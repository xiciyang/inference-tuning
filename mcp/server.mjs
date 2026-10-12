#!/usr/bin/env node
/**
 * MCP server（stdio + 可选 streamable-http）。
 *
 * 工具命名空间：`inference_tuning_*`（7 个）。
 * **不得占用 `tuner_*`** —— `dsh-tuning-engine` 当前仍然挂着且 live，
 * 占用它的命名空间会造成工具重名。`scripts/check-manifest.mjs` 有一条自检专门断言这一点。
 */
import { createInterface } from 'node:readline'
import { createRuntime } from '../src/config.mjs'
import {
  tuneOperationApi, analyzeOperation, validateOperation, rollbackOperation,
  getReportOperation, listOperation, healthOperation,
} from '../src/api.mjs'
import { toErrorPayload } from '../src/errors.mjs'
import { createLogger } from '../src/logger.mjs'

export const MCP_PROTOCOL_VERSION = '2024-11-05'
export const MCP_INTERFACE_VERSION = '1.0.0'

/** 七个工具的声明。schema 与 CLI/API 共享同一份语义。 */
export const TOOL_DEFS = [
  {
    name: 'inference_tuning_analyze',
    description: '【只读】根因墙诊断：给出每堵墙的理论上界、实测利用率、缺失的观测项，以及推荐的 TOP1 干预。零风险，不执行任何实验。',
    inputSchema: {
      type: 'object',
      properties: {
        observations: { type: 'object', description: '观测上下文（hardware/model/measurements/limits/provenance）' },
        wall: { type: 'string', description: '强制指定根因墙（默认自动排序）' },
      },
    },
    op: analyzeOperation,
  },
  {
    name: 'inference_tuning_tune',
    description: '【R2】主闭环：经 serving 起调优端点 → 墙诊断 → TOP1 干预 → 性能与精度双闭环验证 → 通过则固化配置，否则自动回退。**必须显式传阈值**。',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: '模型路径或在 modelRoots 下的目录名' },
        max_accuracy_drop_pct: { type: 'number', description: '允许的最大精度损失（困惑度相对退化 %）。必填或写进 gates.yaml' },
        min_perf_gain_pct: { type: 'number', description: '要求的最小解码吞吐提升（%）。必填或写进 gates.yaml' },
        params: { type: 'object', description: '起始参数集（语义名，如 max_num_seqs）' },
        testSetPath: { type: 'string', description: '精度评测集（jsonl，每行 {"h","t"}）' },
        workload: { type: 'string', description: '负载形状（chat-short/chat-medium/decode-heavy/long-prompt）' },
        requests: { type: 'number' }, concurrency: { type: 'number' },
        maxRounds: { type: 'number' }, budgetMs: { type: 'number' },
        confirm: { type: ['string', 'array'], description: '确认令牌（首次调用会在错误里给出）' },
      },
      required: ['model'],
    },
    op: tuneOperationApi,
  },
  {
    name: 'inference_tuning_validate',
    description: '【R2】对一组已有配置做一次性能 + 精度闭环测量（不搜索、不改目标）。测完自动拆解端点。',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' }, params: { type: 'object' }, testSetPath: { type: 'string' },
        workload: { type: 'string' }, requests: { type: 'number' }, concurrency: { type: 'number' },
        confirm: { type: ['string', 'array'] },
      },
      required: ['model'],
    },
    op: validateOperation,
  },
  {
    name: 'inference_tuning_rollback',
    description: '【R2】把某次调优的生效配置回退到上一个已接受版本。',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' }, reason: { type: 'string' }, confirm: { type: ['string', 'array'] } },
      required: ['runId'],
    },
    op: rollbackOperation,
  },
  {
    name: 'inference_tuning_get_report',
    description: '【只读】按 runId 读调优报告；不给 runId 则列出最近的 run 摘要。',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' }, limit: { type: 'number' } } },
    op: getReportOperation,
  },
  {
    name: 'inference_tuning_list',
    description: '【只读】列出调优注册表（含五要素完整性与缺失字段）。',
    inputSchema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number' } } },
    op: listOperation,
  },
  {
    name: 'inference_tuning_health',
    description: '【只读】健康检查：沙箱三级实测、serving MCP 可达性、审计链完整性、能力清单、是否有未处理的"必须叫人"事件。',
    inputSchema: { type: 'object', properties: { skipContainerImage: { type: 'boolean' } } },
    op: healthOperation,
  },
]

export function createMcpServer({ runtime }) {
  const rl = createInterface({ input: process.stdin })
  const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)

  rl.on('line', async (line) => {
    const t = line.trim()
    if (!t) return
    let msg
    try { msg = JSON.parse(t) } catch { return }
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'inference-tuning', version: MCP_INTERFACE_VERSION } } })
      return
    }
    if (msg.method === 'notifications/initialized') return
    if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOL_DEFS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } })
      return
    }
    if (msg.method === 'tools/call') {
      const def = TOOL_DEFS.find((d) => d.name === msg.params?.name)
      if (!def) {
        send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'E_UNKNOWN_TOOL', message: `未知工具 ${msg.params?.name}` }) }] } })
        return
      }
      const args = msg.params?.arguments ?? {}
      try {
        const out = await def.op(runtime, { raw: args, ...args })
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } })
      } catch (err) {
        send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify(toErrorPayload(err)) }] } })
      }
      return
    }
    if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `未实现的方法：${msg.method}` } })
  })
}

/** 直接以 MCP server 运行时（stdio）。 */
export async function runMcpServer({ root = undefined, options = {} } = {}) {
  const runtime = await createRuntime({ root, options })
  runtime.__log = createLogger({ runtime, stdout: false })
  createMcpServer({ runtime })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMcpServer().catch((err) => {
    process.stderr.write(`${JSON.stringify(toErrorPayload(err))}\n`)
    process.exit(1)
  })
}
