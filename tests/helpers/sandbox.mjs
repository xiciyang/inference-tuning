/**
 * 测试脚手架：隔离的共享状态根 + 真格式的模型夹具。
 *
 * **夹具必须真实**（用户固化的通用原则 #2）：
 *   夹具若喂常量/退化数据，测试就在替 bug 背书。
 *   quantization 的假执行器曾喂常量逐条 NLL，90 个用例全绿却掩盖了退化测量。
 *   因此这里：
 *     · 模型夹具是**真 safetensors 格式**（预检模块会真的去解析它）
 *     · 端点夹具是**真本地 HTTP 服务**（perf/parity 走的是真实网络路径）
 *     · 逐条指标**必须有方差**（"与输入无关"的测量正是门禁要拦的东西）
 */
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

// ---------------------------------------------------------------- safetensors

const DTYPE_SIZE = { F32: 4, F16: 2, BF16: 2, I8: 1, U8: 1, I32: 4, I64: 8 }
const PATTERN = [0x00, 0x00, 0x80, 0x3f] // 小端 f32 = 1.0，非零且有限

export function safetensorsBuffer(tensors, { zero = [] } = {}) {
  const header = {}
  const chunks = []
  let offset = 0
  for (const t of tensors) {
    const dtype = t.dtype ?? 'F32'
    const n = t.shape.reduce((a, b) => a * b, 1)
    const size = n * (DTYPE_SIZE[dtype] ?? 1)
    const buf = Buffer.alloc(size)
    if (!zero.includes(t.name)) for (let i = 0; i < size; i++) buf[i] = PATTERN[i % PATTERN.length]
    header[t.name] = { dtype, shape: t.shape, data_offsets: [offset, offset + size] }
    offset += size
    chunks.push(buf)
  }
  const hjson = Buffer.from(JSON.stringify(header), 'utf8')
  const len = Buffer.alloc(8)
  len.writeBigUInt64LE(BigInt(hjson.length))
  return Buffer.concat([len, hjson, ...chunks])
}

export function minimalModelTensors({ layers = 2, hidden = 64, vocab = 128 } = {}) {
  const out = [
    { name: 'model.embed_tokens.weight', shape: [vocab, hidden] },
    { name: 'model.norm.weight', shape: [hidden] },
  ]
  for (let i = 0; i < layers; i++) {
    out.push({ name: `model.layers.${i}.self_attn.q_proj.weight`, shape: [hidden, hidden] })
    out.push({ name: `model.layers.${i}.mlp.down_proj.weight`, shape: [hidden * 2, hidden] })
  }
  return out
}

// ---------------------------------------------------------------- 沙箱

export async function makeSandbox({ modelName = 'test-model', vocabSize = 128 } = {}) {
  const base = await fs.mkdtemp(join(tmpdir(), 'it-test-'))
  const root = join(base, 'ai-infra')
  const modelRoot = join(base, 'models')
  const modelPath = join(modelRoot, modelName)
  await fs.mkdir(modelPath, { recursive: true })
  await fs.writeFile(join(modelPath, 'config.json'), JSON.stringify({
    architectures: ['LlamaForCausalLM'], model_type: 'llama',
    num_hidden_layers: 2, hidden_size: 64, vocab_size: vocabSize, torch_dtype: 'bfloat16',
  }))
  await fs.writeFile(join(modelPath, 'model.safetensors'), safetensorsBuffer(minimalModelTensors()))
  await fs.writeFile(join(modelPath, 'LICENSE'), 'Apache License 2.0\n')

  const portStart = 19_000 + Math.floor(Math.random() * 400) * 20
  return {
    base, root, modelRoot, modelPath, modelName, vocabSize,
    options: { modelRoots: [modelRoot], bindHost: '127.0.0.1', portPoolStart: portStart, portPoolEnd: portStart + 19 },
    async cleanup() { await fs.rm(base, { recursive: true, force: true }) },
    async readRegistryText() { return fs.readFile(join(root, 'state', 'tuning-registry.yaml'), 'utf8').catch(() => null) },
    async makeTestSet(n = 24) {
      const dir = join(root, 'state', 'datasets', 'test-ds')
      await fs.mkdir(dir, { recursive: true })
      const { createHash } = await import('node:crypto')
      const lines = []
      for (let i = 0; i < n; i += 1) {
        const text = `Wikitext sample ${i}: the quick brown fox jumps over the lazy dog `.repeat(3 + (i % 4))
        lines.push(JSON.stringify({ h: createHash('sha256').update(text).digest('hex'), t: text }))
      }
      const p = join(dir, 'test.jsonl')
      await fs.writeFile(p, `${lines.join('\n')}\n`)
      return p
    },
  }
}

// ---------------------------------------------------------------- 真端点夹具

/**
 * 起一个**真的本地 HTTP 服务**扮演推理端点。
 *
 * 不桩 fetch / 不桩 node:http —— perf 与 parity 走的是真实网络路径，
 * 桩掉就测不到"测量代码本身有没有写错"。
 *
 * @param {{tps?: number, ttftMs?: number, logprobBase?: number, tokenCount?: number}} spec
 *   `logprobBase` 控制精度测量的 meanNll 量级；`tps` 控制吞吐。
 */
export async function withFakeEndpoint(spec, fn) {
  const cfg = {
    tps: 60, ttftMs: 5, logprobBase: -2.2, tokenCount: 24,
    vocabSize: 128, jitter: 0.35,
    // 逐条偏移：**必须依赖输入**。真模型在不同文档上的 loss 不可能逐位相同；
    // 若夹具给常量，它自己就成了"与输入无关"的退化测量（本文件第一次就这么写的，
    // 结果被 parity 的极差判定当场抓住 —— 这正是夹具必须真实的原因）。
    promptSpread: 0.45, ...spec,
  }
  const state = { requests: 0, completions: 0 }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let payload = {}
      try { payload = JSON.parse(body) } catch { /* 忽略 */ }
      if (req.url?.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: payload.model ?? 'test', object: 'model' }] }))
        return
      }
      if (payload.stream) {
        state.requests += 1
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const tokens = Math.max(4, Math.round(cfg.tps / 6))
        setTimeout(() => {
          res.write(`data: ${JSON.stringify({ choices: [{ text: 'tok ' }] })}\n\n`)
          let n = 0
          const tick = setInterval(() => {
            n += 1
            res.write(`data: ${JSON.stringify({ choices: [{ text: `t${n} ` }] })}\n\n`)
            if (n >= tokens) { clearInterval(tick); res.write('data: [DONE]\n\n'); res.end() }
          }, Math.max(1, Math.round(1000 / cfg.tps)))
        }, cfg.ttftMs)
        return
      }
      // 精度测量路径：echo + logprobs
      state.completions += 1
      const prompt = String(payload.prompt ?? '')
      const approxTokens = Math.max(8, Math.min(cfg.tokenCount, Math.ceil(prompt.length / 4)))
      // 由 prompt 内容导出的确定性偏移（不同条 → 不同值；同一条 → 可复现）
      let h = 2166136261
      for (let i = 0; i < prompt.length; i += 1) { h ^= prompt.charCodeAt(i); h = Math.imul(h, 16777619) }
      const promptOffset = cfg.promptSpread * (((h >>> 0) % 10000) / 10000 - 0.5) * 2
      const tl = [null]
      for (let i = 1; i < approxTokens; i += 1) {
        // **必须有方差**：真实模型在不同 token 上的 logprob 不可能逐位相同
        const v = cfg.logprobBase + promptOffset + cfg.jitter * (Math.sin(i * 1.7) + 0.06 * Math.cos(i * 0.3))
        tl.push(Number(v.toFixed(6)))
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ text: prompt, logprobs: { tokens: [], token_logprobs: tl, top_logprobs: [] } }],
      }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const endpoint = `http://127.0.0.1:${port}`
  try {
    return await fn({ endpoint, port, state, cfg })
  } finally {
    await new Promise((r) => server.close(r))
  }
}

export function uniqueName(prefix = 'x') { return `${prefix}-${randomBytes(4).toString('hex')}` }
export { fs, join, tmpdir }
