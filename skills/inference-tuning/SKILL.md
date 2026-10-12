---
name: inference-tuning
description: 用 inference-tuning 做根因墙驱动的推理调优（诊断瓶颈墙 → 匹配 TOP1 干预 → 性能与精度双闭环验证 → 通过则固化配置，失败则自动回退）。当用户要求"调优推理性能""提高吞吐""降低 TTFT""找性能瓶颈""为什么上不去"时使用。
---

# inference-tuning — 根因墙驱动的推理调优

## 什么时候用

- 用户要求提升推理吞吐 / 降低延迟 / 找性能瓶颈
- 用户问"为什么 QPS 上不去""是不是硬件到顶了"
- 需要对一组参数做**可复核**的性能 + 精度闭环验证

**不适用**：量化（→ `inference-quantization`）、部署（→ `inference-serving`）、
改变量化格式（**硬排除**）、训练/QAT。

## 先看墙，再动手（零风险路径）

```bash
inference-tuning analyze --json --observations obs.json
```

`analyze` 是 **R0 只读**，不跑任何实验。它给出：
每堵墙的**理论上界**、当前**实测利用率**、**缺失的观测**、以及推荐的 **TOP1 干预**。

`obs.json` 的形状：

```json
{
  "hardware": { "achievableBandwidthGBps": 238.7 },
  "model": {
    "bytesPerTokenGB": 1.07,
    "contextLength": 4096,
    "kvBytesPerTokenPerCtx": 28672
  },
  "engine": { "image": "vllm@sha256:…", "kernelImplementation": "flash-attn", "kvCacheDtype": "bfloat16" },
  "measurements": { "singleStreamTps": 18.3, "gpuBusyPct": 0.42, "runningRequests": 4 },
  "limits": {
    "kvPoolTokens": 163840,
    "budgetBytes": 100000000000, "weightsBytes": 3000000000, "overheadBytes": 2000000000,
    "kvDtype": "bfloat16", "contextLength": 4096, "seqBudgetNew": 2048, "unifiedMemory": true
  },
  "config": { "numHiddenLayers": 28, "numKeyValueHeads": 2, "headDim": 128 },
  "provenance": { "achievableBandwidthGBps": "local-microbenchmark", "bytesPerTokenGB": "model-file-scan" }
}
```

`analyze` 会额外给出：

- **`ceiling`** —— 单流天花板 + **证据链**（7 个节点，每节点带来源）+ **主张门禁结果**。
  天花板**必须带实现域限定条件**（`engine.kernelImplementation` / `limits.kvDtype` / `model.quantFormat`
  三者至少给一个），否则 `claimGate.verdict != ok`，报告里不得写成"物理上限"。
- **`memory`** —— KV/状态缓存分解 + **每个杠杆具体释放多少字节**（推不出的杠杆标 `derivable:false` 并说明为什么）。
  缺项一律进 `missing`，不会拿系数凑。

**`provenance` 是硬要求**：写 `spec-sheet` / `theoretical-peak` / `datasheet` 会被直接拒绝
（分子与分母必须来自本机实测）。

不传 `observations` 也不会编造数字 —— 每堵墙会报 `missing`，告诉你**该测什么**。

## 主闭环

```bash
inference-tuning tune <model> \
    --max-accuracy-drop-pct 5 --min-perf-gain-pct 20 \
    --test-set ~/.ai-infra/state/datasets/.../test.jsonl
```

**两个阈值必须显式给**（或写进 `~/.ai-infra/config/gates.yaml`）——
两者都没有时插件**拒绝执行**（`E_THRESHOLD_NOT_PROVIDED`），不猜默认值。

首次调用会返回 `E_CONFIRMATION_REQUIRED` 与一个 `confirmToken`（R2，`per-class-once`，24h）。
带上令牌重试即可：

```bash
inference-tuning tune <model> ... --confirm cf_xxxxxxxx
```

### 读结果

```bash
inference-tuning report <runId> --json | jq '.report | {outcome, stopKind, rootWall: .wallDiagnosis.rootWall.id, finalPerfGainPct, rounds: [.rounds[] | {round, lever, decision, gates: .gates.decision}]}'
```

关键字段：

| 字段 | 含义 |
|---|---|
| `outcome` | `improved` / `no-improvement` / `physical-limit` / `rollback-failed` / `user-abort` |
| `wallDiagnosis.rootWall` | 选中的根因墙与推荐干预 |
| `rounds[].validity` | 这一轮的**测量成立性**（性能四闸 + 精度三闸） |
| `rounds[].gates.decision` | `accept` / `confirm-near-limit` / `rollback` / `undetermined` |
| `rounds[].reflection` | 干预无效时的**五因反思**结论 |
| `limitingConditions` | "硬件到顶"判定的**限定条件**（缺实现域条件则不允许判到顶） |
| `earlyStop.suspected` | 是否疑似**过早收尾** |

## 停止语义（与直觉不同，务必知道）

**"目标已达成"与"预算耗尽"都不构成停止理由。**
停止只有三种：`physical-limit`（须带实现域限定条件）/ `user-abort` / `rollback-failed`。

预算耗尽时返回 `yield-resumable` 与 `resumeFrom`，从检查点继续。

## 出事怎么办

| 症状 | 含义 | 处置 |
|---|---|---|
| `E_ROLLBACK_FAILED` | **独立风险档**：目标服务可能停在未知配置上 | **立刻叫人**。已写 `~/.ai-infra/state/MUST_NOTIFY.json`，请人工确认端点与显存 |
| `E_SOURCE_MODEL_INVALID` | 源模型残缺（下载中断 / 整块为零） | 重新完整下载；**不要**在坏模型上调优（性能反而会"更好"） |
| `E_QUANT_FORMAT_FORBIDDEN` | 参数集里含量化格式/精度变更 | 这是**硬排除**，换参数解决不了；量化找 `inference-quantization` |
| `E_MEASUREMENT_INVALID` | 测量不成立 | 看 `reasons[].code`：聚合口径未声明 / 稳态窗口不足 / 均匀输出… |
| `E_SERVING_UNAVAILABLE` | 找不到 serving 的 MCP | 设 `options.servingPath` 或写 `~/.ai-infra/config/serving-path.txt` |

## 纪律（写进插件里，不是建议）

1. **搜索只是验证手段，不是发现手段**：先诊断墙，再匹配干预。
2. **干预无效先反思五因**（测量不成立 → 杠杆未生效 → 墙转移 → 墙找错 → 真硬件极限），
   **不许直接换参数再试**。
3. **任何"硬件到顶"必须写明限定条件**（kernel 实现 / 状态缓存格式 / 量化精度）。
4. **只动本次运行自己建的端点**；存量端点只读。
5. **收尾必须验证无残留**。
