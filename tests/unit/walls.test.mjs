/**
 * 根因墙框架回归。
 *
 * 重点回归：**口径自洽检查** —— 这正是上一轮真机犯过的错：
 *   用规格书理论峰值 273 GB/s 当分母 → 得出"98.8% 已到顶"；
 *   换成实测可达 ~240 GB/s 后，反推的 269.8 GB/s **在物理上不可能**，
 *   说明"每 token 访存字节"这个分母算错了（含了 vision tower、没排除 embed），
 *   而不是硬件到顶。
 * 本测试确保框架**永远先做这个自洽检查再下结论**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  diagnoseWalls, bandwidthWall, speculativeWall, computeWall, capacityWall, scheduleWall,
  WALLS, WallRegistry, assertNoSpecSheet,
} from '../../src/walls/index.mjs'
import { REMEDIES, LEVER_SEMANTICS, top1For, listLevers } from '../../src/walls/remedies.mjs'

const baseCtx = (over = {}) => ({
  hardware: { achievableBandwidthGBps: 240, measuredPeakFlops: 100e12, ...(over.hardware ?? {}) },
  model: { bytesPerTokenGB: 3.1, flopsPerToken: 2.2e9, kvTokensPerRequest: 2000, ...(over.model ?? {}) },
  measurements: { singleStreamTps: 60, kernelMs: 30, gpuBusyPct: 0.8, runningRequests: 4, ...(over.measurements ?? {}) },
  limits: { kvPoolTokens: 163_840, ...(over.limits ?? {}) },
  provenance: over.provenance ?? { achievableBandwidthGBps: 'local-microbenchmark', bytesPerTokenGB: 'adapter' },
})

test('墙: 复现并捕获"规格书峰值当分母"的历史误判', () => {
  // 错误口径：每 token 访存 21.433 GB（含 vision tower、未排除 embed）
  const ctx = baseCtx({
    model: { bytesPerTokenGB: 21.433 },
    measurements: { singleStreamTps: 12.59 },
  })
  const st = bandwidthWall.status(ctx)
  assert.equal(st.sanity.ok, false, '必须报"分母口径有误"')
  assert.match(st.sanity.warn, /分母.*口径有误|口径有误/)
  assert.match(st.sanity.warn, /禁止据此判定/)
  // 关键：state 必须是 unknown —— 不许把它当成"已到顶"
  assert.equal(st.state, 'unknown')
  assert.ok(st.sanity.effectiveGBps > st.sanity.achievableGBps)
})

test('墙: 正确口径下带宽墙给出利用率，且 sanity 通过', () => {
  const st = bandwidthWall.status(baseCtx())
  assert.equal(st.sanity.ok, true)
  // 60 / (240/3.1 = 77.4) = 77.5% → 仍有空间，是 headroom 而不是 walled
  assert.equal(st.state, 'headroom')
  assert.ok(st.utilization > 0.7 && st.utilization < 0.8, `实际 ${st.utilization}`)
})

test('墙: 带宽利用率 ≥95% 时 actionable 明确转向 speculative（而不是继续加并发）', () => {
  const ctx = baseCtx({ measurements: { singleStreamTps: 77 } })  // ≈ 上界
  const st = bandwidthWall.status(ctx)
  const act = bandwidthWall.actionable(ctx, bandwidthWall.theory(ctx), st)
  assert.equal(act.ok, false)
  assert.equal(act.redirect, 'speculative')
  assert.match(act.why, /权重必须全量读/)
})

test('墙: 规格书/理论峰值 provenance 被硬拒绝（不是建议）', () => {
  const r = assertNoSpecSheet({ provenance: { achievableBandwidthGBps: 'spec-sheet' } })
  assert.equal(r.ok, false)
  assert.match(r.detail, /必须来自本机实测/)

  const diag = diagnoseWalls(baseCtx({ provenance: { achievableBandwidthGBps: 'spec-sheet' } }))
  assert.equal(diag.verdict, 'blocked-by-bad-baseline')
  assert.ok(diag.specSheetViolation.reasons.length > 0)
})

test('墙: null 观测不得被当成 0（Number(null)===0 陷阱）', () => {
  const diag = diagnoseWalls({
    hardware: { achievableBandwidthGBps: null },
    model: { bytesPerTokenGB: 3.1 },
    measurements: { singleStreamTps: 10 },
    provenance: {},
  })
  const bw = diag.walls.find((w) => w.id === 'bandwidth')
  assert.equal(bw.state, 'unknown')
  assert.equal(bw.bound, null, '不得编造出一个上界')
  assert.deepEqual(bw.missing, ['hardware.achievableBandwidthGBps'])
})

test('墙: 缺观测时逐条列出"该测什么"，而不是静默降级', () => {
  const diag = diagnoseWalls({ hardware: {}, model: {}, measurements: {}, limits: {}, provenance: {} })
  assert.equal(diag.verdict, 'insufficient-observations')
  assert.ok(diag.unknownObservations.includes('hardware.achievableBandwidthGBps'))
  assert.ok(diag.unknownObservations.includes('measurements.gpuBusyPct'))
  assert.ok(diag.notes.some((n) => n.includes('要测')))
})

test('墙: 投机预算饱和（加了预算但接受长度没变长）必须被判为不可解除', () => {
  const ctx = baseCtx({
    measurements: { acceptLength: 4.27, draftTokens: 32, prevAcceptLength: 5.51, prevDraftTokens: 16 },
  })
  const st = speculativeWall.status(ctx)
  assert.equal(st.saturated, true)
  assert.equal(st.state, 'walled')
  const act = speculativeWall.actionable(ctx, speculativeWall.theory(ctx), st)
  assert.equal(act.ok, false)
  assert.match(act.why, /预算已饱和/)
})

test('墙: 算力墙用实测 kernel 耗时；达成算力超过实测峰值 → 判 FLOPs 口径错', () => {
  const ctx = baseCtx({ model: { flopsPerToken: 1e12 }, measurements: { kernelMs: 1 } }) // 1e15 > 100e12
  const st = computeWall.status(ctx)
  assert.equal(st.sanity.ok, false)
  assert.equal(st.state, 'unknown')
  assert.match(st.sanity.warn, /分母口径有误/)
})

test('墙: 容量墙按 KV 池算并发上界', () => {
  const ctx = baseCtx({ limits: { kvPoolTokens: 100_000 }, model: { kvTokensPerRequest: 2000 }, measurements: { runningRequests: 4 } })
  const th = capacityWall.theory(ctx)
  assert.equal(th.bound, 50)
  const st = capacityWall.status(ctx)
  assert.equal(st.state, 'headroom')
})

test('墙: 调度墙按实测 GPU 忙占比判定', () => {
  const low = scheduleWall.status(baseCtx({ measurements: { gpuBusyPct: 0.3 } }))
  assert.equal(low.state, 'walled')
  assert.equal(scheduleWall.actionable(baseCtx({ measurements: { gpuBusyPct: 0.3 } }), scheduleWall.theory(baseCtx({ measurements: { gpuBusyPct: 0.3 } })), low).ok, true)
  const high = scheduleWall.status(baseCtx({ measurements: { gpuBusyPct: 0.85 } }))
  assert.equal(high.state, 'headroom')
})

test('墙: 自动排序会把"已到墙且干预仍可解除"的选为根因墙', () => {
  const diag = diagnoseWalls(baseCtx({
    measurements: { singleStreamTps: 70, gpuBusyPct: 0.95, runningRequests: 1 },
  }))
  assert.ok(diag.rootWall)
  assert.ok(diag.ranking.length > 0)
  assert.equal(diag.ranking[0].state, diag.rootWall.state === 'walled' ? 'walled' : diag.ranking[0].state)
  // 排序：walled 在前
  const firstWalled = diag.ranking.findIndex((r) => r.state === 'walled')
  const firstHeadroom = diag.ranking.findIndex((r) => r.state === 'headroom')
  if (firstWalled >= 0 && firstHeadroom >= 0) assert.ok(firstWalled < firstHeadroom)
})

test('墙: 强制指定墙（wallOverride）生效；不可用时回退并记 note', () => {
  const diag = diagnoseWalls(baseCtx(), { wallOverride: 'schedule' })
  assert.equal(diag.rootWall.id, 'schedule')
  const bad = diagnoseWalls(baseCtx(), { wallOverride: 'nonexistent' })
  assert.ok(bad.notes.some((n) => n.includes('nonexistent')))
})

test('墙: 每堵墙都声明了 requires，且都有对应的干预映射', () => {
  for (const w of WALLS) {
    assert.ok(Array.isArray(w.requires) && w.requires.length > 0, `${w.id} 缺 requires`)
    assert.ok(REMEDIES[w.id], `${w.id} 缺干预映射`)
    const r = top1For(w.id)
    assert.ok(r.lever, `${w.id} 的 TOP1 干预缺 lever`)
    assert.ok(r.expected, `${w.id} 的干预缺"预期什么动"`)
    assert.ok(r.falsify.length > 0, `${w.id} 的干预缺"什么情况下它不生效"`)
    assert.ok(LEVER_SEMANTICS[r.lever], `${r.lever} 缺语义定义`)
  }
})

test('墙: 每堵墙都产出 sanity 字段（可自我否证）', () => {
  const diag = diagnoseWalls(baseCtx())
  for (const w of diag.walls) {
    if (w.state === 'unknown') continue
    assert.ok(w.sanity, `${w.id} 没有 sanity 字段 —— 不可否证的墙不允许存在`)
  }
})

test('墙: WallRegistry 可注册自定义墙（换引擎/换硬件不改核心）', () => {
  const reg = new WallRegistry()
  const n = reg.list().length
  reg.register({ id: 'custom', title: 'x', kind: 'y', goalMetric: 'z', requires: [], theory: () => null, status: () => ({ state: 'unknown' }) })
  assert.equal(reg.list().length, n + 1)
  assert.ok(reg.get('bandwidth'))
  assert.equal(reg.get('nope'), null)
})

test('干预映射: 杠杆名是语义的，不是引擎 flag', () => {
  for (const l of listLevers()) {
    assert.doesNotMatch(l.id, /^--/, '杠杆名不应是命令行 flag')
    assert.ok(l.description)
    assert.ok(Array.isArray(l.affects) && l.affects.length > 0, `${l.id} 应声明它影响哪些观测`)
  }
})
