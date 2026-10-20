# DEPLOYMENT_REPORT.md — inference-tuning 交付与真机验收报告

> 生成：2026-09-27　交付物：`inference-tuning/` v0.1.0（零运行时依赖）
> 配套：`ACCEPTANCE_MATRIX.md`（42 条逐条对照）· `docs/step0/*`（前置调研与风险裁决）·
> `docs/parity-contract.md`（精度回归契约）· `NEXT_STEPS.md`
> 真机证据：`demo-out/{console.log,report.json,audit-2026-09-27.jsonl,containers.txt}`

---

## 一、结论先行

| 项 | 结论 |
|---|---|
| 闭环 | ✅ 完整实现并**真机跑通**：源模型预检 → 起端点（经 serving MCP）→ 稳态等待 → 基线双测 → 墙诊断 → TOP1 干预 → 双闭环验证 → 门禁 → **回退** → 反思 → 收尾无残留 |
| 工程 | ✅ **258 测试全通过**、**119 项包自检全通过**、零运行时依赖、四入口、`npm pack` 155,553 字节 |
| 根因墙驱动 | ✅ 真机判出 `rootWall=bandwidth`，上界 **81.45 tok/s**（= **实测**可达带宽 ÷ **实测**每 token 访存） |
| 真机基线 | ✅ decodeTps **63.57**（median, n=8, 相对标准误 **0.16%**）；精度 **ppl 15.2087**（400 条 / 68,058 token） |
| 测量成立性 | ✅ 性能**五闸**（聚合口径/稳态/时滞/统计出处/**仪器自洽**）+ 精度**三闸** 全部通过；仪器信噪比 **19.6** |
| 门禁与回退 | ✅ 真机第 1 轮性能 **−0.14%**、精度 **−0.0041%** → 未达标 → 门禁判 `rollback` → **回退成功**并验证端点健康 |
| 预注册 | ✅ 执行前 189 s 登记（时序检查通过）；判定 `falsified` |
| **性能提升** | ❌ **真机未达成**。报告如实写 `outcome=no-improvement`。见 §五 |
| 端点卫生 | ✅ 收尾后 `docker ps` 无托管残留（`containers.txt` 为空）；但**中间态曾泄漏过一次**，见 §四.2 |

**一句话**：机制是真的、测量是真的、门禁是真的、回退是真的、**没提升也是真的** ——
报告没有把它写成成功。

---

## 二、真机端到端（`runId = tr_8f56efd9cb66`）

命令（脚本会先做环境自检，再逐步打印实际执行的命令与输出）：

```bash
node scripts/e2e-demo.mjs \
  --model /path/to/models/<model> \
  --test-set ~/.ai-infra/state/datasets/Salesforce-wikitext__wikitext-2-raw-v1__train__s20260923__c512/test.jsonl \
  --accuracy-drop 8 --perf-gain 3 --requests 8 --max-rounds 2 \
  --machine-name "NVIDIA GB10" --out ./demo-out
```

| 阶段 | 结果 |
|---|---|
| 环境自检 | 沙箱 进程 ✗ / 容器 ✓ / VM ✗；serving MCP **可达**；审计链 ok |
| 只读墙诊断（起端点前） | `insufficient-observations`，列出 **12 项**待测观测 |
| 确认闸 | 返回 `E_CONFIRMATION_REQUIRED` + 令牌 `cf_d8788c…`（R2，per-class-once）；带令牌重跑 |
| 基线部署 | 经 `inference_serving_deploy`；从**运行中的容器**反查到引擎镜像 `vllm/vllm-openai:nightly` |
| 能力探测 | 引擎 flag 探测 + **实测可达带宽微基准**（容器内 triad/read，一次性 `--rm`） |
| 稳态等待 | 60 s（重启后早期窗口会塌陷，实测过 TTFT_p99 ≈ 10 s） |
| 基线测量 | decodeTps **63.57** / TTFT **51 ms** / throughput **124.95 tok/s**；精度 **ppl 15.2087** |
| 墙诊断 | `verdict=headroom`，`rootWall=bandwidth`（利用率 **78.0%**，上界 **81.45**），推荐干预 `concurrency_capacity` |
| 第 1 轮 | 干预 → 测量 → 门禁 `rollback` → **经 serving rollback 回退** → 验证健康 |
| 收尾 | 拆解 owned 端点，校验无残留（`containers-removed` 检查通过，`containers.txt` 为空） |

### 2.1 基线（真机，全部为实测）

```
decodeTps   median 63.57 tok/s   mean 63.56   std 0.09   n=8   相对标准误 0.1646%
ttftMs      median 51 ms         mean 44.75   n=8
throughput  124.95 tok/s
精度         meanNll 2.721867  →  perplexity 15.2087
             400 条 / 68,058 token；来源 endpoint-logprobs
             成立性检查：uniformGap 9.209（远离 ln(151936)=11.931）
                        itemMeanNllRange 3.305（有方差）
                        constantTokenItems 0     errorCount 0
```

### 2.2 单流天花板与证据链

```
ceiling 81.45 tok/s = 实测可达带宽 ÷ 每 token 访存字节
utilization 78.0%      gap 17.9 tok/s
证据链 6 个节点，每节点带来源（local-microbenchmark / model-file-scan / engine-reported / derived）
sanity.ok = true      （未出现"反推带宽 > 实测可达"这种分母口径错误）
conditionalOn = ['engine']   ← 只有引擎镜像，**没有实现域条件**
```

**主张门禁因此拒绝了它**：`claims.failed = 1`，理由 `no-implementation-scope` ——
引擎镜像是"上下文"，不是"实现域"（kernel 实现 / 状态缓存格式 / 量化精度）。
规则是：**没有实现域限定条件的"上限"不得作为物理上限陈述**。
这一条在真机上如实触发了，不是摆设。

### 2.3 内存分解（结构算对了，输入缺两项）

```
perSlot = 2(K,V) × 28 层 × 2 KV头 × 128 head_dim × 2 字节 = 28672 字节/token   ← 与手算一致
杠杆   = kv_precision（bf16→fp8）可释放 14336 字节/token
usable = false
missing = [budgetBytes（可支配字节上限）, overheadBytes（框架/激活/工作区开销）]
```

**`usable=false` 是正确行为**：这两项需要引擎实报或本机实测，本包**不猜** ——
在统一内存机器上猜错保留比例的代价是 OOM。

### 2.4 第 1 轮：干预、判定、回退、反思

| 项 | 值 |
|---|---|
| 根因墙 / 干预 | `bandwidth` → `concurrency_capacity` |
| 端点 | `sameEndpoint = true`（**同一个端点的新 revision**，见 §四.2） |
| 预注册 | `pr_eb7a40009ee79fce`，登记于执行前 **189 s**（时序检查 `ok`） |
| 假设 | 「bandwidth 是根因墙：通过 concurrency_capacity 可解除它」，要求 **≥3%** |
| 性能 | **−0.138%** |
| 精度 | **−0.0041%**（ppl 15.2087 → 基本不变） |
| 测量成立性 | 性能五闸 + 精度三闸 **全 true**；仪器信噪比 **19.6**（声称 3% vs 噪声 0.153%） |
| 门禁 | `decision = rollback`，`measurementValid = true` |
| 预注册判定 | **`falsified`** —— 方向虽对但幅度未达（实测 −0.14% < 要求 3%） |
| 回退 | 经 `inference_serving_rollback` 回退，回退后端点健康检查**通过** |
| 五因反思 | `wrong-wall`，evidence.kind = **`wall-not-saturated`** |

反思原文（这是本报告里最值得读的一段）：

> 干预时 `bandwidth` 处于 headroom（利用率 78.0%），**没有饱和**。没有任何墙到界时，
> 框架会选"利用率最高"的那堵作为根因墙 —— 对它下手属于**探索性干预**，不是在解除瓶颈；
> 因此"没有明显收益"是符合预期的，**不能据此判该墙不是瓶颈**。

`earlyStop` 同时报了两条 high/medium 级发现：

```
headroom-remains  bandwidth(78%) 仍是 headroom —— 还有空间
unknown-walls     4 堵墙因缺观测不可判定（speculative, compute, memory, schedule）。
                  "未测"不等于"没空间" —— 收尾前应补齐观测，或显式声明该墙的结论不适用
```

---

## 三、审计与留证

```
审计文件：~/.ai-infra/logs/audit/inference-tuning/2026-09-27.jsonl（副本：demo-out/audit-2026-09-27.jsonl）
链复算：ok，3 条记录，每条 prevHash 指向上一条的 hash
最后一条：
  {"capability":"tune","action":"tune","phase":"end","runId":"tr_8f56efd9cb66",
   "model":"/path/to/models/<model>","outcome":"no-improvement",
   "rounds":1,"acceptedRounds":0,"rootWall":"bandwidth","confirmed":true,
   "rollbackFailed":false,"reportPath":"..."}

收尾检查：containers.txt = {"serving":0,"quantization":0,"managedNames":[],"total":0}
```

**"必须叫人"通道真机触发过一次**（`~/.ai-infra/state/MUST_NOTIFY.json`，
`code=E_ROLLBACK_FAILED, severity=critical`）—— 那是 §四.2 那条设计缺陷导致的，
修复后未再复现。**该文件与那条审计记录按设计保留**，作为"通道确实能响"的证据。

---

## 四、真机暴露的缺陷（本节最有信息量）

单测与离线集成测试跑不到这些。**三次真机运行，暴露了五个缺陷**，前三个是设计级的。

### 4.1 `execFile(..., { signal: null })` 直接崩

```
ERR_INVALID_ARG_TYPE: The "options.signal" property must be an instance of AbortSignal. Received null
```

**为什么单测抓不到**：假执行器根本不调 `run()`。
**修法**：只有在 `signal` 真的是 AbortSignal 时才放进 `execFile` 的 options。
**回归**：`tests/unit/executor-docker.test.mjs`（真跑 docker）。

### 4.2 部署后的富化抛异常 → **端点失去所有权 → 容器泄漏**

`deploy()` 内部：serving 已经建好容器 → 再做 `docker inspect` 反查镜像 → **抛了**。
调用方拿不到 `id` → 这个端点不在 `ownedEndpoints` 里 → 收尾时不会拆它。
真机实测：一个跑着 vLLM 的容器**留存 7 分钟**。

**修法**：部署成功之后的**一切**富化必须吞掉自己的异常，并保证 `id` 无论如何都返回。
**教训**：*"资源已创建"与"我方已登记所有权"之间的任何一步都不能抛* ——
否则就是"系统里有一个没人认领的资源"。

### 4.3 **serving 按模型给端点做键** —— 我"两个端点"的模型是错的

serving `deploy.mjs:206` 原话：

> 同模型但配置指纹变化，将作为新 revision 重新部署

即：同模型换参数是**同一个端点的新 revision**，不是两个端点。

我第一版按"两个独立端点"设计：
- 基线部署 → 端点 A
- 候选部署 → **还是端点 A**（新 revision，基线容器已被取代）
- 拒绝时"丢掉候选、留下原来的" → 把**同一个端点**拆了 → "原端点不健康" → `E_ROLLBACK_FAILED`

**这是设计错了，不是实现错了。** 修法是改用 serving 的版本语义：
全程只拥有**一个**端点；回退走 `inference_serving_rollback`（它会按目标 revision 的配置重新部署）。

**连带的一条教训**：我的假执行器当初就是按"两个端点"写的，于是它**顺着错误假设一起错**，
测试全绿。所以"夹具必须真实"要再加一句：**夹具要模拟的是对方的语义模型，不只是返回值**。

### 4.4 假执行器没关掉被取代的 revision 服务 → 测试文件级 promise 悬挂

修完 4.3 后出现 `Promise resolution is still pending but the event loop has already resolved`：
accept 路径下我删掉了"拆旧端点"，但夹具没有模拟"部署会取代旧容器"，
旧的 HTTP server 一直挂着拖住事件循环。
**修法**：夹具的 `deploy` 关掉当前 revision 的服务（与 serving 行为一致）。

### 4.5 预检缓存键不含**校验器版本** → 逻辑升级后静默返回过期结果

我扩了源模型预检采集的字段（补 KV 结构），但缓存只按 `(路径, size, mtime)` 命中，
于是真机复用旧记录 → 下游拿不到新字段却看不出为什么（`memory` 一直缺 kvHeads/headDim）。

**修法**：缓存键加入 `VALIDATOR_VERSION`（升级即失效，不靠人去清缓存）。
**教训**：*缓存键要覆盖产出内容的**全部**决定因素 —— 输入**和**产生它的逻辑版本。*

---

## 五、真机为什么没有提升（如实交代）

`concurrency_capacity` 从默认 32 提到 48，decodeTps **−0.14%**（在噪声 0.15% 量级内，即基本不变）。

**这不是"调优失败"的证据，而是"这次干预选错了"的证据**，而选错的原因已经由框架自己说清楚了：

1. **没有任何一堵墙到界**。带宽利用率 78%（headroom），而 speculative / compute / memory / schedule
   四堵墙因**缺观测从未判定**。框架在没有饱和墙时只能选"利用率最高"的那堵，这属于探索。
2. **要真正定位瓶颈，必须先补齐那四堵墙的观测**（见 `NEXT_STEPS.md` §3.1）：
   - `gpuBusyPct`（调度墙）→ 需要 DCGM
   - `kvPoolTokens` / `kvTokensPerRequest`（容量墙）→ 需要引擎 `/metrics` 的 KV 块统计
   - `acceptLength` / `draftTokens`（投机墙）→ 需要带 draft model 的端点
   - `measuredPeakFlops` / `kernelMs`（算力墙）→ 需要算力微基准与 kernel 计时

**在补齐之前，任何"该模型已到硬件上限"的结论都是不允许下的** ——
`limitingConditions` 只有引擎版本与上界口径，**没有实现域条件**，
框架因此拒绝判 `physical-limit`，改为 `yield-resumable`（可续跑）。

---

## 六、复现方式

```bash
cd inference-tuning

npm test              # 258 用例（不需要 GPU；沙箱与执行器那两组会真跑 docker）
npm run check         # 119 项包规范自检（含"不占用 tuner_* / /__tuner/"的上线前必查项）
npm run test:contract # CI 级契约一致性（需要相邻的 inference-quantization checkout）

node bin/inference-tuning.mjs health --json       # 沙箱/serving/审计链/必叫事件
node bin/inference-tuning.mjs analyze --json      # 只读墙诊断（零风险，不跑实验）
node bin/inference-tuning.mjs capabilities        # 能力清单与"明确不做"的事
node bin/inference-tuning.mjs contract            # 精度回归契约声明

# 真机端到端（需 GPU + Docker + serving，约 8–9 分钟）
node scripts/e2e-demo.mjs --model <完整模型目录> \
  --test-set <jsonl> --accuracy-drop 8 --perf-gain 3 --out ./demo-out
```

**硬约束的验证命令**（`dsh-tuning-engine` 零改动 / 不占用命名空间）：

```bash
find ../dsh-tuning-engine -newermt '<本次开始时间>' -type f        # → 空
node -e "…mcp tools/list…" | grep -c 'inference_tuning_'           # → 7
node -e "…mcp tools/list…" | grep -c '\"tuner_'                    # → 0
```

---

## 七、证据边界

**站得住（本机一手实测）**
- 258 用例、119 项自检、`npm pack` 产物；沙箱三级行为验证；serving MCP 可达。
- 真机基线：decodeTps 63.57（n=8，相对标准误 0.16%）、ppl 15.2087（400 条 / 68,058 token）、
  单流天花板 81.45 tok/s（实测带宽 ÷ 实测访存）、利用率 78.0%。
- 真机第 1 轮：性能 −0.14%、精度 −0.0041%、测量成立性双侧全过、仪器信噪比 19.6、
  门禁 `rollback`、serving 回退成功、五因反思给出 `wall-not-saturated`。
- 审计链 3 条复算通过；收尾零残留；`MUST_NOTIFY` 通道真机触发过一次。

**只是合理推断（未验证）**
- 真机上 `accept` 路径与 `physical-limit` 停止**从未跑出**（前者靠离线覆盖，后者条件苛刻）。
- 该模型是否存在**可实现的**性能空间：**未知**。真机只证明了"提高并发无用"，
  而 4 堵墙从未判定。`earlyStop` 已把它标为 high 级发现。
- 27B 主模型的调优空间：未测（且按硬约束不做量化格式变更）。

**原理上不可判（当前无法回答）**
- 引擎镜像未固定到 digest（serving 按 tag 部署）⇒ `runSpec.replayable=false`。
  **在"不修改 serving"的约束下无法解决** —— 已如实记入报告而非绕过。
- 若本机 `qwen3-embedding`（另一个长期在跑的服务）在演示期间抢占统一内存，
  对测量有多大影响：未做对照实验。演示期间该服务保持运行，`decodeTps` 的
  相对标准误只有 0.16%，说明本轮测量本身是稳的。

**已声明但未做（不冒充完成）**
- DSH 内**真实挂载**未验证（只做了契约层 `apply(ctx)` 断言）。
- 算子级改动（R3）本轮不纳入（本机 VM 沙箱不可用）。
- `@ai-infra/testing-core` 落地后两份实现同时替换（迁移脚本已备好，未执行）。
