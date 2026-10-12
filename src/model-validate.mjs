/**
 * 源模型结构预检 —— "文件读得到" ≠ "是一个完整的模型"。
 *
 * 这一层是**能力继承**自 quantization（Step 0 继承项），代码零复用、按本包结构重写。
 * 它回答的问题与目录哈希**不是同一个**：
 *   目录哈希回答"内容**有没有被改动**"；本模块回答"内容**是不是一个完整模型**"。
 * 只做前者，就会在一份**从未损坏过**的坏输入上一路绿灯
 * （quantization 真机事故：223/338 张量整块为零的模型被量化了 436 秒并签收"精度零损失"）。
 *
 * 本包为什么也需要它：调优要反复起端点，一个残缺模型会让每一轮都白跑，
 * 而且**性能数据会看起来"更好"**（层退化成直通 → 更快），从而把调优引向错误结论。
 *
 * 检查口径（每条都出证据）：
 *   ① 截断 —— safetensors 头部声明终点 ≠ 文件实际长度
 *   ② 零填充 —— 单个张量 ≥ zeroCoverage 的字节为 0 且元素数 ≥ minElements
 *      （长度 1 的 bias 恰好为 0 常见；1536×8960 的权重矩阵全 0 不可能是有意为之）
 *   ③ 结构 —— config 声明的层数 vs 权重里实际出现的层号
 *   ④ 分片 —— index.json 列了的分片必须都在
 * 结果按 (路径, 字节数, mtime) 缓存；**只缓存通过结论**。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { readText, atomicWriteJson, mkdirp } from './util/fsx.mjs'
import { fail, warn, ERROR_CODES, WARNING_CODES } from './errors.mjs'

export const VALIDATION_SCHEMA = 'inference-tuning/model-validation@1'

/**
 * **校验器版本** —— 必须参与缓存键。
 *
 * 真机踩过：预检逻辑升级后（多采集了 KV 结构字段），缓存只按 (路径, size, mtime) 命中，
 * 于是旧结构的记录被原样返回，下游拿不到新字段却看不出为什么。
 *
 * 教训：缓存键要覆盖**产出内容的全部决定因素** —— 输入**和**产生它的逻辑版本。
 * 只按输入做键，逻辑一改就静默返回过期结果。
 */
export const VALIDATOR_VERSION = 2

export const DEFAULT_ZERO_POLICY = Object.freeze({
  minElements: 1024,
  zeroCoverage: 0.999,
  chunkBytes: 4 * 1024 * 1024,
  maxZeroTensorNames: 32,
})

const CACHE_LIMIT = 200

/** 线性扫描一个 safetensors：按张量各自的字节区间读，总读取量恰为数据区一遍。 */
export async function scanSafetensors(path, { policy = DEFAULT_ZERO_POLICY } = {}) {
  const p = { ...DEFAULT_ZERO_POLICY, ...(policy ?? {}) }
  let st
  try {
    st = await fs.stat(path)
  } catch (err) {
    return { ok: false, kind: 'unreadable', message: String(err.message), problems: [], evidence: null }
  }
  const size = st.size
  const fh = await fs.open(path, 'r')
  try {
    if (size < 16) return { ok: false, kind: 'header-invalid', message: `文件过小（${size} 字节）`, problems: [], evidence: null }
    const head = Buffer.alloc(8)
    await fh.read(head, 0, 8, 0)
    const headerLen = Number(head.readBigUInt64LE(0))
    if (!Number.isSafeInteger(headerLen) || headerLen <= 0 || 8 + headerLen > size) {
      return { ok: false, kind: 'header-invalid', message: `头部长度非法：${headerLen}`, problems: [], evidence: null }
    }
    const hbuf = Buffer.alloc(headerLen)
    await fh.read(hbuf, 0, headerLen, 8)
    let header
    try { header = JSON.parse(hbuf.toString('utf8')) } catch (err) {
      return { ok: false, kind: 'header-invalid', message: `头部不是合法 JSON：${err.message}`, problems: [], evidence: null }
    }
    const metadata = header.__metadata__ ?? null
    delete header.__metadata__
    const entries = Object.entries(header).map(([name, v]) => ({
      name, dtype: v?.dtype ?? null,
      shape: Array.isArray(v?.shape) ? v.shape : [],
      start: Number(v?.data_offsets?.[0] ?? 0), end: Number(v?.data_offsets?.[1] ?? 0),
    }))
    if (entries.length === 0) return { ok: false, kind: 'header-invalid', message: '头部没有任何张量', problems: [], evidence: null }

    const dataStart = 8 + headerLen
    const declaredEnd = dataStart + entries.reduce((m, e) => Math.max(m, e.end), 0)
    const sorted = entries.filter((e) => e.end > e.start).sort((a, b) => a.start - b.start)
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].start < sorted[i - 1].end) {
        return { ok: false, kind: 'header-invalid', message: `张量数据区重叠：${sorted[i - 1].name} / ${sorted[i].name}`, problems: [], evidence: null }
      }
    }

    const zeroBuf = Buffer.alloc(p.chunkBytes)
    const buf = Buffer.allocUnsafe(p.chunkBytes)
    const regions = []
    const zeroTensors = []
    let zeroBytes = 0
    for (const e of sorted) {
      const len = e.end - e.start
      const from = dataStart + e.start
      const to = dataStart + e.end
      let tensorZero = 0
      let pos = from
      while (pos < to) {
        const want = Math.min(p.chunkBytes, to - pos)
        // eslint-disable-next-line no-await-in-loop
        const { bytesRead } = await fh.read(buf, 0, want, pos)
        if (bytesRead <= 0) break
        if (buf.compare(zeroBuf, 0, bytesRead, 0, bytesRead) === 0) {
          tensorZero += bytesRead
          const last = regions[regions.length - 1]
          if (last && last.end === pos) last.end = pos + bytesRead
          else regions.push({ start: pos, end: pos + bytesRead })
        }
        pos += bytesRead
      }
      zeroBytes += tensorZero
      const elements = e.shape.reduce((a, b) => a * b, 1)
      if (elements >= p.minElements && tensorZero / len >= p.zeroCoverage) {
        zeroTensors.push({
          name: e.name, shape: e.shape, dtype: e.dtype, elements, bytes: len,
          zeroBytes: tensorZero, zeroRatio: Number((tensorZero / len).toFixed(6)),
        })
      }
    }

    const largest = regions.reduce((m, r) => (!m || r.end - r.start > m.end - m.start ? r : m), null)
    const truncatedBy = declaredEnd - size
    const evidence = {
      path, size, mtimeMs: st.mtimeMs, headerBytes: headerLen, metadata,
      tensorCount: entries.length, dataStart, declaredEnd, truncatedBy,
      zeroBytes,
      zeroRatio: (size - dataStart) > 0 ? Number((zeroBytes / (size - dataStart)).toFixed(6)) : 0,
      largestZeroRegion: largest ? { start: largest.start, end: largest.end, bytes: largest.end - largest.start } : null,
      zeroTensorCount: zeroTensors.length,
      zeroTensors: zeroTensors.slice(0, p.maxZeroTensorNames),
      zeroTensorsTruncated: zeroTensors.length > p.maxZeroTensorNames,
      zeroPolicy: { minElements: p.minElements, zeroCoverage: p.zeroCoverage, chunkBytes: p.chunkBytes },
    }
    const problems = []
    if (truncatedBy > 0) problems.push({ kind: 'truncated', message: `文件比头部声明短 ${truncatedBy} 字节（缺 ${(truncatedBy / 2 ** 20).toFixed(1)} MiB）` })
    if (zeroTensors.length > 0) {
      problems.push({ kind: 'zero-filled', message: `${zeroTensors.length}/${entries.length} 个张量整块为零（占数据区 ${(evidence.zeroRatio * 100).toFixed(1)}%）` })
    }
    return { ok: problems.length === 0, problems, evidence }
  } finally {
    await fh.close()
  }
}

/** 只读头部张量名（不读数据区，快）。 */
export async function readSafetensorsNames(path) {
  const fh = await fs.open(path, 'r')
  try {
    const head = Buffer.alloc(8)
    await fh.read(head, 0, 8, 0)
    const headerLen = Number(head.readBigUInt64LE(0))
    if (!Number.isSafeInteger(headerLen) || headerLen <= 0) return []
    const hbuf = Buffer.alloc(headerLen)
    await fh.read(hbuf, 0, headerLen, 8)
    const header = JSON.parse(hbuf.toString('utf8'))
    delete header.__metadata__
    return Object.keys(header)
  } catch {
    return []
  } finally {
    await fh.close()
  }
}

export async function validateModelDir(dir, { policy = DEFAULT_ZERO_POLICY, log = null } = {}) {
  let files
  try {
    files = await fs.readdir(dir)
  } catch (err) {
    fail(ERROR_CODES.E_SOURCE_MODEL_UNREADABLE, `无法读取源模型目录：${dir}`, {
      remediation: '确认路径存在且当前用户可读。', details: { dir, error: err.message }, cause: err,
    })
  }
  const shards = files.filter((f) => f.endsWith('.safetensors')).sort()
  const indexFile = files.filter((f) => f.endsWith('.safetensors.index.json')).sort()[0] ?? null
  const legacyBins = files.filter((f) => f.endsWith('.bin')).sort()
  const cfgRaw = await readText(join(dir, 'config.json'), null)
  let config = null
  try { config = cfgRaw ? JSON.parse(cfgRaw) : null } catch { config = null }

  const problems = []
  const evidence = {
    dir,
    config: config ? {
      architectures: config.architectures ?? null,
      numHiddenLayers: config.num_hidden_layers ?? null,
      vocabSize: config.vocab_size ?? null,
      tieWordEmbeddings: config.tie_word_embeddings ?? null,
      quantizationConfig: config.quantization_config ?? null,
      // --- 内存/容量分解要用的结构字段 ---
      // 刻意保持**原样取用、缺则 null**：`decomposeByFormula` 会对 null 报 missing，
      // 而不是拿一个默认值凑出一个"看起来合理"的容量上限。
      hiddenSize: config.hidden_size ?? null,
      numAttentionHeads: config.num_attention_heads ?? null,
      numKeyValueHeads: config.num_key_value_heads ?? config.num_attention_heads ?? null,
      headDim: config.head_dim ?? (config.hidden_size && config.num_attention_heads
        ? Math.floor(config.hidden_size / config.num_attention_heads) : null),
      intermediateSize: config.intermediate_size ?? null,
      torchDtype: config.torch_dtype ?? null,
    } : null,
    indexFile, shards: [], legacyBins, unsupported: null,
  }

  if (indexFile) {
    const raw = await readText(join(dir, indexFile), null)
    if (raw) {
      try {
        const idx = JSON.parse(raw)
        const listed = [...new Set(Object.values(idx.weight_map ?? {}).map((v) => String(v).split('/').pop()))].sort()
        const missing = listed.filter((f) => !files.includes(f))
        evidence.indexShardsListed = listed.length
        evidence.indexShardsMissing = missing
        if (missing.length > 0) {
          problems.push({ kind: 'shard-missing', message: `index.json 列了 ${listed.length} 个分片，缺 ${missing.length} 个：${missing.slice(0, 5).join(', ')}` })
        }
      } catch (err) {
        problems.push({ kind: 'index-unparsable', message: `${indexFile} 不是合法 JSON：${err.message}` })
      }
    }
  }

  if (shards.length === 0 && legacyBins.length > 0) {
    evidence.unsupported = 'legacy-pickle-bin'
    log?.info?.('源模型只有 .bin（pickle），本模块不做结构预检', { dir, bins: legacyBins.length })
    return { ok: true, problems, files, evidence, unsupported: 'legacy-pickle-bin' }
  }
  if (shards.length === 0) {
    fail(ERROR_CODES.E_SOURCE_MODEL_INVALID, `源模型目录里没有任何权重文件：${dir}`, {
      remediation: '确认这是完整的模型目录（应有 *.safetensors，或至少 *.bin）。',
      details: { dir, files: files.slice(0, 60) },
    })
  }

  const allTensorNames = new Set()
  let totalZeroTensors = 0
  let totalTensors = 0
  let totalZeroBytes = 0
  let totalDataBytes = 0
  for (const s of shards) {
    log?.info?.('源模型结构预检', { file: s })
    // eslint-disable-next-line no-await-in-loop
    const r = await scanSafetensors(join(dir, s), { policy })
    evidence.shards.push(r.evidence ? { file: s, ...r.evidence } : { file: s, error: r.message })
    if (!r.evidence) { problems.push({ kind: r.kind, message: `${s}：${r.message}` }); continue }
    for (const t of r.evidence.zeroTensors) allTensorNames.add(t.name)
    totalZeroTensors += r.evidence.zeroTensorCount
    totalTensors += r.evidence.tensorCount
    totalZeroBytes += r.evidence.zeroBytes
    totalDataBytes += r.evidence.size - r.evidence.dataStart
    for (const pb of r.problems) problems.push({ kind: pb.kind, file: s, message: `${s}：${pb.message}` })
  }
  evidence.totalTensors = totalTensors
  evidence.totalZeroTensors = totalZeroTensors
  evidence.totalZeroBytes = totalZeroBytes
  evidence.totalDataBytes = totalDataBytes
  evidence.zeroTensorNames = [...allTensorNames].slice(0, DEFAULT_ZERO_POLICY.maxZeroTensorNames)

  const declared = evidence.config?.numHiddenLayers ?? null
  if (declared) {
    const names = new Set()
    for (const s of shards) {
      // eslint-disable-next-line no-await-in-loop
      const ns = await readSafetensorsNames(join(dir, s))
      for (const n of ns) names.add(n)
    }
    const present = new Set()
    for (const n of names) {
      const m = /(?:^|\.)(?:model\.)?(?:layers|h)\.(\d+)\./.exec(n)
      if (m) present.add(Number(m[1]))
    }
    evidence.declaredLayers = declared
    evidence.presentLayers = present.size
    evidence.layerIndicesMax = present.size ? Math.max(...present) : null
    if (present.size > 0 && present.size !== declared) {
      problems.push({
        kind: 'layer-count-mismatch',
        message: `config.json 声明 ${declared} 层，权重里只有 ${present.size} 层（最大层号 ${evidence.layerIndicesMax}）`,
      })
    }
  }
  return { ok: problems.length === 0, problems, files, evidence, unsupported: null }
}

async function loadCache(file) {
  const raw = await readText(file, null)
  if (!raw) return {}
  try {
    const j = JSON.parse(raw)
    return j && typeof j.entries === 'object' && j.entries ? j.entries : {}
  } catch { return {} }
}

async function saveCache(file, entries) {
  const keys = Object.keys(entries)
  const trimmed = keys.length > CACHE_LIMIT ? Object.fromEntries(keys.slice(-CACHE_LIMIT).map((k) => [k, entries[k]])) : entries
  await mkdirp(join(file, '..'))
  await atomicWriteJson(file, { schema: `${VALIDATION_SCHEMA}#cache`, updatedAt: new Date().toISOString(), entries: trimmed })
}

async function dirFingerprint(dir, files) {
  const wanted = files.filter((f) => /\.(safetensors|bin)$/.test(f) || f.endsWith('.index.json')).sort()
  const parts = []
  for (const f of wanted) {
    // eslint-disable-next-line no-await-in-loop
    const st = await fs.stat(join(dir, f)).catch(() => null)
    parts.push(`${f}:${st ? st.size : 'missing'}:${st ? Math.round(st.mtimeMs) : 0}`)
  }
  return parts.join('|')
}

/**
 * 断言源模型可用。不可用 → `E_SOURCE_MODEL_INVALID`（**终态**失败：换参数解决不了）。
 */
export async function assertSourceModelValid(runtime, dir, { policy = DEFAULT_ZERO_POLICY, useCache = true, force = false } = {}) {
  const cacheFile = runtime?.paths?.modelValidationFile ?? null
  let files = []
  try {
    files = await fs.readdir(dir)
  } catch (err) {
    fail(ERROR_CODES.E_SOURCE_MODEL_UNREADABLE, `无法读取源模型目录：${dir}`, {
      remediation: '确认路径存在且当前用户可读。', details: { dir, error: err.message }, cause: err,
    })
  }
  const fingerprint = await dirFingerprint(dir, files)
  // 键里含校验器版本：逻辑一升级，旧记录自然失效（不是靠人去清缓存）
  const key = `v${VALIDATOR_VERSION}\u0000${dir}\u0000${fingerprint}`

  if (useCache && cacheFile && !force) {
    const cache = await loadCache(cacheFile)
    const hit = cache[key]
    if (hit && hit.ok === true) {
      runtime?.warnings?.push?.(warn(WARNING_CODES.W_SOURCE_VALIDATION_CACHED,
        `源模型结构预检命中缓存（${hit.validatedAt}）`, { dir, validatedAt: hit.validatedAt }))
      return { ...hit, cached: true }
    }
  }

  const result = await validateModelDir(dir, { policy, log: runtime?.__log ?? null })
  const record = {
    schema: VALIDATION_SCHEMA,
    validatorVersion: VALIDATOR_VERSION,
    ok: result.ok,
    validatedAt: new Date().toISOString(),
    unsupported: result.unsupported,
    problems: result.problems,
    evidence: {
      dir: result.evidence.dir,
      config: result.evidence.config,
      totalTensors: result.evidence.totalTensors,
      totalZeroTensors: result.evidence.totalZeroTensors,
      totalZeroBytes: result.evidence.totalZeroBytes,
      totalDataBytes: result.evidence.totalDataBytes,
      zeroTensorNames: result.evidence.zeroTensorNames,
      declaredLayers: result.evidence.declaredLayers ?? null,
      presentLayers: result.evidence.presentLayers ?? null,
      shards: (result.evidence.shards ?? []).map((s) => ({
        file: s.file, size: s.size, tensorCount: s.tensorCount, declaredEnd: s.declaredEnd,
        truncatedBy: s.truncatedBy, zeroBytes: s.zeroBytes, zeroRatio: s.zeroRatio,
        largestZeroRegion: s.largestZeroRegion, zeroTensorCount: s.zeroTensorCount,
      })),
    },
  }

  if (!result.ok) {
    const zero = result.problems.find((p) => p.kind === 'zero-filled')
    const trunc = result.problems.find((p) => p.kind === 'truncated')
    const hint = zero
      ? '权重里有整块为零的张量 —— 典型成因是**下载中断**（目录里常留有 *.aria2 / *.part 残留文件）。'
      : trunc ? '权重文件比 safetensors 头部声明短 —— 下载未完成。' : '源模型结构不完整。'
    fail(ERROR_CODES.E_SOURCE_MODEL_INVALID, `源模型不可用（${result.problems.map((p) => p.kind).join('、')}）：${dir}`, {
      remediation: `${hint}请重新完整下载该模型，或用 options.model 指向另一份**已验证完整**的副本后重试。`
        + '本插件不会在一份结构残缺的模型上调优 —— 那样的性能数据反而会"更好"（层退化成直通），把结论引向错误方向。',
      details: { dir, problems: result.problems, zeroTensorNames: record.evidence.zeroTensorNames, shards: record.evidence.shards, hint },
    })
  }

  if (result.unsupported) {
    runtime?.warnings?.push?.(warn(WARNING_CODES.W_SOURCE_VALIDATION_UNSUPPORTED,
      '源模型只有 .bin（pickle），跳过结构预检；可用性改由**加载期实测**兜底',
      { dir, kind: result.unsupported }))
  }

  if (cacheFile) {
    try {
      const cache = await loadCache(cacheFile)
      cache[key] = record
      await saveCache(cacheFile, cache)
    } catch (err) {
      runtime?.__log?.warn?.('源模型预检缓存写入失败（不影响结论）', { error: String(err.message) })
    }
  }
  runtime?.__log?.info?.('源模型结构预检通过', {
    dir, tensors: record.evidence.totalTensors, zeroTensors: record.evidence.totalZeroTensors,
  })
  return record
}

export { warn, WARNING_CODES }
