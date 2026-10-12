/**
 * 算子类别超额分析。
 *
 * 回答的问题：**"慢"到底慢在哪一类算子上** —— 是 attention、MLP、norm，还是采样/调度。
 *
 * 为什么要按**类别**而不是按单个算子排时间榜：
 * 单算子时间榜会把"这个 kernel 本身慢"与"这一类算子被调用了不该有的次数/规模"混在一起。
 * 类别超额回答的是后者 —— 它对应的是**结构性问题**（不该这么多次、不该这么大规模），
 * 而不是"这个 kernel 写得不好"。两者的干预完全不同。
 *
 * 判据用**可推导的比值**，不用魔数：
 *   excessRatio = 实测类别占比 / 架构算术预期占比
 *   预期占比来自模型的层数/维度算术（可由调用方给，或从 config 推）。
 *
 * **没有预期分布就不判超额。** 只报实测占比，并明说"缺预期分布，无法判超额" ——
 * 因为"占了 60%"本身没有对错：MLP 在 decode 阶段占大头本来就是正常的。
 */

export const CLASS_EXCESS_SCHEMA_VERSION = '1.0.0'

/** 常见的算子类别。允许调用方自定义，但**必须**在输入里显式给出。 */
export const OPERATOR_CLASSES = Object.freeze([
  'attention', 'mlp', 'norm', 'embedding', 'logits', 'sampling', 'scheduler', 'kv', 'communication', 'other',
])

/** 默认超额阈值：实测占比 ≥ 预期占比的 1.5 倍算"超额"。 */
export const DEFAULT_EXCESS_THRESHOLD = 1.5

const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * @param {{
 *   operators?: {name: string, class: string, ms: number, calls?: number, flops?: number, bytes?: number}[],
 *   expectedShare?: Record<string, number>,   // 架构算术预期占比（0..1）
 *   stepMs?: number,
 *   threshold?: number,
 * }} input
 */
export function analyzeClassExcess({
  operators = [], expectedShare = null, stepMs = null, threshold = DEFAULT_EXCESS_THRESHOLD,
} = {}) {
  const problems = []
  if (!Array.isArray(operators) || operators.length === 0) {
    return {
      schemaVersion: CLASS_EXCESS_SCHEMA_VERSION,
      usable: false,
      why: '没有算子级观测（需要每个算子的耗时与类别）',
      byClass: {}, ranked: [], excess: [], expectedShare: null,
    }
  }
  const bad = operators.filter((o) => !o?.class || num(o?.ms) === null)
  if (bad.length > 0) problems.push({ code: 'incomplete-operator-rows', detail: `${bad.length} 条算子记录缺 class 或 ms` })

  const byClass = {}
  for (const o of operators) {
    const c = o.class ?? 'other'
    if (!byClass[c]) byClass[c] = { ms: 0, calls: 0, operators: [] }
    byClass[c].ms += num(o.ms) ?? 0
    byClass[c].calls += num(o.calls) ?? 0
    byClass[c].operators.push(o.name ?? '(unnamed)')
  }
  const totalMs = Object.values(byClass).reduce((s, v) => s + v.ms, 0)
  const denominator = num(stepMs) ?? totalMs
  if (denominator <= 0) {
    return { schemaVersion: CLASS_EXCESS_SCHEMA_VERSION, usable: false, why: '总耗时为 0，无法计算占比', byClass, ranked: [], excess: [], expectedShare: null }
  }

  for (const [c, v] of Object.entries(byClass)) {
    v.share = v.ms / denominator
    v.sharePct = v.share * 100
  }

  const ranked = Object.entries(byClass)
    .map(([cls, v]) => ({ class: cls, ms: v.ms, share: v.share, sharePct: v.sharePct, calls: v.calls }))
    .sort((a, b) => b.ms - a.ms)

  // 没有预期分布 → **不判超额**
  if (!expectedShare || Object.keys(expectedShare).length === 0) {
    return {
      schemaVersion: CLASS_EXCESS_SCHEMA_VERSION,
      usable: true,
      canJudgeExcess: false,
      why: '缺**架构算术预期分布**，无法判超额 —— "占了 60%"本身没有对错，'
        + '（decode 阶段 MLP 占大头本来就是正常的）。请提供 expectedShare。',
      totalMs, stepMs: num(stepMs), denominator,
      byClass, ranked, excess: [], expectedShare: null,
      problems,
    }
  }

  const excess = []
  const deficit = []
  for (const [cls, expected] of Object.entries(expectedShare)) {
    const e = num(expected)
    if (e === null) continue
    const actual = byClass[cls]?.share ?? 0
    const ratio = e > 0 ? actual / e : null
    const row = {
      class: cls,
      expectedShare: e,
      expectedPct: e * 100,
      actualShare: actual,
      actualPct: actual * 100,
      excessRatio: ratio,
      excessMs: (actual - e) * denominator,
      verdict: ratio === null ? 'unknown' : (ratio >= threshold ? 'excess' : (ratio <= 1 / threshold ? 'deficit' : 'in-range')),
    }
    if (row.verdict === 'excess') excess.push(row)
    if (row.verdict === 'deficit') deficit.push(row)
  }
  excess.sort((a, b) => b.excessMs - a.excessMs)

  return {
    schemaVersion: CLASS_EXCESS_SCHEMA_VERSION,
    usable: true,
    canJudgeExcess: true,
    threshold,
    totalMs, stepMs: num(stepMs), denominator,
    byClass, ranked, excess, deficit, expectedShare,
    problems,
    conclusion: excess.length === 0
      ? '没有任何算子类别显著超出架构算术预期 —— 慢的原因更可能在"调用次数/规模"之外（如 kernel 效率、内存带宽、调度）'
      : `${excess[0].class} 超出预期 ${excess[0].excessRatio.toFixed(2)}×（多花 ${excess[0].excessMs.toFixed(1)} ms）`
        + ' —— 这是**结构性超额**，干预应针对"为什么这一类被算了这么多次/这么大规模"，而不是去优化单个 kernel',
  }
}

/**
 * 把类别超额折算成**端到端收益上界**。
 *
 * 口径：把超额部分压回预期占比，理论上能省多少毫秒、占总步时的百分之几。
 * 这是**上界**（假设能完全消除超额），必须如此标注。
 */
export function projectEndToEndGain({ classExcess = null, stepMs = null } = {}) {
  if (!classExcess?.canJudgeExcess) {
    return {
      schemaVersion: CLASS_EXCESS_SCHEMA_VERSION,
      projectable: false,
      why: classExcess?.why ?? '没有可判定的类别超额结果',
    }
  }
  const step = num(stepMs) ?? num(classExcess.stepMs) ?? num(classExcess.denominator)
  if (step === null || step <= 0) {
    return { schemaVersion: CLASS_EXCESS_SCHEMA_VERSION, projectable: false, why: '缺步总时长，无法折算成端到端收益' }
  }
  const rows = (classExcess.excess ?? []).map((e) => ({
    class: e.class,
    excessRatio: e.excessRatio,
    recoverableMs: e.excessMs,
    gainPctOfStep: (e.excessMs / step) * 100,
  }))
  const totalRecoverableMs = rows.reduce((s, r) => s + r.recoverableMs, 0)
  return {
    schemaVersion: CLASS_EXCESS_SCHEMA_VERSION,
    projectable: true,
    stepMs: step,
    rows,
    totalRecoverableMs,
    upperBoundGainPct: (totalRecoverableMs / step) * 100,
    boundKind: 'upper-bound',
    caveat: '这是**上界**：假设超额能被完全消除、且消除它不会把瓶颈转移到别处。'
      + '实际收益必须由闭环测量判定，不得把这个数当结论。',
  }
}

/** 从模型配置推出**粗粒度**的架构算术预期分布（decode 阶段）。 */
export function expectedShareFromConfig({
  config = {}, contextLength = null, batchSize = 1,
} = {}) {
  const layers = num(config.numHiddenLayers ?? config.num_layers)
  const hidden = num(config.hiddenSize ?? config.hidden_size)
  const kvHeads = num(config.numKeyValueHeads ?? config.num_key_value_heads)
  const heads = num(config.numAttentionHeads ?? config.num_attention_heads)
  const headDim = num(config.headDim ?? config.head_dim)
  const inter = num(config.intermediateSize ?? config.intermediate_size)
  const ctx = num(contextLength)

  const missing = []
  if (layers === null) missing.push('numHiddenLayers')
  if (hidden === null) missing.push('hiddenSize')
  if (heads === null) missing.push('numAttentionHeads')
  if (headDim === null) missing.push('headDim')
  if (inter === null) missing.push('intermediateSize')
  if (ctx === null) missing.push('contextLength')

  if (missing.length > 0) {
    return {
      schemaVersion: CLASS_EXCESS_SCHEMA_VERSION,
      computed: false,
      missing,
      why: `缺配置项：${missing.join(', ')}。**不猜** —— 猜错会让"预期分布"本身变成编出来的。`,
    }
  }

  // decode 阶段的每层算术量（按乘加算 FLOPs，不计激活/采样）
  const qDim = heads * headDim
  const kvDim = kvHeads * headDim
  // 注意力：q·k^T 与 attn·v，各 2×qDim×ctx（每 token）
  const attentionFlops = 2 * (2 * qDim * ctx)
  // 投影：q,k,v,o
  const projFlops = 2 * (hidden * qDim + hidden * kvDim * 2 + qDim * hidden)
  // MLP：gate+up+down（SwiGLU 三个矩阵）
  const mlpFlops = 2 * (3 * hidden * inter)
  const perLayer = { attention: attentionFlops + projFlops, mlp: mlpFlops }
  const total = layers * (perLayer.attention + perLayer.mlp)
  return {
    schemaVersion: CLASS_EXCESS_SCHEMA_VERSION,
    computed: true,
    batchSize,
    contextLength: ctx,
    perLayerFlops: perLayer,
    expectedShare: {
      attention: (layers * perLayer.attention) / total,
      mlp: (layers * perLayer.mlp) / total,
    },
    basis: '按架构算术的 per-layer FLOPs 推算（decode、每 token）。**这是算术量，不是实测**；'
      + '它只用于判断"某一类是不是被算了不该有的规模"，不用于判性能上限。',
    caveat: '未计入 norm/embedding/logits/sampling/调度 —— 因此两类占比之和为 1，'
      + '与实测的全类别占比比较时，应把实测里这两类的**相对占比**归一化后再比。',
  }
}
