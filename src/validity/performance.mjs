/**
 * **性能测量的成立性四闸** —— 与 quantization 的精度三闸是同一条原则的两个实例。
 *
 * 用户固化的通用原则：**门禁不仅判"数值是否达标"，还要判"测量是否成立"**。
 * 一个沉默的坏测量比一个显式的失败更危险 —— 它会以"完美结果"的形态通过所有下游检查。
 *
 * 四道闸都来自真实翻车（旧引擎逐条机制化，见 docs/step0/PROJECT_CONTEXT.md §二）：
 *
 * ① **聚合方式未定义**（踩两次）
 *    `maxGoodput_rps` 没写"峰值"还是"期望" ⇒ 两种读法结论相反、都不在预测区间内。
 *    事后无论选哪种都像在择优。→ 聚合口径必须**在预注册里显式声明**。
 *
 * ② **重启后测量不是稳态**
 *    就绪后 ≤3 min 的窗口会塌陷（TTFT_p99 ≈ 10 s）。把它当稳态会得出错误的塌陷率。
 *    → 必须有预热闸：就绪与测量之间要跨越稳态窗口。
 *
 * ③ **事件对齐必须做时滞扫描**
 *    服务端 `Prefill batch` 日志比 GPU 实际执行**早约 150 ms**。
 *    lag=0 时含/不含 prefill 的间隔只差 1.19×，正确时滞下是 **1.44×** ——
 *    不做扫描会把真效应误判为无效应。
 *
 * ④ **Fisher 精确检验的双尾必须只累加"概率不大于观测表"的表**
 *    第一版把所有 i 的概率求和（恒等于 1 ⇒ p 永远 1.0）。
 *
 * 纯函数：不发请求、不读文件、不写状态。
 */

export const MEASUREMENT_SCHEMA_VERSION = '1.0.0'

/** 聚合方式白名单 —— 必须在预注册里显式声明。 */
export const AGGREGATION = Object.freeze({
  PEAK: 'peak',
  MIN: 'min',
  MEAN: 'mean',
  MEDIAN: 'median',
  EXPECTED: 'expected',
  P50: 'p50',
  P95: 'p95',
  P99: 'p99',
  SUM: 'sum',
})

export const VALIDITY_CODES = Object.freeze({
  AGGREGATION_UNDECLARED: 'aggregation-undeclared',
  AGGREGATION_UNKNOWN: 'aggregation-unknown',
  NOT_STEADY_STATE: 'not-steady-state',
  LAG_NOT_SCANNED: 'lag-not-scanned',
  LAG_EFFECT_UNSTABLE: 'lag-effect-unstable',
  INSTRUMENT_CANNOT_SEE: 'instrument-cannot-see',
  STAT_CLAIM_UNSUPPORTED: 'stat-claim-unsupported',
  NO_SAMPLES: 'no-samples',
  SAMPLE_COUNT_TOO_LOW: 'sample-count-too-low',
})

const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 闸 ①：聚合口径已声明。 */
export function checkAggregationDeclared(declared) {
  if (declared === null || declared === undefined || declared === '') {
    return {
      gate: 'aggregation-declared',
      passed: false,
      code: VALIDITY_CODES.AGGREGATION_UNDECLARED,
      reason: '聚合口径未声明 —— 同一个数按"峰值"与"期望"读会得出相反结论，事后无法补救',
      remediation: '在预注册里显式声明聚合口径（peak/min/mean/median/expected/p50/p95/p99/sum）',
    }
  }
  const key = String(declared).toLowerCase()
  const allowed = Object.values(AGGREGATION)
  if (!allowed.includes(key)) {
    return {
      gate: 'aggregation-declared',
      passed: false,
      code: VALIDITY_CODES.AGGREGATION_UNKNOWN,
      reason: `聚合口径 "${declared}" 不在白名单内`,
      remediation: `允许值：${allowed.join(', ')}`,
    }
  }
  return { gate: 'aggregation-declared', passed: true, code: null, declared: key, reason: `聚合口径已声明为 ${key}` }
}

/**
 * 闸 ②：预热/稳态。
 * @param {{readyAt, measuredAt, minSteadyMs}} spec 时间戳（ms epoch 或相对 ms）
 */
export function warmupGate({ readyAt = null, measuredAt = null, minSteadyMs = 60_000 } = {}) {
  const r = num(readyAt)
  const m = num(measuredAt)
  if (r === null || m === null) {
    return {
      gate: 'steady-state',
      passed: false,
      code: VALIDITY_CODES.NOT_STEADY_STATE,
      reason: '缺少"端点就绪时刻"或"测量时刻"，无法证明测量落在稳态窗口内',
      remediation: '记录端点 /v1/models 就绪的时间戳，并确保测量发生在 minSteadyMs 之后',
    }
  }
  const waited = m - r
  const passed = waited >= minSteadyMs
  return {
    gate: 'steady-state',
    passed,
    code: passed ? null : VALIDITY_CODES.NOT_STEADY_STATE,
    waitedMs: waited,
    minSteadyMs,
    reason: passed
      ? `测量发生在就绪后 ${(waited / 1000).toFixed(0)}s（≥ ${(minSteadyMs / 1000).toFixed(0)}s 稳态窗口）`
      : `测量距就绪仅 ${(waited / 1000).toFixed(0)}s，短于稳态窗口 ${(minSteadyMs / 1000).toFixed(0)}s`
        + ' —— 重启后的早期窗口会塌陷（TTFT 长尾暴涨），此时的数据不是稳态数据',
    remediation: passed ? null : `等满 ${(minSteadyMs / 1000).toFixed(0)}s 再测；或调小 options.steadyStateWaitMs（需自担风险并记入报告）`,
  }
}

/**
 * 闸 ③：时滞对齐扫描 —— **两个时钟域**之间的对齐。
 *
 * 为什么不能只是"把时间戳整体平移"：整体平移不改变任何间隔，扫描就退化成一个恒等变换，
 * 永远得出 lag=0 最优。第一版就是这么写的，等于没做扫描。
 *
 * 真实的机制是：**服务端事件**与**设备侧样本**是两个时钟域，服务端日志比 GPU 实际执行
 * 早约 150 ms。做法是——对每个候选 lag，把事件时刻加上 lag 后，取"该时刻之后的第一个设备样本"，
 * 两者之差就是归因给这个事件的时长；按时长分组求均值，比值最大的 lag 就是正确时滞。
 *
 * lag 取小了，事件会捞到**上一个事件尾巴**上的样本，把两类时长混在一起，
 * 分组差异被稀释（实测 1.19×）；取对了才干净（1.44×）。这就是"不做扫描会把真效应误判为无效应"。
 *
 * @param {{
 *   eventTimes: number[],   // 服务端事件时刻（ms，同一钟）
 *   sampleTimes: number[],  // 设备侧样本时刻（ms，另一钟），需升序
 *   groups: number[],       // 每个事件的组标（0/1）
 *   lags?: number[],
 *   minImprovement?: number // 判定"lag=0 会误导"的相对提升阈值
 * }} spec
 */
export function alignEventsWithLag({
  eventTimes = [], sampleTimes = [], groups = [],
  lags = [0, 50, 100, 150, 200, 300],
  minImprovement = 1.05,
} = {}) {
  const ok = Array.isArray(eventTimes) && Array.isArray(sampleTimes) && Array.isArray(groups)
    && eventTimes.length > 0 && eventTimes.length === groups.length && sampleTimes.length > 0
  if (!ok) {
    return {
      gate: 'lag-alignment',
      passed: false,
      code: VALIDITY_CODES.LAG_NOT_SCANNED,
      reason: '缺少 eventTimes / sampleTimes / groups，无法做时滞扫描',
      remediation: '服务端日志与 GPU 执行是两个时钟域，必须提供两侧时间戳才能对齐',
    }
  }
  const samples = [...sampleTimes].map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  const firstAtOrAfter = (t) => {
    let lo = 0
    let hi = samples.length - 1
    let ans = null
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (samples[mid] >= t) { ans = samples[mid]; hi = mid - 1 } else lo = mid + 1
    }
    return ans
  }

  const scan = lags.map((lag) => {
    const buckets = new Map()
    let matched = 0
    let totalDist = 0
    for (let i = 0; i < eventTimes.length; i += 1) {
      const t0 = Number(eventTimes[i]) + lag
      const s = firstAtOrAfter(t0)
      if (s === null) continue
      matched += 1
      totalDist += s - t0
      const g = groups[i]
      if (!buckets.has(g)) buckets.set(g, [])
      buckets.get(g).push(s - t0)
    }
    const means = [...buckets.entries()]
      .map(([g, xs]) => ({ g, mean: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length }))
      .filter((m) => m.mean > 0)
    if (means.length < 2) return { lag, ratio: null, matched, meanDistanceMs: matched ? totalDist / matched : null }
    const lo = Math.min(...means.map((m) => m.mean))
    const hi = Math.max(...means.map((m) => m.mean))
    return {
      lag,
      ratio: lo > 0 ? hi / lo : null,
      groupMeans: means,
      matched,
      meanDistanceMs: matched ? totalDist / matched : null,
    }
  })

  const valid = scan.filter((s) => s.ratio !== null)
  if (valid.length === 0) {
    return {
      gate: 'lag-alignment',
      passed: false,
      code: VALIDITY_CODES.LAG_NOT_SCANNED,
      reason: '时滞扫描无法得到有效效应量（分组不足或时长全为零）',
      remediation: '确认事件分两组，且每个事件之后都存在设备样本',
      scan,
    }
  }

  const best = valid.reduce((m, s) => (s.ratio > m.ratio ? s : m), valid[0])
  const atZero = valid.find((s) => s.lag === 0) ?? null
  const improvement = atZero && atZero.ratio ? best.ratio / atZero.ratio : 1
  const misleadingAtZero = best.lag !== 0 && improvement >= minImprovement

  return {
    gate: 'lag-alignment',
    // 门槛口径：**扫描做过了**就算过。扫描结果本身是证据，不替调用方决定用哪个 lag。
    // 但若 lag=0 会显著低估效应，必须显式报出来（misleadingAtZero）。
    passed: true,
    code: null,
    bestLagMs: best.lag,
    bestRatio: Number(best.ratio.toFixed(4)),
    atZeroRatio: atZero && atZero.ratio !== null ? Number(atZero.ratio.toFixed(4)) : null,
    improvement: Number(improvement.toFixed(4)),
    misleadingAtZero,
    groupMeansAtBest: best.groupMeans ?? null,
    scan: scan.map((s) => ({
      lag: s.lag,
      ratio: s.ratio === null ? null : Number(s.ratio.toFixed(4)),
      matched: s.matched,
      meanDistanceMs: s.meanDistanceMs === null ? null : Number(s.meanDistanceMs.toFixed(2)),
    })),
    reason: misleadingAtZero
      ? `最优时滞 ${best.lag} ms（效应量 ${best.ratio.toFixed(2)}×），而 lag=0 只有 `
        + `${atZero.ratio.toFixed(2)}×（提升 ${((improvement - 1) * 100).toFixed(0)}%）`
        + ' —— **按 lag=0 测量会把这个真效应误判为无效应**，必须用最优时滞'
      : `最优时滞 ${best.lag} ms（效应量 ${best.ratio.toFixed(2)}×）；lag=0 为 `
        + `${atZero && atZero.ratio !== null ? `${atZero.ratio.toFixed(2)}×` : 'n/a'} —— 该效应对时滞不敏感`,
    remediation: null,
  }
}

// ---------------------------------------------------------------- 统计

function logFactorial(n) {
  let s = 0
  for (let i = 2; i <= n; i += 1) s += Math.log(i)
  return s
}

function hypergeomPmf(a, r, c, n) {
  // P(X = a) 超几何分布
  const lc = logFactorial
  return Math.exp(
    lc(r) + lc(n - r) + lc(c) + lc(n - c)
    - lc(n) - lc(a) - lc(r - a) - lc(c - a) - lc(n - r - c + a),
  )
}

/**
 * 闸 ④：Fisher 精确检验（双尾）。
 *
 * **双尾口径**：累加所有"概率 ≤ 观测表概率"的表 —— 不是把所有 i 的概率求和
 * （那恒等于 1，p 永远 1.0）。旧引擎第一版就是这么错的。
 *
 * 表形： [[a, b], [c, d]]
 * @returns {{p, oddsRatio, observed, tablesConsidered}}
 */
export function fisherExact2x2(table) {
  if (!Array.isArray(table) || table.length !== 2 || table[0].length !== 2) {
    throw new Error('fisherExact2x2 需要 [[a,b],[c,d]]')
  }
  const [[a, b], [c, d]] = table.map((r) => r.map((x) => Number(x)))
  if ([a, b, c, d].some((x) => !Number.isInteger(x) || x < 0)) throw new Error('fisherExact2x2 需要非负整数')
  const r1 = a + b
  const r2 = c + d
  const c1 = a + c
  const n = a + b + c + d
  if (n === 0) throw new Error('fisherExact2x2 需要非空表')

  const pObs = hypergeomPmf(a, r1, c1, n)
  const lo = Math.max(0, c1 - r2)
  const hi = Math.min(r1, c1)
  let p = 0
  let considered = 0
  for (let x = lo; x <= hi; x += 1) {
    const px = hypergeomPmf(x, r1, c1, n)
    if (px <= pObs * (1 + 1e-12)) { p += px; considered += 1 }
  }
  const oddsRatio = (b === 0 || c === 0) ? Infinity : (a * d) / (b * c)
  return {
    p: Math.min(1, p),
    oddsRatio,
    observed: [[a, b], [c, d]],
    tablesConsidered: considered,
    tablesTotal: hi - lo + 1,
    pObserved: pObs,
  }
}

/**
 * 统计出处闸：声称"有提升"必须走白名单估计量 + 达到样本量。
 */
export const APPROVED_ESTIMATORS = Object.freeze({
  'fisher-exact-2x2': { minSamples: 8, note: '两组成功/失败计数的精确检验（双尾）' },
  'median-delta': { minSamples: 10, note: '中位数差（对长尾稳健），需声明聚合口径为 median' },
  'mean-delta': { minSamples: 20, note: '均值差（对长尾不稳健，需先声明并给出方差）' },
  'paired-median-delta': { minSamples: 6, note: '配对中位数差（同一批请求前后各一次的优先口径）' },
})

export function gateStatisticalClaim({ estimator = null, samples = 0, declaredAggregation = null } = {}) {
  if (!estimator) {
    return {
      gate: 'statistical-provenance',
      passed: false,
      code: VALIDITY_CODES.STAT_CLAIM_UNSUPPORTED,
      reason: '未声明所用估计量 —— 无法判断该结论有没有统计出处',
      remediation: `从白名单里选一个：${Object.keys(APPROVED_ESTIMATORS).join(', ')}`,
    }
  }
  const spec = APPROVED_ESTIMATORS[estimator]
  if (!spec) {
    return {
      gate: 'statistical-provenance',
      passed: false,
      code: VALIDITY_CODES.STAT_CLAIM_UNSUPPORTED,
      reason: `估计量 "${estimator}" 不在白名单内`,
      remediation: `允许值：${Object.keys(APPROVED_ESTIMATORS).join(', ')}`,
    }
  }
  const n = num(samples) ?? 0
  if (n < spec.minSamples) {
    return {
      gate: 'statistical-provenance',
      passed: false,
      code: VALIDITY_CODES.SAMPLE_COUNT_TOO_LOW,
      reason: `估计量 ${estimator} 需要 ≥ ${spec.minSamples} 个样本，实得 ${n}`,
      remediation: `提高 requests 到至少 ${spec.minSamples}，或改用需求更低的估计量`,
      estimator, minSamples: spec.minSamples, samples: n,
    }
  }
  const aggGate = checkAggregationDeclared(declaredAggregation)
  if (!aggGate.passed) return { ...aggGate, gate: 'statistical-provenance' }
  return {
    gate: 'statistical-provenance',
    passed: true,
    code: null,
    estimator, samples: n, aggregation: aggGate.declared,
    reason: `估计量 ${estimator}（样本 ${n} ≥ ${spec.minSamples}）+ 聚合口径 ${aggGate.declared}`,
  }
}

export function listApprovedEstimators() {
  return Object.entries(APPROVED_ESTIMATORS).map(([id, v]) => ({ id, ...v }))
}

/**
 * 汇总四闸。
 * @returns {{valid, gates, reasons, checks}}
 */
export function evaluatePerformanceValidity({
  aggregation = null,
  readyAt = null,
  measuredAt = null,
  minSteadyMs = 60_000,
  eventTimes = null,
  sampleTimes = null,
  groups = null,
  lags = null,
  estimator = null,
  samples = 0,
  skipLagScan = false,
  claimedMinEffectPct = null,
  noisePct = null,
} = {}) {
  const gates = []
  gates.push(checkAggregationDeclared(aggregation))
  gates.push(warmupGate({ readyAt, measuredAt, minSteadyMs }))
  if (skipLagScan) {
    gates.push({
      gate: 'lag-alignment',
      passed: true,
      code: null,
      skipped: true,
      reason: '本轮干预不依赖事件时滞（调用方显式声明）—— 已记入报告',
    })
  } else if (eventTimes && sampleTimes && groups) {
    gates.push(alignEventsWithLag({ eventTimes, sampleTimes, groups, lags: lags ?? undefined }))
  } else {
    gates.push({
      gate: 'lag-alignment',
      passed: false,
      code: VALIDITY_CODES.LAG_NOT_SCANNED,
      reason: '未提供两侧时间戳，也未被显式跳过 —— 时滞对齐未做',
      remediation: '提供 eventTimes/sampleTimes/groups，或显式声明 skipLagScan=true（会记入报告）',
    })
  }
  gates.push(gateStatisticalClaim({ estimator, samples, declaredAggregation: aggregation }))

  // 第 5 道闸（可选）：**仪器必须看得见它所声称的效应**。
  // 只在调用方同时给出"声称的最小效应"与"测量噪声"时启用 ——
  // 缺任一项时宁可不判，也不假装判过。
  if (claimedMinEffectPct !== null && claimedMinEffectPct !== undefined
      && noisePct !== null && noisePct !== undefined) {
    const claim = num(claimedMinEffectPct)
    const noise = num(noisePct)
    if (claim !== null && noise !== null) {
      const cannotSee = noise > claim
      gates.push({
        gate: 'instrument-self-match',
        passed: !cannotSee,
        code: cannotSee ? VALIDITY_CODES.INSTRUMENT_CANNOT_SEE : null,
        claimedMinEffectPct: claim,
        noisePct: noise,
        signalToNoise: noise === 0 ? Infinity : claim / noise,
        reason: cannotSee
          ? `声称的最小效应 ${claim}% **小于**测量噪声 ${noise}%（相对标准误）—— `
            + '该仪器原理上看不见这个效应。此时"没观察到提升"推不出"没有提升"，只能说"看不见"。'
          : `声称的最小效应 ${claim}% vs 测量噪声 ${noise}%（信噪比 ${(noise === 0 ? Infinity : claim / noise).toFixed(2)}）`,
        remediation: cannotSee ? '提高信噪比（加样本 / 换聚合口径 / 降噪），或放弃这个量级的断言' : null,
      })
    }
  }

  const failed = gates.filter((g) => !g.passed)
  return {
    schemaVersion: MEASUREMENT_SCHEMA_VERSION,
    valid: failed.length === 0,
    gates,
    reasons: failed.map((g) => ({ code: g.code, gate: g.gate, reason: g.reason })),
    checks: Object.fromEntries(gates.map((g) => [g.gate, g.passed])),
  }
}
