/**
 * 目标驱动与不停机判据。
 *
 * 用户长期指令：**给出目标后优化中途不能停止**；
 * **"已达标"与"预算耗尽"都不构成停止理由**；
 * 任何"硬件到顶"类判定必须写明限定条件（当前 kernel 实现 / 状态缓存格式 / 量化精度）。
 *
 * 因此停止集合刻意**很小**，而且每一项都必须可复核：
 *
 *   stop 原因（只有三个）
 *     ① physical-limit     —— 所有可用的墙都已到界 **且** 没有未试过的可解除干预
 *                              （判定必须带 `limitingConditions`，否则不允许判）
 *     ② user-abort         —— 用户显式中止
 *     ③ rollback-failed    —— 回滚失败（独立风险档，必须叫人）
 *
 *   **不是**停止原因（只是警告，循环继续）
 *     · target-met         —— 达标了也继续：交付的是"离硬件多远"，不是一个数字
 *     · budget-exhausted   —— 预算用完 → 产出**可续跑**的检查点并让出，不判结束
 *     · max-rounds         —— 同上
 */

export const OBJECTIVE_SCHEMA_VERSION = '1.0.0'

export const DRIVE_STATUS = Object.freeze({
  DRIVING: 'driving',
  TARGET_MET: 'target-met',
  NO_HEADROOM: 'no-headroom',
  INSUFFICIENT_OBSERVATIONS: 'insufficient-observations',
})

export const RUN_OUTCOME = Object.freeze({
  CONTINUE: 'continue',
  YIELD_RESUMABLE: 'yield-resumable',
  STOP: 'stop',
})

export const STOP_KINDS = Object.freeze({
  PHYSICAL_LIMIT: 'physical-limit',
  USER_ABORT: 'user-abort',
  ROLLBACK_FAILED: 'rollback-failed',
})

/** 不是停止原因，只是警告 —— 单列出来，避免有人日后把它们塞进停止集合。 */
export const NON_STOP_REASONS = Object.freeze(['target-met', 'budget-exhausted', 'max-rounds'])

/**
 * 定义目标。
 * @param {{model, metric, target, thresholds, exclusions?, budgetMs?, maxRounds?}} spec
 */
export function defineObjective({
  model, metric = 'decodeTps', target = null, thresholds = null, exclusions = [], budgetMs = null, maxRounds = 12,
} = {}) {
  if (!model) throw new Error('defineObjective 需要 model')
  if (!thresholds) throw new Error('defineObjective 需要 thresholds（阈值必须外部提供，不得在本模块猜）')
  return {
    schemaVersion: OBJECTIVE_SCHEMA_VERSION,
    model,
    metric,
    target,
    thresholds,
    // 目标函数之外的**硬约束**（不是优先级）：例如"不得改变主模型量化格式"
    exclusions: exclusions.map((e) => (typeof e === 'string' ? { kind: e } : e)),
    budgetMs,
    maxRounds,
    createdAt: new Date().toISOString(),
  }
}

/** 目标是否达成（仅作为状态显示，**不作为停止理由**）。 */
export function assessTargets({ objective, measurements = {} } = {}) {
  const t = objective?.target
  if (!t || t.value === null || t.value === undefined) {
    return { status: DRIVE_STATUS.DRIVING, met: false, detail: '未设数值目标（由门禁阈值判定接受与否）' }
  }
  const cur = Number(measurements[t.metric] ?? measurements[objective.metric])
  if (!Number.isFinite(cur)) {
    return { status: DRIVE_STATUS.INSUFFICIENT_OBSERVATIONS, met: false, detail: `缺 ${t.metric} 的实测值` }
  }
  const dir = t.direction ?? 'increase'
  const met = dir === 'increase' ? cur >= t.value : cur <= t.value
  return {
    status: met ? DRIVE_STATUS.TARGET_MET : DRIVE_STATUS.DRIVING,
    met,
    current: cur,
    target: t.value,
    direction: dir,
    detail: `${t.metric} = ${cur} vs 目标 ${dir === 'increase' ? '≥' : '≤'} ${t.value}`,
  }
}

/**
 * 是否还有可解除的空间。
 * @param {{wallDiag, triedLevers: string[]}} spec
 */
export function assessDrive({ wallDiag = null, triedLevers = [] } = {}) {
  if (!wallDiag || !Array.isArray(wallDiag.walls)) {
    return { status: DRIVE_STATUS.INSUFFICIENT_OBSERVATIONS, hasHeadroom: false, untriedLevers: [], detail: '无墙诊断结果' }
  }
  const tried = new Set(triedLevers)
  const untried = []
  for (const w of wallDiag.walls) {
    if (!w.usable) continue
    if (w.state !== 'walled') continue
    if (w.actionable && w.actionable.ok === false) continue
    // 该墙的 TOP1 与备选是否都试过
    const candidates = [w.suggestedRemedy, ...(w.remedyAlternatives ?? [])].filter(Boolean)
    const left = candidates.filter((l) => !tried.has(`${w.id}:${l}`))
    for (const l of left) untried.push({ wall: w.id, lever: l })
  }
  const headroom = wallDiag.walls.filter((w) => w.usable && w.state === 'headroom')
  return {
    status: untried.length > 0 ? DRIVE_STATUS.DRIVING : (headroom.length > 0 ? DRIVE_STATUS.DRIVING : DRIVE_STATUS.NO_HEADROOM),
    hasHeadroom: headroom.length > 0,
    headroomWalls: headroom.map((w) => w.id),
    untriedLevers: untried,
    detail: untried.length > 0
      ? `还有 ${untried.length} 个未试过的可解除干预：${untried.map((u) => `${u.wall}:${u.lever}`).join(', ')}`
      : (headroom.length > 0
        ? `已试完介入手段，但 ${headroom.map((w) => w.id).join('/')} 仍有 headroom —— 不是停止理由`
        : '所有可用墙都已到界且无可解除干预'),
  }
}

/**
 * 收集"硬件到顶"判定的限定条件。
 * **没有限定条件的 physical-limit 判定是不允许的** —— 这条是用户明确要求的。
 */
export function collectLimitingConditions({ wallDiag = null, engine = {}, model = {} } = {}) {
  const conds = []
  if (engine.kernelImplementation) conds.push(`当前 kernel 实现：${engine.kernelImplementation}`)
  if (engine.version) conds.push(`引擎版本：${engine.version}`)
  if (model.kvPrecision) conds.push(`状态缓存格式：${model.kvPrecision}`)
  if (model.quantFormat) conds.push(`量化精度：${model.quantFormat}`)
  if (wallDiag?.rootWall?.bound !== null && wallDiag?.rootWall?.bound !== undefined) {
    conds.push(`根因墙上界口径：${wallDiag.rootWall.formula}（上界 ${wallDiag.rootWall.bound} ${wallDiag.rootWall.unit}）`)
  }
  if (wallDiag?.unknownWalls?.length > 0) {
    conds.push(`未测得的墙：${wallDiag.unknownWalls.map((w) => w.id).join(', ')}（这些墙的结论不可用）`)
  }
  return conds
}

/**
 * 限定条件里**必须至少有一条是实现域**的 —— 即用户点名的三类之一：
 * "当前 kernel 实现 / 状态缓存格式 / 量化精度"。
 *
 * 为什么单独抽出来判：只写一句"上界口径是 X"并不构成限定条件。
 * 上界公式本身依赖实现（kernel、缓存格式、量化精度），所以"到顶"必须是
 * **在这些实现条件下**到顶，换实现就可能不到顶。放宽这一条，
 * "硬件到顶"就会退化成一句无法被检验的口号。
 */
const IMPLEMENTATION_SCOPE = [/kernel 实现/, /状态缓存格式/, /量化精度/]

export function hasImplementationScope(conditions = []) {
  return conditions.some((c) => IMPLEMENTATION_SCOPE.some((re) => re.test(String(c))))
}

/**
 * 本轮该继续、该让出、还是该停。
 *
 * @param {{
 *   objective, round, wallDiag, triedLevers, measurements,
 *   budgetExceeded?: boolean, userAbort?: boolean, rollbackFailed?: boolean,
 *   engine?, model?
 * }} spec
 */
export function decideRunOutcome({
  objective = null, round = 0, wallDiag = null, triedLevers = [], measurements = {},
  budgetExceeded = false, userAbort = false, rollbackFailed = false, engine = {}, model = {},
} = {}) {
  const warnings = []

  if (rollbackFailed) {
    return {
      action: RUN_OUTCOME.STOP,
      stopKind: STOP_KINDS.ROLLBACK_FAILED,
      mustNotify: true,
      reason: '回滚失败 —— 目标服务可能停留在未知配置上。这是**独立风险档**，必须叫人',
      remediation: '人工介入：确认端点实际配置、手工恢复，再决定是否继续调优',
      warnings,
    }
  }
  if (userAbort) {
    return { action: RUN_OUTCOME.STOP, stopKind: STOP_KINDS.USER_ABORT, mustNotify: false, reason: '用户显式中止', warnings }
  }

  const drive = assessDrive({ wallDiag, triedLevers })
  const targets = assessTargets({ objective, measurements })

  // **达标不构成停止理由** —— 只记一条警告，继续推进
  if (targets.met) {
    warnings.push({
      code: 'target-met',
      message: `目标已达成（${targets.detail}），但**这不构成停止理由**：继续推进直到没有可解除的空间`,
    })
  }

  if (drive.status === DRIVE_STATUS.NO_HEADROOM || drive.untriedLevers.length === 0) {
    const limitingConditions = collectLimitingConditions({ wallDiag, engine, model })
    if (!hasImplementationScope(limitingConditions)) {
      // 不给"没有实现域限定条件"的硬件到顶判定放行
      return {
        action: RUN_OUTCOME.YIELD_RESUMABLE,
        stopKind: null,
        reason: '所有可用墙都已到界，但**限定条件里没有一条是实现域的**'
          + '（需要 kernel 实现 / 状态缓存格式 / 量化精度 之一）—— 按规则不允许判"硬件到顶"，转为让出（可续跑）',
        remediation: '补齐 engine.kernelImplementation / model.quantFormat / engine.kvPrecision 等实现域限定条件后重跑',
        limitingConditions,
        drive, targets, warnings,
      }
    }
    return {
      action: RUN_OUTCOME.STOP,
      stopKind: STOP_KINDS.PHYSICAL_LIMIT,
      reason: `达到物理瓶颈：${drive.detail}`,
      limitedBy: limitingConditions,
      remediation: '这是**在下列限定条件下的**物理瓶颈，不是物理理论上界。要突破需改变限定条件本身（换 kernel 实现 / 改状态缓存格式 / 改量化精度）。',
      drive, targets, warnings,
    }
  }

  if (budgetExceeded) {
    return {
      action: RUN_OUTCOME.YIELD_RESUMABLE,
      stopKind: null,
      reason: `预算耗尽，但**这不构成停止理由**：还有 ${drive.untriedLevers.length} 个未试过的可解除干预。`
        + '产出可续跑的检查点并让出，下一轮从该检查点继续',
      resumeFrom: { round, triedLevers, untriedLevers: drive.untriedLevers },
      drive, targets, warnings,
    }
  }

  return {
    action: RUN_OUTCOME.CONTINUE,
    stopKind: null,
    reason: drive.detail,
    drive, targets, warnings,
  }
}
