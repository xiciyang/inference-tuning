/**
 * 输入处理管线：模型引用 → 绝对路径；阈值 → 显式或拒绝；参数 → 校验。
 *
 * 7 类输入场景（验收 B 组）在这里归一：
 *   ① 合法路径   ② 相对路径   ③ 符号链接   ④ 模型名（在 modelRoots 下解析）
 *   ⑤ 不存在     ⑥ 歧义（多个 root 下同名） ⑦ 冲突（同时给了路径与名字）
 */
import { isAbsolute, join, resolve } from 'node:path'
import { promises as fs } from 'node:fs'
import { fail, warn, ERROR_CODES, WARNING_CODES } from '../errors.mjs'

export async function resolveModelPath(runtime, input) {
  if (!input) {
    fail(ERROR_CODES.E_INPUT_MISSING, '缺少模型引用', {
      remediation: '传 `model`（绝对路径 / 相对路径 / modelRoots 下的目录名）。',
      details: { modelRoots: runtime?.options?.modelRoots ?? [] },
    })
  }
  const roots = (runtime?.options?.modelRoots ?? []).filter(Boolean)
  const candidates = []

  if (isAbsolute(input)) {
    candidates.push(resolve(input))
  } else if (input.startsWith('./') || input.startsWith('../')) {
    candidates.push(resolve(process.cwd(), input))
  } else {
    // 裸名字：优先按名字在各 root 下找；找不到再当相对 cwd 的路径试
    for (const r of roots) candidates.push(join(r, input))
    candidates.push(resolve(process.cwd(), input))
  }

  const found = []
  for (const c of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const st = await fs.stat(c).catch(() => null)
    if (st) found.push({ path: c, isDir: st.isDirectory(), isSymlink: false })
  }
  if (found.length === 0) {
    fail(ERROR_CODES.E_MODEL_UNRESOLVED, `找不到模型：${input}`, {
      remediation: `试过这些位置：${candidates.join(', ')}。`
        + '传绝对路径，或把上级目录加进 options.modelRoots。',
      details: { input, tried: candidates, modelRoots: roots },
    })
  }
  const dirs = found.filter((f) => f.isDir)
  if (dirs.length === 0) {
    fail(ERROR_CODES.E_INPUT_INVALID, `模型引用不是目录：${input}`, {
      remediation: '模型引用应为包含 config.json 与权重文件的目录。',
      details: { input, found },
    })
  }
  if (dirs.length > 1) {
    fail(ERROR_CODES.E_INPUT_AMBIGUOUS, `模型名在多个 modelRoots 下都存在：${input}`, {
      remediation: `请用绝对路径消歧。候选：${dirs.map((d) => d.path).join(', ')}`,
      details: { input, candidates: dirs.map((d) => d.path) },
    })
  }

  const chosen = dirs[0]
  // 符号链接：跟随，但**留痕**（不然事后没人知道测的是哪份真实权重）
  let real = chosen.path
  let isSymlink = false
  try {
    const lst = await fs.lstat(chosen.path)
    if (lst.isSymbolicLink()) {
      isSymlink = true
      real = await fs.realpath(chosen.path)
      runtime?.warnings?.push?.(warn(WARNING_CODES.W_SYMLINK_MODEL_ROOT,
        `模型引用是符号链接，已跟随：${chosen.path} → ${real}`,
        { input: chosen.path, real }))
    }
  } catch { /* 保持原样 */ }

  const cfg = join(real, 'config.json')
  const hasConfig = Boolean(await fs.stat(cfg).catch(() => null))
  return {
    input,
    path: real,
    requested: chosen.path,
    isSymlink,
    hasConfig,
    tried: candidates,
  }
}

/**
 * 归一化原始入参。
 * 刻意**不在这里**解析阈值 —— 阈值解析属于门禁（`gate.mjs`），
 * 因为它的失败语义是"拒绝执行"，必须与门禁同源。
 */
export async function runInputPipeline(runtime, raw = {}) {
  const assumptions = []
  const model = await resolveModelPath(runtime, raw.model)

  const params = { ...(raw.params ?? {}) }
  const engine = {
    id: raw.engine ?? runtime.options.engineId ?? null,
    image: raw.engineImage ?? runtime.options.engineImage ?? null,
    servedModelName: raw.servedModelName ?? `tuning-${model.path.split('/').filter(Boolean).pop()}`.slice(0, 60),
  }
  const workload = raw.workload ?? runtime.options.workload ?? 'chat-medium'
  const requests = Number.isFinite(Number(raw.requests)) ? Number(raw.requests) : runtime.options.requests
  const concurrency = Number.isFinite(Number(raw.concurrency)) ? Number(raw.concurrency) : runtime.options.concurrency

  assumptions.push({ field: 'engineId', value: engine.id, reason: raw.engine ? '调用方指定' : (engine.id ? '来自 profile 配置' : '未指定 —— 执行前必须显式确定（不默认到任何厂商实现）') })
  assumptions.push({ field: 'workload', value: workload, reason: raw.workload ? '调用方指定' : '默认负载形状' })
  assumptions.push({ field: 'requests', value: requests, reason: raw.requests ? '调用方指定' : '默认样本数（满足统计出处闸的最低样本量）' })

  return {
    model,
    params,
    engine,
    workload,
    requests,
    concurrency,
    testSetPath: raw.testSetPath ?? runtime.options.testSetPath ?? null,
    accuracyLimit: Number.isFinite(Number(raw.accuracyLimit)) ? Number(raw.accuracyLimit) : 0,
    thresholds: {
      maxAccuracyDropPct: raw.max_accuracy_drop_pct ?? raw.maxAccuracyDropPct ?? null,
      minPerfGainPct: raw.min_perf_gain_pct ?? raw.minPerfGainPct ?? null,
    },
    engineCapabilities: raw.engineCapabilities ?? {},
    assumptions,
  }
}
