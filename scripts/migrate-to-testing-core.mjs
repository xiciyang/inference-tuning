#!/usr/bin/env node
/**
 * 迁移脚本：把包内 `@internal` 的精度回归实现换成真正的 `@ai-infra/testing-core`。
 *
 * 契约见 `docs/parity-contract.md` §6。**两个包同时替换**，本脚本是其中之一。
 * 默认 dry-run；`--apply` 才写盘。
 *
 * 做三件事（都是可复核的文本改写，不猜）：
 *   ① 在 `src/testing/parity.mjs` 顶部插入真库的 re-export（保留契约常量）
 *   ② 移除 `W_INTERNAL_SHARED_LIB` 警告的触发点（若有）
 *   ③ 打印需要人工确认的残留清单（本文件里的 @internal 段落）
 *
 * 刻意**不自动删除**原实现：真库上线后先并行跑一轮，
 * 用 `tests/contract/parity-consistency.test.mjs` 断言两边一致，再手工删除。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = join(PKG_ROOT, 'src', 'testing', 'parity.mjs')
const apply = process.argv.includes('--apply')

const HEADER = `// --- 迁移到 @ai-infra/testing-core（由 scripts/migrate-to-testing-core.mjs 生成）---
// 契约来源仍是 docs/parity-contract.md；下面是真库的 re-export。
// 调用方（src/tuning.mjs / src/gate.mjs）零改动。
export {
  parityCheck as testingCoreParityCheck,
  compareParity as testingCoreCompareParity,
  TESTING_CORE_CONTRACT_VERSION,
} from '@ai-infra/testing-core'
// --- 以上为迁移插入段 ---
`

function main() {
  if (!existsSync(TARGET)) {
    console.error(`找不到目标文件：${TARGET}`)
    process.exit(1)
  }
  const src = readFileSync(TARGET, 'utf8')
  if (src.includes('@ai-infra/testing-core\'')) {
    console.log('已迁移过（文件中已存在真库 re-export），无需重复。')
    return
  }
  const next = `${HEADER}\n${src}`
  const plan = [
    { step: '① 插入真库 re-export', file: TARGET, bytes: HEADER.length },
    { step: '② 人工确认：把 src/tuning.mjs 的 parityCheck 换成 testingCoreParityCheck', file: join(PKG_ROOT, 'src', 'tuning.mjs'), manual: true },
    { step: '③ 人工确认：并行跑一轮 tests/contract/parity-consistency.test.mjs，两边一致后再删除 @internal 实现', file: TARGET, manual: true },
    { step: '④ 人工确认：移除 W_INTERNAL_SHARED_LIB 相关警告', file: join(PKG_ROOT, 'src', 'errors.mjs'), manual: true },
  ]
  console.log(apply ? '迁移计划（即将写盘）：' : '迁移计划（dry-run，未写盘）：')
  for (const p of plan) console.log(`  ${p.step}${p.manual ? '  [需人工]' : ''}\n      ${p.file}${p.bytes ? ` (+${p.bytes} bytes)` : ''}`)
  if (apply) {
    writeFileSync(TARGET, next)
    console.log('\n已写盘。请按上面 ②③④ 逐条完成，然后重跑 npm test。')
    console.log('注意：**两个包要同时替换**（另一份在 inference-quantization）。')
  } else {
    console.log('\n加 --apply 才会写盘。')
  }
}

main()
