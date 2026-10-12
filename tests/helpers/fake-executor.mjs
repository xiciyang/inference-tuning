/**
 * 测试用执行器：**起真本地端点、走真网络路径**，只是不碰 GPU 与 serving MCP。
 *
 * 它不做假：
 *   · deploy 真的起一个本地 HTTP 服务，真的监听端口
 *   · measure 走真的 `measureEndpoint`（真 SSE 流、真计时）
 *   · 精度测量真的走 `parityCheck` 的 endpoint-logprobs 路径
 *   · 端点性能**由参数决定**（提高并发 → 吞吐上升），于是闭环能真的做出接受/回退决定
 *
 * `knobs` 精确控制每一步的成败，从而确定性地驱动接受 / 回退 / 测量不成立 / 回滚失败四条路径。
 */
import { createServer } from 'node:http'
import { registerExecutor } from '../../src/executors/index.mjs'

export const knobs = {
  /** 基线吞吐的截距与斜率：tps = base + slope * 并发 */
  base: 40,
  slope: 1.5,
  /**
   * 每提高一档并发，精度退化多少 nats（用来驱动精度门禁）。
   * 注意符号：logprob 越**负** = 越差。所以退化是 `logprobBase - drop*step`，
   * 而不是 `+`（本夹具第一次写反了，导致"精度退化"用例里候选反而更好、门禁正确地放行了）。
   */
  accuracyDropPerStep: 0.0,
  /** 端点逐条 logprob 的方差（置 0 会触发 no-item-variance） */
  jitter: 0.4,
  /** 置真 → 端点返回常量 logprob（测量不成立） */
  constantLogprobs: false,
  /** 置真 → teardown 失败（驱动"回滚失败 → 必须叫人"） */
  failTeardown: false,
  /** 置真 → 部署即不健康 */
  unhealthy: false,
  calls: [],
  servers: new Map(),
  /** 每人模型一个端点：`modelPath -> {id, revisions: [{params, port, server}], current}` */
  endpoints: new Map(),
  /** 置真 → rollback 失败（驱动"回滚失败 → 必须叫人"） */
  failRollback: false,
}

export function resetKnobs() {
  knobs.base = 40
  knobs.slope = 1.5
  knobs.accuracyDropPerStep = 0.0
  knobs.jitter = 0.4
  knobs.constantLogprobs = false
  knobs.failTeardown = false
  knobs.unhealthy = false
  knobs.calls = []
  for (const [, s] of knobs.servers) s.close()
  knobs.servers.clear()
  knobs.endpoints.clear()
  knobs.failRollback = false
}

function makeEndpointServer({ tps, logprobBase, jitter, healthy }) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let payload = {}
      try { payload = JSON.parse(body) } catch { /* ignore */ }
      if (req.url?.startsWith('/v1/models')) {
        if (!healthy) { res.writeHead(503); res.end('unhealthy'); return }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: payload.model ?? 'm' }] }))
        return
      }
      if (payload.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const tokens = Math.max(6, Math.round(tps / 2))
        setTimeout(() => {
          res.write(`data: ${JSON.stringify({ choices: [{ text: 'x ' }] })}\n\n`)
          let n = 0
          const tick = setInterval(() => {
            n += 1
            res.write(`data: ${JSON.stringify({ choices: [{ text: `t${n} ` }] })}\n\n`)
            if (n >= tokens) { clearInterval(tick); res.write('data: [DONE]\n\n'); res.end() }
          }, Math.max(1, Math.round(1000 / Math.max(1, tps))))
        }, 3)
        return
      }
      const prompt = String(payload.prompt ?? '')
      let h = 2166136261
      for (let i = 0; i < prompt.length; i += 1) { h ^= prompt.charCodeAt(i); h = Math.imul(h, 16777619) }
      const off = jitter === 0 ? 0 : 0.4 * (((h >>> 0) % 10000) / 10000 - 0.5) * 2
      const n = Math.max(8, Math.min(64, Math.ceil(prompt.length / 6)))
      const tl = [null]
      for (let i = 1; i < n; i += 1) {
        tl.push(Number((logprobBase + off + jitter * (Math.sin(i * 1.7) + 0.06 * Math.cos(i * 0.3))).toFixed(6)))
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ text: prompt, logprobs: { tokens: [], token_logprobs: tl, top_logprobs: [] } }] }))
    })
  })
  return server
}

export const fakeExecutor = {
  id: 'fake',
  displayName: '进程内假执行器（真本地端点 + 真网络路径，测试用）',

  async probeEngineFlags(runtime, { flags = [] } = {}) {
    knobs.calls.push({ op: 'probeEngineFlags', flags })
    return { supported: new Set(flags), probed: true, missing: [], image: 'fake-engine:1' }
  },

  async bandwidthProbe() {
    knobs.calls.push({ op: 'bandwidthProbe' })
    // 一个"实测"值（不是规格书峰值）
    return { ok: true, readGBps: 231.4, bestReadGBps: 238.7, copyGBps: 198.2, device: 'fake-gpu', method: 'read/copy microbenchmark' }
  },

  async deploy(runtime, { modelPath, params = {}, servedModelName, port = null, log = null } = {}) {
    const capacity = Number(params.concurrency_capacity ?? params.max_num_seqs ?? 32)
    const tps = knobs.base + knobs.slope * capacity
    const logprobBase = -2.7 - knobs.accuracyDropPerStep * Math.log2(Math.max(1, capacity / 32))
    const server = makeEndpointServer({
      tps, logprobBase,
      jitter: knobs.constantLogprobs ? 0 : knobs.jitter,
      healthy: !knobs.unhealthy,
    })
    await new Promise((r) => server.listen(port ?? 0, '127.0.0.1', r))
    const actualPort = server.address().port
    // **同模型 → 同一端点 id**（复刻 serving 的 revision 语义：换参数是同一端点的新 revision）
    const rec = knobs.endpoints.get(modelPath) ?? { id: `ep_fake_${modelPath.split('/').pop()}`, revisions: [], current: null }
    const id = rec.id
    // **部署会取代当前 revision 的容器**（serving 就是这么做的：同一个端点，新 revision 起、
    // 旧的被取代）。夹具必须同样关掉旧服务 —— 否则旧的 HTTP server 会一直挂着，
    // 把测试进程的事件循环拖住（表现为"Promise resolution is still pending"）。
    if (rec.current !== null) {
      const prev = rec.revisions.find((r) => r.rev === rec.current)
      if (prev?.server) { await new Promise((r) => prev.server.close(r)) }
    }
    const rev = rec.revisions.length + 1
    rec.revisions.push({ rev, params, port: actualPort, server, tps, logprobBase })
    rec.current = rev
    knobs.endpoints.set(modelPath, rec)
    knobs.servers.set(id, server)
    knobs.calls.push({ op: 'deploy', id, rev, params, tps, logprobBase })
    log?.info?.('fake: 已起端点', { id, port: actualPort, tps })
    return {
      id,
      endpoint: `http://127.0.0.1:${actualPort}`,
      port: actualPort,
      // 与真执行器同形：真执行器会从运行中的容器反查镜像并带上 containerName，
      // 夹具也必须带，否则闭环里"限定条件/可重放性"这些判据在测试中就永远是空的
      containerName: `fake-container-${actualPort}`,
      revision: rec.revisions.length,
      image: 'fake-engine:1',
      imageId: 'sha256:' + 'f'.repeat(64),
      servedModelName: servedModelName ?? 'm',
      applied: params,
      skipped: [],
      reused: false,
      ownedByThisRun: true,
    }
  },

  /** 回退：关掉当前 revision 的服务，重启上一个 revision 的服务（与 serving 的 rollback 同义）。 */
  async rollback(runtime, { selector, log = null } = {}) {
    knobs.calls.push({ op: 'rollback', selector })
    if (knobs.failRollback) {
      return { ok: false, code: 'E_NO_ROLLBACK_TARGET', message: '注入失败：回退失败', endpoint: null, toRevision: null }
    }
    const rec = [...knobs.endpoints.values()].find((r) => r.id === selector)
    if (!rec || rec.revisions.length < 2) {
      return { ok: false, code: 'E_NO_ROLLBACK_TARGET', message: '没有可回退的历史 revision', endpoint: null, toRevision: null }
    }
    const cur = rec.revisions.find((r) => r.rev === rec.current)
    if (cur) { await new Promise((r) => cur.server.close(r)) }
    const target = rec.revisions[rec.revisions.length - 2]
    // 用目标 revision 的配置**重新起服务**（serving 的 rollback 就是重新部署）
    const server = makeEndpointServer({
      tps: target.tps,
      logprobBase: target.logprobBase,
      jitter: knobs.constantLogprobs ? 0 : knobs.jitter,
      healthy: !knobs.unhealthy,
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    rec.revisions.push({ rev: rec.revisions.length + 1, params: target.params, port, server, tps: target.tps, logprobBase: target.logprobBase, rolledBackTo: target.rev })
    rec.current = rec.revisions.length
    knobs.servers.set(rec.id, server)
    log?.info?.('fake: 已回退', { selector, to: target.rev })
    return { ok: true, code: null, endpoint: { id: rec.id, endpoint: `http://127.0.0.1:${port}`, port }, toRevision: target.rev }
  },

  async ready(runtime, { endpoint, timeoutMs = 30_000 } = {}) {
    const { waitReady } = await import('../../src/testing/perf.mjs')
    return waitReady(endpoint, { timeoutMs: Math.min(timeoutMs, 10_000), intervalMs: 20 })
  },

  async teardown(runtime, { id, log = null } = {}) {
    knobs.calls.push({ op: 'teardown', id })
    if (knobs.failTeardown) {
      return { ok: false, code: 'E_CLEANUP_INCOMPLETE', residual: [{ name: 'no-managed-residual', ok: false }], verification: null }
    }
    const s = knobs.servers.get(id)
    if (s) {
      await new Promise((r) => s.close(r))
      knobs.servers.delete(id)
    }
    log?.info?.('fake: 端点已拆', { id })
    return { ok: true, code: null, residual: [], verification: { clean: true, checks: [{ name: 'no-managed-residual', ok: true }] } }
  },

  async measure(runtime, spec) {
    const { measureEndpoint } = await import('../../src/testing/perf.mjs')
    knobs.calls.push({ op: 'measure', endpoint: spec.endpoint })
    return measureEndpoint(spec.endpoint, spec.model, {
      workload: spec.workload ?? 'chat-medium',
      requests: spec.requests ?? 4,
      concurrency: spec.concurrency ?? 2,
      timeoutMs: 30_000,
    })
  },
}

registerExecutor(fakeExecutor)
export default fakeExecutor
