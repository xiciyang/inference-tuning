/**
 * 沙箱探测 —— **行为验证，不是存在性检查**。
 *
 * 这条纪律是被一次真实误判换来的：`inference-serving` 的 Step 0 最初把进程级沙箱判成
 * "✅ 可用"，依据是"bwrap 二进制存在 + LSM 已启用"。实际一跑就
 * `bwrap: setting up uid map: Permission denied`。**存在 ≠ 可用。**
 *
 * 本测试**真的跑**三级探测（会起一个 `--rm` 的 alpine 容器，跑完即净）。
 * 断言的是"探测行为本身正确"，不是"本机一定支持某一级" ——
 * 因为不同机器的结论不同，硬断言"容器必须可用"会让测试在别的环境里假红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSandbox } from '../helpers/sandbox.mjs'
import { createRuntime } from '../../src/config.mjs'
import { probeSandbox, tierSatisfied, assertSandbox } from '../../src/sandbox.mjs'

async function rt() {
  const sb = await makeSandbox()
  const runtime = await createRuntime({ root: sb.root, options: { modelRoots: [sb.modelRoot] } })
  return { sb, runtime }
}

test('沙箱: 三级探测真的跑命令，并留下原始输出作为证据', async () => {
  const { sb, runtime } = await rt()
  try {
    const p = await probeSandbox(runtime)
    // 三级都必须有结论（true/false），不能是 undefined
    for (const tier of ['process', 'container', 'vm']) {
      assert.equal(typeof p[tier], 'boolean', `${tier} 必须是明确的布尔结论`)
    }
    // 证据结构
    assert.ok(p.evidence.process, '进程级要有证据')
    assert.ok(p.evidence.container, '容器级要有证据')
    assert.ok(p.evidence.vm, 'VM 级要有证据')
    assert.match(p.note, /实跑/)

    // 进程级：本机 bwrap 存在但行为不可用 —— 必须**由实跑判定**，而不是"没装"
    const proc = p.evidence.process
    if (proc.available === false && proc.probe) {
      assert.ok(proc.probe.cmd.includes('bwrap'), '进程级探测应真的执行 bwrap')
      assert.ok(
        /Permission denied|uid map/i.test(`${proc.probe.stderr}${proc.probe.message ?? ''}`),
        `本机进程级沙箱预期因 uid map 被拒而不可用，实际 stderr=${proc.probe.stderr.slice(0, 200)}`,
      )
    }

    // 容器级：探测命令必须真的起容器（不是 --version）
    const cont = p.evidence.container
    if (cont.probe) {
      assert.ok(cont.probe.cmd.includes('docker run'), '容器级探测必须真的 docker run，而不是查版本')
    }

    // VM 级：不可用时必须列出"查过哪些二进制"
    if (p.vm === false) {
      assert.ok(Array.isArray(p.evidence.vm.candidates))
      assert.match(p.evidence.vm.reason, /未安装/)
    }
  } finally { await sb.cleanup() }
})

test('沙箱: 有更严的档位时可以替代较松的需求（R1 不可用 → 按 R2 执行）', () => {
  const probe = { process: false, container: true, vm: false }
  const s1 = tierSatisfied(probe, 'process')
  assert.equal(s1.ok, true)
  assert.equal(s1.via, 'container')
  assert.equal(s1.substituted, true, '必须标记"用了更严的替代"')

  const s2 = tierSatisfied(probe, 'container')
  assert.equal(s2.ok, true)
  assert.equal(s2.substituted, false)

  const s3 = tierSatisfied(probe, 'vm')
  assert.equal(s3.ok, false)
  assert.match(s3.reason, /需要 vm/)

  const s4 = tierSatisfied({ process: false, container: false, vm: false }, 'process')
  assert.equal(s4.ok, false)
})

test('沙箱: 需求满足不了 → 明确失败（不在无沙箱下执行变更类操作）', async () => {
  const { sb, runtime } = await rt()
  try {
    runtime.__sandboxProbe = { process: false, container: false, vm: false, evidence: {}, checkedAt: new Date().toISOString() }
    await assert.rejects(
      () => assertSandbox(runtime, 'container'),
      (e) => {
        assert.equal(e.code, 'E_SANDBOX_UNAVAILABLE')
        assert.match(e.remediation, /不会.*无沙箱/)
        assert.ok(e.details.evidence !== undefined)
        return true
      },
    )
  } finally { await sb.cleanup() }
})

test('沙箱: 用更严档位替代时留下 W_VM_SANDBOX_ABSENT 警告（透明）', async () => {
  const { sb, runtime } = await rt()
  try {
    runtime.__sandboxProbe = { process: false, container: true, vm: false, evidence: {}, checkedAt: new Date().toISOString() }
    const r = await assertSandbox(runtime, 'process')
    assert.equal(r.tier, 'container')
    const codes = runtime.warnings.map((w) => (typeof w.toJSON === 'function' ? w.toJSON().code : w.code))
    assert.ok(codes.includes('W_VM_SANDBOX_ABSENT'), JSON.stringify(codes))
  } finally { await sb.cleanup() }
})

test('沙箱: 命中缓存时不重复探测（force 可强制）', async () => {
  const { sb, runtime } = await rt()
  try {
    runtime.__sandboxProbe = { process: false, container: true, vm: false, evidence: { marker: 'cached' }, checkedAt: 'T' }
    const r = await assertSandbox(runtime, 'container')
    assert.equal(r.probe.evidence.marker, 'cached')
  } finally { await sb.cleanup() }
})
