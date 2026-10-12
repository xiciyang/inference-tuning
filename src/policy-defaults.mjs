/**
 * 策略默认值（**刻意最小化**）。
 *
 * 两条纪律：
 *   ① **门禁阈值绝不内置默认值** —— `null` 表示未设置，插件会拒绝执行（E_THRESHOLD_NOT_PROVIDED）。
 *      理由：调优插件不能自己定"可以掉多少精度"然后自己签收。
 *      这个坑 quantization 已经用一次误签收证明过了。
 *   ② 其余策略值只提供"安全侧"默认；任何被默认 fills 的字段都会进报告的 `assumptions`。
 */

/** 门禁策略模板 —— 首次运行只生成**空模板**，字段为 null。 */
export const GATES_TEMPLATE = Object.freeze({
  version: 1,
  generated: 'template',
  note: '必须显式设置阈值；null 表示未设置，本插件会拒绝执行（不猜默认值）',
  max_accuracy_drop_pct: null,
  min_perf_gain_pct: null,
  // 观测留一档"接近上限"的提前确认（相对阈值的比例，不是绝对魔数）
  near_limit_factor: 0.9,
})

/** 风险分级与沙箱映射（基线 = inference-serving 已固化的口径，本包只沿用不扩充）。 */
export const DEFAULT_RISK_POLICY = Object.freeze({
  version: 1,
  sandbox: {
    R0: 'none',
    R1: 'process',
    R2: 'container',
    R3: 'vm',
    R4: 'vm',
    R5: 'vm',
    R6: 'none',
  },
  confirmation: {
    R0: 'never',
    R1: 'per-class-once',
    R2: 'per-class-once',
    R3: 'always',
    R4: 'always',
    R5: 'always',
    R6: 'never',
  },
  /** R6 一律拒绝的操作类。 */
  denied: ['R6'],
})

export const DEFAULT_HEADLESS_POLICY = Object.freeze({
  version: 1,
  // headless 下，需要确认的一律中止（不静默替你确认）
  confirmInHeadless: 'abort',
})

export const DEFAULT_NETWORK_POLICY = Object.freeze({
  version: 1,
  // 本机 HTTPS_PROXY 指向一个**坏的**代理（CONNECT 通、TLS 挂），
  // 因此出网一律走 node:http 并显式忽略代理环境变量。
  respectProxyEnv: false,
  allowedHosts: [],
})

/** 调优默认参数。每一项都可通过调用方 `options` 覆盖 —— 不硬编码可调参数。 */
export function defaultOptions() {
  return {
    // --- 端点编排 ---
    bindHost: '127.0.0.1',
    portPoolStart: 8300,
    portPoolEnd: 8399,
    // --- 执行 ---
    executor: 'docker',            // docker | fake（测试用进程内假件）
    containerRuntime: 'nvidia',
    servingPath: null,             // 不填则自动探测
    // --- 资源 ---
    gpuMemoryUtilization: null,    // null = 交给 serving 的默认策略
    maxModelLen: null,
    // --- 测量 ---
    evalTimeoutMs: 900_000,
    deployTimeoutMs: 900_000,
    requests: 8,
    concurrency: 2,
    warmupRequests: 1,
    /** 预热闸：端点就绪后必须等待的稳态窗口（原引擎实测：≤3 min 窗口会塌陷） */
    steadyStateWaitMs: 60_000,
    /** 时滞扫描的候选窗口（ms），服务端事件比 GPU 执行早 ~150 ms */
    lagScanMs: [0, 50, 100, 150, 200, 300],
    // --- 闭环 ---
    maxRounds: 12,
    /** 仅用于**有界**保护，不构成停止理由（真正的停止条件是物理瓶颈或用户中止） */
    budgetMs: 6 * 3600 * 1000,
    acceptMinGainPct: null,        // 由门禁阈值决定，不在这里
    // --- 路径 ---
    modelRoots: ['/data/models'],
  }
}

export const METHODS_ORDER_FALLBACK = Object.freeze([])
