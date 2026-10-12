/**
 * 精度回归（端点取数来源）—— 单元测试。
 *
 * 走**真本地 HTTP 服务**，不桩 fetch：
 *   · parity 代码走的网络路径必须被真的走到（桩掉就测不到"测量代码本身写错了"）
 *   · 端点返回的逐条 logprob **必须有方差**（常量正是 validity 门禁要拦的形态）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSandbox, withFakeEndpoint } from '../helpers/sandbox.mjs'
import { createRuntime } from '../../src/config.mjs'
import {
  parityCheck, compareParity, loadTestSet, resolveVocabSize,
  describeContract, PARITY_CONTRACT_VERSION, PARITY_METRIC, UNIFORM_TOLERANCE_NATS,
} from '../../src/testing/parity.mjs'

async function setup(spec = {}) {
  const sb = await makeSandbox()
  const runtime = await createRuntime({ root: sb.root, options: { modelRoots: [sb.modelRoot] } })
  runtime.__modelPath = sb.modelPath
  const testSetPath = await sb.makeTestSet(16)
  return { sb, runtime, testSetPath, spec }
}

test('契约: describeContract 与契约文件声明的版本一致', () => {
  const c = describeContract()
  assert.equal(c.contractVersion, PARITY_CONTRACT_VERSION)
  assert.equal(c.contractSource, 'docs/parity-contract.md')
  assert.equal(c.internal, true, '过渡件必须自标 @internal')
  assert.equal(c.source, 'endpoint-logprobs')
  assert.deepEqual(c.validityGateCodes, ['uniform-output', 'indiscriminate', 'no-item-variance'])
  assert.equal(c.uniformToleranceNats, UNIFORM_TOLERANCE_NATS)
})

test('契约: 测量侧含契约 §1.2 规定的全部键', async () => {
  const { sb, runtime, testSetPath } = await setup()
  try {
    await withFakeEndpoint({}, async ({ endpoint }) => {
      const side = await parityCheck(runtime, { endpointUrl: endpoint, model: 'm', testSetPath, label: 't' })
      for (const k of ['meanNll', 'perplexity', 'vocabSize', 'scoredSamples', 'tokens', 'itemMeanNlls', 'validity', 'source']) {
        assert.ok(k in side, `缺契约键 ${k}`)
      }
      assert.equal(side.source, 'endpoint-logprobs')
      assert.ok(Number.isFinite(side.meanNll))
      assert.ok(side.scoredSamples > 0)
      assert.ok(side.tokens > 0)
      assert.equal(side.validity.valid, true, JSON.stringify(side.validity.reasons))
      assert.ok(side.validity.checks.uniformGap !== null)
      assert.ok(side.itemMeanNlls.length === side.scoredSamples)
    })
  } finally { await sb.cleanup() }
})

test('契约: 按 token 加权（不是按样本平均）—— 长文本不被短文本淹没', async () => {
  const { sb, runtime, testSetPath } = await setup()
  try {
    // tokenCount 放宽，让不同长度的样本给出不同的 token 数 —— 否则加权与不加权恒等，
    // 这条用例就测不出"口径是不是 token 加权"
    await withFakeEndpoint({ tokenCount: 400 }, async ({ endpoint }) => {
      const side = await parityCheck(runtime, { endpointUrl: endpoint, model: 'm', testSetPath, label: 't' })
      const tokenCounts = new Set(side.perItem.filter((p) => p.tokens > 0).map((p) => p.tokens))
      assert.ok(tokenCounts.size > 1, `样本 token 数应有差异，实际 ${JSON.stringify([...tokenCounts])}`)
      const byTokens = side.itemMeanNlls.reduce((s, x, i) => s + x * (side.perItem[i].tokens), 0) / side.tokens
      assert.ok(Math.abs(byTokens - side.meanNll) < 1e-9, `token 加权口径不一致：${byTokens} vs ${side.meanNll}`)
      const bySamples = side.itemMeanNlls.reduce((s, x) => s + x, 0) / side.itemMeanNlls.length
      assert.notEqual(byTokens, bySamples)
    })
  } finally { await sb.cleanup() }
})

test('契约: 逐条极差 > 0（真端点的数据必须有方差）', async () => {
  const { sb, runtime, testSetPath } = await setup()
  try {
    await withFakeEndpoint({ jitter: 0.5 }, async ({ endpoint }) => {
      const side = await parityCheck(runtime, { endpointUrl: endpoint, model: 'm', testSetPath, label: 't' })
      assert.ok(side.validity.checks.itemMeanNllRange > 0)
      assert.equal(side.validity.valid, true)
    })
  } finally { await sb.cleanup() }
})

test('契约: 端点返回**常量** logprob → 测量不成立（no-item-variance）', async () => {
  const { sb, runtime, testSetPath } = await setup()
  try {
    await withFakeEndpoint({ jitter: 0, promptSpread: 0 }, async ({ endpoint }) => {
      const side = await parityCheck(runtime, { endpointUrl: endpoint, model: 'm', testSetPath, label: 't' })
      assert.equal(side.validity.valid, false)
      assert.ok(side.validity.reasons.some((r) => r.code === 'no-item-variance'), JSON.stringify(side.validity.reasons))
    })
  } finally { await sb.cleanup() }
})

test('契约: 均匀输出签名命中（meanNll ≈ ln(vocab)）→ 测量不成立', async () => {
  const { sb, runtime, testSetPath } = await setup()
  try {
    const vocab = 128
    const uniform = Math.log(vocab)
    await withFakeEndpoint({ logprobBase: -uniform, jitter: 0, promptSpread: 0, vocabSize: vocab }, async ({ endpoint }) => {
      const side = await parityCheck(runtime, { endpointUrl: endpoint, model: 'm', testSetPath, label: 't' })
      assert.equal(side.validity.valid, false)
      assert.ok(side.validity.reasons.some((r) => r.code === 'uniform-output'), JSON.stringify(side.validity.reasons))
      assert.ok(side.validity.checks.uniformGap <= UNIFORM_TOLERANCE_NATS)
    })
  } finally { await sb.cleanup() }
})

test('契约: 端点不支持 echo+logprobs → 明确失败并带 remediation', async () => {
  const { sb, runtime, testSetPath } = await setup()
  try {
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ text: 'x' }] }))   // 没有 logprobs
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const endpoint = `http://127.0.0.1:${server.address().port}`
    try {
      await assert.rejects(
        () => parityCheck(runtime, { endpointUrl: endpoint, model: 'm', testSetPath, label: 't' }),
        (e) => {
          assert.equal(e.code, 'E_TESTING_CORE_ERROR')
          assert.match(e.remediation, /echo\+logprobs/)
          return true
        },
      )
    } finally { await new Promise((r) => server.close(r)) }
  } finally { await sb.cleanup() }
})

test('契约: vocabSize 从模型 config 读；读不到 → null 且**不做**均匀判定（不猜）', async () => {
  const { sb, runtime, testSetPath } = await setup()
  try {
    assert.equal(resolveVocabSize(sb.modelPath), sb.vocabSize)
    assert.equal(resolveVocabSize('/nonexistent/path'), null)
    runtime.__modelPath = null
    await withFakeEndpoint({}, async ({ endpoint }) => {
      const side = await parityCheck(runtime, { endpointUrl: endpoint, model: 'm', testSetPath, label: 't' })
      assert.equal(side.vocabSize, null)
      assert.equal(side.validity.checks.uniformGap, null)
      assert.equal(side.validity.valid, true)
    })
  } finally { await sb.cleanup() }
})

test('契约: compareParity 产出 §1.1 的完整结构（含 drop 口径）', async () => {
  const before = { meanNll: 2.5, perplexity: Math.exp(2.5), vocabSize: 100, scoredSamples: 10, tokens: 100, itemMeanNlls: [2.4, 2.6], validity: { valid: true, reasons: [] } }
  const after = { meanNll: 2.6, perplexity: Math.exp(2.6), vocabSize: 100, scoredSamples: 10, tokens: 100, itemMeanNlls: [2.5, 2.7], validity: { valid: true, reasons: [] } }
  const r = compareParity({ before, after, evidence: { testSetPath: '/x', testSetDigest: 'abc' } })
  assert.equal(r.ok, true)
  assert.equal(r.metric, PARITY_METRIC)
  assert.ok(Math.abs(r.drop.pct - ((Math.exp(2.6) - Math.exp(2.5)) / Math.exp(2.5)) * 100) < 1e-9)
  assert.ok(Math.abs(r.drop.nllDelta - 0.1) < 1e-9)
  assert.equal(r.validity.before.valid, true)
  assert.equal(r.evidence.contractVersion, PARITY_CONTRACT_VERSION)
  assert.equal(r.evidence.implementation, 'inference-tuning/internal')
})

test('契约: compareParity 缺一侧 → 明确失败', () => {
  assert.throws(() => compareParity({ before: null, after: {} }), (e) => e.code === 'E_TESTING_CORE_ERROR')
})

test('契约: 评测集 digest 必填（否则"前后测的是不是同一份数据"无法回答）', async () => {
  const { sb, runtime, testSetPath } = await setup()
  try {
    const ds = loadTestSet(testSetPath)
    assert.equal(ds.digest.length, 64)
    assert.equal(ds.items.length, 16)
    assert.equal(loadTestSet(testSetPath, { limit: 5 }).items.length, 5)
  } finally { await sb.cleanup() }
})

test('契约: 评测集不存在 → 明确失败（不静默当成空集）', () => {
  assert.throws(() => loadTestSet('/no/such/file.jsonl'), (e) => e.code === 'E_TESTING_CORE_ERROR')
})
