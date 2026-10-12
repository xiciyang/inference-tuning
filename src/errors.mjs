/**
 * 稳定错误码表 + 结构化错误类型。
 *
 * 与 inference-serving / inference-quantization 同构：
 *   每个错误码都必须带 `remediation` —— 不是"出了错"，而是"出了什么错、怎么修"。
 *   错误码是接口的一部分：一旦发布即冻结，破坏性变更升 MCP major。
 *
 * 本包新增的四类错误码，各自对应一条**独有的风险**（见 docs/step0/RISK_CLASSIFICATION_DELTA.md）：
 *   E_QUANT_FORMAT_FORBIDDEN  硬排除主模型量化格式变更 —— 不是优先级，是目标函数之外的约束
 *   E_ENDPOINT_NOT_OWNED      只动本次经 serving 建的端点，不碰存量
 *   E_MEASUREMENT_INVALID     测量不成立（性能四闸 / 精度三闸任一不过）
 *   E_ROLLBACK_FAILED         **唯一一个"必须叫人"的失败模式**（就地变更回不去）
 */

export const ERROR_CODES = Object.freeze({
  // --- 输入处理（7 类输入场景）---
  E_INPUT_INVALID: 'E_INPUT_INVALID',
  E_INPUT_CONFLICT: 'E_INPUT_CONFLICT',
  E_INPUT_AMBIGUOUS: 'E_INPUT_AMBIGUOUS',
  E_INPUT_MISSING: 'E_INPUT_MISSING',
  E_MODEL_UNRESOLVED: 'E_MODEL_UNRESOLVED',
  E_LICENSE_UNRESOLVED: 'E_LICENSE_UNRESOLVED',
  E_NO_TUNING_TARGET: 'E_NO_TUNING_TARGET',

  // --- 权限与能力清单 ---
  E_CAPABILITY_DENIED: 'E_CAPABILITY_DENIED',
  E_RESOURCE_NOT_DECLARED: 'E_RESOURCE_NOT_DECLARED',

  // --- 沙箱 ---
  E_SANDBOX_UNAVAILABLE: 'E_SANDBOX_UNAVAILABLE',
  E_SANDBOX_PROBE_FAILED: 'E_SANDBOX_PROBE_FAILED',
  E_HOST_SANDBOX_MISMATCH: 'E_HOST_SANDBOX_MISMATCH',

  // --- 确认与交互 ---
  E_CONFIRMATION_REQUIRED: 'E_CONFIRMATION_REQUIRED',
  E_HEADLESS_NEEDS_CONFIRMATION: 'E_HEADLESS_NEEDS_CONFIRMATION',

  // --- 网络出口 ---
  E_EGRESS_DENIED: 'E_EGRESS_DENIED',

  // --- 门禁阈值（用户裁决：不得猜默认值）---
  E_THRESHOLD_NOT_PROVIDED: 'E_THRESHOLD_NOT_PROVIDED',

  // --- 目标函数之外的硬约束（不参与降级/调参）---
  E_QUANT_FORMAT_FORBIDDEN: 'E_QUANT_FORMAT_FORBIDDEN',
  E_ENDPOINT_NOT_OWNED: 'E_ENDPOINT_NOT_OWNED',

  // --- 源模型完整性 ---
  E_SOURCE_MODEL_UNREADABLE: 'E_SOURCE_MODEL_UNREADABLE',
  E_SOURCE_MODEL_INVALID: 'E_SOURCE_MODEL_INVALID',
  E_SOURCE_MODEL_MODIFIED: 'E_SOURCE_MODEL_MODIFIED',

  // --- 测量与门禁 ---
  E_MEASUREMENT_INVALID: 'E_MEASUREMENT_INVALID',
  E_PERF_GATE_FAILED: 'E_PERF_GATE_FAILED',
  E_ACCURACY_GATE_FAILED: 'E_ACCURACY_GATE_FAILED',
  E_NO_IMPROVEMENT: 'E_NO_IMPROVEMENT',
  E_PHYSICAL_LIMIT_REACHED: 'E_PHYSICAL_LIMIT_REACHED',

  // --- 部署与协作 ---
  E_SERVING_UNAVAILABLE: 'E_SERVING_UNAVAILABLE',
  E_DEPLOY_FAILED: 'E_DEPLOY_FAILED',
  E_ENDPOINT_UNHEALTHY: 'E_ENDPOINT_UNHEALTHY',
  E_CLEANUP_INCOMPLETE: 'E_CLEANUP_INCOMPLETE',

  // --- **独立风险档**：就地变更回不去 ---
  E_ROLLBACK_FAILED: 'E_ROLLBACK_FAILED',
  E_NO_ROLLBACK_TARGET: 'E_NO_ROLLBACK_TARGET',

  // --- 状态与生命周期 ---
  E_STATE_CONFLICT: 'E_STATE_CONFLICT',
  E_RUN_NOT_FOUND: 'E_RUN_NOT_FOUND',
  E_TUNING_FAILED: 'E_TUNING_FAILED',
  E_TUNING_TIMEOUT: 'E_TUNING_TIMEOUT',
  E_CANCELLED: 'E_CANCELLED',

  // --- 镜像/契约 ---
  E_IMAGE_NOT_VERIFIED: 'E_IMAGE_NOT_VERIFIED',
  E_CONTRACT_MISMATCH: 'E_CONTRACT_MISMATCH',
  E_TESTING_CORE_ERROR: 'E_TESTING_CORE_ERROR',

  // --- 内部 ---
  E_INTERNAL: 'E_INTERNAL',
})

export const WARNING_CODES = Object.freeze({
  W_PROXY_DEAD: 'W_PROXY_DEAD',
  W_ASSUMPTION_FILLED: 'W_ASSUMPTION_FILLED',
  W_POLICY_DEFAULTED: 'W_POLICY_DEFAULTED',
  W_AMBIGUITY_RESOLVED: 'W_AMBIGUITY_RESOLVED',
  W_SYMLINK_MODEL_ROOT: 'W_SYMLINK_MODEL_ROOT',
  W_VM_SANDBOX_ABSENT: 'W_VM_SANDBOX_ABSENT',
  W_INTERNAL_SHARED_LIB: 'W_INTERNAL_SHARED_LIB',
  W_RESIDUAL_CLEANUP: 'W_RESIDUAL_CLEANUP',
  // 测量与观测
  W_MEASUREMENT_VALIDITY: 'W_MEASUREMENT_VALIDITY',
  W_WALL_UNKNOWN_OBSERVATION: 'W_WALL_UNKNOWN_OBSERVATION',
  W_CEILING_ASSUMPTION: 'W_CEILING_ASSUMPTION',
  W_PREREG_MISSING: 'W_PREREG_MISSING',
  W_EARLY_STOP_SUSPECTED: 'W_EARLY_STOP_SUSPECTED',
  W_INTERVENTION_INEFFECTIVE: 'W_INTERVENTION_INEFFECTIVE',
  W_QUANT_SUGGESTED: 'W_QUANT_SUGGESTED',
  // 源模型 / 契约
  W_SOURCE_VALIDATION_CACHED: 'W_SOURCE_VALIDATION_CACHED',
  W_SOURCE_VALIDATION_UNSUPPORTED: 'W_SOURCE_VALIDATION_UNSUPPORTED',
  W_CONTRACT_VERSION_SKEW: 'W_CONTRACT_VERSION_SKEW',
  W_CONTRACT_CHECK_UNAVAILABLE: 'W_CONTRACT_CHECK_UNAVAILABLE',
})

/** 结构化错误。`code` 取自 ERROR_CODES，`remediation` 必须可操作。 */
export class TuningError extends Error {
  constructor(code, message, { remediation, details, cause, retriable = false, capability } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'TuningError'
    this.code = code
    this.remediation = remediation ?? null
    this.details = details ?? null
    this.retriable = retriable
    this.capability = capability ?? null
  }

  toJSON() {
    return {
      ok: false,
      code: this.code,
      message: this.message,
      remediation: this.remediation,
      details: this.details,
      retriable: this.retriable,
    }
  }
}

/** 构造并抛出。`fail(code, msg, opts)`。 */
export function fail(code, message, opts) {
  throw new TuningError(code, message, opts)
}

export function isTuningError(e) {
  return e instanceof TuningError
}

/** 把任意异常规范化为可序列化载荷 —— 保证故障隔离：调用方永远拿到结构化结果。 */
export function toErrorPayload(err, { capability } = {}) {
  if (isTuningError(err)) {
    const p = err.toJSON()
    if (capability && !p.capability) p.capability = capability
    return p
  }
  return {
    ok: false,
    code: ERROR_CODES.E_INTERNAL,
    message: err && err.message ? String(err.message) : String(err),
    remediation: '这是未预期的内部错误；请附上 code 与本次调用的 auditId 提交问题。',
    details: err && err.stack ? { stack: String(err.stack).split('\n').slice(0, 8) } : null,
    retriable: false,
    capability: capability ?? null,
  }
}

/** 带 code 的警告（非致命），用于把自动决策记录进报告。 */
export class TuningWarning {
  constructor(code, message, details) {
    this.code = code
    this.message = message
    this.details = details ?? null
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details }
  }
}

export function warn(code, message, details) {
  return new TuningWarning(code, message, details)
}

/** **必须叫人**的失败码集合 —— 唯一一类"不能只写日志"的结局。 */
export const MUST_NOTIFY_FAILURES = Object.freeze(new Set([
  ERROR_CODES.E_ROLLBACK_FAILED,
]))
