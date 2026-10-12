# NEXT_STEPS.md — inference-tuning 之后

> 生成：2026-09-27　状态：`inference-tuning` v0.1.0 已交付，42 条验收通过
> 本文给接手的人（或下一个会话的 agent）三样东西：**能直接复用的经验**、**已知的坑**、**还没做的事**。

---

## 一、给下一个插件（很可能是 RSI 编排阶段）的经验

### 1. 一次真机跑能抓到单测永远抓不到的东西

本包在第一次真机端到端上，连续暴露了三个**只在真实路径存在**的缺陷：

| # | 缺陷 | 为什么单测抓不到 |
|---|---|---|
| 1 | `execFile(..., { signal: null })` 直接抛 `ERR_INVALID_ARG_TYPE` | 假执行器根本不调 `run()` |
| 2 | **部署成功后的富化抛异常 → 端点失去所有权 → 容器泄漏** | 假执行器不会"部署成功后再抛" |
| 3 | **serving 按模型给端点做键** —— 同模型换参数是同一端点的新 revision，不是两个端点 | 假执行器被我按"两个端点"的假设写了，于是它**顺着错误假设一起错** |

第 3 条最值钱：**夹具会顺着你的错误假设一起错**。所以
"夹具必须真实"这条纪律要再加一句 —— **夹具的真实性也包括它所模拟的语义模型**，
而不只是它返回的数值。

### 2. 回退必须用**被调系统的**回退语义

本包第一版把回退实现成"丢掉候选、留下原来的"。在 serving 的 revision 语义下，
"原来的"在候选部署时就已经被取代了 —— 回退把同一个端点拆了，然后"原端点不健康"，
直接触发 `E_ROLLBACK_FAILED`。

**教训**：跨系统协作时，先读清对方的**所有权与版本语义**，再设计自己的回退。

### 3. `Number(null) === 0` 在本项目已经咬到三次

墙框架的观测取值 → 内存预算的保留比例 → GPU 规格的实测带宽。
共同点：都用 `Number.isFinite(Number(x))` 判"有没有值"。

**规矩**：任何"有没有值"的判定必须先 `x !== null && x !== undefined && x !== ''`，
再谈数值。把这条写成一个 `num()` 辅助函数，在模块顶部定义一次，全模块用它。

### 4. 可推导的判据优于魔数（本包的实际用法）

| 场景 | 用的判据 | 为什么不用魔数 |
|---|---|---|
| 输出是否均匀 | `\|meanNll − ln(vocab)\| ≤ 1e-4` | 均匀分布的困惑度**恒等于**词表大小（可推导的等式） |
| 逐条是否无方差 | **极差 = 0** | 标准差要先求和再相除，"全相同"会算出 ~1e-15，逼你引入容差 |
| 天花板是否可信 | 反推量 > 实测可达 ⇒ **分母口径有误** | 物理上不可能 ⇒ 错的是分母，不是硬件 |
| 分解是否加得起来 | 残差 > 最大单项 ⇒ **分解不完整** | 没有"5% 以内算好"这种口径 |
| 仪器能不能看见 | 声称效应 ≥ 测量噪声 | 看不见的效应，测多少次都看不见 |

---

## 二、已知的坑（不要再踩一次）

| 坑 | 现象 | 处置 |
|---|---|---|
| **serving 的端点键是模型** | 同模型改参数得到同一个端点的新 revision | 全程只拥有**一个**端点；回退走 `inference_serving_rollback` |
| **serving 的 `list_endpoints` 不返回 image** | 拿不到引擎镜像 → 带宽探针无法运行 | 从端点列表拿 `containerName`，再 `docker inspect` 反查（本机观测，不是跨插件读状态） |
| **端点列表的 `containerName` 需要额外一次调用** | `deploy` 的返回里没有 | deploy 后补一次 `list_endpoints` 按 id 找 |
| **`docker inspect` 在富化路径上抛异常会泄漏容器** | 端点已建、插件却拿不到 id | 部署后的**一切**富化必须吞掉自己的异常 |
| **本机 `HTTPS_PROXY` 是坏的** | CONNECT 通、TLS 挂；`fetch` 会被吞 | 端点测量统一走 `node:http` |
| **R1 进程级沙箱不可用** | `bwrap: setting up uid map: Permission denied` | 按更严的 R2 容器级执行，并留 `W_VM_SANDBOX_ABSENT` 警告 |
| **`Number(null) === 0`** | 缺失观测被当成 0 → 编造出"看起来合理"的上界 | 见上文 §1.3 |
| **`/dev/stdin` 做 `--observations` 在管道里会读不到** | CLI 拿到空对象 | 演示/脚本里用真实文件 |

---

## 三、还没做的事（如实列出，不假装完成）

### 3.1 真实场景下值得补的能力

| # | 能力 | 为什么值得做 | 前置 |
|---|---|---|---|
| 1 | **DCGM 接入** | 现在 `gpuBusyPct` 拿不到 → 调度墙永远 unknown；4 堵墙里有 1 堵看不见 | 本机有 DCGM exporter 或 `DCGM_METRICS_URL` |
| 2 | **KV 池容量实报** | 现在 `limits.kvPoolTokens` 拿不到 → 容量墙 unknown、内存分解缺预算 | 从引擎 `/metrics` 读 `gpu_cache_usage_perc` 与 `num_gpu_blocks` |
| 3 | **prefill/decode 分开测** | 现在只测了 chat-medium 的整体吞吐，没有 prefill 干扰的分解 | 需要带 `long-prompt` 负载与分步计时 |
| 4 | **算子级 profiling 接入** | `class-excess` 与 `step-decomposition` 的输入（逐算子耗时 / 分步耗时）目前靠调用方提供 | 需要容器的 torch profiler 或引擎的 `/metrics` 细分 |
| 5 | **spec-decode 干预** | `draft_budget` 杠杆已登记，但需要端点启用投机才能动 | 部署一个带 draft model 的端点 |

### 3.2 结构性待办

| # | 待办 | 说明 |
|---|---|---|
| 1 | **`@ai-infra/testing-core` 落地后两份实现同时替换** | 契约见 `docs/parity-contract.md` §6；迁移脚本 `scripts/migrate-to-testing-core.mjs`（两边各一份） |
| 2 | **`inference-tuning` 安装为 DSH 插件后验证真实挂载** | 目前只做了契约层的 `apply(ctx)` 断言（mock ctx），**没有**真注入运行中的 DSH 进程 |
| 3 | **`dsh-tuning-engine` 的退场** | 它仍挂着且 live（16 个 `tuner_*` 工具 + `/__tuner/health`）。本包用 `inference_tuning_*` 与之共存；**等你决定何时下架它** |
| 4 | **算子级改动（R3）** | 本轮不纳入（本机 VM 沙箱不可用）。要开启需你显式授权降级到容器级 |
| 5 | **镜像固定到 digest** | 演示里 serving 部署的是 `vllm/vllm-openai:nightly`（tag），因此 `runSpec.replayable=false`。要做可重放快照需 serving 侧支持按 digest 部署——**不改 serving 的前提下做不到**，已如实记在报告里 |

### 3.3 演示中未覆盖的路径

| 路径 | 状态 |
|---|---|
| `accept`（接受并固化） | **离线测试覆盖**（假执行器 + 真本地端点）；**真机未跑出** —— 真机上 `concurrency_capacity` 的 TOP1 干预收益是 −0.53%（低于 3% 门槛），门禁正确地回退了 |
| `E_ROLLBACK_FAILED` | **真机跑出过一次**（第一版设计的缺陷），修好后在离线测试里用注入覆盖。真机上的"真回退失败"未复现（那是好事） |
| `physical-limit` 停止 | 未跑出（需要所有墙到界且干预穷尽） |
| `yield-resumable`（预算耗尽） | 离线覆盖；真机未跑出（预算 6h 未到） |

---

## 四、接手时先看什么

```bash
cd inference-tuning
npm test                  # 258 用例，不需要 GPU/Docker（沙箱与执行器那两条会真跑 docker）
npm run check             # 119 项包规范自检（含"不占用 tuner_*"的上线前必查项）
node bin/inference-tuning.mjs health --json        # 沙箱/serving/审计链/必叫事件
node bin/inference-tuning.mjs analyze --json       # 只读墙诊断（零风险）
node bin/inference-tuning.mjs capabilities         # 能力清单与"明确不做"的事
node scripts/e2e-demo.mjs --model <完整模型> --test-set <jsonl> --out ./demo-out
```

文档顺序：`README.md` → `docs/step0/PROJECT_CONTEXT.md`（为什么要这么设计）→
`docs/parity-contract.md`（精度回归契约）→ `DEPLOYMENT_REPORT.md`（真机结果与证据）→
`ACCEPTANCE_MATRIX.md`（42 条逐条对照）。

> **一条操作提醒**：演示会经 serving 起**真实 vLLM 容器**，占用统一内存。
> 本机另有一个你长期在跑的服务（`qwen3-embedding`），演示期间请留意内存压力。
> 演示脚本结束时会把本次创建的端点全部拆掉并校验无残留（产物里 `containers.txt` 为证）。
