/**
 * 参数目录与硬排除。
 *
 * 最要紧的一条：**主模型量化格式变更必须被硬拒绝** ——
 * 用户在 2026-09-18 明确它是"硬排除，不是优先级问题"。
 * 因此这里逐条覆盖它可能混进来的每一种写法。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PARAM_CATALOG, paramCatalog, assertNoForbiddenParams, proposeCandidate, clampParam,
  buildLaunchArgs, parseSupportedFlags, snapToAlign, flagNameFor, leverToParams, selectableLevers,
  FORBIDDEN_PARAM_PATTERNS,
} from '../../src/registry.mjs'

test('硬排除: 量化/精度类参数一律拒绝（不是优先级）', () => {
  const cases = [
    { '--quantization': 'awq' },
    { 'quantization': 'awq' },
    { '--kv-cache-dtype': 'fp8' },
    { 'kv_cache_dtype': 'fp8' },
    { '--dtype': 'float16' },
    { 'dtype': 'bfloat16' },
    { '--load-format': 'dummy' },
    { '--weight-bits': 4 },
  ]
  for (const c of cases) {
    assert.throws(
      () => assertNoForbiddenParams(c),
      (e) => {
        assert.equal(e.code, 'E_QUANT_FORMAT_FORBIDDEN', JSON.stringify(c))
        assert.match(e.remediation, /硬排除/)
        return true
      },
      `应拒绝 ${JSON.stringify(c)}`,
    )
  }
})

test('硬排除: 正常调优参数不被误伤', () => {
  assert.equal(assertNoForbiddenParams({
    concurrency_capacity: 64, kv_pool_size: 0.9, seq_budget: 8192, prefill_chunk: 4096, batch_step_count: 4,
  }), true)
})

test('硬排除: 拒绝时明确说"换参数解决不了"（不进降级链）', () => {
  try {
    assertNoForbiddenParams({ '--dtype': 'fp8' })
    assert.fail('应当抛出')
  } catch (e) {
    assert.match(e.remediation, /目标函数之外|解决不了/)
    assert.ok(Array.isArray(e.details.hits) && e.details.hits.length === 1)
    assert.ok(e.details.forbiddenPatterns.length === FORBIDDEN_PARAM_PATTERNS.length)
  }
})

test('目录: 每个参数都声明 kind/min/max/所属墙/语义', () => {
  for (const p of paramCatalog()) {
    assert.ok(p.kind === 'int' || p.kind === 'float', `${p.id} kind`)
    assert.ok(Number.isFinite(p.min) && Number.isFinite(p.max) && p.min < p.max, `${p.id} 范围`)
    assert.ok(p.wall, `${p.id} 缺所属墙`)
    assert.ok(p.semantics, `${p.id} 缺语义说明`)
    assert.ok(p.default >= p.min && p.default <= p.max, `${p.id} 默认值超出范围`)
    assert.ok(flagNameFor(p.id, 'vllm'), `${p.id} 缺 vLLM flag`)
  }
})

test('目录: 所有 flag 都是 --kebab-case（不是 camelCase）', () => {
  for (const p of paramCatalog()) {
    const f = flagNameFor(p.id, 'vllm')
    assert.match(f, /^--[a-z0-9][a-z0-9-]*$/, `${p.id} → ${f}`)
  }
})

test('提案: 按方向调整并对齐/夹取到合法范围', () => {
  const up = proposeCandidate({ base: { concurrency_capacity: 32 }, lever: 'concurrency_capacity', direction: 'increase' })
  assert.ok(up.params.concurrency_capacity > 32)
  assert.deepEqual(up.changed.concurrency_capacity.from, 32)

  // 上界夹取
  const capped = proposeCandidate({ base: { concurrency_capacity: 1024 }, lever: 'concurrency_capacity', direction: 'increase' })
  assert.equal(capped.params.concurrency_capacity, 1024)

  // float 按因子
  const kv = proposeCandidate({ base: { kv_pool_size: 0.5 }, lever: 'kv_pool_size', direction: 'increase', factor: 1.5 })
  assert.ok(kv.params.kv_pool_size > 0.5 && kv.params.kv_pool_size <= 0.95)

  // decrease 方向
  const down = proposeCandidate({ base: { seq_budget: 8192 }, lever: 'seq_budget', direction: 'decrease', factor: 2 })
  assert.ok(down.params.seq_budget < 8192)
})

test('提案: 未知杠杆 → 拒绝并列出可用项（不猜）', () => {
  assert.throws(() => proposeCandidate({ lever: 'make_it_faster' }), (e) => {
    assert.equal(e.code, 'E_CAPABILITY_DENIED')
    assert.ok(e.details.available.includes('concurrency_capacity'))
    return true
  })
})

test('对齐与夹取: snapToAlign / clampParam', () => {
  assert.equal(snapToAlign(1000, 256), 1024)
  assert.equal(clampParam('concurrency_capacity', 0), PARAM_CATALOG.concurrency_capacity.min)
  assert.equal(clampParam('concurrency_capacity', 99999), PARAM_CATALOG.concurrency_capacity.max)
  assert.equal(clampParam('kv_pool_size', 2), PARAM_CATALOG.kv_pool_size.max)
  assert.equal(clampParam('seq_budget', 1000), 1024, '应对齐到 256 的倍数')
})

test('渲染: 只下发**已探测存在**的 flag，缺的一律跳过并记账（不猜）', () => {
  const supported = new Set(['--max-num-seqs', '--gpu-memory-utilization'])
  const r = buildLaunchArgs({ concurrency_capacity: 64, kv_pool_size: 0.9, batch_step_count: 4 }, { supportedFlags: supported })
  assert.deepEqual(r.args, ['--max-num-seqs', '64', '--gpu-memory-utilization', '0.9'])
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].paramId, 'batch_step_count')
  assert.match(r.skipped[0].reason, /不支持/)
})

test('渲染: flag 探测 —— vLLM 0.23.1rc1 删掉的两个 flag 必须能被识别为缺失', () => {
  const help = 'usage: vllm serve [options]\n  --max-num-seqs N\n  --gpu-memory-utilization F\n  --max-model-len N\n'
  const set = parseSupportedFlags(help)
  assert.ok(set.has('--max-num-seqs'))
  assert.ok(!set.has('--swap-space'), '已删除的 flag 不应出现在集合里')
  assert.ok(!set.has('--disable-log-requests'))
})

test('渲染: 空 help（探测失败）→ 集合为空，调用方会据此跳过全部参数而不是硬发', () => {
  assert.equal(parseSupportedFlags('').size, 0)
})

test('渲染: 参数集里带禁用项 → 在渲染阶段就抛（不会走到下发）', () => {
  assert.throws(() => buildLaunchArgs({ '--dtype': 'fp8' }), (e) => e.code === 'E_QUANT_FORMAT_FORBIDDEN')
})

test('杠杆→参数、可选参数筛选', () => {
  assert.deepEqual(leverToParams('concurrency_capacity'), ['concurrency_capacity'])
  const noSpec = selectableLevers({ engineCapabilities: { speculative: false } })
  assert.ok(!noSpec.includes('draft_budget'), '没启用投机时不应把草稿预算列为可动')
  const withSpec = selectableLevers({ engineCapabilities: { speculative: true } })
  assert.ok(withSpec.includes('draft_budget'))
})
