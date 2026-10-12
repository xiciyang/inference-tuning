/**
 * 目标驱动与**不停机判据**。
 *
 * 用户长期指令："给出目标后优化中途不能停止；**'已达标'与'预算耗尽'都不构成停止理由**"。
 * 因此这组用例的核心是：**把不该停的东西钉死成"不能停"**。
 * 任何"硬件到顶"判定都**必须带限定条件**，否则不允许成立。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  defineObjective, assessTargets, assessDrive, decideRunOutcome,
  DRIVE_STATUS, RUN_OUTCOME, STOP_KINDS, NON_STOP_REASONS, collectLimitingConditions,
} from '../../src/loop/objective.mjs'
import { detectEarlyStop } from '../../src/loop/early-stop.mjs'

const thresholds = { maxAccuracyDropPct: 5, minPerfGainPct: 20 }
const wallDiag = (walls, rootId = null) => ({
  walls,
  rootWall: rootId ? walls.find((w) => w.id === rootId) : null,
  unknownWalls: walls.filter((w) => !w.usable).map((w) => ({ id: w.id, missing: w.missing ?? [] })),
})
const wall = (id, state, { remedy = 'concurrency_capacity', alternatives = [], usable = true, actionable = { ok: true } } = {}) => ({
  id, state, usable, actionable, suggestedRemedy: remedy, remedyAlternatives: alternatives, utilization: 0.9, bound: 100, unit: 'tok/s', formula: 'f',
})

test('目标: 阈值必须外部提供（本模块不猜）', () => {
  assert.throws(() => defineObjective({ model: '/m' }), /thresholds/)
})

test('目标: 达标状态只是"显示"，selected 为 met', () => {
  const obj = defineObjective({ model: '/m', target: { metric: 'decodeTps', value: 100, direction: 'increase' }, thresholds })
  assert.equal(assessTargets({ objective: obj, measurements: { decodeTps: 120 } }).met, true)
  assert.equal(assessTargets({ objective: obj, measurements: { decodeTps: 80 } }).met, false)
  assert.equal(assessTargets({ objective: obj, measurements: {} }).status, DRIVE_STATUS.INSUFFICIENT_OBSERVATIONS)
})

test('不停机: **已达目标不构成停止理由** —— 继续推进', () => {
  const obj = defineObjective({ model: '/m', target: { metric: 'decodeTps', value: 50, direction: 'increase' }, thresholds })
  const diag = wallDiag([wall('bandwidth', 'walled')], 'bandwidth')
  const d = decideRunOutcome({
    objective: obj, round: 1, wallDiag: diag, triedLevers: [],
    measurements: { decodeTps: 200 }, // 远超目标
  })
  assert.equal(d.action, RUN_OUTCOME.CONTINUE)
  assert.ok(d.warnings.some((w) => w.code === 'target-met'))
  assert.match(d.warnings.find((w) => w.code === 'target-met').message, /不构成停止理由/)
})

test('不停机: **预算耗尽不构成停止理由** —— 产出可续跑检查点并让出', () => {
  const obj = defineObjective({ model: '/m', thresholds, budgetMs: 1000 })
  const diag = wallDiag([wall('bandwidth', 'walled', { alternatives: ['kv_pool_size'] })], 'bandwidth')
  const d = decideRunOutcome({
    objective: obj, round: 5, wallDiag: diag, triedLevers: [], budgetExceeded: true,
  })
  assert.equal(d.action, RUN_OUTCOME.YIELD_RESUMABLE)
  assert.equal(d.stopKind, null, '不是 stop')
  assert.match(d.reason, /不构成停止理由/)
  assert.ok(d.resumeFrom.untriedLevers.length > 0)
})

test('不停机: 还有未试过的可解除干预 → 一律继续（哪怕已经试了很多轮）', () => {
  const diag = wallDiag([wall('bandwidth', 'walled', { remedy: 'concurrency_capacity', alternatives: ['kv_pool_size'] })], 'bandwidth')
  const d = decideRunOutcome({ objective: defineObjective({ model: '/m', thresholds }), round: 99, wallDiag: diag, triedLevers: [] })
  assert.equal(d.action, RUN_OUTCOME.CONTINUE)
})

test('停止: 只有"墙到界 + 干预穷尽 + 有限定条件"才判物理瓶颈', () => {
  const diag = wallDiag([wall('bandwidth', 'walled', { remedy: 'concurrency_capacity', actionable: { ok: false, why: '到顶' } })], 'bandwidth')
  const d = decideRunOutcome({
    objective: defineObjective({ model: '/m', thresholds }),
    round: 3, wallDiag: diag, triedLevers: ['bandwidth:concurrency_capacity'],
    engine: { kernelImplementation: 'vllm-nightly' },
    model: { quantFormat: 'awq-w4a16' },
  })
  assert.equal(d.action, RUN_OUTCOME.STOP)
  assert.equal(d.stopKind, STOP_KINDS.PHYSICAL_LIMIT)
  assert.ok(d.limitedBy.length >= 2)
  assert.match(d.remediation, /限定条件/)
})

test('停止: 没有限定条件 → **不允许**判物理瓶颈，转为让出（可续跑）', () => {
  const diag = wallDiag([wall('bandwidth', 'walled', { remedy: 'concurrency_capacity', actionable: { ok: false, why: '到顶' } })], 'bandwidth')
  const d = decideRunOutcome({
    objective: defineObjective({ model: '/m', thresholds }),
    round: 3, wallDiag: diag, triedLevers: ['bandwidth:concurrency_capacity'],
    engine: {}, model: {},
  })
  assert.equal(d.action, RUN_OUTCOME.YIELD_RESUMABLE)
  assert.equal(d.stopKind, null)
  assert.match(d.reason, /不允许判/)
})

test('停止: 回滚失败 → stop + mustNotify（唯一"必须叫人"的结局）', () => {
  const d = decideRunOutcome({ objective: defineObjective({ model: '/m', thresholds }), rollbackFailed: true })
  assert.equal(d.action, RUN_OUTCOME.STOP)
  assert.equal(d.stopKind, STOP_KINDS.ROLLBACK_FAILED)
  assert.equal(d.mustNotify, true)
  assert.match(d.reason, /必须叫人/)
})

test('停止: 用户中止 → stop', () => {
  const d = decideRunOutcome({ objective: defineObjective({ model: '/m', thresholds }), userAbort: true })
  assert.equal(d.action, RUN_OUTCOME.STOP)
  assert.equal(d.stopKind, STOP_KINDS.USER_ABORT)
})

test('停止集合只有三个；且"达标/预算/轮数"被显式列为**非**停止理由', () => {
  assert.deepEqual(Object.values(STOP_KINDS).sort(), ['physical-limit', 'rollback-failed', 'user-abort'])
  assert.deepEqual([...NON_STOP_REASONS].sort(), ['budget-exhausted', 'max-rounds', 'target-met'])
})

test('assessDrive: 未试过的干预被逐条列出（供人复核"是不是早停了"）', () => {
  const diag = wallDiag([
    wall('bandwidth', 'walled', { remedy: 'concurrency_capacity', alternatives: ['kv_pool_size'] }),
    wall('schedule', 'walled', { remedy: 'batch_step_count' }),
  ], 'bandwidth')
  const d = assessDrive({ wallDiag: diag, triedLevers: ['bandwidth:concurrency_capacity'] })
  assert.equal(d.untriedLevers.length, 2)
  assert.deepEqual(d.untriedLevers.map((u) => u.lever).sort(), ['batch_step_count', 'kv_pool_size'])
})

test('限定条件: 收集 kernel 实现 / 引擎版本 / 缓存格式 / 量化精度 / 上界口径 / 未测得的墙', () => {
  const diag = wallDiag([wall('bandwidth', 'walled'), { id: 'compute', state: 'unknown', usable: false, missing: ['hardware.measuredPeakFlops'] }], 'bandwidth')
  const c = collectLimitingConditions({
    wallDiag: diag,
    engine: { kernelImplementation: 'vllm-nightly', version: 'img@sha256:x' },
    model: { kvPrecision: 'fp8', quantFormat: 'awq-w4a16' },
  })
  assert.ok(c.some((x) => x.includes('kernel 实现')))
  assert.ok(c.some((x) => x.includes('状态缓存格式')))
  assert.ok(c.some((x) => x.includes('量化精度')))
  assert.ok(c.some((x) => x.includes('上界口径')))
  assert.ok(c.some((x) => x.includes('未测得的墙')))
})

// ---------------------------------------------------------------- 过早收尾

test('过早收尾: 有未试过的干预就收 → 报 high', () => {
  const diag = wallDiag([wall('bandwidth', 'walled', { alternatives: ['kv_pool_size'] })], 'bandwidth')
  const r = detectEarlyStop({ wallDiag: diag, triedLevers: [], stopKind: 'physical-limit' })
  assert.equal(r.suspected, true)
  assert.ok(r.findings.some((f) => f.code === 'untried-levers' && f.severity === 'high'))
})

test('过早收尾: 还有墙是 headroom 就收 → 报 high', () => {
  const diag = wallDiag([wall('bandwidth', 'headroom')], 'bandwidth')
  const r = detectEarlyStop({ wallDiag: diag, triedLevers: ['bandwidth:concurrency_capacity'], stopKind: 'physical-limit' })
  assert.ok(r.findings.some((f) => f.code === 'headroom-remains'))
})

test('过早收尾: "未测"不等于"没空间" —— 未测的墙要被点名', () => {
  const diag = wallDiag([wall('bandwidth', 'walled'), { id: 'compute', state: 'unknown', usable: false, missing: ['x'] }], 'bandwidth')
  const r = detectEarlyStop({ wallDiag: diag, triedLevers: ['bandwidth:concurrency_capacity'], stopKind: 'physical-limit' })
  const f = r.findings.find((x) => x.code === 'unknown-walls')
  assert.ok(f)
  assert.match(f.detail, /未测.*不等于.*没空间|不等于/)
})

test('过早收尾: 依据无效测量收尾 → 报 high', () => {
  const diag = wallDiag([], null)
  const r = detectEarlyStop({ wallDiag: diag, triedLevers: [], stopKind: 'physical-limit', measurementValid: false })
  assert.ok(r.findings.some((f) => f.code === 'invalid-measurement'))
})

test('过早收尾: 非物理瓶颈的停止不适用（回滚失败/用户中止不是"收尾"）', () => {
  const r = detectEarlyStop({ wallDiag: wallDiag([]), stopKind: 'rollback-failed' })
  assert.equal(r.suspected, false)
  assert.match(r.note, /不适用/)
})

test('过早收尾: 干预穷尽且无 headroom → 不报（正确的收尾不应被误报）', () => {
  const diag = wallDiag([wall('bandwidth', 'walled', { remedy: 'concurrency_capacity', actionable: { ok: false } })], 'bandwidth')
  const r = detectEarlyStop({ wallDiag: diag, triedLevers: ['bandwidth:concurrency_capacity'], stopKind: 'physical-limit' })
  assert.equal(r.suspected, false)
  assert.match(r.note, /未发现/)
})
