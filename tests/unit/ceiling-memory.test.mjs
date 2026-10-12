/**
 * 单流天花板 + 内存分解。
 *
 * 两条纪律贯穿全部用例：
 *   · 天花板必须带**限定条件**（至少一条实现域），否则它不是"上限"，只是"当前观测"
 *   · 推不出来的项一律 **null + 缺什么**，绝不拿系数凑
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { singleStreamCeiling, bytesPerToken, evidenceChain, resolveConditional } from '../../src/walls/ceiling.mjs'
import {
  dtypeBytes, solvePerSlotCost, decomposeByFormula, decomposeStateCache, solvePerReq, attributeLevers,
} from '../../src/walls/memory.mjs'

const ctx = (over = {}) => ({
  hardware: { achievableBandwidthGBps: 238.7, ...(over.hardware ?? {}) },
  model: { bytesPerTokenGB: 1.07, contextLength: 2048, ...(over.model ?? {}) },
  engine: { image: 'vllm@sha256:abc', kernelImplementation: 'vllm-nightly-flash-attn', ...(over.engine ?? {}) },
  measurements: { singleStreamTps: 60, ...(over.measurements ?? {}) },
  provenance: { achievableBandwidthGBps: 'local-microbenchmark', bytesPerTokenGB: 'model-file-scan', ...(over.provenance ?? {}) },
})

// ---------------------------------------------------------------- 天花板

test('天花板: 用实测带宽与实测访存量算上界，并给出利用率', () => {
  const c = singleStreamCeiling(ctx())
  assert.equal(c.usable, true)
  assert.ok(Math.abs(c.ceilingTps - 238.7 / 1.07) < 1e-9)
  assert.ok(c.utilization > 0 && c.utilization < 1)
  assert.equal(c.sanity.ok, true)
  assert.match(c.formula, /实测可达带宽/)
})

test('天花板: 缺实测带宽 → 不可用，且**明说禁止用规格书峰值代替**', () => {
  const c = singleStreamCeiling(ctx({ hardware: { achievableBandwidthGBps: null } }))
  assert.equal(c.usable, false)
  assert.match(c.why, /禁止用规格书峰值/)
  assert.equal(c.ceilingTps, null)
})

test('天花板: **可自我否证** —— 反推带宽超过实测可达时判"分母口径有误"', () => {
  // 分母被算大了（把不该算的层算进去），于是 tps × 分母 超过实测带宽
  const c = singleStreamCeiling(ctx({ model: { bytesPerTokenGB: 8.0 }, measurements: { singleStreamTps: 60 } }))
  assert.equal(c.sanity.ok, false)
  assert.match(c.sanity.warn, /口径有误/)
  assert.match(c.sanity.warn, /禁止据此判定/)
  assert.ok(c.sanity.effectiveGBps > c.sanity.achievableGBps)
})

test('天花板: 每 token 访存拆成"权重 + KV"两项，长上下文时 KV 反超', () => {
  const short = bytesPerToken(ctx({ model: { bytesPerTokenGB: 1.07, contextLength: 0, stateCacheBytesPerToken: 0 } }))
  assert.equal(short.kv, 0)
  assert.equal(short.total, 1.07)

  // 每 token 每上下文 128 KB：2048 上下文 → 0.25 GB
  const b = bytesPerToken(ctx({ model: { bytesPerTokenGB: 1.07, contextLength: 2048, kvBytesPerTokenPerCtx: 131072 } }))
  assert.ok(Math.abs(b.kv - (131072 * 2048) / 1e9) < 1e-9)
  assert.ok(b.total > b.weights)
  assert.match(b.kvForm, /kvBytesPerTokenPerCtx/)

  // 长上下文下 KV 反超权重
  const long = bytesPerToken(ctx({ model: { bytesPerTokenGB: 1.07, contextLength: 32768, kvBytesPerTokenPerCtx: 131072 } }))
  assert.ok(long.kv > long.weights, `KV ${long.kv} 应超过权重 ${long.weights}`)
})

test('天花板: 缺每 token 权重 → 报缺什么（不许默认 0）', () => {
  const b = bytesPerToken({ model: { contextLength: 2048 } })
  assert.equal(b.total, null)
  assert.match(b.why, /bytesPerTokenGB/)
})

test('天花板: 限定条件必须是**实现域**的（kernel / 缓存格式 / 量化精度）', () => {
  const withKernel = resolveConditional(ctx())
  assert.ok(withKernel.some((c) => c.kind === 'kernel'))
  assert.ok(withKernel.some((c) => c.kind === 'quant') === false, '本 ctx 没给量化格式')

  const onlyEngine = resolveConditional({ engine: { image: 'x' } })
  assert.equal(onlyEngine.length, 1)
  assert.equal(onlyEngine[0].kind, 'engine')
  assert.ok(!['kernel', 'cache', 'quant'].includes(onlyEngine[0].kind), '仅镜像不算实现域')
})

test('天花板: 证据链每一步都带来源，可被独立复核', () => {
  const ch = evidenceChain(ctx())
  assert.ok(ch.nodes.length >= 6)
  assert.equal(ch.nodes[0].source, 'local-microbenchmark')
  assert.ok(ch.nodes.some((n) => n.source === 'model-file-scan'))
  assert.ok(ch.nodes.some((n) => n.source === 'derived'))
  assert.ok(ch.nodes.every((n) => n.step && n.fact && 'value' in n && 'source' in n))
  assert.match(ch.note, /否证/)
})

// ---------------------------------------------------------------- 内存

test('内存: dtype 宽度表；不认识的 dtype 返回 null（不猜）', () => {
  assert.equal(dtypeBytes('bfloat16'), 2)
  assert.equal(dtypeBytes('float8_e4m3fn'), 1)
  assert.equal(dtypeBytes('int4'), 0.5)
  assert.equal(dtypeBytes('float64_totally_unknown'), null)
  assert.equal(dtypeBytes(null), null)
})

test('内存: 每 KV token 字节数按公式算（2×K,V × 层 × KV头 × head_dim × 宽度）', () => {
  const r = solvePerSlotCost({ config: { numHiddenLayers: 28, numKeyValueHeads: 2, headDim: 128 }, dtype: 'bfloat16' })
  assert.equal(r.bytesPerToken, 2 * 28 * 2 * 128 * 2)
  assert.equal(r.bytesPerToken, 28672)
  assert.equal(r.provenance, 'model-config')
})

test('内存: 缺配置项 → 返回 null 并点名缺哪个（猜错会让容量差几倍）', () => {
  const r = solvePerSlotCost({ config: { numHiddenLayers: 28 } })
  assert.equal(r.bytesPerToken, null)
  assert.ok(r.missing.includes('numKeyValueHeads'))
  assert.ok(r.missing.includes('headDim'))
  assert.match(r.why, /不猜/)
})

test('内存: MLA/SSM 结构用调用方给的实测值，不走 KV 公式', () => {
  const r = solvePerSlotCost({ config: { stateCacheBytesPerToken: 12345 } })
  assert.equal(r.bytesPerToken, 12345)
  assert.match(r.form, /调用方实测/)
  assert.equal(r.provenance, 'adapter')
})

test('内存: 完整分解 —— 池 = 预算 − 权重 − 开销；token 数 = 池 / 每 token', () => {
  const d = decomposeByFormula({
    config: { numHiddenLayers: 28, numKeyValueHeads: 2, headDim: 128 },
    budgetBytes: 100e9, weightsBytes: 3e9, overheadBytes: 2e9,
    dtype: 'bfloat16', unifiedMemory: true, maxContextLength: 4096,
  })
  assert.equal(d.usable, true)
  assert.equal(d.terms.kvPoolBytes, 95e9)
  assert.equal(d.maxTokens, Math.floor(95e9 / 28672))
  assert.equal(d.maxConcurrentAt.concurrency, Math.floor(d.maxTokens / 4096))
  assert.equal(d.unifiedMemory, true)
  assert.match(d.caveat, /统一内存/)
})

test('内存: 缺项 → usable=false 且**逐项列出**缺什么（不假装完整）', () => {
  const d = decomposeByFormula({ config: { numHiddenLayers: 28 } })
  assert.equal(d.usable, false)
  assert.ok(d.missing.length >= 3)
  assert.ok(d.missing.some((m) => m.includes('budgetBytes')))
  assert.ok(d.missing.some((m) => m.includes('weightsBytes')))
  assert.equal(d.maxTokens, null)
})

test('内存: 状态缓存按"每请求固定 slot"算，不与 KV 混为一谈', () => {
  const s = decomposeStateCache({
    stateCacheBytes: 8e9, slotsPerRequest: 4, budgetBytes: 100e9, weightsBytes: 40e9, overheadBytes: 10e9,
  })
  assert.equal(s.terms.statePoolBytes, 50e9)
  assert.equal(s.terms.perRequestBytes, 2e9)
  assert.equal(s.maxConcurrent, 25)
  assert.match(s.distinction, /KV 随上下文线性增长.*状态缓存按请求固定/)
})

test('内存: 每请求占用把 KV + 状态 + 激活加在一起', () => {
  const r = solvePerReq({ contextLength: 4096, bytesPerKvToken: 28672, activationBytes: 1e6 })
  assert.equal(r.perRequestBytes, 4096 * 28672 + 1e6)
  assert.equal(r.usable, true)
  assert.equal(solvePerReq({ contextLength: 4096 }).usable, false)
})

test('内存: 杠杆归因给出**具体释放多少字节**，不是"可能有用"', () => {
  const breakdown = decomposeByFormula({
    config: { numHiddenLayers: 28, numKeyValueHeads: 2, headDim: 128 },
    budgetBytes: 100e9, weightsBytes: 3e9, overheadBytes: 2e9, dtype: 'bfloat16',
  })
  const a = attributeLevers({
    breakdown, config: { numHiddenLayers: 28, numKeyValueHeads: 2, headDim: 128 },
    kvDtype: 'bfloat16', targetDtype: 'float8_e4m3fn', contextLength: 4096, seqBudgetNew: 2048,
  })
  const kv = a.derivableLevers.find((l) => l.lever === 'kv_precision')
  assert.ok(kv, 'KV 精度杠杆应可推导')
  assert.equal(kv.freesBytesPerToken, 28672 * 0.5, 'bf16→fp8 释放一半')
  assert.equal(kv.accuracySensitive, true)
  assert.match(kv.caveat, /精度回归/)

  const seq = a.derivableLevers.find((l) => l.lever === 'seq_budget')
  assert.ok(seq)
  assert.equal(seq.freesBytesPerRequest, (4096 - 2048) * 28672)
  assert.equal(seq.maxConcurrentAfter, Math.floor(breakdown.maxTokens / 2048))

  assert.match(a.note, /释放字节/)
})

test('内存: 推不出来的杠杆必须标 derivable=false 并说明为什么', () => {
  const a = attributeLevers({ breakdown: null, config: {}, kvDtype: 'bfloat16', targetDtype: 'float8_e4m3fn' })
  const kv = a.levers.find((l) => l.lever === 'kv_precision')
  assert.ok(kv)
  // 没有 perSlot 时无法推导
  assert.equal(kv.derivable, false)
  assert.ok(kv.why)
})

test('内存: 没有任何可推导杠杆时，明说"先补齐缺项再谈扩容建议"', () => {
  const a = attributeLevers({ breakdown: null, config: {}, kvDtype: 'unknown_dtype', targetDtype: 'also_unknown' })
  assert.equal(a.derivableLevers.length, 0)
  assert.match(a.note, /先补齐/)
})
