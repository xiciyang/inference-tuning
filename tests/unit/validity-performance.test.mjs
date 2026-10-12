/**
 * 性能测量成立性四闸 —— 单元测试。
 *
 * 四道闸都来自真实翻车，所以每条用例都对应一个**必须被拦住**的形态：
 *   ① 聚合口径未声明（同一个数按"峰值"与"期望"读会得出相反结论）
 *   ② 重启后早期窗口不是稳态（TTFT 长尾塌陷）
 *   ③ 不做时滞扫描会把真效应误判为无效应（1.19× vs 1.44×）
 *   ④ Fisher 双尾必须只累加"概率不大于观测表"的表（否则 p 恒为 1.0）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGGREGATION, checkAggregationDeclared, warmupGate, alignEventsWithLag,
  fisherExact2x2, gateStatisticalClaim, evaluatePerformanceValidity,
  APPROVED_ESTIMATORS, listApprovedEstimators,
} from '../../src/validity/performance.mjs'

test('闸①: 未声明聚合口径 → 拒绝（这是最容易事后择优的地方）', () => {
  const r = checkAggregationDeclared(null)
  assert.equal(r.passed, false)
  assert.equal(r.code, 'aggregation-undeclared')
  assert.match(r.reason, /峰值|期望/)
})

test('闸①: 白名单外的口径 → 拒绝并列出允许值', () => {
  const r = checkAggregationDeclared('whatever')
  assert.equal(r.passed, false)
  assert.equal(r.code, 'aggregation-unknown')
  assert.ok(r.remediation.includes('median'))
})

test('闸①: 合法口径通过', () => {
  for (const a of Object.values(AGGREGATION)) {
    assert.equal(checkAggregationDeclared(a).passed, true, a)
  }
})

test('闸②: 稳态窗口不足 → 拒绝（重启后 ≤3min 的窗口会塌陷）', () => {
  const short = warmupGate({ readyAt: 0, measuredAt: 30_000, minSteadyMs: 60_000 })
  assert.equal(short.passed, false)
  assert.equal(short.code, 'not-steady-state')
  assert.match(short.reason, /塌陷/)
  const ok = warmupGate({ readyAt: 0, measuredAt: 120_000, minSteadyMs: 60_000 })
  assert.equal(ok.passed, true)
  assert.equal(ok.waitedMs, 120_000)
})

test('闸②: 缺任一时间戳 → 拒绝（不假设它稳了）', () => {
  assert.equal(warmupGate({ readyAt: null, measuredAt: 1000 }).passed, false)
  assert.equal(warmupGate({ readyAt: 0, measuredAt: null }).passed, false)
})

test('闸③: 复刻真机时滞场景 —— 正确 lag 下效应 1.44×，lag=0 只有 1.03×', () => {
  const trueLag = 150
  const dur = [10, 14.4]              // 两类时长，真比值 = 1.44
  const eventTimes = []
  const sampleTimes = []
  const groups = []
  for (let i = 0; i < 20; i += 1) {
    const t = i * 1000
    const g = i % 2
    eventTimes.push(t)
    groups.push(g)
    sampleTimes.push(t + trueLag + dur[g])
  }
  const r = alignEventsWithLag({ eventTimes, sampleTimes, groups })
  assert.equal(r.passed, true)
  assert.equal(r.bestLagMs, 150)
  assert.ok(Math.abs(r.bestRatio - 1.44) < 0.01, `实际 ${r.bestRatio}`)
  assert.ok(r.atZeroRatio < 1.1, `lag=0 应被稀释，实际 ${r.atZeroRatio}`)
  assert.equal(r.misleadingAtZero, true)
  assert.match(r.reason, /误判为无效应/)
  // 扫描本身是证据
  assert.equal(r.scan.length, 6)
  assert.ok(r.scan.every((s) => s.matched > 0))
})

test('闸③: 效应确实与时滞无关时，如实报"不敏感"而不是硬选一个 lag', () => {
  const eventTimes = []
  const sampleTimes = []
  const groups = []
  for (let i = 0; i < 20; i += 1) {
    const t = i * 1000
    const g = i % 2
    eventTimes.push(t)
    groups.push(g)
    sampleTimes.push(t + 10 + (g ? 0.2 : 0))   // 时滞为 0，效应小
  }
  const r = alignEventsWithLag({ eventTimes, sampleTimes, groups })
  assert.equal(r.passed, true, '扫描做过了就算过')
  assert.equal(r.misleadingAtZero, false)
  assert.match(r.reason, /不敏感/)
})

test('闸③: 缺少两侧时间戳 → 拒绝，并说明"这是两个时钟域"', () => {
  const r = alignEventsWithLag({ eventTimes: [], sampleTimes: [], groups: [] })
  assert.equal(r.passed, false)
  assert.equal(r.code, 'lag-not-scanned')
  assert.match(r.remediation, /时钟域/)
})

test('闸④: Fisher 精确检验双尾 —— 与教科书值一致', () => {
  const r1 = fisherExact2x2([[3, 1], [1, 3]])
  assert.ok(Math.abs(r1.p - 0.485714) < 1e-5, `实际 ${r1.p}`)
  const r2 = fisherExact2x2([[1, 9], [9, 1]])
  assert.ok(Math.abs(r2.p - 0.0010928) < 1e-6, `实际 ${r2.p}`)
  const r3 = fisherExact2x2([[10, 0], [0, 10]])
  assert.ok(r3.p < 1e-4)
})

test('闸④: 完全相同的两组 → p = 1（而不是恒等于 1 的假实现）', () => {
  const r = fisherExact2x2([[5, 5], [5, 5]])
  assert.equal(r.p, 1)
  assert.equal(r.tablesConsidered, r.tablesTotal, '所有表都被考虑')
})

test('闸④: 双尾只累加"概率不大于观测表"的表（不是全部求和）', () => {
  const r = fisherExact2x2([[1, 9], [9, 1]])
  assert.ok(r.tablesConsidered < r.tablesTotal, '必须排除概率更大的表')
  assert.ok(r.pObserved > 0)
})

test('闸④: 非法输入响亮报错，不猜', () => {
  assert.throws(() => fisherExact2x2([[1, 2]]), /需要/)
  assert.throws(() => fisherExact2x2([[1.5, 2], [3, 4]]), /整数/)
})

test('统计出处闸: 未声明估计量 → 拒绝', () => {
  const r = gateStatisticalClaim({ estimator: null, samples: 10 })
  assert.equal(r.passed, false)
  assert.equal(r.code, 'stat-claim-unsupported')
})

test('统计出处闸: 白名单外的估计量 → 拒绝并列出允许值', () => {
  const r = gateStatisticalClaim({ estimator: 'vibes-based', samples: 100, declaredAggregation: 'median' })
  assert.equal(r.passed, false)
  assert.ok(r.remediation.includes('fisher-exact-2x2'))
})

test('统计出处闸: 样本量不足 → 拒绝（并给出该估计量的下限）', () => {
  const r = gateStatisticalClaim({ estimator: 'mean-delta', samples: 5, declaredAggregation: 'mean' })
  assert.equal(r.passed, false)
  assert.equal(r.code, 'sample-count-too-low')
  assert.equal(r.minSamples, APPROVED_ESTIMATORS['mean-delta'].minSamples)
})

test('统计出处闸: 样本量够但聚合口径未声明 → 仍然拒绝', () => {
  const r = gateStatisticalClaim({ estimator: 'median-delta', samples: 20, declaredAggregation: null })
  assert.equal(r.passed, false)
  assert.equal(r.gate, 'statistical-provenance')
})

test('统计出处闸: 合规 → 通过，并在理由里同时写出估计量与口径', () => {
  const r = gateStatisticalClaim({ estimator: 'median-delta', samples: 12, declaredAggregation: 'median' })
  assert.equal(r.passed, true)
  assert.match(r.reason, /median-delta/)
  assert.match(r.reason, /median/)
  assert.ok(listApprovedEstimators().length >= 4)
})

test('汇总: 四闸全过 → valid；任一不过 → 指出是哪一道', () => {
  const good = evaluatePerformanceValidity({
    aggregation: 'median', readyAt: 0, measuredAt: 120_000,
    estimator: 'median-delta', samples: 12, skipLagScan: true,
  })
  assert.equal(good.valid, true)
  assert.deepEqual(good.checks, {
    'aggregation-declared': true, 'steady-state': true, 'lag-alignment': true, 'statistical-provenance': true,
  })

  const bad = evaluatePerformanceValidity({
    aggregation: null, readyAt: 0, measuredAt: 1000, estimator: null, samples: 2,
  })
  assert.equal(bad.valid, false)
  assert.ok(bad.reasons.length >= 3)
  assert.ok(bad.reasons.every((r) => r.code && r.gate && r.reason))
})

test('汇总: 显式跳过时滞扫描会被记为 skipped（透明，不是静默放过）', () => {
  const r = evaluatePerformanceValidity({
    aggregation: 'median', readyAt: 0, measuredAt: 120_000,
    estimator: 'median-delta', samples: 12, skipLagScan: true,
  })
  const lag = r.gates.find((g) => g.gate === 'lag-alignment')
  assert.equal(lag.skipped, true)
  assert.match(lag.reason, /不依赖事件时滞/)
})
