# MIGRATION_PLAN.md — inference-tuning 能力清单与迁移决策

> 生成：2026-09-27（Step 0 只读产出的第二份文档）
> 配套：`PROJECT_CONTEXT.md`（调研证据）· `RISK_CLASSIFICATION_DELTA.md`（风险增量）
> **本文件是待你确认的方案，不是已执行的动作。** 确认后我才开始写包。

---

## 〇、口径（读之前必须同意的两条）

### 口径 1：「继承」= 能力重新实现，**代码零复用**

你的裁决是 `inference-tuning` **新写**、**不继承 `dsh-tuning-engine`**。所以本文所有「继承」只有一种含义：

> **保留这项能力，用新代码在新架构里实现它。**

不存在"把 `lib/analyze/*.mjs` 拷过来"的选项。理由是硬的：`dsh-tuning-engine` 是
`private: true` 的组合父包（8 个 workspace 子包、22,937 行、手写测试 runner、自管 docker），
与目标形态（**单包、零运行时依赖、四入口、MCP 优先、有风险分级与哈希链审计**）在**每一条工程约束上都相反**。
部分拷贝会同时得到两边的最坏属性。

### 口径 2：`dsh-tuning-engine` 同时存活，命名空间必须分开

它**当前是活的**（`~/.dsh/profiles/web` 的 bundles + `link:`，实测 `tuner_analyze` 可调用）。
所以新插件不得占用 `tuner_*` / `tuner_field_*`，也不得注册 `/__tuner/*` 路由。

→ **MCP 前缀 `inference_tuning_*`；HTTP 路由前缀 `/__inference_tuning/`。**

---

## 一、目标形态（与 serving / quantization 对齐）

| 维度 | `inference-serving` | `inference-quantization` | `inference-tuning`（目标） |
|---|---|---|---|
| 包形态 | 单包，零运行时依赖 | 单包，零运行时依赖 | **同** |
| 入口 | CLI + 编程 API + MCP + DSH 插件 | 同 | **同** |
| MCP 工具 | 10 | 11 | 拟 **6–8**（见 §五） |
| 共享状态 | `~/.ai-infra/state/serving-registry.yaml` | `.../quantization-matrix.yaml` | `.../tuning-registry.yaml` |
| 审计 | `~/.ai-infra/logs/audit/inference-serving/{date}.jsonl`（sha256 链） | 同构 | **同构** |
| 风险分级 | R0–R6 + 确认令牌（绑定目标指纹） | 同 | **同** |
| 门禁 | 资源/端口/内存 | 精度 + 性能 + **测量成立性** | 性能 + **精度不降** + **测量成立性** |
| 阈值来源 | — | 调用方 or `gates.yaml`，**都无则拒绝** | **同**（`max_accuracy_drop_pct` / `min_perf_gain_pct`） |
| 执行器接缝 | 后端注册表 | 执行器接缝（docker / 进程内假件） | **同**（使闭环测试免 GPU） |
| 测试 | `node:test` | `node:test`（129 用例） | **`node:test`** |

---

## 二、能力清单

### A. 能力继承（重新实现，语义保留）—— 15 项

| # | 能力 | 原落点 | 新包落点（拟） | 为什么留 |
|---|---|---|---|---|
| A1 | **根因墙框架**：带宽/投机/算力/调度/容量 5 堵墙，每堵声明 `requires` / `theory` / `status` / `actionable` | `lib/walls/index.mjs` 531L | `src/walls/*.mjs` | 你的第 1 条方法论。**没有它 tuning 就退化成盲搜** |
| A2 | **口径自洽检查**：反推有效带宽 > 实测可达 ⇒ 判"分母口径有误"而非"硬件到顶" | `bandwidthWall.status().sanity` | 同（每堵墙都要有） | 你的"硬件到顶必须写明限定条件" |
| A3 | **实测可达带宽探针**：未注入执行器就返回 `null`，**拒绝用理论峰值** | `lib/observe/index.mjs` 109L | `src/observe/bandwidth.mjs` | 你的"分子分母必须本机实测" |
| A4 | **世界经验干预映射**：墙 → TOP1 干预，用**语义杠杆名**与引擎 flag 解耦 | `lib/walls/remedies.mjs` 160L | `src/walls/remedies.mjs` | 你的"按世界经验直接匹配 TOP1 干预" |
| A5 | **干预无效时的五因反思** | 散落在 `engine.mjs` 决策分支 | 显式化为 `src/loop/reflect.mjs` | 你的"TOP1 无效先停下反思五种原因"（**原实现未显式化，这里要补强**） |
| A6 | **测量完整性四闸**：聚合口径必须声明 / 预热闸 / 时滞对齐 / Fisher 精确检验 | `lib/analyze/measurement-integrity.mjs` 208L | `src/validity/performance.mjs` | 与 Phase 1 的"测量成立性"是同一原则的第二个实例 |
| A7 | **目标驱动与不停机判据**：`assessDrive` / `gateBottleneck` / `decideRunOutcome` | `lib/analyze/objective.mjs` 362L | `src/loop/objective.mjs` | 你的"给出目标后中途不能停" |
| A8 | **过早收尾检测** | `lib/analyze/optimization-space.mjs#detectEarlyStop` | `src/loop/early-stop.mjs` | 防止"看起来收敛了"其实没到墙 |
| A9 | **单流天花板 + 证据链** | `lib/analyze/single-stream-ceiling.mjs` 148L | `src/walls/ceiling.mjs` | 判断"是否还有空间"的分母 |
| A10 | **内存/状态缓存分解** | `lib/analyze/memory-decomp.mjs` 173L | `src/walls/memory.mjs` | 统一内存机器上尤其需要（119.6 GiB，无独立 VRAM） |
| A11 | **声明式主张门禁**：provenance / inferred 边界 | `lib/analyze/claim-gate.mjs` 339L | `src/validity/claims.mjs` | 你的"缺证据必须声明不可判" |
| A12 | **预注册与判定**（搜索是验证手段） | `lib/analyze/prereg.mjs` 542L | `src/loop/prereg.mjs` | 防止事后择优 |
| A13 | **统计估计器白名单** | `lib/analyze/stats-registry.mjs` 162L | `src/validity/stats.mjs` | 防止用未经验证的估计量下结论 |
| A14 | **配置快照/重放**：参数 → argv 的零硬编码映射 + 等价性校验 | `lib/run-spec.mjs` 186L | `src/config/run-spec.mjs` | 满足"可复用的优化配置"验收项 |
| A15 | **GPU 规格实测优先** | `lib/backends/gpuspecs.mjs#specFromMeasured` | `src/platform/gpuspec.mjs` | GB10 的 `nvidia-smi` 内存是 `N/A`，静态表必错 |
| A16 | 算子类别超额 + 步分解 + SLA goodput + tier 可行域 | `lib/analyze/{class-excess,step-decomposition,sla-goodput}.mjs` + `packages/operator` 1,574L | `src/analysis/*` | 归因到"哪一类算子、哪一步"才有可执行的干预 |

> A16 是**分层交付的候选**（见 §六 Q3）：先做 A1–A15，A16 按需补。

### B. 需要重新设计 —— 8 项

| # | 原设计 | 新设计 | 为什么必须改 |
|---|---|---|---|
| B1 | **自管 docker 生命周期**（`engine.mjs` 直接 `docker run -d --name` / `docker rm -f`） | 全程走 `inference-serving` MCP：`deploy` / `teardown` / `rollback` / `reconcile` | ⚠ **所有权冲突**。两套生命周期会互相踩端口/显存/容器名；serving 已有"拆解并验证无残留"的完整实现 |
| B2 | DSH 插件单入口 | CLI + 编程 API + MCP + DSH 四入口 | 与 serving/quantization 同构；MCP 是跨插件协作的实际通道 |
| B3 | 无风险分级 | R0–R6 + 确认令牌（绑定 `model|method|参数集` 指纹） | 调优会重启推理服务、改并发/显存，属 R2+；必须有确认与审计 |
| B4 | `writeAudit` 单个 JSON | append-only `.jsonl` + sha256 哈希链 + `audit-verify` | 与另两个包一致，且"改过就跑不掉" |
| B5 | 报告落 `process.cwd()/tuner-reports` | `~/.ai-infra/state/tuning-registry.yaml` + `~/.ai-infra/reports/inference-tuning/` | cwd 依赖是 serving/quantization 都踩过的坑 |
| B6 | **性能只有端点侧**，无精度回归 | 新增 parity：容器内直算 mean NLL / perplexity，**前后各一次** | 你验收第 ① 条就是"性能上升**且精度不下降**"。原引擎根本没有这个能力 |
| B7 | `lib/sandbox/*`（runner + host-observer + safety-gate）自建执行 | 执行落点改为**执行器接缝**（与 quantization 同构：docker 执行器 / 进程内假件）；**保留 safety-gate 的语义与规则表** | 让闭环可离线测试是硬需求；safety 规则本身值得留 |
| B8 | 16 个工具 + 47 个 op 全暴露 | 收敛为 6–8 个 MCP 工具 + 内部 op 表 | 工具面过大会稀释契约、增加缓存前缀 |

### C. 不再需要 —— 7 项

| # | 舍弃项 | 规模 | 理由 |
|---|---|---|---|
| C1 | **现场模式 `lib/field/*` + 6 个 `tuner_field_*` 工具** | ~2,200L + 6 工具 | 它存在的前提是"插件不能重启目标服务，只能让用户代跑命令"。有了 serving MCP 这个前提消失。**待你确认（Q1）** |
| C2 | Wiki 读写（`lib/wiki.mjs` 338L + 2 个工具） | ~338L | 与调优无关，属知识沉淀；需要额外 `WIKI_API_TOKEN`。**待你确认（Q2）** |
| C3 | **多后端引擎发现**（docker/podman/k8s/systemd/bare） | `engine-discovery.mjs` 359L | serving 已拥有部署与发现；重复实现只会产生第二套真相 |
| C4 | 静态 GPU 规格峰值表 | `gpuspecs.mjs` 中非 `specFromMeasured` 的部分 | 与"禁止规格书理论峰值"直接冲突 |
| C5 | 组合父包 + 8 个 workspace 子包 | 8 个 `package.json` | 目标形态是单包零依赖；workspace 会引入跨包版本与安装复杂度 |
| C6 | 手写测试 runner（`check(ok,name)` + 自制计数） | 47 文件 / 211 断言 | 统一 `node:test`，与另两包一致；断言数与覆盖率要可被工具统计 |
| C7 | `lib/index.mjs.bak-*` 三个手工备份 | 115 KB | 与交付物无关 |

---

## 三、核心闭环（根因墙驱动，与你的方法论逐条对齐）

```
目标（模型 + 性能目标 + 精度容忍）
  ↓
[0] 前置门禁
     · 阈值必须来自调用方或 gates.yaml，两者都无 → E_THRESHOLD_NOT_PROVIDED（不猜）
     · 源模型结构预检（沿用量化包已验证的那一层：截断 / 整块为零 / 层数 / 分片）
     · 能力探测：从 serving MCP 读端点能力与指标名（不硬编码）
  ↓
[1] 基线测量（性能 + 精度各一次）  ← 精度来自新增 parity
     · 测量完整性四闸先过：聚合口径已声明 / 已过预热窗口 / 事件已做时滞对齐
  ↓
[2] 墙诊断（不是搜参数）
     · 5 堵墙各自 theory(ctx) 出理论上界 → status(ctx) 出利用率 → 排序
     · 每堵墙的 requires 缺哪个就报"该测什么"（观测即诊断）
     · 口径自洽检查：反推值 > 实测可达 ⇒ 判"分母口径有误"，禁止判硬件到顶
  ↓
[3] TOP1 干预（世界经验映射，语义杠杆名 → 引擎 flag）
     · 预注册：先声明"预期哪个指标动、动多少、聚合口径是什么"，再执行
  ↓
[4] 封闭验证（性能 + 精度各一次）
     · 性能：走 serving 真实端点（沿用 quantization 已验证的 perfValidation 形态，含端点拆解）
     · 精度：容器内直算 NLL/perplexity，前后对比
     · 测量成立性独立判定（性能侧四闸 + 精度侧与 quantization 同构的三条否证）
  ↓
[5] 判定
     · 性能上升 且 精度未超容忍 且 测量成立 → 接受（写 registry + 审计）
     · 否则 → **回滚到上一配置**（自动，不是问用户） → 进入 [6]
  ↓
[6] 无效时的五因反思（显式实现，不直接换参数）
     ① 杠杆未生效 ② 墙找错 ③ 墙转移 ④ 测量不成立 ⑤ 真硬件极限（须写明限定条件）
     → 反思结论决定下一步；只有在 ①–④ 都排除后才允许换参数
  ↓
[7] 不停机判据
     · "目标达成"与"预算耗尽"都**不构成停止理由**（你的长期指令）
     · 停止条件只有：达到物理瓶颈（须附限定条件）/ 你显式中止
  ↓
输出：优化后的可复用配置 + 完整报告 + 审计
```

---

## 四、状态、审计与门禁落点

| 项 | 路径 / 形态 |
|---|---|
| 调优注册表 | `~/.ai-infra/state/tuning-registry.yaml`（五要素：方法/配置/性能/精度/状态） |
| 审计 | `~/.ai-infra/logs/audit/inference-tuning/{date}.jsonl`，append-only + sha256 链 |
| 报告 | `~/.ai-infra/reports/inference-tuning/{runId}.json` |
| 门禁阈值 | 调用方 → `~/.ai-infra/config/gates.yaml` → **都无则 `E_THRESHOLD_NOT_PROVIDED`** |
| 确认令牌 | 绑定 `model | 参数集 | 目标` 指纹，避免"令牌通用" |
| 新增错误码 | `E_TUNING_MEASUREMENT_INVALID`、`E_NO_IMPROVEMENT`、`E_ROLLBACK_FAILED`、`E_SERVING_UNAVAILABLE`（复用）、`E_THRESHOLD_NOT_PROVIDED`（复用） |

---

## 五、MCP 工具面（拟 7 个）

| 工具 | 风险档 | 说明 |
|---|---|---|
| `inference_tuning_tune` | R2 | 主闭环入口；**强制** `max_accuracy_drop_pct` + `min_perf_gain_pct` |
| `inference_tuning_diagnose` | R0 | **只读**：跑墙诊断并返回 5 堵墙的上界/利用率/缺失观测（不执行任何实验） |
| `inference_tuning_get_report` | R0 | 读报告 |
| `inference_tuning_list` | R0 | 列调优注册表 |
| `inference_tuning_rollback` | R2 | 回滚到上一配置（含确认） |
| `inference_tuning_metrics` | R0 | 指标 |
| `inference_tuning_doctor` | R0 | 环境/能力/契约自检（含 serving MCP 可达性与沙箱分级） |

`diagnose` 单独存在很重要：它让"先看墙再决定要不要动手"成为一条零风险路径，
也让 `tune` 的第一步可被独立复核。

---

## 六、实施步骤（确认后执行）

| 步 | 内容 | 产出门 |
|---|---|---|
| S1 | 包骨架：`package.json`（零依赖）/ `manifest.yaml` / `cordis.patch.yml` / `src/index.mjs` | `npm run check` 骨架项通过 |
| S2 | 平台层：`config.mjs`（路径）/ `errors.mjs` / `audit.mjs`（哈希链）/ `state/tuning-registry.mjs` / `risk.mjs` / `capability.mjs` | 审计链与注册表单测通过 |
| S3 | **墙框架**（A1/A2/A9/A10/A15）+ 实测带宽探针（A3）+ 干预映射（A4） | 墙诊断单测通过；**含"口径自洽必须拦住硬件到顶误判"的回归用例** |
| S4 | **测量完整性**（A6）+ 主张门禁（A11）+ 统计白名单（A13） | 四闸单测通过 |
| S5 | **目标/不停机/过早收尾**（A7/A8）+ 五因反思（A5）+ 预注册（A12） | 状态机穷举（logicprobe）通过 |
| S6 | **执行器接缝**：docker 执行器（走 serving MCP 起停端点 + 容器内 parity）+ 进程内假件 | **闭环集成测试免 GPU 全通过** |
| S7 | CLI + 编程 API + MCP server + DSH 插件（四入口） | 四入口契约测试通过 |
| S8 | 真机端到端：对已量化的 `Qwen2.5-1.5B-Instruct-verified-awq-w4a16` 跑一轮真实调优 | 真机数据 + 无残留容器 |
| S9 | 文档：`ACCEPTANCE_MATRIX.md` / `DEPLOYMENT_REPORT.md` / `README.md` / `NEXT_STEPS.md` | 逐条对照 |

**约束遵守**：全程不改 `dsh-tuning-engine`；不改 `inference-serving`；不改 `inference-quantization`
（Q4 若选方案 (b) 则需你**显式**解除这条限制）。

---

## 七、验收矩阵草案（40 条，与另两包同构）

| 组 | 条数 | 要点 |
|---|---|---|
| A 功能 | 9 | 闭环可跑、墙诊断、干预映射、自动回滚、配置可复用、报告、注册表五要素… |
| B 输入处理 | 7 | 模型引用/阈值缺失/端口冲突/歧义/serving 不可达… |
| C 安全 | 8 | 风险分级、确认令牌绑定指纹、原模型只读、源模型结构预检、能力清单（8 项能力 + not_provided）、无提权、审计不可改、密钥不入报告 |
| D 健壮性 | 6 | 超时、取消、部分失败、端点拆解无残留、幂等、断点续跑 |
| E 工程 | 5 | 零运行时依赖、`npm pack`、四入口、`npm run check`、测试覆盖 |
| F **调优专项** | 5 | ①性能上升且精度不下降 ②输出可复用优化配置 ③失败自动回滚 ④**测量成立性检查通过** ⑤`dsh-tuning-engine` 零改动（`find -newermt` 证据） |
| **合计** | **40** | |

---

## 八、风险与开放问题

| # | 风险 | 处置 |
|---|---|---|
| R1 | `tuner_*` 命名空间被 live 引擎占用 | 用 `inference_tuning_*`；写一条自检断言"新工具名不与既有重名" |
| R2 | 分析内核重写工作量大（13 模块 ≈ 3,000 行） | 分层交付（§六 Q3 选项 C） |
| R3 | parity 契约两份实现可能漂移 | 两包各带 `contractVersion` 常量 + 一致性检查脚本（Q4） |
| R4 | 走 serving MCP 后分析结论与原自管 docker 路径不一致 | 在 S8 真机上做一次**对照**：同一模型、同一参数，两条路径的性能测量是否一致 |
| R5 | 统一内存（GB10）下 `memory-decomp` 的分母口径 | 用 `specFromMeasured` + 实测带宽；口径自洽检查兜底 |
| R6 | 真机调优会重启推理端点，可能被你正在用的服务影响 | 编排端点用独立端口池；`headless` 策略 + 确认令牌；结束时校验无残留 |

**开放问题**：Q1 现场模式、Q2 Wiki、Q3 移植深度、Q4 精度回归落点（见 `PROJECT_CONTEXT.md` §六）。

---

## 九、本阶段不做的事

- 不修改 `dsh-tuning-engine`（已 `find -newermt` 验证为零改动）。
- 不创建 `inference-tuning/` 包目录、不写任何实现代码。
- 不安装依赖、不写状态文件、不启动服务。
- 不对生产中的推理端点做任何实验。
