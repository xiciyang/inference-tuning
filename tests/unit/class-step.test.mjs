/**
 * 算子类别超额 + 步分解。
 *
 * 两个"不要自欺"的判据：
 *   · **没有预期分布就不判超额** —— "占了 60%" 本身没有对错
 *   · **残差比任何单项都大 ⇒ 分解不完整**，不是"开销较大"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeClassExcess, projectEndToEndGain, expectedShareFromConfig, OPERATOR_CLASSES, DEFAULT_EXCESS_THRESHOLD,
} from '../../src/analysis/class-excess.mjs'
import { decomposeStep, pickRepresentativeStep, COMMON_PARTS } from '../../src/analysis/step-decomposition.mjs'

const ops = (rows) => rows.map(([name, cls, ms, calls = 1]) => ({ name, class: cls, ms, calls }))

// ---------------------------------------------------------------- 类别超额

test('类别超额: 没有算子观测 → 明确不可用', () => {
  const r = analyzeClassExcess({ operators: [] })
  assert.equal(r.usable, false)
  assert.match(r.why, /算子级观测/)
})

test('类别超额: **没有预期分布就不判超额**（"占 60%" 本身没有对错）', () => {
  const r = analyzeClassExcess({
    operators: ops([['qkv', 'attention', 30], ['gate_up', 'mlp', 60], ['rmsnorm', 'norm', 10]]),
  })
  assert.equal(r.usable, true)
  assert.equal(r.canJudgeExcess, false)
  assert.equal(r.excess.length, 0)
  assert.match(r.why, /缺.*架构算术预期分布/)
  assert.ok(r.ranked.length === 3)
  assert.equal(r.ranked[0].class, 'mlp')
  assert.ok(Math.abs(r.ranked[0].sharePct - 60) < 1e-9)
})

test('类别超额: 有预期分布 → 按比值判超额/正常/不足（可推导，不用魔数）', () => {
  const r = analyzeClassExcess({
    operators: ops([['qkv', 'attention', 60], ['gate_up', 'mlp', 40]]),
    expectedShare: { attention: 0.2, mlp: 0.8 },
    stepMs: 100,
  })
  assert.equal(r.canJudgeExcess, true)
  assert.equal(r.threshold, DEFAULT_EXCESS_THRESHOLD)
  const attn = [...r.excess, ...r.deficit].find((x) => x.class === 'attention') ?? r.excess.find((x) => x.class === 'attention')
  assert.ok(r.excess.some((x) => x.class === 'attention'), 'attention 实测 60% vs 预期 20% → 必判超额')
  const a = r.excess.find((x) => x.class === 'attention')
  assert.equal(a.verdict, 'excess')
  assert.ok(Math.abs(a.excessRatio - 3) < 1e-9)
  assert.ok(Math.abs(a.excessMs - 40) < 1e-9)
  void attn
})

test('类别超额: 结论把"结构性超额"与"kernel 效率"分开 —— 干预不同', () => {
  const r = analyzeClassExcess({
    operators: ops([['attn', 'attention', 70], ['mlp', 'mlp', 30]]),
    expectedShare: { attention: 0.3, mlp: 0.7 },
    stepMs: 100,
  })
  assert.match(r.conclusion, /attention 超出预期/)
  assert.match(r.conclusion, /结构性超额/)
  assert.match(r.conclusion, /而不是去优化单个 kernel/)
})

test('类别超额: 没有超额时明说"原因更可能在别处"（不硬凑一个结论）', () => {
  const r = analyzeClassExcess({
    operators: ops([['attn', 'attention', 32], ['mlp', 'mlp', 68]]),
    expectedShare: { attention: 0.3, mlp: 0.7 },
    stepMs: 100,
  })
  assert.equal(r.excess.length, 0)
  assert.match(r.conclusion, /没有任何算子类别显著超出/)
  assert.match(r.conclusion, /kernel 效率|带宽|调度/)
})

test('类别超额: 预期占比明显高于实测 → 判 deficit（也报出来）', () => {
  const r = analyzeClassExcess({
    operators: ops([['attn', 'attention', 5], ['mlp', 'mlp', 95]]),
    expectedShare: { attention: 0.5, mlp: 0.5 },
    stepMs: 100,
  })
  assert.ok(r.deficit.some((d) => d.class === 'attention'))
})

test('类别超额: 不完整的算子记录会被点名', () => {
  const r = analyzeClassExcess({ operators: [{ name: 'x', class: 'mlp', ms: 10 }, { name: 'y', ms: 5 }] })
  assert.ok(r.problems.some((p) => p.code === 'incomplete-operator-rows'))
})

test('类别超额: 折算成端到端收益时**必须标为上界**', () => {
  const r = analyzeClassExcess({
    operators: ops([['attn', 'attention', 70], ['mlp', 'mlp', 30]]),
    expectedShare: { attention: 0.3, mlp: 0.7 },
    stepMs: 100,
  })
  const p = projectEndToEndGain({ classExcess: r, stepMs: 100 })
  assert.equal(p.projectable, true)
  assert.equal(p.boundKind, 'upper-bound')
  assert.ok(Math.abs(p.upperBoundGainPct - 40) < 1e-9)
  assert.match(p.caveat, /上界/)
  assert.match(p.caveat, /不得把这个数当结论/)
})

test('类别超额: 不可判超额时不给收益折算', () => {
  const r = analyzeClassExcess({ operators: ops([['a', 'mlp', 10]]) })
  assert.equal(projectEndToEndGain({ classExcess: r }).projectable, false)
})

test('类别超额: 从模型配置推预期分布；缺配置项**不猜**', () => {
  const full = expectedShareFromConfig({
    config: { numHiddenLayers: 28, hiddenSize: 1536, numAttentionHeads: 12, numKeyValueHeads: 2, headDim: 128, intermediateSize: 8960 },
    contextLength: 4096,
  })
  assert.equal(full.computed, true)
  assert.ok(full.expectedShare.attention > 0 && full.expectedShare.mlp > 0)
  assert.ok(Math.abs(full.expectedShare.attention + full.expectedShare.mlp - 1) < 1e-9)
  assert.match(full.basis, /算术量，不是实测/)
  assert.match(full.caveat, /归一化/)

  const partial = expectedShareFromConfig({ config: { numHiddenLayers: 28 }, contextLength: 4096 })
  assert.equal(partial.computed, false)
  assert.ok(partial.missing.includes('hiddenSize'))
  assert.match(partial.why, /不猜/)
})

test('类别超额: 长上下文会让 attention 的预期占比上升（算术上必然）', () => {
  const cfg = { numHiddenLayers: 28, hiddenSize: 1536, numAttentionHeads: 12, numKeyValueHeads: 2, headDim: 128, intermediateSize: 8960 }
  const short = expectedShareFromConfig({ config: cfg, contextLength: 512 }).expectedShare.attention
  const long = expectedShareFromConfig({ config: cfg, contextLength: 32768 }).expectedShare.attention
  assert.ok(long > short, `长上下文 attention 占比应更高：${short} → ${long}`)
})

test('类别超额: 类别白名单存在且覆盖常见算子', () => {
  for (const c of ['attention', 'mlp', 'norm', 'sampling', 'scheduler', 'kv']) {
    assert.ok(OPERATOR_CLASSES.includes(c), c)
  }
})

// ---------------------------------------------------------------- 步分解

test('步分解: 加得起来 → complete', () => {
  const r = decomposeStep({ stepMs: 20, parts: { prefill: 4, decode: 12, sampling: 2, scheduler: 2 } })
  assert.equal(r.usable, true)
  assert.ok(Math.abs(r.accountedMs - 20) < 1e-9)
  assert.ok(Math.abs(r.residualMs) < 1e-9)
  assert.equal(r.complete, true)
  assert.equal(r.verdict, 'complete')
})

test('步分解: **残差比任何单项都大 ⇒ 判"分解不完整"**，不是"开销较大"', () => {
  const r = decomposeStep({ stepMs: 100, parts: { prefill: 10, decode: 25, sampling: 5 } })
  assert.equal(r.verdict, 'incomplete')
  assert.equal(r.complete, false)
  assert.ok(r.residualMs > r.worstPart.ms)
  const p = r.problems.find((x) => x.code === 'residual-exceeds-worst-part')
  assert.ok(p)
  assert.match(p.detail, /分解不完整/)
  assert.match(p.detail, /比最大的单项/)
})

test('步分解: 残差超阈值时给出**可操作**的补测方向', () => {
  const r = decomposeStep({ stepMs: 100, parts: { decode: 10 } })
  assert.ok(r.suggestions.length >= 3)
  assert.ok(r.suggestions.some((s) => s.includes('host')))
  assert.ok(r.suggestions.some((s) => s.includes('KV')))
  assert.ok(r.suggestions.some((s) => s.includes('graph')))
  assert.match(r.rule, /只有两种正当结局/)
})

test('步分解: 分项之和**超过**总时长 → 判重复计数（不是"有点误差"）', () => {
  const r = decomposeStep({ stepMs: 100, parts: { a: 60, b: 55 } })
  assert.equal(r.verdict, 'over-accounted')
  assert.ok(r.problems.some((p) => p.code === 'over-accounted'))
  assert.match(r.problems[0].detail, /重复计数|不同源/)
})

test('步分解: 缺总时长 → 不可用（没有分母就判不了加不加得起来）', () => {
  const r = decomposeStep({ parts: { a: 1 } })
  assert.equal(r.usable, false)
  assert.match(r.why, /分母/)
})

test('步分解: 显式容差可覆盖判据（但必须是调用方显式给的）', () => {
  const r = decomposeStep({ stepMs: 100, parts: { a: 90 }, tolerance: 15 })
  assert.equal(r.complete, true)
  const strict = decomposeStep({ stepMs: 100, parts: { a: 90 }, tolerance: 5 })
  assert.equal(strict.complete, false)
  assert.ok(strict.problems.some((p) => p.code === 'residual-outside-tolerance'))
  assert.ok(Math.abs(strict.residualPct - 10) < 1e-9)
})

test('步分解: 代表性步取**中位数**，并把长尾单独报出来', () => {
  const xs = [10, 10, 11, 10, 12, 10, 11, 60]
  const r = pickRepresentativeStep({ stepDurationsMs: xs })
  assert.equal(r.usable, true)
  assert.equal(r.n, 8)
  assert.equal(r.representativeMs, 10.5)
  assert.equal(r.maxMs, 60)
  assert.ok(r.tailRatio > 1.5)
  assert.match(r.tailNote, /先解释长尾再优化中位数/)
})

test('步分解: 长尾不明显时明说中位数有代表性', () => {
  const r = pickRepresentativeStep({ stepDurationsMs: [10, 10.2, 10.1, 10.3, 10.05] })
  assert.ok(r.tailRatio < 1.5)
  assert.match(r.tailNote, /长尾不明显/)
})

test('步分解: 没有可用样本 → 不可用', () => {
  assert.equal(pickRepresentativeStep({ stepDurationsMs: [] }).usable, false)
  assert.equal(pickRepresentativeStep({ stepDurationsMs: [0, -1, null] }).usable, false)
})

test('步分解: 常见分段名清单存在（给补测方向用）', () => {
  for (const p of ['prefill', 'decode', 'hostGap', 'kvWrite', 'graphReplay']) {
    assert.ok(COMMON_PARTS.includes(p), p)
  }
})
