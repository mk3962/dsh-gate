/**
 * MCP 接管集成用例（0.3.0 票 15 / M1-int）。
 *
 * 覆盖四块：
 *  1) 策略 v3 的 mcp 键：归一（坏条目单条丢弃 + 告警）、整表替换、v2→v3 默认、空模板；
 *  2) gate.startMcp：enabled 项并发自挂、disabled 跳过、幂等、单条失败只降级；
 *  3) gate.reapplyAll：挂载后重算已挂 agent（新 mcp__<name>__* 工具进第二层，可 gate_load）；
 *  4) /api/dsh-gate/mcp：GET 合并 owned/external/stopped；POST add/update/disable/enable/remove
 *     写 gate.json（无 BOM）+ 调 manager + reapplyAll；非法 400、冲突 409、未知 404、鉴权沿用。
 *
 * 假宿主只用 test/host.mjs 的 tools seam（仓内唯一的 view/restrict 实现）；
 * loader / plugin 是本地补的两块，行为按 M1-core 调研文档核实的 cordis 语义。
 * 跑法：node --import ./test/stub-loader.mjs test/mcp-int.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGate, STATUS_KEYS } from "../lib/gate.js";
import { POLICY_KEYS, emptyPolicyTemplate, mergePolicyFile, resolvePolicy } from "../lib/policy.js";
import { migrateV2ToV3, normalizeV3Policy } from "../lib/migrate.js";
import { mountServer } from "../lib/server.js";
import { makeHost } from "./host.mjs";

let passed = 0;
const ok = (label) => { passed += 1; console.log("  ok    " + label); };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "gate-mcp-int-"));
const quiet = { warn() { /* 用例自己断言结果对象 */ }, info() { /* noop */ } };

// ── 1. 策略 v3：mcp 归一（逐条校验，坏条目只丢自己）──────────────────────────
{
  const normalized = normalizeV3Policy({
    version: 3,
    mcp: {
      servers: {
        beta: { transport: "streamable-http", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer x" } },
        alpha: { command: "npx", args: ["-y", "mcp-files"], env: { TOKEN: "x" } },
        broken: {},
        "bad name": { command: "x" },
      },
    },
  });
  const servers = normalized.policy.mcp.servers;
  assert.deepEqual(Object.keys(servers), ["alpha", "beta"], "servers 必须按名排序");
  assert.deepEqual(servers.alpha, {
    transport: "stdio", enabled: true, command: "npx", args: ["-y", "mcp-files"], env: { TOKEN: "x" }, cwd: "",
  }, "stdio 条目要补默认 transport/enabled/args/env/cwd");
  assert.equal(servers.beta.transport, "streamable-http");
  assert.equal(servers.beta.url, "https://mcp.example/mcp");
  assert.equal("name" in servers.alpha, false, "落盘条目不带 name（名字就是键）");
  assert.equal(normalized.warnings.length, 2, "两条非法声明各一条告警，实际 " + JSON.stringify(normalized.warnings));
  assert.equal(normalized.warnings.every((row) => row.code === "invalid-mcp-server"), true);
  ok("normalizeV3Policy：mcp.servers 按名排序、逐项归一、坏条目丢弃并告警");
}

// ── 2. resolvePolicy：行 config 的 mcp 生效，坏条目不让整份策略失败 ───────────
{
  const policy = resolvePolicy({
    mcp: {
      servers: {
        one: { command: "npx", args: ["1"] },
        off: { command: "npx", enabled: false },
        bad: { transport: "stdio" },
      },
    },
  }, { logger: quiet });
  assert.deepEqual(Object.keys(policy.mcp.servers), ["off", "one"], "非法项被丢弃，其余保留");
  assert.equal(policy.mcp.servers.one.transport, "stdio");
  assert.equal(policy.mcp.servers.one.enabled, true);
  assert.equal(policy.mcp.servers.off.enabled, false);
  assert.ok(policy.warnings.some((row) => row.code === "invalid-mcp-server"), "坏条目要进统一告警流");
  assert.equal(policy.enabled, true, "一条坏 mcp 配置不许把整份策略打成 disabled");
  ok("resolvePolicy：mcp 行层归一；单条非法只丢弃自己并留 warning");
}

// ── 3. 保存合并：mcp 整表替换（删除真的生效），没提交时保留旧表 ───────────────
{
  assert.deepEqual(emptyPolicyTemplate().mcp, { servers: {} }, "空模板要有 mcp.servers");
  assert.equal(POLICY_KEYS[POLICY_KEYS.length - 1].key, "mcp", "mcp 追加在键表末尾");
  const merged = mergePolicyFile(
    { mcp: { servers: { old: { command: "x" } } } },
    { mcp: { servers: { next: { command: "y" } } } },
  );
  assert.deepEqual(Object.keys(merged.mcp.servers), ["next"], "提交了 servers 就整表替换（old 必须消失）");
  const untouched = mergePolicyFile({ mcp: { servers: { keep: { command: "k" } } } }, { enabled: true });
  assert.deepEqual(Object.keys(untouched.mcp.servers), ["keep"], "没提交 mcp 时旧表必须保留");
  ok("mergePolicyFile：mcp 整表替换，删除生效；无提交时不动旧表");
}

// ── 4. v2 → v3：mcp 默认 { servers: {} }，规范化幂等 ──────────────────────────
{
  const migrated = migrateV2ToV3({ version: 2, tools: { defaultTier: 1, overrides: {} } });
  assert.deepEqual(migrated.policy.mcp, { servers: {} }, "v2 文件迁移后要有空的 mcp 段");
  const again = normalizeV3Policy(migrated.policy).policy;
  assert.equal(JSON.stringify(again.mcp), JSON.stringify(migrated.policy.mcp), "v3 规范化必须幂等");
  ok("migrateV2ToV3：补默认 mcp={servers:{}}，再规范化不变");
}

// ── 5. gate.startMcp：并发挂载、跳过 disabled、幂等 ───────────────────────────
/**
 * 给 makeHost 的根 ctx 补 loader / plugin：
 *  - loader.import 带 5ms 延迟并记录并发峰值（串行 mount 会是 1，并发是 2）；
 *  - ctx.plugin 调 mcp-client 的 apply（注册假工具 mcp__<server>__probe），返回带 dispose 的 fiber；
 *  - rejectServer 让该 server 的 fiber await 拒绝（模拟连不上，走 reason:"startup"）。
 */
const installMcpHost = (host, options) => {
  const opts = options || {};
  const events = { imports: [], mounts: [], disposed: [], inFlight: 0, maxInFlight: 0 };
  host.rootCtx.loader = {
    entries: () => opts.entries || [],
    async import(specifier) {
      events.imports.push(specifier);
      events.inFlight += 1;
      events.maxInFlight = Math.max(events.maxInFlight, events.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.inFlight -= 1;
      if (opts.moduleError) throw opts.moduleError;
      return {
        name: "mcp-client",
        apply(pluginCtx, config) {
          pluginCtx.tools.register({
            name: "mcp__" + config.serverName + "__probe",
            description: "probe 工具",
            execute: async () => ({ content: [] }),
          });
        },
      };
    },
  };
  host.rootCtx.plugin = (plugin, config) => {
    if (opts.rejectServer === config.serverName) return Promise.reject(new Error("connect boom " + config.serverName));
    plugin.apply({ tools: host.tools }, config);
    events.mounts.push(config.serverName);
    const toolName = "mcp__" + config.serverName + "__probe";
    let disposed = false;
    return {
      async dispose() {
        if (disposed) return;
        disposed = true;
        events.disposed.push(config.serverName);
        host.registry.delete(toolName);
      },
    };
  };
  return events;
};

{
  const host = makeHost({ names: ["read"] });
  const events = installMcpHost(host);
  const policy = resolvePolicy({
    mcp: {
      servers: {
        one: { command: "npx", args: ["1"] },
        two: { transport: "streamable-http", url: "https://mcp.example/mcp" },
        off: { command: "npx", enabled: false },
      },
    },
  }, { logger: quiet });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  const result = await gate.startMcp();
  assert.deepEqual(result.mounted.map((row) => row.name), ["one", "two"], "两个 enabled 的都挂上");
  assert.equal(result.failed.length, 0);
  assert.equal(events.maxInFlight, 2, "多个 server 必须并发 mount（串行会是 1）");
  assert.equal(events.mounts.includes("off"), false, "enabled=false 不许 import / plugin");
  assert.equal(host.registry.has("mcp__one__probe"), true);
  const again = await gate.startMcp();
  assert.equal(again, result, "startMcp 幂等：返回同一个结果对象");
  assert.equal(events.mounts.filter((name) => name === "one").length, 1, "重复调用不许二次挂载");
  await gate.mcpManager.disposeAll();
  ok("gate.startMcp：enabled 项并发自挂、disabled 跳过、重复调用幂等");
}

// ── 6. 单条连接失败：startMcp 只降级，另一个照常挂载 ─────────────────────────
{
  const host = makeHost({ names: ["read"] });
  const events = installMcpHost(host, { rejectServer: "bad" });
  const policy = resolvePolicy({
    mcp: { servers: { good: { command: "x" }, bad: { command: "y" } } },
  }, { logger: quiet });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  const result = await gate.startMcp();
  assert.deepEqual(result.mounted.map((row) => row.name), ["good"]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].name, "bad");
  assert.equal(result.failed[0].reason, "startup");
  assert.ok(host.logs.some((line) => line.includes("MCP server bad 未挂载")), "失败要 warn: " + host.logs.join(" | "));
  assert.equal(events.mounts.includes("bad"), false);
  await gate.mcpManager.disposeAll();
  ok("gate.startMcp：单个 server 连不上只 warn 降级，另一个照常挂载（不抛）");
}

// ── 7. gate.reapplyAll：挂载后新工具归层、可 gate_load ────────────────────────
{
  const host = makeHost({ names: ["read"] });
  installMcpHost(host);
  const policy = resolvePolicy({ mcp: { servers: { files: { command: "npx" } } } }, { logger: quiet });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  await gate.attach(host.agent);
  assert.equal(host.visibleOf(host.agent).has("mcp__files__probe"), false, "挂载前没有这个工具");
  await gate.startMcp();
  assert.equal(typeof gate.reapplyAll, "function", "gate 必须暴露 reapplyAll");
  const count = gate.reapplyAll();
  assert.equal(count, 1, "已挂 agent 都要重算");
  assert.equal(host.visibleOf(host.agent).has("mcp__files__probe"), false, "MCP 工具默认按需：不许留在工具表");
  assert.equal(gate.canInvoke(host.agent, "mcp__files__probe").ok, true, "被藏的工具仍可经 gate_load / gate_invoke 用");
  await gate.releaseAll();
  await gate.mcpManager.disposeAll();
  ok("gate.reapplyAll：挂 MCP 后重算已挂 agent（新工具归层、仍可加载）");
}

// ── 8. /api/dsh-gate/mcp：HTTP 测试夹具 ───────────────────────────────────────
const blankSnapshot = () => ({
  enabled: true, policyFile: "", agent: null, visible: 0, resident: 0, onDemand: 0, off: 0,
  gated: 0, passthrough: false, loaded: [], catalogChars: 0, catalogTokens: 0,
  residentNames: [], onDemandNames: [], offNames: [], ownNames: [], presetNames: [],
  sections: [], skills: [], skillEntries: [], tiers: {},
});
const fakeRes = () => {
  const res = { code: 0, body: "", headers: {} };
  res.writeHead = (code, headers) => { res.code = code; Object.assign(res.headers, headers || {}); };
  res.end = (text) => { res.body = String(text === undefined ? "" : text); };
  return res;
};
const plainReq = (over) => Object.assign({
  method: "GET",
  headers: { host: "127.0.0.1:51235", "sec-fetch-site": "same-origin" },
  socket: { remoteAddress: "127.0.0.1" },
  async *[Symbol.asyncIterator]() { /* 空 body */ },
}, over || {});
const jsonReq = (body, over) => plainReq(Object.assign({
  method: "POST",
  headers: { host: "127.0.0.1:51235", "sec-fetch-site": "same-origin", "content-type": "application/json" },
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
}, over || {}));
const routeOf = (gate, policy, config) => {
  const routes = [];
  const ctx = {
    get(name) { return name === "connection" ? { requestRejection: () => undefined } : undefined; },
    reflect: { get() { return undefined; } },
    inject(_names, callback) {
      callback({ webServer: { register(route) { routes.push(route); return () => undefined; } } });
    },
  };
  mountServer({ ctx, gate, policy, logger: quiet, config: config || {} });
  const route = routes.find((row) => row.path === "/api/dsh-gate/mcp");
  assert.ok(route, "mcp 路由没注册");
  return route;
};
const writePolicy = (file, extra) => {
  fs.writeFileSync(file, JSON.stringify(Object.assign({ version: 3, mcp: { servers: {} } }, extra || {}), null, 2));
};
/** gate 里 HTTP 层真正会用到的那几个成员。manager 用状态表模拟挂/卸。 */
const fakeGate = (state) => {
  const events = [];
  const mounted = new Map();
  const manager = {
    list: (agent) => [...mounted.entries()].map(([name, toolCount]) => ({
      name, transport: "stdio", target: "npx", state: "owned", enabled: true, owned: true, toolCount,
    })),
    state: (name) => (mounted.has(name) ? "owned" : undefined),
    mount: async (name, config) => { events.push("mount:" + name); mounted.set(name, 2); return { ok: true, name, state: "owned", toolCount: 2 }; },
    update: async (name, config) => { events.push("update:" + name); mounted.set(name, 2); return { ok: true, name, state: "owned", replaced: true, toolCount: 2 }; },
    unmount: async (name) => { events.push("unmount:" + name); mounted.delete(name); return { ok: true, name }; },
  };
  return {
    events,
    mounted,
    gate: {
      listAgents: () => [],
      snapshot: () => blankSnapshot(),
      reapply: () => undefined,
      reapplyAll: () => { events.push("reapplyAll"); return 0; },
      mcpManager: manager,
    },
  };
};

// ── 9. GET：owned + external + 声明未挂载（stopped），坏声明进 warnings ───────
{
  const dir = tmpDir();
  const file = path.join(dir, "gate.json");
  writePolicy(file, { mcp: { servers: { stopped: { command: "npx" }, broken: { transport: "stdio" } } } });
  const policy = resolvePolicy({ policyFile: file }, { logger: quiet });
  const rig = fakeGate();
  rig.gate.mcpManager.list = () => [
    { name: "owned", transport: "stdio", target: "npx", state: "owned", enabled: true, owned: true, toolCount: 2 },
    { name: "external", transport: "streamable-http", target: "https://mcp.example/mcp", state: "external", enabled: true, owned: false, toolCount: 1 },
  ];
  const route = routeOf(rig.gate, policy, { policyFile: file });
  const res = fakeRes();
  await route.handler(plainReq({ url: "/api/dsh-gate/mcp" }), res);
  assert.equal(res.code, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.writable, true, "manager 在且策略启用时，UI 必须能拿到写权限（否则按钮全灰）");
  assert.deepEqual(body.servers.map((row) => row.name), ["external", "owned", "stopped"], "三来源合并并按名排序");
  const stopped = body.servers.find((row) => row.name === "stopped");
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.enabled, true);
  assert.equal(stopped.owned, false);
  assert.equal(stopped.toolCount, 0);
  assert.equal(body.warnings.some((line) => line.includes("broken")), true, "坏声明要回给 UI: " + JSON.stringify(body.warnings));
  ok("GET /mcp：owned + external + stopped 合并排序；坏声明进 warnings");
}

// ── 10. POST add：校验 → 写 gate.json（无 BOM）→ mount → reapplyAll ─────────
{
  const dir = tmpDir();
  const file = path.join(dir, "gate.json");
  writePolicy(file);
  const policy = resolvePolicy({ policyFile: file }, { logger: quiet });
  const rig = fakeGate();
  const route = routeOf(rig.gate, policy, { policyFile: file });
  const res = fakeRes();
  await route.handler(jsonReq({ action: "add", name: "files", server: { command: "npx", args: ["-y", "mcp-files"] } }, { url: "/api/dsh-gate/mcp" }), res);
  assert.equal(res.code, 200, res.body);
  const savedBytes = fs.readFileSync(file);
  assert.notEqual(savedBytes[0], 0xef, "落盘不许带 BOM");
  const saved = JSON.parse(savedBytes.toString("utf8"));
  assert.equal(saved.mcp.servers.files.command, "npx");
  assert.deepEqual(saved.mcp.servers.files.args, ["-y", "mcp-files"]);
  assert.equal(saved.mcp.servers.files.transport, "stdio");
  assert.equal(saved.mcp.servers.files.enabled, true);
  assert.equal(rig.events.includes("mount:files"), true);
  assert.equal(rig.events.includes("reapplyAll"), true);
  const body = JSON.parse(res.body);
  assert.equal(body.result.ok, true);
  assert.deepEqual(body.servers.map((row) => row.name), ["files"]);
  assert.equal(body.servers[0].state, "owned", "刚 mount 的 server 在返回清单里是 owned");
  ok("POST /mcp add：normalize → 无 BOM 写盘 → mount → reapplyAll → 返回最新 servers");
}

// ── 11. POST update / disable / enable / remove 走同一条写路径 ───────────────
{
  const dir = tmpDir();
  const file = path.join(dir, "gate.json");
  writePolicy(file, { mcp: { servers: { files: { transport: "stdio", enabled: true, command: "npx", args: ["-y", "mcp-files"], env: {}, cwd: "" } } } });
  const policy = resolvePolicy({ policyFile: file }, { logger: quiet });
  const rig = fakeGate();
  rig.mounted.set("files", 2);
  const route = routeOf(rig.gate, policy, { policyFile: file });
  const post = async (body) => {
    const res = fakeRes();
    await route.handler(jsonReq(body, { url: "/api/dsh-gate/mcp" }), res);
    return res;
  };

  let res = await post({ action: "update", name: "files", server: { command: "npx", args: ["-y", "mcp-files@2"] } });
  assert.equal(res.code, 200, res.body);
  assert.equal(rig.events.includes("update:files"), true, "已挂载的 update 必须走 manager.update");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcp.servers.files.args, ["-y", "mcp-files@2"]);

  res = await post({ action: "disable", name: "files" });
  assert.equal(res.code, 200, res.body);
  assert.equal(rig.events.includes("unmount:files"), true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcp.servers.files.enabled, false);

  res = await post({ action: "enable", name: "files" });
  assert.equal(res.code, 200, res.body);
  assert.equal(rig.mounted.has("files"), true, "enable 要把 server 挂回来");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcp.servers.files.enabled, true);

  res = await post({ action: "remove", name: "files" });
  assert.equal(res.code, 200, res.body);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcp.servers, {}, "remove 必须把声明从 gate.json 删掉");
  assert.equal(rig.mounted.has("files"), false);
  ok("POST /mcp：update / disable / enable / remove 都写盘 + 调 manager + reapplyAll");
}

// ── 12. POST 错误分支：非法 400、冲突 409、未知 404、非 JSON 415、禁用 409 ──
{
  const dir = tmpDir();
  const file = path.join(dir, "gate.json");
  writePolicy(file, { mcp: { servers: { taken: { transport: "stdio", enabled: true, command: "npx", args: [], env: {}, cwd: "" } } } });
  const policy = resolvePolicy({ policyFile: file }, { logger: quiet });
  const rig = fakeGate();
  const route = routeOf(rig.gate, policy, { policyFile: file });
  const post = async (body, over) => {
    const res = fakeRes();
    await route.handler(jsonReq(body, Object.assign({ url: "/api/dsh-gate/mcp" }, over || {})), res);
    return res;
  };

  let res = await post({ action: "add", name: "bad name", server: { command: "x" } });
  assert.equal(res.code, 400, "非法 serverName 必须 400: " + res.body);
  assert.equal(JSON.parse(res.body).code, "invalid-server-name");

  res = await post({ action: "add", name: "nocmd", server: {} });
  assert.equal(res.code, 400, "stdio 缺 command 必须 400: " + res.body);

  res = await post({ action: "add", name: "taken", server: { command: "x" } });
  assert.equal(res.code, 409, "已声明的 server 再 add 必须 409: " + res.body);

  res = await post({ action: "remove", name: "ghost" });
  assert.equal(res.code, 404, "未声明的 remove 必须 404: " + res.body);

  res = await post({ action: "frobnicate", name: "taken" });
  assert.equal(res.code, 400, "未知动作必须 400: " + res.body);

  res = fakeRes();
  await route.handler(jsonReq({ action: "add", name: "x" }, { url: "/api/dsh-gate/mcp", headers: { host: "127.0.0.1:51235", "sec-fetch-site": "same-origin", "content-type": "text/plain" } }), res);
  assert.equal(res.code, 415, "非 JSON content-type 必须 415: " + res.body);

  // 闸门整体禁用：不接管 MCP（声明可以留在文件里，等重新启用）。
  const disabledFile = path.join(dir, "disabled.json");
  fs.writeFileSync(disabledFile, JSON.stringify({ version: 3, enabled: false, mcp: { servers: {} } }, null, 2));
  const disabledPolicy = resolvePolicy({ policyFile: disabledFile }, { logger: quiet });
  const disabledRig = fakeGate();
  const disabledRoute = routeOf(disabledRig.gate, disabledPolicy, { policyFile: disabledFile });
  const disabledRes = fakeRes();
  await disabledRoute.handler(jsonReq({ action: "add", name: "x", server: { command: "npx" } }, { url: "/api/dsh-gate/mcp" }), disabledRes);
  assert.equal(disabledRes.code, 409, "enabled=false 时必须 409: " + disabledRes.body);
  assert.equal(disabledRig.events.length, 0, "禁用时不许 mount / 写盘");
  ok("POST /mcp 错误分支：非法 400 / 重复 409 / 未知 404 / 非 JSON 415 / 闸门禁用 409");
}

// ── 13. gate_status 的 18 个键一个不动 ───────────────────────────────────────
{
  assert.equal(STATUS_KEYS.length, 18, "gate_status 键数必须保持 18");
  assert.deepEqual(STATUS_KEYS, [
    "enabled", "visible", "resident", "onDemand", "off", "gated", "passthrough", "catalogTokens",
    "policyFile", "residentNames", "onDemandNames", "offNames", "loaded", "ownNames", "presetNames",
    "catalogChars", "sections", "skills",
  ], "gate_status 键序/键集不许漂");
  ok("gate_status 仍是 18 键（MCP 只走 /mcp 路由，不挤进快照投影）");
}

console.log("\n全部通过 (" + passed + ")");
