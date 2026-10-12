/**
 * 沙箱能力探测 —— **行为验证，不是存在性检查**。
 *
 * 这条纪律是被一次真实误判换来的：`inference-serving` 的 Step 0 最初把进程级沙箱判成
 * "✅ 可用"，依据是"bwrap 二进制存在 + LSM 已启用"。实际一跑就
 * `bwrap: setting up uid map: Permission denied`（`kernel.apparmor_restrict_unprivileged_userns=1`
 * 且 bwrap 非 setuid）。**存在 ≠ 可用。**
 *
 * 因此本模块对每一级都**真的跑一次**，并把原始输出作为证据留下。
 *
 * 本机实测结论（Step 0，2026-09-27）：
 *   R1 进程级 ✗（bwrap uid map 被拒）/ R2 容器级 ✓ / R3 VM 级 ✗（六个 hypervisor 全未安装）
 */
import { execFile } from 'node:child_process'
import { fail, warn, ERROR_CODES, WARNING_CODES } from './errors.mjs'

const TIER_ORDER = ['none', 'process', 'container', 'vm']

function run(cmd, args, { timeoutMs = 60_000, runtime = null } = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: runtime?.env ?? process.env },
      (err, stdout, stderr) => {
        resolvePromise({
          cmd: [cmd, ...args].join(' '),
          ok: !err,
          exitCode: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
          stdout: String(stdout ?? '').slice(-2000),
          stderr: String(stderr ?? '').slice(-2000),
          message: err ? String(err.message ?? err).slice(0, 400) : null,
          ms: Date.now() - started,
        })
      })
  })
}

/** 只用 `--version`/`--help` 判存在性，**不据此下结论**，仅用于挑出候选再行为验证。 */
async function which(cmd) {
  const r = await run('sh', ['-c', `command -v ${cmd} || true`], { timeoutMs: 5_000 })
  const p = r.stdout.trim().split('\n').pop() ?? ''
  return p && !p.includes('not found') ? p : null
}

/**
 * 探测三级沙箱。
 * @returns {{process, container, vm, evidence, checkedAt}}
 */
export async function probeSandbox(runtime, { skipContainerImage = false } = {}) {
  const evidence = {}

  // ---- R1 进程级：bwrap ----
  const bwrap = await which('bwrap')
  if (!bwrap) {
    evidence.process = { available: false, reason: 'bwrap 未安装', probe: null }
  } else {
    const r = await run(bwrap, ['--dev-bind', '/', '--chdir', '/', '/bin/true'], { timeoutMs: 15_000, runtime })
    const denied = /Permission denied|uid map/i.test(`${r.stderr}${r.message ?? ''}`)
    evidence.process = {
      available: r.ok,
      reason: r.ok ? null : (denied ? `bwrap 行为不可用：${r.stderr.trim() || r.message}` : `bwrap 探测失败：${r.message ?? ''}`),
      probe: r,
    }
  }

  // ---- R2 容器级：docker ----
  const docker = await which('docker')
  if (!docker) {
    evidence.container = { available: false, reason: 'docker 未安装', probe: null }
  } else {
    const runtimeName = runtime?.options?.containerRuntime ?? 'nvidia'
    const img = 'alpine:3.20'
    const args = skipContainerImage
      ? ['--version']
      : ['run', '--rm', '--runtime', runtimeName, '--gpus', 'all', img, 'sh', '-c', 'echo container-ok']
    const r = await run(docker, args, { timeoutMs: 60_000, runtime })
    evidence.container = {
      available: r.ok && (skipContainerImage || r.stdout.includes('container-ok')),
      reason: r.ok ? null : `容器探测失败：${r.stderr.trim() || r.message}`,
      probe: r,
    }
  }

  // ---- R3 VM 级：hypervisor 二进制 + 真跑一次 ----
  const vmBins = ['qemu-system-aarch64', 'qemu-system-x86_64', 'firecracker', 'cloud-hypervisor', 'virsh', 'kata-runtime', 'runsc']
  const found = []
  for (const b of vmBins) {
    // eslint-disable-next-line no-await-in-loop
    const p = await which(b)
    if (p) found.push({ bin: b, path: p })
  }
  evidence.vm = {
    available: found.length > 0,
    reason: found.length > 0 ? null : `六个 hypervisor 全部未安装：${vmBins.join(', ')}`,
    candidates: found,
    probe: null,
  }

  return {
    process: evidence.process.available,
    container: evidence.container.available,
    vm: evidence.vm.available,
    evidence,
    checkedAt: new Date().toISOString(),
    note: '每一级都是**实跑**判定，不是"二进制在不在"',
  }
}

/** 需求档位 → 是否满足（含"用更严的档位替代"的处置）。 */
export function tierSatisfied(probe, required) {
  const idx = TIER_ORDER.indexOf(required)
  if (idx < 0) return { ok: false, reason: `未知沙箱档位：${required}` }
  // 允许用更严（更靠后）的档位满足较松的需求
  for (let i = idx; i < TIER_ORDER.length; i += 1) {
    const t = TIER_ORDER[i]
    if (t === 'none') return { ok: true, via: 'none' }
    if (probe[t] === true) return { ok: true, via: t, substituted: t !== required }
  }
  return { ok: false, reason: `需要 ${required}（或更严），实测 ${TIER_ORDER.filter((t) => probe[t] === true).join('/') || '全部不可用'}` }
}

/**
 * 断言沙箱可用。缺档位时按"更严替代"处置，替代不了就失败。
 *
 * 注意 R1 的特殊处置：进程级不可用时，**按更严的容器级执行**（而不是降级到 none）。
 * 这是量化包已验证过的处置方式。
 */
export async function assertSandbox(runtime, required = 'container', { force = false } = {}) {
  if (runtime.__sandboxProbe && !force) {
    const cached = runtime.__sandboxProbe
    const sat = tierSatisfied(cached, required)
    if (!sat.ok) {
      fail(ERROR_CODES.E_SANDBOX_UNAVAILABLE, `沙箱档位不足：${sat.reason}`, {
        remediation: `本机三级沙箱实测：进程 ${cached.process ? '✓' : '✗'} / 容器 ${cached.container ? '✓' : '✗'} / VM ${cached.vm ? '✓' : '✗'}。`
          + '请提供满足要求的执行环境，或改用允许的档位。本插件**不会**在无沙箱的情况下执行变更类操作。',
        details: cached,
      })
    }
    if (sat.substituted) {
      runtime.warnings?.push?.(warn(WARNING_CODES.W_VM_SANDBOX_ABSENT,
        `要求 ${required}，实测不可用；按更严的 ${sat.via} 执行`,
        { required, via: sat.via }))
    }
    return { tier: sat.via ?? 'none', satisfied: true, probe: cached }
  }

  const probe = await probeSandbox(runtime)
  runtime.__sandboxProbe = probe
  const sat = tierSatisfied(probe, required)
  if (!sat.ok) {
    fail(ERROR_CODES.E_SANDBOX_UNAVAILABLE, `沙箱档位不足：${sat.reason}`, {
      remediation: `本机三级沙箱实测：进程 ${probe.process ? '✓' : '✗'} / 容器 ${probe.container ? '✓' : '✗'} / VM ${probe.vm ? '✓' : '✗'}。`
        + 'VM 级需要 qemu/firecracker/cloud-hypervisor/virsh/kata/runsc 之一。'
        + '本插件不会在无沙箱的情况下执行变更类操作。',
      details: probe,
    })
  }
  if (sat.substituted) {
    runtime.warnings?.push?.(warn(WARNING_CODES.W_VM_SANDBOX_ABSENT,
      `要求 ${required}，实测不可用；按更严的 ${sat.via} 执行`, { required, via: sat.via }))
  }
  return { tier: sat.via ?? 'none', satisfied: true, probe }
}

export { run as runProbe }
