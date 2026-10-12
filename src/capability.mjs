/**
 * 能力清单（capabilities）+ 明确不提供的能力（not_provided）。
 *
 * 为什么要显式列 `not_provided`：能力清单的用途不只是"我有什么"，
 * 更是"**别指望我做什么**"。缺哪个能力不写出来，调用方就会假设它在。
 */

export const CAPABILITIES = Object.freeze({
  analyze: {
    tier: 'R0',
    resources: [],
    description: '只读墙诊断：跑根因墙分析，给出每堵墙的理论上界、当前利用率、缺失的观测项',
  },
  tune: {
    tier: 'R2',
    resources: ['gpu:write', 'port:bind', 'disk:write', 'state:write'],
    description: '主闭环：起调优端点 → 墙诊断 → TOP1 干预 → 性能与精度双闭环验证 → 通过则固化配置，否则自动回退',
  },
  validate: {
    tier: 'R2',
    resources: ['gpu:write', 'model:read'],
    description: '对一组已有配置做性能 + 精度闭环验证（不改变目标，只验证）',
  },
  rollback: {
    tier: 'R2',
    resources: ['gpu:write', 'port:bind', 'state:write'],
    description: '回退到上一份已固化的配置',
  },
  get_report: { tier: 'R0', resources: [], description: '读取调优报告' },
  list: { tier: 'R0', resources: [], description: '列出调优注册表（含五要素完整性）' },
  health: { tier: 'R0', resources: [], description: '健康检查（含 serving MCP 可达性与沙箱分级）' },
  metrics: { tier: 'R0', resources: [ 'state:read' ], description: '读取本包指标' },
  audit_verify: { tier: 'R0', resources: ['state:read'], description: '复算审计哈希链完整性' },
  contract: { tier: 'R0', resources: [], description: '打印精度回归契约声明（契约来源 docs/parity-contract.md）' },
  capabilities: { tier: 'R0', resources: [], description: '打印能力清单与"明确不做"的事' },
  install_skills: { tier: 'R1', resources: ['disk:write'], description: '把随包 SKILL.md 复制到 DSH skills 目录' },
})

export const NOT_PROVIDED = Object.freeze({
  quantize: '不做量化 —— 那是 inference-quantization 的职责；本包只通过 MCP 请求它',
  quant_format_change: '**硬排除**：不改变主模型既有的量化格式（含 linear_attn FP8→NVFP4 这类"改格式优化"）',
  operator_patch: '本轮不纳入算子级改动（属 R3，本机 VM 沙箱不可用；需显式授权才可开启）',
  deploy_generic: '不自己做通用部署 —— 端点生命周期一律交给 inference-serving（避免两套所有权互相踩）',
  own_endpoints_only: '只操作本次运行经 serving 建出来的端点；存量端点一律只读，不重启、不改参数',
  wiki: '不含 Wiki 读写（Step 0 裁决 Q2：移出核心）',
  field_mode: '不含现场模式（Step 0 裁决 Q1：整体舍弃 —— 有了 serving MCP，"让用户代跑命令"这个前提消失）',
  training: '不做训练/QAT —— 那是训练侧的职责',
  orchestration: '不做推理编排（留待训练侧就位后的 RSI 阶段）',
})

/** 能力是否被本包声明（供 API 闸门使用）。 */
export function hasCapability(name) {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, name)
}

/** 不存在的能力要给出"该找谁"的可操作指引。 */
export function capabilityRedirect(name) {
  if (name === 'quantize' || name === 'qat') return '改用 inference_quantization_* MCP 工具'
  if (name === 'deploy' || name === 'teardown' || name === 'endpoint') return '改用 inference_serving_* MCP 工具'
  return null
}

export function describeCapabilities() {
  return {
    provided: Object.entries(CAPABILITIES).map(([name, v]) => ({ name, ...v })),
    notProvided: Object.entries(NOT_PROVIDED).map(([name, reason]) => ({ name, reason })),
  }
}
