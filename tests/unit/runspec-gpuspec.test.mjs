/**
 * 配置快照重放 + GPU 规格实测优先。
 *
 * 两个"验收要件"的落点：
 *   · "输出可复用的优化配置" ⇒ **同一条 spec 必须能重放出同一个端点**（做不到重放的配置只是个数）
 *   · "禁止规格书理论峰值当分母" ⇒ 只有规格书的 spec **不可用**（硬门，不是建议）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  captureRunSpec, applyParamsToArgv, serializeRunSpec, parseRunSpec, compareRunSpec,
  specFingerprint, booleanFlagsFromCatalog, needsGpuAll, shellQuote, toShellCommand, RUN_SPEC_SCHEMA_VERSION,
} from '../../src/config/run-spec.mjs'
import {
  resolveGpuSpec, specFromMeasured, assertUsableSpec, specKeyFromDeviceName, budgetBytesFor, STATIC_SPECS,
} from '../../src/platform/gpuspec.mjs'

// ---------------------------------------------------------------- run-spec

const digestModel = () => ({
  model: '/data/models/m',
  engine: { id: 'vllm', image: 'vllm/vllm-openai@sha256:' + 'a'.repeat(64), imageDigest: 'sha256:' + 'a'.repeat(64), servedModelName: 'm', kvCacheDtype: 'bfloat16' },
  params: { concurrency_capacity: 48, kv_pool_size: 0.9 },
  workload: 'chat-medium', requests: 8, concurrency: 2,
})

test('spec: 采集出可重放的 spec（镜像固定到 digest）', () => {
  const s = captureRunSpec(digestModel())
  assert.equal(s.schemaVersion, RUN_SPEC_SCHEMA_VERSION)
  assert.equal(s.replayable, true)
  assert.deepEqual(s.problems, [])
  assert.match(s.fingerprint, /^[0-9a-f]{16}$/)
})

test('spec: **镜像只写 tag 不算可重放** —— tag 会漂', () => {
  const s = captureRunSpec({ ...digestModel(), engine: { id: 'vllm', image: 'vllm/vllm-openai:nightly' } })
  assert.equal(s.replayable, false)
  assert.equal(s.problems[0].code, 'image-not-pinned-to-digest')
  assert.match(s.problems[0].detail, /tag 会漂/)
})

test('spec: 缺模型/引擎 → 不可重放', () => {
  const s = captureRunSpec({ engine: { id: 'vllm', image: 'x@sha256:' + 'a'.repeat(64), imageDigest: 'd' } })
  assert.equal(s.replayable, false)
  assert.ok(s.problems.some((p) => p.code === 'no-model'))
})

test('spec: 指纹**不含**易变字段（容器名/端口/时间戳），但 metadata 里可以留', () => {
  const a = captureRunSpec({ ...digestModel(), metadata: { runId: 'r1', containerName: 'c1', port: 8100 } })
  const b = captureRunSpec({ ...digestModel(), metadata: { runId: 'r2', containerName: 'c2', port: 8200 } })
  assert.equal(a.fingerprint, b.fingerprint, '易变字段不得进指纹，否则同一条配置会有两个指纹')
})

test('spec: 参数变了指纹就变', () => {
  const a = captureRunSpec(digestModel())
  const b = captureRunSpec({ ...digestModel(), params: { concurrency_capacity: 64, kv_pool_size: 0.9 } })
  assert.notEqual(a.fingerprint, b.fingerprint)
})

test('spec: 序列化 → 解析 往返，并**重算指纹**确认没被改过', () => {
  const s = captureRunSpec(digestModel())
  const back = parseRunSpec(serializeRunSpec(s))
  assert.equal(back.fingerprintMatches, true)

  const tampered = JSON.parse(serializeRunSpec(s))
  tampered.params.concurrency_capacity = 999
  const bad = parseRunSpec(tampered)
  assert.equal(bad.fingerprintMatches, false, '参数被改后指纹必须对不上')
  assert.notEqual(bad.recomputedFingerprint, s.fingerprint)
})

test('spec: 版本不匹配 → 响亮报错（不静默按旧版解析）', () => {
  assert.throws(() => parseRunSpec({ schemaVersion: '0.9.0' }), /版本不匹配/)
})

test('spec: 渲染 argv 只下发**已探测存在**的 flag，缺的记账', () => {
  const s = captureRunSpec(digestModel())
  const supported = new Set(['--concurrency-capacity'])
  const r = applyParamsToArgv(s, { supportedFlags: supported })
  assert.deepEqual(r.argv, ['--concurrency-capacity', '48'])
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].param, 'kv_pool_size')
})

test('spec: 布尔假/空值不下发（不发 `--x false` 这种会被引擎误读的东西）', () => {
  const s = captureRunSpec({ ...digestModel(), params: { a: true, b: false, c: null, d: 1 } })
  const r = applyParamsToArgv(s, {})
  assert.ok(r.argv.includes('--a'))
  assert.ok(!r.argv.includes('--b'))
  assert.ok(!r.argv.includes('--c'))
  assert.deepEqual(r.argv.slice(-2), ['--d', '1'])
})

test('spec: extraArgs 原样追加', () => {
  const s = captureRunSpec({ ...digestModel(), extraArgs: ['--enable-chunked-prefill'] })
  assert.ok(applyParamsToArgv(s, {}).argv.includes('--enable-chunked-prefill'))
})

test('spec: 逐项比较 —— 说出**哪里不同**，并分级', () => {
  const a = captureRunSpec(digestModel())
  const same = compareRunSpec(a, captureRunSpec(digestModel()))
  assert.equal(same.equal, true)
  assert.equal(same.verdict, 'identical')

  const b = captureRunSpec({ ...digestModel(), params: { concurrency_capacity: 64, kv_pool_size: 0.9 } })
  const diff = compareRunSpec(a, b)
  assert.equal(diff.equal, false)
  assert.equal(diff.verdict, 'different-affects-conclusion')
  assert.ok(diff.conclusionAffecting.some((d) => d.field === 'params.concurrency_capacity'))
  assert.match(diff.note, /不能拿 A 的结论说 B/)

  const c = captureRunSpec({ ...digestModel(), workload: 'decode-heavy' })
  const ctxOnly = compareRunSpec(a, c)
  assert.equal(ctxOnly.verdict, 'different-context-only', '只有负载形状不同 → 不影响结论')
})

test('spec: 换模型/换镜像 digest 属于"影响结论"的差异', () => {
  const a = captureRunSpec(digestModel())
  const b = captureRunSpec({ ...digestModel(), model: '/data/models/other' })
  assert.ok(compareRunSpec(a, b).conclusionAffecting.some((d) => d.field === 'model.path'))
  const d = captureRunSpec({ ...digestModel(), engine: { ...digestModel().engine, imageDigest: 'sha256:' + 'b'.repeat(64) } })
  assert.ok(compareRunSpec(a, d).conclusionAffecting.some((x) => x.field === 'engine.imageDigest'))
})

test('spec: 小工具（布尔目录 / GPU 需求 / shell 引用）', () => {
  assert.deepEqual(booleanFlagsFromCatalog({ a: { kind: 'bool' }, b: { kind: 'int' } }), ['a'])
  assert.equal(needsGpuAll({ concurrency_capacity: 8 }), true)
  assert.equal(needsGpuAll({}), false)
  assert.equal(shellQuote('simple-value'), 'simple-value')
  assert.equal(shellQuote('has space'), "'has space'")
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
})

test('spec: 生成可直接贴进文档的命令行', () => {
  const s = captureRunSpec(digestModel())
  const r = toShellCommand(s, { supportedFlags: new Set(['--concurrency-capacity', '--kv-pool-size']) })
  assert.match(r.command, /^inference-tuning validate /)
  assert.match(r.command, /--params /)
  assert.ok(r.argv.length > 0)
})

test('spec: 指纹是纯函数（同输入同输出）', () => {
  const s = captureRunSpec(digestModel())
  assert.equal(specFingerprint(s), specFingerprint(s))
})

// ---------------------------------------------------------------- gpuspec

test('gpuspec: **只有规格书值 → 不可用**（硬门，不是建议）', () => {
  const r = resolveGpuSpec({ deviceName: 'NVIDIA GB10' })
  assert.equal(r.usable, false)
  assert.equal(r.source, 'spec-sheet')
  assert.match(r.why, /规格书值不得作为承重输入/)
})

test('gpuspec: 规格书只作为"该测什么"的提示，明确标注不得进入分母', () => {
  const r = resolveGpuSpec({ deviceName: 'NVIDIA GB10' })
  assert.ok(r.hintFromSpecSheet)
  assert.equal(r.hintFromSpecSheet.key, 'gb10')
  assert.match(r.hintFromSpecSheet.warning, /禁止进入/)
  assert.equal(r.hintFromSpecSheet.source, 'spec-sheet')
})

test('gpuspec: 有实测可达带宽 → 可用，来源是 local-microbenchmark', () => {
  const r = resolveGpuSpec({ deviceName: 'NVIDIA GB10', measured: { achievableBandwidthGBps: 238.7 } })
  assert.equal(r.usable, true)
  assert.equal(r.source, 'local-microbenchmark')
  assert.equal(r.spec.achievableBandwidthGBps, 238.7)
})

test('gpuspec: 规格书的理论值**不会**混进实测结果', () => {
  const r = resolveGpuSpec({ deviceName: 'NVIDIA GB10', measured: { achievableBandwidthGBps: 238.7 } })
  assert.equal(r.spec.achievableBandwidthGBps, 238.7)
  assert.notEqual(r.spec.achievableBandwidthGBps, STATIC_SPECS.gb10.specSheet.bandwidthGBps)
  assert.equal(r.hintFromSpecSheet, null, '有实测时不返回规格书提示')
})

test('gpuspec: 统一内存机器必须提示"别照搬显存占用率"', () => {
  const r = resolveGpuSpec({ measured: { achievableBandwidthGBps: 238.7, memoryBytes: 119.6 * 2 ** 30, unifiedMemory: true } })
  assert.match(r.spec.caveat, /统一内存/)
  assert.match(r.spec.caveat, /不要/)
})

test('gpuspec: 断言可用性时给出**可操作的补救**，并禁止规格书代替', () => {
  const bad = assertUsableSpec(resolveGpuSpec({ deviceName: 'NVIDIA GB10' }))
  assert.equal(bad.ok, false)
  assert.match(bad.remediation, /微基准/)
  assert.match(bad.forbidden, /不得用规格书理论峰值代替/)
  assert.equal(assertUsableSpec(resolveGpuSpec({ measured: { achievableBandwidthGBps: 240 } })).ok, true)
})

test('gpuspec: 设备名匹配（GB10 的 is_integrated 注意事项）', () => {
  assert.equal(specKeyFromDeviceName('NVIDIA GB10'), 'gb10')
  assert.equal(specKeyFromDeviceName('NVIDIA H100 80GB HBM3 SXM'), 'h100-sxm')
  assert.equal(specKeyFromDeviceName('some unknown device'), null)
  assert.equal(specKeyFromDeviceName(null), null)
  assert.match(STATIC_SPECS.gb10.notes, /is_integrated/)
})

test('gpuspec: 可支配字节必须由调用方给比例或绝对值 —— **不猜**', () => {
  const gpu = specFromMeasured({ achievableBandwidthGBps: 238.7, memoryBytes: 100e9 })
  const none = budgetBytesFor({ gpu })
  assert.equal(none.budgetBytes, null)
  assert.match(none.why, /不猜/)

  assert.equal(budgetBytesFor({ gpu, reserveRatio: 0.1 }).budgetBytes, 90e9)
  assert.equal(budgetBytesFor({ gpu, reserveBytes: 20e9 }).budgetBytes, 80e9)
  assert.equal(budgetBytesFor({ gpu, reserveRatio: 1.5 }).budgetBytes, null)
  assert.equal(budgetBytesFor({ gpu: null }).budgetBytes, null)
})

test('gpuspec: 缺 memoryBytes 时不给预算（而不是假设一个）', () => {
  const gpu = specFromMeasured({ achievableBandwidthGBps: 238.7 })
  assert.match(budgetBytesFor({ gpu, reserveRatio: 0.1 }).why, /memoryBytes/)
})
