/**
 * 参数目录 + 语义杠杆 → 引擎 flag 的适配器。
 *
 * 分层：
 *   语义杠杆名（`concurrency_capacity`）
 *     → 参数条目（kind/min/max/align + 属于哪堵墙）
 *       → 引擎 flag（vLLM / sglang / … 各自的真实命令行）
 *
 * 为什么要分三层：墙框架与干预映射必须**换引擎不改**（Step 0 继承项 A4）。
 *
 * **硬排除在参数层落地**：任何落在 `FORBIDDEN_PARAM_PATTERNS` 上的参数
 * （量化格式 / KV 精度 / 权重精度类）在**参数构造阶段**就被拒绝，
 * 而不是等到下发时才发现 —— 这条是用户明确的硬约束，不是优先级。
 */
import { fail, ERROR_CODES } from './errors.mjs'

export const REGISTRY_SCHEMA_VERSION = '1.0.0'

/**
 * **目标函数之外**的硬约束：不得改变主模型既有量化格式。
 * 命中即 `E_QUANT_FORMAT_FORBIDDEN`，且**不进降级链**（换参数解决不了）。
 */
export const FORBIDDEN_PARAM_PATTERNS = Object.freeze([
  /^--quantization$/i,
  /^--quantization-config$/i,
  /^--kv-cache-dtype$/i,
  /^--kv-cache-quant/i,
  /^--weight[-_]?(dtype|precision|bits)/i,
  /^--load-format$/i,          // 换加载格式会改权重解释方式
  /^--dtype$/i,                // 改激活/权重 dtype 属"改变精度格式"
  /^quantization\./i,
  /^kv_cache_dtype$/i,
  /^dtype$/i,
])

/**
 * 参数目录。每项声明：类型、范围、所属墙、以及各引擎的 flag 形态。
 * `flags` 只写**已知存在**的；运行时还会用 `probeEngineFlags` 再核一遍。
 */
export const PARAM_CATALOG = Object.freeze({
  concurrency_capacity: {
    lever: 'concurrency_capacity',
    wall: 'bandwidth',
    kind: 'int',
    min: 1,
    max: 1024,
    align: 1,
    default: 32,
    semantics: '同时服务的请求数上限；提高它让权重读取被更多 token 摊薄',
    flags: { vllm: ['--max-num-seqs'] },
  },
  kv_pool_size: {
    lever: 'kv_pool_size',
    wall: 'memory',
    kind: 'float',
    min: 0.05,
    max: 0.95,
    align: 0.01,
    default: 0.9,
    semantics: '留给 KV 缓存的显存比例',
    flags: { vllm: ['--gpu-memory-utilization'] },
  },
  seq_budget: {
    lever: 'seq_budget',
    wall: 'memory',
    kind: 'int',
    min: 256,
    max: 1_048_576,
    align: 256,
    default: 8192,
    semantics: '单请求最大上下文长度',
    flags: { vllm: ['--max-model-len'] },
  },
  prefill_chunk: {
    lever: 'prefill_chunk',
    wall: 'schedule',
    kind: 'int',
    min: 256,
    max: 131_072,
    align: 256,
    default: 8192,
    semantics: '预填充分块大小',
    flags: { vllm: ['--max-num-batched-tokens'] },
  },
  batch_step_count: {
    lever: 'batch_step_count',
    wall: 'schedule',
    kind: 'int',
    min: 1,
    max: 64,
    align: 1,
    default: 2,
    semantics: '一次调度里连续执行的 decode 步数',
    // 该 flag 在部分版本不存在 —— 运行时探测，缺则跳过并记录（不猜）
    flags: { vllm: ['--num-continuous-decode-steps'] },
    optional: true,
  },
  graph_batch_size: {
    lever: 'graph_batch_size',
    wall: 'schedule',
    kind: 'int',
    min: 1,
    max: 1024,
    align: 1,
    default: 16,
    semantics: 'CUDA graph 覆盖的最大批大小',
    flags: { vllm: ['--max-seq-len-to-capture'] },
    optional: true,
  },
  draft_budget: {
    lever: 'draft_budget',
    wall: 'speculative',
    kind: 'int',
    min: 1,
    max: 64,
    align: 1,
    default: 8,
    semantics: '投机草稿预算（每步提出的草稿 token 数）',
    // 新老版本 flag 不同，运行时探测后再决定用哪个
    flags: { vllm: ['--num-speculative-tokens'] },
    optional: true,
    requiresSpeculative: true,
  },
})

export const ENGINE_IDS = Object.freeze(['vllm', 'sglang'])

/** 语义杠杆 → 参数键（目前一一对应，保留间接层以便将来一个杠杆对应多个参数）。 */
export function leverToParams(lever) {
  return Object.values(PARAM_CATALOG).filter((p) => p.lever === lever).map((p) => p.lever)
}

export function paramCatalog() {
  return Object.entries(PARAM_CATALOG).map(([id, v]) => ({ id, ...v }))
}

/** 参数键 → 原始 flag（不带值），用于探测存在性。 */
export function flagNameFor(paramId, engineId = 'vllm') {
  const flags = PARAM_CATALOG[paramId]?.flags?.[engineId]
  return flags && flags.length ? flags[0] : null
}

/**
 * **硬排除检查**：参数集里出现任何量化格式/精度类条目即拒绝。
 * 在**构造阶段**就拦，不让它走到下发。
 */
export function assertNoForbiddenParams(params = {}, { where = 'params' } = {}) {
  const hits = []
  for (const [key, value] of Object.entries(params)) {
    const asFlag = key.startsWith('--') ? key : `--${key}`
    for (const re of FORBIDDEN_PARAM_PATTERNS) {
      if (re.test(key) || re.test(asFlag)) { hits.push({ key, value, matched: String(re) }); break }
    }
  }
  if (hits.length > 0) {
    fail(ERROR_CODES.E_QUANT_FORMAT_FORBIDDEN, `参数集包含禁止的量化格式/精度变更：${hits.map((h) => h.key).join(', ')}`, {
      remediation: '这是**硬排除**（不是优先级）：调优不得改变主模型既有的量化格式，'
        + '包括 quantization / kv-cache-dtype / dtype / load-format 这类条目。'
        + '该约束在目标函数之外，换参数解决不了，因此不进降级链。',
      details: { where, hits, forbiddenPatterns: FORBIDDEN_PARAM_PATTERNS.map(String) },
    })
  }
  return true
}

/** 参数取值对齐到 align 的整数倍（引擎对多数尺寸参数有对齐要求）。 */
export function snapToAlign(value, align) {
  if (!align || align <= 0) return value
  return Math.round(value / align) * align
}

export function clampParam(paramId, value) {
  const spec = PARAM_CATALOG[paramId]
  if (!spec) return value
  let v = Number(value)
  if (!Number.isFinite(v)) return spec.default
  if (spec.kind === 'int') v = Math.round(v)
  v = Math.max(spec.min, Math.min(spec.max, v))
  if (spec.align) v = snapToAlign(v, spec.align)
  return spec.kind === 'float' ? Number(v.toFixed(4)) : v
}

/**
 * 生成一个候选配置：在基线上按方向调整某个杠杆。
 * @returns {{params: object, changed: object}}
 */
export function proposeCandidate({ base = {}, lever, direction = 'increase', step = null, factor = 1.5 } = {}) {
  const paramId = lever
  const spec = PARAM_CATALOG[paramId]
  if (!spec) {
    fail(ERROR_CODES.E_CAPABILITY_DENIED, `未知的语义杠杆/参数：${lever}`, {
      remediation: `可用：${Object.keys(PARAM_CATALOG).join(', ')}`,
      details: { lever, available: Object.keys(PARAM_CATALOG) },
    })
  }
  const cur = Number.isFinite(Number(base[paramId])) ? Number(base[paramId]) : spec.default
  let next
  if (step !== null && Number.isFinite(Number(step))) {
    next = direction === 'decrease' ? cur - Number(step) : cur + Number(step)
  } else if (spec.kind === 'float') {
    next = direction === 'decrease' ? cur / factor : cur * factor
  } else {
    next = direction === 'decrease' ? Math.floor(cur / factor) : Math.ceil(cur * factor)
  }
  next = clampParam(paramId, next)
  const params = { ...base, [paramId]: next }
  return { params, changed: { [paramId]: { from: cur, to: next, lever: spec.lever, wall: spec.wall } } }
}

/**
 * 把参数集渲染成引擎命令行（值 → flag）。
 * 只渲染**已确认存在**的 flag；缺失/未确认的一律跳过并记入 `skipped`（不猜）。
 */
export function buildLaunchArgs(params = {}, { engineId = 'vllm', supportedFlags = null } = {}) {
  assertNoForbiddenParams(params)
  const args = []
  const skipped = []
  const applied = {}
  for (const [paramId, value] of Object.entries(params)) {
    const spec = PARAM_CATALOG[paramId]
    if (!spec) { skipped.push({ paramId, reason: '未登记的参数（不猜 flag）' }); continue }
    const flag = flagNameFor(paramId, engineId)
    if (!flag) { skipped.push({ paramId, reason: `引擎 ${engineId} 无对应 flag` }); continue }
    if (supportedFlags && !supportedFlags.has(flag)) {
      skipped.push({ paramId, flag, reason: '该引擎版本不支持此 flag（已探测）' })
      continue
    }
    const v = clampParam(paramId, value)
    if (spec.kind === 'float') {
      args.push(flag, String(v))
    } else {
      args.push(flag, String(v))
    }
    applied[paramId] = v
  }
  return { args, applied, skipped }
}

/**
 * 从引擎 `--help` 输出里探测真实存在的 flag 集合。
 * **不猜** —— 探测不到就不下发（quantization 踩过：vLLM 0.23.1rc1 删掉了
 * `--swap-space` 与 `--disable-log-requests`，硬编码的启动参数直接让服务起不来）。
 */
export function parseSupportedFlags(helpText) {
  const set = new Set()
  const re = /(--[a-z0-9][a-z0-9-]*)/g
  let m
  while ((m = re.exec(String(helpText ?? ''))) !== null) set.add(m[1])
  return set
}

/** 选一个"当前可动"的杠杆（跳过需要投机但没启用投机的参数）。 */
export function selectableLevers({ engineCapabilities = {} } = {}) {
  return Object.values(PARAM_CATALOG)
    .filter((p) => !(p.requiresSpeculative && !engineCapabilities.speculative))
    .map((p) => p.lever)
}
