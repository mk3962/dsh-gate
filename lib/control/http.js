/**
 * 控制面 HTTP 原语（0.6.0 工单 #06）
 *
 * 写出只有这一个函数：状态码 / 响应头 / 信封形状 / 幂等保护都收在这里。
 * 目的很具体 —— "响应头都没写出、连接挂到宿主超时"（F67）不能再从第二个地方漏出去。
 */

/** 统一的 JSON 写出。**不许抛**：写不出去（已断连 / 已 end 过）返回 false，调用方只记日志。 */
export function writeJson(res, status, body, headers) {
  if (res === null || typeof res !== "object") return false;
  try {
    if (res.writableEnded === true || res.ended === true || res.headersSent === true && res.writableEnded === true) return false;
    const payload = JSON.stringify(body === undefined ? {} : body);
    const merged = Object.assign({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    }, headers || {});
    if (typeof res.writeHead === "function") res.writeHead(status, merged);
    if (typeof res.end === "function") res.end(payload);
    return true;
  } catch {
    // 客户端已断（EPIPE / ERR_STREAM_DESTROYED）：响应写不出去是既成事实，不能再抛。
    try { if (typeof res.end === "function") res.end(); } catch { /* 忽略 */ }
    return false;
  }
}

/** 请求方法（大写；缺省 GET）。 */
export function methodOf(req) {
  const method = req !== null && typeof req === "object" ? req.method : undefined;
  return typeof method === "string" && method.length > 0 ? method.toUpperCase() : "GET";
}

/** 带体的方法：只有这些才做 content-type / 长度预检 / 读体 / JSON 解析。 */
export const BODY_METHODS = Object.freeze(["POST", "PUT", "PATCH", "DELETE"]);

export function isBodyMethod(method) {
  return BODY_METHODS.includes(method);
}

/** content-type 是否 application/json（允许 charset 参数；允许 *+json 变体）。 */
export function isJsonContentType(req) {
  const headers = req !== null && typeof req === "object" && req.headers ? req.headers : {};
  const raw = headers["content-type"];
  if (typeof raw !== "string") return false;
  const media = raw.split(";")[0].trim().toLowerCase();
  if (media === "application/json") return true;
  return /^application\/[a-z0-9.+-]+\+json$/.test(media);
}

/**
 * 解析查询串（坏 URL 不抛：退回空表）。
 * @returns {URLSearchParams}
 */
export function queryOf(req) {
  const url = req !== null && typeof req === "object" && typeof req.url === "string" ? req.url : "/";
  try {
    const base = "http://127.0.0.1";
    return new URL(url.startsWith("/") ? url : "/" + url, base).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** ?agent= 取值（trim 后非空才算点名）。 */
export function agentParamOf(query) {
  const value = query instanceof URLSearchParams ? query.get("agent") : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 稳定的字符串截断（detail 里的 message 上限，防止把整份栈塞进信封）。 */
export function clip(text, limit) {
  const max = Number.isFinite(limit) && limit > 0 ? limit : 300;
  const value = typeof text === "string" ? text : String(text === undefined ? "" : text);
  return value.length > max ? value.slice(0, max) + "…" : value;
}

/** 栈摘要：只留前若干行，绝不回传给客户端（日志与诊断用）。 */
export function stackBrief(error, lines) {
  const max = Number.isFinite(lines) && lines > 0 ? lines : 4;
  const stack = error && typeof error.stack === "string" ? error.stack : "";
  const rows = stack.split("\n").map((row) => row.trim()).filter((row) => row.length > 0);
  return rows.slice(0, max).join(" | ");
}
