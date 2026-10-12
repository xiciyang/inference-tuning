/**
 * 双门禁判定：**性能**与**精度**，且每一侧都要先判"测量是否成立"。
 *
 * 用户裁决（沿用 quantization 已固化的口径，本包不重新发明）：
 *   ① **阈值必须由调用方传入**：调用方 > `~/.ai-infra/config/gates.yaml` > **两者都无则拒绝**
 *      （`E_THRESHOLD_NOT_PROVIDED`）。调优插件不能自己定"可以掉多少精度"然后自己签收。
 *   ② **门禁不仅判"数值是否达标"，还要判"测量是否成立"**。
 *   ③ 接近上限要停下确认（相对阈值的比例，不是绝对魔数）。
 *
 * 本模块是**纯函数**：不发请求、不读文件、不写状态 —— 判定与测量彻底分离，
 * 于是判定可以被穷举测试，测量端可以被独立复核。
 */
import { fail, warn, ERROR_CODES, WARNING_CODES } from './errors.mjs'
import { evaluatePerformanceValidity } from './validity/performance.mjs'

export const GATE_SCHEMA_VERSION = '1.0.0'
export const GATE_FIELDS = ['max_accuracy_drop_pct', 'min_perf_gain_pct']

// ---------------------------------------------------------------- 阈值

/**
 * 解析阈值：显式参数 > gates.yaml > 拒绝。
 * @returns {{maxAccuracyDropPct, minPerfGainPct, nearLimitFactor, source}}
 */
export function resolveThresholds(runtime, { maxAccuracyDropPct = null, minPerfGainPct = null, nearLimitFactor = null } = {}) {
  const file = runtime?.policy?.gates ?? null
  const pick = (explicit, key) => {
    if (explicit !== null && explicit !== undefined && Number.isFinite(Number(explicit))) {
      return { value: Number(explicit), from: 'caller' }
    }
    const v = file?.[key]
    if (v !== undefined && v !== null && Number.isFinite(Number(v))) return { value: Number(v), from: 'gates.yaml' }
    return { value: null, from: null }
  }
  const acc = pick(maxAccuracyDropPct, 'max_accuracy_drop_pct')
  const perf = pick(minPerfGainPct, 'min_perf_gain_pct')
  const nl = pick(nearLimitFactor, 'near_limit_factor')

  const missing = []
  if (acc.value === null) missing.push('max_accuracy_drop_pct（精度容忍）')
  if (perf.value === null) missing.push('min_perf_gain_pct（性能收益目标）')
  if (missing.length > 0) {
    fail(ERROR_CODES.E_THRESHOLD_NOT_PROVIDED, `缺少门禁阈值：${missing.join('、')}`, {
      remediation: '在调用里传 options.max_accuracy_drop_pct / min_perf_gain_pct，'
        + `或把它们写进 ${runtime?.paths?.gatesFile ?? '~/.ai-infra/config/gates.yaml'}。`
        + '本插件**不会**替你猜一个默认阈值 —— 那会让"门禁独立"名存实亡。',
      details: { missing, gatesFile: runtime?.paths?.gatesFile ?? null, policySource: runtime?.policy?.sources?.gates ?? null },
    })
  }
  if (acc.value < 0) {
    fail(ERROR_CODES.E_THRESHOLD_NOT_PROVIDED, `max_accuracy_drop_pct 不能为负：${acc.value}`, {
      remediation: '精度损失容忍应为非负数（0 表示不容忍任何下降）。', details: { value: acc.value },
    })
  }
  return {
    maxAccuracyDropPct: acc.value,
    minPerfGainPct: perf.value,
    nearLimitFactor: nl.value ?? 0.9,
    source: { maxAccuracyDropPct: acc.from, minPerfGainPct: perf.from, nearLimitFactor: nl.from },
  }
}

// ---------------------------------------------------------------- 单侧数值门禁

export function evaluatePerfGate({ gainPct, thresholdPct, nearLimitFactor = 0.9 }) {
  if (gainPct === null || gainPct === undefined || !Number.isFinite(Number(gainPct))) {
    return { passed: false, undetermined: true, reason: '性能收益未测得' }
  }
  const g = Number(gainPct)
  const passed = g >= thresholdPct
  // 接近上限：目标 0 时退化为"只要非负即达标"，此时不存在"接近上限"的概念
  const ratio = thresholdPct > 0 ? g / thresholdPct : Infinity
  const nearLimit = passed && thresholdPct > 0 && ratio < 1.1
  return {
    passed,
    gainPct: g,
    thresholdPct,
    marginPct: g - thresholdPct,
    ratioOfThreshold: Number.isFinite(ratio) ? Number(ratio.toFixed(4)) : null,
    nearLimit,
    nearLimitFactor,
    reason: passed
      ? `性能收益 ${g.toFixed(2)}% ≥ 目标 ${thresholdPct}%`
      : `性能收益 ${g.toFixed(2)}% < 目标 ${thresholdPct}%`,
  }
}

export function evaluateAccuracyGate({ dropPct, thresholdPct, nearLimitFactor = 0.9 }) {
  if (dropPct === null || dropPct === undefined || !Number.isFinite(Number(dropPct))) {
    return { passed: false, undetermined: true, reason: '精度损失未测得' }
  }
  const d = Number(dropPct)
  const passed = d <= thresholdPct
  const ratio = thresholdPct > 0 ? d / thresholdPct : (d <= 0 ? 0 : Infinity)
  const nearLimit = passed && ratio >= nearLimitFactor
  return {
    passed,
    dropPct: d,
    thresholdPct,
    marginPct: thresholdPct - d,
    ratioOfThreshold: Number.isFinite(ratio) ? Number(ratio.toFixed(4)) : null,
    nearLimit,
    nearLimitFactor,
    reason: passed
      ? (nearLimit
        ? `精度损失 ${d.toFixed(3)}% 已达阈值的 ${(ratio * 100).toFixed(0)}%（接近上限）`
        : `精度损失 ${d.toFixed(3)}% ≤ 阈值 ${thresholdPct}%`)
      : `精度损失 ${d.toFixed(3)}% > 阈值 ${thresholdPct}%`,
  }
}

// ---------------------------------------------------------------- 精度测量成立性（三闸）

/**
 * **精度测量的成立性三闸** —— 与 `inference-quantization` 的实现同构
 * （契约 = `docs/parity-contract.md`，单一事实来源；一致性由 CI 检查断言）。
 *
 *   ① **均匀输出签名**：|meanNll − ln(vocab_size)| ≤ tol ⇒ 模型输出近似均匀分布
 *   ② **无区分力**：前后两次 meanNll **逐位相同** ⇒ 该数不依赖权重
 *   ③ **与输入无关**：逐条 meanNll **极差 = 0** ⇒ 与输入无关，不构成一次测量
 *
 * ① 用**相对词表大小**而不是 "ppl > 1000" 这类魔数：均匀输出的困惑度在数学上恒等于
 * 词表大小，这是一个可推导的等式。
 * ③ 用**极差**而不是标准差：标准差要先求和再相除，浮点误差会让"全都相同"算出 ~1e-15，
 * 于是必须引入容差魔数；极差是精确比较，不需要任何阈值。
 */
/**
 * @param {object} spec
 * @param {boolean} spec.sameWeights
 *   **两侧是否服务同一份权重。** 这个开关很关键，它决定第②条闸适不适用：
 *
 *   · `false`（quantization：前后是**不同产物**）—— 两个不同权重给出逐位相同的 meanNll
 *     是不可能的，因此"逐位相同"是**测量退化**的强证据。第②条闸必须生效。
 *
 *   · `true`（tuning：前后是**同一份权重**、只是运行时配置不同）—— 逐位相同是
 *     **预期结果**，不是缺陷。此时用第②条闸会**误杀一切合法的保权重调优**。
 *     第②条被替换为 `reproducibility` 要求：测量仍须过①（均匀输出签名）、
 *     ③（逐条极差）与测量端自报的权重健康度。
 *
 *   这就是"同一个判据在不同语义下含义相反"的典型 —— 契约里把它写成了显式参数，
 *   而不是让实现各自猜。
 */
export function assertAccuracyMeasurementValid({ before, after, toleranceNats = 1e-4, sameWeights = false } = {}) {
  const reasons = []
  const checks = { toleranceNats, sameWeights }

  const side = (name, r) => {
    if (!r) {
      reasons.push({ code: 'missing-side', message: `${name} 侧没有测量结果` })
      return
    }
    const scored = r.scoredSamples ?? null
    if (scored !== null && scored <= 0) {
      reasons.push({ code: 'no-scored-samples', message: `${name} 侧没有任何样本评分成功` })
    }
    if (r.validity && r.validity.valid === false) {
      for (const x of r.validity.reasons ?? []) {
        reasons.push({ code: `sidecar:${x.code ?? 'invalid'}`, message: `${name} 侧自报测量不成立：${x.detail ?? x.code ?? ''}` })
      }
    }
    const vocab = r.vocabSize ?? null
    const meanNll = Number(r.meanNll)
    if (vocab && Number.isFinite(meanNll)) {
      const uniformLoss = Math.log(vocab)
      const gap = Math.abs(meanNll - uniformLoss)
      checks[`${name}UniformGap`] = gap
      checks[`${name}VocabSize`] = vocab
      checks[`${name}UniformLoss`] = uniformLoss
      if (gap <= toleranceNats) {
        reasons.push({
          code: 'uniform-output',
          message: `${name} 侧 meanNll=${meanNll} 与 ln(vocab_size)=${uniformLoss} 相差 ${gap.toExponential(2)} ≤ ${toleranceNats}`
            + ' —— 模型输出近似均匀分布，此时"精度损失"没有区分力',
        })
      }
    } else {
      checks[`${name}UniformGap`] = null
    }
    const items = r.itemMeanNlls ?? null
    if (Array.isArray(items) && items.length > 1) {
      let min = Infinity
      let max = -Infinity
      for (const x of items) {
        if (typeof x !== 'number' || !Number.isFinite(x)) continue
        if (x < min) min = x
        if (x > max) max = x
      }
      const range = max - min
      checks[`${name}ItemMeanNllRange`] = Number.isFinite(range) ? range : null
      if (range === 0) {
        reasons.push({
          code: 'no-item-variance',
          message: `${name} 侧 ${items.length} 条样本的逐条 meanNll 逐位相同（极差 = 0）—— 该数与输入无关，不构成一次测量`,
        })
      }
    }
  }

  side('before', before)
  side('after', after)

  if (before && after) {
    const b = Number(before.meanNll)
    const a = Number(after.meanNll)
    const identical = Number.isFinite(b) && Number.isFinite(a) && b === a
    checks.bitIdenticalMeanNll = identical
    if (identical && !sameWeights) {
      reasons.push({
        code: 'indiscriminate',
        message: `前后 meanNll 逐位相同（${b}）：两个**不同产物**给出同一个数，`
          + '说明该测量不依赖被改的东西 —— 退化的"精度零损失"不能作为"精度不降"的证据',
      })
    }
    if (identical && sameWeights) {
      // 预期之内：记录事实，但不判不合格
      checks.reproducibility = {
        sameWeights: true,
        note: '两侧服务同一份权重（本次调优的参数均在允许集内，不改变权重与缓存格式），'
          + '因此 meanNll 逐位相同是**预期结果**。测量成立性由 ① 均匀输出签名、③ 逐条极差、'
          + '以及测量端自报的权重健康度共同保证（第②条闸在此语义下不适用）。',
      }
    }
  }

  return { valid: reasons.length === 0, reasons, checks }
}

// ---------------------------------------------------------------- 汇总

/**
 * 双侧门禁合并判定（含"测量是否成立"）。
 *
 * @param {{
 *   perf: {gainPct}, accuracy: {dropPct}, thresholds,
 *   performanceValidity?: {valid, reasons, gates},   // 性能四闸（validity/performance.mjs）
 *   accuracyValidity?: {valid, reasons, checks},     // 精度三闸
 * }} spec
 * @returns {{passed, decision, signable, reasons, ...}}
 *   decision ∈ 'accept' | 'confirm-near-limit' | 'rollback' | 'undetermined'
 */
export function evaluateGates({
  perf = null, accuracy = null, thresholds,
  performanceValidity = null, accuracyValidity = null,
} = {}) {
  const pf = evaluatePerfGate({
    gainPct: perf?.gainPct ?? null,
    thresholdPct: thresholds.minPerfGainPct,
    nearLimitFactor: thresholds.nearLimitFactor ?? 0.9,
  })
  const acc = evaluateAccuracyGate({
    dropPct: accuracy?.dropPct ?? null,
    thresholdPct: thresholds.maxAccuracyDropPct,
    nearLimitFactor: thresholds.nearLimitFactor ?? 0.9,
  })

  const reasons = []
  const perfInvalid = Boolean(performanceValidity && performanceValidity.valid === false)
  const accInvalid = Boolean(accuracyValidity && accuracyValidity.valid === false)

  // 理由里带上是哪一道闸的 code —— 否则调用方只知道"测量不成立"，
  // 不知道是聚合口径没声明、还是稳态窗口不够、还是均匀输出签名命中。
  if (perfInvalid) for (const r of performanceValidity.reasons ?? []) reasons.push(`性能测量[${r.code ?? r.gate ?? 'unknown'}]：${r.reason ?? r.message ?? ''}`)
  if (accInvalid) for (const r of accuracyValidity.reasons ?? []) reasons.push(`精度测量[${r.code ?? 'unknown'}]：${r.message ?? ''}`)

  if (acc.undetermined) reasons.push(`精度：${acc.reason}`)
  else if (!acc.passed) reasons.push(`精度：${acc.reason}`)
  if (pf.undetermined) reasons.push(`性能：${pf.reason}`)
  else if (!pf.passed) reasons.push(`性能：${pf.reason}`)

  const measurementInvalid = perfInvalid || accInvalid

  let decision
  if (measurementInvalid || acc.undetermined || pf.undetermined) decision = 'undetermined'
  else if (acc.passed && pf.passed) decision = (acc.nearLimit || pf.nearLimit) ? 'confirm-near-limit' : 'accept'
  else decision = 'rollback'

  return {
    schemaVersion: GATE_SCHEMA_VERSION,
    // 只有"数值达标 ∧ 决策为 accept ∧ 测量成立"三条同时成立才算通过
    passed: !measurementInvalid && acc.passed === true && pf.passed === true,
    decision,
    signable: decision === 'accept',
    needsConfirmation: decision === 'confirm-near-limit',
    measurementValid: (performanceValidity || accuracyValidity)
      ? (!perfInvalid && !accInvalid)
      : null,
    performanceValidity: performanceValidity ?? null,
    accuracyValidity: accuracyValidity ?? null,
    accuracy: acc,
    perf: pf,
    thresholds,
    reasons: reasons.length ? reasons : [acc.reason, pf.reason],
  }
}

/** 接近上限时的确认令牌（绑定具体目标，避免"一个令牌确认一切"）。 */
export function nearLimitTokenFor({ model, configKey, dropPct, gainPct }) {
  const seed = `${model}|${configKey}|${Number(dropPct).toFixed(3)}|${Number(gainPct).toFixed(3)}`
  return `nlt_${Buffer.from(seed).toString('hex').slice(0, 20)}`
}

/** 便利：把两侧测量拼成可直接喂给 `evaluateGates` 的成立性对象。 */
export function buildValidity({ performance = null, accuracy = null } = {}) {
  return {
    performanceValidity: performance ? evaluatePerformanceValidity(performance) : null,
    accuracyValidity: accuracy ? assertAccuracyMeasurementValid(accuracy) : null,
  }
}

export { warn, WARNING_CODES }
