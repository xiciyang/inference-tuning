/**
 * **契约一致性检查（CI 级别）** —— 用户裁决 Q4 的第 1 条。
 *
 * 背景：`@ai-infra/testing-core` 不存在（四项独立探测为空 + registry 不可达），
 * 因此精度回归有**两份实现**：
 *   · inference-quantization → `container-forward`（调的是磁盘上的权重）
 *   · inference-tuning       → `endpoint-logprobs`（调的是正在被服务的那个配置）
 * 两份实现意味着漂移风险，所以契约放在**文件**里（`docs/parity-contract.md`，单一事实来源），
 * 由本测试在三方之间做一致性断言：
 *
 *      契约文件  ⇄  本包实现  ⇄  兄弟包（quantization）实现
 *
 * **这是 CI 级别的门禁，不是运行时告警**：
 *   不一致 → 测试失败 → 不允许发布。
 *   任何一个包改了契约而另一个没跟上，会在 `npm test` 里立刻红。
 *
 * CI 前置：两个包需要**相邻 checkout**（本仓布局天然满足）。
 * 缺兄弟包时本测试**失败**而不是跳过 —— 跳过等于把漂移风险静默掉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describeContract as tuningContract, PARITY_CONTRACT_VERSION, UNIFORM_TOLERANCE_NATS } from '../../src/testing/parity.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const CONTRACT_PATH = join(PKG_ROOT, 'docs', 'parity-contract.md')
const SIBLING = join(PKG_ROOT, '..', 'inference-quantization')

function readContract() {
  assert.ok(existsSync(CONTRACT_PATH), `契约文件不存在：${CONTRACT_PATH}`)
  return readFileSync(CONTRACT_PATH, 'utf8')
}

test('契约文件: 存在且声明了 contractVersion', () => {
  const md = readContract()
  const m = /contractVersion:\s*"([^"]+)"/.exec(md)
  assert.ok(m, '契约文件必须声明 contractVersion')
  assert.equal(m[1], PARITY_CONTRACT_VERSION, '契约文件与本包实现的版本不一致')
})

test('契约文件: §3.2 的三闸 code 与实现完全一致（顺序也一致）', () => {
  const md = readContract()
  const codes = [...md.matchAll(/^\|\s*[①②③]\s*\|\s*`([a-z-]+)`\s*\|/gm)].map((m) => m[1])
  assert.equal(codes.length, 3, `契约文件里应恰好声明 3 条闸，实际 ${JSON.stringify(codes)}`)
  assert.deepEqual(codes, tuningContract().validityGateCodes, '契约文件的三闸与本包实现不一致')
})

test('契约文件: 均匀签名容差与实现一致', () => {
  const md = readContract()
  assert.ok(/1e-4/.test(md), '契约文件应写明 1e-4 容差')
  const declared = /uniformTol:\s*([0-9.e-]+)/.exec(md)
  if (declared) assert.equal(Number(declared[1]), UNIFORM_TOLERANCE_NATS)
  assert.equal(UNIFORM_TOLERANCE_NATS, 1e-4)
})

test('契约文件: §1.2 要求的测量侧键，本包实现全部产出', () => {
  const md = readContract()
  const required = ['meanNll', 'perplexity', 'vocabSize', 'scoredSamples', 'tokens', 'itemMeanNlls', 'validity', 'source']
  for (const k of required) {
    assert.ok(md.includes(`\`${k}\``), `契约文件应声明测量侧键 ${k}`)
  }
  assert.equal(tuningContract().source, 'endpoint-logprobs')
})

test('契约文件: 两种取数来源都被承认（契约约束的是形状+判据，不是从哪取数）', () => {
  const md = readContract()
  assert.ok(md.includes('endpoint-logprobs'))
  assert.ok(md.includes('container-forward'))
})

// ---------------------------------------------------------------- 跨包一致性

test('跨包: 兄弟包 inference-quantization 必须存在（CI 前置；缺失即失败，不跳过）', () => {
  assert.ok(
    existsSync(SIBLING),
    `契约一致性检查需要相邻的 inference-quantization checkout：${SIBLING}。`
    + '这是 CI 级别的门禁 —— 跳过会让两份实现的漂移风险静默存在。',
  )
})

test('跨包: 两个包声明的 contractVersion 一致', async () => {
  const mod = await import(pathToFileURL(join(SIBLING, 'src', 'testing', 'parity.mjs')).href)
  const theirVersion = mod.TESTING_CORE_CONTRACT_VERSION
  assert.ok(theirVersion, '兄弟包应导出 TESTING_CORE_CONTRACT_VERSION')
  assert.equal(theirVersion, PARITY_CONTRACT_VERSION,
    `契约版本漂移：inference-tuning=${PARITY_CONTRACT_VERSION} vs inference-quantization=${theirVersion}`)
})

test('跨包: 两个包的实现都自标 @internal（过渡件身份不得丢失）', async () => {
  const theirs = await import(pathToFileURL(join(SIBLING, 'src', 'testing', 'parity.mjs')).href)
  assert.equal(theirs.describeContract().internal, true, '兄弟包的实现丢了 @internal 标记')
  assert.equal(tuningContract().internal, true)
  assert.equal(theirs.describeContract().implementation, 'inference-quantization/internal')
  assert.equal(tuningContract().implementation, 'inference-tuning/internal')
})

test('跨包: 兄弟包的精度三闸 code 与本包一致（**判定口径不得漂移**）', async () => {
  const mod = await import(pathToFileURL(join(SIBLING, 'src', 'gate.mjs')).href)
  const fn = mod.assertMeasurementValid
  assert.equal(typeof fn, 'function', '兄弟包应导出 assertMeasurementValid')

  // 用同一份「均匀输出 + 逐位相同 + 无方差」的退化输入分别喂两边，比较判定与 code
  const incident = {
    meanNll: 11.93121445743442, perplexity: 151935.96944645362, vocabSize: 151936,
    scoredSamples: 400, itemMeanNlls: Array(400).fill(11.93121445743442),
  }
  const theirs = fn({ baseline: incident, candidate: incident })
  const { assertAccuracyMeasurementValid } = await import('../../src/gate.mjs')
  const ours = assertAccuracyMeasurementValid({ before: incident, after: incident })

  assert.equal(theirs.valid, false, '兄弟包应判测量不成立')
  assert.equal(ours.valid, false, '本包应判测量不成立')

  const codesTheirs = [...new Set(theirs.reasons.map((r) => String(r.code).replace(/^sidecar:/, '')))].sort()
  const codesOurs = [...new Set(ours.reasons.map((r) => String(r.code).replace(/^sidecar:/, '')))].sort()
  assert.deepEqual(codesOurs, codesTheirs, '三闸的 code 集不一致（判定口径漂移）')
  for (const c of ['uniform-output', 'indiscriminate', 'no-item-variance']) {
    assert.ok(codesOurs.includes(c), `本包应产出 ${c}`)
    assert.ok(codesTheirs.includes(c), `兄弟包应产出 ${c}`)
  }
})

test('跨包: 健康输入的判定也必须一致（两边都判成立）', async () => {
  const adjacent = (base) => ({
    meanNll: base, perplexity: Math.exp(base), vocabSize: 151936, scoredSamples: 30,
    itemMeanNlls: Array.from({ length: 30 }, (_, i) => base + 0.3 * Math.sin(i)),
    validity: { valid: true, reasons: [] },
  })
  const mod = await import(pathToFileURL(join(SIBLING, 'src', 'gate.mjs')).href)
  const theirs = mod.assertMeasurementValid({ baseline: adjacent(2.7), candidate: adjacent(2.75) })
  const { assertAccuracyMeasurementValid } = await import('../../src/gate.mjs')
  const ours = assertAccuracyMeasurementValid({ before: adjacent(2.7), after: adjacent(2.75) })
  assert.equal(ours.valid, true, JSON.stringify(ours.reasons))
  assert.equal(theirs.valid, true, JSON.stringify(theirs.reasons))
})

test('跨包: 契约来源路径一致（两边都指 docs/parity-contract.md）', () => {
  assert.equal(tuningContract().contractSource, 'docs/parity-contract.md')
  const md = readContract()
  assert.ok(md.includes('docs/parity-contract.md') || md.includes('parity-contract.md'))
})

test('迁移路径: 契约文件写明 testing-core 可用后两份实现同时替换', () => {
  const md = readContract()
  assert.ok(md.includes('@ai-infra/testing-core'), '应写明迁移目标')
  assert.match(md, /两份实现同时替换|两个包.*同时/, '应写明"同时替换"')
  const migrate = join(PKG_ROOT, 'scripts', 'migrate-to-testing-core.mjs')
  assert.ok(existsSync(migrate), `迁移脚本应存在：${migrate}`)
})
