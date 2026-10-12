/**
 * 极简指标计数（`~/.ai-infra/state/metrics.json`）。
 * 只记"发生过什么"，不做聚合分析 —— 聚合交给读取方。
 */
import { readText, atomicWriteJson, mkdirp } from './util/fsx.mjs'

export async function readMetrics(runtime) {
  const raw = await readText(runtime.paths.metricsFile, null)
  if (!raw) return { version: 1, counters: {}, updatedAt: null }
  try {
    const j = JSON.parse(raw)
    if (!j.counters) j.counters = {}
    return j
  } catch {
    return { version: 1, counters: {}, updatedAt: null }
  }
}

export async function metricsBump(runtime, name, by = 1) {
  const m = await readMetrics(runtime)
  m.counters[name] = (m.counters[name] ?? 0) + by
  m.updatedAt = new Date().toISOString()
  await mkdirp(runtime.paths.stateDir)
  await atomicWriteJson(runtime.paths.metricsFile, m)
  return m.counters[name]
}

export async function resetMetrics(runtime) {
  const m = { version: 1, counters: {}, updatedAt: new Date().toISOString() }
  await mkdirp(runtime.paths.stateDir)
  await atomicWriteJson(runtime.paths.metricsFile, m)
  return m
}
