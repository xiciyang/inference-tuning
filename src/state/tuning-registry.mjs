/**
 * 调优注册表 —— 共享状态（`~/.ai-infra/state/tuning-registry.yaml`）。
 *
 * 与 serving / quantization 同构：**进程内串行 + 文件锁 + 原子写 + 写前快照**。
 * 为什么不用 cwd 相对路径：旧引擎把报告写到 `process.cwd()/tuner-reports`，
 * 换个工作目录就找不到自己的产物。
 *
 * 每条记录的五要素（验收 Q4）：**方法 / 配置 / 性能 / 精度 / 状态**。
 * 缺任何一项时显式写 `null` 并让 `summarizeRun` 把它暴露出来 —— 不假装完整。
 */
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { readText, atomicWrite, atomicWriteJson, mkdirp, delay } from '../util/fsx.mjs'
import { parse as parseYaml, stringify as stringifyYaml } from '../util/yaml.mjs'
import { fail, ERROR_CODES } from '../errors.mjs'

export const REGISTRY_SCHEMA = 'inference-tuning/registry@1'
const LOCK_STALE_MS = 120_000

function emptyRegistry() {
  return { version: 1, updatedAt: new Date().toISOString(), pkg: PKG_VERSION, runs: [] }
}

export const PKG_VERSION = '0.1.0'

/** 读注册表（不存在 → 空表；损坏 → 响亮报错，不静默重建）。 */
export async function loadRegistry(runtime) {
  const file = runtime.paths.tuningRegistryFile
  const raw = await readText(file, null)
  if (!raw) return emptyRegistry()
  let parsed
  try {
    parsed = parseYaml(raw)
  } catch (err) {
    fail(ERROR_CODES.E_STATE_CONFLICT, `调优注册表解析失败：${file}`, {
      remediation: '注册表损坏。**不要**直接覆盖 —— 先备份该文件为证据，再决定是修复还是重建。',
      details: { file, error: String(err.message) },
    })
  }
  if (!parsed || typeof parsed !== 'object') return emptyRegistry()
  if (!Array.isArray(parsed.runs)) parsed.runs = []
  return parsed
}

export function serializeRegistry(reg) {
  return `# inference-tuning 调优注册表 —— 由插件维护；手工编辑请保持受限 YAML 子集（字符串需双引号）\n`
    + `${stringifyYaml(reg, { indent: 0 })}\n`
}

/** 写注册表（原子 + 写前快照）。 */
export async function saveRegistry(runtime, reg) {
  reg.updatedAt = new Date().toISOString()
  reg.pkg = PKG_VERSION
  const file = runtime.paths.tuningRegistryFile
  await mkdirp(runtime.paths.stateDir)
  const before = await readText(file, null)
  if (before) {
    const snap = join(runtime.paths.historyDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.registry.yaml`)
    await mkdirp(runtime.paths.historyDir)
    await atomicWrite(snap, before)
  }
  await atomicWrite(file, serializeRegistry(reg))
  return file
}

/**
 * 串行执行一段注册表读改写。
 * 进程内用 promise 链串行化；跨进程用 `.lock` 文件（带 stale 判定，不用 unref 定时器）。
 */
let chain = Promise.resolve()
export async function withRegistry(runtime, fn) {
  const run = async () => {
    const lock = join(runtime.paths.lockDir, 'tuning-registry.lock')
    await mkdirp(runtime.paths.lockDir)
    const deadline = Date.now() + 30_000
    for (;;) {
      try {
        const st = await fs.stat(lock).catch(() => null)
        if (st && Date.now() - st.mtimeMs < LOCK_STALE_MS) {
          if (Date.now() > deadline) {
            fail(ERROR_CODES.E_STATE_CONFLICT, `获取注册表锁超时：${lock}`, {
              remediation: '可能有另一个 inference-tuning 进程在跑。确认后删除该锁文件，或等待其完成。',
              details: { lock, ageMs: Date.now() - st.mtimeMs },
            })
          }
          // eslint-disable-next-line no-await-in-loop
          await delay(120)
          continue
        }
        await fs.writeFile(lock, `${process.pid}\n`, { mode: 0o600 })
        break
      } catch (err) {
        if (err?.code && err.code !== 'EEXIST') throw err
      }
    }
    try {
      const reg = await loadRegistry(runtime)
      const out = await fn(reg)
      await saveRegistry(runtime, reg)
      return out
    } finally {
      await fs.rm(lock, { force: true }).catch(() => {})
    }
  }
  const next = chain.then(run, run)
  chain = next.catch(() => {})
  return next
}

export function findRun(reg, id) {
  return reg.runs.find((r) => r.id === id) ?? null
}

export function pushHistory(rec, event, detail) {
  if (!Array.isArray(rec.history)) rec.history = []
  rec.history.push({ at: new Date().toISOString(), event, detail: detail ?? null })
}

/**
 * 五要素完整性摘要。
 * 缺字段**显式暴露为 null**，而不是"看起来完整"。
 */
export function summarizeRun(rec) {
  if (!rec) return null
  const missing = []
  if (!rec.method) missing.push('method')
  if (!rec.config) missing.push('config')
  if (!rec.performance) missing.push('performance')
  if (!rec.accuracy) missing.push('accuracy')
  if (!rec.status) missing.push('status')
  return {
    id: rec.id,
    method: rec.method ?? null,
    status: rec.status ?? null,
    config: rec.config ?? null,
    performance: rec.performance ?? null,
    accuracy: rec.accuracy ?? null,
    platform: rec.platform ?? null,
    complete: missing.length === 0,
    missing,
  }
}

export async function listRuns(runtime, { status = null, limit = 0 } = {}) {
  const reg = await loadRegistry(runtime)
  let runs = reg.runs
  if (status) runs = runs.filter((r) => r.status === status)
  const summarized = runs.map(summarizeRun).reverse()
  return limit > 0 ? summarized.slice(0, limit) : summarized
}

/** 报告落盘。 */
export async function writeReport(runtime, runId, report) {
  await mkdirp(runtime.paths.reportsDir)
  const p = join(runtime.paths.reportsDir, `${runId}.json`)
  await atomicWriteJson(p, report)
  return p
}

export async function readReport(runtime, runId) {
  const p = join(runtime.paths.reportsDir, `${runId}.json`)
  const raw = await readText(p, null)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

export async function listReports(runtime) {
  const files = await fs.readdir(runtime.paths.reportsDir).catch(() => [])
  return files.filter((f) => f.endsWith('.json')).sort().reverse()
}
