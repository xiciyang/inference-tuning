/**
 * 根因墙驱动诊断框架 —— 本包的心脏。
 *
 * 方法论（用户长期指令的定稿）：
 *   **搜索只是验证手段，不是发现手段。**
 *   调优 = 找到根因墙 → 用理论/世界经验直接匹配 TOP1 干预 → 自闭环验证。
 *
 * 三条硬性设计约束：
 *
 * ① **与模型/引擎/硬件零耦合**
 *    墙的定义只含物理/数学关系；一切具体数值来自注入的 `ctx`。
 *    每堵墙声明自己 `requires` 哪些观测；缺哪个就把哪个列出来（**观测即诊断的一部分**）。
 *
 * ② **分子与分母都必须来自本机实测，禁止规格书理论峰值**
 *    每个理论输入都带 `provenance`（`local-microbenchmark` / `adapter` / `assumed`）。
 *    `provenance === 'spec-sheet'` 会被 `assertNoSpecSheet` 直接拒绝 —— 这不是建议，是门禁。
 *
 * ③ **每堵墙都必须能自我否证**
 *    每堵墙都带 `sanity`：当"反推量 > 实测可达量"时，判**分母口径有误**，
 *    而不是判"硬件到顶"。这条是被一次真实误判换来的：
 *    用理论峰值 273 GB/s 当分母 → 得出"98.8% 已到顶"；
 *    换成实测可达 ~240 GB/s 后，反推的 269.8 GB/s **在物理上不可能** ——
 *    说明"每 token 访存字节"这个分母算错了（含了 vision tower、没排除 embed），
 *    而不是硬件到顶。
 *
 * `Number(null) === 0` 是一个必须显式拦截的陷阱：不拦，缺失观测会被静默当成 0，
 * 从而编造出一个"看起来合理"的上界。
 */
import { REMEDIES } from './remedies.mjs'

export const WALLS_SCHEMA_VERSION = '1.0.0'

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

function missing(ctx, keys) {
  return keys.filter((k) => num(resolve(ctx, k)) === null)
}

/**
 * 取 provenance。
 * 容忍两种写法：完整观测路径（`hardware.achievableBandwidthGBps`）与末段名（`achievableBandwidthGBps`）。
 * 都没有则兜底 `'adapter'`（"由适配器提供"，不是实测微基准，也不是规格书）。
 */
function prov(ctx, key) {
  const p = ctx?.provenance ?? {}
  const last = String(key).split('.').pop()
  return p[key] ?? p[last] ?? 'adapter'
}

/**
 * **禁止规格书理论峰值** —— 硬门禁。
 * 任何墙的理论输入若声明为 spec-sheet，直接判该墙不可用（而不是悄悄用）。
 */
export function assertNoSpecSheet(ctx, wallId) {
  const provs = ctx?.provenance ?? {}
  const bad = Object.entries(provs)
    .filter(([, v]) => v === 'spec-sheet' || v === 'theoretical-peak' || v === 'datasheet')
    .map(([k]) => k)
  if (bad.length > 0) {
    return {
      ok: false,
      reasons: bad.map((k) => `观测 ${k} 的 provenance=${provs[k]}（规格书/理论峰值）`),
      detail: '分子与分母必须来自本机实测。请用实测微基准替换该输入（见 src/observe/bandwidth.mjs）。',
    }
  }
  return { ok: true, reasons: [] }
}

// ---------------------------------------------------------------- 墙定义

/**
 * 1) 内存带宽墙：单流 TPS ≤ 实测可达带宽 / 每 token 访存字节
 */
export const bandwidthWall = {
  id: 'bandwidth',
  title: '内存带宽墙',
  kind: 'memory',
  goalMetric: 'singleStreamTps',
  requires: ['hardware.achievableBandwidthGBps', 'model.bytesPerTokenGB', 'measurements.singleStreamTps'],
  theory(ctx) {
    const bw = num(resolve(ctx, 'hardware.achievableBandwidthGBps'))
    const bpt = num(resolve(ctx, 'model.bytesPerTokenGB'))
    if (bw === null || bpt === null || bpt <= 0) return null
    return {
      bound: bw / bpt,
      unit: 'tok/s',
      formula: 'TPS ≤ 实测可达带宽 / 每 token 访存字节',
      inputs: { achievableBandwidthGBps: bw, bytesPerTokenGB: bpt },
      provenance: {
        achievableBandwidthGBps: prov(ctx, 'achievableBandwidthGBps'),
        bytesPerTokenGB: prov(ctx, 'bytesPerTokenGB'),
      },
    }
  },
  status(ctx) {
    const th = this.theory(ctx)
    const miss = missing(ctx, this.requires)
    if (!th) return { state: 'unknown', missing: miss, detail: `缺少观测：${miss.join(', ')}` }
    const tps = num(resolve(ctx, 'measurements.singleStreamTps'))
    if (tps === null) return { state: 'unknown', missing: miss, detail: '缺少实测单流 TPS' }
    const util = tps / th.bound
    const eff = tps * th.inputs.bytesPerTokenGB
    const ach = th.inputs.achievableBandwidthGBps
    const impossible = eff > ach * 1.02
    return {
      state: impossible ? 'unknown' : (util >= 0.90 ? 'walled' : 'headroom'),
      missing: miss,
      utilization: util,
      gapToBound: th.bound - tps,
      detail: `实测 ${tps} vs 带宽上界 ${th.bound.toFixed(1)} tok/s → 利用率 ${(util * 100).toFixed(1)}%`,
      sanity: impossible
        ? {
          ok: false,
          warn: `反推有效带宽 ${eff.toFixed(1)} > 实测可达 ${ach.toFixed(1)} GB/s（超出 ${((eff / ach - 1) * 100).toFixed(1)}%）`
            + ' —— **分母（每 token 访存字节）口径有误，禁止据此判定"硬件到顶"**',
          effectiveGBps: eff,
          achievableGBps: ach,
        }
        : { ok: true, effectiveGBps: eff, utilizationOfAchievable: eff / ach },
    }
  },
  actionable(ctx, th, st) {
    const u = st?.utilization
    if (!Number.isFinite(u)) return { ok: false, why: '利用率未知（缺实测可达带宽或分母）' }
    if (st?.sanity && st.sanity.ok === false) {
      return { ok: false, why: '分母口径有误（反推带宽超过实测可达）—— 先修口径，不要在该墙上做干预' }
    }
    if (u >= 0.95) {
      return {
        ok: false,
        why: `有效带宽已达实测可达的 ${(u * 100).toFixed(1)}%（阈 95%）—— 权重必须全量读，带宽侧无空间；`
          + '应转到 speculative 墙（每读一次权重产出更多 token）',
        redirect: 'speculative',
      }
    }
    return { ok: true, why: `带宽利用率 ${(u * 100).toFixed(1)}%，尚有 ${((1 - u) * 100).toFixed(1)}% 空间` }
  },
}

/**
 * 2) 投机解码墙：加速比 ≤ 接受长度 / (1 + 草稿开销/验证开销)
 *
 * 可解除性判据 = **边际接受率**：加草稿预算有没有换来更长的接受长度。
 * 实测反证（旧引擎记录）：预算 16→32 时 accept 5.51→4.27 —— 边际率下降 ⇒ 预算已饱和。
 */
export const speculativeWall = {
  id: 'speculative',
  title: '投机解码墙',
  kind: 'algorithm',
  goalMetric: 'singleStreamTps',
  requires: ['measurements.acceptLength', 'measurements.draftTokens'],
  theory(ctx) {
    const a = num(resolve(ctx, 'measurements.acceptLength'))
    const k = num(resolve(ctx, 'measurements.draftTokens'))
    if (a === null || k === null || k <= 0) return null
    const overhead = num(resolve(ctx, 'measurements.draftOverheadRatio')) ?? 0.15
    const bound = a / (1 + overhead)
    return {
      bound,
      unit: '相对无投机的加速比 ×',
      formula: '加速比 ≤ 接受长度 / (1 + 草稿开销比)',
      inputs: { acceptLength: a, draftTokens: k, draftOverheadRatio: overhead },
      provenance: {
        acceptLength: prov(ctx, 'acceptLength'),
        draftTokens: prov(ctx, 'draftTokens'),
        draftOverheadRatio: resolve(ctx, 'provenance.draftOverheadRatio') ?? 'assumed-default',
      },
    }
  },
  status(ctx) {
    const th = this.theory(ctx)
    const miss = missing(ctx, this.requires)
    if (!th) return { state: 'unknown', missing: miss, detail: `缺少观测：${miss.join(', ')}` }
    const a = th.inputs.acceptLength
    const k = th.inputs.draftTokens
    const marginal = (a - 1) / k
    const prevK = num(resolve(ctx, 'measurements.prevDraftTokens'))
    const prevA = num(resolve(ctx, 'measurements.prevAcceptLength'))
    const saturated = prevK !== null && prevA !== null && k > prevK && a <= prevA
    return {
      state: (marginal <= 0 || saturated) ? 'walled' : 'headroom',
      missing: miss,
      utilization: null,
      gapToBound: null,
      detail: `接受长度 ${a} / 草稿预算 ${k} → 边际接受率 ${marginal.toFixed(3)}`
        + (prevK !== null && prevA !== null ? `（上次 预算 ${prevK} 接受 ${prevA}）` : ''),
      marginalAcceptRate: marginal,
      saturated,
      sanity: { ok: true },
    }
  },
  actionable(ctx, th, st) {
    if (!th) return { ok: false, why: '缺接受长度/草稿预算，无法判断预算是否饱和' }
    if (st?.saturated) {
      return {
        ok: false,
        why: `草稿预算 ${th.inputs.draftTokens} > 上次 ${num(resolve(ctx, 'measurements.prevDraftTokens'))}，`
          + `但接受长度没有变长（${th.inputs.acceptLength} ≤ ${num(resolve(ctx, 'measurements.prevAcceptLength'))}）`
          + ' —— 预算已饱和，加预算无效',
      }
    }
    if (th.inputs.acceptLength <= 1) {
      return { ok: false, why: `接受长度 ${th.inputs.acceptLength} ≤ 1：投机没有产生任何加速，草稿模型/温度/任务不匹配` }
    }
    return { ok: true, why: `接受长度 ${th.inputs.acceptLength}，仍有提升空间` }
  },
}

/**
 * 3) 算力墙：**用实测 kernel 耗时与实测算力峰值**，不用理论 FLOPs 峰值。
 *
 * 口径：
 *   achievedFlops = model.flopsPerToken / (实测 kernel 秒)
 *   utilization   = achievedFlops / hardware.measuredPeakFlops（实测微基准得到）
 *   sanity        = achievedFlops > measuredPeak × 1.02 ⇒ **FLOPs 分母算错了**（如漏算/多算 MoE 稀疏）
 */
export const computeWall = {
  id: 'compute',
  title: '算力墙',
  kind: 'compute',
  goalMetric: 'singleStreamTps',
  requires: ['hardware.measuredPeakFlops', 'model.flopsPerToken', 'measurements.kernelMs'],
  theory(ctx) {
    const peak = num(resolve(ctx, 'hardware.measuredPeakFlops'))
    const fpt = num(resolve(ctx, 'model.flopsPerToken'))
    const kms = num(resolve(ctx, 'measurements.kernelMs'))
    if (peak === null || fpt === null || kms === null || kms <= 0) return null
    const achievedFlops = fpt / (kms / 1000)
    return {
      bound: peak / fpt,
      unit: 'tok/s',
      achievedFlops,
      formula: 'TPS ≤ 实测算力峰值 / 每 token FLOPs（FLOPs 为架构算术量，峰值为实测微基准）',
      inputs: { measuredPeakFlops: peak, flopsPerToken: fpt, kernelMs: kms, achievedFlops },
      provenance: {
        measuredPeakFlops: prov(ctx, 'measuredPeakFlops'),
        flopsPerToken: prov(ctx, 'flopsPerToken'),
        kernelMs: prov(ctx, 'kernelMs'),
      },
    }
  },
  status(ctx) {
    const th = this.theory(ctx)
    const miss = missing(ctx, this.requires)
    if (!th) return { state: 'unknown', missing: miss, detail: `缺少观测：${miss.join(', ')}` }
    const tps = num(resolve(ctx, 'measurements.singleStreamTps'))
    const util = th.inputs.achievedFlops / th.inputs.measuredPeakFlops
    const impossible = util > 1.02
    return {
      state: impossible ? 'unknown' : (util >= 0.85 ? 'walled' : 'headroom'),
      missing: miss,
      utilization: util,
      gapToBound: tps !== null ? th.bound - tps : null,
      detail: `实测 kernel ${th.inputs.kernelMs} ms/token → 达成 ${(th.inputs.achievedFlops / 1e12).toFixed(2)} TFLOP/s`
        + ` vs 实测峰值 ${(th.inputs.measuredPeakFlops / 1e12).toFixed(2)} TFLOP/s → 利用率 ${(util * 100).toFixed(1)}%`,
      sanity: impossible
        ? {
          ok: false,
          warn: `达成算力 ${(th.inputs.achievedFlops / 1e12).toFixed(2)} TFLOP/s 超过实测峰值 `
            + `${(th.inputs.measuredPeakFlops / 1e12).toFixed(2)} TFLOP/s —— **FLOPs 分母口径有误**（稀疏/MoE/精度没算对），`
            + '禁止据此判定"算力到顶"',
        }
        : { ok: true, utilization: util },
    }
  },
  actionable(ctx, th, st) {
    if (!th) return { ok: false, why: '缺实测算力峰值或 kernel 耗时' }
    if (st?.sanity && st.sanity.ok === false) return { ok: false, why: 'FLOPs 分母口径有误 —— 先修口径' }
    if ((st?.utilization ?? 0) >= 0.85) {
      return { ok: true, why: `算力利用率 ${(st.utilization * 100).toFixed(1)}%，接近实测峰值；干预应降低每 token 计算量而非提高占用` }
    }
    return { ok: true, why: `算力利用率 ${((st?.utilization ?? 0) * 100).toFixed(1)}%，有提升空间` }
  },
}

/**
 * 4) 容量墙（KV/状态缓存）：并发上限 ≤ 可用 KV 槽位 / 每请求占用
 */
export const capacityWall = {
  id: 'memory',
  title: '容量墙（KV / 状态缓存）',
  kind: 'capacity',
  goalMetric: 'batchThroughput',
  requires: ['limits.kvPoolTokens', 'model.kvTokensPerRequest', 'measurements.runningRequests'],
  theory(ctx) {
    const pool = num(resolve(ctx, 'limits.kvPoolTokens'))
    const per = num(resolve(ctx, 'model.kvTokensPerRequest'))
    if (pool === null || per === null || per <= 0) return null
    const cap = Math.floor(pool / per)
    return {
      bound: cap,
      unit: '并发请求数',
      formula: '并发上限 ≤ KV 池容量 / 每请求占用（均按本机实测/引擎实报）',
      inputs: { kvPoolTokens: pool, kvTokensPerRequest: per },
      provenance: { kvPoolTokens: prov(ctx, 'kvPoolTokens'), kvTokensPerRequest: prov(ctx, 'kvTokensPerRequest') },
    }
  },
  status(ctx) {
    const th = this.theory(ctx)
    const miss = missing(ctx, this.requires)
    if (!th) return { state: 'unknown', missing: miss, detail: `缺少观测：${miss.join(', ')}` }
    const run = num(resolve(ctx, 'measurements.runningRequests'))
    if (run === null) return { state: 'unknown', missing: miss, detail: '缺少实测并发请求数' }
    const util = run / th.bound
    return {
      state: util >= 0.90 ? 'walled' : 'headroom',
      missing: miss,
      utilization: util,
      gapToBound: th.bound - run,
      detail: `实测并发 ${run} vs 容量上界 ${th.bound} → 利用率 ${(util * 100).toFixed(1)}%`,
      sanity: { ok: true },
    }
  },
  actionable(ctx, th, st) {
    if (!th) return { ok: false, why: '缺 KV 池容量或每请求占用' }
    if ((st?.utilization ?? 0) >= 0.95) {
      return { ok: true, why: `容量利用率 ${(st.utilization * 100).toFixed(1)}% —— 提升并发会 OOM；应降低每请求占用（前缀缓存/更短的 max-len）或缩 KV 精度` }
    }
    return { ok: true, why: `容量利用率 ${((st?.utilization ?? 0) * 100).toFixed(1)}%，可继续提并发` }
  },
}

/**
 * 5) 调度墙：GPU 忙等/空转 —— 忙占比上不去说明调度在拖后腿
 */
export const scheduleWall = {
  id: 'schedule',
  title: '调度墙（批处理/连续批）',
  kind: 'schedule',
  goalMetric: 'batchThroughput',
  requires: ['measurements.gpuBusyPct'],
  theory(ctx) {
    const busy = num(resolve(ctx, 'measurements.gpuBusyPct'))
    if (busy === null) return null
    const stepMs = num(resolve(ctx, 'measurements.decodeStepMs'))
    return {
      // 上界口径：GPU 能 100% 忙时，吞吐可放大 1/busy 倍（busy 为实测占比）
      bound: busy > 0 ? 1 / busy : null,
      unit: '相对当前吞吐的倍数',
      formula: '吞吐放大潜力 ≤ 1 / 实测 GPU 忙占比',
      inputs: { gpuBusyPct: busy, decodeStepMs: stepMs },
      provenance: { gpuBusyPct: prov(ctx, 'gpuBusyPct'), decodeStepMs: prov(ctx, 'decodeStepMs') },
    }
  },
  status(ctx) {
    const th = this.theory(ctx)
    const miss = missing(ctx, this.requires)
    if (!th) return { state: 'unknown', missing: miss, detail: `缺少观测：${miss.join(', ')}` }
    const busy = th.inputs.gpuBusyPct
    return {
      state: busy < 0.60 ? 'walled' : 'headroom',
      missing: miss,
      utilization: busy,
      gapToBound: th.bound !== null ? th.bound - 1 : null,
      detail: `实测 GPU 忙占比 ${(busy * 100).toFixed(1)}% → 理论放大潜力 ${th.bound ? `≤ ${th.bound.toFixed(2)}×` : '未知'}`,
      sanity: { ok: true },
    }
  },
  actionable(ctx, th, st) {
    if (!th) return { ok: false, why: '缺实测 GPU 忙占比' }
    if (th.inputs.gpuBusyPct >= 0.60) {
      return { ok: false, why: `GPU 忙占比 ${(th.inputs.gpuBusyPct * 100).toFixed(1)}% ≥ 60%，调度不是主因` }
    }
    return { ok: true, why: `GPU 忙占比仅 ${(th.inputs.gpuBusyPct * 100).toFixed(1)}% —— 调度/批处理是主因` }
  },
}

export const WALLS = Object.freeze([bandwidthWall, speculativeWall, computeWall, capacityWall, scheduleWall])
export const WALL_IDS = Object.freeze(WALLS.map((w) => w.id))

export class WallRegistry {
  constructor(walls = WALLS) {
    this.walls = [...walls]
  }

  get(id) { return this.walls.find((w) => w.id === id) ?? null }
  list() { return this.walls.map((w) => ({ id: w.id, title: w.title, kind: w.kind, goalMetric: w.goalMetric, requires: w.requires })) }
  register(wall) { this.walls.push(wall); return this }
}

/**
 * 跑一次完整的墙诊断。
 *
 * @returns {{
 *   schemaVersion, verdict, rootWall, walls, ranking, unknownWalls,
 *   unknownObservations, specSheetViolation, notes
 * }}
 *   verdict ∈ {'walled','headroom','insufficient-observations','blocked-by-bad-baseline'}
 */
export function diagnoseWalls(ctx, { walls = WALLS, wallOverride = null } = {}) {
  const notes = []
  const spec = assertNoSpecSheet(ctx, 'all')
  if (!spec.ok) {
    return {
      schemaVersion: WALLS_SCHEMA_VERSION,
      verdict: 'blocked-by-bad-baseline',
      rootWall: null,
      walls: [],
      ranking: [],
      unknownWalls: [],
      unknownObservations: [],
      specSheetViolation: spec,
      notes: ['理论输入里有规格书/理论峰值 —— 拒绝诊断（分子与分母必须来自本机实测）'],
    }
  }

  const results = walls.map((w) => {
    let th = null
    let st = null
    let act = null
    try { th = w.theory(ctx) } catch (err) { notes.push(`${w.id}.theory 抛错：${err.message}`) }
    try { st = w.status(ctx) } catch (err) { notes.push(`${w.id}.status 抛错：${err.message}`) }
    const miss = st?.missing ?? missing(ctx, w.requires)
    if (th && st) {
      try { act = w.actionable(ctx, th, st) } catch (err) { notes.push(`${w.id}.actionable 抛错：${err.message}`) }
    }
    const usable = Boolean(th) && st?.state !== 'unknown'
    return {
      id: w.id,
      title: w.title,
      kind: w.kind,
      goalMetric: w.goalMetric,
      requires: w.requires,
      state: st?.state ?? 'unknown',
      utilization: st?.utilization ?? null,
      gapToBound: st?.gapToBound ?? null,
      detail: st?.detail ?? null,
      bound: th?.bound ?? null,
      unit: th?.unit ?? null,
      formula: th?.formula ?? null,
      inputs: th?.inputs ?? null,
      provenance: th?.provenance ?? null,
      missing: miss,
      sanity: st?.sanity ?? null,
      actionable: act,
      usable,
      suggestedRemedy: REMEDIES[w.id]?.top1 ?? null,
    }
  })

  const unknownWalls = results.filter((r) => !r.usable)
  const unknownObservations = [...new Set(unknownWalls.flatMap((r) => r.missing ?? []))]

  // 排序：可用的 + state=walled 的优先；利用率高的靠前
  const ranking = results
    .filter((r) => r.usable)
    .slice()
    .sort((a, b) => {
      const aw = a.state === 'walled' ? 1 : 0
      const bw = b.state === 'walled' ? 1 : 0
      if (aw !== bw) return bw - aw
      const au = Number.isFinite(a.utilization) ? a.utilization : -1
      const bu = Number.isFinite(b.utilization) ? b.utilization : -1
      return bu - au
    })

  let rootWall = null
  if (wallOverride) {
    rootWall = ranking.find((r) => r.id === wallOverride) ?? null
    if (!rootWall) notes.push(`指定的墙 ${wallOverride} 不可用（缺观测或状态 unknown），回退到自动排序`)
  }
  if (!rootWall) {
    const walled = ranking.find((r) => r.state === 'walled')
    const actionableWalled = ranking.find((r) => r.state === 'walled' && r.actionable?.ok !== false)
    // 优先选"已到墙且干预仍可解除"的；否则选利用率最高的
    rootWall = actionableWalled ?? walled ?? ranking[0] ?? null
  }

  let verdict
  if (ranking.length === 0) verdict = 'insufficient-observations'
  else if (rootWall && rootWall.state === 'walled') verdict = 'walled'
  else verdict = 'headroom'

  if (unknownObservations.length > 0) {
    notes.push(`有 ${unknownWalls.length} 堵墙因缺观测无法判定；要测：${unknownObservations.join(', ')}`)
  }

  return {
    schemaVersion: WALLS_SCHEMA_VERSION,
    verdict,
    rootWall,
    walls: results,
    ranking,
    unknownWalls: unknownWalls.map((r) => ({ id: r.id, missing: r.missing, detail: r.detail })),
    unknownObservations,
    specSheetViolation: null,
    notes,
  }
}

export { REMEDIES }
