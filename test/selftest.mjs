/**
 * 沙盒自测：用共享测试宿主（test/host.mjs）复刻真实语义，
 * 验证闸门算出来的 deny 集、目录文本、按需加载、代理执行、段落摘除。
 * 不碰真实 DSH 实例。跑法：node test/selftest.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePolicy, tierForTool, TIER_RESIDENT, TIER_OFF } from "../lib/policy.js";
import { createGate, pickStatus } from "../lib/gate.js";
import { mountSectionGate } from "../lib/sections.js";
import { mountSkillGate } from "../lib/prestep.js";
import { estimateTokens } from "../lib/catalog.js";
import { registerGateTools } from "../lib/proxy.js";
import { mountServer, hostAdmission, isTrustedRequest } from "../lib/server.js";
import { makeHost } from "./host.mjs";
import os from "node:os";
import fsSync from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const results = [];
/**
 * 旧实现是同步 check：传入 async fn 时 Promise 被丢弃，断言失败也不会被捕获，
 * 于是那两处 async 用例是“空断言”假绿。现在一律 await。
 */
const check = async (label, fn) => {
  try { await fn(); results.push({ ok: true, label }); }
  catch (error) { results.push({ ok: false, label, error: String((error && error.message) || error) }); }
};

const host = makeHost();
const policy = resolvePolicy({}, { logger: host.logger });
const example = JSON.parse(fs.readFileSync(path.join(root, "gate.example.json"), "utf8"));
const examplePolicy = resolvePolicy(example, { logger: host.logger });
const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy: examplePolicy });
await gate.attach(host.agent);

await check("默认策略：T1 九件套常驻（ws_mcp_call 已退休，进 legacy 不再常驻）", () => {
  for (const name of ["pwsh", "read", "write", "edit", "grep", "glob", "web_search", "web_fetch", "skill"]) {
    assert.equal(tierForTool(examplePolicy, name), TIER_RESIDENT, name);
  }
});
await check("默认策略：插件工具按需", () => {
  for (const name of ["univer_sheet", "office_docx", "ssh_exec", "mnemon_recall"]) {
    assert.notEqual(tierForTool(examplePolicy, name), TIER_RESIDENT, name);
  }
});
await check("闸门自己的工具受保护", () => {
  for (const name of ["gate_status", "gate_search", "gate_load", "gate_invoke", "gate_call"]) {
    assert.equal(tierForTool(examplePolicy, name), TIER_RESIDENT, name);
  }
});
await check("restrict 已生效：第二层工具从 view 消失", () => {
  const visible = host.visibleOf(host.agent);
  assert.equal(visible.has("univer_sheet"), false);
  assert.equal(visible.has("read"), true);
  assert.equal(visible.has("run_code"), true);
});
await check("限制里没有 run_code，也没有常驻工具", () => {
  const deny = [...(host.restrictions()[0] || new Set())];
  assert.equal(deny.includes("run_code"), false);
  assert.equal(deny.includes("read"), false);
  assert.equal(deny.includes("univer_sheet"), true);
});
await check("目录文本包含第二层工具与用法提示", () => {
  const catalog = gate.catalogFor(host.agent);
  assert.ok(catalog.includes("<gate-catalog>"));
  assert.ok(catalog.includes("univer_sheet"));
  assert.ok(catalog.includes("gate_load"));
  assert.equal(catalog.includes("- read "), false);
});
await check("目录比原始工具声明省得多", () => {
  const catalog = gate.catalogFor(host.agent);
  const full = [...host.registry.values()].reduce((sum, d) => sum + estimateTokens(d.name + " " + d.description), 0);
  const saved = full - estimateTokens(catalog);
  assert.ok(saved > 0, "saved=" + saved);
});

await check("gate_load 之前 univer_sheet 不在可见工具表里", () => {
  assert.equal(host.visibleOf(host.agent).has("univer_sheet"), false);
});
await gate.load(host.agent, ["univer_sheet"]);
await check("gate_load 生效", () => {
  assert.equal(host.visibleOf(host.agent).has("univer_sheet"), true);
  assert.equal(gate.catalogFor(host.agent).includes("univer_sheet"), false);
});

const forwarded = await gate.callThrough(host.agent, "ssh_exec", { command: "echo hi" }, undefined, undefined);
await check("gate_call 能调到被隐藏的工具", () => {
  assert.equal(forwarded.content[0].text, "ssh_exec ok {\"command\":\"echo hi\"}");
});
await check("代理执行后限制自动恢复", () => {
  assert.equal(host.visibleOf(host.agent).has("ssh_exec"), false);
});

// 段落钩子
const sectionPolicy = resolvePolicy({ sections: { defaultTier: 1, overrides: { "free-search:engines": 2 } } }, { logger: host.logger });
const sectionGate = createGate({ ctx: host.rootCtx, logger: host.logger, policy: sectionPolicy });
const disposeSection = mountSectionGate({ ctx: host.rootCtx, gate: sectionGate, logger: host.logger, policy: sectionPolicy });
const assembly = {
  sections: [
    { name: "HARNESS_IDENTITY", text: "you are dsh" },
    { name: "free-search:engines", text: "x".repeat(400) },
    { name: "tools:sdk", text: "sdk" },
  ],
  contexts: [],
  tools: [],
  variables: {},
};
const transformed = await host.assemble(assembly, host.agent);
await check("段落钩子摘掉了指定段落", () => {
  const names = transformed.sections.map((s) => s.name);
  assert.equal(names.includes("free-search:engines"), false);
  assert.equal(names.includes("HARNESS_IDENTITY"), true);
});
await check("段落钩子插入了目录段", () => {
  const names = transformed.sections.map((s) => s.name);
  assert.ok(names.includes("gate-catalog"));
});
await check("段落清单被记录（含 token 体积）", () => {
  const status = pickStatus(sectionGate.snapshot(host.agent));
  assert.ok(Array.isArray(status.sections));
  assert.ok(status.sections.some((s) => s.name === "free-search:engines" && s.tokens > 0));
});
await check("第一轮只插入一个目录段", () => {
  assert.equal(transformed.sections.filter((s) => s.name === "gate-catalog").length, 1);
});
const twice = await host.assemble(transformed, host.agent);
await check("目录段不重复", () => {
  assert.equal(twice.sections.filter((s) => s.name === "gate-catalog").length, 1);
});
disposeSection();

// 技能钩子：常驻（tier=1）也要记录名单，否则 UI 技能列永远空、用户改不了档
const skillCatalogMessage = {
  role: "user",
  source: { kind: "skill-catalog", entries: [{ name: "archify", description: "图" }, { name: "uni2pg", description: "库" }] },
};
const skillDecision = { kind: "enter", messages: [{ role: "user", source: { kind: "user" } }, skillCatalogMessage] };
const residentSkillPolicy = resolvePolicy({ skills: { tier: 1 } }, { logger: host.logger });
const residentSkillGate = createGate({ ctx: host.rootCtx, logger: host.logger, policy: residentSkillPolicy });
await residentSkillGate.attach(host.agent);
const disposeResidentSkills = mountSkillGate({ ctx: host.rootCtx, gate: residentSkillGate, logger: host.logger, policy: residentSkillPolicy });
const residentOut = await host.preStep(skillDecision, host.agent);
await check("技能常驻（tier=1）时名单照样被记录（UI 才能改档）", () => {
  const entries = residentSkillGate.snapshot(host.agent).skillEntries;
  assert.deepEqual(entries.map((s) => s.name).sort(), ["archify", "uni2pg"]);
});
// 0.3.0 接管（工单 14）：常驻档也摘宿主目录 —— gate 自己的目录在 gate-catalog、正文在
// gate-skill:<name> 段落，宿主那份目录再留着就会重复且不受 off 控制。
// （0.1.8 的「常驻零改动透传」只在 skills.takeover=false 的逃生门下成立，见下一条。）
await check("技能接管：常驻档也摘掉宿主目录（目录/正文由 gate 自己出）", () => {
  assert.equal(residentOut.messages.length, 1);
});
disposeResidentSkills();

// 逃生门：takeover=false 时完整退回 0.1.8 —— 常驻档不摘目录、名单从目录消息里读。
// v3 里档位真源是 defaults.skillpack；skills 只装接管配置（tier 在这里是非法键，会被忽略）。
const legacySkillPolicy = resolvePolicy({ defaults: { skillpack: 1 }, skills: { takeover: false } }, { logger: host.logger });
const legacySkillGate = createGate({ ctx: host.rootCtx, logger: host.logger, policy: legacySkillPolicy });
await legacySkillGate.attach(host.agent);
const disposeLegacySkills = mountSkillGate({ ctx: host.rootCtx, gate: legacySkillGate, logger: host.logger, policy: legacySkillPolicy });
const legacyOut = await host.preStep(skillDecision, host.agent);
await check("技能接管关闭（takeover=false）+ 常驻档：零改动透传（0.1.8 行为）", () => {
  assert.equal(legacyOut.messages.length, skillDecision.messages.length);
  assert.deepEqual(legacySkillGate.snapshot(host.agent).skills.sort(), ["archify", "uni2pg"]);
});
disposeLegacySkills();

const onDemandSkillPolicy = resolvePolicy({ skills: { tier: 2 } }, { logger: host.logger });
const onDemandSkillGate = createGate({ ctx: host.rootCtx, logger: host.logger, policy: onDemandSkillPolicy });
await onDemandSkillGate.attach(host.agent);
const disposeOnDemandSkills = mountSkillGate({ ctx: host.rootCtx, gate: onDemandSkillGate, logger: host.logger, policy: onDemandSkillPolicy });
const onDemandOut = await host.preStep({ kind: "enter", messages: [{ role: "user", source: { kind: "user" } }, skillCatalogMessage] }, host.agent);
await check("技能改按需时摘掉目录消息并记进目录", () => {
  assert.equal(onDemandOut.messages.length, 1);
  const catalog = onDemandSkillGate.catalogFor(host.agent);
  assert.ok(catalog.includes("archify"), "目录里应有技能名");
});
disposeOnDemandSkills();

await check("策略文件不存在时用内置默认（仍然启用）", () => {
  const missing = resolvePolicy({ policyFile: path.join(root, "no-such-file.json") }, { logger: host.logger });
  assert.equal(missing.enabled, true);
  assert.equal(tierForTool(missing, "read"), TIER_RESIDENT);
});
await check("策略文件是坏 JSON 时 fail-open（禁用闸门、全部常驻）", async () => {
  const tmp = path.join(fsSync.mkdtempSync(path.join(os.tmpdir(), "dsh-gate-")), "gate.json");
  fsSync.writeFileSync(tmp, "{ this is not json", "utf8");
  const bad = resolvePolicy({ policyFile: tmp }, { logger: host.logger });
  assert.equal(bad.enabled, false, "坏文件必须 fail-open，不能让闸门半死");
  assert.equal(tierForTool(bad, "univer_doc"), TIER_RESIDENT);
  fsSync.rmSync(path.dirname(tmp), { recursive: true, force: true });
});
await check("非法层值（null/空串/false）不静默变成 0（=关闭）", () => {
  const p = resolvePolicy({ tools: { defaultTier: 2, overrides: { read: null, write: "", edit: false, glob: 1 } } }, { logger: host.logger });
  assert.equal(tierForTool(p, "read"), 2);
  assert.equal(tierForTool(p, "write"), 2);
  assert.equal(tierForTool(p, "edit"), 2);
  assert.equal(tierForTool(p, "glob"), 1);
});
await check("通配符具体度：univer_sheet 压过 univer_*", () => {
  const p = resolvePolicy({ tools: { defaultTier: 2, overrides: { "univer_*": 0, univer_sheet: 1 } } }, { logger: host.logger });
  assert.equal(tierForTool(p, "univer_sheet"), TIER_RESIDENT);
  assert.equal(tierForTool(p, "univer_doc"), TIER_OFF);
});

// 段落被摘掉后必须出现在目录里，否则模型永远不知道有这段可加载。
await check("被摘掉的段落进目录", () => {
  const catalog = sectionGate.catalogFor(host.agent);
  assert.ok(catalog.includes("[段落] free-search:engines"), catalog.slice(0, 300));
});

// own 层（agent 自己注册、restrict 管不到的）工具：run_code 在假宿主里就是这一类。
await check("own 层工具被识别，tierMap 归为常驻", () => {
  const s = gate.snapshot(host.agent);
  assert.ok(s.ownNames.includes("run_code"), "ownNames=" + JSON.stringify(s.ownNames));
  assert.equal(s.tiers.run_code, TIER_RESIDENT);
  assert.equal(s.tiers.univer_doc, 2);
});

// enabled:false 必须撤销已经建立的限制（否则“关闸门”关不掉已藏的工具）。
await check("策略 enabled:false 时撤销已有限制", async () => {
  const host2 = makeHost();
  const p2 = resolvePolicy({ tools: { defaultTier: 2, overrides: {} } }, { logger: host2.logger });
  const g2 = createGate({ ctx: host2.rootCtx, logger: host2.logger, policy: p2 });
  await g2.attach(host2.agent);
  assert.equal(host2.visibleOf(host2.agent).has("univer_doc"), false, "先确认限制生效");
  p2.enabled = false;
  g2.reapply(host2.agent);
  assert.equal(host2.visibleOf(host2.agent).has("univer_doc"), true, "关闭策略后必须撤销限制");
  await g2.release(host2.agent);
});

// 回归：gate_status 的 output.schema 漏键会让真机调用直接 ToolCallError
// （loadtest 直调 execute 绕过宿主 schema 校验，所以它测不出这个 bug）。
registerGateTools({ ctx: host.rootCtx, gate, policy: examplePolicy });
await check("gate_status 声明的输出属性覆盖 status() 实际返回的全部键", () => {
  const definition = host.tool("gate_status");
  assert.ok(definition, "gate_status 没注册上");
  const declared = new Set(Object.keys(definition.output.schema.properties));
  const actual = Object.keys(pickStatus(gate.snapshot(host.agent)));
  const missing = actual.filter((key) => !declared.has(key));
  assert.deepEqual(missing, [], "schema 缺少: " + missing.join(", "));
});
await check("gate_status 能真的执行并返回全部键", async () => {
  const definition = host.tool("gate_status");
  const value = await definition.execute({}, { agent: host.agent });
  for (const key of Object.keys(definition.output.schema.properties)) {
    assert.ok(Object.prototype.hasOwnProperty.call(value, key), "缺少返回值键: " + key);
  }
});

// —— R1：/api/dsh-gate/* 必须走宿主 connection 服务的浏览器会话认证 ——
const fakeCtxWith = (connection) => ({
  get(name) { return name === "connection" ? connection : undefined; },
  reflect: { get() { return undefined; } },
});
const plainReq = (over = {}) => Object.assign({
  method: "GET",
  headers: { host: "127.0.0.1:51235", "sec-fetch-site": "same-origin" },
  socket: { remoteAddress: "127.0.0.1" },
  async *[Symbol.asyncIterator]() { /* 空 body */ },
}, over);
const fakeRes = () => ({ code: 0, body: "", writeHead(code) { this.code = code; }, end(body) { this.body = body || ""; } });

await check("宿主放行时 hostAdmission 记为已检查且不拦截", () => {
  const admission = hostAdmission(fakeCtxWith({ requestRejection: () => undefined }), plainReq());
  assert.equal(admission.checked, true);
  assert.equal(admission.rejection, undefined);
});
await check("宿主返回 401（无浏览器会话 cookie）时原样上报", () => {
  const admission = hostAdmission(fakeCtxWith({ requestRejection: () => 401 }), plainReq());
  assert.equal(admission.checked, true);
  assert.equal(admission.rejection, 401);
});
await check("宿主返回 403（Host/Origin 不合法）时原样上报", () => {
  const admission = hostAdmission(fakeCtxWith({ requestRejection: () => 403 }), plainReq({ headers: { host: "evil.example" } }));
  assert.equal(admission.checked, true);
  assert.equal(admission.rejection, 403);
});
await check("宿主没有 connection 服务时记未检查（回退自家四道门）", () => {
  assert.equal(hostAdmission({}, plainReq()).checked, false);
  assert.equal(isTrustedRequest(plainReq()), true);
  assert.equal(isTrustedRequest(plainReq({ headers: { host: "evil.example" } })), false);
  assert.equal(isTrustedRequest(plainReq({ headers: { host: "127.0.0.1:51235", "sec-fetch-site": "cross-site" } })), false);
});
await check("宿主鉴权抛错时 fail-closed（记 403 而不是放行）", () => {
  const admission = hostAdmission(fakeCtxWith({ requestRejection() { throw new Error("boom"); } }), plainReq());
  assert.equal(admission.checked, true);
  assert.equal(admission.rejection, 403);
});

// 端到端：真的跑 mountServer 注册出来的 handler
/** 空快照：没有 agent 时 HTTP 层的默认形状（形状本身由 gate.snapshot 定义）。 */
const blankSnapshot = () => ({
  enabled: true, policyFile: "", agent: null, visible: 0, resident: 0, onDemand: 0, off: 0,
  gated: 0, passthrough: false, loaded: [], catalogChars: 0, catalogTokens: 0,
  residentNames: [], onDemandNames: [], offNames: [], ownNames: [], presetNames: [],
  sections: [], skills: [], skillEntries: [], tiers: {},
});
const authCtx = (connection) => ({
  get(name) { return name === "connection" ? connection : undefined; },
  reflect: { get() { return undefined; } },
  inject(names, callback) {
    const registered = [];
    const disposer = callback({ webServer: { register(route) { registered.push(route); return () => undefined; } } });
    authCtx.lastRoutes = registered;
    authCtx.lastDisposer = disposer;
    return disposer;
  },
});
const runRoute = async (connection, routePath, reqOver, gateOverride) => {
  const ctx = authCtx(connection);
  const policyForServer = resolvePolicy({ tools: { defaultTier: 2, overrides: {} } }, { logger: host.logger });
  policyForServer.policyFile = path.join(os.tmpdir(), "dsh-gate-auth-test.json");
  mountServer({
    ctx,
    gate: gateOverride || { listAgents: () => [], snapshot: () => blankSnapshot() },
    policy: policyForServer,
    logger: host.logger,
    config: {},
  });
  const route = (authCtx.lastRoutes || []).find((row) => row.path === routePath.split("?")[0]);
  assert.ok(route, "路由没注册: " + routePath);
  const res = fakeRes();
  const reqUrl = (reqOver && reqOver.url) || (routePath.includes("?") ? routePath : "/");
  await route.handler(plainReq(Object.assign({ url: reqUrl }, reqOver)), res);
  return res;
};

await check("GET /state：宿主判 401 时接口也 401（本机 curl 无 cookie 不再能读）", async () => {
  const res = await runRoute({ requestRejection: () => 401 }, "/api/dsh-gate/state");
  assert.equal(res.code, 401, "body=" + res.body);
});
await check("GET /state：宿主放行时接口 200 并返回快照", async () => {
  const res = await runRoute({ requestRejection: () => undefined }, "/api/dsh-gate/state");
  assert.equal(res.code, 200, "body=" + res.body);
  assert.ok(JSON.parse(res.body).hasOwnProperty.call(JSON.parse(res.body), "visible"));
});
await check("POST /policy：宿主放行但 content-type 不是 JSON 仍 415", async () => {
  const fsExtra = await import("node:fs");
  const tempFile = path.join(os.tmpdir(), "dsh-gate-auth-test-415.json");
  fsExtra.writeFileSync(tempFile, JSON.stringify({ version: 2, enabled: true }), "utf8");
  const res = await runRoute({ requestRejection: () => undefined }, "/api/dsh-gate/policy", {
    method: "POST",
    headers: { host: "127.0.0.1:51235", "sec-fetch-site": "same-origin", "content-type": "text/plain" },
  });
  assert.equal(res.code, 415, "body=" + res.body);
});
await check("POST /policy：宿主判 403 时接口也 403", async () => {
  const res = await runRoute({ requestRejection: () => 403 }, "/api/dsh-gate/policy", {
    method: "POST",
    headers: { host: "evil.example", "content-type": "application/json" },
  });
  assert.equal(res.code, 403, "body=" + res.body);
});

// 多会话进程：/state 必须取「最近活过」的那个（gate.listAgents 按 touchedAt 排序），
// 否则 UI 会把另一个恢复会话的分层当成当前会话（真事故：活跃会话的 loaded 永远显示 []）。
// 这里用 stub 顶替 gate：只实现 HTTP 层真的会用到的三个成员（listAgents / snapshot / reapply）。
const multiGate = () => {
  const oldAgent = { id: "session-old" };
  const liveAgent = { id: "session-live" };
  const shape = (id) => {
    const live = id === "session-live";
    return Object.assign(blankSnapshot(), {
      agent: id,
      visible: live ? 127 : 102,
      resident: live ? 20 : 16,
      onDemand: live ? 107 : 86,
      off: live ? 0 : 0,
      residentNames: ["run_code"],
      onDemandNames: ["web_search"],
      offNames: [],
      ownNames: ["run_code"],
      presetNames: [],
      gated: live ? 9 : 5,
      catalogChars: 1,
      catalogTokens: 1,
      loaded: live ? ["advanced_search"] : [],
    });
  };
  // 只实现 HTTP 层真正会用到的三个成员：挑 agent / 出快照 / 重算。
  return {
    listAgents: () => [
      { id: "session-live", touchedAt: 2000, agent: liveAgent },
      { id: "session-old", touchedAt: 1000, agent: oldAgent },
    ],
    snapshot: (agent) => (agent === undefined ? blankSnapshot() : shape(String(agent.id || ""))),
    reapply: () => undefined,
  };
};
await check("GET /state：多会话进程里取最近活跃的 agent（不是 Map 里第一个）", async () => {
  const res = await runRoute({ requestRejection: () => undefined }, "/api/dsh-gate/state", {}, multiGate());
  assert.equal(res.code, 200, "body=" + res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.agent, "session-live", "agent=" + body.agent);
  assert.equal(body.resident, 20, "resident=" + body.resident);
  assert.deepEqual(body.loaded, ["advanced_search"], "loaded=" + JSON.stringify(body.loaded));
});
await check("GET /state?agent=<id>：可点名查指定会话", async () => {
  const res = await runRoute({ requestRejection: () => undefined }, "/api/dsh-gate/state?agent=session-old", {}, multiGate());
  assert.equal(res.code, 200, "body=" + res.body);
  assert.equal(JSON.parse(res.body).agent, "session-old");
});
await check("GET /state?agent=<不存在>：404 并列出已知 agent", async () => {
  const res = await runRoute({ requestRejection: () => undefined }, "/api/dsh-gate/state?agent=session-nope", {}, multiGate());
  assert.equal(res.code, 404, "body=" + res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.error, "agent not found");
  assert.deepEqual(body.agents.sort(), ["session-live", "session-old"]);
});

// ── preset 平面（agent preset 注册的工具：pwsh/read/write/grep/glob/web_search/skill…）──
// 真误诊：gate.json 给它们写的层“不生效”，文档还写成“PTC profile 里根本不存在”。
// 真相：它们由 preset 挂在 agent 祖先层，global 视图看不到 → 旧候选集漏掉它们。
const presetHost = makeHost({ preset: ["pwsh", "read", "write", "skill"] });
const presetPolicy = resolvePolicy({ tools: { defaultTier: 2, overrides: { univer_sheet: 2 } } }, { logger: presetHost.logger });
const presetGate = createGate({ ctx: presetHost.rootCtx, logger: presetHost.logger, policy: presetPolicy });
await presetGate.attach(presetHost.agent);
presetGate.reapply(presetHost.agent);

await check("preset 平面：默认不受管（常驻、不被 deny、不震荡）", () => {
  const status = presetGate.snapshot(presetHost.agent);
  assert.ok(status.residentNames.includes("pwsh"), "resident=" + JSON.stringify(status.residentNames));
  assert.ok(status.presetNames.includes("pwsh"), "preset=" + JSON.stringify(status.presetNames));
  assert.ok(!status.onDemandNames.includes("pwsh"));
  // 全局工具按默认层（2）被藏是正常的；这里只要求 preset 平面不被 deny。
  // 例外：宿主 skill 工具在 0.3.0 由 gate 接管（工单 14），接管开启时**无条件** deny，
  // 哪怕它挂在 preset 平面 —— 不这么做的后果是宿主仍会注入技能目录/正文，与 gate 的 off 打架。
  for (const set of presetHost.restrictions()) {
    assert.ok(!set.has("pwsh") && !set.has("write"), "preset 工具不该被写进 deny: " + [...set].join(","));
    assert.ok(set.has("skill"), "接管开启时 skill 必须被 deny: " + [...set].join(","));
  }
  assert.ok(status.offNames.includes("skill"), "skill 应落关闭桶: " + JSON.stringify(status.offNames));
});
await check("preset 平面：overrides 点名后真正受管（进按需 + 被 restrict 藏掉）", async () => {
  const named = resolvePolicy({ tools: { defaultTier: 2, overrides: { pwsh: 2, read: 1 } } }, { logger: presetHost.logger });
  const gate2 = createGate({ ctx: presetHost.rootCtx, logger: presetHost.logger, policy: named });
  await gate2.attach(presetHost.agent);
  gate2.reapply(presetHost.agent);
  const status = gate2.snapshot(presetHost.agent);
  assert.ok(status.onDemandNames.includes("pwsh"), "onDemand=" + JSON.stringify(status.onDemandNames));
  assert.ok(status.residentNames.includes("read"), "read 显式常驻");
  assert.ok(status.gated > 0, "点名过的要真被藏掉");
  const view = presetHost.tools.view(presetHost.agent);
  assert.ok(!view.visible.has("pwsh"), "restrict 之后 pwsh 必须从 agent 视图消失");
  assert.ok(view.visible.has("read"), "常驻的 read 必须还在");
  assert.ok(presetHost.restrictions().length > 0, "必须真调用 restrict");
  // 收拾干净，别把 restriction 泄漏给后续用例
  await gate2.release(presetHost.agent);
});
await check("preset 平面：gate_load 能认领 preset 工具（不再报 unknown）", async () => {
  const loaded = await presetGate.load(presetHost.agent, ["pwsh"]);
  assert.deepEqual(loaded.unknown, [], "unknown=" + JSON.stringify(loaded.unknown));
  assert.deepEqual(loaded.loaded, ["pwsh"]);
});
await check("preset 平面：tierMap 把它算常驻并单独列出（UI 打标用）", () => {
  const state = presetGate.snapshot(presetHost.agent);
  assert.equal(state.tiers.pwsh, TIER_RESIDENT);
  assert.ok(state.presetNames.includes("read"), "presetNames=" + JSON.stringify(state.presetNames));
});
await check("preset 平面：gate_status schema 覆盖 presetNames", async () => {
  registerGateTools({ ctx: presetHost.rootCtx, gate: presetGate, policy: presetPolicy });
  const tool = presetHost.tool("gate_status");
  assert.ok(tool, "gate_status 未注册");
  const value = pickStatus(presetGate.snapshot(presetHost.agent));
  const allowed = new Set(Object.keys(tool.output.schema.properties));
  for (const key of Object.keys(value)) assert.ok(allowed.has(key), "schema 缺键: " + key);
  assert.ok(allowed.has("presetNames"));
});

const failed = results.filter((r) => !r.ok);
for (const result of results) {
  console.log((result.ok ? "  ok  " : "  FAIL") + "  " + result.label + (result.ok ? "" : "  →  " + result.error));
}
console.log("");
console.log("策略: " + (examplePolicy.policyFile || "(内置默认)"));
console.log("可见工具 " + gate.snapshot(host.agent).visible + " 个，隐藏 " + gate.snapshot(host.agent).gated + " 个");
console.log(failed.length === 0 ? "全部通过 (" + results.length + ")" : failed.length + " 项失败 / " + results.length);
process.exitCode = failed.length === 0 ? 0 : 1;