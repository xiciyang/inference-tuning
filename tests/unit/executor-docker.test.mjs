/**
 * 真机执行器 —— 只在**真实 docker 路径**才出现的两类缺陷的回归。
 *
 * 假执行器不调 `run()`，所以这两条在 S1–S3 的全部单测里都是隐形的，
 * 直到第一次真机端到端才暴露：
 *
 *   ① `execFile(..., { signal: null })` 直接抛 `ERR_INVALID_ARG_TYPE`
 *      （"options.signal must be an instance of AbortSignal"）
 *   ② **部署成功之后的富化若抛异常，端点会失去所有权** ——
 *      serving 已经把容器建出来了，而本插件在返回之前抛了，
 *      调用方拿不到 id → 不在 ownedEndpoints 里 → 收尾不拆 → **容器泄漏**
 *      （真机实测：泄漏了一个跑着 vLLM 的容器 7 分钟）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSandbox } from '../helpers/sandbox.mjs'
import { createRuntime } from '../../src/config.mjs'
import { dockerExecutor } from '../../src/executors/docker.mjs'

async function rt() {
  const sb = await makeSandbox()
  const runtime = await createRuntime({ root: sb.root, options: { modelRoots: [sb.modelRoot] } })
  runtime.__log = { info() {}, warn() {}, error() {}, phase() {} }
  return { sb, runtime }
}

test('docker 执行器: resolveEngineImage 对不存在的容器**返回结构化结果，不抛**', async () => {
  const { sb, runtime } = await rt()
  try {
    // 这条路径同时覆盖两个 bug：
    //   · run() 里 signal 默认 null —— 修之前会抛 ERR_INVALID_ARG_TYPE
    //   · 反查失败必须被吞掉并结构化返回，而不是让调用方（部署路径）炸掉
    const r = await dockerExecutor.resolveEngineImage(runtime, { containerName: 'definitely-not-a-container-xyz' })
    assert.equal(r.image, null)
    assert.equal(r.imageId, null)
    assert.ok(r.why, '失败必须给出原因')
    assert.match(r.why, /docker inspect 失败|无法反查/)
  } finally { await sb.cleanup() }
})

test('docker 执行器: 缺 containerName 时也不抛，并说明为什么', async () => {
  const { sb, runtime } = await rt()
  try {
    const r = await dockerExecutor.resolveEngineImage(runtime, { containerName: null })
    assert.equal(r.image, null)
    assert.match(r.why, /containerName/)
  } finally { await sb.cleanup() }
})

test('docker 执行器: 能从**真实运行中的容器**反查到镜像（行为验证）', async () => {
  const { sb, runtime } = await rt()
  const { execFile } = await import('node:child_process')
  const runp = (c, a) => new Promise((res) => execFile(c, a, (e, so) => res(e ? null : String(so).trim())))
  const name = `it-exec-probe-${Date.now()}`
  try {
    const started = await runp('docker', ['run', '-d', '--rm', '--name', name, 'alpine:3.20', 'sleep', '30'])
    if (!started) { console.log('（跳过：本机 docker 不可用）'); return }
    const r = await dockerExecutor.resolveEngineImage(runtime, { containerName: name })
    assert.ok(r.image, `应反查到镜像，实际 ${JSON.stringify(r)}`)
    assert.match(r.image, /alpine/)
    assert.equal(r.via, 'docker-inspect')
    assert.match(r.imageId, /^sha256:/)
  } finally {
    await runp('docker', ['rm', '-f', name])
    await sb.cleanup()
  }
})

test('docker 执行器: flag 探测对不存在的镜像不抛（返回 probed=false 的结构化结果）', async () => {
  const { sb, runtime } = await rt()
  try {
    const r = await dockerExecutor.probeEngineFlags(runtime, { flags: ['--max-num-seqs'], image: null })
    assert.equal(r.probed, false)
    assert.ok(r.supported instanceof Set)
    assert.match(r.reason, /未指定引擎镜像/)
  } finally { await sb.cleanup() }
})

test('docker 执行器: 带宽探针在无镜像时返回 null（而不是编一个数）', async () => {
  const { sb, runtime } = await rt()
  try {
    const r = await dockerExecutor.bandwidthProbe(runtime, { image: null })
    assert.equal(r, null)
  } finally { await sb.cleanup() }
})

test('docker 执行器: 带宽探针脚本写到共享状态根，**不写进安装目录**（F-11 回归）', async () => {
  const { sb, runtime } = await rt()
  try {
    const { BANDWIDTH_PROBE_PY } = await import('../../src/observe/bandwidth.mjs')
    const pkgRoot = runtime.__packageRoot
    assert.ok(pkgRoot, 'runtime 必须带 __packageRoot（否则这条测试没意义）')

    // 用一个**本机已有**的小镜像跑一次：容器会因为没有 python3 而立刻失败，
    // 但**脚本一定会先落盘** —— 我们要验的是"落盘位置"，不是"探针跑通"。
    // （不用不存在的镜像：那会让 docker 去拉取而超时，把一个 1 秒的断言拖成 75 秒。）
    await dockerExecutor.bandwidthProbe(runtime, { image: 'alpine:3.20', log: runtime.__log }).catch(() => null)

    const { promises: fs } = await import('node:fs')
    const { join } = await import('node:path')

    const expected = join(runtime.paths.tmpDir, 'bwprobe', 'bandwidth_probe.py')
    const written = await fs.readFile(expected, 'utf8').catch(() => null)
    assert.ok(written, `探针脚本必须落在 ${expected}`)
    assert.equal(written, BANDWIDTH_PROBE_PY, '落盘内容应与我们发射的探针一致')

    // 关键回归：安装目录里**不能**出现这个文件。
    // （曾经写的是 `${__packageRoot}observe/bandwidth_probe.py` —— 只读安装会直接失败，
    //   而那是"实测可达带宽"的分母，失败后带宽墙只能降级为 unknown。）
    const stray = await fs.readFile(join(pkgRoot, 'observe', 'bandwidth_probe.py'), 'utf8').catch(() => null)
    assert.equal(stray, null, '安装目录里不得出现运行时产物')
  } finally {
    await sb.cleanup()
  }
})
