/**
 * 主闭环（S1 的核心）。
 *
 *   模型 + 性能目标 + 精度容忍
 *     → 源模型结构预检
 *     → 起基线端点（经 serving MCP）→ 稳态等待 → 基线测量（性能 + 精度）
 *     → 根因墙诊断（不是搜参数）
 *     → 每轮：预注册 → 提案候选配置 → 起候选端点 → 双闭环测量
 *             → 测量成立性（性能四闸 + 精度三闸）→ 门禁判定
 *             → 接受（固化） / 回退（丢弃候选并验证基线仍健康）
 *             → 干预无效 → **五因反思**（不直接换参数）
 *     → 不停机判据（达标与预算耗尽都不构成停止理由）
 *     → 收尾：拆解全部端点（无残留）+ 注册表 + 报告 + 审计
 *
 * 端点所有权：**只动本次运行自己 deploy 出来的端点**。
 * 回退实现为"丢弃候选端点 + 验证原端点仍健康"，因此不存在把在用服务改坏的可能；
 * 若丢弃或验证失败 → `E_ROLLBACK_FAILED`（**独立风险档，必须叫人**）。
 */
import { join } from 'node:path'
import { shortId, canonicalJson, sha256, targetFingerprint } from './util/hash.mjs'
import { fail, warn, ERROR_CODES, WARNING_CODES, MUST_NOTIFY_FAILURES } from './errors.mjs'
import { runInputPipeline } from './input/pipeline.mjs'
import { assertSourceModelValid } from './model-validate.mjs'
import { assertSandbox } from './sandbox.mjs'
import { resolveThresholds, evaluateGates, assertAccuracyMeasurementValid } from './gate.mjs'
import { evaluatePerformanceValidity } from './validity/performance.mjs'
import { diagnoseWalls } from './walls/index.mjs'
import { singleStreamCeiling, evidenceChain } from './walls/ceiling.mjs'
import { decomposeByFormula, attributeLevers } from './walls/memory.mjs'
import { preregister, judge, checkInstrumentSelfMatch, checkPreregTiming } from './loop/prereg.mjs'
import { gateClaims } from './validity/claims.mjs'
import { captureRunSpec, applyParamsToArgv, toShellCommand } from './config/run-spec.mjs'
import { resolveGpuSpec } from './platform/gpuspec.mjs'
import { top1For } from './walls/remedies.mjs'
import { measureAchievableBandwidth } from './observe/bandwidth.mjs'
import { proposeCandidate, buildLaunchArgs, assertNoForbiddenParams, PARAM_CATALOG } from './registry.mjs'
import { decideRunOutcome, defineObjective, assessTargets, collectLimitingConditions, RUN_OUTCOME, STOP_KINDS } from './loop/objective.mjs'
import { detectEarlyStop } from './loop/early-stop.mjs'
import { reflectOnIneffectiveIntervention } from './loop/reflect.mjs'
import { compareParity, parityCheck, PARITY_CONTRACT_VERSION } from './testing/parity.mjs'
import { comparePerf } from './testing/perf.mjs'
import { executorFor } from './executors/index.mjs'
import './executors/docker.mjs'
import { withRegistry, findRun, pushHistory, writeReport, PKG_VERSION } from './state/tuning-registry.mjs'
import { appendAudit } from './audit.mjs'
import { resolveConfirmation, requireConfirmation } from './risk.mjs'
import { notifyFailure } from './notify.mjs'
import { metricsBump } from './metrics.mjs'

const nowMs = () => Date.now()

/**
 * 从**本机实测**装配墙框架要的观测上下文。
 *
 * 关键一条：`model.bytesPerTokenGB` 不再要求调用方提供 —— 它由**模型文件的实际字节数**得出
 * （`sourceValidation` 已经把 safetensors 数据区扫过一遍并给出 `totalDataBytes`）。
 * 这正是"分子与分母必须来自本机实测"的落点：decode 阶段每生成一个 token 就要把权重读一遍，
 * 所以"每 token 访存字节"就是权重字节数本身，不需要任何规格书。
 *
 * 已知限定：MoE/稀疏模型只有激活专家会被读，用总权重字节会**高估**分母
 * （于是带宽利用率被低估 → 偏保守，不会误判"到顶"）。需要精确值时用 options.bytesPerTokenGB 覆盖。
 *
 * 其余拿不到的观测一律 **null**（不是 0），由墙框架判 unknown 并提示"该测什么"。
 */
export function deriveObservedContext({ runtime, standard, sourceValidation, baselinePerf, bw, flagProbe }) {
  const weightBytes = sourceValidation?.evidence?.totalDataBytes ?? null
  const derivedBytesPerTokenGB = weightBytes ? weightBytes / 1e9 : null
  const bytesPerTokenGB = runtime.options.bytesPerTokenGB ?? derivedBytesPerTokenGB
  return {
    ctx: {
      hardware: {
        name: runtime.options.machineName ?? null,
        achievableBandwidthGBps: bw?.GBps ?? null,
        measuredPeakFlops: runtime.options.measuredPeakFlops ?? null,
        unifiedMemory: runtime.options.unifiedMemory ?? null,
      },
      model: {
        name: standard.model.path,
        bytesPerTokenGB,
        flopsPerToken: runtime.options.flopsPerToken ?? null,
        kvTokensPerRequest: runtime.options.kvTokensPerRequest ?? null,
        quantFormat: sourceValidation?.evidence?.config?.quantizationConfig?.quant_method ?? null,
        weightBytes,
      },
      engine: {
        id: standard.engine.id,
        image: flagProbe?.image ?? null,
        kernelImplementation: runtime.options.kernelImplementation ?? null,
      },
      measurements: {
        singleStreamTps: baselinePerf?.decodeTps?.median ?? null,
        decodeTps: baselinePerf?.decodeTps?.median ?? null,
        batchTps: baselinePerf?.throughputTps ?? null,
        ttftMs: baselinePerf?.ttftMs?.median ?? null,
        gpuBusyPct: runtime.options.gpuBusyPct ?? null,
        runningRequests: standard.concurrency,
        kernelMs: null,
        acceptLength: null,
        draftTokens: null,
      },
      limits: {
        kvPoolTokens: runtime.options.kvPoolTokens ?? null,
        maxRunningRequests: runtime.options.maxRunningRequests ?? null,
      },
      provenance: {
        achievableBandwidthGBps: bw?.provenance ?? 'unmeasured',
        // 模型文件扫描是**本机实测**，不是规格书
        bytesPerTokenGB: runtime.options.bytesPerTokenGB ? 'adapter' : (derivedBytesPerTokenGB ? 'model-file-scan' : 'unmeasured'),
        singleStreamTps: 'engine-reported',
        decodeTps: 'engine-reported',
        batchTps: 'engine-reported',
        ttftMs: 'engine-reported',
        gpuBusyPct: runtime.options.gpuBusyPct ? 'adapter' : 'unmeasured',
        kvPoolTokens: runtime.options.kvPoolTokens ? 'adapter' : 'unmeasured',
      },
    },
    derivedBytesPerTokenGB,
    weightBytes,
  }
}

/** 测量成立性：性能四闸 + 精度三闸。 */
function buildValidity({ perfBefore, perfAfter, accuracyBefore, accuracyAfter, steady, params, claimedMinEffectPct = null }) {
  const performanceValidity = evaluatePerformanceValidity({
    aggregation: 'median',
    readyAt: steady?.readyAt ?? null,
    measuredAt: steady?.measuredAt ?? null,
    minSteadyMs: steady?.minSteadyMs ?? 60_000,
    estimator: 'paired-median-delta',
    samples: perfAfter?.succeeded ?? 0,
    // 仪器自洽：声称的最小效应必须大于测量噪声，否则这个仪器**原理上**看不见该效应
    claimedMinEffectPct: claimedMinEffectPct ?? null,
    noisePct: perfAfter?.decodeTps?.relativeStdErrPct ?? null,
    // 本轮的干预目标不是"事件 vs 执行"的时滞对齐，而是端点整体吞吐；
    // 显式跳过并记入报告（不是默认放过）。
    skipLagScan: true,
    lagSkipReason: '本轮度量的对象是端点整体吞吐，不涉及服务端事件与 GPU 执行的时滞对齐',
  })
  // 调优改的是运行时参数（并发/批/缓存规模），**不改变权重**；
  // 且量化格式/缓存 dtype 类参数在 registry 层已被硬排除。
  // 因此两侧服务的是同一份权重 → 第②条闸（逐位相同 ⇒ 测量退化）在此语义下不适用。
  const accuracyValidity = assertAccuracyMeasurementValid({ before: accuracyBefore, after: accuracyAfter, sameWeights: true })
  return { performanceValidity, accuracyValidity }
}

/** 拆解一个端点；失败不抛，交回结构化结果（由调用方决定是否升级为 E_ROLLBACK_FAILED）。 */
async function teardown(runtime, executor, endpoint, tag, log) {
  if (!endpoint?.id) return { ok: true, skipped: true, tag }
  try {
    // 带上本运行自己的 ownerToken —— 没有它，服务端的租约闸门会（正确地）拒绝拆解
    const r = await executor.teardown(runtime, { id: endpoint.id, log, ownerToken: endpoint.ownerToken ?? null })
    return { ...r, tag, endpointId: endpoint.id }
  } catch (err) {
    return { ok: false, tag, endpointId: endpoint.id, code: ERROR_CODES.E_CLEANUP_INCOMPLETE, message: String(err.message).slice(0, 300) }
  }
}

/**
 * 主入口。
 * @returns {{ok, signed, run, report}}
 */
export async function tuneOperation(runtime, { raw = {}, log = null, signal = null, onPhase = null } = {}) {
  const startedAt = nowMs()
  const attempts = []
  const phase = (name, data) => { log?.phase?.(name, data); onPhase?.({ name, ...(data ?? {}), at: nowMs() - startedAt }) }

  // ---------- 0. 输入 ----------
  phase('probe')
  const standard = await runInputPipeline(runtime, raw)

  // ---------- 0b. 目标函数之外的硬约束（最先失败：不依赖沙箱、不依赖确认） ----------
  // 量化格式硬排除是**硬约束**，不是风险档：确认令牌也不能解锁它。
  // 放在这里而不是只放在 api 层，是因为 CLI/DSH/程序化调用都走 computeOperation。
  assertNoForbiddenParams(standard.params, { where: 'tune.params' })

  // ---------- 1. 沙箱（R2 容器级） ----------
  phase('sandbox')
  const sandbox = await assertSandbox(runtime, 'container')

  // ---------- 2. 阈值（不猜默认；配置类错误最先失败） ----------
  phase('thresholds')
  const thresholds = resolveThresholds(runtime, {
    maxAccuracyDropPct: standard.thresholds.maxAccuracyDropPct,
    minPerfGainPct: standard.thresholds.minPerfGainPct,
  })

  // ---------- 3. 源模型结构预检（排在起端点之前：坏输入要最便宜地失败） ----------
  phase('source-validate')
  const sourceValidation = await assertSourceModelValid(runtime, standard.model.path)

  // ---------- 4. 风险确认 ----------
  phase('confirm')
  const fp = targetFingerprint('tune', {
    model: standard.model.path, params: standard.params,
    thresholds: { a: thresholds.maxAccuracyDropPct, p: thresholds.minPerfGainPct },
  })
  const confirmation = await resolveConfirmation(runtime, {
    operation: 'tune', payload: { model: standard.model.path, params: standard.params }, confirm: raw.confirm, fingerprint: fp,
  })
  requireConfirmation(confirmation, {
    operation: 'tune',
    summary: `对 ${standard.model.path} 做就地调优：经 serving 起临时端点、应用候选参数、多轮测量、必要时回退。`
      + '只操作本次运行自己创建的端点，不触碰存量端点。',
  })

  const runId = `tr_${shortId(`${standard.model.path}|${fp}|${startedAt}`, 12)}`
  runtime.__log = log
  // 让精度测量能取到 vocab_size（均匀输出签名需要它；取不到就只能放弃该条判定）
  runtime.__modelPath = standard.model.path

  // ---------- 5. 执行器（能力探测推迟到基线端点就绪之后 —— 镜像要先从容器反查） ----------
  const executor = executorFor(runtime)
  let flagProbe = null
  let bw = null

  // ---------- 6. 基线端点 + 稳态 + 基线测量 ----------
  phase('baseline-deploy')
  const ownedEndpoints = []
  let current = null
  /** serving 发的端点所有权凭证：同一运行内所有 deploy/rollback/teardown 共用它 */
  let ownerToken = null
  let baselinePerf = null
  let baselineAccuracy = null
  const rounds = []
  let outcomeReason = null
  let stopKind = null
  let mustNotify = false
  let rollbackFailure = null
  let activeConfig = { ...standard.params }
  let bestConfig = { ...standard.params }
  let bestPerf = null
  const triedLevers = []
  let wallDiag = null
  // 注意：objective / observed 必须在 try 之外声明 —— 它们要用于 try 之后的报告构建（踩过一次 ReferenceError）
  let objective = null
  let observed = null
  let ceiling = null
  let ceilingChain = null
  let memory = null
  let memoryLevers = null

  try {
    current = await executor.deploy(runtime, {
      modelPath: standard.model.path, params: activeConfig,
      servedModelName: standard.engine.servedModelName,
      supportedFlags: flagProbe?.supported ?? null, log,
    })
    // 本次运行的端点身份 —— 后续所有 deploy / rollback / teardown 都带上它
    ownerToken = current.ownerToken ?? null
    // **serving 按模型给端点做键**：同模型换参数 = 同一端点的新 revision，不是两个端点。
    // 因此本包自始至终只拥有**一个**端点，收尾时拆它一次。
    ownedEndpoints.push({ tag: 'baseline', ...current })

    phase('baseline-ready')
    const ready = await executor.ready(runtime, { endpoint: current.endpoint, timeoutMs: runtime.options.deployTimeoutMs })
    if (!ready.ready) {
      fail(ERROR_CODES.E_ENDPOINT_UNHEALTHY, `基线端点在超时内未就绪：${current.endpoint}`, {
        remediation: '检查 serving 的端点日志；可能是模型/镜像/显存问题。',
        details: { endpoint: current.endpoint, waitedMs: ready.waitedMs },
      })
    }
    // ---------- 6b. 能力探测：镜像优先由**运行中的容器**反查 ----------
    // 这样既不改 serving（它不暴露 image），也不要求调用方预先配置镜像。
    phase('capabilities')
    const engineImage = runtime.options.engineImage ?? current.image ?? null
    if (!engineImage) {
      runtime.warnings?.push?.(warn(WARNING_CODES.W_POLICY_DEFAULTED,
        '未取到引擎镜像（容器反查失败且未配置 options.engineImage）—— '
        + 'flag 探测与带宽微基准都无法运行，带宽墙将判 unknown。'
        + '补救：传 options.engineImage，或确认 docker 可 inspect 该容器。',
        { containerName: current.containerName ?? null, resolved: current.image ?? null }))
    }
    const flagsWanted = Object.values(PARAM_CATALOG).flatMap((p) => p.flags?.vllm ?? [])
    flagProbe = engineImage
      ? await executor.probeEngineFlags(runtime, { flags: flagsWanted, image: engineImage, log })
      : { supported: new Set(), probed: false, missing: [], image: null, reason: '无引擎镜像' }
    bw = await measureAchievableBandwidth({
      run: () => executor.bandwidthProbe(runtime, { image: engineImage, log }),
    })
    if (!bw?.GBps) {
      runtime.warnings?.push?.(warn(WARNING_CODES.W_POLICY_DEFAULTED,
        `实测可达带宽探针未产出结果（${bw?.provenance ?? 'unknown'}）—— 带宽墙将判 unknown；`
        + '**禁止**用规格书峰值代替（那会算出"看起来合理"的上界并误判到顶）',
        { image: engineImage, provenance: bw?.provenance ?? null, note: bw?.note ?? null }))
    }

    // 稳态闸：就绪后必须等够窗口（重启后早期窗口会塌陷）
    const steadyWaitMs = runtime.options.steadyStateWaitMs
    phase('steady-wait', { ms: steadyWaitMs })
    await new Promise((r) => { setTimeout(r, steadyWaitMs) })

    phase('baseline-measure')
    const measuredAt = nowMs()
    baselinePerf = await executor.measure(runtime, {
      endpoint: current.endpoint, model: current.servedModelName,
      workload: standard.workload, requests: standard.requests, concurrency: standard.concurrency, log,
    })
    baselineAccuracy = standard.testSetPath
      ? await parityCheck(runtime, {
        endpointUrl: current.endpoint, model: current.servedModelName, testSetPath: standard.testSetPath,
        label: 'baseline', log,
      })
      : null
    bestPerf = baselinePerf

    // ---------- 7. 墙诊断 ----------
    phase('wall-diagnose')
    observed = deriveObservedContext({ runtime, standard, sourceValidation, baselinePerf, bw, flagProbe })
    const wallCtx = observed.ctx

    wallDiag = diagnoseWalls(wallCtx)
    ceiling = singleStreamCeiling(wallCtx)
    ceilingChain = evidenceChain(wallCtx, ceiling)
    memory = decomposeByFormula({
      // 结构优先取**模型自己的** config.json（本机实测读出来的），调用方可覆盖。
      // 缺 kv heads / head_dim 时**不猜** —— 由 decomposeByFormula 报 missing。
      config: {
        numHiddenLayers: sourceValidation?.evidence?.config?.numHiddenLayers ?? null,
        numKeyValueHeads: runtime.options.numKeyValueHeads ?? sourceValidation?.evidence?.config?.numKeyValueHeads ?? null,
        headDim: runtime.options.headDim ?? sourceValidation?.evidence?.config?.headDim ?? null,
        hiddenSize: sourceValidation?.evidence?.config?.hiddenSize ?? null,
        numAttentionHeads: sourceValidation?.evidence?.config?.numAttentionHeads ?? null,
        intermediateSize: sourceValidation?.evidence?.config?.intermediateSize ?? null,
        stateCacheBytesPerToken: runtime.options.stateCacheBytesPerToken ?? null,
      },
      budgetBytes: runtime.options.memoryBudgetBytes ?? null,
      weightsBytes: observed.weightBytes ?? null,
      overheadBytes: runtime.options.overheadBytes ?? null,
      kvDtype: runtime.options.kvCacheDtype ?? null,
      unifiedMemory: runtime.options.unifiedMemory ?? null,
      maxContextLength: runtime.options.maxContextLength ?? null,
    })
    memoryLevers = attributeLevers({
      breakdown: memory, config: {}, kvDtype: runtime.options.kvCacheDtype ?? null,
      contextLength: runtime.options.maxContextLength ?? null,
      seqBudgetNew: runtime.options.seqBudgetNew ?? null,
      unifiedMemory: runtime.options.unifiedMemory ?? null,
    })

    // ---------- 8. 调优循环 ----------
    objective = defineObjective({
      model: standard.model.path,
      metric: 'decodeTps',
      target: raw.targetTps ? { metric: 'decodeTps', value: Number(raw.targetTps), direction: 'increase' } : null,
      thresholds: { maxAccuracyDropPct: thresholds.maxAccuracyDropPct, minPerfGainPct: thresholds.minPerfGainPct },
      exclusions: [{ kind: 'quant-format-unchanged' }],
      budgetMs: Number.isFinite(Number(raw.budgetMs)) ? Number(raw.budgetMs) : runtime.options.budgetMs,
      maxRounds: Number.isFinite(Number(raw.maxRounds)) ? Number(raw.maxRounds) : runtime.options.maxRounds,
    })

    for (let round = 1; round <= objective.maxRounds; round += 1) {
      if (signal?.aborted) {
        outcomeReason = '用户中止（signal aborted）'
        stopKind = STOP_KINDS.USER_ABORT
        break
      }
      const rd = {
        round, startedAt: new Date().toISOString(), wallId: null, lever: null,
        proposal: null, before: null, after: null, validity: null, gates: null,
        decision: null, reflection: null, ms: 0,
      }
      const rStart = nowMs()

      const rootWall = wallDiag?.rootWall
      if (!rootWall) {
        outcomeReason = '没有可用的根因墙（观测不足）'
        rd.decision = 'no-root-wall'
        rd.ms = nowMs() - rStart
        rounds.push(rd)
        break
      }
      const remedy = top1For(rootWall.id)
      if (!remedy) {
        outcomeReason = `墙 ${rootWall.id} 没有登记的干预映射`
        rd.decision = 'no-remedy'
        rd.ms = nowMs() - rStart
        rounds.push(rd)
        break
      }
      rd.wallId = rootWall.id
      rd.lever = remedy.lever
      rd.wallState = { state: rootWall.state, utilization: rootWall.utilization, bound: rootWall.bound, unit: rootWall.unit }

      // 8a. 预注册（先声明预期，再执行 —— 搜索只是验证手段）
      rd.proposal = proposeCandidate({ base: activeConfig, lever: remedy.lever, direction: remedy.semantics?.direction ?? 'increase' })
      assertNoForbiddenParams(rd.proposal.params, { where: `round-${round}` })
      // **执行之前**登记预注册（含指纹与登记时间）。事后判定以它为准 ——
      // 这是"搜索只是验证手段，不是发现手段"的落地件。
      rd.prereg = preregister({
        hypothesis: `${rootWall.id} 是根因墙：通过 ${remedy.lever} 可解除它`,
        wallId: rootWall.id,
        lever: remedy.lever,
        metric: 'decodeTps',
        direction: remedy.semantics?.direction ?? 'increase',
        minEffectPct: thresholds.minPerfGainPct,
        aggregation: 'median',
        samples: standard.requests,
        falsify: (remedy.falsify ?? []).join('；') || '未观察到该指标按预期方向变化',
        expectedValue: null,
      })
      rd.preregisteredAt = rd.prereg.registeredAt

      // 8b. 起候选端点
      phase('round-deploy', { round, lever: remedy.lever })
      let candidate = null
      try {
        candidate = await executor.deploy(runtime, {
          ownerToken,
          modelPath: standard.model.path, params: rd.proposal.params,
          servedModelName: `${standard.engine.servedModelName}-r${round}`.slice(0, 60),
          supportedFlags: flagProbe?.supported ?? null, log,
        })
        // 候选与基线是**同一个端点 id**（新 revision）—— 不再 push 第二个所有权条目
        rd.sameEndpoint = candidate.id === current.id
        rd.candidateRevision = candidate.revision ?? null
        const ready2 = await executor.ready(runtime, { endpoint: candidate.endpoint, timeoutMs: runtime.options.deployTimeoutMs })
        if (!ready2.ready) {
          fail(ERROR_CODES.E_ENDPOINT_UNHEALTHY, `候选端点在超时内未就绪（第 ${round} 轮）`, {
            remediation: '参数可能让服务起不来（显存/长度/批大小不合理）。已放弃本轮并保留原配置。',
            details: { endpoint: candidate.endpoint, params: rd.proposal.params, waitedMs: ready2.waitedMs },
          })
        }
        await new Promise((r) => { setTimeout(r, steadyWaitMs) })

        // 8c. 双闭环测量
        phase('round-measure', { round })
        const candMeasuredAt = nowMs()
        const candPerf = await executor.measure(runtime, {
          endpoint: candidate.endpoint, model: candidate.servedModelName,
          workload: standard.workload, requests: standard.requests, concurrency: standard.concurrency, log,
        })
        const candAccuracy = standard.testSetPath
          ? await parityCheck(runtime, {
            endpointUrl: candidate.endpoint, model: candidate.servedModelName,
            testSetPath: standard.testSetPath, label: `round-${round}`, log,
          })
          : null
        rd.measuredAt = new Date().toISOString()

        rd.before = { perf: { decodeTps: baselinePerf.decodeTps.median, ttftMs: baselinePerf.ttftMs.median }, accuracy: baselineAccuracy ? { meanNll: baselineAccuracy.meanNll, perplexity: baselineAccuracy.perplexity } : null }
        rd.after = { perf: { decodeTps: candPerf.decodeTps.median, ttftMs: candPerf.ttftMs.median }, accuracy: candAccuracy ? { meanNll: candAccuracy.meanNll, perplexity: candAccuracy.perplexity } : null }

        const perfCmp = comparePerf(baselinePerf, candPerf)
        const parityCmp = candAccuracy && baselineAccuracy
          ? compareParity({ before: baselineAccuracy, after: candAccuracy, evidence: { testSetPath: standard.testSetPath, round } })
          : null

        const validity = buildValidity({
          perfBefore: baselinePerf, perfAfter: candPerf,
          accuracyBefore: baselineAccuracy, accuracyAfter: candAccuracy,
          steady: { readyAt: ready2.readyAt, measuredAt: candMeasuredAt, minSteadyMs: steadyWaitMs },
          params: rd.proposal.params,
          claimedMinEffectPct: thresholds.minPerfGainPct,
        })
        rd.validity = {
          performance: validity.performanceValidity.valid,
          performanceReasons: validity.performanceValidity.reasons.map((x) => x.code),
          accuracy: validity.accuracyValidity.valid,
          accuracyReasons: validity.accuracyValidity.reasons.map((x) => x.code),
          checks: { ...validity.performanceValidity.checks, ...validity.accuracyValidity.checks },
        }

        const gates = evaluateGates({
          perf: { gainPct: perfCmp.gain.decodeTpsPct },
          accuracy: { dropPct: parityCmp?.drop.pct ?? null },
          thresholds,
          performanceValidity: validity.performanceValidity,
          accuracyValidity: validity.accuracyValidity,
        })
        rd.gates = { decision: gates.decision, passed: gates.passed, measurementValid: gates.measurementValid, reasons: gates.reasons, perfGainPct: perfCmp.gain.decodeTpsPct, accuracyDropPct: parityCmp?.drop.pct ?? null }

        // **拿预注册去判实测**（不是反过来）。三种结局：confirmed / falsified / inconclusive。
        rd.preregJudge = judge({
          registration: rd.prereg,
          observed: { decodeTps: candPerf.decodeTps.median, deltaPct: perfCmp.gain.decodeTpsPct },
          measurementValid: gates.measurementValid,
          measurementReasons: [...validity.performanceValidity.reasons, ...validity.accuracyValidity.reasons],
        })
        rd.preregTiming = checkPreregTiming({ registration: rd.prereg, executedAt: rd.measuredAt })
        // 仪器自洽：单独的判定（它回答"这个仪器看不看得见"，与"效应在不在"是两件事）
        rd.instrumentMatch = checkInstrumentSelfMatch({
          minEffectPct: thresholds.minPerfGainPct,
          noisePct: candPerf.decodeTps.relativeStdErrPct,
          samples: candPerf.succeeded,
        })
        rd.perfComparison = perfCmp.gain
        rd.parity = parityCmp ? { dropPct: parityCmp.drop.pct, validity: parityCmp.validity, evidence: parityCmp.evidence } : null

        if (gates.decision === 'accept' || gates.decision === 'confirm-near-limit') {
          // 接受：候选 revision 就是新的 current —— **不需要拆任何东西**
          // （同一个端点，serving 已经把旧 revision 标记为被取代并保留供 rollback）
          current = candidate
          activeConfig = rd.proposal.params
          baselinePerf = candPerf
          baselineAccuracy = candAccuracy
          if (perfCmp.gain.decodeTpsPct > (bestPerf?.__gain ?? -Infinity)) bestConfig = { ...rd.proposal.params }
          bestPerf = candPerf
          rd.decision = 'accepted'
          triedLevers.push(`${rootWall.id}:${remedy.lever}`)
        } else if (gates.decision === 'undetermined') {
          // 测量不成立：不改判数值，也不接受 —— 回退到上一个已验证 revision
          const rb = await executor.rollback(runtime, { selector: current.id, log, ownerToken })
          const back = rb.ok ? await executor.ready(runtime, { endpoint: rb.endpoint?.endpoint ?? current.endpoint, timeoutMs: 120_000 }) : { ready: false }
          if (!rb.ok || !back.ready) {
            rollbackFailure = {
              round,
              reason: !rb.ok ? `serving 回退失败：${rb.code}` : '回退后端点健康检查失败',
              detail: { rollback: rb, health: back },
            }
            rd.decision = 'rollback-failed'
            break
          }
          current = { ...current, endpoint: rb.endpoint?.endpoint ?? current.endpoint, port: rb.endpoint?.port ?? current.port, revision: rb.toRevision ?? null }
          rd.rolledBackTo = rb.toRevision ?? null
          rd.decision = 'rejected-invalid-measurement'
          rd.reflection = reflectOnIneffectiveIntervention({
            wallId: rootWall.id, lever: remedy.lever,
            before: { decodeTps: baselinePerf.decodeTps.median },
            after: { decodeTps: candPerf.decodeTps.median },
            measurementValid: false,
            measurementReasons: [...validity.performanceValidity.reasons, ...validity.accuracyValidity.reasons],
            appliedConfig: rd.proposal.params, observedConfig: candidate.applied,
          })
        } else {
          // 回退到上一个已验证 revision（serving 的 rollback 会按其配置重新部署）
          const rb = await executor.rollback(runtime, { selector: current.id, log, ownerToken })
          const back = rb.ok ? await executor.ready(runtime, { endpoint: rb.endpoint?.endpoint ?? current.endpoint, timeoutMs: 120_000 }) : { ready: false }
          if (!rb.ok || !back.ready) {
            rollbackFailure = {
              round,
              reason: !rb.ok ? `serving 回退失败：${rb.code} — ${rb.message ?? ''}` : '回退后端点健康检查失败',
              detail: { rollback: rb, health: back },
            }
            rd.decision = 'rollback-failed'
            break
          }
          current = { ...current, endpoint: rb.endpoint?.endpoint ?? current.endpoint, port: rb.endpoint?.port ?? current.port, revision: rb.toRevision ?? null }
          rd.rolledBackTo = rb.toRevision ?? null
          rd.decision = 'rejected-rolled-back'
          triedLevers.push(`${rootWall.id}:${remedy.lever}`)
          rd.reflection = reflectOnIneffectiveIntervention({
            wallId: rootWall.id, lever: remedy.lever,
            before: { decodeTps: baselinePerf.decodeTps.median },
            after: { decodeTps: candPerf.decodeTps.median },
            measurementValid: gates.measurementValid,
            measurementReasons: [],
            appliedConfig: rd.proposal.params, observedConfig: candidate.applied,
            wallDiagBefore: wallDiag, wallDiagAfter: wallDiag,
            limitingConditions: collectLimitingConditions({
              wallDiag, engine: { kernelImplementation: runtime.options.kernelImplementation },
              model: { quantFormat: sourceValidation?.evidence?.config?.quantizationConfig?.quant_method },
            }),
          })
          // 干预无效 → 重诊断（墙可能转移），**不直接换参数**
          wallDiag = diagnoseWalls(wallCtx)
    ceiling = singleStreamCeiling(wallCtx)
    ceilingChain = evidenceChain(wallCtx, ceiling)
    memory = decomposeByFormula({
      // 结构优先取**模型自己的** config.json（本机实测读出来的），调用方可覆盖。
      // 缺 kv heads / head_dim 时**不猜** —— 由 decomposeByFormula 报 missing。
      config: {
        numHiddenLayers: sourceValidation?.evidence?.config?.numHiddenLayers ?? null,
        numKeyValueHeads: runtime.options.numKeyValueHeads ?? sourceValidation?.evidence?.config?.numKeyValueHeads ?? null,
        headDim: runtime.options.headDim ?? sourceValidation?.evidence?.config?.headDim ?? null,
        hiddenSize: sourceValidation?.evidence?.config?.hiddenSize ?? null,
        numAttentionHeads: sourceValidation?.evidence?.config?.numAttentionHeads ?? null,
        intermediateSize: sourceValidation?.evidence?.config?.intermediateSize ?? null,
        stateCacheBytesPerToken: runtime.options.stateCacheBytesPerToken ?? null,
      },
      budgetBytes: runtime.options.memoryBudgetBytes ?? null,
      weightsBytes: observed.weightBytes ?? null,
      overheadBytes: runtime.options.overheadBytes ?? null,
      kvDtype: runtime.options.kvCacheDtype ?? null,
      unifiedMemory: runtime.options.unifiedMemory ?? null,
      maxContextLength: runtime.options.maxContextLength ?? null,
    })
    memoryLevers = attributeLevers({
      breakdown: memory, config: {}, kvDtype: runtime.options.kvCacheDtype ?? null,
      contextLength: runtime.options.maxContextLength ?? null,
      seqBudgetNew: runtime.options.seqBudgetNew ?? null,
      unifiedMemory: runtime.options.unifiedMemory ?? null,
    })
        }
      } catch (err) {
        rd.error = { code: err.code ?? ERROR_CODES.E_TUNING_FAILED, message: String(err.message).slice(0, 500) }
        rd.decision = rd.decision ?? 'error'
        // 异常路径：候选与基线是同一个端点，**不要**在这里拆它 ——
        // 交给 finally 统一拆一次，避免"拆了候选等于拆了基线"。
        if (!rollbackFailure) { rd.ms = nowMs() - rStart; rounds.push(rd); break }
      }

      rd.ms = nowMs() - rStart
      rounds.push(rd)
      attempts.push(rd)
      await metricsBump(runtime, rd.decision === 'accepted' ? 'round_accepted' : 'round_rejected')

      if (rollbackFailure) break

      // 8d. 不停机判据
      const budgetExceeded = objective.budgetMs !== null && (nowMs() - startedAt) > objective.budgetMs
      const decision = decideRunOutcome({
        objective, round, wallDiag, triedLevers,
        measurements: { decodeTps: baselinePerf.decodeTps.median },
        budgetExceeded,
        engine: { kernelImplementation: runtime.options.kernelImplementation, version: flagProbe?.image },
        model: { quantFormat: sourceValidation?.evidence?.config?.quantizationConfig?.quant_method, kvPrecision: runtime.options.kvCacheDtype },
      })
      rd.runOutcome = { action: decision.action, stopKind: decision.stopKind ?? null, reason: decision.reason, warnings: (decision.warnings ?? []).map((w) => w.code) }
      for (const w of decision.warnings ?? []) {
        runtime.warnings?.push?.(warn(WARNING_CODES.W_POLICY_DEFAULTED, `[${w.code}] ${w.message}`, {}))
      }
      if (decision.action === RUN_OUTCOME.STOP) {
        outcomeReason = decision.reason
        stopKind = decision.stopKind
        mustNotify = decision.mustNotify === true
        rd.limitedBy = decision.limitedBy ?? null
        break
      }
      if (decision.action === RUN_OUTCOME.YIELD_RESUMABLE) {
        outcomeReason = decision.reason
        rd.resumeFrom = decision.resumeFrom ?? null
        break
      }
    }
  } finally {
    // ---------- 9. 收尾：拆解所有自有端点并验证无残留 ----------
    phase('cleanup')
    if (rollbackFailure) {
      // 回滚失败：**独立风险档**。仍然尝试拆解，但结论是"必须叫人"。
      mustNotify = true
      for (const e of [...ownedEndpoints]) {
        // eslint-disable-next-line no-await-in-loop
        await teardown(runtime, executor, e, `rollback-failed-${e.tag}`, log)
      }
    } else {
      for (const e of ownedEndpoints) {
        // eslint-disable-next-line no-await-in-loop
        const r = await teardown(runtime, executor, e, e.tag, log)
        if (!r.ok) {
          runtime.warnings?.push?.(warn(WARNING_CODES.W_RESIDUAL_CLEANUP,
            `端点 ${e.id} 未拆干净：${r.code}`, r))
        }
      }
    }
  }

  // ---------- 10. 结果裁定 ----------
  const earlyStop = detectEarlyStop({
    wallDiag, triedLevers, stopKind,
    measurementValid: rounds.length ? (rounds.at(-1)?.validity?.performance ?? null) : null,
    roundsRun: rounds.length,
  })
  const limiting = collectLimitingConditions({
    wallDiag,
    engine: { kernelImplementation: runtime.options.kernelImplementation, version: flagProbe?.image },
    model: { quantFormat: sourceValidation?.evidence?.config?.quantizationConfig?.quant_method, kvPrecision: runtime.options.kvCacheDtype },
  })

  const accepted = rounds.filter((r) => r.decision === 'accepted')
  const signed = accepted.length > 0 && !rollbackFailure
  const finalPerfGain = baselinePerf && bestPerf ? ((bestPerf.decodeTps.median - (rounds[0]?.before?.perf?.decodeTps ?? bestPerf.decodeTps.median)) / Math.max(1e-9, rounds[0]?.before?.perf?.decodeTps ?? bestPerf.decodeTps.median)) * 100 : 0

  // ---------- 10c. 可复用配置（spec）+ GPU 规格（实测优先） ----------
  const runSpec = captureRunSpec({
    model: { path: standard.model.path, validation: { tensors: sourceValidation?.evidence?.totalTensors ?? null, zeroTensors: sourceValidation?.evidence?.totalZeroTensors ?? null } },
    engine: {
      id: standard.engine.id,
      image: flagProbe?.image ?? standard.engine.image ?? null,
      // ── 镜像固定（用户验收标准第 6 条）──────────────────────────────
      // 集成测试取证：本机**取得到** digest（vllm 有 RepoDigest，本地构建的镜像有
      // 内容寻址 ID），此前记 null 不是因为取不到，而是只读了 tag 字符串。
      // tag（尤其 nightly）会漂 → 重放不出同一个端点 → replayable=false。
      // 这里用从**运行中的容器**反查到的内容寻址引用。
      imageDigest: current?.imageId ?? current?.imageDigest ?? null,
      servedModelName: standard.engine.servedModelName,
      kvCacheDtype: runtime.options.kvCacheDtype ?? null,
    },
    params: bestConfig,
    workload: standard.workload,
    requests: standard.requests,
    concurrency: standard.concurrency,
    testSet: standard.testSetPath ? { path: standard.testSetPath } : null,
    metadata: { runId, rootWall: wallDiag?.rootWall?.id ?? null, outcome: null, note: 'metadata 不参与指纹' },
  })
  const gpuSpecResolved = resolveGpuSpec({
    deviceName: runtime.options.machineName ?? null,
    measured: {
      achievableBandwidthGBps: bw?.GBps ?? null,
      measuredPeakFlops: runtime.options.measuredPeakFlops ?? null,
      memoryBytes: runtime.options.memoryBytes ?? null,
      dedicatedVramBytes: runtime.options.dedicatedVramBytes ?? null,
      unifiedMemory: runtime.options.unifiedMemory ?? null,
      measurementMethod: bw?.method ?? null,
      measuredAt: new Date().toISOString(),
    },
  })

  // ---------- 10b. 主张门禁：报告里每一条承重陈述都要带出处等级 ─---------
  // 这一道**不产生新数值**，只做一件事：拦住"把推断写成实测"。
  const claims = gateClaims([
    ...(ceiling?.usable ? [{
      kind: 'ceiling',
      ceiling,
      claimedAs: stopKind === STOP_KINDS.PHYSICAL_LIMIT ? 'physical-limit' : 'observed-ceiling',
    }] : []),
    ...(bestPerf ? [{
      kind: 'quantitative',
      name: 'finalDecodeTps',
      value: bestPerf.decodeTps.median,
      unit: 'tok/s',
      aggregation: bestPerf.aggregation,
      samples: bestPerf.succeeded,
      provenance: 'measured',
      evidence: { endpoint: 'serving-owned', source: 'endpoint-sse-stream' },
    }] : []),
    ...(baselinePerf ? [{
      kind: 'quantitative',
      name: 'baselineDecodeTps',
      value: baselinePerf.decodeTps.median,
      unit: 'tok/s',
      aggregation: baselinePerf.aggregation,
      samples: baselinePerf.succeeded,
      provenance: 'measured',
      evidence: { source: 'endpoint-sse-stream' },
    }] : []),
    ...(wallDiag?.rootWall ? [{
      kind: 'claim',
      claim: `根因墙是 ${wallDiag.rootWall.id}`,
      provenance: 'derived',
      evidence: {
        formula: wallDiag.rootWall.formula,
        utilization: wallDiag.rootWall.utilization,
        inputs: wallDiag.rootWall.inputs,
        provenanceOfInputs: wallDiag.rootWall.provenance,
      },
    }] : []),
    ...(wallDiag?.unknownWalls?.length ? [{
      kind: 'inferred',
      claim: `${wallDiag.unknownWalls.map((w) => w.id).join('/')} 这些墙当前不是瓶颈`,
      basis: '它们因缺观测无法判定，且已有其他墙被判为根因',
      falsifiableBy: `补齐这些墙所需的观测后，它们的利用率高于当前根因墙`
        + `（需要：${wallDiag.unknownObservations.join(', ')}）`,
      presentedAlongsideMeasured: false,
    }] : []),
  ])

  const report = {
    schema: 'inference-tuning/tune-report@1',
    runId,
    pkg: PKG_VERSION,
    generatedAt: new Date().toISOString(),
    durationMs: nowMs() - startedAt,
    model: { input: standard.model.input, path: standard.model.path, isSymlink: standard.model.isSymlink, validation: sourceValidation },
    engine: { id: standard.engine.id, servedModelName: standard.engine.servedModelName, flagProbe: { image: flagProbe?.image ?? null, probed: flagProbe?.probed === true, supported: flagProbe?.supported ? flagProbe.supported.size : 0, missing: flagProbe?.missing ?? [] } },
    thresholds,
    thresholdSource: thresholds.source,
    sandbox: { tier: sandbox.tier, probe: sandbox.probe ? { process: sandbox.probe.process, container: sandbox.probe.container, vm: sandbox.probe.vm } : null },
    observability: {
      achievableBandwidthGBps: bw?.GBps ?? null,
      bandwidthProvenance: bw?.provenance ?? null,
      bandwidthNote: bw?.note ?? null,
      // 分母的来历必须写清楚：是量出来的还是调用方给的
      bytesPerTokenGB: observed?.derivedBytesPerTokenGB ?? null,
      bytesPerTokenGBProvenance: observed?.derivedBytesPerTokenGB ? (runtime.options.bytesPerTokenGB ? 'adapter' : 'model-file-scan') : null,
      modelWeightBytes: observed?.weightBytes ?? null,
    },
    wallDiagnosis: wallDiag ? {
      verdict: wallDiag.verdict,
      rootWall: wallDiag.rootWall ? { id: wallDiag.rootWall.id, state: wallDiag.rootWall.state, utilization: wallDiag.rootWall.utilization, bound: wallDiag.rootWall.bound, unit: wallDiag.rootWall.unit, formula: wallDiag.rootWall.formula, suggestedRemedy: wallDiag.rootWall.suggestedRemedy } : null,
      walls: wallDiag.walls.map((w) => ({ id: w.id, state: w.state, utilization: w.utilization, bound: w.bound, unit: w.unit, missing: w.missing, sanity: w.sanity, actionable: w.actionable })),
      unknownObservations: wallDiag.unknownObservations,
      notes: wallDiag.notes,
    } : null,
    ceiling: ceiling ? {
      usable: ceiling.usable,
      why: ceiling.why ?? null,
      ceilingTps: ceiling.ceilingTps,
      currentTps: ceiling.currentTps,
      utilization: ceiling.utilization,
      gapTps: ceiling.gapTps,
      formula: ceiling.formula,
      inputs: ceiling.inputs,
      provenance: ceiling.provenance,
      // **限定条件是必填**：没有它就不是"上限"，只是"当前观测"
      conditionalOn: ceiling.conditionalOn,
      sanity: ceiling.sanity,
      evidenceChain: ceilingChain ? { nodes: ceilingChain.nodes, verifiable: ceilingChain.verifiable, note: ceilingChain.note } : null,
    } : null,
    memory: memory ? {
      usable: memory.usable,
      unifiedMemory: memory.unifiedMemory,
      formula: memory.formula,
      terms: memory.terms,
      perSlot: memory.perSlot,
      maxTokens: memory.maxTokens,
      maxConcurrentAt: memory.maxConcurrentAt,
      missing: memory.missing,
      provenance: memory.provenance,
      caveat: memory.caveat,
      levers: memoryLevers ? { derivable: memoryLevers.derivableLevers, note: memoryLevers.note } : null,
    } : null,
    baseline: {
      perf: baselinePerf ? { decodeTps: baselinePerf.decodeTps, ttftMs: baselinePerf.ttftMs, throughputTps: baselinePerf.throughputTps, succeeded: baselinePerf.succeeded, aggregation: baselinePerf.aggregation } : null,
      accuracy: baselineAccuracy ? { meanNll: baselineAccuracy.meanNll, perplexity: baselineAccuracy.perplexity, vocabSize: baselineAccuracy.vocabSize, scoredSamples: baselineAccuracy.scoredSamples, tokens: baselineAccuracy.tokens, source: baselineAccuracy.source, validity: baselineAccuracy.validity } : null,
    },
    rounds,
    acceptedRounds: accepted.length,
    finalConfig: bestConfig,
    finalPerf: bestPerf ? { decodeTps: bestPerf.decodeTps.median, ttftMs: bestPerf.ttftMs.median } : null,
    finalPerfGainPct: finalPerfGain,
    objective: { metric: objective?.metric ?? null, target: objective?.target ?? null, exclusions: objective?.exclusions ?? [] },
    outcome: rollbackFailure ? 'rollback-failed'
      : stopKind === STOP_KINDS.PHYSICAL_LIMIT ? 'physical-limit'
        : stopKind === STOP_KINDS.USER_ABORT ? 'user-abort'
          : signed ? 'improved' : 'no-improvement',
    stopKind,
    outcomeReason,
    mustNotify,
    rollbackFailure,
    limitingConditions: limiting,
    earlyStop,
    runSpec: {
      schemaVersion: runSpec.schemaVersion,
      fingerprint: runSpec.fingerprint,
      replayable: runSpec.replayable,
      problems: runSpec.problems,
      spec: runSpec,
      shellCommand: toShellCommand(runSpec, { engineId: standard.engine.id, supportedFlags: flagProbe?.supported ?? null }).command,
    },
    gpuSpec: {
      usable: gpuSpecResolved.usable,
      source: gpuSpecResolved.source,
      why: gpuSpecResolved.why,
      spec: gpuSpecResolved.spec,
      hintFromSpecSheet: gpuSpecResolved.hintFromSpecSheet,
    },
    claims: {
      allOk: claims.allOk,
      total: claims.total,
      ok: claims.ok,
      failed: claims.failed,
      failedDetails: claims.failedDetails,
    },
    testingCore: { contractVersion: PARITY_CONTRACT_VERSION, implementation: 'inference-tuning/internal (@internal 过渡实现)', contractSource: 'docs/parity-contract.md' },
    assumptions: standard.assumptions,
    warnings: runtime.warnings.map((w) => (typeof w.toJSON === 'function' ? w.toJSON() : w)),
  }

  phase('persist')
  const registryRecord = await withRegistry(runtime, (reg) => {
    let rec = findRun(reg, runId)
    if (!rec) {
      rec = { id: runId, model: standard.model.path, createdAt: new Date().toISOString(), history: [] }
      reg.runs.push(rec)
    }
    rec.method = 'root-cause-wall-driven'
    rec.status = report.outcome === 'improved' ? 'improved'
      : report.outcome === 'rollback-failed' ? 'rollback-failed'
        : report.outcome === 'physical-limit' ? 'physical-limit' : 'no-improvement'
    rec.config = bestConfig
    rec.runSpecFingerprint = runSpec.fingerprint
    rec.performance = bestPerf ? { metric: 'decode-tps', decodeTps: bestPerf.decodeTps.median, gainPct: finalPerfGain, aggregation: 'median', samples: bestPerf.succeeded } : null
    rec.accuracy = rounds.find((r) => r.parity)?.parity
      ? { metric: 'perplexity-relative-drop-pct', dropPct: rounds.find((r) => r.parity).parity.dropPct, measurementValid: rounds.find((r) => r.parity).parity.validity.after?.valid ?? null, thresholdPct: thresholds.maxAccuracyDropPct }
      : null
    rec.platform = { engine: standard.engine.id, model: standard.model.path, sandboxTier: sandbox.tier }
    pushHistory(rec, `tune-${report.outcome}`, { rounds: rounds.length, accepted: accepted.length, rootWall: wallDiag?.rootWall?.id ?? null })
    return JSON.parse(JSON.stringify(rec))
  })
  const reportPath = await writeReport(runtime, runId, report)
  report.reportPath = reportPath

  const audit = await appendAudit(runtime, {
    capability: 'tune', action: 'tune', phase: 'end',
    runId, model: standard.model.path, outcome: report.outcome, stopKind,
    rounds: rounds.length, acceptedRounds: accepted.length,
    rootWall: wallDiag?.rootWall?.id ?? null,
    confirmed: confirmation.granted === true,
    rollbackFailed: Boolean(rollbackFailure),
    reportPath,
  })

  await metricsBump(runtime, report.outcome === 'improved' ? 'tune_improved' : 'tune_not_improved')

  if (report.mustNotify || MUST_NOTIFY_FAILURES.has(ERROR_CODES.E_ROLLBACK_FAILED)) {
    if (rollbackFailure) await notifyFailure(runtime, { runId, rollbackFailure, reportPath, log })
  }

  if (rollbackFailure) {
    fail(ERROR_CODES.E_ROLLBACK_FAILED, `回滚失败（第 ${rollbackFailure.round} 轮）：${rollbackFailure.reason}`, {
      remediation: '这是**独立风险档**：目标服务可能停留在未知配置上。'
        + '已尝试拆解本次运行创建的全部端点；请人工确认端点与显存状态，并检查通知渠道是否送达。',
      details: { rollbackFailure, runId, reportPath, auditId: audit.auditId, ownedEndpoints: ownedEndpoints.map((e) => ({ tag: e.tag, id: e.id })) },
    })
  }

  return {
    ok: true,
    signed,
    runId,
    auditId: audit.auditId,
    reportPath,
    run: registryRecord,
    report,
  }
}
