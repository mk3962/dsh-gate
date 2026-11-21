/**
 * 旧结果对象 → 控制面响应（0.6.0 工单 #06）
 *
 * 0.5.7 的领域层各自返回 `{ok:false, status, code, message, ...细节}`（不是 HTTP 信封）。
 * 装饰器要求服务层返回 `{status, body}` 且失败体是标准信封，所以这里做**唯一一次**转换：
 *   - ok:true  → 原样返回（成功回执字段一个不动，changed=false 也保持 ok:true + changed:false）
 *   - ok:false → 标准信封，code 优先用领域层给的那个（POLICY_UNREADABLE / REVISION_CONFLICT /
 *                INVALID_POLICY / invalid-server-name 等），status 优先用它给的；
 *                细节键（errors / expectedRevision / …）放进 details，同时**留在顶层**兼容旧面板。
 */
import { errorEnvelope } from "./errors.js";

const isObject = (value) => value !== null && typeof value === "object" && Array.isArray(value) === false;

/** HTTP 状态 → 规格码（领域层没给 code 时的兜底；绝不猜 200）。 */
export function codeForStatus(status) {
  if (status === 400) return "INVALID_POLICY";
  if (status === 404) return "AGENT_NOT_FOUND";
  if (status === 405) return "METHOD_NOT_ALLOWED";
  if (status === 409) return "POLICY_UNREADABLE";
  if (status === 413) return "PAYLOAD_TOO_LARGE";
  if (status === 415) return "UNSUPPORTED_MEDIA_TYPE";
  return "INTERNAL";
}

const DETAIL_KEYS = Object.freeze([
  "errors", "expectedRevision", "currentRevision", "changedKeys", "fileState",
  "readDiagnostic", "writable", "willDelete", "action", "name", "result", "reason",
]);

/**
 * @param {object} legacy 领域层结果
 * @returns {{status:number, body:object}}
 */
export function fromLegacy(legacy) {
  if (!isObject(legacy)) {
    return { status: 500, body: errorEnvelope("INTERNAL", "领域层没有返回结果") };
  }
  if (legacy.ok === true) {
    const status = Number.isFinite(legacy.status) ? legacy.status : 200;
    return { status, body: legacy };
  }
  const status = Number.isFinite(legacy.status) ? legacy.status : 500;
  const code = typeof legacy.code === "string" && legacy.code.length > 0 ? legacy.code : codeForStatus(status);
  const details = {};
  for (const key of DETAIL_KEYS) if (legacy[key] !== undefined) details[key] = legacy[key];
  const body = errorEnvelope(code, legacy.message, Object.keys(details).length > 0 ? details : undefined);
  // 过渡期：细节键同时留在顶层（旧面板与旧用例按 0.5.7 的平铺形状读）。
  for (const [key, value] of Object.entries(details)) if (body[key] === undefined) body[key] = value;
  return { status, body };
}

/** 成功回执的固定字段（工单：ok、revision、changed、可选 changedKeys/warnings、可选 state/applied）。 */
export function writeReceipt(written, extra) {
  const body = Object.assign({
    ok: true,
    revision: written.revision,
    changed: written.changed !== false,
  }, extra || {});
  if (written.changedKeys !== undefined) body.changedKeys = written.changedKeys;
  body.warnings = Array.isArray(written.warnings) ? written.warnings : [];
  return body;
}
