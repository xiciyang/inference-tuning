/**
 * 编程接口（七个操作，与 MCP 工具一一对应）。
 *
 * 纪律（与 serving / quantization 同构）：
 *   - 每个操作先过**能力闸门**：不在能力清单里的调用一律 `E_CAPABILITY_DENIED`，
 *     并给出"该找谁"（量化找 quantization、部署找 serving）。
 *   - 每个操作先过**风险分级**：R0 直接执行；R2 需确认令牌；R6 一律拒绝。
 *   - 错误一律 `toErrorPayload` 规范化 —— 调用方永远拿到结构化结果，不会拿到裸异常。
 */
import { toErrorPayload, fail, ERROR_CODES, warn, WARNING_CODES } from './errors.mjs'
import { hasCapability, capabilityRedirect, describeCapabilities, CAPABILITIES } from './capability.mjs'
import { classifyRisk, resolveConfirmation, requireConfirmation } from './risk.mjs'
import { diagnoseWalls, WallRegistry } from './walls/index.mjs'
import { singleStreamCeiling, evidenceChain } from './walls/ceiling.mjs'
import { decomposeByFormula, decomposeStateCache, attributeLevers } from './walls/memory.mjs'
import { gateCeiling } from './validity/claims.mjs'
import { analyzeClassExcess, projectEndToEndGain, expectedShareFromConfig } from './analysis/class-excess.mjs'
import { decomposeStep, pickRepresentativeStep } from './analysis/step-decomposition.mjs'
import { buildWallContext } from './observe/bandwidth.mjs'
import { top1For, listLevers, REMEDIES } from './walls/remedies.mjs'
import { paramCatalog, PARAM_CATALOG } from './registry.mjs'
import { listRuns, readReport, writeReport } from './state/tuning-registry.mjs'
import { withRegistry, findRun, pushHistory } from './state/tuning-registry.mjs'
import { tuneOperation } from './tuning.mjs'
import { withServing, resolveServingPath } from './serving-client.mjs'
import { probeSandbox } from './sandbox.mjs'
import { verifyAllAuditChains } from './audit.mjs'
import { readMetrics } from './metrics.mjs'
import { readMustNotify } from './notify.mjs'
import { describeContract } from './testing/parity.mjs'
import { assertNoForbiddenParams } from './registry.mjs'

/** 能力闸门：不在清单里 → 拒绝并指路。 */
export function assertCapability(name) {
  if (!hasCapability(name)) {
    const redirect = capabilityRedirect(name)
    fail(ERROR_CODES.E_CAPABILITY_DENIED, `本插件不提供能力：${name}`, {
      remediation: redirect
        ? `**明确不做**：${redirect}。请改用对应的插件。`
        : '本插件只做根因墙驱动的推理调优。能力清单见 `inference-tuning capabilities`。',
      details: { requested: name, provided: Object.keys(CAPABILITIES), redirect },
    })
  }
  return true
}

async function guard(name, runtime, { raw = {}, payload = null } = {}) {
  assertCapability(name)
  const spec = classifyRisk(name)
  const fingerprintPayload = payload ?? raw
  const confirmation = await resolveConfirmation(runtime, {
    operation: name, payload: fingerprintPayload, confirm: raw.confirm ?? payload?.confirm ?? null,
  })
  if (confirmation.required && !confirmation.granted) {
    requireConfirmation(confirmation, { operation: name, summary: spec.summary })
  }
  return { riskSpec: spec, confirmation }
}

const wrap = (capability, fn) => async (runtime, args = {}) => {
  try {
    const out = await fn(runtime, args)
    return { ok: true, capability, ...out }
  } catch (err) {
    return toErrorPayload(err, { capability })
  }
}

// ---------------------------------------------------------------- analyze (R0)

/**
 * **只读**墙诊断。零风险路径：让"先看墙再决定要不要动手"成为可能。
 *
 * 不传观测时不会编造数字 —— 每堵墙会报"该测什么"。
 */
export const analyzeOperation = wrap('analyze', async (runtime, { raw = {} } = {}) => {
  await guard('analyze', runtime, { raw })
  const observations = raw.observations ?? {}
  const ctx = buildWallContext(observations)
  // 允许调用方直接给完整 ctx（高级用法），否则按标准观测形状装配
  const wallCtx = raw.ctx && typeof raw.ctx === 'object' ? raw.ctx : ctx
  const diag = diagnoseWalls(wallCtx, { wallOverride: raw.wall ?? null })

  // S2：单流天花板 + 证据链 + 内存分解，全部在**只读**路径上
  const ceiling = singleStreamCeiling(wallCtx)
  const ceilingGate = ceiling.usable ? gateCeiling({ ceiling, claimedAs: 'observed-ceiling' }) : null
  const memory = raw.memory
    ? decomposeByFormula({ ...raw.memory })
    : decomposeByFormula({
      // 模型结构（层数/KV头/head_dim）可能放在顶层 config，也可能随观测一起给
      config: raw.config ?? observations.config ?? observations.model?.config ?? {},
      budgetBytes: observations.limits?.budgetBytes ?? null,
      weightsBytes: observations.limits?.weightsBytes ?? null,
      overheadBytes: observations.limits?.overheadBytes ?? null,
      kvDtype: observations.limits?.kvDtype ?? null,
      unifiedMemory: observations.limits?.unifiedMemory ?? null,
      maxContextLength: observations.limits?.contextLength ?? observations.model?.contextLength ?? null,
    })
  const memoryLevers = attributeLevers({
    breakdown: memory,
    config: raw.config ?? observations.config ?? observations.model?.config ?? {},
    kvDtype: observations.limits?.kvDtype ?? null,
    targetDtype: raw.targetKvDtype ?? 'float8_e4m3fn',
    contextLength: observations.limits?.contextLength ?? observations.model?.contextLength ?? null,
    seqBudgetNew: observations.limits?.seqBudgetNew ?? null,
    unifiedMemory: observations.limits?.unifiedMemory ?? null,
  })

  // S3：算子类别超额 + 步分解（都只在给了相应观测时才做）
  const expectedShare = raw.expectedShare
    ?? (raw.config ? expectedShareFromConfig({ config: raw.config, contextLength: raw.contextLength ?? observations.model?.contextLength ?? null, batchSize: raw.batchSize ?? 1 }) : null)
  const classExcess = raw.operators
    ? analyzeClassExcess({ operators: raw.operators, expectedShare: expectedShare?.expectedShare ?? null, stepMs: raw.stepMs ?? null })
    : null
  const gainProjection = classExcess?.canJudgeExcess ? projectEndToEndGain({ classExcess, stepMs: raw.stepMs ?? null }) : null
  const stepBreakdown = raw.stepParts
    ? decomposeStep({ stepMs: raw.stepMs ?? null, parts: raw.stepParts })
    : (raw.stepDurationsMs ? pickRepresentativeStep({ stepDurationsMs: raw.stepDurationsMs }) : null)

  const recommended = diag.rootWall ? top1For(diag.rootWall.id) : null
  return {
    classExcess: classExcess ? {
      usable: classExcess.usable,
      canJudgeExcess: classExcess.canJudgeExcess ?? false,
      why: classExcess.why ?? null,
      ranked: classExcess.ranked,
      excess: classExcess.excess,
      deficit: classExcess.deficit ?? [],
      threshold: classExcess.threshold ?? null,
      expectedShare: classExcess.expectedShare ?? null,
      expectedShareBasis: expectedShare?.computed ? expectedShare.basis : (expectedShare?.why ?? null),
      conclusion: classExcess.conclusion ?? null,
      projection: gainProjection,
    } : null,
    stepDecomposition: stepBreakdown ? { ...stepBreakdown } : null,
    ceiling: ceiling.usable ? {
      ceilingTps: ceiling.ceilingTps,
      currentTps: ceiling.currentTps,
      utilization: ceiling.utilization,
      gapTps: ceiling.gapTps,
      formula: ceiling.formula,
      inputs: ceiling.inputs,
      provenance: ceiling.provenance,
      conditionalOn: ceiling.conditionalOn,
      sanity: ceiling.sanity,
      breakdown: ceiling.breakdown,
      claimGate: ceilingGate ? { verdict: ceilingGate.verdict, reasons: ceilingGate.reasons.map((r) => r.code), requiredWording: ceilingGate.requiredWording } : null,
      evidenceChain: evidenceChain(wallCtx, ceiling).nodes,
    } : { usable: false, why: ceiling.why },
    memory: {
      usable: memory.usable,
      formula: memory.formula,
      terms: memory.terms,
      perSlot: memory.perSlot,
      maxTokens: memory.maxTokens,
      maxConcurrentAt: memory.maxConcurrentAt,
      missing: memory.missing,
      caveat: memory.caveat,
      levers: { derivable: memoryLevers.derivableLevers, notDerivable: memoryLevers.notDerivable, note: memoryLevers.note },
    },
    verdict: diag.verdict,
    rootWall: diag.rootWall ? {
      id: diag.rootWall.id, title: diag.rootWall.title, state: diag.rootWall.state,
      utilization: diag.rootWall.utilization, bound: diag.rootWall.bound, unit: diag.rootWall.unit,
      formula: diag.rootWall.formula, detail: diag.rootWall.detail,
      sanity: diag.rootWall.sanity, actionable: diag.rootWall.actionable,
    } : null,
    walls: diag.walls.map((w) => ({
      id: w.id, title: w.title, state: w.state, utilization: w.utilization,
      bound: w.bound, unit: w.unit, formula: w.formula, inputs: w.inputs, provenance: w.provenance,
      missing: w.missing, sanity: w.sanity, actionable: w.actionable, suggestedRemedy: w.suggestedRemedy,
    })),
    unknownObservations: diag.unknownObservations,
    notes: diag.notes,
    specSheetViolation: diag.specSheetViolation,
    recommendedIntervention: recommended ? {
      lever: recommended.lever,
      semantics: recommended.semantics,
      why: recommended.why,
      expected: recommended.expected,
      alternatives: recommended.alternatives,
      falsify: recommended.falsify,
    } : null,
    availableLevers: listLevers().map((l) => l.id),
    paramCatalog: paramCatalog().map((p) => ({ id: p.id, wall: p.wall, kind: p.kind, min: p.min, max: p.max, default: p.default })),
  }
})

// ---------------------------------------------------------------- tune (R2)

export const tuneOperationApi = wrap('tune', async (runtime, args = {}) => {
  const raw = args.raw ?? args
  await guard('tune', runtime, { raw, payload: { model: raw.model, params: raw.params ?? {} } })
  // 量化格式硬排除：入口就拦，不让它走到参数构造
  assertNoForbiddenParams(raw.params ?? {}, { where: 'tune.params' })
  const out = await tuneOperation(runtime, { raw, log: runtime.__log, signal: args.signal ?? null, onPhase: args.onPhase ?? null })
  return out
})

// ---------------------------------------------------------------- validate (R2)

/** 对一组**已有**配置做一次闭环测量（不搜索、不改变目标）。 */
export const validateOperation = wrap('validate', async (runtime, { raw = {} } = {}) => {
  await guard('validate', runtime, { raw, payload: { model: raw.model, params: raw.params ?? {} } })
  assertNoForbiddenParams(raw.params ?? {}, { where: 'validate.params' })
  const { runInputPipeline } = await import('./input/pipeline.mjs')
  const { assertSourceModelValid } = await import('./model-validate.mjs')
  const { executorFor } = await import('./executors/index.mjs')
  await import('./executors/docker.mjs')
  const { parityCheck } = await import('./testing/parity.mjs')
  const { evaluatePerformanceValidity } = await import('./validity/performance.mjs')

  const standard = await runInputPipeline(runtime, raw)
  await assertSourceModelValid(runtime, standard.model.path)
  const executor = executorFor(runtime)
  let ep = null
  try {
    ep = await executor.deploy(runtime, {
      modelPath: standard.model.path, params: standard.params,
      servedModelName: standard.engine.servedModelName, log: runtime.__log,
    })
    const ready = await executor.ready(runtime, { endpoint: ep.endpoint })
    if (!ready.ready) {
      fail(ERROR_CODES.E_ENDPOINT_UNHEALTHY, `端点在超时内未就绪：${ep.endpoint}`, {
        remediation: '检查 serving 的端点日志。', details: { endpoint: ep.endpoint, waitedMs: ready.waitedMs },
      })
    }
    await new Promise((r) => { setTimeout(r, runtime.options.steadyStateWaitMs) })
    const measuredAt = Date.now()
    const perf = await executor.measure(runtime, {
      endpoint: ep.endpoint, model: ep.servedModelName,
      workload: standard.workload, requests: standard.requests, concurrency: standard.concurrency,
    })
    const accuracy = standard.testSetPath
      ? await parityCheck(runtime, { endpointUrl: ep.endpoint, model: ep.servedModelName, testSetPath: standard.testSetPath, label: 'validate' })
      : null
    const validity = evaluatePerformanceValidity({
      aggregation: 'median', readyAt: ready.readyAt, measuredAt,
      minSteadyMs: runtime.options.steadyStateWaitMs,
      estimator: 'median-delta', samples: perf.succeeded, skipLagScan: true,
    })
    return {
      model: standard.model.path, endpoint: { id: ep.id, url: ep.endpoint },
      applied: ep.applied, skipped: ep.skipped,
      perf: { decodeTps: perf.decodeTps, ttftMs: perf.ttftMs, throughputTps: perf.throughputTps, succeeded: perf.succeeded, aggregation: perf.aggregation },
      accuracy: accuracy ? { meanNll: accuracy.meanNll, perplexity: accuracy.perplexity, vocabSize: accuracy.vocabSize, scoredSamples: accuracy.scoredSamples, tokens: accuracy.tokens, validity: accuracy.validity } : null,
      performanceValidity: validity,
    }
  } finally {
    if (ep?.id) {
      try { await executor.teardown(runtime, { id: ep.id }) } catch (err) {
        runtime.warnings.push(warn(WARNING_CODES.W_RESIDUAL_CLEANUP, `validate 端点未拆干净：${err.message}`, { id: ep.id }))
      }
    }
  }
})

// ---------------------------------------------------------------- rollback (R2)

/** 把注册表里某次运行的"生效配置"回退到上一个已接受版本。 */
export const rollbackOperation = wrap('rollback', async (runtime, { raw = {} } = {}) => {
  await guard('rollback', runtime, { raw, payload: { runId: raw.runId } })
  const runId = raw.runId;
  if (!runId) {
    fail(ERROR_CODES.E_INPUT_MISSING, 'rollback 需要 runId', {
      remediation: '先用 `list` 找到要回退的 runId。',
      details: { hint: 'inference-tuning list --json' },
    })
  }
  const out = await withRegistry(runtime, (reg) => {
    const rec = findRun(reg, runId)
    if (!rec) {
      fail(ERROR_CODES.E_RUN_NOT_FOUND, `找不到调优记录：${runId}`, {
        remediation: '用 `list` 查看现有记录。', details: { runId },
      })
    }
    const accepted = (rec.history ?? []).filter((h) => h.event === 'tune-improved')
    if (accepted.length === 0) {
      fail(ERROR_CODES.E_NO_ROLLBACK_TARGET, `该记录没有可回退的历史配置：${runId}`, {
        remediation: '第一次成功调优之前没有"上一版"可回退。', details: { runId, history: rec.history ?? [] },
      })
    }
    const prev = rec.config
    rec.config = null
    rec.status = 'rolled-back'
    pushHistory(rec, 'rollback', { from: prev, reason: raw.reason ?? 'manual' })
    return { runId, previousConfig: prev, note: '注册表已回退；如需让端点也回到该配置，请用 tune 重新应用。' }
  })
  return out
})

// ---------------------------------------------------------------- 其余只读

export const getReportOperation = wrap('get_report', async (runtime, { raw = {} } = {}) => {
  await guard('get_report', runtime, { raw })
  if (raw.runId) {
    const r = await readReport(runtime, raw.runId)
    if (!r) fail(ERROR_CODES.E_RUN_NOT_FOUND, `找不到报告：${raw.runId}`, { remediation: '用 list 查看。', details: { runId: raw.runId } })
    return { runId: raw.runId, report: r }
  }
  const runs = await listRuns(runtime, { limit: raw.limit ?? 20 })
  return { runs }
})

export const listOperation = wrap('list', async (runtime, { raw = {} } = {}) => ({
  runs: await listRuns(runtime, { status: raw.status ?? null, limit: raw.limit ?? 50 }),
}))

export const healthOperation = wrap('health', async (runtime, { raw = {} } = {}) => {
  const sandbox = await probeSandbox(runtime, { skipContainerImage: raw.skipContainerImage === true })
  let serving = { reachable: false, error: null, path: null }
  try {
    const found = await resolveServingPath(runtime)
    serving = await withServing(runtime, async (client) => {
      const out = await client.callTool('inference_serving_doctor', {})
      return { reachable: out.value?.ok !== false, code: out.value?.code ?? null, path: found.serverPath, from: found.from }
    }, { timeoutMs: 120_000 })
  } catch (err) {
    serving = { reachable: false, error: String(err.message).slice(0, 300), code: err.code ?? null }
  }
  const audit = await verifyAllAuditChains(runtime)
  const mustNotify = await readMustNotify(runtime)
  return {
    runtime: { root: runtime.paths.root, version: '0.1.0', node: process.version },
    sandbox: { process: sandbox.process, container: sandbox.container, vm: sandbox.vm, evidence: sandbox.evidence },
    serving,
    audit: { ok: audit.ok, files: audit.files },
    capabilities: describeCapabilities(),
    walls: new WallRegistry().list(),
    remedies: Object.fromEntries(Object.entries(REMEDIES).map(([k, v]) => [k, { top1: v.top1, alternatives: v.alternatives }])),
    params: Object.keys(PARAM_CATALOG),
    mustNotify,
    contract: describeContract(),
  }
})

export const metricsOperation = wrap('metrics', async (runtime) => ({ metrics: await readMetrics(runtime) }))

export const auditVerifyOperation = wrap('audit_verify', async (runtime) => {
  const r = await verifyAllAuditChains(runtime)
  return r
})

export const contractOperation = wrap('contract', async () => ({ contract: describeContract() }))

export const capabilitiesOperation = wrap('doctor', async () => ({ capabilities: describeCapabilities() }))

export {
  tuneOperation, diagnoseWalls, buildWallContext, listLevers, top1For,
  paramCatalog, classifyRisk, assertNoForbiddenParams as assertNoForbidden,
  withRegistry, pushHistory, writeReport, findRun,
}
