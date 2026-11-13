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
import { resolvePolicy, defaultDshHome, emptyPolicyTemplate, isPlainObject, mergePolicyFile } from "./policy.js";
import { isV3Policy, migrateV2ToV3, normalizeV3Policy } from "./migrate.js";
import { capabilityState } from "./capabilities.js";
import { normalizeServerConfig } from "./mcp.js";

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

export function mountServer(options) {
  const ctx = options.ctx;
  const gate = options.gate;
  const policy = options.policy;
  const logger = options.logger;
  const rawConfig = isPlainObject(options.config) ? options.config : {};

  /**
   * 取一个“闸门真正挂上了”的 agent 来做快照。
   * 不能只信 ctx.agents.roots()：插件根 ctx 上它可能为空（真事故：状态页全 0，看着像没生效）。
   * 以 gate.listAgents() 为准（那就是实际被限制的 agent，已按最近活过排序），再退回 roots()。
   */
  const currentAgent = (want) => {
    try {
      const rows = gate.listAgents();
      // 明确点名（?agent=session-xxx）优先，用于排查多会话进程。
      const wanted = typeof want === "string" && want.length > 0 ? want : undefined;
      if (wanted !== undefined) {
        const hit = rows.find((row) => row.id === wanted);
        return hit === undefined ? undefined : hit.agent;
      }
      // 不能取「第一个挂上的」——那会把别的会话的分层当成当前会话显示
      // （真事故：/state 报的是 22:05 那个恢复会话，活跃会话的 loaded 永远是 []）。
      if (rows.length > 0) return rows[0].agent;
    } catch { /* 忽略 */ }
    try {
      const roots = ctx.agents?.roots?.() || [];
      return roots[0];
    } catch { return undefined; }
  };

  /**
   * 面板状态 = gate.snapshot() 换两个字段名（own / preset）+ 补一份 UI 默认值。
   * 这里不拼任何计量字段 —— 形状与数字口径只在 gate.snapshot 里定义一次。
   */
  const snapshot = (want) => {
    const agent = currentAgent(want);
    const state = gate.snapshot(agent);
    return Object.assign({}, state, {
      // own 层（agent 自己注册、restrict 管不到的）与 preset 平面，UI 靠它分列/打标。
      own: state.ownNames,
      preset: state.presetNames,
      defaults: defaultsOf(),
    });
  };

  /** 当前工具面（迁移判定“悬空键”用）；gate 的公开面里没有就退回 undefined。 */
  const knownNamesOf = (agent) => {
    try {
      if (typeof gate.knownNames !== "function") return undefined;
      const names = gate.knownNames(agent);
      return names instanceof Set ? names : undefined;
    } catch { return undefined; }
  };

  const currentKnownNames = () => knownNamesOf(currentAgent(undefined));

  /**
   * UI 仍按 0.1.8 的字段名读默认层（client/ 是工单 05 的范围，这里不改它）：
   * 老键由 v3 的 defaults 映射出来，新键额外给出；UI 升级后可以只读新键。
   */
  const defaultsOf = () => ({
    toolsDefaultTier: policy.defaults.capability,
    sectionsDefaultTier: policy.defaults.section,
    skillsTier: policy.defaults.skillpack,
    // v2 的「逐工具覆盖」在 v3 里已由能力 + 例外派生，UI 拿不到一份等价表，给空表最诚实。
    toolOverrides: {},
    sectionOverrides: {},
    capabilityDefaultTier: policy.defaults.capability,
    sectionDefaultTier: policy.defaults.section,
    skillpackDefaultTier: policy.defaults.skillpack,
  });

  /** 策略文件的原始内容（不做迁移，保存路径要拿它跟新提交合并）。 */
  const readPolicyFileRaw = () => {
    const file = policy.policyFile;
    if (typeof file !== "string" || file.length === 0) return emptyPolicyTemplate();
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return isPlainObject(parsed) ? parsed : emptyPolicyTemplate();
    } catch {
      // 文件不存在/坏 JSON：给一份“全默认”模板当可编辑起点（坏文件的日志由 resolvePolicy 侧记）。
      return emptyPolicyTemplate();
    }
  };

  /**
   * GET /policy：读回**v3 形状**。
   * v2 文件在这里做一次只读迁移（不写盘、不备份；备份与首次落盘发生在保存/解析时），
   * UI 拿到的永远是 v3，点一次保存就把文件升到 v3。
   */
  /**
   * 内置空模板的规范化形状（UI 的「恢复默认」要一份可整份替换的 v3 内容）。
   * 与 resolvePolicy 的兜底同一份 POLICY_KEYS 生成，不在 UI 里手抄第二份默认值。
   */
  const builtinTemplate = () => normalizeV3Policy(emptyPolicyTemplate()).policy;

  const readPolicyFile = () => {
    const file = policy.policyFile;
    const raw = readPolicyFileRaw();
    if (isV3Policy(raw)) {
      return {
        file: typeof file === "string" ? file : "",
        content: normalizeV3Policy(raw).policy,
        version: 3,
        migrated: false,
        warnings: [],
        template: builtinTemplate(),
      };
    }
    const migrated = migrateV2ToV3(raw, { knownNames: currentKnownNames() });
    return {
      file: typeof file === "string" ? file : "",
      content: migrated.policy,
      version: 3,
      fromVersion: migrated.fromVersion,
      migrated: true,
      warnings: migrated.warnings,
      template: builtinTemplate(),
    };
  };

  /**
   * 0.1.8 的 UI 提交的是 v2 形状（tools/sections/skills）。在 UI 升到 v3 之前，
   * 把这份 v2 提交翻译成 v3 补丁：defaults 逐轴改写、overrides 按能力归并成 capabilities。
   * 只翻译**提交里出现过的**部分，不会用空表把已有能力抹掉。
   */
  const withV2Compat = (base, body) => {
    const hasV2 = isPlainObject(body.tools) || isPlainObject(body.sections) || isPlainObject(body.skills);
    if (!hasV2) return base;
    const patch = migrateV2ToV3({
      version: 2,
      tools: isPlainObject(body.tools) ? body.tools : undefined,
      sections: isPlainObject(body.sections) ? body.sections : undefined,
      skills: isPlainObject(body.skills) ? body.skills : undefined,
    }, { knownNames: currentKnownNames() });
    return mergePolicyFile(base, {
      defaults: patch.policy.defaults,
      capabilities: patch.policy.capabilities,
      legacy: patch.policy.legacy,
    });
  };

  const savePolicyFile = (body) => {
    const file = policy.policyFile;
    if (typeof file !== "string" || file.length === 0) return { ok: false, message: "策略文件路径未配置（config.policyFile 为空）" };
    if (!isPlainObject(body)) return { ok: false, message: "策略必须是 JSON 对象" };
    // 面板的原始 JSON 编辑器与「恢复默认」要能删掉能力/例外，而 mergeCapabilities 只增不减；
    // 因此允许提交方显式带 replace:true 表示「整份替换」（旧面板不传，仍然走安全合并）。
    const replace = body.replace === true;
    const submitted = Object.assign({}, body);
    delete submitted.replace;
    // 旧文件如果是 v2，先整体迁到 v3 再合并，否则保存一次会把老 overrides 整张丢掉。
    const rawCurrent = readPolicyFileRaw();
    const current = isV3Policy(rawCurrent) ? rawCurrent : migrateV2ToV3(rawCurrent, { knownNames: currentKnownNames() }).policy;
    let merged;
    if (replace) {
      // 提交的是 v2 形状时先翻译；v3 形状原样作为整份文件（normalize 会补默认键）。
      merged = isV3Policy(submitted) ? submitted : migrateV2ToV3(submitted, { knownNames: currentKnownNames() }).policy;
    } else {
      merged = mergePolicyFile(current, submitted);
      merged = withV2Compat(merged, submitted);
    }
    merged.version = 3;
    const final = normalizeV3Policy(merged).policy;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // 按字节写无 BOM UTF-8（红线：BOM 会炸宿主 JSON 解析）。v3 规范化保证键序固定。
      fs.writeFileSync(file, Buffer.from(JSON.stringify(final, null, 2) + "\n", "utf8"));
    } catch (error) {
      return { ok: false, message: "写入失败: " + String((error && error.message) || error) };
    }
    // 重新解析时必须带插件行 config，否则行上自定义的 policyFile/overrides/protected 会被清空。
    const next = resolvePolicy(rawConfig, { logger, dshHome: defaultDshHome(), knownNames: currentKnownNames() });
    Object.assign(policy, next);
    for (const row of gate.listAgents()) {
      try { gate.reapply(row.agent); } catch { /* 忽略 */ }
    }
    return { ok: true, state: snapshot() };
  };

  // ── MCP 接管（0.3.0 工单 15）：声明、自挂、外部只读，全部经 gate.mcpManager ──────────
  /** gate.json 里声明的 server（归一后的形状；没有就是空表）。 */
  const declaredMcpServers = () => {
    const mcp = policy.mcp;
    return isPlainObject(mcp) && isPlainObject(mcp.servers) ? mcp.servers : {};
  };

  /** 展示地址：stdio 用 command，streamable-http 用 url。 */
  const mcpTargetOf = (config) => {
    const source = isPlainObject(config) ? config : {};
    return source.transport === "streamable-http" ? String(source.url || "") : String(source.command || "");
  };

  /** 策略归一丢弃的 MCP 坏条目（resolvePolicy 已写日志，这里回给 UI 一份）。 */
  const mcpWarnings = () => {
    const rows = Array.isArray(policy.warnings) ? policy.warnings : [];
    return rows
      .filter((row) => row && typeof row.code === "string" && row.code.startsWith("invalid-mcp"))
      .map((row) => String(row.message || row.code));
  };

  /**
   * UI/GET 的服务器清单 = 运行时行（owned + external）+ 声明了但没挂上的（state:"stopped"）。
   * 只读：不 mount、不 dispose、不改 gate.json。
   */
  const mcpServers = (agent) => {
    const warnings = mcpWarnings();
    const rows = [];
    try {
      if (gate.mcpManager && typeof gate.mcpManager.list === "function") {
        for (const row of gate.mcpManager.list(agent) || []) rows.push(row);
      }
    } catch (error) {
      warnings.push("读取 MCP 运行时状态失败 — " + String((error && error.message) || error));
    }
    const seen = new Set(rows.map((row) => row && row.name));
    for (const [name, config] of Object.entries(declaredMcpServers())) {
      if (seen.has(name)) continue;
      seen.add(name);
      rows.push({
        name,
        transport: typeof config.transport === "string" ? config.transport : "stdio",
        target: mcpTargetOf(config),
        state: "stopped",
        enabled: config.enabled !== false,
        owned: false,
        toolCount: 0,
      });
    }
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return { servers: rows, warnings };
  };

  /** 提交里带的是 server 声明（add/update）还是纯动作参数。 */
  const mcpConfigOf = (body) => (isPlainObject(body.server) ? body.server : body.config);

  const handleMcpPost = async (req, res) => {
    if (!isJsonRequest(req)) return writeJson(res, 415, { ok: false, message: "content-type 必须是 application/json" });
    const body = await readJsonBody(req);
    if (!isPlainObject(body)) return writeJson(res, 400, { ok: false, message: "JSON 解析失败" });
    const action = body.action;
    if (!["add", "update", "remove", "enable", "disable"].includes(action)) {
      return writeJson(res, 400, { ok: false, message: "action 只能是 add / update / remove / enable / disable" });
    }
    if (policy.enabled === false) return writeJson(res, 409, { ok: false, message: "闸门未启用（enabled=false），不接管 MCP" });
    const manager = gate.mcpManager;
    if (!manager) return writeJson(res, 409, { ok: false, message: "MCP 接管不可用（manager 不存在）" });
    const name = body.name;
    if (typeof name !== "string" || name.length === 0) return writeJson(res, 400, { ok: false, message: "name 必须是非空字符串" });

    const servers = Object.assign({}, declaredMcpServers());
    const mounted = new Set();
    try {
      if (typeof manager.list === "function") {
        for (const row of manager.list() || []) if (row && row.owned === true) mounted.add(row.name);
      }
    } catch { /* 读不到就当未挂，下一步 mount 会给出准确冲突 */ }
    const isMounted = mounted.has(name) || (typeof manager.state === "function" && manager.state(name) !== undefined);

    const finish = (extra) => {
      const latest = mcpServers();
      return writeJson(res, 200, Object.assign({ ok: true, action, name, servers: latest.servers, warnings: latest.warnings }, extra));
    };

    if (action === "add" || action === "update") {
      if (action === "add" && (servers[name] !== undefined || isMounted)) {
        return writeJson(res, 409, { ok: false, message: "MCP server \"" + name + "\" 已存在（改用 update）" });
      }
      if (action === "update" && servers[name] === undefined && !isMounted) {
        return writeJson(res, 404, { ok: false, message: "MCP server \"" + name + "\" 不存在" });
      }
      let normalized;
      try {
        normalized = normalizeServerConfig(name, mcpConfigOf(body));
      } catch (error) {
        return writeJson(res, 400, { ok: false, code: error && error.code, message: String((error && error.message) || error) });
      }
      const { name: _ignored, ...stored } = normalized;
      servers[name] = stored;
      const saved = savePolicyFile({ mcp: { servers } });
      if (!saved.ok) return writeJson(res, 500, saved);
      let result;
      try {
        result = action === "update" && isMounted ? await manager.update(name, stored) : await manager.mount(name, stored);
      } catch (error) {
        result = { ok: false, name, reason: "exception", message: String((error && error.message) || error) };
      }
      try { gate.reapplyAll?.(); } catch { /* 忽略 */ }
      return finish({ result });
    }

    if (action === "remove") {
      if (servers[name] === undefined && !isMounted) {
        return writeJson(res, 404, { ok: false, message: "MCP server \"" + name + "\" 不存在" });
      }
      delete servers[name];
      const saved = savePolicyFile({ mcp: { servers } });
      if (!saved.ok) return writeJson(res, 500, saved);
      let result;
      try {
        result = await manager.unmount(name);
        if (!result.ok) result = { ok: true, name, state: "stopped", note: result.reason };
      } catch (error) {
        result = { ok: false, name, reason: "exception", message: String((error && error.message) || error) };
      }
      try { gate.reapplyAll?.(); } catch { /* 忽略 */ }
      return finish({ result });
    }

    // enable / disable
    if (servers[name] === undefined) {
      return writeJson(res, 404, { ok: false, message: "MCP server \"" + name + "\" 未声明（先 add）" });
    }
    const enabled = action === "enable";
    servers[name] = Object.assign({}, servers[name], { enabled });
    const saved = savePolicyFile({ mcp: { servers } });
    if (!saved.ok) return writeJson(res, 500, saved);
    let result;
    try {
      if (enabled) {
        result = isMounted
          ? { ok: true, name, state: "owned", note: "already-mounted" }
          : await manager.mount(name, servers[name]);
      } else {
        const unmounted = await manager.unmount(name);
        result = unmounted.ok ? unmounted : { ok: true, name, state: "stopped", note: unmounted.reason };
      }
    } catch (error) {
      result = { ok: false, name, reason: "exception", message: String((error && error.message) || error) };
    }
    try { gate.reapplyAll?.(); } catch { /* 忽略 */ }
    return finish({ result });
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
          const known = gate.listAgents().map((row) => row.id).sort();
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
    {
      // MCP 接管（0.3.0 工单 15）：GET 看清单，POST 做 add/update/remove/enable/disable。
      // 写路径复用 /policy 的保存逻辑（表驱动合并 + 无 BOM 落盘 + 重新解析策略）。
      kind: "exact",
      path: "/api/dsh-gate/mcp",
      handler: async (req, res) => {
        const gateResult = authorize(req);
        if (!gateResult.ok) return writeJson(res, gateResult.status, { error: gateResult.error });
        if (req.method === "POST") return handleMcpPost(req, res);
        const body = mcpServers(currentAgent(undefined));
        writeJson(res, 200, body);
      },
    },
    {
      // 能力视图（0.2.0）：单独一条查询，不挤进 /state 的固定形状。
      kind: "exact",
      path: "/api/dsh-gate/capabilities",
      handler: async (req, res) => {
        const gateResult = authorize(req);
        if (!gateResult.ok) return writeJson(res, gateResult.status, { error: gateResult.error });
        let want;
        try { want = new URL(req.url || "/", "http://localhost").searchParams.get("agent") || undefined; } catch { want = undefined; }
        const agent = currentAgent(want);
        if (agent === undefined || agent === null) {
          if (want !== undefined) {
            const known = gate.listAgents().map((row) => row.id).sort();
            return writeJson(res, 404, { error: "agent not found", requested: want, agents: known });
          }
          return writeJson(res, 200, Object.assign({ agent: null }, capabilityState(policy, {})));
        }
        const id = String(agent.id || "");
        if (typeof gate.capabilityView !== "function") return writeJson(res, 200, Object.assign({ agent: id }, capabilityState(policy, {})));
        writeJson(res, 200, Object.assign({ agent: id }, gate.capabilityView(agent)));
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
