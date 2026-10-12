/**
 * append-only 审计 + sha256 哈希链。
 *
 * 约束（与另两包同构）：
 *   - 每个记录带 `prevHash`（同文件上一条的 `hash`）与自己的 `hash`
 *   - `hash = sha256(canonicalJson(record 去掉 hash 字段))` —— 键序稳定，同一逻辑值同一哈希
 *   - 落盘用 O_APPEND（"只追加不可改"在 POSIX 下的直接表达）
 *   - `audit-verify` 能整链复算：**改过任何一条都会被发现**
 *
 * 为什么调优特别需要它：调优是**就地变更**，事后要能回答
 * "第几轮、什么参数、为什么接受/回退、回滚成不成功"。
 * 没有不可改的证据链，这类问题只能靠记忆。
 */
import { join } from 'node:path'
import { appendLine, readText, listDir, mkdirp } from './util/fsx.mjs'
import { sha256, canonicalJson } from './util/hash.mjs'
import { fail, ERROR_CODES } from './errors.mjs'

export const AUDIT_SCHEMA = 'inference-tuning/audit@1'
const GENESIS = '0'.repeat(64)

export function auditFileFor(runtime, date = new Date()) {
  const day = date.toISOString().slice(0, 10)
  return join(runtime.paths.auditDir, `${day}.jsonl`)
}

async function lastHashOf(file) {
  const raw = await readText(file, null)
  if (!raw) return GENESIS
  const lines = raw.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return GENESIS
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const rec = JSON.parse(lines[i])
      if (typeof rec.hash === 'string') return rec.hash
    } catch { /* 跳过损坏行 */ }
  }
  return GENESIS
}

/**
 * 追加一条审计记录。
 * @returns {Promise<{file, seq, hash, prevHash, auditId}>}
 */
export async function appendAudit(runtime, entry, { date = new Date() } = {}) {
  const file = auditFileFor(runtime, date)
  await mkdirp(runtime.paths.auditDir)
  const prevHash = await lastHashOf(file)
  const raw = await readText(file, null)
  const seq = raw ? raw.split('\n').filter((l) => l.trim() !== '').length + 1 : 1
  const body = {
    schema: AUDIT_SCHEMA,
    seq,
    ts: new Date().toISOString(),
    pkg: 'inference-tuning',
    pkgVersion: PKG_VERSION,
    ...entry,
    // 记账字段放在最后，且**参与**哈希（它们也是事实的一部分）
    headless: runtime?.options?.headless === true,
    prevHash,
  }
  const hash = sha256(canonicalJson(body))
  const record = { ...body, hash }
  await appendLine(file, JSON.stringify(record))
  return { file, seq, hash, prevHash, auditId: `aud_${hash.slice(0, 12)}` }
}

export const PKG_VERSION = '0.1.0'

/** 读某一天的审计记录（默认今天）。 */
export async function readAudit(runtime, { date = new Date(), limit = 0 } = {}) {
  const file = auditFileFor(runtime, date)
  const raw = await readText(file, null)
  if (!raw) return { file, records: [], parseErrors: 0 }
  const records = []
  let parseErrors = 0
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try { records.push(JSON.parse(line)) } catch { parseErrors += 1 }
  }
  return { file, records: limit > 0 ? records.slice(-limit) : records, parseErrors }
}

/**
 * 复算整链。任何一条被改动、删除、重排都会失败。
 * @returns {{ok, checked, brokenAt, reason, parseErrors}}
 */
export async function verifyAuditChain(runtime, { date = new Date() } = {}) {
  const { file, records, parseErrors } = await readAudit(runtime, { date })
  if (parseErrors > 0) {
    return { ok: false, checked: records.length, brokenAt: null, reason: `${parseErrors} 行不是合法 JSON（记录被破坏或截断）`, parseErrors, file }
  }
  let prev = GENESIS
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i]
    const { hash, ...body } = rec
    if (body.prevHash !== prev) {
      return { ok: false, checked: records.length, brokenAt: i + 1, reason: `第 ${i + 1} 条的 prevHash 与上一条的 hash 不符（链断了）`, parseErrors, file }
    }
    const recomputed = sha256(canonicalJson(body))
    if (recomputed !== hash) {
      return { ok: false, checked: records.length, brokenAt: i + 1, reason: `第 ${i + 1} 条内容被改动（重算哈希不一致）`, parseErrors, file }
    }
    prev = hash
  }
  return { ok: true, checked: records.length, brokenAt: null, reason: null, parseErrors, file, head: prev }
}

/** 列出审计目录里所有日期分片。 */
export async function listAuditFiles(runtime) {
  const files = await listDir(runtime.paths.auditDir)
  return files.filter((f) => f.endsWith('.jsonl')).sort()
}

/** 校验所有日期分片（跨文件不建链，各自独立成链）。 */
export async function verifyAllAuditChains(runtime) {
  const files = await listAuditFiles(runtime)
  const results = []
  for (const f of files) {
    const day = f.replace(/\.jsonl$/, '')
    // eslint-disable-next-line no-await-in-loop
    const r = await verifyAuditChain(runtime, { date: new Date(`${day}T00:00:00Z`) })
    results.push({ day, ...r })
  }
  return { ok: results.every((r) => r.ok), files: results.length, results }
}

/** 链断了要响亮失败（不允许"继续写"把断点糊过去）。 */
export async function assertAuditChainIntact(runtime, { date = new Date() } = {}) {
  const r = await verifyAuditChain(runtime, { date })
  if (!r.ok) {
    fail(ERROR_CODES.E_STATE_CONFLICT, `审计哈希链已损坏：${r.reason}`, {
      remediation: '不要再继续写入该审计文件。把该文件保留为证据，另起一个日期分片继续记录；'
        + '并排查是磁盘损坏还是有人改过。',
      details: r,
    })
  }
  return r
}
