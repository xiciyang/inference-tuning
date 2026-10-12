/**
 * 运行时装配：路径解析 + 策略装载 + options 合并。
 *
 * 两条从另两包继承的硬纪律：
 *   ① **剔除 `undefined` 再合并** —— 否则调用方没传的字段会清空默认值
 *      （serving/quantization 都因此出过"看起来传了其实没传"）。
 *   ② 路径集中在 `resolvePaths`，不接受 cwd 依赖 —— 旧引擎把报告写到
 *      `process.cwd()/tuner-reports`，换个工作目录就找不到自己的产物。
 */
import { join, resolve } from 'node:path'
import { promises as fs } from 'node:fs'
import { expandHome, readText, mkdirp } from './util/fsx.mjs'
import { parse as parseYaml } from './util/yaml.mjs'
import {
  GATES_TEMPLATE, DEFAULT_RISK_POLICY, DEFAULT_HEADLESS_POLICY, DEFAULT_NETWORK_POLICY, defaultOptions,
} from './policy-defaults.mjs'

export const AI_INFRA_ROOT = '~/.ai-infra'

export function resolvePaths(root = AI_INFRA_ROOT) {
  const base = resolve(expandHome(root))
  return {
    root: base,
    stateDir: join(base, 'state'),
    // 调优注册表（本包的共享状态）
    tuningRegistryFile: join(base, 'state', 'tuning-registry.yaml'),
    // 源模型结构预检缓存（键含 size+mtime，文件一变即失效）
    modelValidationFile: join(base, 'state', 'model-validation.json'),
    historyDir: join(base, 'state', 'history'),
    confirmationsFile: join(base, 'state', 'confirmations.json'),
    metricsFile: join(base, 'state', 'metrics.json'),
    imageMetaDir: join(base, 'state', 'images'),
    // 日志与审计
    logsDir: join(base, 'logs'),
    auditDir: join(base, 'logs', 'audit', 'inference-tuning'),
    appLogDir: join(base, 'logs', 'inference-tuning'),
    // 报告
    reportsDir: join(base, 'reports', 'inference-tuning'),
    // 运行期
    runDir: join(base, 'run', 'inference-tuning'),
    tmpDir: join(base, 'run', 'inference-tuning', 'tmp'),
    lockDir: join(base, 'run', 'inference-tuning', 'locks'),
    // 配置
    configDir: join(base, 'config'),
    gatesFile: join(base, 'config', 'gates.yaml'),
    riskFile: join(base, 'config', 'risk-classification.yaml'),
    networkFile: join(base, 'config', 'network-policy.yaml'),
    headlessFile: join(base, 'config', 'headless-policy.yaml'),
  }
}

/** 剔除 `undefined`（保留 null —— null 是"显式不设置"，语义不同）。 */
export function stripUndefined(obj) {
  if (!obj || typeof obj !== 'object') return obj
  const out = {}
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined) out[k] = obj[k]
  }
  return out
}

async function loadPolicyFile(file, fallback) {
  const raw = await readText(file, null)
  if (!raw) return { value: fallback, source: 'default', file }
  try {
    const parsed = parseYaml(raw)
    if (!parsed || typeof parsed !== 'object') return { value: fallback, source: 'default', file }
    return { value: parsed, source: 'file', file }
  } catch (err) {
    return { value: fallback, source: 'default-parse-error', file, error: String(err.message) }
  }
}

/** 逐字段合并：文件里显式给出的字段覆盖默认值。 */
function mergePolicy(base, override) {
  if (!override || typeof override !== 'object') return base
  const out = { ...base }
  for (const k of Object.keys(override)) {
    const v = override[k]
    if (v === undefined) continue
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = mergePolicy(base[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

/** 首次运行只生成**空模板** —— 字段为 null，绝不替用户填默认阈值。 */
export async function ensureGatesTemplate(paths) {
  try {
    await fs.access(paths.gatesFile)
    return null
  } catch { /* 不存在 → 生成空模板 */ }
  const { stringify } = await import('./util/yaml.mjs')
  await mkdirp(paths.configDir)
  await fs.writeFile(
    paths.gatesFile,
    `# inference-tuning 门禁阈值模板 —— 必须显式填写，null 表示未设置（本插件会拒绝执行，不猜默认值）\n`
    + `${stringify(GATES_TEMPLATE, { indent: 0 })}\n`,
    { mode: 0o600 },
  )
  return paths.gatesFile
}

/**
 * 创建运行时。
 * @param {{root?, options?, env?, warnings?}} spec
 */
export async function createRuntime({ root = AI_INFRA_ROOT, options = {}, env = process.env, warnings = [] } = {}) {
  const paths = resolvePaths(root)
  const opts = { ...defaultOptions(), ...stripUndefined(options) }

  for (const d of [paths.stateDir, paths.historyDir, paths.logsDir, paths.auditDir, paths.appLogDir,
    paths.configDir, paths.runDir, paths.tmpDir, paths.lockDir, paths.reportsDir, paths.imageMetaDir]) {
    await mkdirp(d)
  }

  const risk = await loadPolicyFile(paths.riskFile, DEFAULT_RISK_POLICY)
  const network = await loadPolicyFile(paths.networkFile, DEFAULT_NETWORK_POLICY)
  const headless = await loadPolicyFile(paths.headlessFile, DEFAULT_HEADLESS_POLICY)
  const gates = await loadPolicyFile(paths.gatesFile, GATES_TEMPLATE)

  const runtime = {
    paths,
    options: opts,
    env,
    warnings,
    policy: {
      risk: mergePolicy(DEFAULT_RISK_POLICY, risk.value),
      network: mergePolicy(DEFAULT_NETWORK_POLICY, network.value),
      headless: mergePolicy(DEFAULT_HEADLESS_POLICY, headless.value),
      gates: gates.value,
      sources: { risk: risk.source, network: network.source, headless: headless.source, gates: gates.source },
    },
    __log: null,
    __packageRoot: new URL('../', import.meta.url).pathname,
    __startedAt: Date.now(),
  }
  return runtime
}

/** 装载 `~/.ai-infra/config/gates.yaml`（已装载则直接读 runtime）。 */
export function gatesFromPolicy(runtime) {
  const g = runtime?.policy?.gates ?? {}
  return {
    max_accuracy_drop_pct: g.max_accuracy_drop_pct ?? null,
    min_perf_gain_pct: g.min_perf_gain_pct ?? null,
    near_limit_factor: typeof g.near_limit_factor === 'number' ? g.near_limit_factor : 0.9,
    source: runtime?.policy?.sources?.gates ?? 'default',
  }
}

export { defaultOptions }
