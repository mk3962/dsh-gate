/**
 * 状态形状单一真源（票 03）用例。
 *
 * 回归的是两条真事故：
 *  1) 面板「关闭」一栏永远 0 —— 快照把 status.off（数字）当数组取 .length，
 *     得 undefined，JSON.stringify 直接把这个键丢了。
 *  2) gate_status 的输出 schema 与 status() 各自手写键集，漂一个就够真机
 *     `ToolCallError: additionalProperties`。
 *
 * 宿主来自共享 seam（test/host.mjs）。跑法：node test/snapshot.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATUS_KEYS, createGate, pickStatus } from "../lib/gate.js";
import { resolvePolicy } from "../lib/policy.js";
import { registerGateTools } from "../lib/proxy.js";
import { mountServer } from "../lib/server.js";
import { fileURLToPath } from "node:url";
import { makeHost } from "./host.mjs";

const NAMES = ["read", "write", "edit", "grep", "glob", "pwsh", "univer_sheet", "univer_doc", "ssh_exec", "mnemon_recall"];
const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-snapshot-"));

const host = makeHost({ names: NAMES, id: "session-live" });
const agent = host.agent;
const policy = resolvePolicy(
  { tools: { defaultTier: 2, overrides: { read: 1, write: 1, edit: 1, grep: 1, glob: 1, pwsh: 1 } }, sections: { defaultTier: 1 } },
  { logger: host.logger, dshHome: policyDir },
);
const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
// attach 只交「就绪」这件事本身（票 06 后不再交出条目），种子必须走公开面。
await gate.attach(agent);
await gate.load(agent, ["univer_doc"]);
gate.recordSections(agent, [{ name: "mcp:wincu", chars: 120, tokens: 40 }]);
gate.reapply(agent);

registerGateTools({ ctx: host.rootCtx, gate, policy });

const adminCtx = () => ({
  // 宿主有 connection 服务时走它的拒绝判定（回环 + same-origin 的请求会被放行）。
  get(name) { return name === "connection" ? { requestRejection: () => undefined } : undefined; },
  reflect: { get() { return undefined; } },
  inject(_names, callback) {
    const routes = [];
    callback({ webServer: { register(route) { routes.push(route); return () => undefined; } } });
    adminCtx.lastRoutes = routes;
  },
});
const routeOf = (routePath) => {
  const ctx = adminCtx();
  mountServer({ ctx, gate, policy, logger: host.logger, config: {} });
  const route = (adminCtx.lastRoutes || []).find((row) => row.path === routePath);
  assert.ok(route, "路由没注册: " + routePath);
  return route;
};
const fakeRes = () => {
  const res = { code: 0, body: "", headers: {} };
  res.writeHead = (code, headers) => { res.code = code; Object.assign(res.headers, headers || {}); return res; };
  res.end = (text) => { res.body = String(text === undefined ? "" : text); return res; };
  res.setHeader = (key, value) => { res.headers[key] = value; };
  return res;
};
const getJson = async (routePath) => {
  const route = routeOf(routePath);
  const res = fakeRes();
  await route.handler({
    method: "GET",
    url: routePath,
    headers: { host: "127.0.0.1:51235", "sec-fetch-site": "same-origin" },
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { /* 空 body */ },
  }, res);
  assert.equal(res.code, 200, "body=" + res.body);
  return JSON.parse(res.body);
};
const callState = () => getJson("/api/dsh-gate/state");

const results = [];
const check = async (label, fn) => {
  try { await fn(); results.push({ ok: true, label }); }
  catch (error) { results.push({ ok: false, label, error: String((error && error.message) || error) }); }
};

const state = await callState();
const status = pickStatus(gate.snapshot(agent));
const snapshot = gate.snapshot(agent);

await check("面板状态接口的关闭数是数字，且等于关闭名字清单的长度", () => {
  assert.equal(typeof state.off, "number", "off 必须是数字，实际 " + typeof state.off);
  assert.equal(state.off, state.offNames.length, "off=" + state.off + " offNames=" + JSON.stringify(state.offNames));
  // 这一条同时卡住「JSON.stringify 把 undefined 键丢掉」：键必须真的在序列化结果里。
  assert.equal(Object.prototype.hasOwnProperty.call(state, "off"), true);
});

await check("快照的键集与 gate_status 的输出 schema 属性集互相覆盖", () => {
  const tool = host.tool("gate_status");
  const allowed = new Set(Object.keys(tool.output.schema.properties));
  for (const key of STATUS_KEYS) assert.ok(allowed.has(key), "schema 缺键: " + key);
  for (const key of allowed) assert.ok(STATUS_KEYS.includes(key), "schema 多了键: " + key);
  for (const key of Object.keys(status)) assert.ok(allowed.has(key), "status 多返回了 schema 没有的键: " + key);
  for (const key of allowed) assert.ok(key in status, "status 少了 schema 声明的键: " + key);
});

await check("gate_status 的输出键集与 STATUS_KEYS 逐字节一致（顺序也一致，缓存约束）", () => {
  const tool = host.tool("gate_status");
  assert.deepEqual(Object.keys(tool.output.schema.properties), STATUS_KEYS);
  assert.deepEqual(Object.keys(status), STATUS_KEYS);
});

await check("HTTP 快照不再自己拼字段，只挑 agent 并补默认值", () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "server.js"), "utf8");
  assert.ok(source.includes("gate.snapshot("), "server.js 必须从 gate.snapshot 派生");
  assert.equal(source.includes("status.off.length"), false, "server.js 里还残留 off 取 .length 的老写法");
  // 快照里除 own / preset / defaults 三个 UI 视图字段外，其余键必须原样来自 gate.snapshot。
  const own = new Set(["own", "preset", "defaults"]);
  for (const key of Object.keys(state)) {
    if (own.has(key)) continue;
    assert.ok(key in snapshot, "HTTP 快照多拼了字段: " + key);
    assert.deepEqual(state[key], snapshot[key], "字段 " + key + " 与 gate.snapshot 不一致");
  }
});

await check("数字恒等式「可见 = 常驻 + 按需 + 关闭」仍成立（面板与工具两处）", () => {
  assert.equal(state.visible, state.resident + state.onDemand + state.off);
  assert.equal(status.visible, status.resident + status.onDemand + status.off);
});

await check("快照带齐 UI 需要的非工具字段（agent / tiers / skills / skillEntries）", () => {
  assert.equal(snapshot.agent, "session-live");
  assert.equal(typeof snapshot.tiers, "object");
  assert.ok(Array.isArray(snapshot.skillEntries));
  assert.ok(Array.isArray(snapshot.skills));
  assert.ok("univer_doc" in snapshot.tiers, "已加载的工具应在权威归层表里");
});

await check("被摘掉的段落进了段落清单（种子经 recordSections，不是直接摸内部条目）", () => {
  const rows = gate.snapshot(agent).sections;
  assert.ok(Array.isArray(rows) && rows.length > 0, "段落清单不能为空");
  const wincu = rows.find((row) => row.name === "mcp:wincu");
  assert.ok(wincu, "mcp:wincu 应该在段落清单里，实际 " + JSON.stringify(rows.map((r) => r.name)));
  assert.equal(wincu.chars, 120);
  assert.equal(wincu.tokens, 40);
  // 段落归属：策略里 sections.defaultTier = 1（常驻）⇒ 这一条是常驻，不该标成受管。
  assert.equal(wincu.gated, false, "常驻段落不该被标成受管");
});

await check("没有 agent 时快照仍是完整形状（不返回裸对象）", () => {
  const blank = gate.snapshot(undefined);
  assert.equal(blank.agent, null);
  assert.equal(blank.off, 0);
  assert.ok(Array.isArray(blank.offNames));
  for (const key of STATUS_KEYS) assert.ok(key in blank, "空快照缺键: " + key);
});

await check("能力视图走单独接口，不改 /state 的固定形状（0.2.0）", async () => {
  const view = await getJson("/api/dsh-gate/capabilities");
  assert.equal(view.version, 3);
  assert.equal(view.agent, "session-live");
  assert.ok(Array.isArray(view.capabilities) && view.capabilities.length > 0, "能力视图不能为空");
  const row = view.capabilities.find((entry) => entry.id === "plugin:dsh-univer-office");
  assert.ok(row, "univer 插件应有一行能力：" + JSON.stringify(view.capabilities.map((entry) => entry.id)));
  assert.ok(row.tools.includes("univer_sheet"));
  assert.ok(row.tools.includes("univer_doc"));
  // /state 仍是 v2 时代的面板形状：不多不少（能力数据只在 /capabilities）。
  assert.equal(Object.prototype.hasOwnProperty.call(state, "capabilities"), false);
  // 旧 client 读的 defaults 字段仍由 v3 defaults 映射，UI 工单交接前不能断。
  assert.equal(state.defaults.toolsDefaultTier, policy.defaults.capability);
  assert.equal(state.defaults.sectionsDefaultTier, policy.defaults.section);
  assert.equal(state.defaults.skillsTier, policy.defaults.skillpack);
});

await check("快照是只读的：对一个没挂过闸门的 agent 取快照，不许替它建条目或施加限制", async () => {
  const stranger = { id: "stranger" };
  const blank = gate.snapshot(stranger);
  assert.equal(blank.agent, "stranger");
  assert.equal(blank.gated, 0, "没挂过的 agent 不该有 gated 计数");
  assert.equal(gate.restrictionState(stranger).mode, "none");
  // 关键：listAgents 里不许因为「取过一次快照」就多出一个会话。
  assert.equal(gate.listAgents().some((row) => row.id === "stranger"), false, "取快照不该把 agent 登记进来");
});

await gate.release(agent);

const failed = results.filter((row) => !row.ok);
for (const row of results) console.log((row.ok ? "  ok    " : "  FAIL  ") + row.label + (row.ok ? "" : "  →  " + row.error));
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exitCode = failed.length === 0 ? 0 : 1;
