---
name: root-cause-wall
description: 为 inference-tuning 新增/修改一堵根因墙或一条干预映射。当需要支持新引擎、新硬件、新瓶颈类型，或发现某堵墙的判据不成立时使用。
---

# 给 inference-tuning 加一堵墙

## 什么时候需要加墙

- 换了引擎/硬件，现有 5 堵墙覆盖不到它的瓶颈
- 现有墙的判据被证明不成立（例如口径算错、假设不适用）
- 出现了新的可解除瓶颈类型

**不要**为了"多一个可调参数"而加墙 —— 墙是**物理/数学关系**，不是参数分组。

## 一堵墙的契约

`src/walls/index.mjs`：

```js
export const myWall = {
  id: 'my-wall',            // 唯一、kebab-case
  title: '…',
  kind: 'memory|compute|algorithm|capacity|schedule',
  goalMetric: 'singleStreamTps|batchThroughput',
  requires: ['a.b.c', '…'], // **必须**列出它依赖的观测；缺了会被判 unknown 并提示"该测什么"

  // 理论上界。返回 null 表示"观测不够，算不出上界"（**不要**用默认值凑）
  theory(ctx) {
    const x = num(resolve(ctx, 'a.b.c'))     // num() 会把 null/''/undefined 变成 null，
    if (x === null) return null               // 这个拦截是必须的：Number(null) === 0
    return { bound, unit, formula, inputs, provenance }
  },

  // 当前状态。**必须**带 sanity 字段
  status(ctx) {
    return { state: 'walled'|'headroom'|'unknown', utilization, gapToBound, detail, missing, sanity }
  },

  // 可解除性：这堵墙现在能不能被干预解除
  actionable(ctx, th, st) {
    return { ok: true|false, why, redirect? }
  },
}
```

## 三条硬要求

### ① `sanity` 必须能自我否证

当"反推量 > 实测可达量"时，判**分母口径有误**，而不是判"硬件到顶"：

```js
sanity: eff > ach * 1.02
  ? { ok: false, warn: `反推 ${eff} > 实测可达 ${ach} —— 分母口径有误，禁止据此判定"硬件到顶"` }
  : { ok: true, effectiveGBps: eff }
```

这条不是形式主义。真机上正是它拦住了"用理论峰值 273 GB/s 当分母 → 判 98.8% 到顶"的误判：
换成实测 240 GB/s 后，反推的 269.8 GB/s **在物理上不可能**，说明分母算错了。

### ② 分母必须来自本机实测

`ctx.provenance` 里出现 `spec-sheet` / `theoretical-peak` / `datasheet` 会被
`assertNoSpecSheet` **直接拒绝整个诊断**。可用的 provenance：

`local-microbenchmark`（微基准）· `model-file-scan`（扫模型文件量出来的）·
`engine-reported`（引擎自报）· `adapter`（适配器提供）· `assumed-default`（有默认假设，需显式标注）

### ③ `requires` 写全

缺观测 → `state: 'unknown'` → 诊断报告里列出"该测什么"。
**观测即诊断的一部分**：说不清"该测什么"的墙是没用的墙。

## 再配一条干预映射

`src/walls/remedies.mjs`：

```js
export const REMEDIES = {
  'my-wall': {
    top1: 'my_lever',              // 语义杠杆名，不是引擎 flag
    why: '为什么先试这一个',
    expected: '预期哪个指标动、往哪个方向动',
    alternatives: ['other_lever'],
    falsify: ['什么情况下它不会生效', '…'],   // 必填：没有否证条件的干预是乱试
  },
}
```

再加语义定义（`LEVER_SEMANTICS`）：`description` / `direction` / `affects` / `precondition`。

## 最后接引擎 flag

`src/registry.mjs` 的 `PARAM_CATALOG`：把语义杠杆映射到真实 flag，
并声明 `kind/min/max/align/default`。

**flag 必须实测存在**：`probeEngineFlags` 会跑 `<image> --help` 取真实 flag 集合，
不支持的一律**跳过并记账**（`skipped`），不猜。
（真机教训：vLLM 0.23.1rc1 删掉了 `--swap-space` 与 `--disable-log-requests`，
硬编码启动参数会让服务直接起不来。）

## 别忘了

- 单测：`tests/unit/walls.test.mjs` 里加一条，**必须包含一条"该墙的 sanity 能拦住误判"的用例**
- 自检：`npm run check` 里"每堵墙都有 requires/sanity/干预映射"是自动断言的
- 若杠杆会改精度或缓存格式 → **加进 `FORBIDDEN_PARAM_PATTERNS`**（那是硬排除）
