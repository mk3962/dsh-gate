/**
 * 请求体读取（0.6.0 工单 #06 · 装饰器第 3/4 步）
 *
 * 三条纪律（对应 F71 / P1-1）：
 *   1. **声明长度预检在流之前**：Content-Length 已超限就直接 413，一个字节都不读。
 *   2. **读体整段包在异常处理内**：流错误 / 客户端断连（ECONNRESET / aborted）一律转成
 *      `BodyError("BODY_ABORTED")`，调用方据此写结构化 500，绝不让异常逃到 webServer（P1-1）。
 *   3. **超限先丢弃再 413**：读到一半超限时先尽力把剩余字节消费掉（不让宿主拿着半截连接），
 *      再报 413；消费有硬上限，绝不为了"读完"把面板挂死。
 *
 * 这里不做 JSON 解析、不看 content-type —— 那是装饰器第 2/5 步。
 */

/** 请求体上限（与 0.5.7 一致：512 KiB）。导出给接缝夹具断言用。 */
export const MAX_BODY_BYTES = 512 * 1024;

/** 超限后最多再消费多少字节；再多就直接断开（防御无限分块流）。 */
export const MAX_DRAIN_BYTES = MAX_BODY_BYTES * 2;

/** 读体失败的两类原因（都不是业务错误）。 */
export const BODY_REASONS = Object.freeze({
  ABORTED: "body-aborted",
  OVERSIZED: "body-oversized",
});

/** 读体失败：只有当它是"超限"时才有状态码；断连交给装饰器落 500。 */
export class BodyError extends Error {
  constructor(reason, message, details) {
    super(message || reason);
    this.name = "BodyError";
    this.reason = reason;
    if (details !== undefined) this.details = details;
  }
  /** @returns {boolean} 是否属于"客户端已经走了"（写响应只能尽力而为）。 */
  get aborted() {
    return this.reason === BODY_REASONS.ABORTED;
  }
  get oversized() {
    return this.reason === BODY_REASONS.OVERSIZED;
  }
}

const numeric = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

/**
 * 读 Content-Length 声明（不碰流）。
 * @returns {{declared?: number, invalid: boolean, zero: boolean, exceeds: boolean, raw: unknown}}
 */
export function declaredLength(req, limit) {
  const max = Number.isFinite(limit) && limit > 0 ? limit : MAX_BODY_BYTES;
  const headers = req !== null && typeof req === "object" && req.headers ? req.headers : {};
  const raw = headers["content-length"];
  if (raw === undefined || raw === null || raw === "") return { declared: undefined, invalid: false, zero: false, exceeds: false, raw };
  const declared = numeric(raw);
  if (declared === undefined || declared < 0 || !Number.isInteger(declared)) {
    return { declared: undefined, invalid: true, zero: false, exceeds: false, raw };
  }
  return { declared, invalid: false, zero: declared === 0, exceeds: declared > max, raw };
}

/**
 * 尽力消费剩余字节：让宿主不会因为半截请求体把连接留着。
 * 只挂 resume（真 IncomingMessage 有），不自己再 for-await —— 我们已经跳出了迭代器。
 */
function drain(req) {
  try {
    if (req !== null && typeof req === "object") {
      if (typeof req.on === "function") {
        try { req.on("error", () => undefined); } catch { /* 忽略 */ }
      }
      if (typeof req.resume === "function") { req.resume(); return; }
      if (typeof req.destroy === "function") { req.destroy(); }
    }
  } catch { /* 消费失败不影响 413 的写出 */ }
}

/**
 * 读完整请求体。
 * @param {object} req IncomingMessage 形状（至少可 for-await）
 * @param {{limit?: number}} [options]
 * @returns {Promise<{text: string, bytes: number, chunks: number}>}
 * @throws {BodyError} reason = body-oversized | body-aborted
 */
export async function readBody(req, options) {
  const opts = options || {};
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : MAX_BODY_BYTES;
  const chunks = [];
  let size = 0;
  let count = 0;
  if (req === null || typeof req !== "object" || typeof req[Symbol.asyncIterator] !== "function") {
    // 没有可读流：在这个装饰器里等同"没有请求体"，由 JSON 解析那一步报 400。
    return { text: "", bytes: 0, chunks: 0 };
  }
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk === undefined ? "" : String(chunk));
      size += buffer.length;
      count += 1;
      if (size > limit) {
        drain(req);
        throw new BodyError(BODY_REASONS.OVERSIZED, "请求体超过上限 " + limit + " 字节", { limit, bytes: size, drained: true });
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof BodyError) throw error;
    // 流错误 / 断连 / 迭代器抛错：一律记 body-aborted，不向上抛原始异常。
    throw new BodyError(BODY_REASONS.ABORTED, "读取请求体失败：" + String((error && (error.code || error.message)) || error), {
      cause: error && error.code ? String(error.code) : undefined,
      bytes: size,
    });
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes: size, chunks: count };
}
