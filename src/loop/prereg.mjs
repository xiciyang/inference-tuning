/**
 * 预注册与判定 —— "**搜索只是验证手段，不是发现手段**" 的落地件。
 *
 * 要防的失败模式：**事后择优**。
 * 跑完一堆配置，挑一个看起来最好的，再回过头编一个"我本来就想验证这个"的说法。
 * 那不是在验证假设，那是在给已经发生的结果找理由。
 *
 * 做法：**执行之前**把下面的东西写下来并算出指纹，执行后再判定。
 *
 *   · 假设是什么（一句话）
 *   · 预期**哪个指标**动、往**哪个方向**动、**至少动多少**
 *   · 聚合口径（peak / median / p95 …）
 *   · 样本量
 *   · **什么结果会否证它**（必填 —— 不可证伪的假设等于没提）
 *
 * 三道附加检查：
 *   `checkEffectAssertions`      效应断言必须具体（指标 + 方向 + 幅度），不能是"会变好"
 *   `checkVerificationStrength`  验证强度必须够（样本量、聚合口径、是否有对照）
 *   `checkInstrumentSelfMatch`   **仪器必须看得见它所声称的效应** ——
 *                                 若声称 1% 的提升而测量的噪声就有 5%，
 *                                 那这个仪器原理上无法确认该效应，无论跑多少次
 *
 * 最后一条是最容易被忽略、也最致命的：它把"我没测出来"与"它不存在"区分开。
 */

export const PREREG_SCHEMA_VERSION = '1.0.0'

export const PREREG_VERDICT = Object.freeze({
  OK: 'ok',
  VAGUE_EFFECT: 'vague-effect',
  WEAK_VERIFICATION: 'weak-verification',
  INSTRUMENT_MISMATCH: 'instrument-mismatch',
})

export const JUDGE_VERDICT = Object.freeze({
  CONFIRMED: 'confirmed',
  FALSIFIED: 'falsified',
  INCONCLUSIVE: 'inconclusive',
})

export const EFFECT_ASSERTION = Object.freeze({
  DIRECTION: Object.freeze(['increase', 'decrease']),
  // 允许的聚合口径（与 validity/performance.mjs 的 AGGREGATION 同源）
  AGGREGATION: Object.freeze(['peak', 'min', 'mean', 'median', 'expected', 'p50', 'p95', 'p99', 'sum']),
})

const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 简单稳定指纹：用于事后证明"这份预注册确实在跑之前就写了"。 */
function fingerprint(obj) {
  const s = JSON.stringify(obj, Object.keys(obj).sort())
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i += 1) {
    h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 16777619)
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519)
  }
  return `pr_${(((h1 >>> 0) * 4294967296 + (h2 >>> 0)) >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * 登记一次预注册。
 * **在干预执行之前调用**，返回值必须随报告落盘（含指纹与时间戳）。
 */
export function preregister({
  hypothesis, metric, direction, minEffectPct, aggregation, samples,
  falsify, wallId = null, lever = null, expectedValue = null, now = null,
} = {}) {
  const reg = {
    schemaVersion: PREREG_SCHEMA_VERSION,
    hypothesis: hypothesis ?? null,
    wallId, lever,
    effect: { metric: metric ?? null, direction: direction ?? null, minEffectPct: num(minEffectPct), expectedValue: num(expectedValue) },
    aggregation: aggregation ?? null,
    samples: num(samples),
    falsify: falsify ?? null,
    registeredAt: new Date(now ?? Date.now()).toISOString(),
  }
  reg.fingerprint = fingerprint({
    hypothesis: reg.hypothesis, wallId, lever,
    metric: reg.effect.metric, direction: reg.effect.direction, minEffectPct: reg.effect.minEffectPct,
    aggregation: reg.aggregation, samples: reg.samples, falsify: reg.falsify,
  })

  const a = checkEffectAssertions(reg)
  const v = checkVerificationStrength(reg)
  return {
    ...reg,
    verdict: a.verdict !== PREREG_VERDICT.OK ? a.verdict : v.verdict,
    problems: [...a.problems, ...v.problems],
    registered: a.verdict === PREREG_VERDICT.OK && v.verdict === PREREG_VERDICT.OK,
  }
}

/** 效应断言必须具体：指标 + 方向 + 幅度。 */
export function checkEffectAssertions(reg = {}) {
  const problems = []
  const e = reg.effect ?? {}
  if (!e.metric) problems.push({ code: 'no-metric', detail: '没写预期哪个指标动' })
  if (!e.direction) problems.push({ code: 'no-direction', detail: '没写预期往哪个方向动' })
  else if (!EFFECT_ASSERTION.DIRECTION.includes(e.direction)) {
    problems.push({ code: 'bad-direction', detail: `方向 "${e.direction}" 非法，允许：${EFFECT_ASSERTION.DIRECTION.join(', ')}` })
  }
  if (e.minEffectPct === null) problems.push({ code: 'no-magnitude', detail: '没写"至少动多少" —— "会变好"不是可判定的断言' })
  else if (e.minEffectPct < 0) problems.push({ code: 'negative-magnitude', detail: `幅度不能为负（${e.minEffectPct}）；方向已由 direction 表达` })
  if (!reg.falsify) problems.push({ code: 'no-falsifier', detail: '没写"什么结果会否证它" —— 不可证伪的假设不得登记' })
  if (!reg.hypothesis) problems.push({ code: 'no-hypothesis', detail: '没写假设本身' })
  return {
    gate: 'effect-assertions',
    verdict: problems.length === 0 ? PREREG_VERDICT.OK : PREREG_VERDICT.VAGUE_EFFECT,
    problems,
  }
}

/** 验证强度：聚合口径 + 样本量。 */
export function checkVerificationStrength(reg = {}, { minSamples = 6 } = {}) {
  const problems = []
  if (!reg.aggregation) {
    problems.push({ code: 'no-aggregation', detail: '没声明聚合口径 —— 同一个数按峰值与中位数读会得出相反结论' })
  } else if (!EFFECT_ASSERTION.AGGREGATION.includes(reg.aggregation)) {
    problems.push({ code: 'bad-aggregation', detail: `聚合口径 "${reg.aggregation}" 非法，允许：${EFFECT_ASSERTION.AGGREGATION.join(', ')}` })
  }
  const n = num(reg.samples)
  if (n === null) problems.push({ code: 'no-samples', detail: '没声明样本量' })
  else if (n < minSamples) problems.push({ code: 'too-few-samples', detail: `样本量 ${n} < ${minSamples}：这个强度不足以支撑"有提升"的结论` })
  return {
    gate: 'verification-strength',
    verdict: problems.length === 0 ? PREREG_VERDICT.OK : PREREG_VERDICT.WEAK_VERIFICATION,
    problems,
  }
}

/**
 * **仪器自洽**：仪器必须看得见它所声称的效应。
 *
 * 若声称至少 1% 的提升，而同一配置重复测量的相对波动（噪声）就有 5%，
 * 那么这个仪器**原理上**无法确认该效应 —— 跑再多次也只是在噪声里挑一个好看的数。
 *
 * 判据（可推导，不需要魔数）：`claimedMinEffectPct >= noisePct`。
 * 等号允许，但要在报告里标注"边际"。
 */
export function checkInstrumentSelfMatch({ minEffectPct = null, noisePct = null, samples = null, noiseSamples = null } = {}) {
  const claim = num(minEffectPct)
  const noise = num(noisePct)
  const problems = []
  if (claim === null) problems.push({ code: 'no-claimed-effect', detail: '没给声称的最小效应' })
  if (noise === null) {
    problems.push({
      code: 'no-noise-estimate',
      detail: '没给测量噪声估计 —— 不给噪声就无法判断"没测出来"到底是"不存在"还是"看不见"',
    })
  }
  let ratio = null
  if (claim !== null && noise !== null) {
    ratio = noise === 0 ? Infinity : claim / noise
    if (noise > claim) {
      problems.push({
        code: 'effect-below-noise',
        detail: `声称的最小效应 ${claim}% **小于**测量噪声 ${noise}% —— `
          + '该仪器原理上无法确认这个效应。此时"没观察到提升"不能推出"没有提升"，'
          + '只能说"看不见"。要么提高信噪比（加样本/换口径），要么放弃这个量级的断言。',
      })
    } else if (noise > claim * 0.5) {
      problems.push({
        code: 'effect-near-noise',
        detail: `声称的最小效应 ${claim}% 与噪声 ${noise}% 同量级（比值 ${ratio.toFixed(2)}）—— 属于边际，结论必须标注为弱证据`,
      })
    }
  }
  const hard = problems.filter((p) => p.code === 'effect-below-noise' || p.code === 'no-noise-estimate' || p.code === 'no-claimed-effect')
  return {
    gate: 'instrument-self-match',
    verdict: hard.length === 0 ? PREREG_VERDICT.OK : PREREG_VERDICT.INSTRUMENT_MISMATCH,
    signalToNoise: ratio,
    claimedMinEffectPct: claim,
    noisePct: noise,
    samples, noiseSamples,
    problems,
    rule: '仪器看不见的效应，测多少次都看不见 —— 这属于"测量不成立"，不是"没有效应"。',
  }
}

/**
 * 判定：拿**预注册**去对**实测结果**。
 *
 * 只有三种结局，没有第四种：
 *   confirmed   —— 方向对且幅度达到预注册的最低要求
 *   falsified   —— 方向相反，或幅度未达（且测量成立）
 *   inconclusive—— **测量不成立**（此时既不能确认也不能否证）
 */
export function judge({ registration = null, observed = null, measurementValid = true, measurementReasons = [] } = {}) {
  if (!registration) {
    return { verdict: JUDGE_VERDICT.INCONCLUSIVE, reason: '没有预注册 —— 事后判定不成立（这正是预注册要防的）' }
  }
  if (!registration.registered) {
    return {
      verdict: JUDGE_VERDICT.INCONCLUSIVE,
      reason: '预注册本身不合格，不能用来判定',
      problems: registration.problems ?? [],
    }
  }
  if (measurementValid === false) {
    return {
      verdict: JUDGE_VERDICT.INCONCLUSIVE,
      reason: '测量不成立 —— 此时既不能确认也不能否证该假设。先修测量再判。',
      measurementReasons,
    }
  }
  const e = registration.effect
  const value = num(observed?.[e.metric])
  if (value === null) {
    return { verdict: JUDGE_VERDICT.INCONCLUSIVE, reason: `结果里没有 ${e.metric} 的实测值` }
  }
  const deltaPct = num(observed?.deltaPct)
  const signed = e.direction === 'decrease' ? -1 : 1
  const effectiveDelta = deltaPct === null ? null : deltaPct * signed
  const meetsMagnitude = effectiveDelta !== null && effectiveDelta >= e.minEffectPct

  return {
    verdict: meetsMagnitude ? JUDGE_VERDICT.CONFIRMED : JUDGE_VERDICT.FALSIFIED,
    metric: e.metric,
    direction: e.direction,
    minEffectPct: e.minEffectPct,
    observedValue: value,
    observedDeltaPct: deltaPct,
    effectiveDeltaPct: effectiveDelta,
    aggregation: registration.aggregation,
    fingerprint: registration.fingerprint,
    reason: meetsMagnitude
      ? `方向与幅度都满足预注册（${e.metric} ${e.direction} ≥ ${e.minEffectPct}%，实测有效变化 ${effectiveDelta.toFixed(2)}%）`
      : (effectiveDelta === null
        ? '没有相对变化量，无法判定'
        : `未达预注册幅度（要求 ${e.direction} ≥ ${e.minEffectPct}%，实测有效变化 ${effectiveDelta.toFixed(2)}%）`),
  }
}

/**
 * 事后才写的"预注册"要被抓出来。
 * 判据：指纹里的登记时间必须早于干预执行时间。
 */
export function checkPreregTiming({ registration = null, executedAt = null, toleranceMs = 1000 } = {}) {
  if (!registration?.registeredAt) {
    return { ok: false, code: 'no-registration-time', detail: '预注册没有登记时间' }
  }
  const reg = new Date(registration.registeredAt).getTime()
  const exec = new Date(executedAt ?? Date.now()).getTime()
  if (!Number.isFinite(reg) || !Number.isFinite(exec)) {
    return { ok: false, code: 'bad-time', detail: '时间戳不可解析' }
  }
  if (reg > exec + toleranceMs) {
    return {
      ok: false,
      code: 'registered-after-execution',
      detail: `预注册时间 ${registration.registeredAt} **晚于**执行时间 —— 这是事后补写的预注册，不构成预注册`,
      registeredAt: registration.registeredAt, executedAt,
    }
  }
  return { ok: true, code: null, leadMs: exec - reg }
}
