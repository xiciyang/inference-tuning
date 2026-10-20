/**
 * 集成测试：完整调优闭环（假执行器，但**端点是真的、网络路径是真的**）。
 *
 * 覆盖：源模型预检、沙箱闸、阈值闸、确认令牌、墙诊断、TOP1 干预、
 * 双闭环测量（性能四闸 + 精度三闸）、门禁判定、接受/回退、五因反思、
 * 不停机判据、端点拆解无残留、注册表五要素、审计哈希链、必须叫人。
 *
 * 不需要 GPU / Docker —— 这正是"执行器接缝"存在的意义，
 * 也是"不只靠 mock 验收"的落点：闭环里除执行器外的每一步都是生产代码。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSandbox } from '../helpers/sandbox.mjs'
import { knobs, resetKnobs } from '../helpers/fake-executor.mjs'
import { createRuntime } from '../../src/config.mjs'
import { tuneOperation } from '../../src/tuning.mjs'
import { verifyAllAuditChains, readAudit } from '../../src/audit.mjs'
import { loadRegistry } from '../../src/state/tuning-registry.mjs'
import { readMetrics } from '../../src/metrics.mjs'
import { readMustNotify } from '../../src/notify.mjs'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/**
 * 沙箱探测在这里**预置**（不跑真 docker）：本用例测的是闭环逻辑，
 * 沙箱探测本身由 `sandbox.test.mjs` 真跑一次覆盖。
 */
async function setup({ thresholds = { max_accuracy_drop_pct: 30, min_perf_gain_pct: 10 }, knobsPatch = {} } = {}) {
  resetKnobs()
  Object.assign(knobs, knobsPatch)
  const sb = await makeSandbox()
  const runtime = await createRuntime({
    root: sb.root,
    options: {
      ...sb.options,
      executor: 'fake',
      // 测试里把稳态窗口压到 300ms（生产默认 60s）—— 它是**闸门**，不能在测试里被设成 0
      steadyStateWaitMs: 300,
      requests: 24,  // 最低样本量是 6；8 在负载下会被噪声打穿，24 才能稳定通过统计出处闸
      concurrency: 2,
      maxRounds: 4,
    },
  })
  runtime.__log = { info() {}, warn() {}, error() {}, phase() {} }
  runtime.policy.gates = thresholds
  runtime.__sandboxProbe = {
    process: false, container: true, vm: false,
    evidence: { note: '预置（沙箱探测由 sandbox.test.mjs 真跑覆盖）' },
    checkedAt: new Date().toISOString(),
  }
  const testSetPath = await sb.makeTestSet(10)
  return { sb, runtime, testSetPath }
}

const rawFor = (sb, testSetPath, extra = {}) => ({
  model: sb.modelPath, testSetPath, max_accuracy_drop_pct: 30, min_perf_gain_pct: 10, ...extra,
})

/**
 * 走**真实的确认流程**：第一次拿到令牌，第二次带上执行。
 * 刻意不绕过确认 —— 确认闸是生产路径的一部分，测试绕开它就没有覆盖。
 */
async function tuneWithConfirm(runtime, raw) {
  if (raw.confirm) return tuneOperation(runtime, { raw })
  const first = await tuneOperation(runtime, { raw }).then(() => null, (e) => e)
  if (!first) throw new Error('预期第一次调用要求确认，但直接成功了')
  if (first.code !== 'E_CONFIRMATION_REQUIRED') throw first
  return tuneOperation(runtime, { raw: { ...raw, confirm: first.details.confirmToken } })
}

test('闭环: 提高并发 → 性能上升、精度不降 → 接受并固化配置', async () => {
  const { sb, runtime, testSetPath } = await setup()
  try {
    const out = await tuneWithConfirm(runtime, rawFor(sb, testSetPath))
    assert.equal(out.ok, true, JSON.stringify(out).slice(0, 400))
    assert.equal(out.signed, true, '应签收')
    assert.equal(out.report.outcome, 'improved')
    assert.equal(out.report.acceptedRounds, 1)
    assert.ok(out.report.finalConfig.concurrency_capacity > 32, JSON.stringify(out.report.finalConfig))
    assert.ok(out.report.finalPerfGainPct > 10, `增益 ${out.report.finalPerfGainPct}`)

    // 墙诊断确实跑了，且给出了根因墙与干预
    assert.ok(out.report.wallDiagnosis.rootWall, '应有根因墙')
    assert.ok(out.report.wallDiagnosis.rootWall.suggestedRemedy)

    // 测量成立性两侧都过
    const r0 = out.report.rounds[0]
    assert.equal(r0.validity.performance, true, JSON.stringify(r0.validity.performanceReasons))
    assert.equal(r0.validity.accuracy, true, JSON.stringify(r0.validity.accuracyReasons))
    assert.equal(r0.gates.measurementValid, true)
    // 保权重调优：前后精度逐位相同是**预期结果**，闸②在此不适用（契约里写成了显式参数）
    assert.equal(r0.validity.checks.bitIdenticalMeanNll, true)
    assert.equal(r0.validity.checks.sameWeights, true)
    assert.equal(r0.gates.decision, 'accept')
  } finally { await sb.cleanup() }
})

test('闭环: 端点全部拆解、无残留（**owned 端点**与 teardown 一一对应）', async () => {
  const { sb, runtime, testSetPath } = await setup()
  try {
    await tuneWithConfirm(runtime, rawFor(sb, testSetPath))
    const deploys = knobs.calls.filter((c) => c.op === 'deploy')
    const teardowns = knobs.calls.filter((c) => c.op === 'teardown')
    // **不变量改了**：serving 按模型给端点做键，同模型换参数是**同一端点的新 revision**。
    // 因此 deploy 会有多次（基线 + 每轮候选），但 owned 端点只有一个、teardown 只有一次。
    // 原来那条"deploy 数 == teardown 数"是**错的设计假设**，真机跑出来才知道。
    assert.ok(deploys.length >= 2, `基线 + 至少一轮候选，实际 ${deploys.length}`)
    assert.equal(teardowns.length, 1, `owned 端点只有一个，应只拆一次，实际 ${teardowns.length}`)
    assert.equal(new Set(deploys.map((d) => d.id)).size, 1, '所有 deploy 必须是**同一个端点 id**（新 revision）')
    assert.equal(knobs.servers.size, 0, '不得残留活的端点服务')
  } finally { await sb.cleanup() }
})

test('闭环: 注册表五要素齐全，报告落盘，审计链完好', async () => {
  const { sb, runtime, testSetPath } = await setup()
  try {
    const out = await tuneWithConfirm(runtime, rawFor(sb, testSetPath))
    const reg = await loadRegistry(runtime)
    assert.equal(reg.runs.length, 1)
    const rec = reg.runs[0]
    for (const k of ['method', 'config', 'performance', 'accuracy', 'status']) {
      assert.ok(rec[k] !== null && rec[k] !== undefined, `五要素缺 ${k}`)
    }
    // 注册表状态必须与**报告结论**一致 —— 这里验的是"两处不许各写一套"，
    // 不重复断言性能是否提升（模拟端点用真实定时器，负载下增益可能落到阈值外；
    // 性能断言由本文件第一条用例负责）。
    const expectedStatus = out.report.outcome === 'improved' ? 'improved'
      : out.report.outcome === 'rollback-failed' ? 'rollback-failed'
        : out.report.outcome === 'physical-limit' ? 'physical-limit' : 'no-improvement'
    assert.equal(rec.status, expectedStatus, `注册表状态 ${rec.status} 与报告结论 ${out.report.outcome} 不一致`)
    assert.equal(rec.performance.aggregation, 'median', '聚合口径必须落盘')
    assert.equal(rec.accuracy.measurementValid, true)

    assert.ok(out.report.reportPath)
    const onDisk = JSON.parse(await fs.readFile(out.report.reportPath, 'utf8'))
    assert.equal(onDisk.runId, out.runId)
    assert.ok(onDisk.testingCore.contractVersion)

    const audit = await verifyAllAuditChains(runtime)
    assert.equal(audit.ok, true)
    const { records } = await readAudit(runtime)
    assert.ok(records.length >= 1)
    assert.equal(records.at(-1).capability, 'tune')

    // 本用例验的是**记账一致性**（注册表/报告/审计/指标），不是统计判定的方向：
    // 假执行器的吞吐在负载高的 runner 上会抖动，判定可能 improved 也可能 not_improved。
    // 因此断言"恰好记一次结局"，并断言它**与报告结论一致**，而不是钉死 improved。
    const m = await readMetrics(runtime)
    const improved = m.counters.tune_improved ?? 0
    const notImproved = m.counters.tune_not_improved ?? 0
    assert.equal(improved + notImproved, 1,
      `必须恰好记一次结局计数（improved=${improved} / not_improved=${notImproved}）`)
    assert.equal(out.report.outcome === 'improved' ? improved : notImproved, 1,
      `结局计数必须与报告结论 ${out.report.outcome} 一致`)
  } finally { await sb.cleanup() }
})

test('闭环: 阈值缺失 → 拒绝执行（在起端点之前就失败）', async () => {
  const { sb, runtime, testSetPath } = await setup({ thresholds: { max_accuracy_drop_pct: null, min_perf_gain_pct: null } })
  try {
    await assert.rejects(
      () => tuneOperation(runtime, { raw: { model: sb.modelPath, testSetPath } }),
      (e) => {
        assert.equal(e.code, 'E_THRESHOLD_NOT_PROVIDED')
        return true
      },
    )
    assert.equal(knobs.calls.filter((c) => c.op === 'deploy').length, 0, '配置类错误不得先起端点')
  } finally { await sb.cleanup() }
})

test('闭环: 源模型结构残缺 → 在起端点之前失败（不浪费调优轮次）', async () => {
  const { sb, runtime, testSetPath } = await setup()
  try {
    // 复刻事故形态：文件长度正确，但数据区后半段全为 0
    const p = join(sb.modelPath, 'model.safetensors')
    const buf = await fs.readFile(p)
    buf.fill(0, 8 + Number(buf.readBigUInt64LE(0)) + 64)
    await fs.writeFile(p, buf)
    await assert.rejects(
      () => tuneOperation(runtime, { raw: rawFor(sb, testSetPath) }),
      (e) => {
        assert.equal(e.code, 'E_SOURCE_MODEL_INVALID')
        assert.ok(e.details.problems.some((x) => x.kind === 'zero-filled'))
        return true
      },
    )
    assert.equal(knobs.calls.filter((c) => c.op === 'deploy').length, 0)
  } finally { await sb.cleanup() }
})

test('闭环: 需要确认令牌；无令牌时拒绝且**不起端点**', async () => {
  const { sb, runtime, testSetPath } = await setup()
  try {
    // per-class-once：第一次一定要求确认
    await assert.rejects(
      () => tuneOperation(runtime, { raw: rawFor(sb, testSetPath) }),
      (e) => {
        assert.equal(e.code, 'E_CONFIRMATION_REQUIRED')
        assert.ok(e.details.confirmToken)
        return true
      },
    )
    assert.equal(knobs.calls.filter((c) => c.op === 'deploy').length, 0, '未确认不得起端点')
    // 带令牌再来一次（走真实确认流程）
    const out = await tuneWithConfirm(runtime, rawFor(sb, testSetPath))
    // 本用例验的是确认闸；性能结论由第一条用例负责（真实定时器在负载下会抖）。
    assert.equal(out.ok, true)
    assert.ok(out.report?.runId)
  } finally { await sb.cleanup() }
})

test('闭环: 参数集带量化格式变更 → 硬拒绝（不是"确认后可执行"）', async () => {
  const { sb, runtime, testSetPath } = await setup()
  try {
    // 硬约束**先于**确认：确认令牌也不能解锁它
    await assert.rejects(
      () => tuneOperation(runtime, { raw: rawFor(sb, testSetPath, { params: { '--dtype': 'fp8' } }) }),
      (e) => {
        assert.equal(e.code, 'E_QUANT_FORMAT_FORBIDDEN')
        assert.match(e.remediation, /硬排除/)
        return true
      },
    )
    assert.equal(knobs.calls.filter((c) => c.op === 'deploy').length, 0)
  } finally { await sb.cleanup() }
})

test('闭环: 端点返回常量 logprob → 测量不成立 → 本轮被拒且进入反思的"测量不成立"分支', async () => {
  const { sb, runtime, testSetPath } = await setup({ knobsPatch: { constantLogprobs: true } })
  try {
    const out = await tuneWithConfirm(runtime, rawFor(sb, testSetPath))
    // 端点返回常量 logprob ⇒ 逐条极差为 0 ⇒ 测量不成立 ⇒ 不得接受任何一轮
    assert.equal(out.report.acceptedRounds, 0, '测量不成立时不得接受任何一轮')
    assert.equal(out.signed, false)
    assert.ok(out.report.rounds.length >= 1)
    const r0 = out.report.rounds[0]
    assert.equal(r0.gates.measurementValid, false)
    // code 可能带 `sidecar:` 前缀（测量端自报）—— 两种来源都算数
    const accCodes = r0.validity.accuracyReasons.map((c) => String(c).replace(/^sidecar:/, ''))
    assert.ok(
      accCodes.includes('constant-token-logprobs') || accCodes.includes('no-item-variance'),
      `应命中 token 级或逐条级的退化签名，实际 ${JSON.stringify(r0.validity.accuracyReasons)}`,
    )
    assert.equal(r0.decision, 'rejected-invalid-measurement')
    // 反思必须走"测量不成立"分支，且**阻塞**后续（不许直接换参数再试）
    assert.ok(r0.reflection?.hypotheses?.[0])
    assert.equal(r0.reflection.hypotheses[0].cause, 'invalid-measurement')
    assert.equal(r0.reflection.hypotheses[0].blocking, true)
    assert.match(r0.reflection.mustNotDo, /不得/)
  } finally { await sb.cleanup() }
})

test('闭环: 精度退化超阈值 → 回退（丢弃候选，保留原配置）', async () => {
  const { sb, runtime, testSetPath } = await setup({
    // 步长必须"足以跨过阈值、又不至于把输出打成常量"：
    //   0.8 会让 mock 输出退化成常量 logprob ⇒ 先命中**测量不成立**分支（另一条用例覆盖），
    //   实测在 CI/负载下不稳定；0.5 稳定走"可测量退化 → 拒绝并回退"这条路径。
    thresholds: { max_accuracy_drop_pct: 0.001, min_perf_gain_pct: 1 },
    knobsPatch: { accuracyDropPerStep: 0.5 },
  })
  try {
    const out = await tuneWithConfirm(runtime, rawFor(sb, testSetPath))
    assert.equal(out.report.acceptedRounds, 0)
    assert.equal(out.signed, false)
    const rejected = out.report.rounds.filter((r) => r.decision === 'rejected-rolled-back')
    assert.ok(rejected.length >= 1, JSON.stringify(out.report.rounds.map((r) => r.decision)))
    // 回退后端点仍被拆干净
    assert.equal(knobs.servers.size, 0)
  } finally { await sb.cleanup() }
})

test('闭环: **回滚失败 → E_ROLLBACK_FAILED + mustNotify + 写 MUST_NOTIFY 状态文件**（独立风险档）', async () => {
  const { sb, runtime, testSetPath } = await setup({
    thresholds: { max_accuracy_drop_pct: 0.001, min_perf_gain_pct: 1 },
    // 回退现在走 serving 的 rollback（不是"拆候选"），所以注入点是 failRollback
    knobsPatch: { accuracyDropPerStep: 0.8, failRollback: true },
  })
  try {
    await assert.rejects(
      () => tuneWithConfirm(runtime, rawFor(sb, testSetPath)),
      (e) => {
        assert.equal(e.code, 'E_ROLLBACK_FAILED', `实际 ${e.code}: ${e.message}`)
        assert.match(e.remediation, /独立风险档|必须/)
        assert.ok(e.details.reportPath)
        return true
      },
    )
    const mn = await readMustNotify(runtime)
    assert.ok(mn, '必须写 MUST_NOTIFY 状态文件')
    assert.equal(mn.latest.code, 'E_ROLLBACK_FAILED')
    assert.equal(mn.latest.severity, 'critical')
    assert.ok(mn.latest.message.includes('人工'))

    const report = JSON.parse(await fs.readFile(mn.latest.reportPath, 'utf8'))
    assert.equal(report.outcome, 'rollback-failed')
    assert.equal(report.mustNotify, true)
    const metric = await readMetrics(runtime)
    assert.ok(metric.counters.tune_not_improved >= 1)
  } finally { await sb.cleanup() }
})

test('闭环: 报告带"未测得的墙"与限定条件（不能无声地判到顶）', async () => {
  const { sb, runtime, testSetPath } = await setup()
  try {
    const out = await tuneWithConfirm(runtime, rawFor(sb, testSetPath))
    const d = out.report.wallDiagnosis
    // 观测不全时（本夹具只喂了部分观测），必须显式列出"该测什么"
    assert.ok(Array.isArray(d.unknownObservations))
    assert.ok(d.walls.every((w) => 'sanity' in w))
    assert.ok(Array.isArray(out.report.limitingConditions))
    assert.ok(typeof out.report.earlyStop.suspected === 'boolean')
  } finally { await sb.cleanup() }
})

test('闭环: 审计记录里带 runId / 根因墙 / 是否回滚失败（事后可追）', async () => {
  const { sb, runtime, testSetPath } = await setup()
  try {
    const out = await tuneWithConfirm(runtime, rawFor(sb, testSetPath))
    const { records } = await readAudit(runtime)
    const rec = records.find((r) => r.runId === out.runId)
    assert.ok(rec, '审计里应能找到这次运行')
    assert.equal(rec.capability, 'tune')
    assert.equal(rec.phase, 'end')
    assert.ok('rootWall' in rec)
    assert.equal(rec.rollbackFailed, false)
    assert.equal(rec.confirmed, true)
  } finally { await sb.cleanup() }
})
