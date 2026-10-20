# @xiciyang/inference-tuning

给模型 + 性能目标 + 精度容忍，**找到根因墙、匹配 TOP1 干预、双闭环验证** ——
通过则输出可复用的优化配置，失败则自动回退。

```
模型 + 性能目标 + 精度容忍
  → 源模型结构预检（是完整模型吗）
  → 经 inference-serving 起基线端点 → 稳态等待 → 基线测量（性能 + 精度）
  → 根因墙诊断（不是搜参数）
  → 每轮：预注册 → 提案候选配置 → 起候选端点 → 双闭环测量
          → 测量成立性（性能四闸 + 精度三闸）→ 门禁判定
          → 接受（固化）/ 回退（丢弃候选并验证原端点仍健康）
          → 干预无效 → **五因反思**（不直接换参数）
  → 不停机判据（达标与预算耗尽都**不**构成停止理由）
  → 收尾：拆解全部自有端点（验证无残留）+ 注册表 + 报告 + 审计哈希链
```

## 设计要点

- **零运行时依赖**（只用 Node 内建模块）
- **根因墙驱动，不是盲搜参数空间**：`docs/step0/MIGRATION_PLAN.md` §三
- **分子与分母必须来自本机实测**：带宽用实测微基准；"每 token 访存字节"由**模型文件实际字节数**得出；
  任何 `spec-sheet` / `theoretical-peak` provenance 会被**硬拒绝**
- **每堵墙都能自我否证**：反推量 > 实测可达 ⇒ 判**分母口径有误**，而不是"硬件到顶"
- **单流天花板带证据链**：从实测带宽到上限的每一步都标来源，可被独立复核；**必须带实现域限定条件**才算"上限"
- **内存分解不拿系数凑**：KV/状态缓存按公式算，缺项一律 `null + 缺什么`；每个扩容杠杆给出**具体释放多少字节**
- **主张门禁**：报告里每条承重陈述都要带出处等级（实测/推导/推断/假设），规格书峰值是**禁用项**，
  把推断写成结论口吻会被**升格检测**拦下
- **预注册与判定**：干预**执行之前**登记假设与否证条件，执行后只判 confirmed / falsified / inconclusive；
  事后补写的"预注册"会被时序检查抓出来
- **仪器自洽**：声称的最小效应若**小于测量噪声**，该仪器原理上看不见它 ——
  这属于"测量不成立"，不是"没有效应"
- **门禁独立**：阈值必须由调用方传入或写进 `gates.yaml`，**两者都无则拒绝执行**
- **测量成立性双重门禁**：性能四闸（聚合口径 / 稳态 / 时滞 / 统计出处）+ 精度三闸（均匀输出 / 无区分力 / 与输入无关）
- **端点生命周期交给 serving**：本包一行 docker 生命周期命令都不发，只经 MCP 请求 serving
- **只动自己的端点**：存量端点一律只读；回退 = 丢弃候选 + 验证原端点仍健康
- **回滚失败是独立风险档**：写 `MUST_NOTIFY.json` + 审计 + stderr + 可选 webhook

## 安装

```bash
git clone https://github.com/xiciyang/inference-tuning.git
cd inference-tuning && npm pack
dsh plugin --profile <name> add ./xiciyang-inference-tuning-0.1.0.tgz
```

> 尚未发布到 npm（`npm install -g` 暂不可用）；用上面的源码打包路径安装。

作为 **DSH 插件**：`dsh plugin --profile web add <tgz>`，重启后生效。

**依赖**：`inference-serving`（端点生命周期，通过 **MCP**）。定位顺序：
`options.servingPath` → `~/.ai-infra/config/serving-path.txt` → 同级目录 `../inference-serving` → `node_modules/`。

> **命名空间**：工具一律 `inference_tuning_*`，路由 `/__inference_tuning/health`。
> `dsh-tuning-engine`（`tuner_*` / `/__tuner/`）当前仍可能挂着，两者可共存不冲突。

## 快速上手

```bash
inference-tuning health --json            # 沙箱三级实测 / serving 可达性 / 审计链 / 必叫事件
inference-tuning analyze --json           # 【只读】墙诊断（零风险，不跑实验）
inference-tuning capabilities             # 能力清单与"明确不做"的事
inference-tuning contract                 # 精度回归契约声明

inference-tuning tune /path/to/models/<model> \
    --max-accuracy-drop-pct 5 --min-perf-gain-pct 20 \
    --test-set ~/.ai-infra/state/datasets/.../test.jsonl \
    --params '{"concurrency_capacity":32}'

inference-tuning list --json              # 调优注册表（五要素完整性）
inference-tuning report <runId> --json    # 完整报告（含墙诊断/每轮证据/反思）
inference-tuning audit-verify --json      # 复算审计哈希链
```

## MCP 工具（7 个）

| 工具 | 档 | 说明 |
|---|---|---|
| `inference_tuning_analyze` | R0 | 只读墙诊断 |
| `inference_tuning_tune` | R2 | 主闭环 |
| `inference_tuning_validate` | R2 | 对一组已有配置做闭环测量 |
| `inference_tuning_rollback` | R2 | 回退到上一个已接受配置 |
| `inference_tuning_get_report` | R0 | 读报告 |
| `inference_tuning_list` | R0 | 列注册表 |
| `inference_tuning_health` | R0 | 健康检查 |

## 精度回归契约

精度回归由**两份独立实现**（本包 `endpoint-logprobs`、quantization `container-forward`）互相校验，
契约放在 `docs/parity-contract.md`（**单一事实来源**），由 `tests/contract/parity-consistency.test.mjs`
做三方一致性断言（契约文件 ⇄ 本包 ⇄ 兄弟包）。不一致 → 测试红 → 不允许发布。

## 配置

| 输入 | 说明 |
|---|---|
| `--engine <id>` / `options.engineId` | **必填**（无默认）。本包不内置任何引擎的默认值；新引擎通过 `PARAM_CATALOG` 的 `flags.<engine>` 扩展 |
| `--engine-image` | 引擎镜像（固定到 digest 才算可重放） |
| `--max-accuracy-drop-pct` / `--min-perf-gain-pct` | 门禁阈值；必须显式给，或写进 `gates.yaml`，两者都无则拒绝执行 |
| `--params` | 语义参数（不是引擎 flag）；映射成命令行时才使用所选引擎的 flag 表 |
| `--test-set` | 精度对比用的固定评测集 |
| `params.servingPath` / `~/.ai-infra/config/serving-path.txt` | 定位 `inference-serving`（端点生命周期全部经 MCP，本包不发 docker 命令） |

## 兼容与解耦

- **Node ≥ 20**，Linux/macOS，零运行时依赖（只用 Node 内建模块）。
- **不绑定引擎**：未指定引擎时 `buildLaunchArgs` 抛 `E_ENGINE_NOT_SPECIFIED`，绝不回落到某个厂商的 flag 表；
  未登记的引擎 → 参数全部跳过并记账（`skipped` 带原因），不会借用别的引擎的 flag。
- **不绑定硬件**：静态规格表**只用于提示该测什么**，`usable: false` 时禁止进入任何天花板分母；
  未登记的硬件 → 无规格、无提示，只能靠本机微基准产出实测值。统一内存与独立显存分开建模。
- **不绑定 serving 实现**：只经 MCP 契约调用，路径可配置。
- 已在 DSH **0.2.0-rc.2** 上验证；`npm test` 为本包自有套件（250 项），
  跨仓契约套件单独跑：`npm run test:contract`（需要 `inference-contracts` 与兄弟包）。

## 许可

BSD-3-Clause。见 `LICENSE`。

## 明确不做

量化（找 `inference-quantization`）、通用部署（找 `inference-serving`）、
改变主模型既有量化格式（**硬排除**）、算子级改动（本轮不纳入）、
现场模式、Wiki、训练/QAT、推理编排。详见 `inference-tuning capabilities`。
