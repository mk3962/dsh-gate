/**
 * 控制面环境（0.6.0 工单 #06 · 装饰器第 6/7 步与诊断的宿主面）
 *
 * 把三件与"环境"有关的事收在一处：
 *   1. 鉴权：宿主 connection 优先，回退四道门；两者都不可用时**不 fail-open**，
 *      并在诊断里给出 auth.shape 诊断码（F79：形状变化给码，而不是全量 401）。
 *   2. 会话解析：?agent= → agent 对象与已知 id 清单（404 AGENT_NOT_FOUND 的 details.agents）。
 *   3. 宿主能力探测：**只给诊断用**，不参与任何决策（"删除特征探测"的要求）；
 *      探测失败缓存为 unsupported，前端据此降级（07 消费）。
 *
 * F76 的进程内令牌：兜底门在 requireToken 为真时额外要求 x-dsh-gate-token；
 * 默认不要求（与 0.5.7 行为一致），令牌由安装/启动时下发（#07 接线），状态始终进诊断。
 */
import crypto from "node:crypto";
import { hostAdmission, isTrustedRequest } from "./trust.js";
import { AUTH_CODES, AUTH_STATUS } from "./errors.js";
import { LEDGER_CODES } from "./error-ledger.js";
import { resolveService } from "../services.js";

/** 造一个进程内令牌（安装/启动时下发；只在 requireToken 时生效）。 */
export function createFallbackToken() {
  return crypto.randomBytes(24).toString("hex");
}

const TOKEN_HEADER = "x-dsh-gate-token";

/**
 * @param {{ctx:object, ledger:object, logger:object, config:object, requireToken?:boolean, token?:string}} options
 */
export function createEnvironment(options) {
  const opts = options || {};
  const ctx = opts.ctx;
  const ledger = opts.ledger;
  const logger = opts.logger;
  const config = opts.config !== null && typeof opts.config === "object" ? opts.config : {};
  const token = typeof opts.token === "string" && opts.token.length > 0
    ? opts.token
    : (typeof config.fallbackToken === "string" && config.fallbackToken.length > 0 ? config.fallbackToken : undefined);
  const requireToken = opts.requireToken === true || config.requireFallbackToken === true;

  let warnedFallback = false;
  const auth = {
    host: "unknown",
    mode: "unknown",
    fallback: false,
    token: token === undefined ? "not-configured" : requireToken ? "required" : "configured-optional",
    shape: undefined,
    lastCheckedAt: undefined,
    rejections: { "401": 0, "403": 0 },
  };

  const note = (code, message, detail) => {
    try { ledger?.record?.(code, { message, detail, route: "auth" }); } catch { /* 忽略 */ }
  };

  /** 装饰器第 6 步：返回 { ok } 或 { ok:false, status, code, message, details }。 */
  const authenticate = (req) => {
    auth.lastCheckedAt = new Date().toISOString();
    let admission;
    try {
      admission = hostAdmission(ctx, req);
    } catch (error) {
      note(LEDGER_CODES.HOST_CAPABILITY_MISSING, "connection.requestRejection 抛错（按 fail-closed 处理）", { cause: String((error && error.message) || error) });
      admission = { checked: true, rejection: 403 };
    }
    if (admission.checked === true) {
      auth.host = "available";
      auth.mode = "host";
      auth.fallback = false;
      auth.shape = "ok";
      if (admission.rejection === undefined) return { ok: true };
      if (admission.rejection === 403) {
        auth.rejections["403"] += 1;
        return { ok: false, status: AUTH_STATUS.FORBIDDEN, code: AUTH_CODES.FORBIDDEN, message: "local trusted request only" };
      }
      auth.rejections["401"] += 1;
      return { ok: false, status: AUTH_STATUS.UNAUTHORIZED, code: AUTH_CODES.UNAUTHORIZED, message: "browser session required (dsh web token/cookie)" };
    }

    // 宿主 connection 服务缺失或形状变了：明确记账，再退回四道门（不是全量 401）。
    const connection = safeService(ctx, "connection");
    if (connection === undefined) {
      if (!warnedFallback) {
        warnedFallback = true;
        note(LEDGER_CODES.AUTH_FALLBACK, "宿主 connection 服务不可用，/api/dsh-gate/* 退回本地四道门（不含浏览器会话认证）");
        try { logger?.warn?.("dsh-gate: 宿主 connection 服务不可用，/api/dsh-gate/* 退回本地四道门（不含浏览器会话认证）"); } catch { /* 忽略 */ }
      }
      auth.host = "missing";
      auth.shape = "missing";
    } else {
      note(LEDGER_CODES.AUTH_SHAPE_CHANGED, "宿主 connection 服务存在但 requestRejection 不是函数", { capability: "connection.requestRejection" });
      try { logger?.warn?.("dsh-gate: 宿主鉴权形状变化（connection.requestRejection 缺失），已退回四道门"); } catch { /* 忽略 */ }
      auth.host = "shape-changed";
      auth.shape = "shape-changed";
    }
    auth.mode = "fallback";
    auth.fallback = true;

    if (!isTrustedRequest(req)) {
      auth.rejections["403"] += 1;
      return { ok: false, status: AUTH_STATUS.FORBIDDEN, code: AUTH_CODES.FORBIDDEN, message: "local trusted request only", details: { gate: "origin", mode: "fallback" } };
    }
    if (requireToken === true) {
      const headers = req !== null && typeof req === "object" ? req.headers || {} : {};
      const presented = typeof headers[TOKEN_HEADER] === "string" ? headers[TOKEN_HEADER] : "";
      if (token === undefined || presented !== token) {
        auth.rejections["401"] += 1;
        return { ok: false, status: AUTH_STATUS.UNAUTHORIZED, code: AUTH_CODES.UNAUTHORIZED, message: "fallback token required", details: { header: TOKEN_HEADER, mode: "fallback" } };
      }
    }
    return { ok: true };
  };

  /** 装饰器第 7 步：按 ?agent= 解析会话（不含 404 决策——那是装饰器的事）。 */
  const resolveScope = (want) => {
    let rows = [];
    try { rows = gateRows(ctx, opts.gate); } catch { rows = []; }
    const known = rows.map((row) => row.id).sort();
    if (typeof want !== "string" || want.length === 0) {
      return { known, agent: rows.length > 0 ? rows[0].agent : undefined, id: rows.length > 0 ? rows[0].id : undefined };
    }
    const hit = rows.find((row) => row.id === want);
    return { known, agent: hit === undefined ? undefined : hit.agent, id: hit === undefined ? undefined : hit.id };
  };

  /** 宿主能力探测：只读、只给诊断；失败缓存为一个明确的 unsupported 值（07 消费）。 */
  const probes = {};
  const probe = (name) => {
    if (probes[name] !== undefined) return probes[name];
    let value = "unsupported";
    try {
      const service = safeService(ctx, name);
      if (name === "connection") {
        if (service === undefined) value = "missing";
        else value = typeof service.requestRejection === "function" ? "available" : "shape-changed";
      } else if (service !== undefined) {
        value = "available";
      }
    } catch {
      value = "unsupported";
    }
    probes[name] = value;
    return value;
  };

  const snapshot = () => ({
    host: auth.host,
    mode: auth.mode,
    fallback: auth.fallback,
    shape: auth.shape,
    token: auth.token,
    requireToken,
    lastCheckedAt: auth.lastCheckedAt,
    rejections: Object.assign({}, auth.rejections),
    probes: {
      connection: probe("connection"),
      agents: probe("agents"),
      agentPresets: probe("agentPresets"),
      workingDirectory: probe("workingDirectory"),
      skills: probe("skills"),
    },
    counters: {
      authRejected: (auth.rejections["401"] || 0) + (auth.rejections["403"] || 0),
    },
  });

  return { authenticate, resolveScope, snapshot, token, requireToken, TOKEN_HEADER, note };
}

function safeService(ctx, name) {
  try { return resolveService(ctx, name); } catch { return undefined; }
}

function gateRows(ctx, gate) {
  if (gate !== undefined && gate !== null && typeof gate.listAgents === "function") return gate.listAgents() || [];
  return [];
}
