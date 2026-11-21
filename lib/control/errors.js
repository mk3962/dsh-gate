/**
 * 控制面错误信封与稳定错误码（0.6.0 工单 #06 · 规格 I-15 / F73）
 *
 * 纪律：
 *   1. 失败一律 `{ ok:false, code, message, details? }`；过渡期把 `message` 同时留在顶层供旧客户端，
 *      并把 `error` 回填成稳定 code（0.5.7 的 auth 失败只有 `error` 字段，面板读它）。
 *   2. 状态码只按 code 查表得出，服务层不自己拍数字（"保存失败仍 200" 的根因就是分散拍数字）。
 *   3. 十二个规格码是**闭合清单**：名字与状态码由本文件唯一定义，客户端可以按 code 分支。
 *      业务态（MCP 冲突 / 路径不安全）另给扩展码，且一律保留 `message`，客户端按 status 兜底。
 */

/** 规格 §「错误信封」要求的全量 code 表（名字与状态码都是契约）。 */
export const ERROR_CODES = Object.freeze({
  REVISION_CONFLICT: "REVISION_CONFLICT",
  POLICY_UNREADABLE: "POLICY_UNREADABLE",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
  INVALID_TIER: "INVALID_TIER",
  INVALID_POLICY: "INVALID_POLICY",
  INVALID_BODY: "INVALID_BODY",
  AGENT_NOT_FOUND: "AGENT_NOT_FOUND",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  GATE_TOOL_NOT_FORWARDABLE: "GATE_TOOL_NOT_FORWARDABLE",
  INTERNAL: "INTERNAL",
});

/** 规格码 → HTTP 状态码（唯一映射）。 */
export const ERROR_STATUS = Object.freeze({
  REVISION_CONFLICT: 409,
  POLICY_UNREADABLE: 409,
  CONFIRMATION_REQUIRED: 409,
  INVALID_TIER: 400,
  INVALID_POLICY: 400,
  INVALID_BODY: 400,
  AGENT_NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  GATE_TOOL_NOT_FORWARDABLE: 400,
  INTERNAL: 500,
});

/**
 * 鉴权码（规格只规定 401/403 两个状态，没给 code；这里补两个稳定名，面板按 status 也能分支）。
 * 鉴权失败**不是** INTERNAL：把它归到 500 会让面板把"没登录"误报成"服务端坏了"。
 */
export const AUTH_CODES = Object.freeze({ UNAUTHORIZED: "UNAUTHORIZED", FORBIDDEN: "FORBIDDEN" });
export const AUTH_STATUS = Object.freeze({ UNAUTHORIZED: 401, FORBIDDEN: 403 });

/** 业务态扩展码：不改变规格码表，只是不让业务冲突挤进 INTERNAL。 */
export const SERVICE_CODES = Object.freeze({
  GATE_DISABLED: "GATE_DISABLED",
  MCP_CONFLICT: "MCP_CONFLICT",
  MCP_NOT_FOUND: "MCP_NOT_FOUND",
  MCP_UNAVAILABLE: "MCP_UNAVAILABLE",
  IMPORT_PATH_UNSAFE: "IMPORT_PATH_UNSAFE",
  IMPORT_PATH_MISSING: "IMPORT_PATH_MISSING",
  BATCH_REJECTED: "BATCH_REJECTED",
});
export const SERVICE_STATUS = Object.freeze({
  GATE_DISABLED: 409,
  MCP_CONFLICT: 409,
  MCP_NOT_FOUND: 404,
  MCP_UNAVAILABLE: 409,
  IMPORT_PATH_UNSAFE: 400,
  IMPORT_PATH_MISSING: 400,
  BATCH_REJECTED: 400,
});

/** 全部已知 code → 状态码（规格码优先，扩展码不覆盖规格码）。 */
export const CODE_STATUS = Object.freeze(Object.assign({}, SERVICE_STATUS, AUTH_STATUS, ERROR_STATUS));

/** 状态码、code 二元组是否属于规格闭合表（测试与文档断言用）。 */
export const CANONICAL_CODES = Object.freeze(Object.keys(ERROR_CODES));

/**
 * code → 状态码；未知 code 退回 fallback（默认 500，绝不猜 200）。
 * @param {string} code
 * @param {number} [fallback]
 */
export function statusOf(code, fallback) {
  const known = CODE_STATUS[code];
  if (Number.isFinite(known)) return known;
  return Number.isFinite(fallback) ? fallback : 500;
}

/**
 * 严格档位判定（P1-10 的修法）。
 * 0.5.7 用 `Number(value)` 判档，于是 null / "" / false / [] 全部被强转成 0（"关闭"），
 * 一个手抖的 `tier: null` 就把技能静默关掉。这里只认 0/1/2，其余一律非法。
 */
export function isTier(value) {
  return value === 0 || value === 1 || value === 2;
}

/**
 * 唯一的档位归一化函数：合法返回 0/1/2，非法返回 undefined（调用方落 INVALID_TIER 400）。
 * 接受 "0"/"1"/"2" 字符串（老面板偶尔这么发），但绝不接受 null / "" / true / false / 数组 / 小数。
 */
export function parseTier(value) {
  if (isTier(value)) return value;
  if (typeof value === "string" && (value === "0" || value === "1" || value === "2")) return Number(value);
  return undefined;
}

/** 带 code 的控制面异常：服务层 throw 它，装饰器统一落成信封（不许自己写响应）。 */
export class ControlPlaneError extends Error {
  constructor(code, message, details, status) {
    super(message || code);
    this.name = "ControlPlaneError";
    this.code = String(code || ERROR_CODES.INTERNAL);
    if (details !== undefined) this.details = details;
    this.status = Number.isFinite(status) ? status : statusOf(this.code, 500);
  }
}

const isObject = (value) => value !== null && typeof value === "object" && Array.isArray(value) === false;

/**
 * 错误信封：固定形状 + 旧字段回填。
 * details 里常见的键：allow / method / declared / limit / requested / agents / errors / revision 前后值 / index。
 */
export function errorEnvelope(code, message, details) {
  const envelope = {
    ok: false,
    code: String(code || ERROR_CODES.INTERNAL),
    message: String(message === undefined || message === null || message === "" ? (code || "error") : message),
  };
  if (details !== undefined && details !== null) envelope.details = details;
  // 过渡期兼容：旧客户端读 error / message 两个顶层字段（client/index.js: body.message || body.error）。
  // 个别老用例按 0.5.7 的小写字样断言 error（selftest: "agent not found"），映射表把它保住，
  // 同时 code 仍是稳定大写码 —— 两条契约都不破。
  envelope.error = LEGACY_ERROR_TEXT[envelope.code] || envelope.code;
  return envelope;
}

/** 旧版纯文本 error 字段的兼容映射（只影响顶层 error 字段，不影响 code）。 */
export const LEGACY_ERROR_TEXT = Object.freeze({
  AGENT_NOT_FOUND: "agent not found",
  INTERNAL: "internal error",
});

/** 服务层的 { status, body } 结果 → 是不是错误信封（装饰器只做转发，不重写形状）。 */
export function isFailureBody(body) {
  return isObject(body) && body.ok === false && typeof body.code === "string";
}
