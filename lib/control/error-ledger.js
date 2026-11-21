/**
 * 被吞异常账本（0.6.0 工单 #06 · 诊断 errors 组）
 *
 * 规格要求："各吞错桶计数与最近样本，带上限，含宿主能力缺失与鉴权回退"。
 * 因此这里不是日志，而是一个**有界**的只读证据面：
 *   - 每个 code 一个桶：count / firstAt / lastAt / samples（最多 N 条，只留最新）；
 *   - 桶数有上限（D20 资源有界：按最近命中淘汰最久未用的桶）；
 *   - 只存摘要（route / detail / message 截断），绝不存完整栈或请求体。
 *
 * 为什么不让各处直接 logger.error：日志读完就没了，而面板要回答"最近吞了什么"。
 */

/** 默认上限：32 个桶 × 3 条样本 —— 够覆盖全部规格码 + 扩展码，又不会无限涨。 */
export const LEDGER_BUCKET_LIMIT = 32;
export const LEDGER_SAMPLES_PER_BUCKET = 3;

/** 规格里点名要进诊断的稳定桶名（不是 HTTP code，是"被吞掉的事件"）。 */
export const LEDGER_CODES = Object.freeze({
  INTERNAL: "INTERNAL",
  BODY_ABORTED: "body-aborted",
  PAYLOAD_TOO_LARGE: "payload-too-large",
  INVALID_BODY: "invalid-body",
  AUTH_FALLBACK: "auth-fallback",
  AUTH_SHAPE_CHANGED: "auth-shape-changed",
  AUTH_REJECTED: "auth-rejected",
  HOST_CAPABILITY_MISSING: "host-capability-missing",
  PRESCAN_FAILED: "skill-prescan-failed",
  MCP_READ_FAILED: "mcp-read-failed",
});

const iso = (at) => new Date(at).toISOString();

/**
 * @param {{bucketLimit?: number, samplesPerBucket?: number, now?: () => number}} [options]
 */
export function createErrorLedger(options) {
  const opts = options || {};
  const bucketLimit = Number.isFinite(opts.bucketLimit) && opts.bucketLimit > 0 ? Math.floor(opts.bucketLimit) : LEDGER_BUCKET_LIMIT;
  const samplesPerBucket = Number.isFinite(opts.samplesPerBucket) && opts.samplesPerBucket > 0
    ? Math.floor(opts.samplesPerBucket)
    : LEDGER_SAMPLES_PER_BUCKET;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  /** @type {Map<string, {code:string, count:number, firstAt:number, lastAt:number, samples:object[]}>} */
  const buckets = new Map();
  let dropped = 0;

  const touch = (code) => {
    let bucket = buckets.get(code);
    if (bucket !== undefined) {
      // 命中即移到队尾：Map 插入序当 LRU。
      buckets.delete(code);
    } else {
      bucket = { code, count: 0, firstAt: now(), lastAt: 0, samples: [] };
    }
    buckets.set(code, bucket);
    while (buckets.size > bucketLimit) {
      const oldest = buckets.keys().next();
      if (oldest.done === true) break;
      buckets.delete(oldest.value);
      dropped += 1;
    }
    return bucket;
  };

  return {
    /**
     * 记一次被吞掉的事件。
     * @param {string} code 桶名（用 LEDGER_CODES 里的常量；未知 code 也允许，按有界 LRU 收）
     * @param {{message?: string, route?: string, detail?: object, at?: number}} [info]
     */
    record(code, info) {
      const key = typeof code === "string" && code.length > 0 ? code : "unknown";
      const bucket = touch(key);
      const at = Number.isFinite(info && info.at) ? info.at : now();
      bucket.count += 1;
      bucket.lastAt = at;
      const sample = { at: iso(at) };
      if (info && typeof info.route === "string" && info.route.length > 0) sample.route = info.route;
      if (info && info.message !== undefined && info.message !== null && String(info.message).length > 0) {
        sample.message = String(info.message).slice(0, 300);
      }
      if (info && info.detail !== undefined) sample.detail = info.detail;
      bucket.samples.push(sample);
      while (bucket.samples.length > samplesPerBucket) bucket.samples.shift();
      return bucket;
    },
    /** 只读快照（按 lastAt 倒序，最新在最前）。 */
    snapshot() {
      const rows = [...buckets.values()].map((bucket) => ({
        code: bucket.code,
        count: bucket.count,
        firstAt: iso(bucket.firstAt),
        lastAt: bucket.lastAt === 0 ? undefined : iso(bucket.lastAt),
        samples: bucket.samples.map((sample) => Object.assign({}, sample)),
      }));
      rows.sort((a, b) => (String(b.lastAt || "").localeCompare(String(a.lastAt || ""))) || a.code.localeCompare(b.code));
      return {
        buckets: rows,
        total: rows.reduce((sum, row) => sum + row.count, 0),
        limit: { buckets: bucketLimit, samplesPerBucket },
        dropped,
      };
    },
    /** 单桶计数（内部计数用；不存在返回 0）。 */
    countOf(code) {
      const bucket = buckets.get(code);
      return bucket === undefined ? 0 : bucket.count;
    },
    clear() {
      buckets.clear();
      dropped = 0;
    },
  };
}
