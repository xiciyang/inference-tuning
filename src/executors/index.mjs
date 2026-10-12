/**
 * 执行器接缝。
 *
 * 存在的意义：让**完整闭环可以在没有 GPU / Docker 的情况下被测试**，
 * 而生产路径零改动。这是 quantization 已验证过的做法 ——
 * 没有这个接缝，"真机演示"就会退化成"只能人工跑"，
 * 而没有自动化闭环测试，任何一个重构都会静默破坏挂载/参数/路径。
 *
 * 执行器契约（全部 async，全部返回结构化结果，**不抛跨接口的裸异常**）：
 *   probeEngineFlags(runtime, {flags})            → Set<string>  该引擎版本真实支持的 flag
 *   deploy(runtime, spec)                          → {id, endpoint, port, servedModelName, applied, skipped}
 *   teardown(runtime, {id})                        → {ok, residual, cleanup}
 *   measure(runtime, spec)                         → 见 testing/perf.mjs measureEndpoint
 *   bandwidthProbe(runtime, spec)                  → {readGBps, bestReadGBps, ...} | null
 */
import { fail, ERROR_CODES } from '../errors.mjs'

const registry = new Map()

export function registerExecutor(executor) {
  if (!executor || !executor.id) throw new Error('registerExecutor 需要 {id, ...}')
  registry.set(executor.id, executor)
  return executor
}

export function listExecutors() {
  return [...registry.values()].map((e) => ({ id: e.id, displayName: e.displayName }))
}

export function getExecutor(id) {
  return registry.get(id) ?? null
}

/** 取运行时选定的执行器；未注册 → 明确失败（不静默回退到真机路径）。 */
export function executorFor(runtime) {
  const id = runtime?.options?.executor ?? 'docker'
  const e = registry.get(id)
  if (!e) {
    fail(ERROR_CODES.E_INTERNAL, `未注册的执行器：${id}`, {
      remediation: `已注册：${[...registry.keys()].join(', ') || '(空)'}。`
        + '测试里请先 import 并 registerExecutor(fakeExecutor)。',
      details: { requested: id, available: [...registry.keys()] },
    })
  }
  return e
}

export function _resetExecutorsForTests() {
  registry.clear()
}
