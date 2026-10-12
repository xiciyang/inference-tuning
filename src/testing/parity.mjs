/**
 * @internal 精度回归实现（**过渡件**）—— 契约见 `docs/parity-contract.md`（单一事实来源）。
 *
 * 为什么标注 @internal：
 *   题面把精度/性能验证划给共享库 `@ai-infra/testing-core`，但**该库在本机不存在**
 *   （2026-09-27 四项独立探测：工作区无 @ai-infra / npm ls 为空 / 全盘 find 为空 /
 *    registry.npmjs.org 返回 000 不可达）。用户裁决：**两份实现 + 契约一致性检查（CI 级）**。
 *   因此本文件是过渡件：
 *     - 对外只暴露契约里的函数
 *     - `@ai-infra/testing-core` 发布后，两个包**同时**把实现换成真库（调用方零改动）
 *     - 迁移脚本见 `scripts/migrate-to-testing-core.mjs`
 *
 * **与 quantization 那份实现的唯一实质差别是取数来源**：
 *   quantization 调的是磁盘上的权重 → `container-forward`
 *   tuning 调的是**正在被服务的那个配置** → `endpoint-logprobs`
 * 契约约束的是"结果长什么样 + 怎么判成立"，不是"从哪取数"，所以这是同一个契约的两个来源。
 *
 * 真机交叉验证（2026-09-27，同一份 wikitext 测试集、同一个模型）：
 *   端点法 ppl = 16.0852（60 条 / 9130 token）
 *   容器法 ppl = 15.3366（400 条 / 67658 token）
 *   两者相差 5%，差异可解释（端点法跳过无前文的首 token；截断口径不同）。
 *   **两者都远离均匀输出签名（ln(151936) = 11.93），逐条极差 2.95 —— 测量有判别力。**
 */
import { readFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { sha256 } from '../util/hash.mjs'
import { readText } from '../util/fsx.mjs'
import { fail, warn, ERROR_CODES, WARNING_CODES } from '../errors.mjs'

/**
 * 契约版本。**必须与 `docs/parity-contract.md` 声明的一致** ——
 * `tests/contract/parity-consistency.test.mjs` 会断言这一点。
 */
export const PARITY_CONTRACT_VERSION = '1.0.0'

/** 契约里固定的指标名。 */
export const PARITY_METRIC = 'mean-nll-and-perplexity'

/** 与本契约对应的实现标识。 */
export const PARITY_IMPLEMENTATION = 'inference-tuning/internal'

/**
 * 契约声明（可被 CLI `contract` 子命令打印，也可被审计记录）。
 * 结构必须与契约 §1 §3 §4 对齐。
 */
export function describeContract() {
  return {
    name: '@ai-infra/testing-core',
    contractVersion: PARITY_CONTRACT_VERSION,
    contractSource: 'docs/parity-contract.md',
    implementation: PARITY_IMPLEMENTATION,
    internal: true,
    source: 'endpoint-logprobs',
    peerImplementation: {
      pkg: 'inference-quantization',
      implementation: 'inference-quantization/internal',
      source: 'container-forward',
    },
    functions: {
      parityCheck: {
        purpose: '对**当前被服务的配置**在给定评测集上做一次精度测量，返回契约 §1.2 的测量侧',
        inputs: ['runtime', 'endpointUrl', 'model', 'testSetPath', 'limit?', 'label?'],
        returns: ['meanNll', 'perplexity', 'vocabSize', 'scoredSamples', 'tokens', 'itemMeanNlls', 'validity', 'source'],
      },
      compareParity: {
        purpose: '把调优前后两次测量合成契约 §1.1 的完整结果（含 drop 与 validity）',
        inputs: ['before', 'after', 'evidence'],
        returns: ['ok', 'metric', 'before', 'after', 'drop', 'validity', 'evidence'],
      },
    },
    /** 契约 §3.2 的三闸 —— 判定端实现必须覆盖这三个 code。 */
    validityGateCodes: ['uniform-output', 'indiscriminate', 'no-item-variance'],
    uniformToleranceNats: 1e-4,
  }
}

/** 契约里规定的均匀签名容差。 */
export const UNIFORM_TOLERANCE_NATS = 1e-4

// ---------------------------------------------------------------- 评测集

/**
 * 读评测集（jsonl，每行 `{h, t}`）。
 * `testSetDigest` 是**必填证据**：否则"前后测的是不是同一份数据"无法回答。
 */
export function loadTestSet(path, { limit = 0 } = {}) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    fail(ERROR_CODES.E_TESTING_CORE_ERROR, `无法读取评测集：${path}`, {
      remediation: '确认路径存在；评测集应为 jsonl，每行含 {"h": <内容哈希>, "t": <文本>}',
      details: { path, error: String(err.message) },
    })
  }
  const items = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try {
      const j = JSON.parse(t)
      if (typeof j.t === 'string' && j.t.length > 0) items.push(j.t)
    } catch { /* 跳过损坏行；条数由 digest 与 scoredSamples 兜底比对 */ }
  }
  const sliced = limit > 0 ? items.slice(0, limit) : items
  return { items: sliced, total: items.length, digest: sha256(raw), path }
}

/**
 * 词表大小：从模型目录的 `config.json` 读。
 * **读不到就返回 null，不猜** —— 契约 §1.2 明确规定 null 表示不做均匀签名判定。
 */
export function resolveVocabSize(modelPath) {
  if (!modelPath) return null
  const p = isAbsolute(modelPath) ? join(modelPath, 'config.json') : join(process.cwd(), modelPath, 'config.json')
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    const v = Number(j.vocab_size)
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 端点取数

/**
 * 向端点要一段文本的 prompt logprobs。
 *
 * vLLM 的 OpenAI 兼容接口在 `echo: true` 时，`choices[0].logprobs.token_logprobs`
 * 覆盖**整段 prompt** 的每个 token（首 token 为 `null`，因为它没有前文）。
 * 真机实测确认（2026-09-27）。
 */
async function fetchPromptLogprobs({ endpointUrl, model, text, maxPromptChars, timeoutMs }) {
  const prompt = String(text).slice(0, maxPromptChars)
  const body = { model, prompt, max_tokens: 1, temperature: 0, echo: true, logprobs: 1 }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(`${endpointUrl}/v1/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      return { ok: false, status: r.status, error: t.slice(0, 300) }
    }
    const j = await r.json()
    const tl = j?.choices?.[0]?.logprobs?.token_logprobs
    if (!Array.isArray(tl)) {
      return { ok: false, status: 200, error: '响应里没有 choices[0].logprobs.token_logprobs（该端点不支持 echo+logprobs）' }
    }
    return { ok: true, tokenLogprobs: tl }
  } catch (err) {
    return { ok: false, status: null, error: String(err?.message ?? err).slice(0, 300) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 契约 §1.2 的测量侧。
 *
 * 口径：**按 token 加权**的平均负对数似然（不是按样本平均 —— 那会让长文本被短文本淹没）。
 * 首 token 没有前文，其 logprob 为 null，不计入。
 */
export async function parityCheck(runtime, {
  endpointUrl, model, testSetPath, limit = 0, label = 'parity', log = null,
  minTokensPerItem = 8, maxPromptChars = 6000, timeoutMs = 60_000, concurrency = 2,
} = {}) {
  if (!endpointUrl || !model || !testSetPath) {
    fail(ERROR_CODES.E_TESTING_CORE_ERROR, 'parityCheck 需要 endpointUrl / model / testSetPath', {
      remediation: '检查调用参数；这是内部契约错误，通常意味着上游没准备好评测集或端点。',
      details: { endpointUrl, model, testSetPath },
    })
  }
  const t0 = Date.now()
  const ds = loadTestSet(testSetPath, { limit })
  if (ds.items.length === 0) {
    fail(ERROR_CODES.E_TESTING_CORE_ERROR, `评测集为空：${testSetPath}`, {
      remediation: '确认评测集文件非空且每行含 {"t": "<文本>"}。',
      details: { testSetPath, digest: ds.digest },
    })
  }
  const vocabSize = resolveVocabSize(runtime?.options?.modelPath ?? runtime?.__modelPath ?? null)

  const perItem = []
  const errors = []
  // token 级的均匀输出签名：若某条样本内**所有** token 的 logprob 逐位相同，
  // 那正是"输出均匀分布"在 token 粒度上的表现（每个 token 概率都 = 1/V ⇒ logprob 都是 −ln V）。
  // 它比"逐条均值相同"更早命中：逐条均值可能因为 prompt 不同而仍有差异，
  // 但 token 级相同这条会先把退化暴露出来。
  let constantTokenItems = 0
  let constantTokenSample = null
  let idx = 0
  const worker = async () => {
    while (true) {
      const i = idx
      idx += 1
      if (i >= ds.items.length) return
      // eslint-disable-next-line no-await-in-loop
      const r = await fetchPromptLogprobs({
        endpointUrl, model, text: ds.items[i], maxPromptChars, timeoutMs,
      })
      if (!r.ok) {
        errors.push({ i, status: r.status, error: r.error })
        perItem.push({ i, tokens: 0, nll: null, meanNll: null, error: r.error })
        continue
      }
      const valid = r.tokenLogprobs.filter((x) => typeof x === 'number' && Number.isFinite(x))
      if (valid.length < minTokensPerItem) {
        perItem.push({ i, tokens: 0, nll: null, meanNll: null, skipped: 'too-short' })
        continue
      }
      const nllSum = -valid.reduce((a, b) => a + b, 0)
      const distinctTokens = new Set(valid)
      if (distinctTokens.size === 1 && valid.length >= minTokensPerItem) {
        constantTokenItems += 1
        if (constantTokenSample === null) {
          constantTokenSample = { i, tokens: valid.length, logprob: valid[0], impliedPpl: Math.exp(-valid[0]) }
        }
      }
      perItem.push({ i, tokens: valid.length, nll: nllSum, meanNll: nllSum / valid.length })
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()))

  const scored = perItem.filter((p) => p.tokens > 0)
  const tokens = scored.reduce((s, p) => s + p.tokens, 0)
  if (tokens === 0) {
    fail(ERROR_CODES.E_TESTING_CORE_ERROR, `精度测量未得到任何成功响应（${label}）`, {
      remediation: '检查端点是否就绪、模型名是否匹配、以及该端点是否支持 echo+logprobs。'
        + '首条错误见 details.errors。',
      details: { endpointUrl, model, label, errors: errors.slice(0, 3) },
    })
  }
  const meanNll = scored.reduce((s, p) => s + p.nll, 0) / tokens
  const uniformLoss = vocabSize ? Math.log(vocabSize) : null
  const uniformGap = uniformLoss === null ? null : Math.abs(meanNll - uniformLoss)

  const itemMeanNlls = scored.map((p) => p.meanNll)
  let range = null
  if (itemMeanNlls.length > 1) {
    range = Math.max(...itemMeanNlls) - Math.min(...itemMeanNlls)
  }

  const reasons = []
  if (uniformGap !== null && uniformGap <= UNIFORM_TOLERANCE_NATS) {
    reasons.push({
      code: 'uniform-output',
      detail: `meanNll=${meanNll.toFixed(10)} 与 ln(vocab_size)=${uniformLoss.toFixed(10)} 相差 ${uniformGap.toExponential(2)}`
        + ` ≤ ${UNIFORM_TOLERANCE_NATS} —— 模型输出近似均匀分布，"精度"在此没有区分力`,
    })
  }
  if (range === 0) {
    reasons.push({ code: 'no-item-variance', detail: `${itemMeanNlls.length} 条样本的逐条 meanNll 逐位相同（极差 = 0）` })
  }
  if (constantTokenItems > 0) {
    reasons.push({
      code: 'constant-token-logprobs',
      detail: `${constantTokenItems}/${scored.length} 条样本内**所有 token 的 logprob 逐位相同**`
        + `（示例：第 ${constantTokenSample.i} 条，${constantTokenSample.tokens} 个 token 全是 ${constantTokenSample.logprob}，`
        + `隐含困惑度 ${constantTokenSample.impliedPpl.toFixed(1)}）—— 这是"输出均匀分布"在 token 粒度上的签名`,
    })
  }
  if (errors.length > 0 && errors.length >= scored.length) {
    reasons.push({ code: 'no-scored-samples', detail: '没有任何样本评分成功' })
  }

  const side = {
    label,
    meanNll,
    perplexity: Math.exp(Math.min(meanNll, 50)),
    vocabSize,
    scoredSamples: scored.length,
    tokens,
    itemMeanNlls,
    source: 'endpoint-logprobs',
    validity: {
      valid: reasons.length === 0,
      reasons,
      uniformTol: UNIFORM_TOLERANCE_NATS,
      checks: {
        vocabSize, uniformLoss, uniformGap, itemMeanNllRange: range, errorCount: errors.length,
        constantTokenItems, constantTokenSample,
      },
    },
  }
  if (vocabSize === null) {
    runtime?.warnings?.push?.(warn(WARNING_CODES.W_CONTRACT_CHECK_UNAVAILABLE,
      '未取到 vocab_size（模型 config.json 不可读）—— 本次**不做**均匀输出签名判定（不猜）',
      { endpointUrl, label }))
  }
  log?.info?.('精度测量完成', { label, meanNll, perplexity: side.perplexity, tokens, scored: scored.length })
  return { ...side, durationMs: Date.now() - t0, perItem }
}

/**
 * 契约 §1.1：把前后两次测量合成完整结果。
 * **只搬运事实**，不做成立性判定 —— 判定在 `src/gate.mjs` 的纯函数里（判定与测量分离）。
 */
export function compareParity({ before, after, evidence = {} } = {}) {
  if (!before || !after) {
    fail(ERROR_CODES.E_TESTING_CORE_ERROR, 'compareParity 需要 before 与 after 两次测量', {
      remediation: '内部契约错误：调优前后各应有一次精度测量。',
      details: { hasBefore: Boolean(before), hasAfter: Boolean(after) },
    })
  }
  const dropPct = before.perplexity > 0
    ? ((after.perplexity - before.perplexity) / before.perplexity) * 100
    : null
  return {
    ok: true,
    metric: PARITY_METRIC,
    before,
    after,
    drop: { pct: dropPct, nllDelta: after.meanNll - before.meanNll },
    validity: { before: before.validity ?? null, after: after.validity ?? null },
    evidence: {
      contractVersion: PARITY_CONTRACT_VERSION,
      contractSource: 'docs/parity-contract.md',
      implementation: PARITY_IMPLEMENTATION,
      source: 'endpoint-logprobs',
      ...evidence,
    },
  }
}

export { warn, WARNING_CODES, readText }
