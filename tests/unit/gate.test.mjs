/**
 * 门禁：阈值来源、双侧数值判定、**精度测量成立性三闸**、合并判定。
 *
 * 复用真实数据：精度三闸的回归用例直接复刻 2026-09-23 真机事故的原始数值
 * （meanNll = 11.93121445743442，ppl = 151935.97，vocab_size = 151936）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveThresholds, evaluatePerfGate, evaluateAccuracyGate,
  assertAccuracyMeasurementValid, evaluateGates, nearLimitTokenFor,
} from '../../src/gate.mjs'

const rt = (gates = null) => ({ policy: { gates }, paths: { gatesFile: '/tmp/gates.yaml' }, warnings: [] })

test('阈值: 调用方提供 → 用调用方的', () => {
  const t = resolveThresholds(rt({ max_accuracy_drop_pct: 99, min_perf_gain_pct: 99 }), { maxAccuracyDropPct: 5, minPerfGainPct: 20 })
  assert.equal(t.maxAccuracyDropPct, 5)
  assert.equal(t.minPerfGainPct, 20)
  assert.equal(t.source.maxAccuracyDropPct, 'caller')
})

test('阈值: 调用方未传 → 读 gates.yaml', () => {
  const t = resolveThresholds(rt({ max_accuracy_drop_pct: 7, min_perf_gain_pct: 11 }), {})
  assert.equal(t.maxAccuracyDropPct, 7)
  assert.equal(t.minPerfGainPct, 11)
  assert.equal(t.source.maxAccuracyDropPct, 'gates.yaml')
})

test('阈值: 两者都无 → **拒绝执行**，不猜默认值', () => {
  assert.throws(
    () => resolveThresholds(rt({ max_accuracy_drop_pct: null, min_perf_gain_pct: null }), {}),
    (e) => {
      assert.equal(e.code, 'E_THRESHOLD_NOT_PROVIDED')
      assert.match(e.remediation, /不会.*猜/)
      assert.ok(e.details.missing.length === 2)
      return true
    },
  )
})

test('阈值: 只缺一个也要拒绝，并点名缺哪个', () => {
  assert.throws(
    () => resolveThresholds(rt({ max_accuracy_drop_pct: 5, min_perf_gain_pct: null }), {}),
    (e) => e.details.missing.some((m) => m.includes('min_perf_gain_pct')),
  )
})

test('阈值: 负的精度容忍被拒绝', () => {
  assert.throws(() => resolveThresholds(rt(null), { maxAccuracyDropPct: -1, minPerfGainPct: 0 }), (e) => e.code === 'E_THRESHOLD_NOT_PROVIDED')
})

test('数值门禁: 性能/精度各自的通过与否', () => {
  assert.equal(evaluatePerfGate({ gainPct: 25, thresholdPct: 20 }).passed, true)
  assert.equal(evaluatePerfGate({ gainPct: 5, thresholdPct: 20 }).passed, false)
  assert.equal(evaluatePerfGate({ gainPct: null, thresholdPct: 20 }).undetermined, true)
  assert.equal(evaluateAccuracyGate({ dropPct: 3, thresholdPct: 5 }).passed, true)
  assert.equal(evaluateAccuracyGate({ dropPct: 8, thresholdPct: 5 }).passed, false)
  assert.equal(evaluateAccuracyGate({ dropPct: 4.7, thresholdPct: 5 }).nearLimit, true, '4.7/5 = 94% → 接近上限')
})

// ---------------------------------------------------------------- 精度三闸

const healthy = ({ meanNll = 2.7, vocabSize = 151936, n = 30, jitter = 0.35 } = {}) => ({
  meanNll,
  perplexity: Math.exp(meanNll),
  vocabSize,
  scoredSamples: n,
  tokens: n * 40,
  validity: { valid: true, reasons: [] },
  itemMeanNlls: Array.from({ length: n }, (_, i) => meanNll + jitter * Math.sin(i * 1.7)),
})

test('精度三闸: 健康测量 → valid', () => {
  const r = assertAccuracyMeasurementValid({ before: healthy(), after: healthy({ meanNll: 2.75 }) })
  assert.equal(r.valid, true, JSON.stringify(r.reasons))
  assert.equal(r.checks.bitIdenticalMeanNll, false)
  assert.ok(r.checks.beforeUniformGap > 9, '离均匀签名很远')
})

test('精度三闸: 复刻真机事故数值 → 三条否证同时命中', () => {
  const incident = {
    meanNll: 11.93121445743442,
    perplexity: 151935.96944645362,
    vocabSize: 151936,
    scoredSamples: 400,
    tokens: 65850,
    itemMeanNlls: Array.from({ length: 400 }, () => 11.93121445743442),
  }
  const r = assertAccuracyMeasurementValid({ before: incident, after: incident })
  assert.equal(r.valid, false)
  const codes = r.reasons.map((x) => x.code)
  assert.ok(codes.includes('uniform-output'), JSON.stringify(codes))
  assert.ok(codes.includes('indiscriminate'))
  assert.ok(codes.includes('no-item-variance'))
  assert.ok(r.checks.beforeUniformGap <= 1e-4)
})

test('精度三闸: 均匀输出签名用 ln(vocab_size) —— 可推导的等式，不是魔数', () => {
  const vocab = 32000
  const uniform = Math.log(vocab)
  const r = assertAccuracyMeasurementValid({ before: healthy({ meanNll: uniform, vocabSize: vocab }), after: healthy({ meanNll: 3, vocabSize: vocab }) })
  assert.ok(r.reasons.some((x) => x.code === 'uniform-output'))
  assert.ok(Math.abs(r.checks.beforeUniformLoss - uniform) < 1e-12)
})

test('精度三闸: 逐条极差用精确比较（不需要容差魔数）', () => {
  const flat = { ...healthy({ n: 20 }), itemMeanNlls: Array(20).fill(2.5) }
  const r = assertAccuracyMeasurementValid({ before: flat, after: healthy({ meanNll: 2.9 }) })
  assert.ok(r.reasons.some((x) => x.code === 'no-item-variance'))
  assert.equal(r.checks.beforeItemMeanNllRange, 0)
})

test('精度三闸: 未取到 vocabSize → 不做均匀判定（不猜）', () => {
  const r = assertAccuracyMeasurementValid({
    before: healthy({ vocabSize: null }), after: healthy({ meanNll: 2.9, vocabSize: null }),
  })
  assert.equal(r.valid, true)
  assert.equal(r.checks.beforeUniformGap, null)
})

test('精度三闸: 测量端自报无效 → 原样上抛，保留原因', () => {
  const bad = { ...healthy(), validity: { valid: false, reasons: [{ code: 'zero-weight-tensors', detail: '223 张大张量整块为零' }] } }
  const r = assertAccuracyMeasurementValid({ before: bad, after: healthy({ meanNll: 2.9 }) })
  assert.equal(r.valid, false)
  assert.equal(r.reasons[0].code, 'sidecar:zero-weight-tensors')
  assert.match(r.reasons[0].message, /223/)
})

test('精度三闸: 无评分样本 / 缺一侧 → 都被拦下', () => {
  assert.ok(assertAccuracyMeasurementValid({ before: healthy({ n: 0, scoredSamples: 0 }), after: healthy() }).reasons.some((x) => x.code === 'no-scored-samples'))
  assert.ok(assertAccuracyMeasurementValid({ before: healthy(), after: null }).reasons.some((x) => x.code === 'missing-side'))
})

// ---------------------------------------------------------------- 合并判定

test('合并: 测量不成立 → undetermined、不可签收（数值再好也不签）', () => {
  const incident = {
    meanNll: 11.93121445743442, perplexity: 151935.96944645362, vocabSize: 151936,
    scoredSamples: 400, itemMeanNlls: Array(400).fill(11.93121445743442),
  }
  const g = evaluateGates({
    perf: { gainPct: 500 }, accuracy: { dropPct: 0 },
    thresholds: { maxAccuracyDropPct: 50, minPerfGainPct: 0, nearLimitFactor: 0.9 },
    accuracyValidity: assertAccuracyMeasurementValid({ before: incident, after: incident }),
    performanceValidity: { valid: true, reasons: [] },
  })
  assert.equal(g.decision, 'undetermined')
  assert.equal(g.passed, false)
  assert.equal(g.signable, false)
  assert.equal(g.measurementValid, false)
  assert.ok(g.reasons.some((r) => r.startsWith('精度测量[')), JSON.stringify(g.reasons))
})

test('合并: 性能测量不成立同样拒绝', () => {
  const g = evaluateGates({
    perf: { gainPct: 50 }, accuracy: { dropPct: 1 },
    thresholds: { maxAccuracyDropPct: 5, minPerfGainPct: 10, nearLimitFactor: 0.9 },
    accuracyValidity: { valid: true, reasons: [] },
    performanceValidity: { valid: false, reasons: [{ code: 'not-steady-state', reason: '测量距就绪仅 5s' }] },
  })
  assert.equal(g.decision, 'undetermined')
  assert.ok(g.reasons.some((r) => r.includes('not-steady-state')), JSON.stringify(g.reasons))
})

test('合并: 数值达标且测量成立 → accept', () => {
  const g = evaluateGates({
    perf: { gainPct: 30 }, accuracy: { dropPct: 2 },
    thresholds: { maxAccuracyDropPct: 10, minPerfGainPct: 20, nearLimitFactor: 0.9 },
    accuracyValidity: { valid: true, reasons: [] },
    performanceValidity: { valid: true, reasons: [] },
  })
  assert.equal(g.decision, 'accept')
  assert.equal(g.passed, true)
  assert.equal(g.signable, true)
})

test('合并: 精度不达标 → rollback（不是"继续调"，而是先回退）', () => {
  const g = evaluateGates({
    perf: { gainPct: 80 }, accuracy: { dropPct: 30 },
    thresholds: { maxAccuracyDropPct: 5, minPerfGainPct: 10, nearLimitFactor: 0.9 },
    accuracyValidity: { valid: true, reasons: [] },
    performanceValidity: { valid: true, reasons: [] },
  })
  assert.equal(g.decision, 'rollback')
  assert.equal(g.passed, false)
  assert.equal(g.accuracy.passed, false)
})

test('合并: 接近上限 → confirm-near-limit（需确认令牌）', () => {
  const g = evaluateGates({
    perf: { gainPct: 30 }, accuracy: { dropPct: 4.8 },
    thresholds: { maxAccuracyDropPct: 5, minPerfGainPct: 20, nearLimitFactor: 0.9 },
    accuracyValidity: { valid: true, reasons: [] },
    performanceValidity: { valid: true, reasons: [] },
  })
  assert.equal(g.decision, 'confirm-near-limit')
  assert.equal(g.needsConfirmation, true)
  assert.equal(g.signable, false)
})

test('合并: 性能目标为 0 时不产生"接近上限"（阈值 0 时该概念无意义）', () => {
  const g = evaluateGates({
    perf: { gainPct: 0.1 }, accuracy: { dropPct: 0 },
    thresholds: { maxAccuracyDropPct: 5, minPerfGainPct: 0, nearLimitFactor: 0.9 },
    accuracyValidity: { valid: true, reasons: [] },
    performanceValidity: { valid: true, reasons: [] },
  })
  assert.equal(g.perf.nearLimit, false)
  assert.equal(g.decision, 'accept')
})

test('令牌: 绑定具体目标（不同配置不会得到同一个令牌）', () => {
  const a = nearLimitTokenFor({ model: '/m', configKey: 'k1', dropPct: 4.8, gainPct: 30 })
  const b = nearLimitTokenFor({ model: '/m', configKey: 'k2', dropPct: 4.8, gainPct: 30 })
  const c = nearLimitTokenFor({ model: '/m', configKey: 'k1', dropPct: 4.8, gainPct: 30 })
  assert.notEqual(a, b)
  assert.equal(a, c)
  assert.match(a, /^nlt_/)
})
