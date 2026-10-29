/**
 * 给 UI 用的本地 HTTP 接口。
 *  - GET  /api/dsh-gate/state   → 当前分层快照（UI 列表 + 预算）
 *  - GET  /api/dsh-gate/policy  → 策略文件原文
 *  - POST /api/dsh-gate/policy  → 写回策略并立刻重算（无 BOM，按字节写）
 *
 * 安全模型（2026-10-29 二审修）：
 * 这是插件自己注册在宿主 webServer 上的 **精确路由**，会先于宿主的 SPA/认证处理器命中，
 * 所以必须自己把门。两道：
 *  第一道（主门，2026-10-29 补）：借宿主的 connection 服务
 *    `connection.requestRejection(req)` —— 它内部是 isTrustedApiRequest（Host/Origin/sec-fetch-site 围栏）
 *    + browserAuth（launch token / dsh-auth-<sha256(authority)> 签名 cookie）的完整校验。
 *    本机任意进程（curl、脚本、其它 GUI 页面）没有这个签名 cookie 直接 401 —— 这是 R1 的修法。
 *  第二道（回退，宿主没提供 connection 服务时才走）：自家四道门
 *    ① 只允许回环来源（req.socket.remoteAddress，含 ::ffff:127.0.0.1）
 *    ② Host 头必须是回环名（防 DNS rebinding：rebind 后浏览器把 evil.com 解析到 127.0.0.1，
 *       socket 看着是本机，Host 头却写着 evil.com）
 *    ③ Origin / Sec-Fetch-Site 必须是同源（防跨站 text/plain 简单请求直接改策略）
 *    ④ POST 必须是 application/json（强制预检，简单请求伪造不进来）
 */
import fs from "node:fs";
import path from "node:path";
import { resolvePolicy, defaultDshHome } from "./policy.js";

const MAX_BODY_BYTES = 512 * 1024;
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const writeJson = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
};

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
 * 解析宿主的 connection 服务（dsh-client-connection 提供的 HostConnectionService）。
 * 官方面板走 `ctx.get(name)`，cordis 还提供 `ctx.reflect.get(name, false)` 的非抛错读法；
 * 两条都试，拿不到就退回自家四道门。
 */
export const resolveService = (ctx, name) => {
  try {
    if (ctx !== null && ctx !== undefined && typeof ctx.get === "function") {
      const found = ctx.get(name);
      if (found !== undefined && found !== null) return found;
    }
  } catch { /* 忽略 */ }
  try {
    if (ctx !== null && ctx !== undefined && ctx.reflect && typeof ctx.reflect.get === "function") {
      const found = ctx.reflect.get(name, false);
      if (found !== undefined && found !== null) return found;
    }
  } catch { /* 忽略 */ }
  return undefined;
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

const isJsonRequest = (req) => {
  const type = req.headers["content-type"];
  if (typeof type !== "string") return false;
  return type.split(";")[0].trim().toLowerCase() === "application/json";
};

const readJsonBody = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
};

const emptyPolicyFile = {
  version: 2,
  enabled: true,
  tools: { defaultTier: 2, overrides: {} },
  sections: { defaultTier: 1, overrides: {} },
  skills: { tier: 1 },
  catalog: { groupByPlugin: true, maxDescriptionLength: 64 },
};

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * 浅合并：保存只带 version/enabled/tools/sections/skills 时，别把 catalog / protected
 * 之类的字段整块抹掉（真事故：点一次“保存策略”就把 catalog 与 protected 静默删了）。
 */
const mergePolicy = (current, incoming) => {
  const base = isPlainObject(current) ? current : {};
  const next = isPlainObject(incoming) ? incoming : {};
  const out = Object.assign({}, base);
  if (next.version !== undefined) out.version = next.version;
  if (typeof next.enabled === "boolean") out.enabled = next.enabled;
  for (const key of ["tools", "sections", "skills", "catalog"]) {
    if (next[key] === undefined) continue;
    if (!isPlainObject(next[key])) continue;
    const merged = Object.assign({}, isPlainObject(base[key]) ? base[key] : {}, next[key]);
    if (isPlainObject(next[key].overrides) || isPlainObject(base[key] && base[key].overrides)) {
      merged.overrides = Object.assign(
        {},
        isPlainObject(base[key] && base[key].overrides) ? base[key].overrides : {},
        isPlainObject(next[key].overrides) ? next[key].overrides : {},
      );
    }
    out[key] = merged;
  }
  if (Array.isArray(next.protected)) out.protected = next.protected;
  return out;
};

export function mountServer(options) {
  const ctx = options.ctx;
  const gate = options.gate;
  const policy = options.policy;
  const logger = options.logger;
  const rawConfig = isPlainObject(options.config) ? options.config : {};

  /**
   * 取一个“闸门真正挂上了”的 agent 来做快照。
   * 不能只信 ctx.agents.roots()：插件根 ctx 上它可能为空（真事故：状态页全 0，看着像没生效）。
   * 以 gate.entries 为准（那就是实际被限制的 agent），再退回 roots()。
   */
  const currentAgent = (want) => {
    try {
      const list = [...gate.entries.entries()];
      // 明确点名（?agent=session-xxx）优先，用于排查多会话进程。
      const wanted = typeof want === "string" && want.length > 0 ? want : undefined;
      if (wanted !== undefined) {
        for (const [agent] of list) if (String((agent && agent.id) || "") === wanted) return agent;
        return undefined;
      }
      // 多会话进程里 entries 是「谁先挂上谁在前」，不能取第一个——那会把别的会话的分层
      // 当成当前会话显示（真事故：/state 报的是 22:05 那个恢复会话，活跃会话的 loaded 永远是 []）。
      // 取最近一次 reapply/attach 的那个（touchedAt 由 gate 侧维护）。
      if (list.length > 0) {
        let best = list[0][0];
        let bestAt = -1;
        for (const [agent, entry] of list) {
          const at = Number(entry && entry.touchedAt) || 0;
          if (at >= bestAt) { bestAt = at; best = agent; }
        }
        return best;
      }
    } catch { /* 忽略 */ }
    try {
      const roots = ctx.agents?.roots?.() || [];
      return roots[0];
    } catch { return undefined; }
  };

  const snapshot = (want) => {
    const agent = currentAgent(want);
    if (agent === undefined) {
      return {
        enabled: policy.enabled !== false,
        policyFile: policy.policyFile,
        agent: null,
        resident: 0,
        onDemand: 0,
        off: 0,
        residentNames: [],
        onDemandNames: [],
        offNames: [],
        own: [],
        preset: [],
        tiers: {},
        loaded: [],
        catalogTokens: 0,
        visible: 0,
        defaults: defaultsOf(),
      };
    }
    const status = gate.status(agent);
    const entry = gate.entries.get(agent);
    const skills = entry && Array.isArray(entry.skills) ? entry.skills.map((s) => s.name) : [];
    let tiers = {};
    try { tiers = gate.tierMap(agent).tiers; } catch { tiers = {}; }
    return {
      enabled: policy.enabled !== false,
      policyFile: policy.policyFile,
      agent: String(agent.id || ""),
      visible: status.visible,
      // 数字口径（HANDOFF 第 4 节 C2 与文档承诺的 stable 形状）
      resident: status.resident,
      onDemand: status.onDemand,
      off: status.off.length,
      // 名字口径（UI 分列与调试用）
      residentNames: status.residentNames,
      onDemandNames: status.onDemandNames,
      offNames: status.offNames,
      // own 层（agent 自己注册、restrict 管不到的）与权威归层表，UI 靠它分列，不再靠猜。
      own: status.ownNames,
      // preset 平面（agent preset 注册、默认不受管，点名才生效）——UI 用它打标。
      preset: status.presetNames,
      tiers,
      loaded: status.loaded,
      gated: status.gated,
      catalogChars: status.catalogChars,
      catalogTokens: status.catalogTokens,
      skills,
      sections: status.sections,
      defaults: defaultsOf(),
    };
  };

  const defaultsOf = () => ({
    toolsDefaultTier: policy.tools.defaultTier,
    sectionsDefaultTier: policy.sections.defaultTier,
    skillsTier: policy.skills.tier,
    toolOverrides: policy.tools.overrides,
    sectionOverrides: policy.sections.overrides,
  });

  const readPolicyFile = () => {
    const file = policy.policyFile;
    if (typeof file !== "string" || file.length === 0) return { file: "", content: emptyPolicyFile };
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      return { file, content: isPlainObject(parsed) ? parsed : emptyPolicyFile };
    } catch {
      // 文件不存在时给一份“全默认”模板；文件坏由 resolvePolicy 侧记日志（这里只给 UI 一个可编辑起点）。
      return { file, content: emptyPolicyFile };
    }
  };

  const savePolicyFile = (body) => {
    const file = policy.policyFile;
    if (typeof file !== "string" || file.length === 0) return { ok: false, message: "策略文件路径未配置（config.policyFile 为空）" };
    if (!isPlainObject(body)) return { ok: false, message: "策略必须是 JSON 对象" };
    const current = readPolicyFile().content;
    const merged = mergePolicy(current, body);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // 按字节写无 BOM UTF-8（红线：BOM 会炸宿主 JSON 解析）
      fs.writeFileSync(file, Buffer.from(JSON.stringify(merged, null, 2) + "\n", "utf8"));
    } catch (error) {
      return { ok: false, message: "写入失败: " + String((error && error.message) || error) };
    }
    // 重新解析时必须带插件行 config，否则行上自定义的 policyFile/overrides/protected 会被清空。
    const next = resolvePolicy(rawConfig, { logger, dshHome: defaultDshHome() });
    Object.assign(policy, next);
    for (const agent of [...gate.entries.keys()]) {
      try { gate.reapply(agent); } catch { /* 忽略 */ }
    }
    return { ok: true, state: snapshot() };
  };

  let warnedFallback = false;

  /** 宿主鉴权优先，宿主没装 connection 服务时回退自家四道门。 */
  const authorize = (req) => {
    const admission = hostAdmission(ctx, req);
    if (admission.checked) {
      if (admission.rejection === undefined) return { ok: true };
      if (admission.rejection === 403) return { ok: false, status: 403, error: "local trusted request only" };
      return { ok: false, status: 401, error: "browser session required (dsh web token/cookie)" };
    }
    if (!warnedFallback) {
      warnedFallback = true;
      try { logger?.warn?.("dsh-gate: 宿主 connection 服务不可用，/api/dsh-gate/* 退回本地四道门（不含浏览器会话认证）"); } catch { /* 忽略 */ }
    }
    if (!isTrustedRequest(req)) return { ok: false, status: 403, error: "local trusted request only" };
    return { ok: true };
  };

  const routes = [
    {
      kind: "exact",
      path: "/api/dsh-gate/state",
      handler: async (req, res) => {
        const gateResult = authorize(req);
        if (!gateResult.ok) return writeJson(res, gateResult.status, { error: gateResult.error });
        let want;
        try { want = new URL(req.url || "/", "http://localhost").searchParams.get("agent") || undefined; } catch { want = undefined; }
        const body = snapshot(want);
        if (want !== undefined && body.agent === null) {
          const known = [...gate.entries.keys()].map((agent) => String((agent && agent.id) || ""));
          return writeJson(res, 404, { error: "agent not found", requested: want, agents: known });
        }
        writeJson(res, 200, body);
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-gate/policy",
      handler: async (req, res) => {
        const gateResult = authorize(req);
        if (!gateResult.ok) return writeJson(res, gateResult.status, { error: gateResult.error });
        if (req.method === "POST") {
          if (!isJsonRequest(req)) return writeJson(res, 415, { ok: false, message: "content-type 必须是 application/json" });
          const body = await readJsonBody(req);
          if (body === undefined) return writeJson(res, 400, { ok: false, message: "JSON 解析失败" });
          return writeJson(res, 200, savePolicyFile(body));
        }
        writeJson(res, 200, readPolicyFile());
      },
    },
  ];

  ctx.inject(["webServer"], (sctx) => {
    const disposers = [];
    for (const route of routes) {
      try { disposers.push(sctx.webServer.register(route)); }
      catch (error) { try { logger?.warn?.("dsh-gate: 注册路由失败 " + route.path + " — " + String((error && error.message) || error)); } catch { /* 忽略 */ } }
    }
    return () => { for (const dispose of disposers) { try { dispose(); } catch { /* 忽略 */ } } };
  });

  return () => undefined;
}
