/**
 * 性能测量（契约里 `perfValidation` 的位置）。
 *
 * 与精度测量的分工：
 *   精度必须走**直接打分**（logprobs），因为我们要的是"模型变了多少"；
 *   性能必须走**真实服务端点**，因为调度/批处理/显存这些恰恰是被调的对象 ——
 *   绕开端点测性能等于把要调的东西排除在测量之外。
 *
 * 测量口径全部**显式声明**（契约与四闸要求）：
 *   - 聚合口径：各指标取 median（长尾稳健），同时在 evidence 里带 mean 与样本数
 *   - TTFT：首 token 到达时刻 − 请求发出时刻
 *   - decodeTps：token 数 /（总时长 − TTFT），逐请求算再取 median
 *
 * 用 node:http 而不是 fetch：本机 `HTTPS_PROXY` 指向一个**坏的**代理
 * （CONNECT 通、TLS 挂），走 fetch 会被代理吞掉。这是 serving/quantization 都踩过的坑。
 */
import { request as httpRequest } from 'node:http'
import { fail, ERROR_CODES } from '../errors.mjs'

export const PERF_SCHEMA_VERSION = '1.0.0'

export const WORKLOADS = Object.freeze({
  'chat-short': { prompt: 'Explain what a KV cache is in one short paragraph.', maxTokens: 64 },
  'chat-medium': { prompt: 'Write a 200-word explanation of how quantization reduces inference cost, covering weight-only vs activation quantization.', maxTokens: 160 },
  'decode-heavy': { prompt: 'Count from 1 to 50, one number per line.', maxTokens: 256 },
  'long-prompt': { prompt: `${'The quick brown fox jumps over the lazy dog. '.repeat(120)}Summarize the sentence above in one word.`, maxTokens: 32 },
})

export function median(xs) {
  const a = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y)
  if (a.length === 0) return null
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

export function mean(xs) {
  const a = xs.filter((x) => typeof x === 'number' && Number.isFinite(x))
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null
}

/** 样本标准差（总体口径，n 为样本数）。 */
export function std(xs) {
  const a = xs.filter((x) => typeof x === 'number' && Number.isFinite(x))
  if (a.length < 2) return null
  const m = a.reduce((s, x) => s + x, 0) / a.length
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length)
}

/**
 * **测量噪声**（相对百分比）。
 *
 * 用**均值的相对标准误**：se = std/√n，再除以均值。理由是——我们比较的是两次测量的
 * **聚合值**（中位数/均值），聚合值的波动才是"这个仪器分辨得出多小的差异"的答案；
 * 单次请求的离散度（max−min）会把仪器说得比实际更差。
 *
 * 这个数直接喂给 `checkInstrumentSelfMatch`：若声称的最小效应小于它，
 * 这个仪器**原理上**看不见该效应（跑多少次都看不见）。
 */
export function relativeStdErrPct(xs) {
  const a = xs.filter((x) => typeof x === 'number' && Number.isFinite(x))
  if (a.length < 2) return null
  const m = a.reduce((s, x) => s + x, 0) / a.length
  if (m === 0) return null
  const sd = std(a)
  if (sd === null) return null
  return ((sd / Math.sqrt(a.length)) / Math.abs(m)) * 100
}

/** 发一个流式补全请求，测 TTFT / token 数 / 总时长。 */
export function postStream(url, body, { timeoutMs = 120_000 } = {}) {
  const u = new URL(url)
  return new Promise((resolvePromise) => {
    const startedAt = Date.now()
    let firstTokenAt = null
    let tokens = 0
    let text = ''
    let buf = ''
    const req = httpRequest({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        resolvePromise({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}`, ttftMs: null, totalMs: Date.now() - startedAt, tokens: 0, text: '' })
        return
      }
      res.setEncoding('utf8')
      const finish = (err) => resolvePromise({
        ok: !err, status: res.statusCode, error: err ? String(err.message ?? err) : null,
        ttftMs: firstTokenAt === null ? null : firstTokenAt - startedAt,
        totalMs: Date.now() - startedAt, tokens, text,
      })
      res.on('data', (chunk) => {
        buf += chunk
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') { finish(null); return }
          try {
            const j = JSON.parse(data)
            const ch = j.choices?.[0]
            if (!ch) continue
            const piece = ch.text ?? ch.delta?.content ?? ''
            if (piece) {
              if (firstTokenAt === null) firstTokenAt = Date.now()
              tokens += 1
              text += piece
            }
          } catch { /* 忽略非 JSON 行 */ }
        }
      })
      res.on('end', () => finish(null))
      res.on('error', (e) => finish(e))
    })
    req.on('error', (e) => resolvePromise({ ok: false, status: null, error: String(e.message ?? e), ttftMs: null, totalMs: Date.now() - startedAt, tokens: 0, text: '' }))
    req.write(JSON.stringify(body))
    req.end()
  })
}

/** 等端点就绪（`/v1/models` 返回 200），返回就绪时刻。 */
export async function waitReady(endpointUrl, { timeoutMs = 300_000, intervalMs = 3000, headers = {} } = {}) {
  const started = Date.now()
  for (;;) {
    try {
      const r = await fetch(`${endpointUrl}/v1/models`, { headers })
      if (r.ok) return { ready: true, readyAt: Date.now(), waitedMs: Date.now() - started }
    } catch { /* 还没起来 */ }
    if (Date.now() - started > timeoutMs) return { ready: false, readyAt: null, waitedMs: Date.now() - started }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, intervalMs) })
  }
}

/**
 * 测一个端点。返回的每个统计量都带样本数，供四闸与统计出处使用。
 */
export async function measureEndpoint(endpointUrl, modelName, {
  workload = 'chat-medium', requests = 8, concurrency = 2, warmup = 1, timeoutMs = 120_000, log = null,
} = {}) {
  const spec = WORKLOADS[workload] ?? WORKLOADS['chat-medium']
  const doOne = () => postStream(`${endpointUrl}/v1/completions`, {
    model: modelName, prompt: spec.prompt, max_tokens: spec.maxTokens, temperature: 0, stream: true,
  }, { timeoutMs })

  for (let i = 0; i < warmup; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await doOne()
  }
  log?.info?.('性能测量：预热完成，开始计数', { endpointUrl, workload, requests, concurrency })

  const wallStart = Date.now()
  const results = []
  let inflight = 0
  let idx = 0
  await new Promise((resolvePromise) => {
    const pump = () => {
      if (idx >= requests && inflight === 0) { resolvePromise(); return }
      while (inflight < concurrency && idx < requests) {
        idx += 1
        inflight += 1
        doOne().then((r) => {
          results.push(r)
          inflight -= 1
          pump()
        })
      }
    }
    pump()
  })
  const wallMs = Date.now() - wallStart

  const ok = results.filter((r) => r.ok && r.tokens > 0)
  if (ok.length === 0) {
    fail(ERROR_CODES.E_TESTING_CORE_ERROR, `性能测量未得到任何成功响应：${results[0]?.error ?? 'unknown'}`, {
      remediation: '检查端点是否就绪、模型名是否匹配、max_tokens 是否过小。',
      details: { endpointUrl, modelName, firstError: results[0] ?? null },
    })
  }
  const totalTokens = ok.reduce((s, r) => s + r.tokens, 0)
  const decodeTimes = ok.map((r) => Math.max(1, r.totalMs - (r.ttftMs ?? 0)))
  const perReqDecode = ok.map((r, i) => (r.tokens / decodeTimes[i]) * 1000)
  return {
    endpointUrl,
    modelName,
    workload,
    requests: results.length,
    succeeded: ok.length,
    failed: results.length - ok.length,
    concurrency,
    wallMs,
    totalTokens,
    ttftMs: { median: median(ok.map((r) => r.ttftMs)), mean: mean(ok.map((r) => r.ttftMs)), n: ok.length },
    latencyMs: { median: median(ok.map((r) => r.totalMs)), mean: mean(ok.map((r) => r.totalMs)), n: ok.length },
    decodeTps: {
      median: median(perReqDecode),
      mean: mean(perReqDecode),
      std: std(perReqDecode),
      n: ok.length,
      /** 相对标准误（%）：喂给"仪器自洽"闸 —— 仪器看不见的效应，测多少次都看不见 */
      relativeStdErrPct: relativeStdErrPct(perReqDecode),
    },
    throughputTps: (totalTokens / wallMs) * 1000,
    /** 显式声明聚合口径（测量四闸的第一道闸） */
    aggregation: 'median',
  }
}

/** 两次端点测量 → 收益。 */
export function comparePerf(before, after) {
  const gainDecode = before.decodeTps.median > 0
    ? ((after.decodeTps.median - before.decodeTps.median) / before.decodeTps.median) * 100 : null
  const gainThroughput = before.throughputTps > 0
    ? ((after.throughputTps - before.throughputTps) / before.throughputTps) * 100 : null
  const gainTtft = before.ttftMs.median > 0
    ? ((before.ttftMs.median - after.ttftMs.median) / before.ttftMs.median) * 100 : null
  return {
    ok: true,
    metrics: {
      primary: 'decode-tps-gain-pct',
      decodeTpsGainPct: gainDecode,
      throughputGainPct: gainThroughput,
      ttftReductionPct: gainTtft,
    },
    before,
    after,
    gain: { decodeTpsPct: gainDecode, throughputPct: gainThroughput, ttftReductionPct: gainTtft },
  }
}
