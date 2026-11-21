/**
 * 本机来源与宿主鉴权（从 0.5.7 lib/server.js 提出，语义逐行保留）。
 * server.js re-export 这三个符号，公共 API 不变（selftest 直接 import hostAdmission）。
 */
import { resolveService } from "../services.js";

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const isLoopback = (req) => {
  const address = req.socket && req.socket.remoteAddress;
  if (typeof address !== "string") return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
};

const hostNameOf = (host) => {
  if (typeof host !== "string") return "";
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const cut = trimmed.indexOf("]");
    return cut > 0 ? trimmed.slice(0, cut + 1) : trimmed;
  }
  const colon = trimmed.lastIndexOf(":");
  return colon > 0 ? trimmed.slice(0, colon) : trimmed;
};

export const isTrustedRequest = (req) => {
  if (!isLoopback(req)) return false;
  const headers = req.headers || {};
  const host = headers.host;
  if (typeof host === "string" && host.length > 0 && !LOOPBACK_NAMES.has(hostNameOf(host))) return false;
  const site = headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return false;
  const origin = headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    if (origin === "null") return false;
    let originHost = "";
    try { originHost = new URL(origin).host.toLowerCase(); } catch { return false; }
    if (!LOOPBACK_NAMES.has(hostNameOf(originHost))) return false;
    if (typeof host === "string" && host.length > 0 && originHost !== host.toLowerCase()) return false;
  }
  return true;
};

/**
 * 宿主级鉴权：返回 { checked, rejection }。
 * checked=true 表示宿主 connection 服务给过结论（rejection 为 undefined 即放行）。
 * 服务抛错时按 fail-closed 处理（checked=true + 403），避免宿主接口变动时悄悄放行。
 */
export const hostAdmission = (ctx, req) => {
  const connection = resolveService(ctx, "connection");
  if (connection === undefined || typeof connection.requestRejection !== "function") return { checked: false };
  try {
    const rejection = connection.requestRejection(req);
    return { checked: true, rejection: rejection === undefined ? undefined : Number(rejection) };
  } catch {
    return { checked: true, rejection: 403 };
  }
};
