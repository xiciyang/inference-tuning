/**
 * 极简结构化日志。
 * 两条纪律：
 *   · **不写敏感值**（密钥/令牌一律只留指纹）—— 报告是要给人看、给审计查的
 *   · 空值不静默丢弃（`undefined` 会被显式写成 null，避免"看起来没有这个字段"）
 */
import { join } from 'node:path'
import { appendLine, mkdirp } from './util/fsx.mjs'

function scrub(v) {
  if (v === undefined) return null
  if (typeof v === 'string' && /^(sk-|Bearer |cf_)/.test(v)) return `${v.slice(0, 6)}…(len=${v.length})`
  return v
}

export function createLogger({ runtime = null, stdout = false, level = 'info' } = {}) {
  const emit = async (lvl, msg, data) => {
    const rec = { ts: new Date().toISOString(), level: lvl, msg, data: data === undefined ? null : scrub(data) }
    if (stdout) process.stdout.write(`${JSON.stringify(rec)}\n`)
    if (runtime?.paths?.appLogDir) {
      try {
        await mkdirp(runtime.paths.appLogDir)
        await appendLine(join(runtime.paths.appLogDir, `${new Date().toISOString().slice(0, 10)}.log`), JSON.stringify(rec))
      } catch { /* 日志失败不影响主流程 */ }
    }
  }
  return {
    info: (msg, data) => { void emit('info', msg, data) },
    warn: (msg, data) => { void emit('warn', msg, data) },
    error: (msg, data) => { void emit('error', msg, data) },
    phase: (name, data) => { void emit('info', `phase:${name}`, data) },
    level,
  }
}
