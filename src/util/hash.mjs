import { createHash } from 'node:crypto'

/** sha256 十六进制摘要。 */
export function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * 稳定序列化：对象键排序后序列化，保证同一逻辑值产出同一字符串。
 * 用于审计哈希链与幂等键 —— 键序不稳定会让同一次调用算出两个不同的键。
 */
export function canonicalJson(value) {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue
      out[k] = sortDeep(v[k])
    }
    return out
  }
  return v
}

/** 计算幂等键：同一次逻辑动作必须得到同一个 key。 */
export function idempotencyKey(parts) {
  return sha256(canonicalJson(parts)).slice(0, 16)
}

/** 短 id，用于 run id / 容器名 / 端点 id。 */
export function shortId(seed, len = 10) {
  return sha256(String(seed)).slice(0, len)
}

/**
 * 目标指纹 —— 确认令牌的作用域。
 *
 * **刻意排除**记账字段（`confirm` / `options` / `headless` 等）：
 * 把 `confirm` 自己算进指纹，会让"带令牌重试"算出新指纹 → 再要一次确认 → 永远走不通。
 * 这个坑 inference-serving 与 inference-quantization 各踩过一次。
 */
const BOOKKEEPING = new Set(['confirm', 'options', 'headless', 'json', 'raw', 'log', 'signal', 'onPhase'])
export function targetFingerprint(scope, payload) {
  const clean = {}
  for (const k of Object.keys(payload ?? {}).sort()) {
    if (BOOKKEEPING.has(k)) continue
    if (payload[k] === undefined) continue
    clean[k] = payload[k]
  }
  return `${scope}:${sha256(canonicalJson(clean)).slice(0, 16)}`
}
