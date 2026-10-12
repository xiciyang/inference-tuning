/**
 * **干预无效时的五因反思**（显式实现）。
 *
 * 用户长期指令：TOP1 干预若无效，**先停下反思五种原因，不许直接换参数再试**
 * （原话："搜索只是验证手段，不是发现手段"）。
 *
 * 旧引擎把这个判断散落在 `engine.mjs` 的多个决策分支里，没有显式化为一个可复核的函数 ——
 * 本包把它补成一个纯函数，输入是"干预前后两次测量 + 墙诊断 + 杠杆"，输出是
 * **按可排除性排序的假设**，每条都附"下一步该查什么"（而不是"再试一个参数"）。
 *
 * 排除顺序是刻意的，不可交换：
 *   ④ 测量不成立  → 如果数本身是坏的，后面四条全都不必谈
 *   ① 杠杆未生效  → 参数可能根本没传到引擎（被忽略/被覆盖/拼错）
 *   ③ 墙转移      → 当前墙确实解除了，但暴露了新的墙
 *   ② 墙找错      → 干预的墙本来就不是瓶颈
 *   ⑤ 真硬件极限  → 只有前四条都排除，才允许得出这个结论，且**必须带限定条件**
 */

import { hasImplementationScope } from './objective.mjs'

export const REFLECT_SCHEMA_VERSION = '1.0.0'

export const INEFFECTIVE_CAUSES = Object.freeze({
  INVALID_MEASUREMENT: 'invalid-measurement',
  LEVER_INEFFECTIVE: 'lever-ineffective',
  WALL_SHIFTED: 'wall-shifted',
  WRONG_WALL: 'wrong-wall',
  TRUE_HARDWARE_LIMIT: 'true-hardware-limit',
})

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * @param {{
 *   wallId: string,
 *   lever: string,
 *   before: object,          // 干预前测量（含 metric 数值）
 *   after: object,           // 干预后测量
 *   metric?: string,
 *   measurementValid?: boolean|null,
 *   measurementReasons?: object[],
 *   appliedConfig?: object|null,   // 实际下发的配置（用来查"参数是否真的生效"）
 *   observedConfig?: object|null,  // 从引擎侧读回的配置
 *   wallDiagBefore?: object|null,
 *   wallDiagAfter?: object|null,
 *   improvementThreshold?: number,
 *   limitingConditions?: string[],
 * }} spec
 */
export function reflectOnIneffectiveIntervention({
  wallId, lever, before = {}, after = {},
  metric = 'decodeTps',
  measurementValid = null,
  measurementReasons = [],
  appliedConfig = null,
  observedConfig = null,
  wallDiagBefore = null,
  wallDiagAfter = null,
  improvementThreshold = 0.02,
  limitingConditions = [],
} = {}) {
  const b = num(before?.[metric] ?? before?.value)
  const a = num(after?.[metric] ?? after?.value)
  if (b === null || a === null) {
    return {
      schemaVersion: REFLECT_SCHEMA_VERSION,
      wallId, lever, metric,
      inconclusive: true,
      reason: `缺 ${metric} 的前后实测值，无法判断干预是否生效`,
      hypotheses: [],
    }
  }
  const deltaPct = ((a - b) / b) * 100
  const improved = deltaPct >= improvementThreshold * 100

  // ④ **测量不成立必须先于"干预有效/无效"的判断**。
  //
  // 本函数第一版把"improved"的提前返回放在了这一步之前，于是出现过这样的结果：
  // 性能数字涨了 20%，但**精度测量是坏的**，函数却回了一句"干预有效"、零假设。
  // 那正好违反了本文件开头写的优先级 —— 测量不成立时，
  // "有效"与"无效"**都**不能判。
  if (measurementValid === false) {
    const codes = (measurementReasons ?? []).map((r) => r.code ?? r).filter(Boolean)
    return {
      schemaVersion: REFLECT_SCHEMA_VERSION,
      wallId, lever, metric,
      effective: null,
      inconclusive: true,
      deltaPct: Number(deltaPct.toFixed(3)),
      reason: `测量未通过成立性门禁（${codes.join(', ') || '未给出来由'}）—— 此时"干预有效"与"干预无效"**都不能判**`,
      hypotheses: [{
        cause: INEFFECTIVE_CAUSES.INVALID_MEASUREMENT,
        priority: 1,
        confidence: 'high',
        why: '测量未通过成立性门禁。在这个前提下任何关于干预效果的结论都不成立',
        evidence: measurementReasons ?? [],
        nextAction: `先修测量：${codes.join(', ') || '查看 validity 证据块'}，然后重测再谈干预`,
        blocking: true,
      }],
      conclusion: INEFFECTIVE_CAUSES.INVALID_MEASUREMENT,
      nextAction: `先修测量：${codes.join(', ') || '查看 validity 证据块'}，然后重测再谈干预`,
      mustNotDo: '在未排除前四条之前，**不得**换一个参数再试 —— 那会把反思变成盲搜',
    }
  }

  if (improved) {
    return {
      schemaVersion: REFLECT_SCHEMA_VERSION,
      wallId, lever, metric,
      effective: true,
      deltaPct: Number(deltaPct.toFixed(3)),
      reason: `干预有效：${metric} ${b} → ${a}（+${deltaPct.toFixed(2)}%）`,
      hypotheses: [],
    }
  }

  const hypotheses = []

  // ① 杠杆未生效 —— 参数可能根本没到引擎
  const configMismatch = diffConfig(appliedConfig, observedConfig)
  if (observedConfig && configMismatch.length > 0) {
    hypotheses.push({
      cause: INEFFECTIVE_CAUSES.LEVER_INEFFECTIVE,
      priority: 2,
      confidence: 'high',
      why: '下发配置与引擎侧读回的配置不一致 —— 参数没有真正生效',
      evidence: configMismatch,
      nextAction: `核对这几项为什么没生效：${configMismatch.map((m) => m.key).join(', ')}`
        + '（常见原因：引擎不认这个 flag、被更晚的配置覆盖、需要重启而非热更新）',
      blocking: true,
    })
  } else if (!observedConfig) {
    hypotheses.push({
      cause: INEFFECTIVE_CAUSES.LEVER_INEFFECTIVE,
      priority: 2,
      confidence: 'medium',
      why: '没有从引擎侧读回配置，无法证明杠杆真的生效（"我传了" ≠ "它用了"）',
      evidence: { appliedConfig },
      nextAction: '从端点侧读回实际生效的配置（如 /v1/models 的配置回显或引擎启动参数），再判断',
    })
  }

  // ③ 墙转移 —— 当前墙解除了，但冒出另一堵
  const shift = detectWallShift(wallDiagBefore, wallDiagAfter, wallId)
  if (shift.shifted) {
    hypotheses.push({
      cause: INEFFECTIVE_CAUSES.WALL_SHIFTED,
      priority: 3,
      confidence: 'high',
      why: `当前墙确实解除了，但暴露了新墙：${shift.to}`,
      evidence: shift,
      nextAction: `把干预目标切到 ${shift.to} 墙；当前墙的杠杆已被证明有效，不要再加大它的剂量`,
    })
  }

  // ② 墙找错 —— 干预的墙本来就不是瓶颈
  const wrong = detectWrongWall(wallDiagBefore, wallId)
  if (wrong.wrong) {
    hypotheses.push({
      cause: INEFFECTIVE_CAUSES.WRONG_WALL,
      priority: 4,
      confidence: 'medium',
      why: wrong.why,
      evidence: wrong,
      nextAction: `改判根因墙为 ${wrong.actualRootWall}；先修它的分母口径（若是 unknown），再对它下干预`,
    })
  }

  // ⑤ 真硬件极限 —— 只有前面都不成立才允许提，且必须带限定条件
  const othersBlocking = hypotheses.some((h) => h.blocking)
  if (!othersBlocking && hypotheses.length === 0) {
    if (!hasImplementationScope(limitingConditions)) {
      hypotheses.push({
        cause: INEFFECTIVE_CAUSES.TRUE_HARDWARE_LIMIT,
        priority: 5,
        confidence: 'low',
        why: '前四条都不成立，但**限定条件里没有一条是实现域的**（kernel 实现 / 状态缓存格式 / 量化精度）'
          + ' —— 按规则不允许判"硬件到顶"',
        evidence: { metric, before: b, after: a, deltaPct },
        nextAction: '补齐限定条件（当前 kernel 实现 / 状态缓存格式 / 量化精度 / 上界口径），否则只能报"未解释的无效干预"',
        cannotConclude: true,
      })
    } else {
      hypotheses.push({
        cause: INEFFECTIVE_CAUSES.TRUE_HARDWARE_LIMIT,
        priority: 5,
        confidence: 'medium',
        why: '在下列限定条件下，该杠杆确实无法再改善 —— 这是**限定条件下的**硬件极限，不是物理理论上界',
        evidence: { metric, before: b, after: a, deltaPct },
        limitingConditions,
        nextAction: '要突破需改变限定条件本身（换 kernel 实现 / 改状态缓存格式 / 改量化精度），而不是继续调参',
      })
    }
  }

  hypotheses.sort((x, y) => x.priority - y.priority)
  return {
    schemaVersion: REFLECT_SCHEMA_VERSION,
    wallId, lever, metric,
    effective: false,
    deltaPct: Number(deltaPct.toFixed(3)),
    inconclusive: false,
    hypotheses,
    conclusion: hypotheses.find((h) => h.blocking)?.cause
      ?? hypotheses[0]?.cause
      ?? INEFFECTIVE_CAUSES.TRUE_HARDWARE_LIMIT,
    nextAction: hypotheses[0]?.nextAction ?? '补齐观测后重判',
    mustNotDo: '在未排除前四条之前，**不得**换一个参数再试 —— 那会把反思变成盲搜',
  }
}

/** 下发的配置 vs 引擎读回的配置：找出没生效的键。 */
export function diffConfig(applied, observed) {
  if (!applied || !observed) return []
  const out = []
  for (const k of Object.keys(applied)) {
    if (!(k in observed)) continue
    const a = applied[k]
    const o = observed[k]
    if (typeof a === 'number' && typeof o === 'number') {
      if (Math.abs(a - o) > 1e-9) out.push({ key: k, applied: a, observed: o })
    } else if (String(a) !== String(o)) {
      out.push({ key: k, applied: a, observed: o })
    }
  }
  return out
}

function detectWallShift(before, after, wallId) {
  if (!before?.walls || !after?.walls) return { shifted: false }
  const b = before.walls.find((w) => w.id === wallId)
  const a = after.walls.find((w) => w.id === wallId)
  const relieved = b && a && b.state === 'walled' && a.state === 'headroom'
  const newRoot = after.rootWall && after.rootWall.id !== wallId ? after.rootWall.id : null
  if (relieved && newRoot) {
    return { shifted: true, to: newRoot, from: wallId, beforeUtil: b.utilization, afterUtil: a.utilization }
  }
  return { shifted: false, relieved: Boolean(relieved), newRoot }
}

function detectWrongWall(wallDiagBefore, wallId) {
  if (!wallDiagBefore?.walls) return { wrong: false }
  const target = wallDiagBefore.walls.find((w) => w.id === wallId)
  const root = wallDiagBefore.rootWall

  // (a) 干预的墙根本不是根因墙
  if (root && root.id !== wallId && target && target.state !== 'walled') {
    return {
      wrong: true,
      why: `干预时 ${wallId} 的状态是 ${target.state}（不是 walled），而当时的根因墙是 ${root.id}`,
      actualRootWall: root.id,
      targetState: target.state,
      rootUtilization: root.utilization,
    }
  }

  // (b) **目标墙自己就没饱和** —— 真机暴露的一种成因：
  //     没有任何一堵墙是 walled 时，框架会把"利用率最高的那堵"当根因墙，
  //     但它只是相对最高，并没有到界。此时对它的干预是**探索性的**，不是"解除瓶颈"，
  //     预期收益本就不该按"解除瓶颈"来算。不说出来，读报告的人会误以为找错了墙。
  if (target && target.state === 'headroom') {
    return {
      wrong: true,
      kind: 'wall-not-saturated',
      why: `干预时 ${wallId} 处于 headroom（利用率 ${((target.utilization ?? 0) * 100).toFixed(1)}%），`
        + '**没有饱和**。没有任何墙到界时，框架会选"利用率最高"的那堵作为根因墙 —— '
        + '对它下手属于**探索性干预**，不是在解除瓶颈；'
        + '因此"没有明显收益"是符合预期的，不能据此判该墙不是瓶颈。',
      targetState: target.state,
      targetUtilization: target.utilization,
      actualRootWall: root?.id ?? null,
      note: '要真正判"哪堵墙是瓶颈"，需要先补齐其它墙的观测（见 earlyStop.findings 的 unknown-walls）。',
    }
  }
  return { wrong: false }
}
