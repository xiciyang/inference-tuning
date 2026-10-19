# PROJECT_CONTEXT.md — inference-tuning Step 0 调研结果（只读）

> 生成：2026-09-27　范围：`dsh-tuning-engine` 实际结构 + serving/quantization 接口契约 + 宿主沙箱行为
> **本阶段为只读**：未修改 `dsh-tuning-engine` 任何字节，未创建 `inference-tuning/` 包，未安装任何依赖，未写任何状态文件。
> 本文每一节标注证据等级：`[verified]` 本机一手实测 / `[inferred]` 推论 / `[claimed]` 二手口径。

---

## 〇、先纠正一条前置认知（重要）

上一轮的计划里写着「`inference-tuning`（原 tuning-engine 改名）」，并准备在 `package.json` 声明
`previousNames: ["dsh-tuning-engine"]`。

**用户裁决已推翻这个口径**：`inference-tuning` 是**新写的标准 npm 包**，**不是** `dsh-tuning-engine` 改名，
**也不继承它的代码**；`dsh-tuning-engine` 保留不动、视为弃用。

因此本阶段所有「继承」二字一律指**能力继承（用新代码重新实现同一能力）**，**不指代码复用**。
`previousNames` 字段**不写**（那会暗示是改名）。本文件与 `MIGRATION_PLAN.md` 全程遵守这条区分。

---

## 一、`dsh-tuning-engine` 实况 `[verified]`

### 1.1 形态与规模

| 项 | 值 |
|---|---|
| 包名 / 版本 | `dsh-tuning-engine` 0.1.0，**`private: true`**（不可发布） |
| 形态 | **组合父包** + 8 个 workspace 子包 |
| 子包 | `@dsh-tuning/{collect, attributor, decider, guard, contracts, statistics, operator, ceilings}` |
| 入口 | `lib/index.mjs`（1,013 行），`main: lib/index.mjs` |
| DSH 契约 | `export const name = 'tuner'`；`export const inject = ['tools','fs','timer','webServer']`；`apply(ctx)` |
| Bundle 组合 | `cordis.patch.yml` → `insert: [{ id: 'tuner', name: 'dsh-tuning-engine', inject: [tools, fs, timer, webServer] }]` |
| 代码量 | 191 个非 node_modules 文件；`.mjs` 合计 **22,937 行**（`lib/` 12,917 + `packages/*/lib` 5,005 + 测试/工具其余） |
| 最大单文件 | `lib/engine.mjs` **1,327 行**（核心优化循环 `OptimizerEngine`） |
| 残留 | 3 个 `lib/index.mjs.bak-*`（33–47 KB，2026-09-14 / 09-18 的手工备份） |

### 1.2 工具面（16 个）

`tuner_*` 10 个：`analyze`、`run_trial`、`diagnose_bottleneck`、`diagnose_root_cause`、`confirm_wall`、
`check_resource_gate`、`run_loop`、`profile_operators`、`read_from_wiki`、`publish_to_wiki`。

`tuner_field_*` 6 个（现场模式）：`capabilities`、`plan`、`ingest`、`next`、`export`、`status`。

`tuner_analyze` 暴露 **47 个纯分析 op**（实测返回），涵盖：SLA/goodput、优化空间、单流天花板、
算子类别超额、步分解、状态缓存分解、主张门禁、预注册与判定、目标驱动与瓶颈闸门、内存余量闸门、
测量完整性、统计出处闸门、闸门注册表、后端目录（引擎/GPU 规格/探针/控制器）、沙箱安全预检、环境发现。

### 1.3 它**没有**的东西（与新包要求的差距）

| 缺 | 说明 |
|---|---|
| **MCP 接口** | 全仓 grep 无任何 MCP 引用。它只有 DSH 工具 + 一条 `GET /__tuner/health` 路由。`inference-serving` 10 个 MCP 工具、`inference-quantization` 11 个，都走 MCP |
| **风险分级 R0–R6 + 确认令牌** | 无。serving/quantization 有完整的 `riskClass` / `permit` / `confirmToken`（与目标指纹绑定） |
| **append-only 审计哈希链** | `lib/convergence.mjs#writeAudit` 只写一个 `audit-report.json`，无 `prevHash`/哈希链 |
| **共享状态注册表** | 无 `~/.ai-infra/state/*.yaml`。报告落 `process.cwd()/tuner-reports`（**cwd 依赖**——与 serving/quantization Step 0 修过的同一类坑） |
| **精度回归接口** | 只有性能。全仓无 perplexity / NLL / parity 实现。而用户对 tuning 的第 ① 条要求就是"性能上升且精度不下降" |
| **标准测试框架** | 手写 runner：`check(ok, name)` + 自制 `pass/fail` 计数 + `test/*/run.mjs` 入口。无 `node:test` |

### 1.4 测试覆盖 `[verified]`

47 个测试文件：`test/unit` 27、`test/field` 16、`test/mock` 4，另 6 个子包各有 `test/run.mjs`。
断言点合计 **211** 处。全部为**离线**（不需 GPU/容器/引擎）。
**未运行**（Step 0 约束"无启动进程"），故此处只报结构不报通过率。

### 1.5 它**当前是活的** `[verified]`

```
实测调用 tuner_analyze({op:'list'}) → ok=true，返回 47 个 op
挂载位置：~/.dsh/profiles/web/package.json
         dependencies."dsh-tuning-engine": "link:$HOME/deepseek_harness/dsh-tuning-engine"
         bundles: [ ... "dsh-tuning-engine" ... ]
         node_modules/dsh-tuning-engine -> $HOME/deepseek_harness/dsh-tuning-engine
```

**这是本阶段最需要你知道的一条工程事实**：

1. 新插件与它**同时挂载**时，`tuner_*` / `tuner_field_*` 命名空间**已被占用**。
   → `inference-tuning` 必须用独立前缀（拟 `inference_tuning_*`），否则工具重名冲突。
2. 它的 `inject` 里含 `webServer` 并注册了 `/__tuner/health`；新插件若要注册路由，路径也要区分。

---

## 二、方法论资产：用户的长期指令已经被写成代码 `[verified]`

这是 `dsh-tuning-engine` 里**最有价值、最不该被丢掉**的部分。逐条对上你的要求：

| 你的要求（原话） | 它在代码里的落点 | 证据 |
|---|---|---|
| **根因墙驱动，不是盲搜参数空间** | `lib/walls/index.mjs`（531 行）：5 堵墙 `bandwidth / speculative / compute / memory / schedule`，每堵墙声明 `requires`（要哪些观测）/ `theory(ctx)`（理论上界）/ `status(ctx)`（利用率）/ `actionable(ctx)`（可解除性） | 文件头注释："**搜索只是验证手段，不是发现手段**" |
| **带宽不能用规格书理论峰值** | `lib/observe/index.mjs#measureAchievableBandwidth`：未注入探针执行器时**返回 `null` 而不是理论值**，并附注 *"未注入带宽探针执行器；禁止用理论峰值代替实测可达带宽"*；探针是自带 triad/read 微基准 | 同文件 `BANDWIDTH_PROBE_PY` |
| **"硬件到顶"必须能自我否证** | `bandwidthWall.status()` 内置**口径自洽检查**：若反推有效带宽 > 实测可达 → 报 *"分母口径有误，禁止据此判定硬件到顶"* | `lib/walls/index.mjs` `sanity` 字段 |
| **TOP1 干预 + 世界经验映射** | `lib/walls/remedies.mjs`：`REMEDIES`（墙 → 干预）+ `LEVER_SEMANTICS`（语义杠杆名，与引擎 flag 解耦） | 文件头："干预项用**语义杠杆名**…换引擎/换模型都不改本文件" |
| **给出目标后中途不能停** | `lib/analyze/objective.mjs`：`defineObjective` / `classifyPath` / `gateBottleneck` / `assessDrive` / `DRIVE_STATUS` / `PATH_STATUS` / `decideRunOutcome` | 362 行 |
| **测量成立性** | `lib/analyze/measurement-integrity.mjs`：四道闸——①聚合方式必须显式声明（`AGGREGATION` 白名单）②预热闸（重启后 ≤3 min 不是稳态，Fisher p=0.0001）③事件对齐必须做时滞扫描（服务端日志比 GPU 早 ~150 ms）④Fisher 精确检验双尾实现 | 208 行，文件头列出四条真实翻车 |
| **主张必须可溯源，推断不得当结论** | `lib/analyze/claim-gate.mjs`：`gateClaim` / `gateCeiling` / `gateQuantitative` / `gateInferredClaim` + `PROVENANCE` / `INFERRED_VERDICT` | 339 行 |
| **搜索是验证手段** | `lib/analyze/prereg.mjs`：`preregister` / `judge` / `checkEffectAssertions` / `checkVerificationStrength` / `checkInstrumentSelfMatch` | **542 行**（最大的分析模块） |
| **统计出处** | `lib/analyze/stats-registry.mjs`：`APPROVED_ESTIMATORS` 白名单 + `gateStatisticalClaim` | 162 行 |
| 单流天花板与证据链 | `lib/analyze/single-stream-ceiling.mjs`：`singleStreamCeiling` + `evidenceChain` | 148 行 |
| 内存/状态缓存分解 | `lib/analyze/memory-decomp.mjs`：`solvePerSlotCost` / `decomposeStateCache` / `attributeLevers` / `solvePerReq` / `decomposeByFormula` | 173 行 |
| GPU 规格实测优先 | `lib/backends/gpuspecs.mjs`：`specFromMeasured` 与 `listGpuSpecs` 并存 | 140 行 |
| 优化空间与过早收尾 | `lib/analyze/optimization-space.mjs`：`prefillInterference` / `tierOptimizationSpace` / **`detectEarlyStop`** | 146 行 |
| 算子类别超额 | `lib/analyze/class-excess.mjs` + `packages/operator/lib`（1,574 行） | — |
| 安全预检 + 可审计回滚 | `lib/sandbox/safety-gate.mjs`：`SAFETY_RULES` / `gateSafety` / `auditableRecovery` / `auditMemoryAccounting` | 335 行 |

**一条重要观察** `[inferred]`：

`measurement-integrity.mjs` 的四道闸与我们在 Phase 1 刚固化的「**门禁不仅要判数值达标，还要判测量成立**」
是**同一个原则的两个独立实例**。区别在于：
- quantization 面对的是"**打分**是否成立"（均匀输出 / 无区分力 / 与输入无关）；
- tuning 面对的是"**性能观测**是否成立"（聚合口径 / 稳态 / 时滞 / 统计检验）。

两者不重复，**应当同时存在于新包里**，并且共用同一条措辞与同一种落点（`validity` 证据块 + 独立纯函数判定）。

---

## 三、与 `inference-serving` / `inference-quantization` 的接口重叠 `[verified]`

### 3.1 已实测的接口契约

| 包 | 接口 | 工具数 |
|---|---|---|
| `inference-serving` | MCP（stdio + streamable-http） | **10**：`deploy` `status` `rollback` `teardown` `list_endpoints` `metrics` `audit_verify` `reconcile` `doctor` `migrate` |
| `inference-quantization` | MCP（stdio + streamable-http） | **11**：`quantize` `get_report` `list` `rollback` `qat_plan` `dataset_prepare` `dataset_verify` `image_verify` `metrics` `audit_verify` `doctor` |
| `dsh-tuning-engine` | 无 MCP；DSH 工具 16 个 + `/__tuner/health` | — |

### 3.2 重叠与冲突

| 能力 | tuning-engine 现状 | serving 提供 | 结论 |
|---|---|---|---|
| **起停推理端点** | **自管 docker**：`lib/engine.mjs` 直接 `docker rm -f <name>` / `docker run -d --name <name> …`（实测命中 240/246/256/297 行） | `deploy` / `teardown` / `rollback` / `reconcile`（带风险确认 + 无残留校验） | ⚠ **所有权冲突**。新包必须改为走 serving MCP —— 否则两套生命周期会互相踩（端口/显存/容器名） |
| 端点指标 | 直读 `VLLM_BASE_URL` / `DCGM_METRICS_URL` | `metrics` / `status` / `doctor` | 部分重叠 → 走 serving |
| 镜像 digest 固定 | `engine-discovery.mjs` 有 sha256 固定逻辑 | serving 有 image 元数据；quantization 有 `image verify` | 可复用现成 |
| **精度前后评估** | **无** | quantization 有 `parityCheck`（容器内直算 NLL/perplexity）但**没有独立 MCP 工具** | ⚠ **缺口**，需要新接口（见 §五 Q4） |
| 配置快照/重放 | `lib/run-spec.mjs`（`captureRunSpec` / `applyParamsToArgv` / `compareRunSpec`） | 无 | 保留（自实现） |

---

## 四、宿主环境与沙箱（行为验证，非存在性检查）`[verified]`

### 4.1 沙箱三级 —— 逐级**跑一次**而不是看二进制在不在

| 级别 | 行为验证命令 | 实测结果 | 判定 |
|---|---|---|---|
| **R1 进程级** | `bwrap --dev-bind / / --chdir / /bin/true` | `bwrap: setting up uid map: Permission denied`；`kernel.apparmor_restrict_unprivileged_userns=1`；`/usr/bin/bwrap` 权限 `-rwxr-xr-x`（**非 setuid**） | ❌ **不可用** |
| **R2 容器级** | `docker run --rm --runtime nvidia --gpus all alpine:3.20 sh -c 'echo container-ok'` | `container-ok`，exit 0 | ✅ **可用** |
| **R3 VM 级** | `qemu-system-{x86_64,aarch64}` / `firecracker` / `cloud-hypervisor` / `virsh` / `kata-runtime` / `runsc` | 六个**全部未安装** | ❌ **不可用** |

**与 `inference-serving` / `inference-quantization` 的 Step 0 结论完全一致**，说明环境未变。

> ⚠ 注意这条曾犯过的错：`inference-serving` 的 Step 0 最初把 R1 判成「✅ 可用」，
> 依据是"二进制存在 + LSM 存在"——那是**存在性检查**，不是行为验证。
> 实际一跑就 `Permission denied`。**本次是跑出来的，不是查出来的。**

### 4.2 与调优直接相关的其它环境事实

| 项 | 值 | 对 tuning 的影响 |
|---|---|---|
| GPU | NVIDIA GB10（Grace Blackwell, aarch64），compute cap 12.1 | 静态规格表不可信，必须 `specFromMeasured` |
| 内存 | 119.6 GiB **统一内存**（`nvidia-smi` memory = `N/A`，`is_integrated=1`） | `memory-decomp` 的分母口径要按统一内存重算 |
| 驱动 / CUDA | 580.126.09 / CUDA 13.0 | — |
| vLLM 端点 | 本机可经 serving 起（`vllm/vllm-openai:nightly`），量化镜像另有独立 toolchain | 性能评测走真实端点（沿用 quantization 的 `perfValidation` 形态） |
| DCGM | `DCGM_METRICS_URL` / `DCGM_METRIC_MAP` 由环境提供（tuning-engine 约定） | 指标名不可硬编码 |

---

## 五、共享库探测 `[verified]`

| 库 | 状态 | 证据 |
|---|---|---|
| `@ai-infra/testing-core` | ❌ **不存在** | ① 工作区无 `node_modules/@ai-infra`；② `npm ls @ai-infra/testing-core` → empty；③ 全盘 `find -name testing-core -path '*ai-infra*'` → 空；④ `registry.npmjs.org` 返回 **000**（不可达），**也不可能拉取** |
| `@ai-infra/{state,audit,sandbox,adaptation}-core` | ❌ 同上 | 同一探测路径 |

**结论**：与 quantization 一致 —— 只能走「包内 `@internal` 最小实现 + 契约版本声明 + 迁移脚本」的过渡路线。
**但这带来一个必须由你裁决的架构问题**（见 §六 Q4）：`parityCheck` 会在 quantization 与 tuning 里**各有一份**。

---

## 六、需要你裁决的四个问题（我不替你决定）

### Q1　现场模式（16 个 `tuner_field_*` 工具）保不保？

`lib/field/*`（约 2,200 行 + 6 个工具）解决的问题是：
**插件无法重启目标服务，所以让 agent 转述命令、用户代跑、结果粘回解析**（`ingest` / `wire` / `pyprobe` / `templates`）。

`inference-tuning` 有 `inference-serving` 的 MCP 管生命周期，**这个前提不存在了**。
我倾向**整体舍弃**（保留 `capability.mjs#detectCapabilities` 的"能力自检"思想，改为 MCP 探测）。
但这会让"客户现场不能给你 shell"的场景失去退路，请你定。

### Q2　Wiki 工具（`tuner_read_from_wiki` / `tuner_publish_to_wiki`）保不保？

它需要 `WIKI_API_TOKEN`，与调优本身无关，属知识沉淀。
我倾向**移出核心**（可作为可选出口或直接舍弃）。

### Q3　分析内核的移植深度？

13 个分析模块合计约 3,000 行，加上 `walls` + `remedies` + `backends` + `observe` 约 2,000 行。
它们是**零依赖、框架无关**的纯逻辑，能力上完全值得保留，但**逐条重新实现**是一笔可观的工作量。
三个选项：

| 选项 | 说明 | 代价 |
|---|---|---|
| **A 最小充分集** | 只移植验收必需的：根因墙 5 堵 + 实测带宽探针 + 干预映射 + 测量完整性四闸 + 目标/不停机 + 精度回归。其余记为 deferred | 中等 |
| **B 全量 13 模块** | 一比一重新实现全部分析内核 | 大（但仍满足"不继承代码"） |
| **C 分层交付** | 先 A 保证本轮验收，再按需补 B 的其余模块 | 分阶段 |

我倾向 **C**（先 A，文档里列出 B 的清单与触发条件）。请你定。

### Q4　精度回归的落点（会决定包间耦合与重复度）

你的要求第 ① 条是"性能上升**且精度不下降**"，所以 tuning 必须能在每个优化前后各做一次任务级精度评估。
可选：

| 方案 | 说明 | 风险 |
|---|---|---|
| (a) tuning 内再实现一份 `@internal` parity | 与 quantization 完全同构、包间零耦合 | **同一契约两份实现**，存在漂移风险 |
| (b) quantization 新增一个独立 MCP 工具（如 `inference_quantization_parity_check`）供 tuning 调用 | 单一实现 | 需要**改已交付的 quantization 包**（你此前要求不得修改） |
| (c) 把 parity 抽成 `@ai-infra/testing-core` | 最干净 | 但该库不存在且 registry 不可达，本机无法交付 |

我倾向 **(a) + 与 quantization 相同的 `@internal` 标注 + 契约一致性校验**（两个包各有一份契约常量，
用一个检查脚本断言两者 `contractVersion` 与返回结构一致）。请你定。

---

## 七、本阶段**未**做的事（如实声明）

- 未修改 `dsh-tuning-engine` 任何文件（`find -newermt` 验证为空）。
- 未创建 `inference-tuning/` 包目录，未写 `package.json`。
- **未运行** `dsh-tuning-engine` 的测试（Step 0 约束"无启动进程"），故 §1.4 只报结构不报通过率。
- 未做任何真机调优实验（Step 0 只读；且新包尚未存在）。
- 未探测 27B 主模型的可调优性（留待写包阶段，且主模型硬排除量化）。

---

## 八、证据边界

**站得住（本机一手实测）**
- 目录/包/依赖/代码量/工具面/分析 op（47 个）/测试文件数/挂载位置与 live 状态。
- serving 10 个、quantization 11 个 MCP 工具的实际 `tools/list` 返回。
- 沙箱三级的行为验证结果；`@ai-infra/*` 三项探测为空 + registry 不可达。
- `lib/engine.mjs` 直接 `docker run/rm` 的具体行号。

**只是合理推断（未验证）**
- `dsh-tuning-engine` 迁移到"走 serving MCP"之后，5 堵墙的分析结论是否与旧的自管 docker 路径一致
  —— **未做对照实验**，这属于写包阶段的自验内容。
- 13 个分析模块"逐条重新实现"的实际工作量估计（未做拆解）。

**原理上不可判（当前无法回答）**
- `@ai-infra/testing-core` 的真实契约形态 —— 库不存在、来源不可达，只能按我们自己的设计走。
- 27B 主模型（`Qwen3.8-27B-NVFP4` 等）的调优空间 —— 需真机实验，Step 0 不做。
