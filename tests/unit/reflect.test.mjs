/**
 * 五因反思 —— 用户明确要求："TOP1 干预若无效，先停下反思五种原因，
 * **不许直接换参数再试**"（原话："搜索只是验证手段，不是发现手段"）。
 *
 * 排除顺序是刻意的、不可交换：
 *   ④ 测量不成立 → ① 杠杆未生效 → ③ 墙转移 → ② 墙找错 → ⑤ 真硬件极限
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reflectOnIneffectiveIntervention, diffConfig, INEFFECTIVE_CAUSES } from '../../src/loop/reflect.mjs'

const base = {
  wallId: 'bandwidth', lever: 'concurrency_capacity',
  before: { decodeTps: 60 }, after: { decodeTps: 60.2 }, metric: 'decodeTps',
}

test('反思: 干预有效时不做反思（直接报有效）', () => {
  const r = reflectOnIneffectiveIntervention({ ...base, after: { decodeTps: 120 } })
  assert.equal(r.effective, true)
  assert.equal(r.hypotheses.length, 0)
  assert.ok(r.deltaPct > 90)
})

test('反思: 缺前后数值 → inconclusive，不编造结论', () => {
  const r = reflectOnIneffectiveIntervention({ ...base, after: {} })
  assert.equal(r.inconclusive, true)
  assert.match(r.reason, /无法判断/)
})

test('反思: ④ 测量不成立**优先于**其他所有假设（它是前提）', () => {
  const r = reflectOnIneffectiveIntervention({
    ...base,
    measurementValid: false,
    measurementReasons: [{ code: 'not-steady-state' }],
    observedConfig: { concurrency_capacity: 64 },
    appliedConfig: { concurrency_capacity: 64 },
  })
  assert.equal(r.hypotheses[0].cause, INEFFECTIVE_CAUSES.INVALID_MEASUREMENT)
  assert.equal(r.hypotheses[0].blocking, true)
  assert.match(r.nextAction, /先修测量/)
})

test('反思: ① 下发配置与引擎读回不一致 → 参数没真正生效', () => {
  const r = reflectOnIneffectiveIntervention({
    ...base,
    appliedConfig: { concurrency_capacity: 64 },
    observedConfig: { concurrency_capacity: 32 },
    measurementValid: true,
  })
  const h = r.hypotheses.find((x) => x.cause === INEFFECTIVE_CAUSES.LEVER_INEFFECTIVE)
  assert.ok(h)
  assert.equal(h.blocking, true)
  assert.deepEqual(h.evidence, [{ key: 'concurrency_capacity', applied: 64, observed: 32 }])
  assert.match(h.nextAction, /没生效|为什么/)
})

test('反思: 没有读回配置 → 提示"我传了 ≠ 它用了"（不许当成已生效）', () => {
  const r = reflectOnIneffectiveIntervention({
    ...base, appliedConfig: { concurrency_capacity: 64 }, observedConfig: null, measurementValid: true,
  })
  const h = r.hypotheses.find((x) => x.cause === INEFFECTIVE_CAUSES.LEVER_INEFFECTIVE)
  assert.ok(h)
  assert.match(h.why, /无法证明|≠/)
  assert.equal(h.blocking, undefined, '不是硬阻塞，但必须先查')
})

test('反思: ③ 墙转移 —— 当前墙解除了但冒出新的，应切目标而不是加大剂量', () => {
  const before = {
    rootWall: { id: 'bandwidth', state: 'walled', utilization: 0.93 },
    walls: [{ id: 'bandwidth', state: 'walled', utilization: 0.93 }, { id: 'schedule', state: 'headroom', utilization: 0.4 }],
  }
  const after = {
    rootWall: { id: 'schedule', state: 'walled', utilization: 0.9 },
    walls: [{ id: 'bandwidth', state: 'headroom', utilization: 0.5 }, { id: 'schedule', state: 'walled', utilization: 0.9 }],
  }
  const r = reflectOnIneffectiveIntervention({
    ...base, wallDiagBefore: before, wallDiagAfter: after,
    appliedConfig: { concurrency_capacity: 64 }, observedConfig: { concurrency_capacity: 64 },
    measurementValid: true,
  })
  const h = r.hypotheses.find((x) => x.cause === INEFFECTIVE_CAUSES.WALL_SHIFTED)
  assert.ok(h)
  assert.equal(h.evidence.to, 'schedule')
  assert.match(h.nextAction, /切到 schedule/)
})

test('反思: ② 墙找错 —— 干预时目标墙并非 walled', () => {
  const before = {
    rootWall: { id: 'schedule', state: 'walled', utilization: 0.9 },
    walls: [{ id: 'bandwidth', state: 'headroom', utilization: 0.5 }, { id: 'schedule', state: 'walled', utilization: 0.9 }],
  }
  const r = reflectOnIneffectiveIntervention({
    ...base, wallDiagBefore: before,
    appliedConfig: { concurrency_capacity: 64 }, observedConfig: { concurrency_capacity: 64 },
    measurementValid: true,
  })
  const h = r.hypotheses.find((x) => x.cause === INEFFECTIVE_CAUSES.WRONG_WALL)
  assert.ok(h)
  assert.equal(h.evidence.actualRootWall, 'schedule')
})

test('反思: ⑤ 没有限定条件 → **不允许**判"硬件到顶"', () => {
  const r = reflectOnIneffectiveIntervention({
    ...base,
    appliedConfig: { concurrency_capacity: 64 }, observedConfig: { concurrency_capacity: 64 },
    measurementValid: true,
  })
  const h = r.hypotheses.find((x) => x.cause === INEFFECTIVE_CAUSES.TRUE_HARDWARE_LIMIT)
  assert.ok(h)
  assert.equal(h.cannotConclude, true)
  assert.match(h.nextAction, /补齐限定条件/)
})

test('反思: ⑤ 有限定条件 → 允许判"限定条件下的硬件极限"，并写明条件', () => {
  const r = reflectOnIneffectiveIntervention({
    ...base,
    appliedConfig: { concurrency_capacity: 64 }, observedConfig: { concurrency_capacity: 64 },
    measurementValid: true,
    limitingConditions: ['当前 kernel 实现：vllm-nightly', '量化精度：awq-w4a16'],
  })
  const h = r.hypotheses.find((x) => x.cause === INEFFECTIVE_CAUSES.TRUE_HARDWARE_LIMIT)
  assert.ok(h)
  assert.equal(h.cannotConclude, undefined)
  assert.equal(h.limitingConditions.length, 2)
  assert.match(h.why, /限定条件下的/)
  assert.match(h.nextAction, /改变限定条件本身/)
})

test('反思: 结论与"不许直接换参数"的纪律同时给出', () => {
  const r = reflectOnIneffectiveIntervention({
    ...base, appliedConfig: { concurrency_capacity: 64 }, observedConfig: { concurrency_capacity: 32 }, measurementValid: true,
  })
  assert.match(r.mustNotDo, /不得.*换一个参数再试/)
  assert.ok(r.conclusion)
  assert.ok(r.nextAction)
})

test('反思: 假设按可排除性排序（测量不成立永远第一）', () => {
  const before = {
    rootWall: { id: 'schedule', state: 'walled', utilization: 0.9 },
    walls: [{ id: 'bandwidth', state: 'headroom', utilization: 0.5 }, { id: 'schedule', state: 'walled', utilization: 0.9 }],
  }
  const r = reflectOnIneffectiveIntervention({
    ...base, wallDiagBefore: before,
    measurementValid: false, measurementReasons: [{ code: 'x' }],
    appliedConfig: { concurrency_capacity: 64 }, observedConfig: { concurrency_capacity: 32 },
  })
  const priorities = r.hypotheses.map((h) => h.priority)
  assert.deepEqual(priorities, [...priorities].sort((a, b) => a - b))
  assert.equal(priorities[0], 1)
})

test('diffConfig: 数值容差与字符串比较', () => {
  assert.deepEqual(diffConfig({ a: 1 }, { a: 1.0000000001 }), [])
  assert.deepEqual(diffConfig({ a: 1 }, { a: 2 }), [{ key: 'a', applied: 1, observed: 2 }])
  assert.deepEqual(diffConfig({ a: 'x' }, { a: 'y' }), [{ key: 'a', applied: 'x', observed: 'y' }])
  assert.deepEqual(diffConfig({ a: 1 }, {}), [], '引擎没回显的键不判为不一致（另有分支处理）')
  assert.deepEqual(diffConfig(null, { a: 1 }), [])
})

test('反思: 目标墙**没饱和**时必须说出来（真机暴露的成因）', () => {
  const before = {
    rootWall: { id: 'bandwidth', state: 'headroom', utilization: 0.77 },
    walls: [{ id: 'bandwidth', state: 'headroom', utilization: 0.77 }],
  }
  const r = reflectOnIneffectiveIntervention({
    ...base, wallDiagBefore: before,
    appliedConfig: { concurrency_capacity: 48 }, observedConfig: { concurrency_capacity: 48 },
    measurementValid: true, limitingConditions: ['kernel 实现：flash-attn'],
  })
  const h = r.hypotheses.find((x) => x.cause === INEFFECTIVE_CAUSES.WRONG_WALL)
  assert.ok(h, '应命中 wrong-wall（未饱和变体）')
  assert.equal(h.evidence.kind, 'wall-not-saturated')
  assert.match(h.why, /没有饱和/)
  assert.match(h.why, /探索性干预/)
  assert.match(h.why, /没有明显收益.*符合预期/)
  assert.ok(h.evidence.note.includes('unknown-walls'))
})
