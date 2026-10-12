/**
 * 主张门禁 + 预注册。
 *
 * 两个要防的东西：
 *   · **把推断写成实测**（升格）
 *   · **事后择优**（跑完再编一个"我本来就想验证这个"）
 *
 * 以及一个最容易忽略的：**仪器看不见的效应，测多少次都看不见** ——
 * 它把"我没测出来"与"它不存在"分开，这属于"测量不成立"，不是"没有效应"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROVENANCE, CLAIM_VERDICT, gateClaim, gateCeiling, gateQuantitative, gateInferredClaim, gateClaims,
} from '../../src/validity/claims.mjs'
import {
  preregister, judge, checkEffectAssertions, checkVerificationStrength, checkInstrumentSelfMatch,
  checkPreregTiming, PREREG_VERDICT, JUDGE_VERDICT,
} from '../../src/loop/prereg.mjs'
import { singleStreamCeiling } from '../../src/walls/ceiling.mjs'

// ---------------------------------------------------------------- 主张门禁

test('主张: 实测必须给证据；推导必须给输入项', () => {
  assert.equal(gateClaim({ claim: 'x', provenance: PROVENANCE.MEASURED, evidence: null }).verdict, CLAIM_VERDICT.NEEDS_EVIDENCE)
  assert.equal(gateClaim({ claim: 'x', provenance: PROVENANCE.MEASURED, evidence: { cmd: 'docker run …' } }).verdict, CLAIM_VERDICT.OK)
  assert.equal(gateClaim({ claim: 'x', provenance: PROVENANCE.DERIVED, evidence: null }).verdict, CLAIM_VERDICT.NEEDS_EVIDENCE)
  assert.equal(gateClaim({ claim: 'x', provenance: PROVENANCE.DERIVED, evidence: { formula: 'a/b', inputs: {} } }).verdict, CLAIM_VERDICT.OK)
})

test('主张: **规格书峰值是禁用项，不是低等级**', () => {
  for (const p of ['spec-sheet', 'theoretical-peak', 'datasheet']) {
    const r = gateClaim({ claim: 'x', provenance: p })
    assert.equal(r.verdict, CLAIM_VERDICT.FORBIDDEN_SOURCE, p)
    assert.match(r.reasons[0].detail, /禁用项/)
  }
})

test('主张: 推断必须给依据**与否证条件**（不可证伪的推断等于没说）', () => {
  const noBasis = gateClaim({ claim: 'x', provenance: PROVENANCE.INFERRED })
  assert.equal(noBasis.verdict, CLAIM_VERDICT.NEEDS_FALSIFIER)
  const codes = noBasis.reasons.map((r) => r.code)
  assert.ok(codes.includes('inferred-without-basis'))
  assert.ok(codes.includes('inferred-without-falsifier'))

  const ok = gateClaim({ claim: 'x', provenance: PROVENANCE.INFERRED, basis: '因为 y', falsifiableBy: '若观察到 z' })
  assert.equal(ok.verdict, CLAIM_VERDICT.OK)
})

test('主张: **升格检测** —— 推断写成结论口吻会被抓出来', () => {
  const r = gateClaim({
    claim: '带宽是瓶颈', provenance: PROVENANCE.INFERRED, basis: 'b', falsifiableBy: 'f',
    assertedAs: '带宽确实是瓶颈',
  })
  assert.equal(r.verdict, CLAIM_VERDICT.NEEDS_EVIDENCE)
  assert.ok(r.reasons.some((x) => x.code === 'promoted-inference'))
})

test('主张: 没声明出处 → 拒绝（无出处的陈述不得进报告）', () => {
  const r = gateClaim({ claim: 'x' })
  assert.equal(r.verdict, CLAIM_VERDICT.NEEDS_EVIDENCE)
  assert.equal(r.reasons[0].code, 'no-provenance')
})

test('天花板门禁: 没有限定条件 → 不得作为"物理上限"陈述', () => {
  const r = gateCeiling({ ceiling: { ceilingTps: 100 }, conditions: [] })
  assert.equal(r.verdict, CLAIM_VERDICT.NEEDS_FALSIFIER)
  assert.ok(r.reasons.some((x) => x.code === 'no-conditions'))
  assert.match(r.requiredWording, /不得作为物理上限/)
})

test('天花板门禁: 只有"引擎镜像"这类条件 → 仍判不合格（不算实现域）', () => {
  const r = gateCeiling({ ceiling: { ceilingTps: 100 }, conditions: [{ kind: 'engine', text: '镜像 X' }] })
  assert.ok(r.reasons.some((x) => x.code === 'no-implementation-scope'))
})

test('天花板门禁: 有实现域条件 + sanity 通过 → OK，并给出**规定的措辞**', () => {
  const r = gateCeiling({
    ceiling: { ceilingTps: 42.5, sanity: { ok: true } },
    conditions: [{ kind: 'kernel', text: '当前 kernel 实现：flash-attn' }, { kind: 'quant', text: '量化精度：awq-w4a16' }],
  })
  assert.equal(r.verdict, CLAIM_VERDICT.OK)
  assert.match(r.requiredWording, /在当前实现条件下/)
  assert.match(r.requiredWording, /42\.5/)
})

test('天花板门禁: sanity 失败 → 拒绝（口径错了就不是上界）', () => {
  const r = gateCeiling({
    ceiling: { ceilingTps: 100, sanity: { ok: false, warn: '反推带宽超过实测可达' } },
    conditions: [{ kind: 'kernel', text: 'k' }],
  })
  assert.ok(r.reasons.some((x) => x.code === 'failed-sanity'))
})

test('数量门禁: 值/单位/聚合口径/样本数/出处，缺一不可复核', () => {
  const perfect = gateQuantitative({ name: 'decodeTps', value: 62.1, unit: 'tok/s', aggregation: 'median', samples: 8, provenance: 'measured', evidence: { source: 'x' } })
  assert.equal(perfect.verdict, CLAIM_VERDICT.OK)

  const missing = gateQuantitative({ name: 'decodeTps', value: 62.1, unit: 'tok/s' })
  const codes = missing.reasons.map((r) => r.code)
  assert.ok(codes.includes('no-aggregation'))
  assert.ok(codes.includes('no-samples'))
  assert.ok(codes.includes('no-provenance'))
  assert.match(missing.rule, /聚合口径/)
})

test('数量门禁: 样本数为 0 与服务端禁用项都被拦', () => {
  assert.ok(gateQuantitative({ name: 'x', value: 1, unit: 'u', aggregation: 'median', samples: 0, provenance: 'measured', evidence: {} })
    .reasons.some((r) => r.code === 'zero-samples'))
  assert.ok(gateQuantitative({ name: 'x', value: 1, unit: 'u', aggregation: 'median', samples: 8, provenance: 'spec-sheet' })
    .reasons.some((r) => r.code === 'forbidden-provenance'))
})

test('推断门禁: 与实测并列排版会被拦（分不清哪些能信）', () => {
  const r = gateInferredClaim({ claim: 'c', basis: 'b', falsifiableBy: 'f', presentedAlongsideMeasured: true })
  assert.ok(r.reasons.some((x) => x.code === 'mixed-presentation'))
  assert.match(r.requiredWording, /推断（未验证）/)
})

test('批量门禁: 汇总失败项与原因码', () => {
  const g = gateClaims([
    { kind: 'quantitative', name: 'a', value: 1, unit: 'u', aggregation: 'median', samples: 8, provenance: 'measured', evidence: {} },
    { kind: 'inferred', claim: 'c', basis: 'b' },   // 缺否证条件
  ])
  assert.equal(g.total, 2)
  assert.equal(g.ok, 1)
  assert.equal(g.allOk, false)
  assert.equal(g.failedDetails[0].kind, 'inferred')
})

// ---------------------------------------------------------------- 预注册

const goodReg = () => preregister({
  hypothesis: 'bandwidth 是根因墙，提高并发可解除',
  wallId: 'bandwidth', lever: 'concurrency_capacity',
  metric: 'decodeTps', direction: 'increase', minEffectPct: 20,
  aggregation: 'median', samples: 8,
  falsify: '提高并发后 decodeTps 不升反降',
})

test('预注册: 合格的登记 → registered=true 且带指纹与时间戳', () => {
  const r = goodReg()
  assert.equal(r.registered, true)
  assert.match(r.fingerprint, /^pr_/)
  assert.ok(r.registeredAt)
  assert.equal(r.verdict, PREREG_VERDICT.OK)
})

test('预注册: 效应断言必须具体 —— "会变好"不是可判定的断言', () => {
  const r = preregister({ hypothesis: 'h', direction: 'sideways', aggregation: 'median', samples: 8, falsify: 'f' })
  const codes = r.problems.map((p) => p.code)
  assert.ok(codes.includes('no-metric'))
  assert.ok(codes.includes('no-magnitude'))
  assert.ok(codes.includes('bad-direction'))
  assert.equal(r.registered, false)
  assert.equal(r.verdict, PREREG_VERDICT.VAGUE_EFFECT)
})

test('预注册: **不可证伪的假设不得登记**', () => {
  const r = preregister({ hypothesis: 'h', metric: 'm', direction: 'increase', minEffectPct: 5, aggregation: 'median', samples: 8 })
  assert.ok(r.problems.some((p) => p.code === 'no-falsifier'))
  assert.equal(r.registered, false)
})

test('预注册: 验证强度 —— 聚合口径与样本量', () => {
  assert.ok(checkVerificationStrength({ aggregation: 'peak', samples: 3 }).problems.some((p) => p.code === 'too-few-samples'))
  assert.ok(checkVerificationStrength({ aggregation: 'vibes', samples: 20 }).problems.some((p) => p.code === 'bad-aggregation'))
  assert.equal(checkVerificationStrength({ aggregation: 'median', samples: 8 }).verdict, PREREG_VERDICT.OK)
})

test('仪器自洽: **声称的效应小于噪声 → 仪器原理上看不见**（这是"测量不成立"，不是"没有效应"）', () => {
  const r = checkInstrumentSelfMatch({ minEffectPct: 1, noisePct: 5 })
  assert.equal(r.verdict, PREREG_VERDICT.INSTRUMENT_MISMATCH)
  assert.match(r.problems[0].detail, /原理上无法确认/)
  assert.match(r.problems[0].detail, /看不见/)
  assert.match(r.rule, /不是.*没有效应/)
  assert.ok(r.signalToNoise < 1)
})

test('仪器自洽: 没给噪声估计 → 拒绝（否则分不清"没测出来"与"看不见"）', () => {
  const r = checkInstrumentSelfMatch({ minEffectPct: 5 })
  assert.equal(r.verdict, PREREG_VERDICT.INSTRUMENT_MISMATCH)
  assert.ok(r.problems.some((p) => p.code === 'no-noise-estimate'))
})

test('仪器自洽: 效应远大于噪声 → OK；同量级 → 标为边际', () => {
  assert.equal(checkInstrumentSelfMatch({ minEffectPct: 20, noisePct: 0.3 }).verdict, PREREG_VERDICT.OK)
  const marginal = checkInstrumentSelfMatch({ minEffectPct: 10, noisePct: 6 })
  assert.equal(marginal.verdict, PREREG_VERDICT.OK, '边际不是硬失败')
  assert.ok(marginal.problems.some((p) => p.code === 'effect-near-noise'))
  assert.match(marginal.problems[0].detail, /弱证据/)
})

test('判定: 拿预注册去判实测 —— 只有三种结局', () => {
  const reg = goodReg()
  const confirmed = judge({ registration: reg, observed: { decodeTps: 120, deltaPct: 25 }, measurementValid: true })
  assert.equal(confirmed.verdict, JUDGE_VERDICT.CONFIRMED)

  const falsified = judge({ registration: reg, observed: { decodeTps: 61, deltaPct: 2 }, measurementValid: true })
  assert.equal(falsified.verdict, JUDGE_VERDICT.FALSIFIED)
  assert.match(falsified.reason, /未达预注册幅度/)

  const inconclusive = judge({ registration: reg, observed: { decodeTps: 120, deltaPct: 25 }, measurementValid: false, measurementReasons: [{ code: 'not-steady-state' }] })
  assert.equal(inconclusive.verdict, JUDGE_VERDICT.INCONCLUSIVE)
  assert.match(inconclusive.reason, /既不能确认也不能否证/)
})

test('判定: decrease 方向的假设按符号正确判定', () => {
  const reg = preregister({
    hypothesis: 'h', metric: 'ttftMs', direction: 'decrease', minEffectPct: 30,
    aggregation: 'median', samples: 8, falsify: 'f',
  })
  // TTFT 下降 40% → deltaPct = -40，按 decrease 方向 effectiveDelta = +40 ≥ 30 → confirmed
  assert.equal(judge({ registration: reg, observed: { ttftMs: 12, deltaPct: -40 } }).verdict, JUDGE_VERDICT.CONFIRMED)
  // TTFT 上升 10% → effectiveDelta = -10 < 30 → falsified
  assert.equal(judge({ registration: reg, observed: { ttftMs: 22, deltaPct: 10 } }).verdict, JUDGE_VERDICT.FALSIFIED)
})

test('判定: 没有预注册 → 直接 inconclusive（事后判定不成立）', () => {
  const r = judge({ registration: null, observed: { decodeTps: 100, deltaPct: 50 } })
  assert.equal(r.verdict, JUDGE_VERDICT.INCONCLUSIVE)
  assert.match(r.reason, /预注册/)
})

test('判定: 预注册本身不合格 → 不能拿来判', () => {
  const bad = preregister({ hypothesis: 'h' })
  const r = judge({ registration: bad, observed: { decodeTps: 100, deltaPct: 50 } })
  assert.equal(r.verdict, JUDGE_VERDICT.INCONCLUSIVE)
  assert.match(r.reason, /预注册本身不合格/)
})

test('时序: **事后补写的"预注册"要被抓出来**', () => {
  const reg = goodReg()
  const after = new Date(new Date(reg.registeredAt).getTime() + 60_000).toISOString()
  assert.equal(checkPreregTiming({ registration: reg, executedAt: after }).ok, true)

  const before = new Date(new Date(reg.registeredAt).getTime() - 60_000).toISOString()
  const bad = checkPreregTiming({ registration: reg, executedAt: before })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'registered-after-execution')
  assert.match(bad.detail, /事后补写/)
})

// ---------------------------------------------------------------- 与天花板联动

test('联动: 一个"没有实现域条件"的天花板过不了主张门禁', () => {
  const ctx = {
    hardware: { achievableBandwidthGBps: 238.7 },
    model: { bytesPerTokenGB: 1.07, contextLength: 2048 },
    engine: { image: 'vllm@x' },          // 只给了镜像，没给 kernel/缓存格式/量化精度
    measurements: { singleStreamTps: 60 },
    provenance: { achievableBandwidthGBps: 'local-microbenchmark' },
  }
  const c = singleStreamCeiling(ctx)
  assert.equal(c.usable, true)
  const g = gateCeiling({ ceiling: c, claimedAs: 'physical-limit' })
  assert.notEqual(g.verdict, CLAIM_VERDICT.OK)
  assert.ok(g.reasons.some((r) => r.code === 'no-implementation-scope'))
})
