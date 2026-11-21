/**
 * 控制面统一装饰器（0.6.0 工单 #06 · 规格 F67/F68/F71/F72/F73）
 *
 * 全部路由**只能**经这里出去。固定八步，顺序是契约（改顺序必须改本注释与用例）：
 *
 *   1 方法允许清单       → 405 METHOD_NOT_ALLOWED + Allow 头
 *   2 写操作 Content-Type → 415 UNSUPPORTED_MEDIA_TYPE（只对带体方法）
 *   3 声明长度预检       → 413 PAYLOAD_TOO_LARGE，**一个字节都不读**
 *   4 读体               → 流错误 / 断连记 body-aborted（500 INTERNAL 信封），超限先丢弃再 413
 *   5 JSON 解析          → 400 INVALID_BODY（必须是 JSON 对象）
 *   6 鉴权主门与兜底门   → 401 / 403（宿主鉴权形状变化与回退进诊断）
 *   7 会话解析           → 404 AGENT_NOT_FOUND + 已知会话清单
 *   8 处理函数执行       → 任何抛出转 500 INTERNAL，**必须写出响应**；
 *                          结构化记录路由 / 耗时 / 状态码 / 堆栈摘要
 *
 * 处理函数只拿 { body, query, agent, agentId, want, scope } 并返回 { status, body }：
 * 它不碰 res、不判状态码、不写信封 —— 所以它想"忘写响应"都没有地方可忘（F67）。
 */
import { BodyError, BODY_REASONS, declaredLength, readBody } from "./body.js";
import {
  ControlPlaneError,
  ERROR_CODES,
  AUTH_CODES,
  errorEnvelope,
  statusOf,
} from "./errors.js";
import { clip, isBodyMethod, isJsonContentType, methodOf, queryOf, agentParamOf, stackBrief, writeJson } from "./http.js";

/** 规格八步的名字（诊断与测试按它断言顺序，不靠读源码）。 */
export const PIPELINE_STEPS = Object.freeze([
  "method", "content-type", "content-length", "read-body", "json", "auth", "scope", "handler",
]);

const isPlainObject = (value) => value !== null && typeof value === "object" && Array.isArray(value) === false;

/**
 * 造一条路由的 handler。
 * @param {object} spec { id, path, methods, body, scope, handler }
 * @param {object} deps { authenticate, resolveScope, metrics, ledger, logger, maxBodyBytes }
 * @returns {(req:object, res:object) => Promise<void>}
 */
export function createControlHandler(spec, deps) {
  const route = spec || {};
  const api = deps || {};
  const routeId = typeof route.id === "string" && route.id.length > 0 ? route.id : String(route.path || "unknown");
  const path = typeof route.path === "string" ? route.path : "/api/dsh-gate/unknown";
  const allowed = Array.isArray(route.methods) && route.methods.length > 0 ? route.methods.slice() : ["GET"];
  const needsBody = route.body === true;
  const acceptsAgent = route.scope === "agent";
  const limit = Number.isFinite(api.maxBodyBytes) && api.maxBodyBytes > 0 ? api.maxBodyBytes : undefined;
  const logger = api.logger;
  const ledger = api.ledger;
  const metrics = api.metrics;

  const log = (line) => {
    try { logger?.info?.(line); } catch { /* 日志失败不影响响应 */ }
  };
  const warn = (line) => {
    try { logger?.warn?.(line); } catch { /* 忽略 */ }
  };
  const record = (code, info) => {
    try { ledger?.record?.(code, Object.assign({ route: path }, info || {})); } catch { /* 忽略 */ }
  };

  return async function controlHandler(req, res) {
    const startedAt = Date.now();
    const method = methodOf(req);
    let status = 500;
    let code = ERROR_CODES.INTERNAL;
    let finished = false;

    /** 唯一写出口：写完即锁，后续任何分支都不再写（幂等，绝不二次 end）。 */
    const send = (nextStatus, body, headers) => {
      if (finished === true) return false;
      finished = true;
      status = Number.isFinite(nextStatus) ? nextStatus : 500;
      code = isPlainObject(body) && typeof body.code === "string" ? body.code : (status >= 400 ? code : undefined);
      return writeJson(res, status, body, headers);
    };
    const fail = (errorCode, message, details, headers, statusOverride) => {
      const envelope = errorEnvelope(errorCode, message, details);
      const nextStatus = Number.isFinite(statusOverride) ? statusOverride : statusOf(errorCode, 500);
      return send(nextStatus, envelope, headers);
    };

    try {
      // ── 1 方法允许清单 ────────────────────────────────────────────────────
      if (!allowed.includes(method)) {
        record("method-not-allowed", { message: method + " " + path, detail: { method, allow: allowed } });
        return fail(ERROR_CODES.METHOD_NOT_ALLOWED, "方法不允许：" + method + "（允许 " + allowed.join(", ") + "）", {
          method,
          allow: allowed,
        }, { allow: allowed.join(", ") });
      }

      let body;
      if (needsBody === true && isBodyMethod(method)) {
        // ── 2 写操作 Content-Type ─────────────────────────────────────────
        if (!isJsonContentType(req)) {
          const headers = req !== null && typeof req === "object" ? req.headers || {} : {};
          return fail(ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, "content-type 必须是 application/json", {
            contentType: typeof headers["content-type"] === "string" ? headers["content-type"] : null,
          });
        }

        // ── 3 声明长度预检（不读体）────────────────────────────────────────
        const declared = declaredLength(req, limit);
        if (declared.invalid === true) {
          return fail(ERROR_CODES.INVALID_BODY, "Content-Length 不是合法字节数", { declared: declared.raw });
        }
        if (declared.exceeds === true) {
          record("payload-too-large", { message: "声明长度 " + declared.declared + " 超过上限", detail: { declared: declared.declared, limit } });
          return fail(ERROR_CODES.PAYLOAD_TOO_LARGE, "请求体超过上限 " + (limit || 0) + " 字节（声明 " + declared.declared + " 字节）", {
            declared: declared.declared,
            limit,
            read: false,
          }, { connection: "close" });
        }
        if (declared.zero === true) {
          return fail(ERROR_CODES.INVALID_BODY, "请求体为空：需要一个 JSON 对象", { declared: 0 });
        }

        // ── 4 读体 ────────────────────────────────────────────────────────
        let read;
        try {
          read = await readBody(req, { limit });
        } catch (error) {
          if (error instanceof BodyError && error.oversized === true) {
            record("payload-too-large", { message: "读体超限", detail: error.details });
            return fail(ERROR_CODES.PAYLOAD_TOO_LARGE, "请求体超过上限 " + (limit || 0) + " 字节", {
              limit,
              read: "aborted-after-limit",
              bodyAborted: false,
            }, { connection: "close" });
          }
          const detail = error instanceof BodyError ? error.details : undefined;
          record("body-aborted", { message: error && error.message, detail });
          // 客户端可能已经走了；仍然尽力写一个结构化 500 —— 绝不"不发响应"就返回（F67/F68）。
          return fail(ERROR_CODES.INTERNAL, "读取请求体失败（客户端中断或流错误）", {
            reason: BODY_REASONS.ABORTED,
            cause: detail && detail.cause,
          });
        }

        // ── 5 JSON 解析 ───────────────────────────────────────────────────
        if (read.bytes === 0) {
          return fail(ERROR_CODES.INVALID_BODY, "JSON 解析失败：请求体为空", { bytes: 0 });
        }
        let parsed;
        try {
          parsed = JSON.parse(read.text);
        } catch (error) {
          record("invalid-body", { message: error && error.message });
          return fail(ERROR_CODES.INVALID_BODY, "JSON 解析失败：" + clip(read.text, 80), {
            bytes: read.bytes,
            reason: clip(error && error.message, 120),
          });
        }
        if (!isPlainObject(parsed)) {
          record("invalid-body", { message: "请求体不是 JSON 对象", detail: { received: Array.isArray(parsed) ? "array" : typeof parsed } });
          return fail(ERROR_CODES.INVALID_BODY, "请求体必须是 JSON 对象", {
            received: Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed,
          });
        }
        body = parsed;
      }

      // ── 6 鉴权主门与兜底门 ────────────────────────────────────────────
      let admission;
      try {
        admission = typeof api.authenticate === "function" ? api.authenticate(req) : { ok: false, status: 403, code: AUTH_CODES.FORBIDDEN };
      } catch (error) {
        // 鉴权实现自己抛错 = fail-closed（放行是安全事故，拒绝只是多一点噪声）。
        record("auth-rejected", { message: "authenticate threw: " + clip(error && error.message, 200), detail: { failClosed: true } });
        admission = { ok: false, status: 403, code: AUTH_CODES.FORBIDDEN, message: "local trusted request only" };
      }
      if (admission === null || typeof admission !== "object" || admission.ok !== true) {
        const authCode = admission && admission.code === AUTH_CODES.UNAUTHORIZED ? AUTH_CODES.UNAUTHORIZED : AUTH_CODES.FORBIDDEN;
        const authStatus = admission && Number.isFinite(admission.status) ? admission.status : statusOf(authCode, 403);
        record("auth-rejected", { message: (admission && admission.message) || "rejected", detail: admission && admission.details });
        return fail(authCode, (admission && admission.message) || "local trusted request only", admission && admission.details, undefined, authStatus);
      }

      // ── 7 会话解析 ────────────────────────────────────────────────────
      const query = queryOf(req);
      const want = agentParamOf(query);
      let scope = { known: [], agent: undefined, id: undefined };
      if (typeof api.resolveScope === "function") {
        try {
          scope = api.resolveScope(want) || scope;
        } catch (error) {
          record("host-capability-missing", { message: "resolveScope threw: " + clip(error && error.message, 200), detail: { capability: "agents" } });
          scope = { known: [], agent: undefined, id: undefined };
        }
      }
      if (acceptsAgent === true && want !== undefined && (scope.id === undefined || scope.id === null || scope.id === "")) {
        const known = Array.isArray(scope.known) ? scope.known : [];
        const envelope = errorEnvelope(ERROR_CODES.AGENT_NOT_FOUND, "agent not found（会话不存在或已过期）", {
          requested: want,
          agents: known,
        });
        // 旧面板按顶层 error / requested / agents 读（selftest:410-415）：信封照旧，平铺字段同时给。
        envelope.requested = want;
        envelope.agents = known;
        return send(statusOf(ERROR_CODES.AGENT_NOT_FOUND, 404), envelope);
      }

      // ── 8 处理函数执行 ────────────────────────────────────────────────
      if (typeof route.handler !== "function") {
        throw new ControlPlaneError(ERROR_CODES.INTERNAL, "路由没有处理函数：" + routeId, { route: path });
      }
      const result = await route.handler({
        req,
        res,
        body,
        query,
        want,
        agent: scope.agent,
        agentId: scope.id,
        scope,
        route: routeId,
      });
      if (result === undefined || result === null) {
        throw new ControlPlaneError(ERROR_CODES.INTERNAL, "处理函数没有返回结果：" + routeId, { route: path });
      }
      const resultStatus = Number.isFinite(result.status) ? result.status : 200;
      const resultBody = result.body === undefined ? {} : result.body;
      if (result.headers !== undefined) send(resultStatus, resultBody, result.headers);
      else send(resultStatus, resultBody);
      // 2xx 但 ok=false 视为失败（规格明文）：状态码必须与信封一致，否则面板会把失败当成功。
      if (resultStatus >= 200 && resultStatus < 300 && isPlainObject(resultBody) && resultBody.ok === false) {
        record("contract-violation", { message: "2xx 但 ok=false：" + routeId, detail: { status: resultStatus, code: resultBody.code } });
      }
    } catch (error) {
      const isControl = error instanceof ControlPlaneError;
      const codeOfError = isControl && error.code ? error.code : ERROR_CODES.INTERNAL;
      const statusOfError = isControl && Number.isFinite(error.status) ? error.status : 500;
      const summary = stackBrief(error, 4);
      record(codeOfError === ERROR_CODES.INTERNAL ? "internal" : "rejected", {
        message: clip((error && error.message) || error, 300),
        detail: { stack: summary, name: error && error.name, code: codeOfError },
      });
      warn("dsh-gate: " + method + " " + path + " 抛出异常 → " + statusOfError + " " + codeOfError + " — " + clip((error && error.message) || error, 300));
      if (finished === false) {
        // 服务层的 ControlPlaneError 是**已归类**的失败（400/409 等）：原样用它给的消息与 details，
        // 绝不改写成"内部错误"（否则客户端只能看到 500 语义，code 表就白定了）。
        const message = isControl ? String(error.message) : "控制面内部错误：" + clip((error && error.message) || error, 200);
        const details = isControl && error.details !== undefined
          ? Object.assign({ reason: codeOfError }, error.details)
          : { reason: "exception", route: path, name: error && error.name ? String(error.name) : undefined };
        fail(codeOfError, message, details, undefined, statusOfError);
      } else {
        // 已经写过响应：保证连接被合上（绝不留一个未结束的响应，F68）。
        try { if (typeof res?.end === "function") res.end(); } catch { /* 忽略 */ }
      }
    } finally {
      const durationMs = Date.now() - startedAt;
      try {
        metrics?.record?.({ id: routeId, method, path, status, durationMs, code });
      } catch { /* 统计失败不影响请求 */ }
      log("dsh-gate: " + method + " " + path + " → " + status + " (" + durationMs + "ms)" + (code === undefined ? "" : " " + code));
    }
  };
}
