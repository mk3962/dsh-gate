/**
 * MCP 接管核心用例（0.3.0 票 15 / M1-core）。
 *
 * 盯四件事：
 *  1) normalizeServerConfig 只放行规范形状：serverName / transport / command / url / args / env /
 *     headers / cwd / enabled 逐项校验，非法一律抛带 code 的错（不静默吞配置错误）。
 *  2) toPluginConfig 产出 mcp-client 的 Config 形状，enabled 不外泄，failOnStartupError 恒 false。
 *  3) manager.mount 的三道冲突（已挂同名 / 工具命名空间被占 / loader 行同 serverName）、模块缺失、
 *     启动失败、连不上（挂上但无工具）全部降级成结果对象：不 throw 到 gate 主链路。
 *  4) unmount 调 dispose、update = 卸载+重挂、list 同时给 owned 与 external、state 三态可查；
 *     宿主服务打坏（tools.view / loader.entries / logger）时仍然给结果，不炸。
 *
 * 假宿主只模拟本模块用到的宿主面（ctx.loader.import / ctx.loader.entries / ctx.plugin / ctx.tools），
 * 不模拟 gate，也不依赖 asar 里的真 mcp-client。
 *
 * 跑法：node --import ./test/stub-loader.mjs test/mcp.test.mjs
 */
import assert from "node:assert/strict";
import { createMcpManager, MCP_CLIENT_MODULE, normalizeServerConfig, toPluginConfig } from "../lib/mcp.js";
import { makeHost } from "./host.mjs";

let passed = 0;
const ok = (label) => { passed += 1; console.log("  ok    " + label); };

/**
 * 假宿主：
 *  - ctx.tools.register 进 registrations；view() 读它（toolsBroken 时抛）。
 *  - ctx.loader.import 只认 MCP_CLIENT_MODULE；module/moduleError 控制返回值。
 *  - ctx.plugin 记录 (plugin, config)，默认同步跑 plugin.apply（与真宿主一样把工具注册进来），
 *    startupFailure 时返回一个 reject 的 thenable fiber（真 cordis 的 await 语义）。
 *  - ctx.loader.entries 默认返回传入的 entries（数组或 generator），entriesBroken 时抛。
 */
const makeFakeHost = (options) => {
  const opts = options || {};
  // 宿主 tools 面复用共享 seam（test/host.mjs）：这里只补 loader / plugin，不写第二份 view 适配。
  const host = makeHost({ names: [] });
  const pluginCalls = [];
  const disposals = [];
  const imports = [];
  const disposers = new Map();

  /** 默认 plugin.apply：注册一个 mcp__<serverName>__probe（providesTools=false 时什么都不注册）。 */
  const apply = (pluginCtx, config) => {
    if (opts.providesTools === false) return;
    const dispose = pluginCtx.tools.register({
      name: "mcp__" + config.serverName + "__probe",
      description: "probe",
      execute: async () => ({ content: [] }),
    });
    disposers.set(config.serverName, dispose);
  };

  // 坏宿主：只有 view 抛错，register 仍走共享宿主（模拟宿主接口在升级后变脸）。
  const tools = opts.toolsBroken === true
    ? { view() { throw new Error("tools.view 坏了"); }, register: host.tools.register.bind(host.tools) }
    : host.tools;

  const ctx = {
    tools,
    loader: {
      import(name) {
        imports.push(name);
        if (name !== MCP_CLIENT_MODULE) return Promise.reject(new Error("unexpected module " + name));
        if (opts.moduleError !== undefined) return Promise.reject(opts.moduleError);
        if (opts.module !== undefined) {
          const module = typeof opts.module === "function" ? opts.module({ apply }) : opts.module;
          return Promise.resolve(module);
        }
        return Promise.resolve({ name: "mcp-client", apply });
      },
      entries() {
        if (opts.entriesBroken === true) throw new Error("loader.entries 坏了");
        const source = opts.entries;
        if (typeof source === "function") return source();
        return source || [];
      },
    },
    plugin(plugin, config) {
      pluginCalls.push({ plugin, config });
      if (opts.pluginThrows === true) throw new Error("ctx.plugin 不可用");
      if (opts.startupFailure === true) {
        return {
          dispose: async () => { disposals.push(config.serverName); },
          then(resolve, reject) { return Promise.reject(new Error("initial connection failed")).then(resolve, reject); },
        };
      }
      if (plugin && typeof plugin.apply === "function") plugin.apply({ tools: host.tools }, config);
      return {
        dispose: async () => {
          disposals.push(config.serverName);
          const dispose = disposers.get(config.serverName);
          if (dispose !== undefined) { dispose(); disposers.delete(config.serverName); }
        },
      };
    },
  };

  return { ctx, logger: host.logger, logs: host.logs, registrations: host.registry, pluginCalls, disposals, imports };
};

// ── 1. normalize：stdio 默认形状 / 显式字段 / 数值字段 ────────────────────────────
{
  const config = normalizeServerConfig("files", { command: "npx", args: ["-y", "mcp-files"], env: { TOKEN: "x" } });
  assert.deepEqual(config, {
    name: "files",
    transport: "stdio",
    enabled: true,
    command: "npx",
    args: ["-y", "mcp-files"],
    env: { TOKEN: "x" },
    cwd: "",
  }, "stdio 默认：transport=stdio、args/env 空、cwd 空、enabled=true");
  assert.equal(normalizeServerConfig("off", { command: "x", enabled: false }).enabled, false, "enabled=false 原样保留");
  assert.deepEqual(
    normalizeServerConfig("paths", { command: " npx ", cwd: "D:\\work", toolCallTimeoutMs: 1500, maxInstructionBytes: 2048 }),
    { name: "paths", transport: "stdio", enabled: true, command: "npx", args: [], env: {}, cwd: "D:\\work", toolCallTimeoutMs: 1500, maxInstructionBytes: 2048 },
    "command 去空白；cwd/超时/说明上限按声明进规范化结果",
  );
  const raw = { command: "x", args: ["a"], env: { A: "1" } };
  const normalized = normalizeServerConfig("deep", raw);
  assert.notEqual(normalized.args, raw.args, "args 必须是副本（不能和输入共享引用）");
  assert.notEqual(normalized.env, raw.env, "env 必须是副本");
  ok("normalize：stdio 默认与显式形状、enabled、数值字段、深拷贝");
}

// ── 2. normalize：streamable-http ─────────────────────────────────────────────
{
  const config = normalizeServerConfig("remote", {
    transport: "streamable-http",
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer t" },
  });
  assert.deepEqual(config, {
    name: "remote",
    transport: "streamable-http",
    enabled: true,
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer t" },
  }, "http 形状只有 url/headers，不带 stdio 字段");
  assert.equal("command" in config, false, "http 不塞 command");
  assert.equal("cwd" in config, false, "http 不塞 cwd");
  ok("normalize：streamable-http 形状与默认 headers");
}

// ── 3. normalize：非法输入逐条抛带 code 的错 ────────────────────────────────────
{
  const cases = [
    [undefined, { command: "x" }, "invalid-server-name"],
    ["bad name", { command: "x" }, "invalid-server-name"],
    ["x".repeat(33), { command: "x" }, "invalid-server-name"],
    ["ok", undefined, "invalid-config"],
    ["ok", [], "invalid-config"],
    ["ok", { transport: "sse", command: "x" }, "invalid-transport"],
    ["ok", { transport: "stdio" }, "missing-command"],
    ["ok", { command: "   " }, "missing-command"],
    ["ok", { command: "x", args: "nope" }, "invalid-args"],
    ["ok", { command: "x", args: [1] }, "invalid-args"],
    ["ok", { command: "x", env: "nope" }, "invalid-env"],
    ["ok", { command: "x", env: { A: 1 } }, "invalid-env"],
    ["ok", { command: "x", cwd: 1 }, "invalid-cwd"],
    ["ok", { transport: "streamable-http" }, "missing-url"],
    ["ok", { transport: "streamable-http", url: "not a url" }, "invalid-url"],
    ["ok", { transport: "streamable-http", url: "ftp://example.com/mcp" }, "invalid-url"],
    ["ok", { transport: "streamable-http", url: "https://x", headers: [] }, "invalid-headers"],
    ["ok", { command: "x", enabled: "yes" }, "invalid-enabled"],
    ["ok", { command: "x", toolCallTimeoutMs: "slow" }, "invalid-number"],
    ["ok", { command: "x", maxInstructionBytes: 1.5 }, "invalid-number"],
  ];
  for (const [name, raw, code] of cases) {
    let thrown;
    try { normalizeServerConfig(name, raw); } catch (error) { thrown = error; }
    assert.ok(thrown instanceof Error, "必须抛 Error：" + JSON.stringify(name) + " / " + JSON.stringify(raw));
    assert.equal(thrown.code, code, "code 不符：" + JSON.stringify(name) + " → " + thrown.code);
  }
  ok("normalize：20 条非法输入各自抛对 code，不静默放行");
}

// ── 4. toPluginConfig：Config 形状、enabled 不外泄、深拷贝 ─────────────────────
{
  const stdio = normalizeServerConfig("files", { command: "npx", args: ["-y", "mcp-files"], env: { TOKEN: "x" } });
  const before = JSON.parse(JSON.stringify(stdio));
  const pluginConfig = toPluginConfig("files", stdio);
  assert.deepEqual(pluginConfig, {
    transport: "stdio",
    serverName: "files",
    failOnStartupError: false,
    command: "npx",
    args: ["-y", "mcp-files"],
    env: { TOKEN: "x" },
    cwd: "",
  }, "stdio → mcp-client Config（serverName/transport/command/args/env/cwd）");
  assert.equal("enabled" in pluginConfig, false, "enabled 是 gate 的声明位，不传给 mcp-client");
  assert.equal("name" in pluginConfig, false, "用 serverName，不用 name");
  assert.equal(pluginConfig.failOnStartupError, false, "连接失败不许让 apply 抛（failOnStartupError 恒 false）");
  assert.deepEqual(stdio, before, "toPluginConfig 不能改输入");
  assert.notEqual(pluginConfig.args, stdio.args, "args 仍是副本");
  assert.notEqual(pluginConfig.env, stdio.env, "env 仍是副本");

  const http = normalizeServerConfig("remote", { transport: "streamable-http", url: "https://x/y", headers: { A: "b" } });
  assert.deepEqual(toPluginConfig("remote", http), {
    transport: "streamable-http",
    serverName: "remote",
    failOnStartupError: false,
    url: "https://x/y",
    headers: { A: "b" },
  }, "http → Config（url/headers）");
  assert.throws(() => toPluginConfig("", {}), (error) => error.code === "invalid-server-name", "没有 serverName 时 toPluginConfig 也抛 code");
  ok("toPluginConfig：Config 形状、无 enabled、failOnStartupError=false、不改输入");
}

// ── 5. mount 成功：import 走 loader、plugin 拿到 Config、登记 owned ─────────────
{
  const host = makeFakeHost();
  const manager = createMcpManager({ ctx: host.ctx, logger: host.logger });
  const result = await manager.mount("files", { command: "npx", args: ["-y", "mcp-files"] });
  assert.equal(result.ok, true);
  assert.equal(result.state, "owned");
  assert.equal(result.transport, "stdio");
  assert.equal(result.target, "npx");
  assert.equal(result.toolCount, 1);
  assert.deepEqual(host.imports, [MCP_CLIENT_MODULE], "必须经 ctx.loader.import 取模块（裸 import 在 profile 里解析不到）");
  assert.equal(host.pluginCalls.length, 1);
  assert.equal(typeof host.pluginCalls[0].plugin.apply, "function");
  assert.equal(host.pluginCalls[0].config.serverName, "files");
  assert.equal(host.pluginCalls[0].config.failOnStartupError, false);
  assert.equal(manager.state("files"), "owned");
  ok("mount：loader.import 取模块 → ctx.plugin → state=owned、toolCount 计数");

  // 默认导出包一层的模块也要认（loader unwrap 的兼容面）。
  const wrapped = makeFakeHost({ module: (api) => ({ default: { apply: api.apply } }) });
  const wrappedManager = createMcpManager({ ctx: wrapped.ctx, logger: wrapped.logger });
  const wrappedResult = await wrappedManager.mount("deep", { command: "uvx" });
  assert.equal(wrappedResult.ok, true, "moduleNamespace.default.apply 也要挂得上");
  assert.equal(wrappedResult.state, "owned");
}

// ── 6. mount 冲突三道：已挂同名 / 工具命名空间 / loader 行 ───────────────────────
{
  const host = makeFakeHost();
  const manager = createMcpManager({ ctx: host.ctx, logger: host.logger });
  await manager.mount("files", { command: "npx" });
  const again = await manager.mount("files", { command: "npx" });
  assert.equal(again.ok, false);
  assert.equal(again.reason, "conflict");
  assert.equal(again.detail, "mounted");
  assert.equal(host.pluginCalls.length, 1, "已挂同名不许再挂第二份");
  assert.ok(host.logs.some((line) => line.includes("files")) === false, "同门冲突不必刷告警（调用方可预期）");

  const toolHost = makeFakeHost();
  toolHost.registrations.set("mcp__taken__probe", { name: "mcp__taken__probe" });
  const toolManager = createMcpManager({ ctx: toolHost.ctx, logger: toolHost.logger });
  const toolConflict = await toolManager.mount("taken", { command: "npx" });
  assert.equal(toolConflict.ok, false);
  assert.equal(toolConflict.reason, "conflict");
  assert.equal(toolConflict.detail, "tools");
  assert.deepEqual(toolConflict.tools, ["mcp__taken__probe"], "冲突结果要列出被占的 mcp__<name>__* 工具");
  assert.equal(toolHost.pluginCalls.length, 0, "命名空间被占时不 import / 不挂载");

  const loaderHost = makeFakeHost({
    entries: [{ options: { id: "e1", name: MCP_CLIENT_MODULE, config: { transport: "stdio", serverName: "busy", command: "x" }, disabled: false }, fiber: {} }],
  });
  const loaderManager = createMcpManager({ ctx: loaderHost.ctx, logger: loaderHost.logger });
  const loaderConflict = await loaderManager.mount("busy", { command: "x" });
  assert.equal(loaderConflict.ok, false);
  assert.equal(loaderConflict.reason, "conflict");
  assert.equal(loaderConflict.detail, "loader");
  assert.equal(loaderHost.pluginCalls.length, 0, "loader 行已有同 serverName 时只观察，不重复挂");
  ok("mount 冲突：已挂同名 / mcp__<name>__* 已存在 / loader 行同 serverName 三条都拒绝且不挂");
}

// ── 7. mount：模块缺失 / 模块没有 apply → reason=module，降级不抛 ───────────────
{
  const missingHost = makeFakeHost({ moduleError: new Error("cannot resolve " + MCP_CLIENT_MODULE) });
  const missing = createMcpManager({ ctx: missingHost.ctx, logger: missingHost.logger });
  const missingResult = await missing.mount("x", { command: "x" });
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.reason, "module");
  assert.match(missingResult.message, /MCP 接管不可用/);
  assert.equal(missingHost.pluginCalls.length, 0, "模块取不到就不碰 ctx.plugin");
  assert.equal(missing.state("x"), undefined, "没挂上就没有登记");
  assert.ok(missingHost.logs.some((line) => line.includes("加载 " + MCP_CLIENT_MODULE)), "模块失败要留告警");

  const noApplyHost = makeFakeHost({ module: { name: "mcp-client" } });
  const noApply = createMcpManager({ ctx: noApplyHost.ctx, logger: noApplyHost.logger });
  const noApplyResult = await noApply.mount("x", { command: "x" });
  assert.equal(noApplyResult.ok, false);
  assert.equal(noApplyResult.reason, "module");
  assert.equal(noApplyHost.pluginCalls.length, 0);

  const noLoaderHost = makeFakeHost();
  const noLoaderCtx = { tools: noLoaderHost.ctx.tools, plugin: noLoaderHost.ctx.plugin };
  const noLoader = createMcpManager({ ctx: noLoaderCtx, logger: noLoaderHost.logger });
  const noLoaderResult = await noLoader.mount("x", { command: "x" });
  assert.equal(noLoaderResult.ok, false);
  assert.equal(noLoaderResult.reason, "module", "宿主没有 loader 服务时同样是「MCP 接管不可用」");
  ok("mount：模块缺失 / 无 apply / 无 loader 服务 → reason=module，不挂不登记，只告警");
}

// ── 8. mount：连不上（挂上但没工具）→ ok + unavailable + warning，保持挂载 ──────
{
  const host = makeFakeHost({ providesTools: false });
  const manager = createMcpManager({ ctx: host.ctx, logger: host.logger });
  const result = await manager.mount("empty", { command: "npx" });
  assert.equal(result.ok, true, "failOnStartupError=false：连不上不是挂载失败");
  assert.equal(result.state, "unavailable");
  assert.equal(result.toolCount, 0);
  assert.match(result.warning, /没有任何工具/, "unavailable 必须带可读告警");
  assert.equal(manager.state("empty"), "unavailable", "unavailable 仍要留在登记表里（UI 能看到并等重连）");
  assert.equal(host.pluginCalls.length, 1);
  assert.ok(host.logs.some((line) => line.startsWith("warn ") && line.includes("empty")));
  const rows = manager.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "unavailable");
  // 重连成功后工具出现：宿主没有连接状态 API，工具出现就是唯一证据，list/state 要自动翻成 owned。
  host.registrations.set("mcp__empty__late", { name: "mcp__empty__late", description: "late", execute: async () => ({ content: [] }) });
  assert.equal(manager.state("empty"), "owned", "重连后工具出现 → state 从 unavailable 翻成 owned");
  assert.equal(manager.list()[0].state, "owned");
  assert.equal(manager.list()[0].toolCount, 1);
  ok("mount：挂上但无工具 → ok:true/state=unavailable/带 warning，登记保留；重连后自动翻 owned");
}

// ── 9. mount：启动抛错 / ctx.plugin 抛错 → 降级 + 清理，不 throw ───────────────
{
  const startupHost = makeFakeHost({ startupFailure: true });
  const startup = createMcpManager({ ctx: startupHost.ctx, logger: startupHost.logger });
  const startupResult = await startup.mount("boom", { command: "npx" });
  assert.equal(startupResult.ok, false);
  assert.equal(startupResult.reason, "startup");
  assert.equal(startupResult.state, "unavailable");
  assert.equal(startup.state("boom"), undefined, "启动失败的 fiber 不留在登记表");
  assert.deepEqual(startupHost.disposals, ["boom"], "失败 fiber 要顺手 dispose 掉，避免半死实例占命名空间");

  const throwHost = makeFakeHost({ pluginThrows: true });
  const throwManager = createMcpManager({ ctx: throwHost.ctx, logger: throwHost.logger });
  const throwResult = await throwManager.mount("boom", { command: "npx" });
  assert.equal(throwResult.ok, false);
  assert.equal(throwResult.reason, "mount");
  assert.equal(throwManager.state("boom"), undefined);
  ok("mount：启动抛错 → reason=startup 并 dispose；ctx.plugin 抛错 → reason=mount；都不抛");
}

// ── 10. mount：非法声明 / enabled=false 早退，不 import ────────────────────────
{
  const host = makeFakeHost();
  const manager = createMcpManager({ ctx: host.ctx, logger: host.logger });
  const invalidName = await manager.mount("bad name", { command: "npx" });
  assert.equal(invalidName.ok, false);
  assert.equal(invalidName.reason, "invalid");
  assert.equal(invalidName.code, "invalid-server-name");
  const invalidShape = await manager.mount("ok", { transport: "stdio" });
  assert.equal(invalidShape.reason, "invalid");
  assert.equal(invalidShape.code, "missing-command");
  const disabled = await manager.mount("off", { command: "npx", enabled: false });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.reason, "disabled");
  assert.deepEqual(host.imports, [], "非法/停用的声明连模块都不该 import");
  assert.equal(host.pluginCalls.length, 0);
  assert.equal(manager.state("off"), undefined);
  ok("mount：非法声明 → invalid+code；enabled=false → disabled；都不 import 不挂");
}

// ── 11. unmount：dispose 被调用、登记消失、重复卸载可预期 ───────────────────────
{
  const host = makeFakeHost();
  const manager = createMcpManager({ ctx: host.ctx, logger: host.logger });
  await manager.mount("files", { command: "npx" });
  assert.equal(host.registrations.has("mcp__files__probe"), true);
  const result = await manager.unmount("files");
  assert.equal(result.ok, true);
  assert.deepEqual(host.disposals, ["files"], "unmount 必须 await fiber.dispose()");
  assert.equal(host.registrations.has("mcp__files__probe"), false, "dispose 后工具名要腾出来");
  assert.equal(manager.state("files"), undefined);
  assert.deepEqual(manager.list(), []);
  const again = await manager.unmount("files");
  assert.equal(again.ok, false);
  assert.equal(again.reason, "not-mounted");
  ok("unmount：await dispose、删登记、状态消失；重复卸载 → not-mounted");
}

// ── 12. update = 卸载 + 重挂；非法更新保留旧实例 ────────────────────────────────
{
  const host = makeFakeHost();
  const manager = createMcpManager({ ctx: host.ctx, logger: host.logger });
  await manager.mount("files", { command: "npx", args: ["a"] });

  const invalid = await manager.update("files", { transport: "stdio" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "invalid");
  assert.equal(invalid.code, "missing-command");
  assert.equal(host.pluginCalls.length, 1, "新配置非法时不许先把旧实例拆掉");
  assert.equal(host.disposals.length, 0);
  assert.equal(manager.state("files"), "owned", "旧实例保持 owned");

  const updated = await manager.update("files", { command: "uvx", args: ["b"] });
  assert.equal(updated.ok, true);
  assert.equal(updated.replaced, true);
  assert.equal(host.pluginCalls.length, 2);
  assert.equal(host.pluginCalls[1].config.command, "uvx", "重挂的新 config 生效");
  assert.deepEqual(host.disposals, ["files"], "update 先卸载旧 fiber 再挂新的");
  assert.equal(manager.state("files"), "owned");
  assert.equal(manager.list()[0].target, "uvx");

  const stopped = await manager.update("files", { command: "uvx", enabled: false });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.reason, "disabled");
  assert.equal(manager.state("files"), undefined, "enabled=false 的更新 = 卸载后不重挂");
  assert.equal(host.pluginCalls.length, 2);
  ok("update：先校验（非法保留旧实例）→ 卸载+重挂；enabled=false 变卸载");
}

// ── 13. list：owned + external 合并、字段齐、toolCount 按可见名计数 ─────────────
{
  const entries = function* () {
    yield { options: { id: "w", name: "@deepseek-ai/dsh-mcp-client", config: { transport: "stdio", serverName: "wincu", command: "wincu" }, disabled: false }, fiber: {} };
    yield { options: { id: "o", name: MCP_CLIENT_MODULE, config: { transport: "streamable-http", serverName: "remote", url: "https://mcp.example/mcp" }, disabled: true }, fiber: {} };
    yield { options: { id: "g", name: "some-other-plugin", config: { serverName: "ignored" } }, fiber: {} };
    yield { options: { id: "n", name: MCP_CLIENT_MODULE, config: {} }, fiber: {} };
  };
  const host = makeFakeHost({ entries });
  host.registrations.set("mcp__wincu__fs_read", { name: "mcp__wincu__fs_read" });
  const manager = createMcpManager({ ctx: host.ctx, logger: host.logger });
  await manager.mount("files", { command: "npx" });

  const rows = manager.list();
  assert.equal(rows.length, 3, "owned 1 + external 2；非 mcp-client 行与缺 serverName 的行都不列");
  assert.deepEqual(rows[0], {
    name: "files",
    transport: "stdio",
    target: "npx",
    state: "owned",
    enabled: true,
    owned: true,
    toolCount: 1,
  });
  assert.deepEqual(rows[1], {
    name: "wincu",
    transport: "stdio",
    target: "wincu",
    state: "external",
    enabled: true,
    owned: false,
    toolCount: 1,
  }, "外部行：只读 serverName/disabled，toolCount 用可见名（mcp__wincu__*）计数");
  assert.deepEqual(rows[2], {
    name: "remote",
    transport: "streamable-http",
    target: "https://mcp.example/mcp",
    state: "external",
    enabled: false,
    owned: false,
    toolCount: 0,
  }, "disabled 的外部行 enabled=false");
  assert.equal(manager.state("wincu"), "external");
  assert.equal(manager.state("remote"), "external");
  assert.equal(manager.state("missing"), undefined);
  assert.equal(manager.list().length, 3, "list 幂等；外部行不重复");
  assert.equal(manager.list({ id: "agent-1" }).length, 3, "传 agent 时也按可见名计数，不抛");
  ok("list：owned+external 合并、字段齐、toolCount 按 mcp__<name>__* 可见名计数");
}

// ── 14. 宿主服务打坏：tools.view / loader.entries / logger 都不炸 ──────────────
{
  const blind = makeFakeHost({ toolsBroken: true, entriesBroken: true });
  const blindManager = createMcpManager({ ctx: blind.ctx, logger: blind.logger });
  const mounted = await blindManager.mount("blind", { command: "npx" });
  assert.equal(mounted.ok, true, "看不到工具面时冲突检测跳过，挂载照走");
  assert.equal(mounted.state, "unavailable", "看不到工具 → toolCount 0 → unavailable");
  assert.equal(mounted.toolCount, 0);
  const rows = blindManager.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].toolCount, 0, "拿不到 view 时 toolCount 就是 0，不抛");
  assert.equal(blindManager.state("anything"), undefined);
  const second = await blindManager.mount("blind2", { command: "npx" });
  assert.equal(second.ok, true, "knownNames 拿不到就不判工具命名空间冲突（降级放行）");

  const noisy = makeFakeHost();
  const throwingLogger = createMcpManager({ ctx: noisy.ctx, logger: { warn() { throw new Error("logger down"); } } });
  const noisyResult = await throwingLogger.mount("x", { command: "npx" });
  assert.equal(noisyResult.ok, true, "logger 自己抛错不能影响挂载结果");

  const noTools = makeFakeHost();
  const noToolsCtx = { loader: noTools.ctx.loader, plugin: noTools.ctx.plugin };
  const noToolsManager = createMcpManager({ ctx: noToolsCtx, logger: noTools.logger });
  const noView = await noToolsManager.mount("x", { command: "npx" });
  assert.equal(noView.ok, true);
  assert.equal(noView.state, "unavailable", "宿主没有 tools 服务时按 toolCount=0 降级");
  assert.deepEqual(noToolsManager.list()[0].toolCount, 0);
  ok("降级：tools.view / loader.entries / logger / 无 tools 服务全都不抛，结果对象照给");
}

// ── 15. disposeAll：逐个卸载，失败收集不抛，重复调用幂等 ───────────────────────
{
  const host = makeFakeHost();
  const manager = createMcpManager({ ctx: host.ctx, logger: host.logger });
  await manager.mount("a", { command: "npx" });
  await manager.mount("b", { command: "uvx" });
  const result = await manager.disposeAll();
  assert.deepEqual(result.removed.sort(), ["a", "b"]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(host.disposals.slice().sort(), ["a", "b"]);
  assert.deepEqual(manager.list(), []);
  assert.equal(manager.state("a"), undefined);
  assert.deepEqual(await manager.disposeAll(), { removed: [], failed: [] }, "空表时 disposeAll 也是安全 no-op");
  ok("disposeAll：全部 dispose、清登记；空表/重复调用幂等");
}

console.log("\n全部通过 (" + passed + ")");