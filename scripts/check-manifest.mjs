#!/usr/bin/env node
/**
 * 包规范自检 —— 与 serving / quantization 同构。
 *
 * 这里有两类条目：
 *   · **一致性**：声明（manifest.yaml / package.json）与实现（src/*.mjs）必须对得上
 *   · **项目硬约束**：命名空间、阈值不猜默认、量化格式硬排除、契约一致性等
 *
 * 其中"工具名不得与 tuner_* 冲突"是**上线前必查项**：
 * `dsh-tuning-engine` 当前仍挂着且 live，占用 `tuner_*` 与 `/__tuner/health`。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const notes = []
const failures = []
const check = (ok, name, detail = '') => {
  if (ok) notes.push(`  ok   ${name}`)
  else { notes.push(`  FAIL ${name}${detail ? ` | ${detail}` : ''}`); failures.push(name) }
}
const read = (p) => readFileSync(join(root, p), 'utf8')
const has = (p) => existsSync(join(root, p))

// ---------------------------------------------------------------- package.json
const pkg = JSON.parse(read('package.json'))
check(pkg.name === 'inference-tuning', 'package.json name 正确')
check(pkg.version === '0.1.0', '版本 0.1.0')
check(pkg.type === 'module', 'type: module')
check(pkg.main === 'src/index.mjs', 'main 指向 src/index.mjs')
check(pkg.bin && pkg.bin['inference-tuning'] === 'bin/inference-tuning.mjs', 'bin 指向 CLI 入口')
check(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', 'package.json 声明 dsh.bundle.patch')
check(
  !pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
  '零运行时依赖（dependencies 为空）',
  JSON.stringify(pkg.dependencies ?? {}),
)
check(!pkg.devDependencies || Object.keys(pkg.devDependencies).length === 0, '零 devDependencies')
check(
  Array.isArray(pkg.files) && !pkg.files.some((f) => f.startsWith('tests/') || f.startsWith('scripts/')),
  'files 白名单不含 tests/ 或 scripts/',
  JSON.stringify(pkg.files),
)
check(
  Array.isArray(pkg.files) && pkg.files.includes('docs/parity-contract.md'),
  'files 白名单包含精度回归契约（它是单一事实来源，必须随包发布）',
)

// ---------------------------------------------------------------- manifest.yaml
const manifest = read('manifest.yaml')
check(/^name:\s*inference-tuning$/m.test(manifest), 'manifest name 正确')
check(/interface:\s*\n\s*mcp:\s*"1\.0\.0"/.test(manifest), 'manifest 声明 MCP 接口版本')
check(/not_provided:/.test(manifest), 'manifest 声明 not_provided（明确不做什么）')

// manifest 声明的 capability 必须与 src/capability.mjs 的实现一致
const capSrc = read('src/capability.mjs')
const capMod = await import(new URL('../src/capability.mjs', import.meta.url).href)
const declaredCaps = [...manifest.matchAll(/^\s{2}- id:\s*(\S+)\s*$/gm)].map((m) => m[1])
const manifestCaps = []
{
  let inCaps = false
  for (const line of manifest.split('\n')) {
    if (/^capabilities:/.test(line)) { inCaps = true; continue }
    if (/^[a-z_]+:/.test(line) && !/^capabilities:/.test(line)) { if (inCaps) break }
    const m = /^\s{2}- id:\s*(\S+)\s*$/.exec(line)
    if (inCaps && m) manifestCaps.push(m[1])
  }
}
check(manifestCaps.length > 0, `manifest 声明了 capability（${manifestCaps.length} 个）`)
for (const c of manifestCaps) {
  check(Object.prototype.hasOwnProperty.call(capMod.CAPABILITIES, c), `capability ${c} 在 src/capability.mjs 里有实现`)
}
for (const c of Object.keys(capMod.CAPABILITIES)) {
  check(manifestCaps.includes(c), `实现里的 capability ${c} 已在 manifest 声明`)
}
check(/risk:\s*(read|write|system)/.test(manifest), 'capability 声明了风险档')
const capsWithResources = [...manifest.matchAll(/resources:\s*\[([^\]]*)\]/g)].map((m) => m[1])
check(capsWithResources.length >= manifestCaps.length - 2, 'capability 声明了 resources（只读类可为空）')

// not_provided 的关键条目
for (const k of ['quantize', 'quant_format_change', 'operator_patch', 'deploy_generic', 'touch_existing_endpoints', 'wiki', 'field_mode', 'training', 'orchestration']) {
  check(new RegExp(`- id:\\s*${k}\\b`).test(manifest), `manifest 明确不做：${k}`)
}

// ---------------------------------------------------------------- 命名空间（上线前必查）
const idxSrc = read('src/index.mjs')
const mcpSrc = read('mcp/server.mjs')
const allToolNames = [...`${idxSrc}\n${mcpSrc}`.matchAll(/name:\s*'([a-z_]+)'/g)].map((m) => m[1])
const tuningTools = allToolNames.filter((n) => n.startsWith('inference_tuning_'))
check(tuningTools.length >= 7, `至少注册 7 个 inference_tuning_* 工具（实际 ${tuningTools.length}）`)
const badNamespace = allToolNames.filter((n) => n.startsWith('tuner_') || n.startsWith('tuner'))
check(badNamespace.length === 0, '**不占用 tuner_* 命名空间**（dsh-tuning-engine 仍 live）', JSON.stringify(badNamespace))
const srcAll = readdirSync(join(root, 'src'), { recursive: true })
  .filter((f) => String(f).endsWith('.mjs'))
  .map((f) => read(join('src', String(f))))
  .join('\n')
// 只看**真实的路由注册**，不看注释里对该路径的提及（注释里恰恰必须提它，说明为什么不占用）
const routePaths = [...`${idxSrc}\n${srcAll}`.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1])
check(!routePaths.some((p) => p.startsWith('/__tuner')), '**不占用 /__tuner/ 路由**', JSON.stringify(routePaths))
check(/\/__inference_tuning\/health/.test(idxSrc), '注册了 /__inference_tuning/health 路由')
check(/inference_tuning_analyze/.test(mcpSrc) && /inference_tuning_tune/.test(mcpSrc) && /inference_tuning_health/.test(mcpSrc),
  'MCP 七个工具的核心三个都在')

// ---------------------------------------------------------------- 错误码与硬约束
const errSrc = read('src/errors.mjs')
for (const c of [
  'E_THRESHOLD_NOT_PROVIDED', 'E_QUANT_FORMAT_FORBIDDEN', 'E_MEASUREMENT_INVALID',
  'E_ROLLBACK_FAILED', 'E_SOURCE_MODEL_INVALID', 'E_ENDPOINT_NOT_OWNED', 'E_CAPABILITY_DENIED',
]) {
  check(new RegExp(`${c}:`).test(errSrc), `存在错误码 ${c}`)
}
check(/MUST_NOTIFY_FAILURES/.test(errSrc), '声明了"必须叫人"的失败集合')

const riskSrc = read('src/risk.mjs')
check(/E_QUANT_FORMAT_FORBIDDEN/.test(read('src/registry.mjs')), '量化格式变更在参数层被硬拒绝')
check(/R6/.test(riskSrc), '风险分级里有 R6 档')
check(/E_ENDPOINT_NOT_OWNED|ownedByThisRun/.test(read('src/executors/docker.mjs')), '端点所有权被显式标记')
check(/local-microbenchmark|未注入带宽探针执行器/.test(read('src/observe/bandwidth.mjs')),
  '带宽探针拒绝用理论峰值代替实测（返回 null）')
check(/spec-sheet|theoretical-peak/.test(read('src/walls/index.mjs')), '墙框架拒绝规格书峰值 provenance')

// ---------------------------------------------------------------- 阈值不猜默认
const policySrc = read('src/policy-defaults.mjs')
check(/max_accuracy_drop_pct:\s*null/.test(policySrc), '门禁阈值**没有**内置默认值（裁决：不猜默认）')
check(/min_perf_gain_pct:\s*null/.test(policySrc), '性能阈值同样无内置默认值')

// ---------------------------------------------------------------- 契约
check(has('docs/parity-contract.md'), '契约文件 docs/parity-contract.md 存在')
const contractMd = read('docs/parity-contract.md')
check(/contractVersion:\s*"1\.0\.0"/.test(contractMd), '契约文件声明 contractVersion 1.0.0')
check(/uniform-output/.test(contractMd) && /indiscriminate/.test(contractMd) && /no-item-variance/.test(contractMd),
  '契约文件声明了精度三闸')
check(/两份实现同时替换/.test(contractMd), '契约文件写明迁移路径（两份实现同时替换）')
check(has('tests/contract/parity-consistency.test.mjs'), 'CI 级契约一致性检查存在')
check(has('scripts/migrate-to-testing-core.mjs'), '迁移脚本存在')
const paritySrc = read('src/testing/parity.mjs')
check(/@internal/.test(paritySrc), '精度回归实现标注 @internal（过渡件）')

// ---------------------------------------------------------------- 其它
check(/termi|TERMINAL|不可降级/.test(read('src/errors.mjs') + read('src/gate.mjs') + manifest)
  || /硬约束/.test(read('src/registry.mjs')), '声明了不可降级/硬约束语义')
check(has('cordis.patch.yml'), 'cordis.patch.yml 存在')
const patch = read('cordis.patch.yml')
check(/id:\s*inference-tuning/.test(patch), 'patch entry id 为 inference-tuning（与 tuner 区分）')
check(/name:\s*'inference-tuning'/.test(patch), 'patch name 是 npm 包名（不是相对路径）')
check(has('skills'), 'skills 目录存在')
const skillDirs = readdirSync(join(root, 'skills'), { withFileTypes: true }).filter((d) => d.isDirectory())
check(skillDirs.length >= 1, `随包 skill 至少 1 个（实际 ${skillDirs.length}）`)
check(has('README.md'), 'README.md 存在')
check(has('TEST_REPORT.md'), '测试报告存在')
check(has('ACCEPTANCE_MATRIX.md'), '验收矩阵存在')
check(has('DEPLOYMENT_REPORT.md'), '交付报告存在')
check(has('NEXT_STEPS.md'), '下一阶段清单存在')
check(has('docs/audit-sample/audit-2026-09-27.jsonl'), '审计日志样本存在')
const auditSample = read('docs/audit-sample/audit-2026-09-27.jsonl')
check(/\"capability\":\"tune\"/.test(auditSample), '审计样本里含真实的 tune 记录')
check(/\"prevHash\"/.test(auditSample) && /\"hash\":/.test(auditSample), '审计样本含哈希链字段（可独立复算）')

// ---------------------------------------------------------------- S2 模块
check(has('src/walls/ceiling.mjs'), 'S2: 单流天花板模块存在')
const ceilSrc = read('src/walls/ceiling.mjs')
check(/evidenceChain/.test(ceilSrc), 'S2: 天花板带证据链（可独立复核）')
check(/conditionalOn/.test(ceilSrc) && /resolveConditional/.test(ceilSrc), 'S2: 天花板必须带限定条件')
check(has('src/walls/memory.mjs'), 'S2: 内存分解模块存在')
const memSrc = read('src/walls/memory.mjs')
check(/solvePerSlotCost/.test(memSrc) && /decomposeByFormula/.test(memSrc) && /attributeLevers/.test(memSrc),
  'S2: 内存分解含 per-slot / 全量分解 / 杠杆归因')
check(/不猜/.test(memSrc), 'S2: 内存分解对未知项不猜（返回 null + 缺什么）')
check(has('src/validity/claims.mjs'), 'S2: 主张门禁模块存在')
const claimSrc = read('src/validity/claims.mjs')
check(/FORBIDDEN_PROVENANCE/.test(claimSrc) && /spec-sheet/.test(claimSrc), 'S2: 规格书峰值是**禁用项**（不是低等级）')
check(/promoted-inference/.test(claimSrc), 'S2: 有升格检测（推断不得写成结论口吻）')
check(has('src/loop/prereg.mjs'), 'S2: 预注册模块存在')
const preregSrc = read('src/loop/prereg.mjs')
check(/checkInstrumentSelfMatch/.test(preregSrc), 'S2: 有"仪器必须看得见它声称的效应"检查')
check(/registered-after-execution/.test(preregSrc), 'S2: 能抓出事后补写的预注册')
check(/INSTRUMENT_CANNOT_SEE|instrument-cannot-see/.test(read('src/validity/performance.mjs')),
  'S2: 仪器自洽已接进性能测量成立性（第 5 道闸）')
check(/preregister\(/.test(read('src/tuning.mjs')) && /judge\(/.test(read('src/tuning.mjs')),
  'S2: 闭环里**真的**用预注册做判定（不是只有模块）')

// ---------------------------------------------------------------- S3 模块
check(has('src/config/run-spec.mjs'), 'S3: 配置快照重放模块存在')
const specSrc = read('src/config/run-spec.mjs')
check(/image-not-pinned-to-digest/.test(specSrc), 'S3: 镜像未固定 digest 判为**不可重放**（tag 会漂）')
check(/VOLATILE_KEYS/.test(specSrc), 'S3: 易变字段不进指纹（否则同一条配置会有两个指纹）')
check(/conclusionAffecting/.test(specSrc), 'S3: spec 比较按"是否影响结论"分级')
check(has('src/platform/gpuspec.mjs'), 'S3: GPU 规格模块存在')
const gpuSrc = read('src/platform/gpuspec.mjs')
check(/usable:\s*hasBW/.test(gpuSrc) || /usable: hasBW/.test(gpuSrc), 'S3: 只有实测值才判 usable（规格书不算）')
check(/forbidden/.test(gpuSrc) && /不得用规格书理论峰值代替/.test(gpuSrc), 'S3: 明确写出"禁止用规格书峰值代替"')
check(/先判空/.test(gpuSrc), 'S3: 内存预算处显式拦 Number(null)===0 陷阱')
check(has('src/analysis/class-excess.mjs'), 'S3: 算子类别超额模块存在')
check(/canJudgeExcess/.test(read('src/analysis/class-excess.mjs')), 'S3: 无预期分布时不判超额')
check(has('src/analysis/step-decomposition.mjs'), 'S3: 步分解模块存在')
const stepSrc = read('src/analysis/step-decomposition.mjs')
check(/residual-exceeds-worst-part/.test(stepSrc), 'S3: 残差大于最大单项则判"分解不完整"')
check(/upper-bound/.test(read('src/analysis/class-excess.mjs')), 'S3: 收益折算标注为上界')
check(/runSpec/.test(read('src/tuning.mjs')), 'S3: 报告里带可复用配置（run-spec）')
check(/spec\s+spec \[runId\]/.test(read('src/cli.mjs')) || /case 'spec'/.test(read('src/cli.mjs')), 'S3: CLI 有 spec 子命令')

process.stdout.write(`inference-tuning 包规范自检\n${notes.join('\n')}\n`)
if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} 项失败：\n${failures.map((f) => `  - ${f}`).join('\n')}\n`)
  process.exit(1)
}
process.stdout.write(`\n全部通过（${notes.length} 项）\n`)
