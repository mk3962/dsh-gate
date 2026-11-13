/**
 * MCP 接管核心（0.3.0，票 15 / M1-core）。
 *
 * 依据《docs/dsh-gate-0.3.0-15-mcp客户端挂载调研.md》核实过的一手 API：
 *  - 宿主没有 MCP 管理 API，唯一合法的运行期挂载是「插件自己 ctx.plugin(mcp-client, cfg)」；
 *    一个实例连一个 server，dispose = 断开连接 + 注销全部工具 + 释放 serverName 命名空间。
 *    **绝不 dispose 宿主自己的 mcp-client 行**（loader 会把该行写 disabled:true）。
 *  - mcp-client 是命名空间插件（无 default export），只能经 ctx.loader.import 取到：
 *    gate 装在 profile/node_modules，裸 import 解析不到 asar 里的包。
 *  - 连接态没有公开 API：连上之后工具才注册，所以「挂上但工具为空」= 连不上/重连中/服务器没工具，
 *    记为 unavailable 并告警，但**保持挂载**（failOnStartupError=false 时 apply 不抛，重连由 mcp-client 自己管）。
 *
 * 本模块只做 M1-core：纯校验函数 + 一个自挂 manager。不碰 gate 主链路、不改 profile、不读宿主行状态。
 * 运行时失败一律降级成结果对象 + 告警，不向调用方抛错；只有 normalizeServerConfig / toPluginConfig
 * 这两个纯校验函数会抛带 code 的 Error（ToolArgs 风格），由 manager 转成 {ok:false}。
 */

/** mcp-client 的包名（经 ctx.loader.import 解析）。 */
export const MCP_CLIENT_MODULE = "@deepseek-ai/dsh-mcp-client";

/** serverName 语法：与 mcp-client Config 的约束逐字一致（MC:768）。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** 工具名命名空间：mcp__<serverName>__<rawName>（MC:96-110），也是冲突检测的依据。 */
export const TOOL_PREFIX = "mcp__";

const toolPrefixOf = (name) => TOOL_PREFIX + name + "__";

/** 带 code 的配置错误（ToolArgs 风格：Error + 稳定 code）。 */
const configError = (code, message) => {
  const error = new Error(message);
  error.name = "McpConfigError";
  error.code = code;
  return error;
};

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const messageOf = (error) => {
  if (error === undefined || error === null) return "unknown";
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 0 ? text : "unknown";
};

const stringArray = (value, field, code) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw configError(code, field + " 必须是字符串数组");
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") throw configError(code, field + " 必须是字符串数组");
    out.push(item);
  }
  return out;
};

const stringDict = (value, field, code) => {
  if (value === undefined) return {};
  if (!isRecord(value)) throw configError(code, field + " 必须是对象（值全为字符串）");
  const out = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (typeof item !== "string") throw configError(code, field + "." + key + " 必须是字符串");
    out[key] = item;
  }
  return out;
};

const positiveNumber = (value, field) => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw configError("invalid-number", field + " 必须是正数");
  return value;
};

const positiveInteger = (value, field) => {
  const number = positiveNumber(value, field);
  if (number !== undefined && !Number.isInteger(number)) throw configError("invalid-number", field + " 必须是正整数");
  return number;
};

/**
 * 校验并规范化一条 server 声明（gate.json 里 mcp.servers[name] 的形状）。
 *
 * @param {string} name serverName，必须匹配 /^[A-Za-z0-9_-]{1,32}$/
 * @param {object} raw 原始声明：transport 省略按 stdio；stdio 要 command；streamable-http 要 url
 * @returns {{name:string, transport:"stdio"|"streamable-http", enabled:boolean,
 *   command?:string, args?:string[], env?:Record<string,string>, cwd?:string,
 *   url?:string, headers?:Record<string,string>,
 *   toolCallTimeoutMs?:number, maxInstructionBytes?:number}}
 * @throws {Error & {code:string}} code ∈ invalid-server-name / invalid-config / invalid-transport /
 *   invalid-enabled / missing-command / invalid-args / invalid-env / invalid-cwd /
 *   missing-url / invalid-url / invalid-headers / invalid-number
 */
export function normalizeServerConfig(name, raw) {
  if (typeof name !== "string" || !SERVER_NAME_PATTERN.test(name)) {
    throw configError("invalid-server-name", "MCP serverName 必须匹配 " + SERVER_NAME_PATTERN.source + "，实际: " + JSON.stringify(name));
  }
  if (!isRecord(raw)) throw configError("invalid-config", "MCP server \"" + name + "\" 的配置必须是对象");
  const transport = raw.transport === undefined ? "stdio" : raw.transport;
  if (transport !== "stdio" && transport !== "streamable-http") {
    throw configError("invalid-transport", "MCP server \"" + name + "\" 的 transport 只能是 \"stdio\" 或 \"streamable-http\"，实际: " + JSON.stringify(transport));
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw configError("invalid-enabled", "MCP server \"" + name + "\" 的 enabled 必须是布尔值");
  }

  const normalized = { name, transport, enabled: raw.enabled !== false };
  const timeout = positiveNumber(raw.toolCallTimeoutMs, "toolCallTimeoutMs");
  if (timeout !== undefined) normalized.toolCallTimeoutMs = timeout;
  const maxInstructions = positiveInteger(raw.maxInstructionBytes, "maxInstructionBytes");
  if (maxInstructions !== undefined) normalized.maxInstructionBytes = maxInstructions;

  if (transport === "stdio") {
    if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
      throw configError("missing-command", "MCP server \"" + name + "\"（stdio）需要非空 command");
    }
    const cwd = raw.cwd === undefined ? "" : raw.cwd;
    if (typeof cwd !== "string") throw configError("invalid-cwd", "MCP server \"" + name + "\" 的 cwd 必须是字符串");
    normalized.command = raw.command.trim();
    normalized.args = stringArray(raw.args, "args", "invalid-args");
    normalized.env = stringDict(raw.env, "env", "invalid-env");
    normalized.cwd = cwd;
    return normalized;
  }

  if (typeof raw.url !== "string" || raw.url.trim().length === 0) {
    throw configError("missing-url", "MCP server \"" + name + "\"（streamable-http）需要非空 url");
  }
  const url = raw.url.trim();
  let parsed;
  try { parsed = new URL(url); }
  catch { throw configError("invalid-url", "MCP server \"" + name + "\" 的 url 不是合法 URL: " + JSON.stringify(url)); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw configError("invalid-url", "MCP server \"" + name + "\" 的 url 只支持 http/https: " + JSON.stringify(url));
  }
  normalized.url = url;
  normalized.headers = stringDict(raw.headers, "headers", "invalid-headers");
  return normalized;
}

/**
 * 规范化配置 → mcp-client 的 Config 形状。enabled 是 gate 自己的声明位，不进插件配置。
 * failOnStartupError 恒为 false：连接失败只降级成 unavailable，不能让挂载抛错打断 gate apply。
 *
 * @param {string} name
 * @param {object} config normalizeServerConfig 的输出（或等价形状）
 * @returns {object} {transport, serverName, failOnStartupError:false, ...transport 字段}
 */
export function toPluginConfig(name, config) {
  const source = isRecord(config) ? config : {};
  const serverName = typeof name === "string" && name.length > 0 ? name : source.name;
  if (typeof serverName !== "string" || serverName.length === 0) {
    throw configError("invalid-server-name", "toPluginConfig 需要 serverName");
  }
  const transport = source.transport === undefined ? "stdio" : source.transport;
  if (transport !== "stdio" && transport !== "streamable-http") {
    throw configError("invalid-transport", "transport 只能是 \"stdio\" 或 \"streamable-http\"，实际: " + JSON.stringify(transport));
  }

  const out = { transport, serverName, failOnStartupError: false };
  if (transport === "stdio") {
    out.command = typeof source.command === "string" ? source.command : "";
    out.args = Array.isArray(source.args) ? source.args.filter((item) => typeof item === "string") : [];
    out.env = stringDict(source.env, "env", "invalid-env");
    out.cwd = typeof source.cwd === "string" ? source.cwd : "";
  } else {
    out.url = typeof source.url === "string" ? source.url : "";
    out.headers = stringDict(source.headers, "headers", "invalid-headers");
  }
  if (typeof source.toolCallTimeoutMs === "number" && Number.isFinite(source.toolCallTimeoutMs) && source.toolCallTimeoutMs > 0) {
    out.toolCallTimeoutMs = source.toolCallTimeoutMs;
  }
  if (typeof source.maxInstructionBytes === "number" && Number.isInteger(source.maxInstructionBytes) && source.maxInstructionBytes > 0) {
    out.maxInstructionBytes = source.maxInstructionBytes;
  }
  return out;
}

/** 行里的服务器展示地址：stdio 用 command，http 用 url。 */
const targetOf = (config) => {
  const source = isRecord(config) ? config : {};
  if (source.transport === "streamable-http") return typeof source.url === "string" ? source.url : "";
  return typeof source.command === "string" ? source.command : "";
};

/** ctx.plugin 接受的形状：函数，或带 apply 的对象（ESM 命名空间可能被 default 包一层）。 */
const pluginOf = (moduleNamespace) => {
  if (typeof moduleNamespace === "function") return moduleNamespace;
  if (moduleNamespace && typeof moduleNamespace.apply === "function") return moduleNamespace;
  if (moduleNamespace && moduleNamespace.default) {
    const inner = moduleNamespace.default;
    if (typeof inner === "function") return inner;
    if (inner && typeof inner.apply === "function") return inner;
  }
  return undefined;
};

/**
 * 自挂 MCP manager：一次一个 server（mcp-client 的语义），对 gate 暴露稳定的结果对象。
 *
 * @param {{ctx:object, logger?:{warn?:Function, info?:Function, debug?:Function}}} options
 * @returns {{mount:Function, unmount:Function, update:Function, list:Function, state:Function, disposeAll:Function}}
 */
export function createMcpManager(options) {
  const opts = options || {};
  const ctx = opts.ctx;
  const logger = opts.logger;
  /** @type {Map<string, {name:string, config:object, fiber:any, state:string, warning?:string}>} */
  const owned = new Map();

  const warn = (message) => {
    try {
      if (logger && typeof logger.warn === "function") logger.warn("dsh-gate mcp: " + message);
    } catch { /* 记日志失败不影响结果对象 */ }
  };

  const viewOf = (scope) => {
    try {
      if (ctx === null || ctx === undefined || !ctx.tools || typeof ctx.tools.view !== "function") return undefined;
      return ctx.tools.view(scope);
    } catch { return undefined; }
  };

  /** 可见工具名列表；宿主没给 view 或形状不认识时返回 undefined（调用方降级为 0/不判冲突）。 */
  const visibleNames = (scope) => {
    const view = viewOf(scope);
    if (view === undefined || view === null) return undefined;
    const visible = view.visible;
    const names = [];
    const push = (item) => {
      const name = typeof item === "string" ? item : item && typeof item.name === "string" ? item.name : undefined;
      if (name !== undefined) names.push(name);
    };
    try {
      if (visible && typeof visible.keys === "function") { for (const key of visible.keys()) push(key); }
      else if (visible && typeof visible[Symbol.iterator] === "function") { for (const item of visible) push(item); }
      else return undefined;
    } catch { return undefined; }
    return names;
  };

  /** 注册过的名字（restriction 不影响）：冲突检测的稳定来源。 */
  const knownNames = (scope) => {
    const view = viewOf(scope);
    if (view === undefined || view === null) return undefined;
    const known = view.knownNames;
    if (known instanceof Set) return known;
    if (known && typeof known[Symbol.iterator] === "function" && typeof known.has !== "function") return new Set(known);
    return undefined;
  };

  const countTools = (scope, name) => {
    // 优先数“注册过”的名字：restriction 只影响 visible，不影响注册；面板在没有活跃会话时
    // 拿到的是全局 knownNames，用 visible 会把已挂上的 MCP 工具数误报成 0（真机复现）。
    const known = knownNames(scope);
    const pool = known !== undefined ? known : visibleNames(scope);
    if (pool === undefined) return 0;
    const prefix = toolPrefixOf(name);
    let count = 0;
    for (const tool of pool) if (tool.startsWith(prefix)) count += 1;
    return count;
  };

  /** loader 行（generator / 数组都认）；读不到就当空表，不抛。 */
  const loaderRows = () => {
    try {
      if (!ctx || !ctx.loader || typeof ctx.loader.entries !== "function") return [];
      const rows = ctx.loader.entries();
      if (rows === undefined || rows === null) return [];
      return Array.from(rows);
    } catch { return []; }
  };

  const isMcpClientRow = (entry) => {
    const name = entry && entry.options && entry.options.name;
    return typeof name === "string" && name.includes("dsh-mcp-client");
  };

  /**
   * 外部托管的 mcp-client 行（只观察，不 dispose、不改 config）。
   * 与我们自己挂的 fiber 按身份排除；同 serverName 的也不重复列。
   */
  const externalRows = (scope) => {
    const ours = new Set();
    for (const row of owned.values()) if (row.fiber !== undefined && row.fiber !== null) ours.add(row.fiber);
    const rows = [];
    for (const entry of loaderRows()) {
      if (!isMcpClientRow(entry)) continue;
      if (entry.fiber !== undefined && entry.fiber !== null && ours.has(entry.fiber)) continue;
      const rawConfig = entry.options.config;
      const config = isRecord(rawConfig) ? rawConfig : {};
      if (typeof config.serverName !== "string" || config.serverName.length === 0) continue;
      if (owned.has(config.serverName)) continue;
      const transport = typeof config.transport === "string" ? config.transport : "unknown";
      const disabled = Boolean(entry.options.disabled);
      rows.push({
        name: config.serverName,
        transport,
        target: targetOf({ transport, command: config.command, url: config.url }),
        state: "external",
        enabled: !disabled,
        owned: false,
        toolCount: countTools(scope, config.serverName),
      });
    }
    return rows;
  };

  /**
   * 挂一个 server。冲突/模块缺失/启动失败都返回 {ok:false}，不抛。
   *
   * 注意：await 会等到 mcp-client 的初始连接结算（apply 内部 await connection.ready）。
   * gate apply 里挂多个 server 时请并发（Promise.all），不要串行等待网络。
   *
   * @param {string} name
   * @param {object} rawConfig gate.json 里的声明
   * @returns {Promise<object>} 成功 {ok:true,name,state,target,transport,toolCount,warning?}；
   *   失败 {ok:false,name,reason,message,...}，reason ∈ invalid / disabled / conflict / module / mount / startup
   */
  const mount = async (name, rawConfig) => {
    let config;
    try {
      config = normalizeServerConfig(name, rawConfig);
    } catch (error) {
      const message = "MCP server 声明非法：" + messageOf(error);
      warn(message);
      return { ok: false, name, reason: "invalid", code: error && error.code, message };
    }
    if (config.enabled === false) {
      return { ok: false, name, reason: "disabled", message: "MCP server \"" + name + "\" 在配置里 enabled=false，不挂载" };
    }
    if (owned.has(name)) {
      return { ok: false, name, reason: "conflict", detail: "mounted", message: "MCP server \"" + name + "\" 已经挂载过（先 unmount/update）" };
    }
    const known = knownNames(undefined);
    if (known !== undefined) {
      const prefix = toolPrefixOf(name);
      const collided = [];
      for (const tool of known) if (tool.startsWith(prefix)) collided.push(tool);
      if (collided.length > 0) {
        collided.sort();
        const message = "MCP server \"" + name + "\" 的工具命名空间已被占用：" + collided.join(", ");
        warn(message);
        return { ok: false, name, reason: "conflict", detail: "tools", tools: collided, message };
      }
    }
    const external = externalRows(undefined).find((row) => row.name === name);
    if (external !== undefined) {
      const message = "MCP server \"" + name + "\" 已由宿主 loader 行托管（外部服务器只观察，不重复挂载）";
      warn(message);
      return { ok: false, name, reason: "conflict", detail: "loader", message };
    }

    let plugin;
    try {
      if (!ctx || !ctx.loader || typeof ctx.loader.import !== "function") {
        throw new Error("ctx.loader.import 不可用（宿主 loader 服务缺失）");
      }
      const moduleNamespace = await ctx.loader.import(MCP_CLIENT_MODULE);
      plugin = pluginOf(moduleNamespace);
      if (plugin === undefined) throw new Error("模块 " + MCP_CLIENT_MODULE + " 没有可用的 apply 导出");
    } catch (error) {
      const message = "MCP 接管不可用：加载 " + MCP_CLIENT_MODULE + " 失败 — " + messageOf(error);
      warn(message);
      return { ok: false, name, reason: "module", message };
    }

    let fiber;
    try {
      if (typeof ctx.plugin !== "function") throw new Error("ctx.plugin 不可用");
      fiber = ctx.plugin(plugin, toPluginConfig(name, config));
    } catch (error) {
      const message = "MCP server \"" + name + "\" 挂载失败：" + messageOf(error);
      warn(message);
      return { ok: false, name, reason: "mount", message };
    }

    // 先登记再 await：并发 mount 同名要立刻撞 conflict，而不是等启动完再撞。
    const row = { name, config, fiber, state: "unavailable", warning: undefined };
    owned.set(name, row);
    try {
      // cordis 的 ctx.plugin 返回可 await 的 fiber（then = fiber.await()）；fake ctx 的普通对象照样能 await。
      await Promise.resolve(fiber);
      // 兼容将来只暴露 fiber.ready 的宿主：额外等一次（没有就跳过）。
      if (fiber && fiber.ready && typeof fiber.ready.then === "function") await fiber.ready;
    } catch (error) {
      owned.delete(name);
      try { if (fiber && typeof fiber.dispose === "function") await fiber.dispose(); } catch { /* 清理失败也不抛 */ }
      const message = "MCP server \"" + name + "\" 启动失败：" + messageOf(error);
      warn(message);
      return { ok: false, name, reason: "startup", state: "unavailable", message };
    }

    const toolCount = countTools(undefined, name);
    if (toolCount === 0) {
      row.state = "unavailable";
      row.warning = "MCP server \"" + name + "\" 已挂载但没有任何工具（连接失败/重连中/服务器无工具），保持挂载等待重连";
      warn(row.warning);
    } else {
      row.state = "owned";
    }
    const result = { ok: true, name, state: row.state, transport: config.transport, target: targetOf(config), toolCount };
    if (row.warning !== undefined) result.warning = row.warning;
    return result;
  };

  /**
   * 卸载 gate 自己挂的 server（dispose = 断连 + 注销工具 + 释放命名空间）。
   * 外部行不在这里的登记表里，永远不会被 dispose。
   *
   * @param {string} name
   * @returns {Promise<{ok:boolean,name:string,reason?:string,message?:string}>}
   */
  const unmount = async (name) => {
    const row = owned.get(name);
    if (row === undefined) return { ok: false, name, reason: "not-mounted", message: "MCP server \"" + name + "\" 不是 gate 挂载的" };
    owned.delete(name);
    const fiber = row.fiber;
    if (fiber !== undefined && fiber !== null && typeof fiber.dispose === "function") {
      try {
        await fiber.dispose();
      } catch (error) {
        const message = "MCP server \"" + name + "\" 卸载时 dispose 失败：" + messageOf(error);
        warn(message);
        return { ok: false, name, reason: "dispose", message };
      }
    }
    return { ok: true, name };
  };

  /**
   * 改配置 = 卸载 + 重挂。先校验新配置，非法时保留旧实例不动。
   *
   * @param {string} name
   * @param {object} rawConfig
   * @returns {Promise<object>} mount 的结果 + replaced:boolean
   */
  const update = async (name, rawConfig) => {
    let next;
    try {
      next = normalizeServerConfig(name, rawConfig);
    } catch (error) {
      return { ok: false, name, reason: "invalid", code: error && error.code, message: "MCP server 声明非法：" + messageOf(error) };
    }
    const replaced = owned.has(name);
    await unmount(name);
    const mounted = await mount(name, next);
    return Object.assign({}, mounted, { replaced: replaced && mounted.ok === true });
  };

  /**
   * 运行时列表：gate 自己挂的（owned）+ 宿主 loader 行里的（external）。
   * 每行 {name,transport,target,state,enabled,owned,toolCount}；toolCount 用可见工具名计数。
   *
   * @param {object} [agent] 传 agent 时按该 agent 的视图计数，否则全局视图
   * @returns {Array<object>}
   */
  const list = (agent) => {
    const rows = [];
    for (const row of owned.values()) {
      const toolCount = countTools(agent, row.name);
      rows.push({
        name: row.name,
        transport: row.config.transport,
        target: targetOf(row.config),
        // 宿主没有连接状态 API：工具出现就是唯一的「已连上」证据，重连成功后这里自动翻成 owned。
        state: row.state === "owned" || toolCount > 0 ? "owned" : row.state,
        enabled: row.config.enabled !== false,
        owned: true,
        toolCount,
      });
    }
    for (const row of externalRows(agent)) rows.push(row);
    return rows;
  };

  /** 单个 server 的运行时状态：owned / unavailable / external；没登记且不是外部行 → undefined。 */
  const state = (name) => {
    const row = owned.get(name);
    if (row !== undefined) {
      if (row.state === "owned") return "owned";
      return countTools(undefined, name) > 0 ? "owned" : row.state;
    }
    const external = externalRows(undefined).find((item) => item.name === name);
    return external === undefined ? undefined : external.state;
  };

  /** 退出/重载前清场：逐个 unmount，失败只收集不抛。 */
  const disposeAll = async () => {
    const removed = [];
    const failed = [];
    for (const name of [...owned.keys()]) {
      const result = await unmount(name);
      if (result.ok) removed.push(name);
      else failed.push(result);
    }
    return { removed, failed };
  };

  return { mount, unmount, update, list, state, disposeAll };
}