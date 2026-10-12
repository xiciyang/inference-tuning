/**
 * DSH 插件入口。
 *
 * 契约：`name` + `inject` + `apply(ctx)`；所有注册都经 `ctx.effect()`（可回收）。
 *
 * **命名空间纪律**：工具一律 `inference_tuning_*`，路由一律 `/__inference_tuning/*`。
 * `dsh-tuning-engine` 当前仍挂着且 live（16 个 `tuner_*`/`tuner_field_*` 工具 +
 * `/__tuner/health`），占用它的命名空间会造成重名冲突。
 * `scripts/check-manifest.mjs` 有一条自检专门断言本包不出现 `tuner_` 前缀。
 */
import { createRuntime } from './config.mjs'
import { createLogger } from './logger.mjs'
import { toErrorPayload } from './errors.mjs'
import { installSkills } from './skills.mjs'
import {
  tuneOperationApi, analyzeOperation, validateOperation, rollbackOperation,
  getReportOperation, listOperation, healthOperation, metricsOperation,
  auditVerifyOperation, contractOperation, capabilitiesOperation,
} from './api.mjs'

export const name = 'inference-tuning'
export const inject = ['tools']

/** 与 MCP 工具同名同义 —— 一套语义，多入口。 */
export const TOOL_SPECS = [
  { name: 'inference_tuning_analyze', capability: 'analyze', op: analyzeOperation },
  { name: 'inference_tuning_tune', capability: 'tune', op: tuneOperationApi },
  { name: 'inference_tuning_validate', capability: 'validate', op: validateOperation },
  { name: 'inference_tuning_rollback', capability: 'rollback', op: rollbackOperation },
  { name: 'inference_tuning_get_report', capability: 'get_report', op: getReportOperation },
  { name: 'inference_tuning_list', capability: 'list', op: listOperation },
  { name: 'inference_tuning_health', capability: 'health', op: healthOperation },
]

/**
 * 把工具返回值规整成**无损 JSON**（树，不是 DAG）。
 *
 * ## 为什么适配层必须做这件事
 *
 * DSH 的工具契约要求返回值可被无损快照；它比 `JSON.stringify` **更严**：
 * 共享引用（同一个对象被两处引用）、数组里的 `undefined`、函数、非有限数
 * 都会被判为 `value is not lossless JSON`。
 *
 * 真机事故：`inference_serving_doctor` 的输出里 `environment.container.runtimes`
 * 与 `warnings[0].details` 是**共享引用** —— 于是工具一被调用就报
 * `tool "inference_serving_doctor" returned invalid output: value is not lossless JSON`。
 *
 * 这个缺陷**此前被另一个缺陷掩盖了**：那三个包的注册当时因为缺 `output.render`
 * 全部失败，工具**根本不存在**，自然没人调用、也没人发现输出不可序列化。
 * （"装了 ≠ 生效"的又一层：**注册成功 ≠ 调用成功**。）
 *
 * 修在适配层而不是逐个 doctor：这是**契约边界**的责任 —— 任何工具的返回值
 * 都必须过这一关，新增工具自动受保护。
 */
export function toLosslessJson(value) {
  if (value === undefined) return null
  try {
    // JSON 往返同时做了三件事：DAG → 树、丢掉 undefined、拒绝真循环/函数/BigInt
    return JSON.parse(JSON.stringify(value))
  } catch (e) {
    return {
      ok: false,
      code: 'E_OUTPUT_NOT_SERIALIZABLE',
      message: `工具返回值无法序列化为无损 JSON：${String(e?.message ?? e).slice(0, 200)}`,
      remediation: '这是本包输出构造的问题（常见于循环引用或 BigInt）；请报告该工具名与入参。',
    }
  }
}

export async function apply(ctx, config = {}) {
  const runtime = await createRuntime({ root: config.root, options: config.options ?? {} })
  runtime.__log = createLogger({ runtime, stdout: false })
  runtime.warnings = runtime.warnings ?? []

  /**
   * 注册一个工具（**统一补齐 DSH 的工具契约**）。
   *
   * ## 真机事故（本包最要命的一条）
   *
   * 本包此前 12 个工具**全都没有**声明 `output`。后果不是"少个字段"，
   * 而是 DSH 的 loader **直接拒绝整个 entry**：
   *
   *   ERROR: loader.create 失败: failed to apply loader entry … (inference-tuning):
   *     tool "inference_tuning_analyze" must declare output { schema, render, presentationMeta? }
   *
   * 也就是说 —— **inference-tuning 根本无法挂进 DSH**。
   * 而这一点在单包测试（`npm test`）、集成测试（走 api.mjs 与 CLI）里**都看不见**，
   * 因为那两条路径都不经 `ctx.tools.register`。只有真的往 DSH 里装载才会暴露。
   *
   * 修法放在这里而不是逐个工具补：一处盖上全部 12 个，且新增工具自动满足契约。
   * 同时 `inference-contracts/checks/run-all.mjs` 加了 C9（用 mock ctx 跑 apply()，
   * 断言每个工具都声明了 schema + render），防止复发。
   */
  const DSH_OUTPUT = {
    schema: { type: 'object', additionalProperties: true },
    render(_args, value) {
      return [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }]
    },
  }
  const registerTool = (tool) => {
    const normalized = { ...tool, output: tool.output ?? DSH_OUTPUT, execute: async (a, e) => toLosslessJson(await tool.execute(a, e)) }
    ctx.effect(() => ctx.tools.register(normalized), `inference-tuning: register ${normalized.name}`)
  }

  registerTool({
    name: 'inference_tuning_analyze',
    description: '【只读】根因墙诊断：给出每堵墙的理论上界、实测利用率、缺失观测与推荐的 TOP1 干预。零风险。',
    parameters: {
      type: 'object',
      properties: { observations: { type: 'object' }, wall: { type: 'string' } },
    },
    async execute(args) {
      return analyzeOperation(runtime, { raw: args ?? {} })
    },
  })

  registerTool({
    name: 'inference_tuning_tune',
    description: '【R2】主闭环调优：经 serving 起端点 → 墙诊断 → TOP1 干预 → 性能与精度双闭环 → 通过则固化，否则自动回退。必须显式传阈值。',
    parameters: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        max_accuracy_drop_pct: { type: 'number' },
        min_perf_gain_pct: { type: 'number' },
        params: { type: 'object' },
        testSetPath: { type: 'string' },
        workload: { type: 'string' },
        requests: { type: 'number' },
        concurrency: { type: 'number' },
        maxRounds: { type: 'number' },
        budgetMs: { type: 'number' },
        confirm: { type: ['string', 'array'] },
      },
      required: ['model'],
    },
    async execute(args) {
      return tuneOperationApi(runtime, { raw: args ?? {} })
    },
  })

  registerTool({
    name: 'inference_tuning_validate',
    description: '【R2】对一组已有配置做一次性能 + 精度闭环测量（不搜索、不改目标）。',
    parameters: { type: 'object', properties: { model: { type: 'string' }, params: { type: 'object' }, testSetPath: { type: 'string' }, confirm: { type: ['string', 'array'] } }, required: ['model'] },
    async execute(args) { return validateOperation(runtime, { raw: args ?? {} }) },
  })

  registerTool({
    name: 'inference_tuning_rollback',
    description: '【R2】把某次调优的生效配置回退到上一个已接受版本。',
    parameters: { type: 'object', properties: { runId: { type: 'string' }, reason: { type: 'string' }, confirm: { type: ['string', 'array'] } }, required: ['runId'] },
    async execute(args) { return rollbackOperation(runtime, { raw: args ?? {} }) },
  })

  registerTool({
    name: 'inference_tuning_get_report',
    description: '【只读】读调优报告（给 runId）或列出最近 run 摘要。',
    parameters: { type: 'object', properties: { runId: { type: 'string' }, limit: { type: 'number' } } },
    async execute(args) { return getReportOperation(runtime, { raw: args ?? {} }) },
  })

  registerTool({
    name: 'inference_tuning_list',
    description: '【只读】列出调优注册表（含五要素完整性）。',
    parameters: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number' } } },
    async execute(args) { return listOperation(runtime, { raw: args ?? {} }) },
  })

  registerTool({
    name: 'inference_tuning_health',
    description: '【只读】健康检查：沙箱三级实测、serving MCP 可达性、审计链完整性、能力清单、未处理的必叫事件。',
    parameters: { type: 'object', properties: { skipContainerImage: { type: 'boolean' } } },
    async execute(args) { return healthOperation(runtime, { raw: args ?? {} }) },
  })

  // 其余只读能力也注册成工具（metrics / audit / contract / capabilities）
  registerTool({
    name: 'inference_tuning_metrics',
    description: '【只读】读取本包指标计数。',
    parameters: { type: 'object', properties: {} },
    async execute() { return metricsOperation(runtime, {}) },
  })
  registerTool({
    name: 'inference_tuning_audit_verify',
    description: '【只读】复算审计哈希链完整性。',
    parameters: { type: 'object', properties: {} },
    async execute() { return auditVerifyOperation(runtime, {}) },
  })
  registerTool({
    name: 'inference_tuning_contract',
    description: '【只读】打印精度回归契约声明（契约来源 docs/parity-contract.md）。',
    parameters: { type: 'object', properties: {} },
    async execute() { return contractOperation(runtime, {}) },
  })
  registerTool({
    name: 'inference_tuning_capabilities',
    description: '【只读】打印能力清单与"明确不做"的事。',
    parameters: { type: 'object', properties: {} },
    async execute() { return capabilitiesOperation(runtime, {}) },
  })
  registerTool({
    name: 'inference_tuning_install_skills',
    description: '把随包 SKILL.md 复制到 DSH skills 目录。',
    parameters: { type: 'object', properties: { dir: { type: 'string' } } },
    async execute(args) { return installSkills({ dir: args?.dir }) },
  })

  // 路由：/__inference_tuning/health（**不得**用 /__tuner/）
  const web = ctx.get?.('webServer') ?? ctx.webServer
  if (web && typeof web.register === 'function') {
    ctx.effect(() => web.register({
      kind: 'route',
      path: '/__inference_tuning/health',
      async handler(req, res) {
        try {
          const out = await healthOperation(runtime, { raw: { skipContainerImage: true } })
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({
            ok: true, service: 'inferenceTuning', origin: 'inference-tuning', version: '0.1.0',
            sandbox: { process: out.sandbox.process, container: out.sandbox.container, vm: out.sandbox.vm },
            servingReachable: out.serving.reachable,
            auditOk: out.audit.ok,
            mustNotify: Boolean(out.mustNotify),
          }))
        } catch (err) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(toErrorPayload(err)))
        }
      },
    }), 'inference-tuning: register /__inference_tuning/health')
  }
}

export default { name, inject, apply, TOOL_SPECS }
export { createRuntime }
