# `dsh-tuning-engine` × `inference-tuning` 能力对照表

> 用途：用户裁决"先不下架 `dsh-tuning-engine`，先做能力对照表"的交付物。
> 方法：**机械化比对**，不是印象 —— 取 `dsh-tuning-engine` 暴露的全部工具与 `analyze` op，
> 逐个到 `inference-tuning/src/` 里找同名导出；同名找不到的，再做一轮概念级检索确认是不是改了个名字。
> 生成时间：2026-09-28。两侧版本：`dsh-tuning-engine`（观察期内，未改动）/ `inference-tuning` 0.1.0。

---

## 0. 结论先说

| 面 | `dsh-tuning-engine` | `inference-tuning` | 判定 |
|---|---:|---:|---|
| 工具数 | **16** | **12** | 数量接近，但**映射不是一一对应** |
| `analyze` 的 op 面 | **46** 个具名 op | **0**（只有 `analyze(observations, wall)`）| **这一层差距最大** |

**一句话**：`inference-tuning` 把**算法**搬过来了（46 个 op 里 27 个能在源码里找到同名实现），
但**没有把 op 面的入口搬过来** —— 于是那 27 个能力在 `inference-tuning` 里
**不可从工具面到达**（只能被内部流程调用）。

这直接决定了下架判断：**现在下架会同时丢掉两类东西**（见 §3）。

---

## 1. 工具级对照（16 → 12）

| # | `dsh-tuning-engine` | `inference-tuning` 对应 | 判定 |
|---|---|---|---|
| 1 | `tuner_run_loop` | `inference_tuning_tune` | ✅ 有后继（真机跑通）|
| 2 | `tuner_run_trial` | `inference_tuning_validate` | ✅ 有后继（真机跑通）|
| 3 | `tuner_analyze`（46 op）| `inference_tuning_analyze`（无 op）| ⚠️ **部分**：墙诊断有；op 面没有 |
| 4 | `tuner_diagnose_bottleneck` | `inference_tuning_analyze` | ✅ 能力有，**无独立工具入口** |
| 5 | `tuner_diagnose_root_cause` | `inference_tuning_analyze` | ✅ 能力有，**无独立工具入口** |
| 6 | `tuner_confirm_wall` | 无独立入口（`walls/remedies.mjs` 有 `falsify` 语义）| ⚠️ 部分 |
| 7 | `tuner_check_resource_gate` | 无独立入口 | ❌ **无后继** |
| 8 | `tuner_profile_operators` | **无** | ❌ **无后继**（见 §2 注）|
| 9 | `tuner_read_from_wiki` | — | 🚫 主动舍弃（Step 0 裁决 Q2）|
| 10 | `tuner_publish_to_wiki` | — | 🚫 主动舍弃（Q2）|
| 11-16 | `tuner_field_*` ×7（实际 7 个）| — | 🚫 主动舍弃（Q1，整体舍弃）|

> 说明：`tuner_field_*` 共 7 个（`plan` / `ingest` / `next` / `status` / `export` / `capabilities` + 1），
> 与 `publish_to_wiki`/`read_from_wiki` 一样是**用户主动裁决舍弃**的，不算能力损失。

**新增（`inference-tuning` 有、`dsh-tuning-engine` 没有）**：
`audit_verify` · `contract` · `get_report` · `list` · `health` · `metrics` · `install_skills`
—— 7 个，都属于"可运维 / 可追溯"面。

---

## 2. `analyze` 的 op 级对照（46 → 27 同名 + 1 族名，18 缺）

机械化结果（`export function|const <同名>` 检索 `inference-tuning/src/**`）：

| 分类 | 数量 | 说明 |
|---|---:|---|
| 源码里有**同名**导出 | **27** | 算法确实搬过来了 |
| 族名可对上 | 1 | `prereg.register`（本包为 `preregister`）|
| **同名找不到** | **18** | 逐个复核见下 |

18 个"同名找不到"里，逐条复核后：

| op | 复核结论 |
|---|---|
| `sandbox.listSafetyRules`、`sandbox.safetyPreflight` | ✅ **能力有后继**（改名）：`sandbox.mjs` 的 `probeSandbox` / `tierSatisfied` / `assertSandbox` |
| `backends.listEngines` / `listControllers` / `listProbes` / `getEngineAdapter` / `normalizeEngineId` / `listGpuSpecs` | ⚠️ **部分**：`platform/gpuspec.mjs` 与 `registry.mjs` 覆盖了 GPU 规格与参数目录，但没有"引擎/控制器/探针注册表"的**枚举面** |
| `gates.gatePlan`、`gates.listGates` | ❌ 无（`src/` 内检索 `gatePlan` / `listGates` 无命中）|
| `sla.goodputAnalysis`、`sla.judgeTier`、`sla.tierFeasibility` | ❌ 无（`SLA` / `tierFeasibility` 无命中；`goodput` 仅作为词出现在 `validity/performance.mjs`，不是一套 goodput 判定）|
| `space.prefillInterference`、`space.tierOptimizationSpace` | ❌ 无（`tierOptimizationSpace` 无命中；`prefillInterference` 只作为**观测名**出现在 `walls/remedies.mjs`，不是分析 op）|
| `headroom.gateMemoryHeadroom` | ❌ 无同名闸门（`headroom` 概念在 `loop/early-stop.mjs`、`loop/objective.mjs` 中被使用，但没有"内存余量闸门"这个独立判定）|
| `objective.gateBottleneck` | ❌ 无（`objective.mjs` 有 `decideRunOutcome` / `assessTargets`，但没有"瓶颈闸门"）|
| `env.discoverEnvironment` | ❌ 无 |

**净结果**：`dsh-tuning-engine` 的 46 个 op 里，约 **9–11 个在 `inference-tuning` 里没有对应实现**
（SLA 三件、gates 两件、space 两件、memory headroom 闸、bottleneck 闸、环境发现），
2 个改名为不同 API，6 个 backends 枚举部分覆盖。

> **注（重要）**：`tuner_profile_operators` 是**整工具**级别的缺口 ——
> 在 `inference-tuning/src/` 里检索 `sglang_layers` / `torch_trace` / `profileOperators` **均无命中**，
> 且它**没有**出现在 `inference-tuning/manifest.yaml` 的 `not_provided` 里
> （那里只声明了 `operator_patch`，那是**改**算子，与**测**算子不是一回事）。
> 也就是说：这一项是"**静默丢失**"，不是"已声明不做"。

---

## 3. 对下架的判定：**现在不下架**

原定判据是"三插件集成测试通过后再下架"。集成测试确实通过了 ——
但那条判据**不足以支持这个结论**，理由是上面两张表里的硬事实：

1. **替代者从未在 DSH 内运行过**
   三个新包都不在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里
   （集成测试 S5-12 实测）。`dsh-tuning-engine` 是**唯一**在线的调优插件。
   直接下架 = DSH 侧立刻没有调优能力。

2. **op 面缺口是"静默"的**
   46 → 27 同名，另有约 9–11 个能力在 `inference-tuning` 里不存在，且**没有写进 `not_provided`**。
   下架时不会有任何提示，是静默丢失。

3. **`tuner_profile_operators` 无后继且未声明**
   见 §2 注。

**建议顺序**（与原裁决一致，只是把"确认归属"落到具体项）：

1. 把 `inference-tuning` 挂进 DSH profile 并**实跑一次**（当前唯一完全未验证的交付形态）。
2. 对上面 9–11 个缺失 op + `profile_operators` **逐项裁决**：
   - 补进 `inference-tuning`（并暴露 op 面），或
   - 明确写进 `manifest.yaml` 的 `not_provided`（"主动不做"与"忘了做"必须能区分）
3. 裁决完成后再决定下架时机。

---

## 4. 复现方式

```bash
# 工具面
grep -rhoE "name: ['\"]tuner_[a-z_]+['\"]" dsh-tuning-engine --include=*.mjs | grep -v node_modules | sort -u
grep -rhoE "name: 'inference_tuning_[a-z_]+'" inference-tuning/src/index.mjs | sort -u

# op 面（46 个）
grep -oE "'[a-z]+\.[a-zA-Z]+'" dsh-tuning-engine/lib/analyze/index.mjs | sort -u

# 逐个到本包找同名导出
node /tmp/capmap.mjs      # 生成脚本见本节说明；结论：27 exact / 1 family / 18 missing

# 逐个确认"缺失"不是改名
cd inference-tuning
for kw in goodput tierFeasibility listGates gatePlan prefillInterference tierOptimizationSpace; do
  printf "%-22s " "$kw"; grep -rli "$kw" src/ | tr '\n' ' '; echo
done
```
