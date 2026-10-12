/**
 * 风险分级 + 确认令牌。
 *
 * 基线口径沿用 `inference-serving`（`~/.ai-infra/config/risk-classification.yaml`，用户已确认）：
 *   R0 → none / R1 → process / R2 → container / R3–R5 → vm / R6 → none(拒绝)
 *   确认策略：R0 never / R1,R2 per-class-once / R3–R5 always / R6 never
 *
 * 本包**只沿袭不扩充**档位定义（Step 0 §7 的一致性声明）。调优特有的三条硬约束：
 *   ① `E_QUANT_FORMAT_FORBIDDEN` 主模型量化格式变更 —— **不是风险档，是目标函数之外的约束**
 *   ② `E_ENDPOINT_NOT_OWNED`     只动本次经 serving 建的端点
 *   ③ `E_ROLLBACK_FAILED`        就地变更回不去 → 独立风险档 + 必须叫人
 */
import { join } from 'node:path'
import { readText, atomicWriteJson, mkdirp } from './util/fsx.mjs'
import { sha256, targetFingerprint } from './util/hash.mjs'
import { fail, ERROR_CODES } from './errors.mjs'

/** 本包的操作用例表。**新增操作必须在这里登记**，否则 `classifyRisk` 会拒绝（不猜档位）。 */
export const OPERATIONS = Object.freeze({
  // R0 —— 纯只读
  'analyze': { tier: 'R0', resources: [], summary: '只读诊断：跑墙分析并给出上界/利用率/缺失观测，不执行任何实验' },
  'get_report': { tier: 'R0', resources: [], summary: '读取调优报告' },
  'list': { tier: 'R0', resources: [], summary: '列出调优注册表' },
  'metrics': { tier: 'R0', resources: [], summary: '读取本包指标' },
  'contract': { tier: 'R0', resources: [], summary: '打印 testing-core 契约声明' },
  'doctor': { tier: 'R0', resources: [], summary: '环境与能力自检' },
  'health': { tier: 'R0', resources: [], summary: '健康检查' },
  'audit_verify': { tier: 'R0', resources: [], summary: '复算审计哈希链' },
  // R1 —— 只写自有状态
  'write_state': { tier: 'R1', resources: ['state:write'], summary: '写调优注册表/报告' },
  // R2 —— 容器级：起端点、改参数、长时测量
  'tune': { tier: 'R2', resources: ['gpu:write', 'port:bind', 'disk:write', 'state:write'], summary: '就地调优：起端点、应用候选参数、多轮测量、必要时回滚' },
  'bandwidth_probe': { tier: 'R2', resources: ['gpu:write'], summary: '实测可达带宽微基准（不得用规格书峰值代替）' },
  'validate': { tier: 'R2', resources: ['gpu:write', 'model:read'], summary: '性能与精度闭环验证' },
  'rollback': { tier: 'R2', resources: ['gpu:write', 'port:bind', 'state:write'], summary: '回退到上一配置' },
  // R3 —— VM 级：本轮不纳入（本机 VM 沙箱不可用 → 一律拒绝）
  'operator_patch': { tier: 'R3', resources: ['gpu:write', 'disk:write', 'model:read'], summary: '算子级改动（本轮不纳入）' },
  // R6 —— 一律拒绝
  'quant_format_change': { tier: 'R6', resources: [], summary: '改变主模型既有量化格式（硬排除）' },
  'modify_host': { tier: 'R6', resources: [], summary: '修改宿主 OS/固件/HDK/内核（一律拒绝）' },
  'modify_other_pkg': { tier: 'R6', resources: [], summary: '修改 dsh-tuning-engine / inference-serving / inference-quantization（硬约束）' },
})

export function classifyRisk(operation) {
  const spec = OPERATIONS[operation]
  if (!spec) {
    fail(ERROR_CODES.E_CAPABILITY_DENIED, `未登记的操作：${operation}`, {
      remediation: `在 src/risk.mjs 的 OPERATIONS 里登记该操作的风险档与资源清单后再调用。`
        + `**不猜档位**是刻意的：没有登记的操作用户无法审计。`,
      details: { operation, known: Object.keys(OPERATIONS) },
    })
  }
  return spec
}

export function sandboxTierFor(runtime, tier) {
  return runtime?.policy?.risk?.sandbox?.[tier] ?? null
}

export function confirmationModeFor(runtime, tier) {
  return runtime?.policy?.risk?.confirmation?.[tier] ?? 'always'
}

// ---------------------------------------------------------------- 确认令牌

const TTL_MS = 24 * 3600 * 1000

async function loadConfirmations(runtime) {
  const raw = await readText(runtime.paths.confirmationsFile, null)
  if (!raw) return {}
  try {
    const j = JSON.parse(raw)
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

async function saveConfirmations(runtime, data) {
  await mkdirp(runtime.paths.stateDir)
  await atomicWriteJson(runtime.paths.confirmationsFile, data)
}

/**
 * 令牌 = 绑定**目标指纹**的短期凭证。
 * `per-class-once`：同一 operation 在 TTL 内确认过一次就不再问；
 * `always`：每次都要确认（R3+）。
 * R0/R6：从不询问（R0 无需确认；R6 直接拒绝，确认也没用）。
 */
export function confirmTokenFor(operation, fingerprint) {
  return `cf_${sha256(`${operation}|${fingerprint}`).slice(0, 24)}`
}

/**
 * 解析确认状态。**不抛异常给调用方做控制流**，返回结构化结果。
 * @returns {{required, granted, token, mode, tier, fingerprint, reused}}
 */
export async function resolveConfirmation(runtime, { operation, payload = {}, confirm = null, fingerprint = null }) {
  const spec = classifyRisk(operation)
  const tier = spec.tier
  const fp = fingerprint ?? targetFingerprint(operation, payload)
  const mode = confirmationModeFor(runtime, tier)

  if (tier === 'R6') {
    fail(ERROR_CODES.E_CAPABILITY_DENIED, `操作 ${operation} 属 R6，一律拒绝：${spec.summary}`, {
      remediation: '这是硬约束，不是"确认后可执行"。R6 包含：改宿主 OS/固件/HDK、改主模型量化格式、改其它包文件。',
      details: { operation, tier, summary: spec.summary },
    })
  }

  if (mode === 'never') {
    return { required: false, granted: true, token: null, mode, tier, fingerprint: fp, reused: false }
  }

  const tokens = Array.isArray(confirm) ? confirm : (confirm ? [confirm] : [])
  const now = Date.now()

  if (mode === 'per-class-once') {
    const store = await loadConfirmations(runtime)
    const key = `${operation}`
    const rec = store[key]
    if (rec && now - rec.at < TTL_MS && rec.fingerprint === fp) {
      return { required: true, granted: true, token: rec.token, mode, tier, fingerprint: fp, reused: true, grantedAt: rec.at }
    }
    const token = confirmTokenFor(operation, fp)
    if (tokens.includes(token)) {
      const next = { ...store, [key]: { token, fingerprint: fp, at: now, operation, tier } }
      await saveConfirmations(runtime, next)
      return { required: true, granted: true, token, mode, tier, fingerprint: fp, reused: false, grantedAt: now }
    }
    return { required: true, granted: false, token, mode, tier, fingerprint: fp, reused: false }
  }

  // always
  const token = confirmTokenFor(operation, fp)
  if (tokens.includes(token)) {
    return { required: true, granted: true, token, mode, tier, fingerprint: fp, reused: false, grantedAt: now }
  }
  return { required: true, granted: false, token, mode, tier, fingerprint: fp, reused: false }
}

/** 未获确认时抛出的标准错误（含令牌与"确认后会做什么"）。 */
export function requireConfirmation(resolution, { operation, summary, remediationExtra = '' }) {
  if (resolution.granted) return resolution
  const headless = false
  fail(ERROR_CODES.E_CONFIRMATION_REQUIRED, `操作需要确认：${operation}（风险档 ${resolution.tier}，策略 ${resolution.mode}）`, {
    remediation: `确认影响后，带 options.confirm = "${resolution.token}" 重新调用即可执行`
      + (resolution.mode === 'per-class-once' ? '（24h 内同类操作不再询问）。' : '（该档位每次都需确认）。')
      + remediationExtra,
    details: {
      operation, riskClass: resolution.tier, mode: resolution.mode,
      confirmToken: resolution.token, summary, targetFingerprint: resolution.fingerprint, headless,
    },
  })
}
