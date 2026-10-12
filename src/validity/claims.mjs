/**
 * 主张门禁 —— 报告里的每一句话都要带上它的**出处等级**。
 *
 * 要防的失败模式：**把推断当成实测讲出去**。
 * 一旦"我算出来的"与"我量到的"在报告里长得一样，读的人就再也分不清哪些能信、
 * 哪些只是合理猜测 —— 而这正是要用户逐条排查的根源。
 *
 * 四级出处（**从严到宽**）：
 *
 *   measured  本机实测（微基准 / 引擎实报 / 文件扫描）
 *   derived   由上一步**可复核地**推出（例如 上限 = 实测带宽 / 实测访存量）
 *   inferred  由观察合理推断，**没有被直接验证**（必须给出"如何否证"）
 *   assumed   用了默认假设（必须在报告里点名）
 *
 * `spec-sheet` **不是等级，是禁用项**：规格书峰值不得作为承重输入（见 walls/index.mjs）。
 *
 * 门禁的输出是**判定**，不是警告：不合格的主张不允许以陈述句出现在报告的承重位置上。
 */

export const CLAIM_SCHEMA_VERSION = '1.0.0'

export const PROVENANCE = Object.freeze({
  MEASURED: 'measured',
  DERIVED: 'derived',
  INFERRED: 'inferred',
  ASSUMED: 'assumed',
  SPEC_SHEET: 'spec-sheet',
})

export const PROVENANCE_RANK = Object.freeze({
  measured: 0,
  derived: 1,
  inferred: 2,
  assumed: 3,
})

export const CLAIM_VERDICT = Object.freeze({
  OK: 'ok',
  NEEDS_FALSIFIER: 'needs-falsifier',
  NEEDS_EVIDENCE: 'needs-evidence',
  FORBIDDEN_SOURCE: 'forbidden-source',
  MISPROMOTED: 'mispromoted',
})

/** 禁止作为承重输入的出处。**不是等级，是禁用项。** */
export const FORBIDDEN_PROVENANCE = Object.freeze([PROVENANCE.SPEC_SHEET, 'theoretical-peak', 'datasheet'])

/**
 * 单条主张的门禁。
 *
 * @param {{
 *   claim: string,            // 主张本身（一句话）
 *   provenance: string,       // 上面四级之一
 *   evidence?: any,           // measured/derived 必须有；inferred 必须有 basis
 *   basis?: string,           // inferred 的推断依据
 *   falsifiableBy?: string,   // inferred **必须**给"什么观察能证伪它"
 *   assertedAs?: string,      // 报告里实际怎么写的（用来查"有没有被升格"）
 * }} spec
 */
export function gateClaim({ claim, provenance, evidence = null, basis = null, falsifiableBy = null, assertedAs = null } = {}) {
  const reasons = []
  if (!claim || typeof claim !== 'string') {
    return { schemaVersion: CLAIM_SCHEMA_VERSION, verdict: CLAIM_VERDICT.NEEDS_EVIDENCE, claim, reasons: [{ code: 'empty-claim', detail: '主张为空' }] }
  }
  if (!provenance) {
    return {
      schemaVersion: CLAIM_SCHEMA_VERSION,
      verdict: CLAIM_VERDICT.NEEDS_EVIDENCE,
      claim,
      reasons: [{ code: 'no-provenance', detail: '没有声明出处等级 —— 无出处的陈述不得进报告' }],
    }
  }
  if (FORBIDDEN_PROVENANCE.includes(provenance)) {
    return {
      schemaVersion: CLAIM_SCHEMA_VERSION,
      verdict: CLAIM_VERDICT.FORBIDDEN_SOURCE,
      claim, provenance,
      reasons: [{
        code: 'forbidden-provenance',
        detail: `出处 "${provenance}" 是**禁用项**（规格书/理论峰值不得作为承重输入）。`
          + '请改用本机实测值（微基准 / 引擎实报 / 文件扫描）。',
      }],
    }
  }
  if (!(provenance in PROVENANCE_RANK)) {
    return {
      schemaVersion: CLAIM_SCHEMA_VERSION,
      verdict: CLAIM_VERDICT.NEEDS_EVIDENCE,
      claim, provenance,
      reasons: [{ code: 'unknown-provenance', detail: `未知出处等级 "${provenance}"，允许值：${Object.keys(PROVENANCE_RANK).join(', ')}` }],
    }
  }

  if (provenance === PROVENANCE.MEASURED && (evidence === null || evidence === undefined)) {
    reasons.push({ code: 'measured-without-evidence', detail: '标成"实测"却没给证据（命令/文件/端点响应）' })
  }
  if (provenance === PROVENANCE.DERIVED && (evidence === null || evidence === undefined)) {
    reasons.push({ code: 'derived-without-inputs', detail: '标成"推导"却没给输入项 —— 推导链不可复核' })
  }
  if (provenance === PROVENANCE.INFERRED) {
    if (!basis) reasons.push({ code: 'inferred-without-basis', detail: '标成"推断"却没写推断依据' })
    if (!falsifiableBy) reasons.push({ code: 'inferred-without-falsifier', detail: '标成"推断"却没写"什么观察能证伪它" —— 不可证伪的推断等于没说' })
  }
  if (provenance === PROVENANCE.ASSUMED && !assertedAs) {
    // 允许，但必须能被点名；由调用方在报告 assumptions 里列出
  }

  // **升格检测**：写法上像结论，但出处只是推断/假设。
  //
  // 判据刻意用"结论标记词"而不是 ^ 锚定的单个"是" —— 后者会把
  // "这是缓存命中率" 这类普通陈述误判成升格。标记词是**只有在断言为真时才该出现**的词。
  if (assertedAs && [PROVENANCE.INFERRED, PROVENANCE.ASSUMED].includes(provenance)) {
    const markers = ['确实', '已经证明', '证明了', '证实', '确认', '无疑', '显然成立']
    const en = /\b(proven|confirmed|established|definitively|conclusively)\b/i
    const hit = markers.find((m) => assertedAs.includes(m)) ?? (en.test(assertedAs) ? en.exec(assertedAs)[0] : null)
    if (hit) {
      reasons.push({
        code: 'promoted-inference',
        detail: `写法 "${assertedAs}" 用了结论标记词「${hit}」，但出处只是 ${provenance} 级 —— 这是**升格**`,
      })
    }
  }

  const verdict = reasons.length === 0
    ? CLAIM_VERDICT.OK
    : (reasons.some((r) => r.code.startsWith('inferred-without')) ? CLAIM_VERDICT.NEEDS_FALSIFIER : CLAIM_VERDICT.NEEDS_EVIDENCE)

  return {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    verdict,
    claim, provenance, basis, falsifiableBy, assertedAs,
    reasons,
    rule: '标成"实测/推导"必须给证据；标成"推断"必须给**否证条件**；规格书峰值是禁用项。',
  }
}

/**
 * 天花板类主张的门禁：**必须带限定条件，且至少一条是实现域的。**
 *
 * "单流上限 X tok/s" 脱离实现条件时没有意义 —— 换 kernel / 缓存格式 / 量化精度都会改分母。
 */
const IMPLEMENTATION_SCOPE_KINDS = new Set(['kernel', 'cache', 'quant'])

export function gateCeiling({ ceiling = null, conditions = null, claimedAs = 'physical-limit' } = {}) {
  const conds = conditions ?? ceiling?.conditionalOn ?? []
  const reasons = []
  if (!ceiling || ceiling.ceilingTps === null || ceiling.ceilingTps === undefined) {
    reasons.push({ code: 'no-ceiling', detail: '没有可用的天花板数值（缺实测可达带宽或每 token 访存量）' })
  }
  if (!Array.isArray(conds) || conds.length === 0) {
    reasons.push({ code: 'no-conditions', detail: '天花板没有限定条件 —— 脱离实现条件的"上限"不是上限，只是当前观测' })
  } else if (!conds.some((c) => IMPLEMENTATION_SCOPE_KINDS.has(c.kind))) {
    reasons.push({
      code: 'no-implementation-scope',
      detail: '限定条件里没有一条是实现域的（kernel 实现 / 状态缓存格式 / 量化精度）'
        + ' —— 按规则不得作为"物理上限"陈述',
    })
  }
  if (ceiling?.sanity && ceiling.sanity.ok === false) {
    reasons.push({ code: 'failed-sanity', detail: ceiling.sanity.warn })
  }
  if (claimedAs === 'physical-limit' && conds.length > 0) {
    // 允许，但必须把条件一起写出来
    if (!conds.every((c) => c.text)) reasons.push({ code: 'condition-without-text', detail: '有限定条件但没写成人话' })
  }
  return {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    verdict: reasons.length === 0 ? CLAIM_VERDICT.OK : CLAIM_VERDICT.NEEDS_FALSIFIER,
    ceilingTps: ceiling?.ceilingTps ?? null,
    conditions: conds,
    reasons,
    requiredWording: reasons.length === 0
      ? `可以说"在当前实现条件下（${conds.map((c) => c.text).join('；')}）单流上限约 ${Number(ceiling.ceilingTps).toFixed(1)} tok/s"`
      : '不得作为物理上限陈述；补齐限定条件后再说',
  }
}

/**
 * 数量类主张的门禁：数值必须带单位、聚合口径、样本数、出处。
 *
 * 少任何一项，这个数在事后都无法被复核 —— 而"无法复核的数"和"没有数"一样没用。
 */
export function gateQuantitative({ name = null, value = null, unit = null, aggregation = null, samples = null, provenance = null, evidence = null } = {}) {
  const reasons = []
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    reasons.push({ code: 'no-value', detail: `${name ?? '数值'} 没有可用的数值` })
  }
  if (!unit) reasons.push({ code: 'no-unit', detail: `${name ?? '数值'} 没有单位` })
  if (!aggregation) reasons.push({ code: 'no-aggregation', detail: `${name ?? '数值'} 没有聚合口径（peak/median/p95…）—— 同数不同读法结论相反` })
  if (samples === null || samples === undefined) reasons.push({ code: 'no-samples', detail: `${name ?? '数值'} 没有样本数` })
  else if (Number(samples) <= 0) reasons.push({ code: 'zero-samples', detail: `${name ?? '数值'} 的样本数为 ${samples}` })
  if (!provenance) reasons.push({ code: 'no-provenance', detail: `${name ?? '数值'} 没有出处等级` })
  else if (FORBIDDEN_PROVENANCE.includes(provenance)) reasons.push({ code: 'forbidden-provenance', detail: `${name ?? '数值'} 的出处 ${provenance} 是禁用项` })
  if (provenance === PROVENANCE.MEASURED && (evidence === null || evidence === undefined)) {
    reasons.push({ code: 'measured-without-evidence', detail: `${name ?? '数值'} 标为实测但没给证据` })
  }
  return {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    verdict: reasons.length === 0 ? CLAIM_VERDICT.OK : CLAIM_VERDICT.NEEDS_EVIDENCE,
    name, value, unit, aggregation, samples, provenance,
    reasons,
    rule: '数值 = 值 + 单位 + 聚合口径 + 样本数 + 出处，缺一不可复核。',
  }
}

/**
 * 推断类主张的门禁：必须写成可证伪的形式，且不得与实测结论并列排版。
 */
export function gateInferredClaim({ claim = null, basis = null, falsifiableBy = null, presentedAlongsideMeasured = false } = {}) {
  const reasons = []
  if (!claim) reasons.push({ code: 'empty-claim', detail: '推断为空' })
  if (!basis) reasons.push({ code: 'no-basis', detail: '没写推断依据' })
  if (!falsifiableBy) {
    reasons.push({
      code: 'no-falsifier',
      detail: '没写"什么观察能证伪它" —— 不可证伪的推断不得作为结论陈述（这是硬要求）',
    })
  }
  if (presentedAlongsideMeasured) {
    reasons.push({
      code: 'mixed-presentation',
      detail: '推断与实测结论并列排版会让人分不清 —— 报告中推断必须**单独成节**并显式标注',
    })
  }
  return {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    verdict: reasons.length === 0 ? CLAIM_VERDICT.OK : CLAIM_VERDICT.NEEDS_FALSIFIER,
    claim, basis, falsifiableBy,
    reasons,
    requiredWording: reasons.length === 0
      ? `应写成："**推断（未验证）**：${claim}。依据：${basis}。若观察到「${falsifiableBy}」则此推断不成立。"`
      : (reasons.some((r) => r.code === 'mixed-presentation')
        ? `把这条移出实测章节，单独成节并写成："**推断（未验证）**：${claim ?? '…'}。依据：${basis ?? '…'}。`
          + '若观察到「…」则此推断不成立。"'
        : '补齐依据与否证条件后再进报告'),
  }
}

/** 批量过门禁：报告落盘前的最后一道。任何一条不 OK 就不允许以陈述句出现在承重位置。 */
export function gateClaims(claims = []) {
  const results = claims.map((c) => {
    if (c.kind === 'ceiling') return { kind: 'ceiling', ...gateCeiling(c) }
    if (c.kind === 'quantitative') return { kind: 'quantitative', ...gateQuantitative(c) }
    if (c.kind === 'inferred') return { kind: 'inferred', ...gateInferredClaim(c) }
    return { kind: 'claim', ...gateClaim(c) }
  })
  const failed = results.filter((r) => r.verdict !== CLAIM_VERDICT.OK)
  return {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    total: results.length,
    ok: results.length - failed.length,
    failed: failed.length,
    allOk: failed.length === 0,
    results,
    failedDetails: failed.map((f) => ({ kind: f.kind, claim: f.claim ?? f.name, verdict: f.verdict, reasons: f.reasons.map((x) => x.code) })),
  }
}
