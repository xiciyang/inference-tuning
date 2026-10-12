/**
 * 内存与状态缓存分解。
 *
 * 回答的问题：**给定显存预算与模型，容量到底卡在哪里；提高并发的空间有多少；
 * 哪个杠杆能释放多少字节。**
 *
 * 三条纪律：
 *
 * ① **每一项都要有公式与来源**
 *    不做"大概是 0.9 倍"这类系数。所有项从模型配置（层数 / KV 头数 / head_dim / dtype 宽度）
 *    与本机实测（统一内存总量 / 引擎实报）推出；推不出的项一律 **null** 并说明缺什么。
 *
 * ② **统一内存机器上"显存"这个词会误导**
 *    GB10 的 `nvidia-smi` 显存是 `N/A`（`is_integrated=1`），CPU 与 GPU 共用 119.6 GiB。
 *    因此本模块的分母叫 `budgetBytes`（可支配字节），由调用方给，
 *    并在报告里显式标注 `unifiedMemory`，避免把"显存占用率"从别处照搬过来。
 *
 * ③ **杠杆要能回答"释放多少"**
 *    `attributeLevers` 返回每个干预**具体释放多少字节**（可推导），
 *    而不是"这个参数可能有用"。说不清释放多少的杠杆不该出现在建议里。
 */

export const MEMORY_SCHEMA_VERSION = '1.0.0'

const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** dtype 名字 → 每元素字节数。**不认识就返回 null**（不猜）。 */
export function dtypeBytes(dtype) {
  if (typeof dtype !== 'string') return null
  const d = dtype.toLowerCase().replace(/^torch\./, '')
  const table = {
    float32: 4, fp32: 4,
    float16: 2, fp16: 2, half: 2,
    bfloat16: 2, bf16: 2,
    float8_e4m3fn: 1, float8_e5m2: 1, fp8: 1,
    int8: 1, uint8: 1, i8: 1,
    int4: 0.5, uint4: 0.5, i4: 0.5, nvfp4: 0.5, fp4: 0.5,
  }
  return table[d] ?? null
}

/**
 * 每个 KV token 的字节数（K 与 V 各一份）。
 *
 *   bytes = 2(K,V) × layers × kvHeads × headDim × dtypeBytes
 *
 * MLA / SSM 等结构不适用这个公式 —— 此时必须由调用方给
 * `config.stateCacheBytesPerToken`（**实测或引擎实报**），本函数不替它猜。
 */
export function solvePerSlotCost({ config = {}, kvDtype = null, dtype = 'bfloat16' } = {}) {
  if (num(config.stateCacheBytesPerToken) !== null) {
    return {
      bytesPerToken: num(config.stateCacheBytesPerToken),
      form: 'stateCacheBytesPerToken（调用方实测/实报）',
      inputs: { stateCacheBytesPerToken: num(config.stateCacheBytesPerToken) },
      provenance: 'adapter',
    }
  }
  const layers = num(config.numHiddenLayers ?? config.num_layers)
  const kvHeads = num(config.numKeyValueHeads ?? config.num_key_value_heads)
  const headDim = num(config.headDim ?? config.head_dim)
  const width = dtypeBytes(kvDtype ?? config.kvDtype ?? dtype)
  const missing = []
  if (layers === null) missing.push('numHiddenLayers')
  if (kvHeads === null) missing.push('numKeyValueHeads')
  if (headDim === null) missing.push('headDim')
  if (width === null) missing.push(`kvDtype（不认识 ${kvDtype ?? config.kvDtype ?? dtype}）`)
  if (missing.length > 0) {
    return {
      bytesPerToken: null,
      form: '2×layers×kvHeads×headDim×dtypeBytes',
      missing,
      why: `缺配置项：${missing.join(', ')}。**不猜** —— 猜错会让容量上限差好几倍。`,
      inputs: { layers, kvHeads, headDim, dtypeBytes: width },
      provenance: null,
    }
  }
  const bytesPerToken = 2 * layers * kvHeads * headDim * width
  return {
    bytesPerToken,
    form: '2(K,V)×layers×kvHeads×headDim×dtypeBytes',
    inputs: { layers, kvHeads, headDim, dtypeBytes: width },
    provenance: 'model-config',
  }
}

/**
 * 完整内存分解。
 * 每一项都要么有值 + 来源，要么是 null + 缺什么。
 */
export function decomposeByFormula({
  config = {}, budgetBytes = null, weightsBytes = null, overheadBytes = null,
  kvDtype = null, dtype = 'bfloat16', unifiedMemory = null, maxContextLength = null,
} = {}) {
  const perSlot = solvePerSlotCost({ config, kvDtype, dtype })
  const budget = num(budgetBytes)
  const weights = num(weightsBytes)
  const overhead = num(overheadBytes)

  const missing = []
  if (budget === null) missing.push('budgetBytes（可支配字节上限，本机需实测/实报）')
  if (weights === null) missing.push('weightsBytes（权重占用，可由模型文件实测）')
  if (overhead === null) missing.push('overheadBytes（框架/激活/工作区开销，需实测或实报）')
  if (perSlot.bytesPerToken === null) missing.push(`每 KV token 字节数（${perSlot.why}`.replace(/\n/g, ' ') + '）')

  const kvPoolBytes = (budget !== null && weights !== null && overhead !== null)
    ? budget - weights - overhead
    : null
  const maxTokens = (kvPoolBytes !== null && perSlot.bytesPerToken)
    ? Math.floor(kvPoolBytes / perSlot.bytesPerToken)
    : null

  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    unifiedMemory,
    formula: 'KV 池 = 预算 − 权重 − 开销；可容纳 token 数 = KV 池 / 每 token KV 字节',
    terms: {
      budgetBytes: budget,
      weightsBytes: weights,
      overheadBytes: overhead,
      kvPoolBytes,
    },
    perSlot,
    maxTokens,
    maxConcurrentAt: maxContextLength
      ? { contextLength: maxContextLength, concurrency: maxTokens === null ? null : Math.floor(maxTokens / maxContextLength) }
      : null,
    missing,
    usable: missing.length === 0,
    provenance: {
      budgetBytes: budget !== null ? 'adapter' : null,
      weightsBytes: weights !== null ? 'model-file-scan' : null,
      overheadBytes: overhead !== null ? 'adapter' : null,
      kvBytesPerToken: perSlot.provenance,
    },
    caveat: unifiedMemory
      ? '本机是**统一内存**（CPU/GPU 共用），因此"显存占用率"不能从独立显存机器照搬；分母用可支配字节。'
      : null,
  }
}

/**
 * 状态缓存（SSM/Mamba/混合注意力）分解。
 *
 * 与 KV 缓存的差别：状态缓存的占用**不随上下文长度线性增长**，
 * 而是**每请求固定若干 slot**。因此它的上界是"并发数"，不是"token 数"。
 */
export function decomposeStateCache({
  stateCacheBytes = null, slotsPerRequest = null, bytesPerSlot = null, budgetBytes = null, weightsBytes = null, overheadBytes = null,
} = {}) {
  const budget = num(budgetBytes)
  const weights = num(weightsBytes)
  const overhead = num(overheadBytes)
  const perReq = num(slotsPerRequest)
  const perSlotBytes = num(bytesPerSlot)
  const declared = num(stateCacheBytes)

  const missing = []
  if (budget === null) missing.push('budgetBytes')
  if (weights === null) missing.push('weightsBytes')
  if (overhead === null) missing.push('overheadBytes')
  if (perReq === null && declared === null) missing.push('slotsPerRequest（每请求占几个状态 slot）')

  const pool = (budget !== null && weights !== null && overhead !== null) ? budget - weights - overhead : null
  let perRequestBytes = null
  let maxConcurrent = null
  if (declared !== null && perReq !== null) {
    perRequestBytes = declared / perReq
    maxConcurrent = pool !== null ? Math.floor(pool / perRequestBytes * perReq / perReq) : null
    maxConcurrent = perRequestBytes > 0 ? Math.floor(pool / perRequestBytes) : null
  } else if (perReq !== null && perSlotBytes !== null) {
    perRequestBytes = perReq * perSlotBytes
    maxConcurrent = pool !== null && perRequestBytes > 0 ? Math.floor(pool / perRequestBytes) : null
  }

  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    kind: 'state-cache',
    formula: '状态缓存每请求占用固定 slot（**不随上下文线性增长**）；并发上限 = 状态池 / 每请求占用',
    terms: { budgetBytes: budget, weightsBytes: weights, overheadBytes: overhead, statePoolBytes: pool, slotsPerRequest: perReq, bytesPerSlot: perSlotBytes, perRequestBytes },
    maxConcurrent,
    missing,
    usable: missing.length === 0,
    distinction: '与 KV 缓存的关键差别：KV 随上下文线性增长，状态缓存按请求固定 —— 两者的扩容杠杆不同。',
  }
}

/** 每请求内存占用（决策时按"能同时跑几个"看更直观）。 */
export function solvePerReq({ contextLength = null, bytesPerKvToken = null, stateCachePerReqBytes = null, activationBytes = null } = {}) {
  const ctx = num(contextLength)
  const perToken = num(bytesPerKvToken)
  const state = num(stateCachePerReqBytes)
  const act = num(activationBytes)
  const missing = []
  if (ctx === null) missing.push('contextLength')
  if (perToken === null && state === null) missing.push('bytesPerKvToken 或 stateCachePerReqBytes')
  const kv = (ctx !== null && perToken !== null) ? ctx * perToken : (state ?? null)
  const total = kv === null ? null : kv + (act ?? 0)
  return {
    formula: '每请求 = 上下文长度 × 每 token KV 字节 + 状态缓存 + 激活/工作区',
    terms: { contextLength: ctx, bytesPerKvToken: perToken, kvBytes: kv, stateCachePerReqBytes: state, activationBytes: act },
    perRequestBytes: total,
    missing,
    usable: missing.length === 0,
  }
}

/**
 * 杠杆归因：每个干预**具体释放多少字节**。
 *
 * 只返回可推导的项；推不出的项返回 null 并说明缺什么 ——
 * 说不清释放多少的杠杆不该出现在建议里。
 */
export function attributeLevers({
  breakdown = null, config = {}, kvDtype = null, targetDtype = 'float8_e4m3fn', contextLength = null, seqBudgetNew = null, unifiedMemory = null,
} = {}) {
  const levers = []
  const b = breakdown ?? decomposeByFormula({ config, budgetBytes: null, weightsBytes: null, overheadBytes: null, kvDtype, unifiedMemory })

  // ① 降低 KV 精度
  const curWidth = dtypeBytes(kvDtype ?? config.kvDtype ?? 'bfloat16')
  const newWidth = dtypeBytes(targetDtype)
  if (b.perSlot?.bytesPerToken && curWidth && newWidth && newWidth > 0) {
    const freedPerToken = b.perSlot.bytesPerToken * (1 - newWidth / curWidth)
    const maxTokensAfter = (b.terms.kvPoolBytes !== null && (b.terms.kvPoolBytes / (b.perSlot.bytesPerToken * newWidth / curWidth)))
      ? Math.floor(b.terms.kvPoolBytes / (b.perSlot.bytesPerToken * newWidth / curWidth))
      : null
    levers.push({
      lever: 'kv_precision',
      description: `KV 精度 ${kvDtype ?? 'bfloat16'} → ${targetDtype}`,
      freesBytesPerToken: freedPerToken,
      maxTokensBefore: b.maxTokens,
      maxTokensAfter,
      deltaMaxTokens: (b.maxTokens !== null && maxTokensAfter !== null) ? maxTokensAfter - b.maxTokens : null,
      derivable: true,
      accuracySensitive: true,
      caveat: '会改数值行为 → **必须走精度回归验证**',
    })
  } else {
    levers.push({
      lever: 'kv_precision',
      description: `KV 精度 ${kvDtype ?? 'bfloat16'} → ${targetDtype}`,
      freesBytesPerToken: null,
      derivable: false,
      why: `无法推导：${curWidth ? '' : '当前 kvDtype 不认识；'}${newWidth ? '' : '目标 dtype 不认识；'}${b.perSlot?.bytesPerToken ? '' : '每 token KV 字节数未知'}`,
    })
  }

  // ② 缩小单请求上下文预算
  const seq = num(seqBudgetNew)
  const cur = num(contextLength)
  if (seq !== null && cur !== null && b.perSlot?.bytesPerToken && seq < cur) {
    const perReqBefore = cur * b.perSlot.bytesPerToken
    const perReqAfter = seq * b.perSlot.bytesPerToken
    levers.push({
      lever: 'seq_budget',
      description: `单请求上下文上限 ${cur} → ${seq}`,
      freesBytesPerRequest: perReqBefore - perReqAfter,
      maxConcurrentBefore: b.maxTokens === null ? null : Math.floor(b.maxTokens / cur),
      maxConcurrentAfter: b.maxTokens === null ? null : Math.floor(b.maxTokens / seq),
      derivable: true,
      caveat: '会截断超过该长度的请求 —— 需业务确认',
    })
  }

  // ③ 扩大 KV 池（预算内重新分配）
  if (b.terms?.kvPoolBytes !== null && b.terms?.kvPoolBytes !== undefined) {
    levers.push({
      lever: 'kv_pool_size',
      description: '在预算内扩大 KV 池占比',
      currentKvPoolBytes: b.terms.kvPoolBytes,
      freesBytesPerToken: null,
      derivable: true,
      caveat: '受总预算硬约束；扩大它会挤压权重与开销，可能 OOM',
    })
  }

  const derivable = levers.filter((l) => l.derivable)
  const notDerivable = levers.filter((l) => !l.derivable)
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    levers,
    derivableLevers: derivable,
    notDerivable,
    note: derivable.length === 0
      ? '没有任何一个杠杆的释放量是可推导的 —— 先补齐上面 missing 的项，再谈扩容建议'
      : `可推导释放量的杠杆 ${derivable.length} 个；按"释放字节"从大到小排：`
        + derivable
          .map((l) => ({ l, amount: l.freesBytesPerToken ?? l.freesBytesPerRequest ?? l.currentKvPoolBytes ?? 0 }))
          .sort((a, c) => c.amount - a.amount)
          .map((x) => x.l.lever).join(' > '),
  }
}
