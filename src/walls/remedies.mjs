/**
 * 世界经验干预映射 —— 墙 → TOP1 干预。
 *
 * 两条设计约束：
 *
 * ① **用语义杠杆名，不用引擎 flag**
 *    `draft_budget` 而不是 `--speculative-num-draft-tokens`。
 *    换引擎/换版本都不改本文件；具体 flag 由 `src/registry.mjs` 的引擎适配器映射。
 *
 * ② **每条干预都必须写明"预期哪个指标动、动多少、以及什么情况下它不会生效"**
 *    没有预期的干预不是干预，是乱试。`expected` 与 `falsify` 是必填项。
 *
 * 内容来自公开的推理系统经验（continuous batching / speculative decoding / KV 管理 /
 * chunked prefill / CUDA graph 的常见收益区间），**不是**本机实测数字 ——
 * 所以它们只用于"选哪一个 TOP1"，实际收益一律由本机闭环测量判定。
 */

export const LEVER_SEMANTICS = Object.freeze({
  concurrency_capacity: {
    title: '并发容量',
    description: '同时服务的请求数上限。提高它让权重读取被更多 token 摊薄（decode 阶段收益主来源）',
    direction: 'increase',
    affects: ['measurements.runningRequests', 'measurements.singleStreamTps', 'measurements.decodeTps'],
    precondition: 'KV 容量未吃满、且尚未达到调度/算力墙',
  },
  kv_pool_size: {
    title: 'KV 池规模',
    description: '留给 KV 缓存的显存比例。扩大它以支撑更高并发',
    direction: 'increase',
    affects: ['limits.kvPoolTokens', 'measurements.runningRequests'],
    precondition: '显存有余量；否则会挤压权重导致 OOM',
  },
  seq_budget: {
    title: '单序列长度预算',
    description: '单请求可用的最大上下文。降低它提高并发上限但会截断长请求',
    direction: 'decrease',
    affects: ['model.kvTokensPerRequest', 'limits.kvPoolTokens'],
    precondition: '业务负载的实际上下文远小于配置上限',
  },
  prefill_chunk: {
    title: '预填充分块',
    description: '把长 prefill 切块以降低单次显存峰值、改善与 decode 的交错',
    direction: 'increase',
    affects: ['measurements.gpuBusyPct', 'measurements.ttftMs', 'measurements.prefillInterferenceMs'],
    precondition: '负载含长 prompt；纯短 prompt 负载上无效',
  },
  draft_budget: {
    title: '投机草稿预算',
    description: '每步提出的草稿 token 数。加大它是否有效取决于**边际接受率**',
    direction: 'increase',
    affects: ['measurements.acceptLength', 'measurements.singleStreamTps'],
    precondition: '边际接受率仍为正：(accept−1)/draftTokens 随预算上升而上升或持平',
  },
  batch_step_count: {
    title: '连续解码步数',
    description: '一次调度里连续执行的 decode 步数，减少调度开销、提高 GPU 忙占比',
    direction: 'increase',
    affects: ['measurements.gpuBusyPct', 'measurements.decodeStepMs'],
    precondition: 'GPU 忙占比偏低（调度是主因）；忙占比已高时无空间',
  },
  graph_batch_size: {
    title: '图捕获批大小',
    description: 'CUDA graph 覆盖的批大小档位。补齐档位可减少小批次的 kernel 启动开销',
    direction: 'increase',
    affects: ['measurements.decodeStepMs', 'measurements.gpuBusyPct'],
    precondition: '存在落在图覆盖范围之外的小批次',
  },
  reduce_token_compute: {
    title: '降低每 token 计算量',
    description: '减少每 token 的算力需求（更省算子的实现、更少激活）',
    direction: 'decrease',
    affects: ['model.flopsPerToken', 'measurements.kernelMs'],
    precondition: '算力利用率已接近实测峰值',
  },
  kv_precision: {
    title: 'KV 精度',
    description: '降低 KV 缓存精度以扩大容量',
    direction: 'decrease',
    affects: ['model.kvBytesPerToken', 'limits.kvPoolTokens'],
    precondition: '精度容忍允许；**必须走精度回归验证**',
    risk: 'R2',
    accuracySensitive: true,
  },
})

/** 墙 → 干预。`top1` 是"先试这一个"，`alternatives` 是 TOP1 被否证后的候选。 */
export const REMEDIES = Object.freeze({
  bandwidth: {
    top1: 'concurrency_capacity',
    why: '带宽墙的本质是"读一次权重只产出很少 token"。利用率未到顶时，把并发提上去让同一次权重读取服务更多 token 是最直接的解法。',
    expected: 'decode 吞吐随并发近似线性上升，直到 KV 容量或调度成为新墙',
    alternatives: ['kv_pool_size', 'batch_step_count'],
    falsify: [
      '提高并发后 TPS 不上反降 → 已经越过了带宽墙，新墙是容量或调度（去看那两堵墙的利用率）',
      '反推有效带宽 > 实测可达 → **分母口径有误**，不是墙的问题',
    ],
  },
  speculative: {
    top1: 'draft_budget',
    why: '投机墙的收益 = 接受长度 / (1 + 草稿开销)。预算不足时加预算直接提高接受长度。',
    expected: '接受长度上升，单流 TPS 上升，TTFT 基本不变',
    alternatives: ['concurrency_capacity'],
    falsify: [
      '预算加大但接受长度不升（边际接受率 ≤ 0）→ 预算已饱和，加预算无效，应停手而不是继续加',
      '接受长度 ≤ 1 → 草稿模型/温度/任务不匹配，换预算无用',
    ],
  },
  compute: {
    top1: 'reduce_token_compute',
    why: '算力利用率已接近实测峰值时，唯一出路是降低每 token 计算量，而不是继续提高占用。',
    expected: '每 token FLOPs 下降，kernelMs 下降',
    alternatives: ['prefill_chunk'],
    falsify: [
      '达成算力 > 实测算力峰值 → FLOPs 分母口径错，先修口径',
      '降低计算量后 TPS 不变 → 该场景其实不是算力墙（墙找错了）',
    ],
  },
  memory: {
    top1: 'kv_pool_size',
    why: '容量墙是 KV 池装不下更多并发。先扩大池子；池子受显存限制时改降单请求占用。',
    expected: '并发上限上升，批吞吐上升',
    alternatives: ['seq_budget', 'kv_precision'],
    falsify: [
      '扩大池子后 OOM 或权重被挤压 → 显存本就是硬约束，应改降每请求占用',
      '并发上限升了但吞吐没动 → 真正的墙在别处（调度/带宽）',
    ],
  },
  schedule: {
    top1: 'batch_step_count',
    why: 'GPU 忙占比低说明时间花在调度/启动开销上，而不是计算。提高连续解码步数与图覆盖能直接提高忙占比。',
    expected: 'GPU 忙占比上升，decodeStepMs 下降，批吞吐上升',
    alternatives: ['graph_batch_size', 'prefill_chunk'],
    falsify: [
      '忙占比已 ≥60% → 调度不是主因（墙找错了）',
      '步数提高后 TTFT 明显变差 → 交互性被牺牲，需按业务权衡',
    ],
  },
})

export const WALL_IDS = Object.freeze(Object.keys(REMEDIES))

/** 取某堵墙的 TOP1 干预（含语义说明）。 */
export function top1For(wallId) {
  const r = REMEDIES[wallId]
  if (!r) return null
  const lever = r.top1
  return {
    wallId,
    lever,
    semantics: LEVER_SEMANTICS[lever] ?? null,
    why: r.why,
    expected: r.expected,
    alternatives: r.alternatives ?? [],
    falsify: r.falsify ?? [],
  }
}

export function leverSemantics(lever) {
  return LEVER_SEMANTICS[lever] ?? null
}

export function listLevers() {
  return Object.entries(LEVER_SEMANTICS).map(([id, v]) => ({ id, ...v }))
}
