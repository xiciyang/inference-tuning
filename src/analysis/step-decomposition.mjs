/**
 * 步分解 —— 把一次 decode 步的耗时拆成可归属的部分，并**暴露未归属的残差**。
 *
 * 要防的失败模式：**分解加不起来，却照样拿它做归因。**
 *
 * 真实场景：报"调度 30% / 计算 25% / 采样 10%"，剩下的 35% 被含糊地叫成"开销"。
 * 但那 35% 恰恰可能就是这个系统最大的问题 —— 把它命名为"开销"就等于放弃了它。
 *
 * 因此本模块的判据是：**残差必须被显式量化并给出"它可能是什么"**；
 * 残差过大时，结论要写成"分解不完整"，而不是"开销较大"。
 *
 * 残差阈值用**可推导**的口径：残差是否超过最大单项的两倍（即"未归属的部分比任何一项都大"）。
 * 不用"5% 以内算好"这类魔数。
 */

export const STEP_SCHEMA_VERSION = '1.0.0'

const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 常见分段名（用于给出"残差可能是什么"的可操作提示）。 */
export const COMMON_PARTS = Object.freeze([
  'prefill', 'decode', 'attention', 'mlp', 'norm', 'embedding', 'logits',
  'sampling', 'scheduler', 'kvWrite', 'kvRead', 'graphReplay', 'communication', 'hostGap',
])

/**
 * @param {{stepMs, parts: Record<string, number>, labels?: Record<string,string>, tolerance?: number}} input
 */
export function decomposeStep({ stepMs = null, parts = {}, labels = null, tolerance = null } = {}) {
  const step = num(stepMs)
  if (step === null || step <= 0) {
    return {
      schemaVersion: STEP_SCHEMA_VERSION,
      usable: false,
      why: '缺步总时长（stepMs）—— 没有分母就无法判"分解加不加得起来"',
    }
  }
  const entries = Object.entries(parts ?? {})
    .map(([k, v]) => ({ part: k, label: labels?.[k] ?? null, ms: num(v) }))
    .filter((e) => e.ms !== null)
  if (entries.length === 0) {
    return { schemaVersion: STEP_SCHEMA_VERSION, usable: false, why: '没有任何分段耗时' }
  }

  const accountedMs = entries.reduce((s, e) => s + e.ms, 0)
  const residualMs = step - accountedMs
  const residualPct = (residualMs / step) * 100
  const worst = entries.reduce((m, e) => (m === null || e.ms > m.ms ? e : m), null)

  // 判据（可推导，不用魔数）：残差**比任何单项都大** ⇒ 分解不完整
  const exceedWorst = worst !== null && residualMs > worst.ms
  const tol = num(tolerance)
  const withinTolerance = tol === null
    ? (residualMs <= 0 && Math.abs(residualPct) < 1)   // 默认：分项之和不得超过总时长（超过说明重复计数）
    : Math.abs(residualPct) <= tol

  const problems = []
  if (accountedMs > step * 1.01) {
    problems.push({
      code: 'over-accounted',
      detail: `分项之和 ${accountedMs.toFixed(2)} ms **超过**步总时长 ${step.toFixed(2)} ms `
        + `（${(((accountedMs - step) / step) * 100).toFixed(1)}%）—— 有重复计数，或分项口径与总时长不同源`,
    })
  }
  if (!withinTolerance && tol !== null && Math.abs(residualPct) > tol) {
    problems.push({
      code: 'residual-outside-tolerance',
      detail: `残差 ${residualPct.toFixed(1)}% 超出调用方显式给定的容差 ${tol}%`,
    })
  }
  if (exceedWorst) {
    problems.push({
      code: 'residual-exceeds-worst-part',
      detail: `未归属的残差 ${residualMs.toFixed(2)} ms（${residualPct.toFixed(1)}%）**比最大的单项**
        （${worst.part} ${worst.ms.toFixed(2)} ms）还大 —— 这不是"开销"，这是**分解不完整**`,
    })
  }

  const suggestions = []
  if (residualMs > 0) {
    suggestions.push('确认每一段的口径同源（服务端日志 / GPU 事件 / 引擎计数器三者的时间基准不同）')
    suggestions.push('最常见的三处漏项：host 侧等待（hostGap）、KV 读写（kvRead/kvWrite）、graph 重放与 kernel 启动')
    suggestions.push('若残差集中在某一处，先补测该处，而不是把它归为"开销"')
  }

  return {
    schemaVersion: STEP_SCHEMA_VERSION,
    usable: true,
    stepMs: step,
    accountedMs,
    accountedPct: (accountedMs / step) * 100,
    residualMs,
    residualPct,
    parts: entries.sort((a, b) => b.ms - a.ms),
    worstPart: worst,
    // `complete` 必须同时满足两件事：没有硬问题（重复计数/残差过大）**且**残差落在容差内。
    // 只看 problems 会让"残差 10ms 但没人说它算不算大"这种情况被判成 complete ——
    // 那正是"分解加不起来却照样归因"的入口。
    complete: problems.length === 0 && withinTolerance,
    verdict: accountedMs > step * 1.01
      ? 'over-accounted'
      : (exceedWorst ? 'incomplete' : (withinTolerance ? 'complete' : 'residual-notable')),
    problems,
    suggestions: exceedWorst ? suggestions : [],
    rule: '残差只有两种正当结局：**接近零**，或**被明确归因**。把它叫"开销"并继续拿这份分解做归因，是不允许的。',
  }
}

/**
 * 从引擎侧的一串步耗时序列里挑出**代表性**的一步来分解。
 *
 * 为什么不能取平均：长尾步（GC、KV 换出、图重捕获）会把均值抬起来，
 * 而我们要诊断的是"稳态下每步花在哪"。因此取**中位数**那一步，并把长尾单独报出来。
 */
export function pickRepresentativeStep({ stepDurationsMs = [], percentile = 0.5 } = {}) {
  const xs = stepDurationsMs.map(num).filter((x) => x !== null && x > 0).sort((a, b) => a - b)
  if (xs.length === 0) return { usable: false, why: '没有可用的步耗时样本' }
  // 偶数样本取中间两个的均值（真正的 median；直接取 floor 会偏向较小的一侧）
  const at = (p) => {
    const idx = p * (xs.length - 1)
    const lo = Math.floor(idx)
    const hi = Math.ceil(idx)
    return lo === hi ? xs[lo] : (xs[lo] + xs[hi]) / 2
  }
  return {
    schemaVersion: STEP_SCHEMA_VERSION,
    usable: true,
    n: xs.length,
    representativeMs: at(percentile),
    percentile,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    minMs: xs[0],
    maxMs: xs[xs.length - 1],
    tailRatio: at(0.5) > 0 ? at(0.99) / at(0.5) : null,
    tailNote: (at(0.5) > 0 && at(0.99) / at(0.5) > 1.5)
      ? `长尾明显：p99/p50 = ${(at(0.99) / at(0.5)).toFixed(2)}。`
        + '**先解释长尾再优化中位数** —— 长尾往往来自换出/重捕获/GC，与稳态 kernel 无关。'
      : '长尾不明显，中位数具备代表性',
  }
}
