/**
 * 过早收尾检测。
 *
 * 要防的失败模式：**看起来收敛了，其实只是没继续试**。
 * 这跟"达到物理瓶颈"是两回事 —— 前者是过程缺陷，后者是客观结论。
 *
 * 判据（任一成立即报"疑似过早收尾"）：
 *   ① 还有未试过的可解除干预就收了
 *   ② 有墙仍是 headroom（有空间）却收了
 *   ③ 有墙因为**缺观测**而不可判定，且从未补测过那些观测就收了
 *   ④ 收尾时用的是"信号未达稳"的数据（调用方声明 measurementValid=false）
 *
 * 刻意**不**把"轮数少"当判据：轮数少但空间已穷尽，是正确的收尾。
 */

export const EARLY_STOP_SCHEMA_VERSION = '1.0.0'

export function detectEarlyStop({
  wallDiag = null,
  triedLevers = [],
  stopKind = null,
  measurementValid = null,
  roundsRun = 0,
} = {}) {
  const findings = []

  if (stopKind && stopKind !== 'physical-limit') {
    return {
      schemaVersion: EARLY_STOP_SCHEMA_VERSION,
      suspected: false,
      findings: [],
      note: `停止原因 ${stopKind} 不是"收敛"，过早收尾检测不适用`,
      roundsRun,
    }
  }

  const tried = new Set(triedLevers)
  const walls = Array.isArray(wallDiag?.walls) ? wallDiag.walls : []

  const untried = []
  for (const w of walls) {
    if (!w.usable) continue
    const candidates = [w.suggestedRemedy, ...(w.remedyAlternatives ?? [])].filter(Boolean)
    for (const l of candidates) if (!tried.has(`${w.id}:${l}`)) untried.push(`${w.id}:${l}`)
  }
  if (untried.length > 0) {
    findings.push({
      code: 'untried-levers',
      severity: 'high',
      detail: `收尾时仍有 ${untried.length} 个可解除干预未试过：${untried.join(', ')}`,
    })
  }

  const headroom = walls.filter((w) => w.usable && w.state === 'headroom')
  if (headroom.length > 0) {
    findings.push({
      code: 'headroom-remains',
      severity: 'high',
      detail: `${headroom.map((w) => `${w.id}(${((w.utilization ?? 0) * 100).toFixed(0)}%)`).join(', ')} 仍是 headroom —— 还有空间`,
    })
  }

  const unknown = walls.filter((w) => !w.usable)
  if (unknown.length > 0) {
    findings.push({
      code: 'unknown-walls',
      severity: 'medium',
      detail: `${unknown.length} 堵墙因缺观测不可判定（${unknown.map((w) => w.id).join(', ')}）。`
        + '"未测"不等于"没空间" —— 收尾前应补齐观测，或显式声明该墙的结论不适用',
    })
  }

  if (measurementValid === false) {
    findings.push({
      code: 'invalid-measurement',
      severity: 'high',
      detail: '收尾依据的测量未通过成立性门禁 —— 这个收尾结论没有判别力',
    })
  }

  return {
    schemaVersion: EARLY_STOP_SCHEMA_VERSION,
    suspected: findings.length > 0,
    findings,
    roundsRun,
    untriedLevers: untried,
    note: findings.length === 0
      ? '未发现过早收尾迹象'
      : '**疑似过早收尾**：以下事项未穷尽就停止了（这不等于错，但必须显式交代）',
  }
}
