#!/usr/bin/env node
/**
 * 真机端到端演示 —— **可复核证据**：命令 + 输出 + 审计日志。
 *
 * 这个脚本的作用是把"我跑过了"变成"你可以照着复核"：
 *   每一步都打印**实际执行的命令**与**关键输出**，并把全部产物落到 `--out` 目录。
 *
 * 前置（脚本会先自检并说不缺什么）：
 *   · `inference-serving` 可达（MCP）
 *   · 一个**结构完整**的模型目录（残缺会被预检拦下，这是设计如此）
 *   · 一个精度评测集（jsonl，每行 {"h","t"}）
 *   · 沙箱容器级可用（docker + nvidia runtime）
 *
 * 用法：
 *   node scripts/e2e-demo.mjs --model /data/models/Qwen2.5-1.5B-Instruct-verified \
 *       --test-set ~/.ai-infra/state/datasets/.../test.jsonl \
 *       --accuracy-drop 5 --perf-gain 5 --out ./demo-out
 *
 * 刻意**不**自带默认模型路径：默认值会让"跑的是哪个模型"变成一个看不清的假设。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createRuntime } from '../src/config.mjs'
import { createLogger } from '../src/logger.mjs'
import { tuneOperation } from '../src/tuning.mjs'
import { analyzeOperation, healthOperation } from '../src/api.mjs'
import { verifyAllAuditChains, readAudit, auditFileFor } from '../src/audit.mjs'
import { loadRegistry } from '../src/state/tuning-registry.mjs'
import { readMustNotify } from '../src/notify.mjs'
import { toErrorPayload } from '../src/errors.mjs'

function parseArgv(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) { out[k] = true; continue }
    i += 1
    out[k] = v
  }
  return out
}

const args = parseArgv(process.argv.slice(2))
const started = Date.now()
const lines = []
const step = (n, title) => { const s = `\n=== [${n}] ${title} ===`; console.log(s); lines.push(s) }
const say = (m) => { console.log(m); lines.push(m) }
const cmd = (c) => { const s = `$ ${c}`; console.log(s); lines.push(s) }
const dump = (label, v) => {
  const s = `${label}: ${JSON.stringify(v, null, 2)}`
  console.log(s); lines.push(s)
}

async function main() {
  if (!args.model) {
    console.error('必须给 --model（脚本刻意不带默认模型路径：默认值会让"跑的是哪个模型"变成看不清的假设）')
    process.exit(2)
  }
  const outDir = args.out ?? './demo-out'
  await fs.mkdir(outDir, { recursive: true })

  const runtime = await createRuntime({
    options: {
      ...(args.root ? { root: args.root } : {}),
      steadyStateWaitMs: Number(args.steadyStateWaitMs ?? 60_000),
      requests: Number(args.requests ?? 8),
      concurrency: Number(args.concurrency ?? 2),
      maxRounds: Number(args.maxRounds ?? 3),
      machineName: args.machineName ?? null,
    },
  })
  runtime.__log = createLogger({ runtime, stdout: false })
  runtime.warnings = runtime.warnings ?? []

  // ---------------------------------------------------------------- 0
  step(0, '环境自检（沙箱三级实测 + serving 可达性 + 审计链）')
  cmd('node bin/inference-tuning.mjs health --json')
  const health = await healthOperation(runtime, { raw: {} })
  dump('沙箱', { process: health.sandbox.process, container: health.sandbox.container, vm: health.sandbox.vm })
  dump('serving', { reachable: health.serving.reachable, path: health.serving.path ?? health.serving.error })
  dump('审计链', { ok: health.audit.ok, files: health.audit.files })
  if (!health.sandbox.container) {
    say('✗ 容器级沙箱不可用 —— 变更类操作不会在无沙箱下执行。演示中止。')
    await finish(outDir, lines, started, 2)
    return
  }

  // ---------------------------------------------------------------- 1
  step(1, '只读墙诊断（零风险路径；此时还不起任何端点）')
  cmd(`node bin/inference-tuning.mjs analyze --json`)
  const analyze = await analyzeOperation(runtime, { raw: {} })
  dump('verdict', analyze.verdict)
  dump('每堵墙状态', Object.fromEntries((analyze.walls ?? []).map((w) => [w.id, w.state])))
  dump('要测的观测', analyze.unknownObservations)
  if (analyze.recommendedIntervention) {
    dump('建议 TOP1 干预', { lever: analyze.recommendedIntervention.lever, why: analyze.recommendedIntervention.why })
  }

  // ---------------------------------------------------------------- 2
  step(2, '主闭环调优（R2：起端点 → 墙诊断 → TOP1 干预 → 双闭环验证 → 固化/回退）')
  const tuneCmd = `node bin/inference-tuning.mjs tune ${args.model} `
    + `--max-accuracy-drop-pct ${args.accuracyDrop ?? 5} --min-perf-gain-pct ${args.perfGain ?? 5}`
    + (args.testSet ? ` --test-set ${args.testSet}` : '')
  cmd(tuneCmd)
  let tune = await tuneOperation(runtime, {
    raw: {
      model: args.model,
      testSetPath: args.testSet ?? undefined,
      max_accuracy_drop_pct: Number(args.accuracyDrop ?? 5),
      min_perf_gain_pct: Number(args.perfGain ?? 5),
      requests: Number(args.requests ?? 8),
      concurrency: Number(args.concurrency ?? 2),
      maxRounds: Number(args.maxRounds ?? 3),
    },
    onPhase: (p) => say(`  · phase: ${p.name}`),
  }).then((v) => v, (e) => e)

  if (tune?.code === 'E_CONFIRMATION_REQUIRED') {
    say(`serving 式确认闸要求令牌：${tune.details.confirmToken}（R2，per-class-once）`)
    step('2b', '带令牌重跑（这是生产路径的一部分，不是绕过）')
    cmd(`${tuneCmd} --confirm ${tune.details.confirmToken}`)
    tune = await tuneOperation(runtime, {
      raw: {
        model: args.model,
        testSetPath: args.testSet ?? undefined,
        max_accuracy_drop_pct: Number(args.accuracyDrop ?? 5),
        min_perf_gain_pct: Number(args.perfGain ?? 5),
        requests: Number(args.requests ?? 8),
        concurrency: Number(args.concurrency ?? 2),
        maxRounds: Number(args.maxRounds ?? 3),
        confirm: tune.details.confirmToken,
      },
      onPhase: (p) => say(`  · phase: ${p.name}`),
    }).then((v) => v, (e) => e)
  }

  if (tune?.code) {
    say(`✗ 调优未完成：${tune.code} — ${tune.message}`)
    say(`  修法：${tune.remediation}`)
    dump('details', tune.details)
    await finish(outDir, lines, started, 1)
    return
  }

  const r = tune.report
  step(3, '结果裁定')
  dump('outcome / stopKind', { outcome: r.outcome, stopKind: r.stopKind, signed: tune.signed })
  dump('根因墙', r.wallDiagnosis?.rootWall ? {
    id: r.wallDiagnosis.rootWall.id, state: r.wallDiagnosis.rootWall.state,
    utilization: r.wallDiagnosis.rootWall.utilization, bound: r.wallDiagnosis.rootWall.bound,
    formula: r.wallDiagnosis.rootWall.formula, remedy: r.wallDiagnosis.rootWall.suggestedRemedy,
  } : null)
  dump('基线', r.baseline?.perf ? { decodeTps: r.baseline.perf.decodeTps, ttftMs: r.baseline.perf.ttftMs, aggregation: r.baseline.perf.aggregation, samples: r.baseline.perf.succeeded } : null)
  dump('最终配置', r.finalConfig)
  dump('最终性能', r.finalPerf)
  dump('性能增益 %', r.finalPerfGainPct)

  step(4, '每轮证据（测量成立性 + 门禁 + 预注册判定）')
  for (const rd of r.rounds ?? []) {
    say(`--- 第 ${rd.round} 轮：墙=${rd.wallId} 干预=${rd.lever}`)
    say(`    决策 = ${rd.decision}`)
    say(`    测量成立性：性能=${rd.validity?.performance} ${JSON.stringify(rd.validity?.performanceReasons ?? [])}`
      + ` 精度=${rd.validity?.accuracy} ${JSON.stringify(rd.validity?.accuracyReasons ?? [])}`)
    say(`    门禁：${rd.gates?.decision}（精度损失 ${fmt(rd.gates?.accuracyDropPct)}%，性能收益 ${fmt(rd.gates?.perfGainPct)}%）`)
    if (rd.preregJudge) say(`    预注册判定：${rd.preregJudge.verdict} — ${rd.preregJudge.reason}`)
    if (rd.instrumentMatch) say(`    仪器自洽：${rd.instrumentMatch.verdict}（信噪比 ${fmt(rd.instrumentMatch.signalToNoise)}）`)
    if (rd.preregTiming) say(`    预注册时序：${rd.preregTiming.ok ? '早于执行 ✓' : rd.preregTiming.code}`)
    if (rd.reflection?.hypotheses?.length) {
      say(`    五因反思：${rd.reflection.hypotheses.map((h) => h.cause).join(' > ')}`)
      say(`    下一步：${rd.reflection.nextAction}`)
    }
  }

  step(5, 'S2/S3 证据块')
  dump('单流天花板', r.ceiling ? {
    ceilingTps: r.ceiling.ceilingTps, currentTps: r.ceiling.currentTps, utilization: r.ceiling.utilization,
    conditionalOn: (r.ceiling.conditionalOn ?? []).map((c) => c.kind), sanity: r.ceiling.sanity?.ok,
    evidenceChainNodes: r.ceiling.evidenceChain?.nodes?.length ?? 0,
  } : null)
  dump('内存分解', r.memory ? {
    usable: r.memory.usable, maxTokens: r.memory.maxTokens, missing: r.memory.missing,
    derivableLevers: (r.memory.levers?.derivable ?? []).map((l) => l.lever),
  } : null)
  dump('GPU 规格', { usable: r.gpuSpec?.usable, source: r.gpuSpec?.source, why: r.gpuSpec?.why })
  dump('主张门禁', r.claims)
  dump('可复用配置', r.runSpec ? { fingerprint: r.runSpec.fingerprint, replayable: r.runSpec.replayable, problems: r.runSpec.problems.map((p) => p.code), command: r.runSpec.shellCommand } : null)
  dump('过早收尾检测', r.earlyStop)
  dump('限定条件', r.limitingConditions)
  dump('警告', (r.warnings ?? []).map((w) => w.code))

  // ---------------------------------------------------------------- 6
  step(6, '审计与留证')
  const audit = await verifyAllAuditChains(runtime)
  dump('审计链复算', { ok: audit.ok, files: audit.files, results: audit.results?.map((x) => ({ day: x.day, ok: x.ok, checked: x.checked })) })
  const { file, records } = await readAudit(runtime)
  say(`审计文件：${file}（${records.length} 条记录）`)
  say(`最后一条：${JSON.stringify(records.at(-1) ?? null).slice(0, 400)}`)
  const mustNotify = await readMustNotify(runtime)
  dump('未处理的必叫事件', mustNotify ? mustNotify.latest : '无')

  const reg = await loadRegistry(runtime)
  dump('注册表五要素', reg.runs.map((x) => ({
    id: x.id, method: x.method, status: x.status,
    hasConfig: Boolean(x.config), hasPerf: Boolean(x.performance), hasAccuracy: Boolean(x.accuracy),
    runSpecFingerprint: x.runSpecFingerprint ?? null,
  })))

  // 落证
  await fs.writeFile(join(outDir, 'console.log'), `${lines.join('\n')}\n`)
  await fs.writeFile(join(outDir, 'report.json'), JSON.stringify(r, null, 2))
  await fs.copyFile(file, join(outDir, `audit-${file.split('/').pop()}`)).catch(() => {})
  const containerResidue = await scanContainers()
  dump('残留容器', containerResidue)
  await fs.writeFile(join(outDir, 'containers.txt'), `${JSON.stringify(containerResidue, null, 2)}\n`)

  const ok = containerResidue.total === 0 && audit.ok
  say(`\n${ok ? '✅' : '⚠️'} 演示完成：产物在 ${outDir}/`)
  await finish(outDir, lines, started, ok ? 0 : 1)
}

function fmt(v) { return v === null || v === undefined ? 'n/a' : Number(v).toFixed(3) }

async function scanContainers() {
  const { execFile } = await import('node:child_process')
  const run = (args) => new Promise((r) => execFile('docker', args, (e, so) => r(e ? '' : String(so))))
  const q = await run(['ps', '-q', '--filter', 'label=inference-serving.managed=true'])
  const q2 = await run(['ps', '-q', '--filter', 'label=inference-quantization.managed=true'])
  const names = (await run(['ps', '--format', '{{.Names}}'])).split('\n').filter((x) => /inference-(serving|quantization)/.test(x))
  return {
    serving: q.split('\n').filter(Boolean).length,
    quantization: q2.split('\n').filter(Boolean).length,
    managedNames: names,
    total: q.split('\n').filter(Boolean).length + q2.split('\n').filter(Boolean).length,
  }
}

async function finish(outDir, lines, started, code) {
  const tail = `\n总耗时：${((Date.now() - started) / 1000).toFixed(1)}s\n退出码：${code}\n`
  console.log(tail); lines.push(tail)
  await fs.writeFile(join(outDir, 'console.log'), `${lines.join('\n')}\n`).catch(() => {})
  process.exit(code)
}

main().catch(async (err) => {
  const p = toErrorPayload(err)
  console.error(JSON.stringify(p, null, 2))
  console.error(p.details?.stack ?? err?.stack ?? '')
  process.exit(1)
})
