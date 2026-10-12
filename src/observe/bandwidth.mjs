/**
 * 观测适配层 —— 把"能从目标系统观测到什么"变成墙框架可消费的 ctx，**每个数字都带 provenance**。
 *
 * 与设施零耦合：带宽探针的**执行器**由外部注入；默认不给执行器 → 返回 `GBps: null`，
 * 让墙框架判定为 `unknown` 并提示"该测什么"。
 *
 * 这是一条硬纪律，不是偏好：
 *   **未注入探针执行器时返回 null，而不是拿理论峰值凑数。**
 *   用规格书峰值当分母，会算出一个"看起来合理"的上界，并据此得出"硬件已到顶"的假结论 ——
 *   旧引擎正是这么误判过一次（理论 273 GB/s → 判 98.8% 到顶；实测可达 ~240 GB/s 时，
 *   反推的 269.8 GB/s 在物理上不可能，说明是分母口径错了）。
 */

export const OBSERVE_SCHEMA_VERSION = '1.0.0'

/** provenance 取值白名单。`spec-sheet` 一类会被墙框架直接拒绝。 */
export const PROVENANCE = Object.freeze({
  LOCAL_MICROBENCHMARK: 'local-microbenchmark',
  ENGINE_REPORTED: 'engine-reported',
  ADAPTER: 'adapter',
  ASSUMED_DEFAULT: 'assumed-default',
  UNMEASURED: 'unmeasured',
  PROBE_ERROR: 'probe-error',
  PROBE_EMPTY: 'probe-empty',
  PROBE_FAILED: 'probe-failed',
  SPEC_SHEET: 'spec-sheet',
})

/**
 * 与框架无关的带宽微基准（纯文本，交给执行通道去跑；不假设设备名/路径）。
 * 报告"纯读最快值"——推理 decode 以读权重为主。
 */
export const BANDWIDTH_PROBE_PY = `import json, os, statistics, time
import torch

spec = json.loads(os.environ.get("BW_PROBE_SPEC", "{}"))
sizes = spec.get("sizesGiB", [0.5, 1, 2])
iters = int(spec.get("iters", 25))
warmup = int(spec.get("warmup", 6))

out = {"ok": False, "readGBps": 0.0, "copyGBps": 0.0, "bestReadGBps": 0.0}
try:
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    out["device"] = (torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu")

    def bench(fn, nbytes):
        for _ in range(warmup):
            fn()
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        ts = []
        for _ in range(iters):
            t0 = time.perf_counter()
            fn()
            if torch.cuda.is_available():
                torch.cuda.synchronize()
            ts.append(time.perf_counter() - t0)
        med = statistics.median(ts)
        best = min(ts)
        return (nbytes / med / 1e9 if med > 0 else 0.0,
                nbytes / best / 1e9 if best > 0 else 0.0)

    best_read = 0.0
    read_med = 0.0
    copy_med = 0.0
    for gib in sizes:
        n = int(gib * (1024 ** 3) / 4)          # fp32 元素数
        if n <= 0:
            continue
        src = torch.ones(n, dtype=torch.float32, device=dev)
        dst = torch.empty_like(src)
        nbytes = n * 4
        rm, rb = bench(lambda: src.sum(), nbytes)
        cm, _cb = bench(lambda: dst.copy_(src), nbytes * 2)
        read_med = max(read_med, rm)
        best_read = max(best_read, rb)
        copy_med = max(copy_med, cm)
        del src, dst
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    out.update({
        "ok": True,
        "readGBps": round(read_med, 2),
        "bestReadGBps": round(best_read, 2),
        "copyGBps": round(copy_med, 2),
        "method": "read(sum)/copy_ microbenchmark, median+best",
        "sizesGiB": sizes,
        "iters": iters,
        "warmup": warmup,
    })
except Exception as e:
    out["error"] = "%s: %s" % (type(e).__name__, str(e)[:400])

print("BWPROBE_JSON=" + json.dumps(out))
`

/** 从探针 stdout 里取出结果 JSON。 */
export function parseBandwidthProbeOutput(stdout) {
  const m = /BWPROBE_JSON=(\{.*\})/s.exec(String(stdout ?? ''))
  if (!m) return null
  try { return JSON.parse(m[1]) } catch { return null }
}

/**
 * 实测可达带宽。
 *
 * @param {{run?: Function, sizesGiB?, iters?, warmup?}} spec
 *   `run(spec)` 由执行通道注入 → `{readGBps, copyGBps, bestReadGBps, device, method}` | null
 * @returns {{GBps, provenance, method, device, note?, raw?}}
 */
export async function measureAchievableBandwidth({ run = null, sizesGiB = [0.5, 1, 2], iters = 25, warmup = 6 } = {}) {
  if (typeof run !== 'function') {
    return {
      GBps: null,
      provenance: PROVENANCE.UNMEASURED,
      method: null,
      device: null,
      note: '未注入带宽探针执行器；**禁止用理论峰值代替实测可达带宽**',
    }
  }
  let res = null
  try {
    res = await run({ sizesGiB, iters, warmup })
  } catch (e) {
    return { GBps: null, provenance: PROVENANCE.PROBE_ERROR, method: null, device: null, note: String(e?.message ?? e) }
  }
  if (!res) return { GBps: null, provenance: PROVENANCE.PROBE_EMPTY, method: null, device: null }
  if (res.ok === false) {
    return { GBps: null, provenance: PROVENANCE.PROBE_FAILED, method: null, device: res.device ?? null, note: res.error ?? '探针自报失败', raw: res }
  }
  const candidates = [res.bestReadGBps, res.readGBps].filter((v) => Number.isFinite(v) && v > 0)
  const GBps = candidates.length ? Math.max(...candidates) : null
  return {
    GBps,
    provenance: GBps ? PROVENANCE.LOCAL_MICROBENCHMARK : PROVENANCE.PROBE_FAILED,
    method: res.method ?? 'read/copy microbenchmark',
    device: res.device ?? null,
    raw: res,
  }
}

/**
 * 把观测拼成墙框架消费的 ctx。
 * 任何拿不到的观测一律 **null**（不是 0），让墙判定为 unknown 并提示"该测什么"。
 */
export function buildWallContext({
  // `machine` 与 `hardware` 是同一个东西的两种叫法：内部实现叫 machine，
  // 而墙的 `requires` 路径与对外文档都写 `hardware.…`。
  // **同时接受两者**，否则调用方按文档给 `hardware` 会被静默丢掉、判成"缺观测"（踩过一次）。
  machine = null, hardware = null, model = {}, engine = {}, measurements = {}, limits = {}, provenance = {},
} = {}) {
  const hw = machine ?? hardware ?? {}
  return {
    hardware: {
      name: hw.name ?? null,
      achievableBandwidthGBps: hw.achievableBandwidthGBps ?? null,
      measuredPeakFlops: hw.measuredPeakFlops ?? null,
      unifiedMemory: hw.unifiedMemory ?? null,
      memoryBytes: hw.memoryBytes ?? null,
    },
    model: {
      name: model.name ?? null,
      bytesPerTokenGB: model.bytesPerTokenGB ?? null,
      flopsPerToken: model.flopsPerToken ?? null,
      kvBytesPerToken: model.kvBytesPerToken ?? null,
      kvTokensPerRequest: model.kvTokensPerRequest ?? null,
      paramsB: model.paramsB ?? null,
      // --- S2：天花板与内存分解要用的字段 ---
      // 刻意**不设默认值**：缺失就保持 null，让上层判 unknown 并提示"该测什么"
      contextLength: model.contextLength ?? null,
      kvBytesPerTokenPerCtx: model.kvBytesPerTokenPerCtx ?? null,
      stateCacheBytesPerToken: model.stateCacheBytesPerToken ?? null,
      kvPrecision: model.kvPrecision ?? null,
      quantFormat: model.quantFormat ?? null,
      weightBytesGB: model.weightBytesGB ?? null,
    },
    engine: {
      id: engine.id ?? null,
      version: engine.version ?? null,
      flags: engine.flags ?? {},
      // S2：天花板/主张门禁要判"限定条件里有没有实现域的那一条"
      image: engine.image ?? null,
      kernelImplementation: engine.kernelImplementation ?? null,
      kvCacheDtype: engine.kvCacheDtype ?? null,
    },
    measurements: {
      singleStreamTps: measurements.singleStreamTps ?? null,
      decodeTps: measurements.decodeTps ?? null,
      batchTps: measurements.batchTps ?? null,
      ttftMs: measurements.ttftMs ?? null,
      kernelMs: measurements.kernelMs ?? null,
      decodeStepMs: measurements.decodeStepMs ?? null,
      gpuBusyPct: measurements.gpuBusyPct ?? null,
      runningRequests: measurements.runningRequests ?? null,
      acceptLength: measurements.acceptLength ?? null,
      draftTokens: measurements.draftTokens ?? null,
      prevAcceptLength: measurements.prevAcceptLength ?? null,
      prevDraftTokens: measurements.prevDraftTokens ?? null,
      draftOverheadRatio: measurements.draftOverheadRatio ?? null,
    },
    limits: {
      kvPoolTokens: limits.kvPoolTokens ?? null,
      maxRunningRequests: limits.maxRunningRequests ?? null,
      // S2 内存分解
      budgetBytes: limits.budgetBytes ?? null,
      weightsBytes: limits.weightsBytes ?? null,
      overheadBytes: limits.overheadBytes ?? null,
      unifiedMemory: limits.unifiedMemory ?? null,
      contextLength: limits.contextLength ?? null,
      seqBudgetNew: limits.seqBudgetNew ?? null,
      kvDtype: limits.kvDtype ?? null,
    },
    provenance: { ...provenance },
  }
}

export { PROVENANCE as OBSERVATION_PROVENANCE }
