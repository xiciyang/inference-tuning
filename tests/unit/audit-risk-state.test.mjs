/**
 * 审计哈希链 / 风险分级与确认 / 调优注册表。
 *
 * 三条最要紧的性质：
 *   · 审计链**改过任何一条都会被发现**（就地变更必须留下不可改的证据）
 *   · R6 一律拒绝（**不是"确认后可执行"**），R2 需令牌且令牌绑定目标指纹
 *   · 注册表五要素缺字段要**显式暴露为 null**，不假装完整
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSandbox } from '../helpers/sandbox.mjs'
import { createRuntime } from '../../src/config.mjs'
import { appendAudit, readAudit, verifyAuditChain, verifyAllAuditChains, assertAuditChainIntact } from '../../src/audit.mjs'
import { classifyRisk, resolveConfirmation, requireConfirmation, confirmTokenFor, OPERATIONS } from '../../src/risk.mjs'
import { withRegistry, findRun, pushHistory, summarizeRun, listRuns, writeReport, readReport, loadRegistry } from '../../src/state/tuning-registry.mjs'
import { metricsBump, readMetrics, resetMetrics } from '../../src/metrics.mjs'
import { capabilitiesOperation } from '../../src/api.mjs'

async function rt() {
  const sb = await makeSandbox()
  const runtime = await createRuntime({ root: sb.root, options: { modelRoots: [sb.modelRoot] } })
  return { sb, runtime }
}

// ---------------------------------------------------------------- 审计

test('审计: 追加产生递增 seq 与连起来的哈希', async () => {
  const { sb, runtime } = await rt()
  try {
    const a = await appendAudit(runtime, { action: 'x', n: 1 })
    const b = await appendAudit(runtime, { action: 'y', n: 2 })
    assert.equal(a.seq, 1)
    assert.equal(b.seq, 2)
    assert.equal(b.prevHash, a.hash, 'prevHash 必须指向上一条的 hash')
    assert.notEqual(a.hash, b.hash)
    const v = await verifyAuditChain(runtime)
    assert.equal(v.ok, true)
    assert.equal(v.checked, 2)
  } finally { await sb.cleanup() }
})

test('审计: 链头是 genesis（全 0），且首个记录的 prevHash = genesis', async () => {
  const { sb, runtime } = await rt()
  try {
    const a = await appendAudit(runtime, { action: 'first' })
    assert.equal(a.prevHash, '0'.repeat(64))
  } finally { await sb.cleanup() }
})

test('审计: **改动任意一条内容** → 复算发现不一致', async () => {
  const { sb, runtime } = await rt()
  try {
    await appendAudit(runtime, { action: 'a' })
    await appendAudit(runtime, { action: 'b' })
    await appendAudit(runtime, { action: 'c' })
    const { file } = await readAudit(runtime)
    const fs = await import('node:fs/promises')
    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean)
    const rec = JSON.parse(lines[1])
    rec.action = 'TAMPERED'
    lines[1] = JSON.stringify(rec)
    await fs.writeFile(file, `${lines.join('\n')}\n`)
    const v = await verifyAuditChain(runtime)
    assert.equal(v.ok, false)
    assert.equal(v.brokenAt, 2)
    assert.match(v.reason, /内容被改动/)
  } finally { await sb.cleanup() }
})

test('审计: **删除一条** → 链断被检出', async () => {
  const { sb, runtime } = await rt()
  try {
    await appendAudit(runtime, { action: 'a' })
    await appendAudit(runtime, { action: 'b' })
    await appendAudit(runtime, { action: 'c' })
    const { file } = await readAudit(runtime)
    const fs = await import('node:fs/promises')
    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean)
    await fs.writeFile(file, `${[lines[0], lines[2]].join('\n')}\n`)
    const v = await verifyAuditChain(runtime)
    assert.equal(v.ok, false)
    assert.match(v.reason, /链断了/)
  } finally { await sb.cleanup() }
})

test('审计: 损坏行（非法 JSON）→ 判损坏而不是静默跳过', async () => {
  const { sb, runtime } = await rt()
  try {
    await appendAudit(runtime, { action: 'a' })
    const { file } = await readAudit(runtime)
    const fs = await import('node:fs/promises')
    await fs.appendFile(file, '{not json\n')
    const v = await verifyAuditChain(runtime)
    assert.equal(v.ok, false)
    assert.ok(v.parseErrors > 0)
  } finally { await sb.cleanup() }
})

test('审计: 链坏了要响亮失败（不允许继续写把断点糊过去）', async () => {
  const { sb, runtime } = await rt()
  try {
    await appendAudit(runtime, { action: 'a' })
    const { file } = await readAudit(runtime)
    const fs = await import('node:fs/promises')
    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean)
    const rec = JSON.parse(lines[0]); rec.action = 'X'; lines[0] = JSON.stringify(rec)
    await fs.writeFile(file, `${lines.join('\n')}\n`)
    await assert.rejects(() => assertAuditChainIntact(runtime), (e) => e.code === 'E_STATE_CONFLICT')
  } finally { await sb.cleanup() }
})

test('审计: 跨日期分片各自独立成链', async () => {
  const { sb, runtime } = await rt()
  try {
    await appendAudit(runtime, { action: 'd1' }, { date: new Date('2026-01-01T00:00:00Z') })
    await appendAudit(runtime, { action: 'd2' }, { date: new Date('2026-01-02T00:00:00Z') })
    const all = await verifyAllAuditChains(runtime)
    assert.equal(all.ok, true)
    assert.equal(all.files, 2)
  } finally { await sb.cleanup() }
})

// ---------------------------------------------------------------- 风险

test('风险: 未登记的操作 → 拒绝（不猜档位）', () => {
  assert.throws(() => classifyRisk('do_something_dangerous'), (e) => {
    assert.equal(e.code, 'E_CAPABILITY_DENIED')
    assert.ok(e.details.known.includes('tune'))
    return true
  })
})

test('风险: R6 一律拒绝，**不是"确认后可执行"**', async () => {
  const { sb, runtime } = await rt()
  try {
    for (const op of ['quant_format_change', 'modify_host', 'modify_other_pkg']) {
      assert.equal(OPERATIONS[op].tier, 'R6')
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        () => resolveConfirmation(runtime, { operation: op, payload: {}, confirm: 'anything' }),
        (e) => {
          assert.equal(e.code, 'E_CAPABILITY_DENIED')
          assert.match(e.remediation, /硬约束|不是.*确认后可执行/)
          return true
        },
      )
    }
  } finally { await sb.cleanup() }
})

test('风险: R0 从不询问；R2 首次要求令牌', async () => {
  const { sb, runtime } = await rt()
  try {
    const r0 = await resolveConfirmation(runtime, { operation: 'analyze', payload: {} })
    assert.equal(r0.required, false)
    assert.equal(r0.granted, true)

    const r2 = await resolveConfirmation(runtime, { operation: 'tune', payload: { model: '/m' } })
    assert.equal(r2.required, true)
    assert.equal(r2.granted, false)
    assert.match(r2.token, /^cf_/)
  } finally { await sb.cleanup() }
})

test('风险: 带正确令牌 → 授权；且 per-class-once 在 TTL 内复用', async () => {
  const { sb, runtime } = await rt()
  try {
    const first = await resolveConfirmation(runtime, { operation: 'tune', payload: { model: '/m' } })
    const granted = await resolveConfirmation(runtime, { operation: 'tune', payload: { model: '/m' }, confirm: first.token })
    assert.equal(granted.granted, true)
    assert.equal(granted.reused, false)

    const again = await resolveConfirmation(runtime, { operation: 'tune', payload: { model: '/m' } })
    assert.equal(again.granted, true)
    assert.equal(again.reused, true, 'per-class-once：24h 内不再问')
  } finally { await sb.cleanup() }
})

test('风险: 指纹变了 → 旧令牌作废（令牌绑定目标，不是通用通行证）', async () => {
  const { sb, runtime } = await rt()
  try {
    const a = await resolveConfirmation(runtime, { operation: 'tune', payload: { model: '/m1' } })
    await resolveConfirmation(runtime, { operation: 'tune', payload: { model: '/m1' }, confirm: a.token })
    const other = await resolveConfirmation(runtime, { operation: 'tune', payload: { model: '/m2' } })
    assert.notEqual(other.token, a.token)
    assert.equal(other.granted, false, '换模型必须重新确认')
  } finally { await sb.cleanup() }
})

test('风险: 指纹**排除** confirm 等记账字段（否则带令牌重试会算出新指纹 → 死循环）', async () => {
  const { sb, runtime } = await rt()
  try {
    const first = await resolveConfirmation(runtime, { operation: 'tune', payload: { model: '/m', confirm: null, options: {}, headless: false } })
    const retry = await resolveConfirmation(runtime, {
      operation: 'tune',
      payload: { model: '/m', confirm: first.token, options: { whatever: 1 }, headless: true },
      confirm: first.token,
    })
    assert.equal(retry.fingerprint, first.fingerprint, '记账字段不得影响指纹')
    assert.equal(retry.granted, true)
  } finally { await sb.cleanup() }
})

test('风险: 错误里的令牌可直接用于重试', async () => {
  const { sb, runtime } = await rt()
  try {
    const r = await resolveConfirmation(runtime, { operation: 'tune', payload: { model: '/m' } })
    try {
      requireConfirmation(r, { operation: 'tune', summary: 'x' })
      assert.fail('应抛出')
    } catch (e) {
      assert.equal(e.code, 'E_CONFIRMATION_REQUIRED')
      assert.equal(e.details.confirmToken, r.token)
      assert.ok(e.details.summary)
    }
  } finally { await sb.cleanup() }
})

test('风险: 令牌是 operation|fingerprint 的确定函数', () => {
  assert.equal(confirmTokenFor('tune', 'fp1'), confirmTokenFor('tune', 'fp1'))
  assert.notEqual(confirmTokenFor('tune', 'fp1'), confirmTokenFor('rollback', 'fp1'))
})

// ---------------------------------------------------------------- 注册表

test('注册表: 五要素完整 → complete=true', async () => {
  const { sb, runtime } = await rt()
  try {
    await withRegistry(runtime, (reg) => {
      reg.runs.push({
        id: 'tr_1', method: 'root-cause-wall-driven', config: { a: 1 },
        performance: { decodeTps: 60 }, accuracy: { dropPct: 1 }, status: 'improved', history: [],
      })
      return null
    })
    const runs = await listRuns(runtime)
    assert.equal(runs[0].complete, true)
    assert.deepEqual(runs[0].missing, [])
  } finally { await sb.cleanup() }
})

test('注册表: 缺字段 → **显式暴露为 null 并列出缺失项**，不假装完整', async () => {
  const { sb, runtime } = await rt()
  try {
    await withRegistry(runtime, (reg) => {
      reg.runs.push({ id: 'tr_2', method: 'x', status: 'no-improvement', history: [] })
      return null
    })
    const runs = await listRuns(runtime)
    assert.equal(runs[0].complete, false)
    assert.deepEqual(runs[0].missing.sort(), ['accuracy', 'config', 'performance'])
    assert.equal(runs[0].config, null)
    assert.equal(runs[0].performance, null)
  } finally { await sb.cleanup() }
})

test('注册表: 写前留快照（可在 historyDir 找到上一版）', async () => {
  const { sb, runtime } = await rt()
  try {
    await withRegistry(runtime, (reg) => { reg.runs.push({ id: 'a', history: [] }); return null })
    await withRegistry(runtime, (reg) => { reg.runs.push({ id: 'b', history: [] }); return null })
    const files = await (await import('node:fs/promises')).readdir(runtime.paths.historyDir)
    assert.ok(files.some((f) => f.endsWith('.registry.yaml')), JSON.stringify(files))
  } finally { await sb.cleanup() }
})

test('注册表: 损坏的注册表 → 响亮报错，**不静默重建**', async () => {
  const { sb, runtime } = await rt()
  try {
    const fs = await import('node:fs/promises')
    await fs.mkdir(runtime.paths.stateDir, { recursive: true })
    await fs.writeFile(runtime.paths.tuningRegistryFile, 'runs:\n\t- bad: tab\n')
    await assert.rejects(() => loadRegistry(runtime), (e) => {
      assert.equal(e.code, 'E_STATE_CONFLICT')
      assert.match(e.remediation, /不要.*直接覆盖|备份/)
      return true
    })
  } finally { await sb.cleanup() }
})

test('注册表: pushHistory 追加事件；报告可写可读', async () => {
  const { sb, runtime } = await rt()
  try {
    const rec = { id: 'x', history: [] }
    pushHistory(rec, 'tune-improved', { rounds: 3 })
    assert.equal(rec.history.length, 1)
    assert.equal(rec.history[0].event, 'tune-improved')
    assert.ok(rec.history[0].at)
    const p = await writeReport(runtime, 'tr_x', { hello: 'world' })
    assert.ok(p.endsWith('tr_x.json'))
    assert.deepEqual((await readReport(runtime, 'tr_x')).hello, 'world')
    assert.equal(await readReport(runtime, 'nope'), null)
  } finally { await sb.cleanup() }
})

test('注册表: summarizeRun 对 null 记录返回 null', () => {
  assert.equal(summarizeRun(null), null)
})

test('指标: 计数累加与复位', async () => {
  const { sb, runtime } = await rt()
  try {
    await metricsBump(runtime, 'round_accepted')
    await metricsBump(runtime, 'round_accepted')
    await metricsBump(runtime, 'round_rejected')
    const m = await readMetrics(runtime)
    assert.equal(m.counters.round_accepted, 2)
    assert.equal(m.counters.round_rejected, 1)
    await resetMetrics(runtime)
    assert.equal((await readMetrics(runtime)).counters.round_accepted, undefined)
  } finally { await sb.cleanup() }
})

test('能力清单: 明确列出"不做"的事，并给出该找谁', async () => {
  const { sb, runtime } = await rt()
  try {
    const out = await capabilitiesOperation(runtime, {})
    assert.equal(out.ok, true)
    const names = out.capabilities.notProvided.map((x) => x.name)
    assert.ok(names.includes('quantize'))
    assert.ok(names.includes('quant_format_change'))
    assert.ok(names.includes('field_mode'))
    assert.ok(names.includes('wiki'))
    assert.ok(out.capabilities.provided.length >= 8)
  } finally { await sb.cleanup() }
})
