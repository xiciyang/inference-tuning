/**
 * "必须叫人"的失败通知 —— 目前只有一个触发点：**回滚失败**。
 *
 * 为什么它值得一个独立模块：调优是**就地变更**。回滚失败意味着
 * "把一个原本可用的服务留在了坏状态" —— 这与"调优没成功"是两回事，
 * 严重性和处置都不同（前者必须停机并叫人，后者可以继续试）。
 *
 * 通道（按可靠性从高到低，**全部都会执行，不择一**）：
 *   ① 状态文件 `~/.ai-infra/state/MUST_NOTIFY.json` —— 最可靠，任何进程/人都能读到
 *   ② 审计日志（调用方已写）—— 不可改的证据链
 *   ③ 可选 webhook（`~/.ai-infra/config/notify.json` 里的 `webhookUrl`）
 *   ④ 进程 stderr —— 让调用方的日志里也有
 *
 * 注意：插件运行在 DSH 进程里时**不能直接调用 DSH 的通知工具**（那是模型侧能力）。
 * 因此这里把事实落到状态文件，并在 MCP/CLI 的返回里把 `mustNotify` 置真；
 * 由 agent 侧读取后触发 DSH 通知渠道。**这条边界是显式的，不是遗漏。**
 */
import { join } from 'node:path'
import { readText, atomicWriteJson, mkdirp } from './util/fsx.mjs'
import { ERROR_CODES } from './errors.mjs'

export const MUST_NOTIFY_FILE = 'MUST_NOTIFY.json'

export async function notifyFailure(runtime, { runId, rollbackFailure, reportPath, log = null } = {}) {
  const file = join(runtime.paths.stateDir, MUST_NOTIFY_FILE)
  const previous = await readText(file, null)
  let history = []
  if (previous) {
    try {
      const j = JSON.parse(previous)
      history = Array.isArray(j.history) ? j.history.slice(-19) : []
    } catch { history = [] }
  }
  const entry = {
    at: new Date().toISOString(),
    pkg: 'inference-tuning',
    code: ERROR_CODES.E_ROLLBACK_FAILED,
    severity: 'critical',
    runId,
    reason: rollbackFailure?.reason ?? null,
    round: rollbackFailure?.round ?? null,
    reportPath: reportPath ?? null,
    message: '调优回滚失败：目标服务可能停留在未知配置上。请人工确认端点与显存状态。',
  }
  await mkdirp(runtime.paths.stateDir)
  await atomicWriteJson(file, { schema: 'inference-tuning/must-notify@1', latest: entry, history: [...history, entry] })

  // webhook（可选）
  const cfgRaw = await readText(join(runtime.paths.configDir, 'notify.json'), null)
  if (cfgRaw) {
    try {
      const cfg = JSON.parse(cfgRaw)
      if (cfg.webhookUrl) {
        const r = await fetch(cfg.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
          body: JSON.stringify({ text: `${entry.message}\nrunId=${runId}\nreason=${entry.reason}` }),
        })
        log?.info?.('回滚失败通知已投递 webhook', { status: r.status })
      }
    } catch (err) {
      log?.warn?.('回滚失败 webhook 投递失败（状态文件已写，不影响主判断）', { error: String(err.message) })
    }
  }

  // stderr —— 让调用方日志里也有
  process.stderr.write(`[inference-tuning] MUST-NOTIFY ${ERROR_CODES.E_ROLLBACK_FAILED}: ${entry.message} (runId=${runId})\n`)
  log?.error?.('回滚失败，已写入 MUST_NOTIFY 状态文件', { file, runId })

  return { file, entry, delivered: ['state-file', 'audit', 'stderr', ...(cfgRaw ? ['webhook?'] : [])] }
}

/** 供 health/doctor 读出"是否有未处理的必叫事件"。 */
export async function readMustNotify(runtime) {
  const file = join(runtime.paths.stateDir, MUST_NOTIFY_FILE)
  const raw = await readText(file, null)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}
