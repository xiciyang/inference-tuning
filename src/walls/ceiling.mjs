/**
 * 单流天花板 + **证据链**。
 *
 * 回答的问题：**给定本机实测可达带宽与真实的每 token 访存量，单流吞吐的理论上界是多少，
 * 当前离它有多远。**
 *
 * 三条纪律：
 *
 * ① **天花板必须带限定条件**
 *    "单流上限 X tok/s" 这句话在脱离实现条件时是没有意义的 —— 换 kernel、换状态缓存格式、
 *    换量化精度都会改分母。因此返回值里 `conditionalOn` 是**必填项**，
 *    且至少要有一条是**实现域**的（kernel 实现 / 状态缓存格式 / 量化精度）。
 *    没有限定条件的天花板会被 `gateCeiling` 拒绝（见 src/validity/claims.mjs）。
 *
 * ② **每 token 访存量要拆开算，不能只算权重**
 *    decode 阶段每个 token 要读：全部权重 + 该上下文长度对应的 KV 缓存。
 *    短上下文时权重占绝对多数，长上下文时 KV 会反超 —— 这正是"同一模型不同上下文
 *    单流上限差好几倍"的原因。
 *
 * ③ **可自我否证**
 *    若实测 TPS 反推出的有效带宽**超过**实测可达带宽，判"分母口径有误"，
 *    而不是判"已达上限"。这条是被真机误判换来的。
 *
 * `evidenceChain` 把从"原始实测"到"天花板"的每一步都列出来（含来源），
 * 使这个数字可以被独立复核，而不是只能选择相信。
 */

export const CEILING_SCHEMA_VERSION = '1.0.0'

const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function resolve(obj, path) {
  let cur = obj
  for (const p of String(path).split('.')) {
    if (cur == null) return null
    cur = cur[p]
  }
  return cur
}

function prov(ctx, key) {
  const p = ctx?.provenance ?? {}
  return p[key] ?? p[String(key).split('.').pop()] ?? 'adapter'
}

/**
 * 每 token 的总访存量（GB）。
 *
 * weightsGB        —— 全部权重（decode 每个 token 都要读一遍）
 * kvPerTokenGB     —— 该上下文下每个 token 需要读的 KV 缓存
 *
 * KV 每 token 字节数 = 2(K,V) × layers × kv_heads × head_dim × dtype_bytes × context_len
 * 对 MLA / SSM（Mamba）等结构，用 `model.stateCacheBytesPerToken` 直接给实测值覆盖。
 */
export function bytesPerToken(ctx) {
  const weights = num(resolve(ctx, 'model.bytesPerTokenGB') ?? resolve(ctx, 'model.weightBytesGB'))
  const ctxLen = num(resolve(ctx, 'model.contextLength')) ?? num(resolve(ctx, 'measurements.contextLength')) ?? 0
  const statePerToken = num(resolve(ctx, 'model.stateCacheBytesPerToken'))   // 每 token 的状态缓存字节数
  const kvPerTokenPerCtx = num(resolve(ctx, 'model.kvBytesPerTokenPerCtx'))  // 每 (token × 上下文) 的字节数

  if (weights === null) return { total: null, weights: null, kv: null, contextLength: ctxLen, why: '缺 model.bytesPerTokenGB（每 token 至少要读权重）' }

  let kv = null
  if (statePerToken !== null) {
    kv = (statePerToken * ctxLen) / 1e9
  } else if (kvPerTokenPerCtx !== null) {
    kv = (kvPerTokenPerCtx * ctxLen) / 1e9
  }
  return {
    total: weights + (kv ?? 0),
    weights,
    kv,
    contextLength: ctxLen,
    kvForm: statePerToken !== null ? 'stateCacheBytesPerToken×contextLength' : (kvPerTokenPerCtx !== null ? 'kvBytesPerTokenPerCtx×contextLength' : null),
  }
}

/**
 * 单流天花板。
 *
 * @returns {{ceilingTps, currentTps, utilization, gapTps, formula, inputs, provenance,
 *            conditionalOn, sanity, breakdown, usable, why?}}
 */
export function singleStreamCeiling(ctx, { limitingConditions = null } = {}) {
  const bw = num(resolve(ctx, 'hardware.achievableBandwidthGBps'))
  const bpt = bytesPerToken(ctx)
  const tps = num(resolve(ctx, 'measurements.singleStreamTps')) ?? num(resolve(ctx, 'measurements.decodeTps'))

  const conditionalOn = resolveConditional(ctx, limitingConditions)

  if (bw === null || bpt.total === null || bpt.total <= 0) {
    return {
      schemaVersion: CEILING_SCHEMA_VERSION,
      usable: false,
      why: bw === null ? '缺实测可达带宽（禁止用规格书峰值代替）' : bpt.why,
      ceilingTps: null, currentTps: tps, utilization: null, gapTps: null,
      conditionalOn,
      breakdown: { ...bpt, achievableBandwidthGBps: bw },
    }
  }

  const ceilingTps = bw / bpt.total
  const utilization = tps !== null ? tps / ceilingTps : null
  const effectiveBW = tps !== null ? tps * bpt.total : null
  const impossible = effectiveBW !== null && effectiveBW > bw * 1.02

  const sanity = impossible
    ? {
      ok: false,
      warn: `按当前分母反推的有效带宽 ${effectiveBW.toFixed(1)} GB/s > 实测可达 ${bw.toFixed(1)} GB/s`
        + `（超出 ${((effectiveBW / bw - 1) * 100).toFixed(1)}%）—— **每 token 访存量口径有误**`
        + '（常见原因：把不该算的层/embed/vision tower 算进去了，或 KV 项重复计算）。'
        + '禁止据此判定"已达单流上限"。',
      effectiveGBps: effectiveBW,
      achievableGBps: bw,
    }
    : { ok: true, effectiveGBps: effectiveBW, utilizationOfAchievable: effectiveBW === null ? null : effectiveBW / bw }

  return {
    schemaVersion: CEILING_SCHEMA_VERSION,
    usable: true,
    ceilingTps,
    currentTps: tps,
    utilization,
    gapTps: tps !== null ? ceilingTps - tps : null,
    formula: '单流上限 = 实测可达带宽 / (权重 + 该上下文下每 token 的 KV 读量)',
    inputs: { achievableBandwidthGBps: bw, bytesPerTokenGB: bpt.total, weightsGB: bpt.weights, kvGB: bpt.kv, contextLength: bpt.contextLength },
    provenance: {
      achievableBandwidthGBps: prov(ctx, 'hardware.achievableBandwidthGBps'),
      bytesPerTokenGB: prov(ctx, 'model.bytesPerTokenGB'),
      kvBytesPerTokenPerCtx: prov(ctx, 'model.kvBytesPerTokenPerCtx'),
      stateCacheBytesPerToken: prov(ctx, 'model.stateCacheBytesPerToken'),
    },
    conditionalOn,
    sanity,
    breakdown: bpt,
  }
}

/**
 * 收集限定条件。
 * **至少要有一条是实现域的**（kernel 实现 / 状态缓存格式 / 量化精度），
 * 否则这个天花板不成立为"物理意义上界" —— 它只是"当前实现下的观测"。
 */
export function resolveConditional(ctx, extra = null) {
  if (Array.isArray(extra) && extra.length > 0) return extra
  const out = []
  const kernel = resolve(ctx, 'engine.kernelImplementation')
  const engineImage = resolve(ctx, 'engine.image')
  const kv = resolve(ctx, 'model.kvPrecision') ?? resolve(ctx, 'engine.kvCacheDtype')
  const quant = resolve(ctx, 'model.quantFormat')
  if (kernel) out.push({ kind: 'kernel', text: `当前 kernel 实现：${kernel}` })
  if (engineImage) out.push({ kind: 'engine', text: `引擎镜像：${engineImage}` })
  if (kv) out.push({ kind: 'cache', text: `状态缓存格式：${kv}` })
  if (quant) out.push({ kind: 'quant', text: `量化精度：${quant}` })
  return out
}

/** 证据链：从原始实测到天花板，每一步都带来源，可被独立复核。 */
export function evidenceChain(ctx, ceiling = null) {
  const c = ceiling ?? singleStreamCeiling(ctx)
  const nodes = []
  const push = (step, fact, value, unit, source) => nodes.push({ step, fact, value, unit, source })

  push(1, '实测可达带宽（本机微基准）', num(resolve(ctx, 'hardware.achievableBandwidthGBps')), 'GB/s', prov(ctx, 'hardware.achievableBandwidthGBps'))
  push(2, '每 token 权重读量', c.breakdown?.weights ?? null, 'GB', prov(ctx, 'model.bytesPerTokenGB'))
  if (c.breakdown?.kv !== null && c.breakdown?.kv !== undefined) {
    push(3, `每 token KV 读量（上下文 ${c.breakdown.contextLength}）`, c.breakdown.kv, 'GB', c.breakdown.kvForm ?? 'adapter')
  }
  push(4, '每 token 总访存', c.breakdown?.total ?? null, 'GB', 'derived')
  push(5, '单流理论上限 = 1 / 4', c.ceilingTps, 'tok/s', 'derived')
  push(6, '实测单流吞吐', c.currentTps, 'tok/s', prov(ctx, 'measurements.singleStreamTps'))
  push(7, '利用率 = 6 / 5', c.utilization, '×', 'derived')
  return {
    schemaVersion: CEILING_SCHEMA_VERSION,
    ceilingTps: c.ceilingTps,
    nodes,
    sanity: c.sanity,
    conditionalOn: c.conditionalOn,
    verifiable: nodes.every((n) => n.source !== 'assumed-default' || n.value === null),
    note: '链路每一环都写了来源。要否证这个天花板，只需指出某一环的来源不成立（例如第 1 环用了规格书峰值）。',
  }
}
