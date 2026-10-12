/**
 * inference-serving 的 MCP 客户端（stdio JSON-RPC）。
 *
 * 为什么必须有这一层：调优会**就地变更端点**。端点生命周期如果由本包自己管
 * （旧引擎就是直接 `docker run -d --name …`），就会和 serving 的注册表形成**两套所有权**，
 * 互相踩端口/显存/容器名。因此本包**只经 MCP 请求 serving**，自己不碰 docker 生命周期。
 *
 * 定位顺序（与 quantization 同构，便于同一台机器上共存）：
 *   `options.servingPath` → `~/.ai-infra/config/serving-path.txt` → 同级目录 `../inference-serving` → `node_modules/`
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { readText } from './util/fsx.mjs'
import { fail, ERROR_CODES } from './errors.mjs'

/**
 * 定位 inference-serving 的 MCP 入口。
 *
 * ## 返回形状是**契约**（见 inference-contracts/contracts/serving-client-contract.md）
 *
 * 与 `inference-quantization/src/serving-client.mjs` 的同名函数**必须同形**：
 *   `{ serverPath: <server.mjs 的绝对路径>, root: <包根目录>, from: <命中方式>, tried: [{path, from}] }`
 *
 * 曾经两份实现返回不同形状，且 `path` 一边指包根、一边指文件 —— 任何共享消费方
 * 都没法一视同仁。字段名不再有歧义：**要 spawn 的就是 serverPath**。
 */
export async function resolveServingPath(runtime) {
  const tried = []
  const candidates = []
  if (runtime?.options?.servingPath) candidates.push({ path: runtime.options.servingPath, from: 'options.servingPath' })
  const pointer = join(runtime.paths.root, 'config', 'serving-path.txt')
  const pointed = await readText(pointer, null)
  if (pointed) candidates.push({ path: pointed.trim(), from: 'config file' })
  candidates.push({ path: join(runtime.__packageRoot, '..', 'inference-serving'), from: 'sibling directory' })
  candidates.push({ path: join(process.cwd(), 'node_modules', 'inference-serving'), from: 'node_modules' })

  for (const c of candidates) {
    const serverPath = join(c.path, 'mcp', 'server.mjs')
    tried.push({ path: c.path, from: c.from })
    if (existsSync(serverPath)) return { serverPath, root: c.path, from: c.from, tried }
  }
  fail(ERROR_CODES.E_SERVING_UNAVAILABLE, '找不到 inference-serving 的 MCP server', {
    remediation: '按顺序设置其中之一：options.servingPath、'
      + `把路径写进 ${pointer}、或把 inference-serving 放在同级目录/ node_modules 下。`,
    details: { tried },
  })
}

/** 客户端接缝的统一入口解析：既接受 server.mjs 文件，也接受包根目录。 */
export function resolveServerEntry(serverPath) {
  return serverPath.endsWith('.mjs') ? serverPath : join(serverPath, 'mcp', 'server.mjs')
}

/** 极简 MCP stdio 客户端：initialize → tools/call。 */
export class ServingMcpClient {
  constructor({ serverPath, env = process.env, timeoutMs = 300_000 }) {
    this.serverPath = serverPath
    this.env = env
    this.timeoutMs = timeoutMs
    this.child = null
    this.seq = 0
    this.pending = new Map()
    this.buf = ''
  }

  async start() {
    this.child = spawn(process.execPath, [resolveServerEntry(this.serverPath)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...this.env },
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (d) => this._onData(d))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', () => { /* serving 的诊断输出，忽略但不阻塞 */ })
    this.child.on('exit', (code) => {
      for (const [, p] of this.pending) p.reject(new Error(`serving MCP 进程退出（code=${code}）`))
      this.pending.clear()
    })
    await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'inference-tuning', version: '0.1.0' },
    })
    this._notify('notifications/initialized', {})
    return this
  }

  _onData(chunk) {
    this.buf += chunk
    let i
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      const p = this.pending.get(msg.id)
      if (!p) continue
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(`MCP error: ${JSON.stringify(msg.error).slice(0, 400)}`))
      else p.resolve(msg.result)
    }
  }

  _send(obj) {
    this.child.stdin.write(`${JSON.stringify(obj)}\n`)
  }

  _notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params })
  }

  /**
   * 公开的协议方法（契约要求与 quantization 的实现同形）。
   * `_request` / `_notify` 保留为内部别名，避免改动既有调用点。
   */
  request(method, params) { return this._request(method, params) }

  notify(method, params) { return this._notify(method, params) }

  _request(method, params, timeoutMs = this.timeoutMs) {
    this.seq += 1
    const id = this.seq
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP 调用超时（${method}，${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolvePromise, reject, timer })
      this._send({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** 调一个 tool，返回 `{isError, value, raw}`。 */
  async callTool(name, args) {
    const r = await this._request('tools/call', { name, arguments: args ?? {} })
    const text = (r?.content ?? []).map((c) => c.text ?? '').join('')
    let value = null
    try { value = JSON.parse(text) } catch { value = { raw: text } }
    // 契约：`raw` 一律是**文本**（两份实现同形），完整 MCP 响应放在 `response`
    return { isError: r?.isError === true, value, raw: text, response: r }
  }

  /** 列出对端工具（契约要求与 quantization 的实现同形）。 */
  async listTools() {
    const res = await this._request('tools/list', {})
    return res?.tools ?? []
  }

  async close() {
    if (!this.child) return
    try { this.child.stdin.end() } catch { /* 已关 */ }
    try { this.child.kill('SIGTERM') } catch { /* 已退 */ }
    this.child = null
  }
}

/** 开一个客户端，跑 fn，然后一定关掉。 */
export async function withServing(runtime, fn, { timeoutMs = 600_000 } = {}) {
  const found = await resolveServingPath(runtime)
  const client = new ServingMcpClient({ serverPath: found.serverPath, env: runtime.env, timeoutMs })
  await client.start()
  try {
    return await fn(client, found)
  } finally {
    await client.close()
  }
}

/**
 * 令牌累积重放 —— 复刻 serving 的确认流程契约。
 *
 * serving 有两道门（R2 风险确认 + license 确认），各自的令牌不同，
 * 且要用**同一个 `details.confirmToken` 字段**回传。这里统一累积，
 * 避免每个调用点各写一遍（少写一处就会出现"传了令牌还被再问一次"的鬼打墙）。
 */
export async function callWithConfirm(client, name, args, { maxRounds = 6, log = null } = {}) {
  const tokens = Array.isArray(args.confirm) ? [...args.confirm] : (args.confirm ? [args.confirm] : [])
  let last = null
  for (let round = 0; round < maxRounds; round += 1) {
    // eslint-disable-next-line no-await-in-loop
    const out = await client.callTool(name, { ...args, confirm: tokens })
    last = out
    if (!out.isError && out.value?.ok !== false) return out
    const token = out.value?.details?.confirmToken
    if (!token || tokens.includes(token)) return out
    log?.info?.(`serving 要求确认：${out.value?.code}`, { tool: name, token })
    tokens.push(token)
  }
  return last
}

export { spawn }
