/**
 * 配置快照与**重放**。
 *
 * 验收要求"输出可复用的优化配置" —— 这句话的实质是：
 * **同一条 spec 必须能重放出同一个端点**。做不到重放的"最佳配置"只是一个数字，
 * 换台机器、换个版本就重现不出来。
 *
 * 因此本模块的三件事都围绕"可重放"：
 *   `captureRunSpec`  把一次运行的全部可复现要素收进一条 spec（**含引擎镜像 digest**）
 *   `applyParamsToArgv` 从 spec 重新渲染命令行（只渲染**已探测存在**的 flag）
 *   `compareRunSpec`  比较两条 spec，逐项说出**哪里不同**（而不是"不相等"）
 *
 * 两条纪律：
 *   ① **spec 里不放任何不可复现的东西**：不存时间戳进指纹、不存随机端口、不存容器名。
 *      它们进 `metadata`（仅供人看），不进 `fingerprint`。
 *   ② **引擎镜像必须固定到 digest**，不能只写 tag —— tag 会漂。
 */

export const RUN_SPEC_SCHEMA_VERSION = '1.0.0'

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const VOLATILE_KEYS = new Set(['containerName', 'port', 'endpoint', 'createdAt', 'runId', 'startedAt', 'rev'])

function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => !VOLATILE_KEYS.has(k) && v[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/** 64-bit FNV-1a 风格指纹（零依赖；不是密码学用途，只用于"是不是同一条 spec"）。 */
export function specFingerprint(spec) {
  const s = stableStringify({
    model: spec.model,
    engineId: spec.engine?.id,
    image: spec.engine?.image,
    imageDigest: spec.engine?.imageDigest ?? null,
    params: spec.params,
    extraArgs: spec.extraArgs ?? [],
    servedModelName: spec.engine?.servedModelName ?? null,
  })
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i += 1) {
    h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 16777619)
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519)
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * 采集一条可重放的运行 spec。
 *
 * @param {{model, engine, params, extraArgs?, workload?, requests?, concurrency?, testSet?, metadata?}} input
 */
export function captureRunSpec({
  model, engine = {}, params = {}, extraArgs = [], workload = null,
  requests = null, concurrency = null, testSet = null, metadata = {}, strict = true,
} = {}) {
  const problems = []
  if (!model) problems.push({ code: 'no-model', detail: 'spec 必须记录模型（路径或内容哈希）' })

  // ── testSet 的内容摘要（F-7 判据对称）────────────────────────────────
  // 原先 `testSet.digest` 只**记录**、从不校验，而它却参与 compareRunSpec 的
  // 结论相关字段比较 —— "足以让两次运行不可比，却不足以让一次运行被判不可重放"。
  // 现在：调用方给了就用给的；没给就**自己算**（文件就在本机，没有理由不算）；
  // 连文件都读不到，才记 problem。两条判据（镜像 / 测试集）从此对称。
  let resolvedTestSet = null
  if (testSet) {
    const tsPath = testSet.path ?? testSet
    let tsDigest = testSet.digest ?? null
    if (!tsDigest && typeof tsPath === 'string' && tsPath.length > 0) {
      try {
        // eslint-disable-next-line global-require
        tsDigest = `sha256:${createHash('sha256').update(readFileSync(tsPath)).digest('hex')}`
      } catch {
        if (strict) {
          problems.push({
            code: 'test-set-not-digestible',
            detail: `测试集 ${tsPath} 既没有提供 digest、也无法在本机读取并计算 —— `
              + '评据（精度结论）因此不可复现。请给出可读路径，或显式传入 digest。',
          })
        }
      }
    } else if (!tsDigest && strict) {
      problems.push({ code: 'test-set-not-pinned', detail: '测试集没有路径也没有 digest —— 精度结论不可复现' })
    }
    resolvedTestSet = { path: tsPath ?? null, digest: tsDigest }
  }
  if (!engine.id) problems.push({ code: 'no-engine-id', detail: 'spec 必须记录引擎 id' })
  if (strict) {
    if (!engine.image) problems.push({ code: 'no-engine-image', detail: 'spec 必须记录引擎镜像' })
    else if (!engine.imageDigest) {
      problems.push({
        code: 'image-not-pinned-to-digest',
        detail: `镜像只写了 tag（${engine.image}）而没有 digest —— tag 会漂，重放不出同一个端点。`
          + '请用 `镜像名@sha256:…` 的形式固定。',
      })
    }
  }

  const spec = {
    schemaVersion: RUN_SPEC_SCHEMA_VERSION,
    model: typeof model === 'string' ? { path: model } : model,
    engine: {
      id: engine.id ?? null,
      image: engine.image ?? null,
      imageDigest: engine.imageDigest ?? null,
      servedModelName: engine.servedModelName ?? null,
      kvCacheDtype: engine.kvCacheDtype ?? null,
    },
    params: { ...params },
    extraArgs: [...extraArgs],
    workload, requests, concurrency,
    testSet: resolvedTestSet,
    metadata: { ...metadata },
  }
  // F-7：判据对称性。
  // 原先只对**镜像**设了 image-not-pinned-to-digest，而 `testSet.digest` 同样参与
  // `compareRunSpec` 的结论相关字段比较（见 CONCLUSION_AFFECTING）却从不校验 ——
  // 即"足以让两次运行不可比，却不足以让一次运行被标记为不可重放"。
  // 调用方没给 digest 时，**本函数自己算**（文件就在本机，没有理由不算）；
  // 连文件都读不到，才记 problem。
  spec.fingerprint = specFingerprint(spec)
  spec.replayable = problems.length === 0
  spec.problems = problems
  return spec
}

/** 从参数集渲染引擎命令行。**只渲染已确认存在的 flag**（不猜）。 */
export function applyParamsToArgv(spec, { engineId = null, supportedFlags = null, render } = {}) {
  const id = engineId ?? spec?.engine?.id
  if (typeof render === 'function') return render(spec, { supportedFlags })
  // 默认渲染：直接按参数名 → --kebab-case 映射；由 registry 负责语义名（本模块不依赖 registry，
  // 避免配置模块反向依赖参数目录）
  const argv = []
  const skipped = []
  for (const [k, v] of Object.entries(spec?.params ?? {})) {
    const flag = k.startsWith('--') ? k : `--${String(k).replace(/_/g, '-')}`
    if (supportedFlags && !supportedFlags.has(flag)) { skipped.push({ param: k, flag, reason: '该引擎版本不支持此 flag（已探测）' }); continue }
    if (v === true) argv.push(flag)
    else if (v === false || v === null || v === undefined) skipped.push({ param: k, flag, reason: '布尔假/空值不下发' })
    else argv.push(flag, String(v))
  }
  // extraArgs 原样追加（已由调用方担保合法）
  for (const a of spec?.extraArgs ?? []) if (a !== undefined && a !== null) argv.push(String(a))
  return { argv, skipped, engineId: id }
}

export function serializeRunSpec(spec) {
  return `${JSON.stringify(spec, null, 2)}\n`
}

export function parseRunSpec(text) {
  const j = typeof text === 'string' ? JSON.parse(text) : text
  if (!j || typeof j !== 'object') throw new Error('运行 spec 不是对象')
  if (j.schemaVersion !== RUN_SPEC_SCHEMA_VERSION) {
    throw new Error(`运行 spec 版本不匹配：文件是 ${j.schemaVersion}，本包是 ${RUN_SPEC_SCHEMA_VERSION}`)
  }
  // 重算指纹，确认没被改过
  const recomputed = specFingerprint(j)
  return { ...j, fingerprintMatches: recomputed === j.fingerprint, recomputedFingerprint: recomputed }
}

const COMPARE_FIELDS = [
  ['model.path', (s) => s?.model?.path],
  ['engine.id', (s) => s?.engine?.id],
  ['engine.image', (s) => s?.engine?.image],
  ['engine.imageDigest', (s) => s?.engine?.imageDigest],
  ['engine.servedModelName', (s) => s?.engine?.servedModelName],
  ['engine.kvCacheDtype', (s) => s?.engine?.kvCacheDtype],
  ['workload', (s) => s?.workload],
  ['requests', (s) => s?.requests],
  ['concurrency', (s) => s?.concurrency],
  ['testSet.digest', (s) => s?.testSet?.digest],
]

/**
 * 逐项比较两条 spec，**说出哪里不同**（而不是只回一个 false）。
 * 差异按"会不会影响结论"分级：model/镜像/参数 → `conclusion-affecting`，其余 → `contextual`。
 */
export function compareRunSpec(a, b) {
  const diffs = []
  for (const [name, get] of COMPARE_FIELDS) {
    const va = get(a)
    const vb = get(b)
    if (stableStringify(va) !== stableStringify(vb)) diffs.push({ field: name, a: va ?? null, b: vb ?? null })
  }
  const keys = [...new Set([...Object.keys(a?.params ?? {}), ...Object.keys(b?.params ?? {})])].sort()
  for (const k of keys) {
    const va = a?.params?.[k]
    const vb = b?.params?.[k]
    if (va !== vb) diffs.push({ field: `params.${k}`, a: va ?? null, b: vb ?? null })
  }
  const affecting = diffs.filter((d) => d.field.startsWith('params.') || d.field === 'model.path'
    || d.field.startsWith('engine.image') || d.field === 'engine.id' || d.field === 'engine.kvCacheDtype')
  return {
    schemaVersion: RUN_SPEC_SCHEMA_VERSION,
    equal: diffs.length === 0,
    fingerprintEqual: a?.fingerprint === b?.fingerprint,
    differences: diffs,
    conclusionAffecting: affecting,
    verdict: diffs.length === 0
      ? 'identical'
      : (affecting.length > 0 ? 'different-affects-conclusion' : 'different-context-only'),
    note: diffs.length === 0
      ? '两条 spec 一致，重放应得到同样的端点'
      : (affecting.length > 0
        ? `有 ${affecting.length} 处差异会影响结论（${affecting.map((d) => d.field).join(', ')}）—— 不能拿 A 的结论说 B`
        : `只有 ${diffs.length} 处上下文差异，不影响结论`),
  }
}

/** 布尔开关目录（哪些参数是开关而非带值参数）。 */
export function booleanFlagsFromCatalog(catalog = {}) {
  return Object.entries(catalog).filter(([, v]) => v?.kind === 'bool').map(([k]) => k)
}

/** 该参数集是否必须 `--gpus all`（有任何 GPU 相关参数即为真）。 */
export function needsGpuAll(params = {}) {
  const gpuish = ['kv_pool_size', '--gpu-memory-utilization', 'concurrency_capacity', '--max-num-seqs', 'prefill_chunk']
  return Object.keys(params).some((k) => gpuish.includes(k))
}

/** POSIX shell 引用（写进文档/脚本时用；不用于 spawn —— spawn 走数组不经过 shell）。 */
export function shellQuote(s) {
  const str = String(s)
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(str)) return str
  return `'${str.replace(/'/g, `'\\''`)}'`
}

/** 便于直接贴进文档的完整命令行。 */
export function toShellCommand(spec, { engineId = null, supportedFlags = null, bin = 'inference-tuning' } = {}) {
  const { argv, skipped } = applyParamsToArgv(spec, { engineId, supportedFlags })
  const parts = [
    bin, 'validate', shellQuote(spec?.model?.path ?? ''),
    '--params', shellQuote(JSON.stringify(spec?.params ?? {})),
  ]
  return {
    command: parts.join(' '),
    argv,
    skipped,
    note: skipped.length > 0 ? `${skipped.length} 个参数因该引擎版本不支持被跳过` : null,
  }
}
