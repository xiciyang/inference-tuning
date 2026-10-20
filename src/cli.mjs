/**
 * CLI 入口。与 MCP / 编程 API 共享同一批操作实现（`src/api.mjs`），
 * 保证三个入口的语义**不漂移** —— 这正是"四入口"要求的实质。
 */
import { createRuntime } from './config.mjs'
import { createLogger } from './logger.mjs'
import { toErrorPayload } from './errors.mjs'
import { installSkills } from './skills.mjs'
import {
  tuneOperationApi, analyzeOperation, validateOperation, rollbackOperation,
  getReportOperation, listOperation, healthOperation, metricsOperation,
  auditVerifyOperation, contractOperation, capabilitiesOperation,
} from './api.mjs'

const FLAGS = new Set(['json', 'help', 'skip-container-image', 'deep'])

const HELP = `inference-tuning —— 根因墙驱动的推理调优：诊断瓶颈 → 匹配 TOP1 干预 → 双闭环验证 → 通过则固化，失败则回退

用法  inference-tuning <command> [args] [--options]

  analyze       analyze [--observations FILE] [--wall ID]        —— 【只读】墙诊断（零风险，不跑实验）
  tune          tune <model> --max-accuracy-drop-pct N --min-perf-gain-pct N [options]
  validate      validate <model> [--params JSON]                 —— 对一组已有配置做一次闭环测量
  rollback      rollback <runId> [--reason TEXT]                 —— 回退到上一个已接受配置
  report        report [runId] [--json]                          —— 读调优报告
  spec          spec [runId] [--json]                            —— 打印**可复用的优化配置**（含重放指纹与命令行）
  list          list [--status S] [--json]                       —— 列出调优注册表（含五要素完整性）
  health        health [--skip-container-image] [--json]         —— 沙箱/ serving / 审计链 / 能力清单
  metrics       metrics [--json]                                 —— 指标
  audit-verify  audit-verify [--json]                            —— 复算审计哈希链
  contract      contract                                         —— 打印精度回归契约声明
  capabilities  capabilities                                     —— 打印能力清单与明确不做的事
  doctor        doctor                                           —— 同 health
  install-skills [--dir PATH]                                    —— 把随包 SKILL.md 复制到 skills 目录
  version       version                                          —— 版本
  help          help                                             —— 本帮助

门禁阈值（必填或写进 ~/.ai-infra/config/gates.yaml；本插件**不猜默认值**）
  --max-accuracy-drop-pct N   允许的最大精度损失（困惑度相对退化 %）
  --min-perf-gain-pct N       要求的最小解码吞吐提升（%）

通用选项
  --root PATH                 共享状态根目录（默认 ~/.ai-infra）
  --test-set PATH             精度评测集（jsonl，每行 {"h","t"}）
  --params JSON               起始参数集（语义名）
  --workload NAME             chat-short | chat-medium | decode-heavy | long-prompt
  --requests N                样本数（默认 8）
  --concurrency N             并发（默认 2）
  --max-rounds N              最多轮数（默认 12；**不是停止理由**）
  --budget-ms N               时间预算（**不是停止理由**，用尽则产出可续跑检查点）
  --engine-image IMG          引擎镜像
  --confirm TOKEN             确认令牌（首次调用会在错误里给出）
  --json                      机器可读输出

示例
  inference-tuning analyze --json
  inference-tuning health --json
  inference-tuning tune /path/to/models/<model> \\
      --max-accuracy-drop-pct 5 --min-perf-gain-pct 20 \\
      --params '{"max_num_seqs":32}' --test-set ~/.ai-infra/state/datasets/.../test.jsonl
`

export function parseArgv(argv) {
  const flags = new Set()
  const opts = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) { positional.push(a); continue }
    const key = a.slice(2)
    if (FLAGS.has(key)) { flags.add(key); continue }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) { flags.add(key); continue }
    i += 1
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    opts[camel] = next
  }
  return { flags, opts, positional }
}

function num(v) { return v === undefined ? undefined : Number(v) }
function json(v) { try { return v ? JSON.parse(v) : undefined } catch { return undefined } }

export function buildRaw(opts) {
  const raw = {
    model: opts.model ?? undefined,
    max_accuracy_drop_pct: num(opts.maxAccuracyDropPct),
    min_perf_gain_pct: num(opts.minPerfGainPct),
    params: json(opts.params),
    testSetPath: opts.testSet,
    workload: opts.workload,
    requests: num(opts.requests),
    concurrency: num(opts.concurrency),
    maxRounds: num(opts.maxRounds),
    budgetMs: num(opts.budgetMs),
    runId: opts.runId,
    reason: opts.reason,
    confirm: opts.confirm,
    engineImage: opts.engineImage,
  }
  for (const k of Object.keys(raw)) if (raw[k] === undefined) delete raw[k]
  return raw
}

export async function main(argv) {
  const [command, ...rest] = argv
  const { flags, opts, positional } = parseArgv(rest)
  const asJson = flags.has('json')
  if (!command || command === 'help' || flags.has('help')) {
    process.stdout.write(HELP)
    return 0
  }
  const runtime = await createRuntime({ root: opts.root, options: {} })
  runtime.__log = createLogger({ runtime, stdout: false })

  const emit = (out) => {
    if (asJson) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    else process.stdout.write(formatHuman(command, out))
    return out?.ok === false ? 2 : 0
  }

  switch (command) {
    case 'analyze': {
      const observations = opts.observations ? JSON.parse(await readMaybe(opts.observations)) : undefined
      return emit(await analyzeOperation(runtime, { raw: { observations, wall: opts.wall } }))
    }
    case 'tune': {
      const raw = buildRaw({ ...opts, model: opts.model ?? positional[0] })
      return emit(await tuneOperationApi(runtime, { raw }))
    }
    case 'validate': {
      const raw = buildRaw({ ...opts, model: opts.model ?? positional[0] })
      return emit(await validateOperation(runtime, { raw }))
    }
    case 'rollback':
      return emit(await rollbackOperation(runtime, { raw: { runId: opts.runId ?? positional[0], reason: opts.reason, confirm: opts.confirm } }))
    case 'spec': {
      const id = opts.runId ?? positional[0]
      const out = await getReportOperation(runtime, { raw: { runId: id } })
      if (out.ok === false) return emit(out)
      const rs = out.report?.runSpec
      if (!rs) {
        process.stderr.write(`该运行没有 run-spec：${id ?? '(未指定)'}\n`)
        return 2
      }
      return emit({ ok: true, runId: id, ...rs })
    }
    case 'report': {
      const out = await getReportOperation(runtime, { raw: { runId: opts.runId ?? positional[0], limit: num(opts.limit) } })
      return emit(out)
    }
    case 'list':
      return emit(await listOperation(runtime, { raw: { status: opts.status, limit: num(opts.limit) } }))
    case 'health':
    case 'doctor':
      return emit(await healthOperation(runtime, { raw: { skipContainerImage: flags.has('skip-container-image') } }))
    case 'metrics':
      return emit(await metricsOperation(runtime, {}))
    case 'audit-verify':
      return emit(await auditVerifyOperation(runtime, {}))
    case 'contract':
      return emit(await contractOperation(runtime, {}))
    case 'capabilities':
      return emit(await capabilitiesOperation(runtime, {}))
    case 'install-skills': {
      const r = await installSkills({ dir: opts.dir })
      return emit({ ok: true, ...r })
    }
    case 'version':
      process.stdout.write('inference-tuning 0.1.0\n')
      return 0
    default:
      process.stderr.write(`未知命令：${command}\n\n${HELP}`)
      return 2
  }
}

async function readMaybe(p) {
  const { readText } = await import('./util/fsx.mjs')
  return (await readText(p, null)) ?? '{}'
}

function formatHuman(command, out) {
  if (!out || out.ok === false) {
    const lines = [`✗ ${out?.code ?? 'ERROR'}：${out?.message ?? ''}`]
    if (out?.remediation) lines.push(`  修法：${out.remediation}`)
    if (out?.details?.confirmToken) lines.push(`  确认令牌：${out.details.confirmToken}`)
    return `${lines.join('\n')}\n`
  }
  if (command === 'analyze') {
    const lines = [`墙诊断：${out.verdict}`]
    for (const w of out.walls ?? []) {
      const util = w.utilization === null ? '  n/a' : `${(w.utilization * 100).toFixed(1)}%`
      lines.push(`  ${w.id.padEnd(12)} ${String(w.state).padEnd(9)} util=${util.padStart(6)}  ${w.detail ?? w.missing?.join(', ') ?? ''}`)
    }
    if (out.recommendedIntervention) lines.push(`建议 TOP1 干预：${out.recommendedIntervention.lever} —— ${out.recommendedIntervention.why}`)
    if (out.unknownObservations?.length) lines.push(`要测得：${out.unknownObservations.join(', ')}`)
    return `${lines.join('\n')}\n`
  }
  if (command === 'list') {
    const runs = out.runs ?? []
    if (runs.length === 0) return '（注册表为空）\n'
    return `${runs.map((r) => `${r.id}  ${String(r.status).padEnd(16)} complete=${r.complete}${r.missing?.length ? ` 缺:${r.missing.join(',')}` : ''}`).join('\n')}\n`
  }
  if (command === 'health') {
    return `沙箱：进程 ${out.sandbox.process ? '✓' : '✗'} / 容器 ${out.sandbox.container ? '✓' : '✗'} / VM ${out.sandbox.vm ? '✓' : '✗'}\n`
      + `serving MCP：${out.serving.reachable ? '✓ 可达' : `✗ ${out.serving.error ?? ''}`}\n`
      + `审计链：${out.audit.ok ? `✓ ${out.audit.files} 个分片` : '✗ 已损坏'}\n`
      + `未处理的必叫事件：${out.mustNotify ? `${out.mustNotify.latest?.code} @ ${out.mustNotify.latest?.at}` : '无'}\n`
  }
  if (command === 'spec') {
    return `${out.replayable ? '✓' : '✗'} 可重放  fingerprint=${out.fingerprint}\n`
      + `  命令：${out.shellCommand}\n`
      + `  参数：${JSON.stringify(out.spec?.params ?? {})}\n`
      + (out.problems?.length ? `  问题：${out.problems.map((p) => p.code).join(', ')}\n` : '')
  }
  if (command === 'tune') {
    return `调优 ${out.signed ? '✓ 已改善' : '· 未改善'}  runId=${out.runId}\n`
      + `  报告：${out.reportPath}\n`
      + `  最终配置：${JSON.stringify(out.report?.finalConfig ?? {})}\n`
      + `  性能增益：${(out.report?.finalPerfGainPct ?? 0).toFixed(2)}%\n`
  }
  return `${JSON.stringify(out, null, 2)}\n`
}
