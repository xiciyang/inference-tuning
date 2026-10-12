# parity-contract.md — 精度回归的**单一事实来源**

> 状态：**已冻结**
> `contractVersion = 1.0.0`
> 本文件是精度回归契约的**唯一权威定义**。所有实现与检查都以本文件为准；
> 实现与本文件不一致时，**改实现，不改本文件**（除非走下面的版本升级流程）。

---

## 0. 为什么需要这份文件

`inference-quantization` 与 `inference-tuning` **各自持有一份精度回归实现**，原因见 §5。
两份实现意味着漂移风险，所以：

> **契约放在文件里，不放在某一份实现里。** 两份实现都是本文件的从属物。

一致性由 **CI 级检查**保证（不是运行时告警）：`tests/contract/parity-consistency.test.mjs`
会在 `npm test` 时读本文件、读两份实现、逐项断言一致。

---

## 1. 契约版本与不变量

```yaml
contractVersion: "1.0.0"
invariants:
  - 结果对象必须含且仅含下列顶层键（允许额外键，但不允许缺失）
  - 两侧测量必须都能给出 validity 证据块
  - 判定（是否成立 / 是否达标）与测量（数值）必须分离
```

### 1.1 顶层结果结构

| 键 | 类型 | 说明 |
|---|---|---|
| `ok` | boolean | 测量本身是否成功产出（**不代表测量成立**） |
| `metric` | string | 固定为 `"mean-nll-and-perplexity"` |
| `before` | object | 调优/量化**前**的测量侧 |
| `after` | object | 调优/量化**后**的测量侧 |
| `drop` | object | `{ pct, nllDelta }` |
| `validity` | object | `{ before, after }`，各自是 §3 的成立性证据块 |
| `evidence` | object | 见 §4 |

### 1.2 测量侧结构（`before` / `after` 同构）

| 键 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `meanNll` | number | ✅ | **按 token 加权**的平均负对数似然 |
| `perplexity` | number | ✅ | `exp(min(meanNll, 50))` |
| `vocabSize` | number\|null | ✅ | 词表大小；null 表示未取到（则不做均匀签名判定，**不猜**） |
| `scoredSamples` | number | ✅ | 成功评分的样本数 |
| `tokens` | number | ✅ | 总 token 数 |
| `itemMeanNlls` | number[] | ✅ | 逐条 `meanNll`，用于极差判定 |
| `validity` | object\|null | ✅ | 测量端的自报证据（见 §3.1） |
| `source` | string | ✅ | `"endpoint-logprobs"` \| `"container-forward"` \| `"internal-test"` |

### 1.3 `drop`

```
drop.pct      = (after.perplexity - before.perplexity) / before.perplexity * 100
drop.nllDelta = after.meanNll - before.meanNll
```

口径固定为**相对困惑度退化**（更直观、与人感知一致）；同时给出 NLL 绝对差
以便排查"两边都很好但差一点"的情形。

---

## 2. 测量口径

### 2.1 指标

- **meanNll**：`-Σ log p(token_i) / N`，**按 token 加权**。
  按样本平均会让长文本被短文本淹没，因此不允许。
- **perplexity**：`exp(meanNll)`，并以 `min(meanNll, 50)` 封顶防止溢出。

### 2.2 两个**允许**的测量来源

| `source` | 取数方式 | 用于 |
|---|---|---|
| `endpoint-logprobs` | 向**已服务端点**请求 prompt logprobs，在客户端按 token 加权聚合 | inference-tuning（它调的就是这个端点的配置） |
| `container-forward` | 在容器内加载权重做前向，取 `model(ids, labels=ids).loss` | inference-quantization（它调的是磁盘上的权重） |

**两者必须产出同一个结构**（§1.2），且都必须过 §3 的成立性判定。
来源不同**不影响契约**：契约约束的是"结果长什么样 + 怎么判成立"，不是"从哪取数"。

> 为什么 tuning 不需要容器：它要评估的是**当前被服务的那个配置**。
> 走端点拿 logprobs 测的正是这个东西；另起容器加载权重测的反而可能是另一份配置。

---

## 3. **测量成立性**（三闸）—— 本契约的硬核心

两侧各判一次；**任一条成立即判"测量不成立"**。

### 3.1 测量端自报块（`validity`）

```yaml
validity:
  valid: boolean
  reasons:
    - code: string          # 见 §3.2 的取值
      detail: string
  uniformTol: number        # 默认 1e-4
  checks: object            # 至少含 uniformLoss / uniformGap / itemMeanNllRange
```

### 3.2 三闸（判定端实现，**不得只依赖自报**）

| # | code | 判据 | 为什么是这个判据 |
|---|---|---|---|
| ① | `uniform-output` | `\|meanNll − ln(vocabSize)\| ≤ 1e-4` | 均匀分布的困惑度**在数学上恒等于词表大小**：这是可推导的等式，不是经验魔数 |
| ② | `indiscriminate` | 两侧 `meanNll` **逐位相同** | 两个不同配置给出同一个数 ⇒ 这个数不依赖被改的东西 |
| ③ | `no-item-variance` | 逐条 `meanNll` 的**极差 = 0** | 与输入无关的数不构成一次测量。用极差而非标准差：标准差要先求和再相除，"全相同"会算出 ~1e-15，逼你引入容差魔数 |

补充闸（来自测量端自报，判定端**原样上抛**，不覆盖）：

| code | 判据 |
|---|---|
| `zero-weight-tensors` | 存在整块为零的大张量（权重没真的加载进来） |
| `non-finite-weights` | 存在 NaN/Inf 张量 |
| `constant-logits` | logits 在词表维度上的标准差为 0 |
| `constant-argmax` | 整条序列的 argmax 只有 ≤1 个取值 |
| `constant-token-logprobs` | **某条样本内所有 token 的 logprob 逐位相同** —— 均匀分布在 token 粒度上的签名。比 `no-item-variance` 更细：逐条均值可能因 prompt 不同而仍有差异，这条会先把退化暴露出来 |
| `no-scored-samples` | `scoredSamples = 0` |
| `missing-side` | 某一侧没有结果 |

### 3.3 判定与测量必须分离

- **测量端**（`container-forward` 脚本 / `endpoint-logprobs` 采集器）只**报事实**：
  `ok` 仍为 `true`，数值照给，另附 `validity` 块。
- **判定端**（`assertAccuracyMeasurementValid` / `assertMeasurementValid`）是**纯函数**，
  输入是两侧结果，输出是 `{valid, reasons, checks}`。

这样测量端可以被独立复核，判定端可以被穷举测试。

---

## 4. `evidence`

至少含：

| 键 | 类型 | 说明 |
|---|---|---|
| `testSetPath` | string | 评测集路径 |
| `testSetDigest` | string | 评测集内容 sha256（**必须**，否则"前后测的是不是同一份数据"无法回答） |
| `contractVersion` | string | `"1.0.0"` |
| `implementation` | string | 实现标识（含 `@internal` 标记） |
| `source` | string | 见 §1.2 |
| `durationMs` | number | 耗时 |

---

## 5. 为什么是两份实现（而不是一份）

理想形态是一份共享库 `@ai-infra/testing-core`。**它不存在**：

```
[verified] 2026-09-27
  ① 工作区无 node_modules/@ai-infra
  ② npm ls @ai-infra/testing-core → empty
  ③ 全盘 find -name testing-core -path '*ai-infra*' → 空
  ④ registry.npmjs.org → HTTP 000（不可达），也拉不到
```

因此两个包各持一份 `@internal` 实现，并用 §6 的 CI 检查防止漂移。

---

## 6. 迁移路径（`@ai-infra/testing-core` 可用后）

**两份实现同时替换**，本文件继续作为契约来源：

1. 发布 `@ai-infra/testing-core`，其导出与本文件 §1 §3 §4 逐项对应；
2. 两个包的 `src/testing/parity.mjs` 改为 re-export 真库（调用方零改动）；
3. 删除各自的 `@internal` 实现与 `W_INTERNAL_SHARED_LIB` 警告；
4. `tests/contract/parity-consistency.test.mjs` 改为"实现 vs 真库 vs 本文件"三方一致；
5. `contractVersion` 升到真库声明的主版本。

迁移脚本：`scripts/migrate-to-testing-core.mjs`（两个包各一份，语义一致）。

---

## 7. 版本升级流程

- **兼容变更**（新增可选键）：`1.0.0 → 1.1.0`，两份实现同步升，CI 检查通过即可。
- **破坏性变更**（改键名/改判据/改口径）：`1.x → 2.0.0`，需**同时**改：
  本文件、两份实现、两个包的 MCP major 版本、以及两包的 ACCEPTANCE_MATRIX。
- 任何情况下，**先改本文件，再改实现**。实现先行视为漂移。
