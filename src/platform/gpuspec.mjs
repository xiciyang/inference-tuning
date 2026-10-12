/**
 * GPU / 加速器规格 —— **实测优先**。
 *
 * 这个模块存在的唯一理由是防止一类具体错误：
 * **拿规格书的理论峰值当分母，然后得出"已经到硬件上限"的结论。**
 *
 * 真机案例：用理论峰值 273 GB/s 当分母 → 判"98.8% 已到顶"；
 * 换成实测可达 ~240 GB/s 后，反推的 269.8 GB/s **在物理上不可能** ——
 * 说明"每 token 访存字节"这个分母算错了，而不是硬件到顶。
 *
 * 因此本模块的返回值里有一道**硬门**：
 *   只有规格书值的 spec，`usable: false`，**不得**作为墙的天花板分母。
 *   要变成 `usable: true`，必须由本机微基准补上**实测可达值**。
 *
 * 另一条：**统一内存机器上"显存"这个词会误导**。
 * GB10 的 `nvidia-smi` 显存显示 `N/A`（`is_integrated=1`），CPU/GPU 共用内存。
 * 因此本模块把 `memoryBytes`（总量）与 `dedicatedVramBytes`（独立显存，可为 null）
 * 分开记 —— 把它们混为一谈会让容量推算差一个数量级。
 */

export const GPUSPEC_SCHEMA_VERSION = '1.0.0'

/**
 * 显式判空的数值转换。
 *
 * **存在的唯一理由**：`Number(null) === 0`、`Number('') === 0`、`Number(undefined) === NaN`。
 * 不拦空值，`null` 会被当成"实测 0"，于是 `usable: true` 而分母是 0 ——
 * 这个陷阱在本项目已经咬到第三次（墙框架观测取值 → 内存预算 → GPU 规格）。
 */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 静态规格表。
 *
 * **只用于触发实测**（告诉你"这块卡该测什么"），**不作为任何承重输入**。
 * 每条都标 `source: 'spec-sheet'`，读取方据此拒绝它进天花板。
 */
export const STATIC_SPECS = Object.freeze({
  'gb10': {
    devicePattern: /GB10|Grace\s*Blackwell/i,
    vendor: 'NVIDIA', arch: 'Blackwell',
    specSheet: { bandwidthGBps: 273, peakFlopsFp16: null, memoryBytes: null },
    source: 'spec-sheet',
    notes: '统一内存（is_integrated=1）；nvidia-smi 的显存字段为 N/A，不要照搬独立显存的读法',
  },
  'h100-sxm': {
    devicePattern: /H100.*SXM|H100 80GB HBM3/i,
    vendor: 'NVIDIA', arch: 'Hopper',
    specSheet: { bandwidthGBps: 3350, peakFlopsFp16: 989e12, memoryBytes: 80 * 2 ** 30 },
    source: 'spec-sheet',
  },
  'a100-80': {
    devicePattern: /A100.*80GB/i,
    vendor: 'NVIDIA', arch: 'Ampere',
    specSheet: { bandwidthGBps: 2039, peakFlopsFp16: 312e12, memoryBytes: 80 * 2 ** 30 },
    source: 'spec-sheet',
  },
})

export function specKeyFromDeviceName(deviceName) {
  if (typeof deviceName !== 'string' || deviceName === '') return null
  for (const [key, spec] of Object.entries(STATIC_SPECS)) {
    if (spec.devicePattern.test(deviceName)) return key
  }
  return null
}

/**
 * 从**本机实测**构造一份规格。
 * 这是唯一能产出 `usable: true` 的入口。
 */
export function specFromMeasured({
  deviceName = null, achievableBandwidthGBps = null, measuredPeakFlops = null,
  memoryBytes = null, dedicatedVramBytes = null, unifiedMemory = null,
  measurementMethod = null, measuredAt = null,
} = {}) {
  // ⚠ `Number(null) === 0` —— 不显式判空，`null` 会被当成"实测 0 GB/s"，
  // 于是 `usable: true` 而带宽是 0，天花板算出 0。这个陷阱在本包已经咬到第三次（真机暴露）。
  const hasBW = num(achievableBandwidthGBps) !== null && num(achievableBandwidthGBps) > 0
  const hasFlops = num(measuredPeakFlops) !== null && num(measuredPeakFlops) > 0
  const missing = []
  if (!hasBW) missing.push('achievableBandwidthGBps（本机微基准实测；**0 与 null 都算缺**）')
  if (!hasFlops) missing.push('measuredPeakFlops（本机微基准实测，仅在需要判算力墙时才必需）')
  return {
    schemaVersion: GPUSPEC_SCHEMA_VERSION,
    deviceName,
    vendor: deviceName ? (STATIC_SPECS[specKeyFromDeviceName(deviceName)]?.vendor ?? null) : null,
    arch: deviceName ? (STATIC_SPECS[specKeyFromDeviceName(deviceName)]?.arch ?? null) : null,
    // 实测值
    achievableBandwidthGBps: hasBW ? num(achievableBandwidthGBps) : null,
    measuredPeakFlops: hasFlops ? num(measuredPeakFlops) : null,
    memoryBytes: num(memoryBytes),
    dedicatedVramBytes: num(dedicatedVramBytes),
    unifiedMemory: unifiedMemory ?? (dedicatedVramBytes === null && memoryBytes !== null ? true : null),
    // 出处：实测优先
    source: hasBW || hasFlops ? 'local-microbenchmark' : 'unmeasured',
    provenance: {
      achievableBandwidthGBps: hasBW ? 'local-microbenchmark' : null,
      measuredPeakFlops: hasFlops ? 'local-microbenchmark' : null,
      memoryBytes: num(memoryBytes) !== null ? 'adapter' : null,
      dedicatedVramBytes: num(dedicatedVramBytes) !== null ? 'adapter' : null,
    },
    measurementMethod, measuredAt,
    /** **能不能用来当下限/上界的分母** —— 这就是本模块存在的意义 */
    usable: hasBW,
    missing,
    caveat: (unifiedMemory === true)
      ? '统一内存：CPU 与 GPU 共用，**不要**把"显存占用率"从独立显存机器照搬过来；分母用可支配字节。'
      : null,
  }
}

/**
 * 解析一份规格。**实测优先，规格书仅作触发提示。**
 *
 * @param {{deviceName?, measured?, allowSpecSheetAsHint?}} input
 * @returns {{spec, usable, source, why, hintFromSpecSheet}}
 */
export function resolveGpuSpec({ deviceName = null, measured = null, allowSpecSheetAsHint = true } = {}) {
  if (measured && (num(measured.achievableBandwidthGBps) > 0 || num(measured.measuredPeakFlops) > 0)) {
    const spec = specFromMeasured({ deviceName, ...measured })
    return {
      schemaVersion: GPUSPEC_SCHEMA_VERSION,
      spec,
      usable: spec.usable,
      source: spec.source,
      why: spec.usable ? '有本机实测可达带宽 —— 可作为墙的天花板分母' : `缺实测量：${spec.missing.join('、')}`,
      hintFromSpecSheet: null,
    }
  }

  const key = specKeyFromDeviceName(deviceName)
  const sheet = key ? STATIC_SPECS[key] : null
  return {
    schemaVersion: GPUSPEC_SCHEMA_VERSION,
    spec: null,
    usable: false,
    source: 'spec-sheet',
    why: sheet
      ? `只匹配到规格书条目（${key}）。**规格书值不得作为承重输入** —— `
        + '必须先用本机微基准测出可达带宽（见 src/observe/bandwidth.mjs）。'
      : `既没有实测值，也没有匹配到规格书条目（deviceName=${deviceName ?? 'null'}）`,
    hintFromSpecSheet: allowSpecSheetAsHint && sheet
      ? {
        key,
        // 只作为"该测什么"的提示，**不进入任何计算**
        forMeasurementPlanningOnly: { ...sheet.specSheet },
        source: 'spec-sheet',
        warning: '此值仅供决定微基准的规模，禁止进入天花板/利用率的分母。',
      }
      : null,
  }
}

/**
 * 断言一份规格可用于天花板计算。
 * 失败时给出**可操作的**补救（去跑微基准），而不是笼统报错。
 */
export function assertUsableSpec(gpu = null) {
  if (gpu?.usable === true) return { ok: true }
  return {
    ok: false,
    code: 'spec-not-usable',
    detail: gpu?.why ?? '没有可用的实测规格',
    remediation: '跑一次实测可达带宽微基准（inference-tuning 在起端点时会自动跑；'
      + '也可单独调用 executor.bandwidthProbe），得到 achievableBandwidthGBps 后再算天花板。',
    forbidden: '不得用规格书理论峰值代替 —— 那会算出一个"看起来合理"的上界，并据此误判"硬件到顶"。',
  }
}

/**
 * 统一内存机器上的可支配字节推算。
 *
 * **不猜系数**：调用方必须给"留给推理的内存比例"或"绝对字节数"，
 * 本函数不替它取一个"大概是 0.9"的值。
 */
export function budgetBytesFor({ gpu = null, reserveRatio = null, reserveBytes = null } = {}) {
  // ⚠ `Number(null) === 0` —— 不显式拦空值，就会把"没给保留量"静默当成"保留 0"，
  // 于是返回一个"看起来合理"的满额预算。这个陷阱本项目已经咬过一次（墙框架的观测取值），
  // 这里是第二次：**必须先判空，再判有限**。
  const finite = (v) => (v === null || v === undefined || v === '') ? null : (Number.isFinite(Number(v)) ? Number(v) : null)
  const total = finite(gpu?.memoryBytes)
  if (total === null || total <= 0) {
    return { budgetBytes: null, why: '缺 memoryBytes（本机实测总量）—— 无法推算可支配字节' }
  }
  const rb = finite(reserveBytes)
  const rr = finite(reserveRatio)
  if (rb !== null) {
    return { budgetBytes: Math.max(0, total - rb), form: 'memoryBytes − reserveBytes', total, reserveBytes: rb }
  }
  if (rr !== null) {
    const r = rr
    if (r < 0 || r > 1) return { budgetBytes: null, why: `reserveRatio 必须在 [0,1]，实得 ${r}` }
    return { budgetBytes: Math.floor(total * (1 - r)), form: 'memoryBytes × (1 − reserveRatio)', total, reserveRatio: r }
  }
  return {
    budgetBytes: null,
    why: '没给 reserveRatio 或 reserveBytes —— 本模块**不猜**保留比例（在统一内存机器上，猜错的代价是 OOM）',
  }
}
