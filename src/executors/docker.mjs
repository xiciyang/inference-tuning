/**
 * 真机执行器：端点生命周期**全部经 inference-serving 的 MCP**。
 *
 * 这是 Step 0 的决定性重构（继承项 B1）。旧引擎 `lib/engine.mjs` 直接
 * `docker run -d --name …` / `docker rm -f …`，形成第二套端点所有权：
 * 与 serving 的注册表互相踩端口/显存/容器名。本包**一行 docker 生命周期命令都不发**，
 * 只发两类只读/一次性容器：
 *   · 引擎 flag 探测（`<image> --help`）—— 只读，`--rm`
 *   · 实测可达带宽微基准 —— 只读挂载 + `--rm`
 * 端点的起停一律 `inference_serving_deploy` / `inference_serving_teardown`。
 */
import { execFile } from 'node:child_process'
import { registerExecutor } from './index.mjs'
import { withServing, callWithConfirm } from '../serving-client.mjs'
import { measureEndpoint, waitReady } from '../testing/perf.mjs'
import { parseSupportedFlags } from '../registry.mjs'
import { BANDWIDTH_PROBE_PY, parseBandwidthProbeOutput } from '../observe/bandwidth.mjs'
import { fail, warn, ERROR_CODES, WARNING_CODES } from '../errors.mjs'

function run(cmd, args, { timeoutMs = 300_000, env = process.env, signal = null } = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    // ⚠ `execFile` 收到 `signal: null` 会直接抛 `ERR_INVALID_ARG_TYPE`
    // （"options.signal must be an instance of AbortSignal"）。只有真是 AbortSignal 时才放进去。
    // 这个 bug 只在真机路径出现 —— 假执行器不调 run()，所以测试抓不到。
    const opts = { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env }
    if (signal && typeof signal.addEventListener === 'function' && typeof signal.aborted === 'boolean') opts.signal = signal
    const child = execFile(cmd, args, opts,
      (err, stdout, stderr) => {
        resolvePromise({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          timedOut: Boolean(err && err.killed),
          stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
          durationMs: Date.now() - started,
          message: err ? String(err.message ?? err).slice(0, 500) : null,
        })
      })
    void child
  })
}

/** 把参数集渲染进 serving deploy 的 extra 里（不新增 flag 语义，只是透传）。 */
function paramsToExtra(params, { supportedFlags = null } = {}) {
  const extra = {}
  const skipped = []
  for (const [k, v] of Object.entries(params ?? {})) {
    const flag = k.startsWith('--') ? k : `--${k}`
    if (supportedFlags && !supportedFlags.has(flag)) {
      skipped.push({ param: k, flag, reason: '该引擎版本不支持此 flag（已探测）' })
      continue
    }
    extra[k] = v
  }
  return { extra, skipped }
}

export const dockerExecutor = {
  id: 'docker',
  displayName: '真实容器 + inference-serving MCP（端点为 serving 所有）',

  /**
   * 探测引擎真实支持的 flag。
   * **不猜**：vLLM 0.23.1rc1 删掉了 `--swap-space` 与 `--disable-log-requests`，
   * 硬编码启动参数会让服务直接起不来（quantization 真机踩过）。
   */
  async probeEngineFlags(runtime, { flags = [], image = null, log = null } = {}) {
    const img = image ?? runtime.options.engineImage
    if (!img) return { supported: new Set(), probed: false, reason: '未指定引擎镜像' }
    const r = await run('docker', ['run', '--rm', '--entrypoint', 'sh', img, '-c', 'vllm serve --help 2>&1 || python3 -m vllm.entrypoints.openai.api_server --help 2>&1'], { timeoutMs: 180_000 })
    const supported = parseSupportedFlags(`${r.stdout}\n${r.stderr}`)
    const missing = flags.filter((f) => !supported.has(f))
    log?.info?.('引擎 flag 探测完成', { image: img, supported: supported.size, missing })
    if (supported.size === 0) {
      runtime.warnings?.push?.(warn(WARNING_CODES.W_POLICY_DEFAULTED,
        `未能从 ${img} 探测到任何 flag（--help 无输出）—— 将只下发 serving 默认支持的参数`,
        { image: img, exitCode: r.code }))
    }
    return { supported, probed: supported.size > 0, missing, image: img, raw: { code: r.code, stderr: r.stderr.slice(-400) } }
  },

  /**
   * 从**运行中的容器**读出真实镜像。
   *
   * 为什么不问 serving 要：serving 的 `list_endpoints` 不暴露 image（那是它的内部注册表字段），
   * 而**约束不允许改 serving**。但端点列表公开了 `containerName` ——
   * 对宿主机上的容器做一次 `docker inspect` 属于**本机观测**，不是跨插件读状态。
   * 这样既不改 serving，也不要求调用方预先配置镜像。
   */
  async resolveEngineImage(runtime, { containerName = null, log = null } = {}) {
    if (!containerName) return { image: null, imageId: null, why: '端点没有 containerName，无法反查镜像' }
    const r = await run('docker', ['inspect', '-f', '{{.Config.Image}}|{{.Image}}', containerName], { timeoutMs: 30_000 })
    if (r.code !== 0) {
      return { image: null, imageId: null, why: `docker inspect 失败：${(r.stderr || r.message || '').slice(0, 200)}` }
    }
    const [image, imageId] = r.stdout.trim().split('|')
    log?.info?.('从运行中的容器反查到引擎镜像', { containerName, image })
    return { image: image || null, imageId: imageId || null, via: 'docker-inspect', containerName }
  },

  /** 经 serving 部署一个**本次运行自有**的调优端点。 */
  async deploy(runtime, { modelPath, params = {}, port = null, servedModelName, supportedFlags = null, extra = {}, log = null, ownerToken = null } = {}) {
    const { extra: paramExtra, skipped } = paramsToExtra(params, { supportedFlags })
    return withServing(runtime, async (client) => {
      const out = await callWithConfirm(client, 'inference_serving_deploy', {
        model: modelPath,
        ...(port ? { port } : {}),
        ...(servedModelName ? { servedModelName } : {}),
        // ── 端点租约（F-3）──────────────────────────────────────────────
        // serving 按 model 给端点做键，所以"本包自有的端点"这句话只有在出示
        // 同一个 ownerToken 时才成立。首次 deploy 不带 token（服务端生成并返回），
        // 同一次运行内后续 deploy（候选/revision）必须带上它，否则会被
        // E_ENDPOINT_LEASED 拒绝 —— 那正是"两个插件各自以为独占"的闸门。
        owner: 'inference-tuning',
        ...(ownerToken ? { ownerToken } : {}),
        ...extra,
        ...paramExtra,
      }, { log })
      if (out.isError || out.value?.ok === false) {
        fail(ERROR_CODES.E_DEPLOY_FAILED, `serving 部署失败：${out.value?.code ?? 'unknown'} — ${out.value?.message ?? ''}`, {
          remediation: '按 serving 返回的 remediation 处理；也可先用 serving 的 doctor 自检。',
          details: out.value ?? { raw: out.raw?.slice(0, 600) },
        })
      }
      const ep = out.value.endpoint
      // ⚠ **部署成功之后的一切富化都必须吞掉自己的异常**。
      // 否则：serving 已经把端点建出来了（容器在跑、占着显存），而本插件在返回之前抛了，
      // 调用方拿不到 id → 这个端点不在 ownedEndpoints 里 → 收尾时不会拆它 → **泄漏**。
      // 真机踩过一次（docker inspect 抛 ERR_INVALID_ARG_TYPE → 容器留在那儿 7 分钟）。
      let containerName = ep.containerName ?? null
      let resolved = { image: null, imageId: null, why: null }
      try {
        if (!containerName) {
          const list = await callWithConfirm(client, 'inference_serving_list_endpoints', {}, { log })
          const found = (list.value?.endpoints ?? []).find((e) => e.id === ep.id)
          containerName = found?.containerName ?? null
        }
        resolved = containerName
          ? await this.resolveEngineImage(runtime, { containerName, log })
          : { image: null, imageId: null, why: '端点未暴露 containerName（不影响生命周期，只影响能力探测）' }
      } catch (err) {
        resolved = { image: null, imageId: null, why: `镜像反查失败（已忽略，不影响端点所有权）：${String(err.message).slice(0, 200)}` }
        runtime?.warnings?.push?.(warn(WARNING_CODES.W_POLICY_DEFAULTED,
          `部署后镜像反查失败，已忽略 —— 端点仍会被正常拆解，但 flag/带宽探测将不可用：${String(err.message).slice(0, 160)}`,
          { containerName }))
      }
      return {
        id: ep.id, endpoint: ep.endpoint, port: ep.port,
        containerName,
        image: resolved.image,
        imageId: resolved.imageId,
        servedModelName: ep.servedModelName,
        /** 端点所有权凭证：teardown / rollback / 续租都要原样带回服务端 */
        ownerToken: out.value.ownerToken ?? null,
        lease: out.value.lease ?? null,
        applied: paramExtra, skipped,
        reused: out.value.reused === true,
        report: out.value.report ?? null,
        /** 端点所有权凭证：本包只允许操作自己 deploy 出来的端点（见 E_ENDPOINT_NOT_OWNED） */
        ownedByThisRun: true,
      }
    }, { timeoutMs: runtime.options.deployTimeoutMs })
  },

  /** 等端点就绪（返回就绪时刻，供稳态闸使用）。 */
  async ready(runtime, { endpoint, timeoutMs = 300_000 } = {}) {
    return waitReady(endpoint, { timeoutMs })
  },

  /**
   * **回退到上一个已验证 revision**（经 serving）。
   *
   * 为什么回退走 serving 而不是"丢掉候选、留下原来的"：
   * serving 按**模型**给端点做键 —— 同模型换参数是**同一个端点的新 revision**，
   * 不是两个端点。因此"原来的那个"在候选部署时就已经被取代了，
   * 唯一的回退手段就是 serving 的 rollback（它会用目标 revision 的配置重新部署）。
   *
   * 真机教训：本包第一版按"两个独立端点"设计，回退实现成"拆掉候选 + 检查原端点还活着" ——
   * 结果是拆掉了同一个端点，原端点自然不健康，直接触发 E_ROLLBACK_FAILED。**设计错了，不是实现错了。**
   */
  async rollback(runtime, { selector = null, log = null, ownerToken = null } = {}) {
    return withServing(runtime, async (client) => {
      const out = await callWithConfirm(client, 'inference_serving_rollback', { selector, ...(ownerToken ? { ownerToken } : {}) }, { log })
      const ok = !out.isError && out.value?.ok !== false
      return {
        ok,
        code: ok ? null : (out.value?.code ?? 'E_NO_ROLLBACK_TARGET'),
        message: ok ? null : (out.value?.message ?? null),
        endpoint: out.value?.endpoint ?? null,
        toRevision: out.value?.toRevision ?? out.value?.revision ?? null,
        value: out.value ?? null,
      }
    }, { timeoutMs: 900_000 })
  },

  /** 经 serving 拆解端点，并校验无残留。 */
  async teardown(runtime, { id, log = null, ownerToken = null } = {}) {
    return withServing(runtime, async (client) => {
      const out = await callWithConfirm(client, 'inference_serving_teardown', { selector: id, ...(ownerToken ? { ownerToken } : {}) }, { log })
      const ok = !out.isError && out.value?.ok !== false
      if (!ok) {
        runtime.warnings?.push?.(warn(WARNING_CODES.W_RESIDUAL_CLEANUP,
          `端点 ${id} 拆解未成功：${out.value?.code ?? 'unknown'} —— 容器可能仍在占用显存`,
          { id, value: out.value ?? null }))
      }
      return {
        ok,
        code: ok ? null : (out.value?.code ?? 'E_CLEANUP_INCOMPLETE'),
        residual: out.value?.verification?.checks?.filter((c) => !c.ok) ?? null,
        verification: out.value?.verification ?? null,
        value: out.value ?? null,
      }
    }, { timeoutMs: 300_000 })
  },

  /**
   * 实测可达带宽（在一次性容器里跑微基准）。
   * 探针脚本与框架无耦合；容器只读挂载脚本，`--rm` 退出即净。
   */
  async bandwidthProbe(runtime, { image = null, sizesGiB = [0.5, 1, 2], iters = 25, warmup = 6, log = null } = {}) {
    const img = image ?? runtime.options.quantImage ?? runtime.options.engineImage
    if (!img) return null
    // 把纯文本探针写到**共享状态根下的临时目录**再只读挂载。
    //
    // 这里曾经写的是 `${runtime.__packageRoot}observe/bandwidth_probe.py` —— 即写进
    // **安装目录**。后果（集成测试 F-11 抓到）：只读安装（npm -g / 容器镜像 / 只读挂载）
    // 下这一步会失败，而它正是"实测可达带宽"的分母；失败后带宽墙只能降级为 unknown，
    // **诊断能力静默下降**。另外并发 run 会互相踩同一个路径，交付物也会自我变更
    // （与审计哈希链纪律冲突）。下面那个 `dir` 当时建了却没人用 —— 就是原意写错的痕迹。
    const { mkdirp, atomicWrite } = await import('../util/fsx.mjs')
    const dir = `${runtime.paths.tmpDir}/bwprobe`
    await mkdirp(dir)
    const scriptPath = `${dir}/bandwidth_probe.py`
    await atomicWrite(scriptPath, BANDWIDTH_PROBE_PY)
    const r = await run('docker', [
      'run', '--rm', '--runtime', runtime.options.containerRuntime, '--gpus', 'all',
      '-e', `BW_PROBE_SPEC=${JSON.stringify({ sizesGiB, iters, warmup })}`,
      '-v', `${scriptPath}:${scriptPath}:ro`,
      '--entrypoint', 'python3', img, scriptPath,
    ], { timeoutMs: 600_000, env: runtime.env })
    const parsed = parseBandwidthProbeOutput(r.stdout)
    log?.info?.('带宽探针完成', { ok: Boolean(parsed?.ok), GBps: parsed?.bestReadGBps ?? null })
    if (!parsed) {
      runtime.warnings?.push?.(warn(WARNING_CODES.W_POLICY_DEFAULTED,
        `带宽探针未产出可解析结果（exit=${r.code}）—— 带宽墙将判为 unknown 而不是拿理论峰值凑数`,
        { exitCode: r.code, stderr: r.stderr.slice(-500) }))
      return null
    }
    return parsed
  },

  async measure(runtime, spec) {
    return measureEndpoint(spec.endpoint, spec.model, {
      workload: spec.workload ?? runtime.options.workload ?? 'chat-medium',
      requests: spec.requests ?? runtime.options.requests,
      concurrency: spec.concurrency ?? runtime.options.concurrency,
      timeoutMs: spec.timeoutMs ?? runtime.options.evalTimeoutMs,
      log: spec.log ?? null,
    })
  },
}

registerExecutor(dockerExecutor)
export default dockerExecutor
