/**
 * /api/dsh-gate/skills 用例（0.3.0 工单 16 的服务端面）。
 *
 * 覆盖：
 *  - GET 形状：{skills, imports, off, takeover, prescan}，行带 provider/origin/path/tier/shadowed/capability；
 *  - POST 四种动作：tier（写/删单技能条目）、off、imports（校验目录）、takeover；
 *  - 非法参数 400、闸门禁用 409、未启用时不动文件；
 *  - 整份替换保存 /policy 不能把 skills 接管配置抹掉（0.2.0 基线的 policy.js 不认识这个键）；
 *  - 冷启动预扫描（票 04）：无 agent（或 agent 已挂但技能表还空）时用假 skills.snapshot +
 *    假 agentPresets.acquireScope 填表、行标 prescan；skills/change 立刻失效缓存；
 *    服务缺失降级成 200 + active:false。
 *
 * 跑法：node test/server-skills.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGate } from "../lib/gate.js";
import { resolvePolicy } from "../lib/policy.js";
import { mountServer } from "../lib/server.js";
import { makeHost } from "./host.mjs";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "gate-skills-"));
const fakeRes = () => {
  const res = { code: 0, body: "", headers: {} };
  res.writeHead = (code, headers) => { res.code = code; Object.assign(res.headers, headers || {}); return res; };
  res.end = (text) => { res.body = String(text === undefined ? "" : text); return res; };
  return res;
};

/**
 * 注册路由并返回按路径取 handler 的函数。
 * options.services 是假的宿主服务表（skills / agentPresets / workingDirectory）；
 * 返回的 emit 用来自造 ctx 事件（验 skills/change 失效缓存）。
 */
const mountRoutes = (options) => {
  const routes = [];
  const services = options.services || {};
  const listeners = new Map();
  const ctx = {
    get(name) {
      if (name === "connection") return { requestRejection: () => undefined };
      return services[name];
    },
    reflect: { get() { return undefined; } },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => undefined;
    },
    inject(_names, callback) {
      callback({ webServer: { register(route) { routes.push(route); return () => undefined; } } });
    },
  };
  mountServer(Object.assign({ ctx }, options));
  const routeOf = (routePath) => {
    const route = routes.find((row) => row.path === routePath);
    assert.ok(route, "路由没注册: " + routePath);
    return route;
  };
  const emit = (event) => { for (const handler of listeners.get(event) || []) handler(); };
  return { routes, routeOf, emit };
};

const request = async (route, method, body, url) => {
  const res = fakeRes();
  const headers = { host: "127.0.0.1:51235", "sec-fetch-site": "same-origin" };
  if (body !== undefined) headers["content-type"] = "application/json";
  await route.handler({
    method,
    url: url || route.path,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  }, res);
  return { code: res.code, body: res.body.length === 0 ? null : JSON.parse(res.body) };
};

let passed = 0;
const ok = (label) => { passed += 1; console.log("  ok    " + label); };

/* ── 1. GET /skills：形状与合并（假 gate，覆盖 import/shadowed 两个基线做不到的字段）── */
{
  const dir = tmpDir();
  const file = path.join(dir, "gate.json");
  const policy = resolvePolicy({ policyFile: file }, { logger: { warn() {}, info() {} } });
  const agent = { id: "session-fake" };
  const fakeGate = {
    listAgents: () => [{ id: "session-fake", touchedAt: Date.now(), agent }],
    snapshot: () => ({
      agent: "session-fake",
      skills: ["alpha-skill"],
      skillEntries: [
        { name: "alpha-skill", provider: "alpha", description: "A 技能的描述" },
        { name: "beta-skill", provider: "beta", description: "B 技能的描述", origin: "import", path: "D:\\skills\\beta\\SKILL.md", shadowed: false },
      ],
      warnings: [],
    }),
    capabilityView: () => ({
      defaults: { capability: 2, section: 1, skillpack: 2 },
      skills: [
        { name: "alpha-skill", provider: "alpha", capability: "skillpack:alpha", tier: 1, origin: "host", shadowed: false },
        { name: "beta-skill", provider: "beta", capability: "skillpack:beta", tier: 2, origin: "import", path: "D:\\skills\\beta\\SKILL.md", shadowed: true },
      ],
    }),
    knownNames: () => new Set(),
    reapply: () => undefined,
  };
  const { routeOf } = mountRoutes({ gate: fakeGate, policy, logger: { warn() {}, info() {} }, config: { policyFile: file } });
  const res = await request(routeOf("/api/dsh-gate/skills"), "GET");
  assert.equal(res.code, 200, res.body && JSON.stringify(res.body));
  const body = res.body;
  assert.deepEqual(Object.keys(body).sort(), ["agent", "defaults", "imports", "off", "prescan", "skills", "takeover", "warnings"]);
  // 技能表已经非空（真清单在手）：不做预扫描，reason 说明为什么没扫。
  assert.equal(body.prescan.active, false);
  assert.equal(body.prescan.reason, "agent-live");
  assert.equal(body.prescan.scoped, false);
  assert.equal(body.prescan.at, null);
  assert.equal(body.agent, "session-fake");
  assert.equal(body.skills.length, 2);
  const alpha = body.skills.find((row) => row.name === "alpha-skill");
  assert.equal(alpha.provider, "alpha");
  assert.equal(alpha.origin, "host");
  assert.equal(alpha.tier, 1, "能力视图的档位要透传");
  assert.equal(alpha.capability, "skillpack:alpha");
  assert.equal(alpha.description, "A 技能的描述", "描述来自快照 skillEntries");
  assert.equal(alpha.shadowed, false);
  assert.equal(alpha.prescan, false, "真行不带预扫描标记");
  const beta = body.skills.find((row) => row.name === "beta-skill");
  assert.equal(beta.origin, "import");
  assert.equal(beta.path, "D:\\skills\\beta\\SKILL.md");
  assert.equal(beta.shadowed, true, "shadowed 必须原样给 UI（只标注、不隐藏）");
  // 0.3.0 的默认就是接管（takeover=true）：策略文件不存在时 resolvePolicy 补的就是接管配置。
  assert.equal(body.takeover, true, "没有显式 skills 配置时按 0.3.0 默认接管 true");
  assert.deepEqual(body.off, []);
  assert.deepEqual(body.imports, []);
  ok("GET /skills：行带 provider/origin/path/tier/shadowed/capability，description 来自快照");
}

/* ── 2. POST 四种动作：真 gate + 临时策略文件，写完立刻重算 ─────────────────── */
{
  const dir = tmpDir();
  const file = path.join(dir, "gate.json");
  const importDir = path.join(dir, "imported-skills");
  fs.mkdirSync(importDir, { recursive: true });
  fs.writeFileSync(path.join(importDir, "SKILL.md"), "---\nname: imported-one\ndescription: 导入技能\n---\n\n正文\n", "utf8");
  const emptyDir = path.join(dir, "empty-dir");
  fs.mkdirSync(emptyDir, { recursive: true });

  const host = makeHost({ names: ["read", "write", "univer_sheet"], id: "session-skills" });
  const policy = resolvePolicy({ policyFile: file }, { logger: host.logger });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  await gate.attach(host.agent);
  gate.rememberSkills(host.agent, [
    { name: "alpha-skill", provider: "alpha", description: "A" },
    { name: "beta-skill", provider: "beta", description: "B" },
  ]);
  gate.reapply(host.agent);
  const { routeOf } = mountRoutes({ gate, policy, logger: host.logger, config: { policyFile: file } });
  const skillsRoute = routeOf("/api/dsh-gate/skills");
  const policyRoute = routeOf("/api/dsh-gate/policy");

  // 2.1 tier：写单技能条目
  let res = await request(skillsRoute, "POST", { action: "tier", name: "alpha-skill", tier: 0 });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.changed, true);
  assert.ok(res.body.state && typeof res.body.state.visible === "number", "返回最新 state");
  let saved = readJson(file);
  assert.equal(saved.capabilities["skill:alpha-skill"].tier, 0, "单技能条目必须落盘");
  assert.equal(saved.capabilities["skillpack:alpha"], undefined, "不许改整组的能力条目");

  // 2.2 tier：与继承档相同 = 删条目（跟随来源组）
  res = await request(skillsRoute, "POST", { action: "tier", name: "alpha-skill", tier: 2 });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  saved = readJson(file);
  assert.equal(saved.capabilities["skill:alpha-skill"], undefined, "选回默认档 = 删单技能条目");
  assert.equal(saved.defaults.skillpack, 2, "defaults 不许被顺手改掉");

  // 2.3 imports：存在的目录 + 空目录（200 + 告警）
  res = await request(skillsRoute, "POST", { action: "imports", imports: [importDir, { id: "empty", path: emptyDir }] });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  saved = readJson(file);
  assert.deepEqual(saved.skills.imports, [{ path: importDir }, { id: "empty", path: emptyDir }]);
  assert.ok(Array.isArray(res.body.warnings) && res.body.warnings.length === 1, "空目录要给告警");
  assert.equal(res.body.warnings[0].code, "import-empty");
  let listed = await request(skillsRoute, "GET");
  assert.equal(listed.body.imports.length, 2);
  assert.equal(listed.body.imports[0].exists, true);
  assert.equal(listed.body.imports[0].hasSkills, true);
  assert.equal(listed.body.imports[1].hasSkills, false);

  // 2.4 imports：不存在的目录 → 400，文件不动
  const before = fs.readFileSync(file, "utf8");
  res = await request(skillsRoute, "POST", { action: "imports", imports: [path.join(dir, "nope")] });
  assert.equal(res.code, 400, JSON.stringify(res.body));
  assert.match(res.body.message, /不存在/);
  assert.equal(fs.readFileSync(file, "utf8"), before, "400 不许动文件");

  // 2.5 off：去重排序后整条替换
  res = await request(skillsRoute, "POST", { action: "off", off: ["beta-skill", "alpha-skill", "beta-skill"] });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  saved = readJson(file);
  assert.deepEqual(saved.skills.off, ["alpha-skill", "beta-skill"]);

  // 2.6 takeover：布尔写入，非布尔 400
  res = await request(skillsRoute, "POST", { action: "takeover", value: false });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  saved = readJson(file);
  assert.equal(saved.skills.takeover, false);
  assert.deepEqual(saved.skills.off, ["alpha-skill", "beta-skill"], "takeover 不许把 off/imports 冲掉");
  res = await request(skillsRoute, "POST", { action: "takeover", value: "yes" });
  assert.equal(res.code, 400, JSON.stringify(res.body));

  // 2.7 非法参数
  for (const bad of [
    { action: "tier", name: "", tier: 1 },
    { action: "tier", name: "alpha-skill", tier: 3 },
    { action: "tier", name: "alpha-skill" },
    { action: "off", off: "alpha-skill" },
    { action: "off", off: [1] },
    { action: "imports", imports: "x" },
    { action: "imports", imports: [{ id: "x" }] },
    { action: "nope" },
  ]) {
    res = await request(skillsRoute, "POST", bad);
    assert.equal(res.code, 400, JSON.stringify(bad) + " → " + JSON.stringify(res.body));
  }

  // 2.8 整份替换保存 /policy 不能抹掉 skills（0.2.0 基线 policy.js 不认识这个键）
  res = await request(policyRoute, "POST", { version: 3, replace: true, enabled: true, defaults: { capability: 2, section: 1, skillpack: 2 }, capabilities: {}, sources: {}, legacy: { unknownOverrides: {} } });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  saved = readJson(file);
  assert.deepEqual(saved.skills, { takeover: false, off: ["alpha-skill", "beta-skill"], imports: [{ path: importDir }, { id: "empty", path: emptyDir }] }, "整份替换必须保留接管配置");

  // 2.9 无 BOM、无 CRLF
  const text = fs.readFileSync(file, "utf8");
  assert.equal(text.charCodeAt(0) === 0xfeff, false, "不许写 BOM");
  assert.equal(text.includes("\r\n"), false, "不许写 CRLF");

  // 2.10 未启用 409
  fs.writeFileSync(file, JSON.stringify({ version: 3, enabled: false, defaults: { capability: 1, section: 1, skillpack: 1 }, capabilities: {} }, null, 2));
  Object.assign(policy, resolvePolicy({ policyFile: file }, { logger: host.logger }));
  res = await request(skillsRoute, "POST", { action: "tier", name: "alpha-skill", tier: 1 });
  assert.equal(res.code, 409, JSON.stringify(res.body));
  assert.match(res.body.message, /禁用/);

  await gate.release(host.agent);
  ok("POST /skills：tier/off/imports/takeover 落盘并返回最新 state；非法参数 400、禁用 409、/policy 整份替换保留 skills");
}

/* ── 3. 票 15 之后服务端注册 /mcp；UI 的 404 降级只留给旧版宿主 ──────────────── */
{
  const dir = tmpDir();
  const file = path.join(dir, "gate.json");
  const policy = resolvePolicy({ policyFile: file }, { logger: { warn() {}, info() {} } });
  const host = makeHost({ names: ["read"], id: "session-nomcp" });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  await gate.attach(host.agent);
  const { routes } = mountRoutes({ gate, policy, logger: host.logger, config: { policyFile: file } });
  assert.equal(routes.some((row) => row.path === "/api/dsh-gate/mcp"), true, "票 15 之后 /mcp 必须注册");
  await gate.release(host.agent);
  ok("服务端注册 /mcp（UI 对旧宿主仍按 404 降级）");
}

/* ── 4. 冷启动预扫描（票 04）：没有 agent 时用宿主 registry 直接填表 ────────── */
{
  const dir = tmpDir();
  const file = path.join(dir, "gate.json");
  const host = makeHost({ names: ["read"], id: "session-cold" });
  const policy = resolvePolicy({ policyFile: file }, { logger: host.logger });
  // 不 attach：listAgents() 为空 = 本会话还没装配过，正是预扫描要覆盖的场景。
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  const scopeKey = { id: "preset:ptc" };
  const seen = {};
  let snapshotCalls = 0;
  let disposeCalls = 0;
  const skillsService = {
    async snapshot(request) {
      snapshotCalls += 1;
      Object.assign(seen, request);
      return {
        complete: true,
        skills: [
          { name: "cold-skill", description: "冷启动技能", provider: "filesystem", invocation: { modelInvocable: true, userInvocable: false } },
          { name: "hidden-skill", description: "模型不可调用（invocation）", provider: "filesystem", invocation: { modelInvocable: false } },
          { name: "hidden-flat", description: "模型不可调用（扁平字段，老宿主）", provider: "filesystem", modelInvocable: false },
        ],
      };
    },
  };
  const presetsService = {
    defaultId: "ptc",
    async acquireScope(id) {
      seen.preset = id;
      return { key: scopeKey, [Symbol.asyncDispose]: async () => { disposeCalls += 1; } };
    },
  };
  const { routeOf, emit } = mountRoutes({
    gate,
    policy,
    logger: host.logger,
    config: { policyFile: file },
    services: { skills: skillsService, agentPresets: presetsService },
  });
  const skillsRoute = routeOf("/api/dsh-gate/skills");

  let res = await request(skillsRoute, "GET");
  assert.equal(res.code, 200, JSON.stringify(res.body));
  let body = res.body;
  assert.equal(body.agent, null);
  assert.equal(body.prescan.active, true, "无 agent + 可扫 ⇒ 预扫描生效");
  assert.equal(body.prescan.scoped, true, "拿到 preset 的 standing scope");
  assert.equal(body.prescan.preset, "ptc");
  assert.equal(body.prescan.cwd, null, "cwd 默认 undefined（不猜工作区根）");
  assert.equal(body.prescan.complete, true);
  assert.equal(body.prescan.reason, null);
  assert.equal(typeof body.prescan.at, "number");
  assert.equal(body.skills.length, 1, "模型不可调用的技能不进预扫描清单（invocation 与扁平字段两种形状）");
  assert.equal(body.skills.some((row) => row.name === "hidden-flat"), false, "老宿主的扁平 modelInvocable:false 也要过滤");
  const cold = body.skills[0];
  assert.equal(cold.name, "cold-skill");
  assert.equal(cold.prescan, true, "预扫描行必须带标记");
  assert.equal(cold.provider, "filesystem");
  assert.equal(cold.origin, "host");
  assert.equal(cold.description, "冷启动技能");
  assert.equal(cold.capability, "skillpack:filesystem", "预扫描行同样按来源组归组");
  assert.equal(cold.tier, 2, "档位仍走 defaults.skillpack");
  assert.equal(seen.preset, "ptc", "acquireScope 用默认 preset");
  assert.equal(seen.scope, scopeKey, "snapshot 必须带 preset 的 standing scope");
  assert.equal(seen.cwd, undefined);
  assert.ok(seen.signal instanceof AbortSignal, "必须带超时 signal");
  assert.equal(disposeCalls, 1, "租约扫描完立刻释放");

  // 4.1 TTL 内复用缓存；skills/change 立刻失效
  await request(skillsRoute, "GET");
  assert.equal(snapshotCalls, 1, "10s 内复用缓存");
  emit("skills/change");
  await request(skillsRoute, "GET");
  assert.equal(snapshotCalls, 2, "skills/change 必须立刻失效缓存");
  assert.equal(disposeCalls, 2);

  // 4.2 POST 的返回值同样带预扫描（保存后 UI 不该闪回空表）
  res = await request(skillsRoute, "POST", { action: "takeover", value: false });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.skills.prescan.active, true);
  assert.equal(res.body.skills.skills[0].prescan, true);

  ok("冷启动预扫描：prescan.active/scoped 正确、行标 prescan、TTL + skills/change 失效、POST 同样接上");
}

/* ── 5. acquireScope 抛错：退回无 scope 读，仍然列出，但标 scoped:false ──────── */
{
  const dir = tmpDir();
  const file = path.join(dir, "gate.json");
  const host = makeHost({ names: ["read"], id: "session-noscope" });
  const policy = resolvePolicy({ policyFile: file }, { logger: host.logger });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  const seen = {};
  const skillsService = {
    async snapshot(request) {
      Object.assign(seen, request);
      return { complete: true, skills: [{ name: "cold-skill", description: "冷", provider: "archify-plugin" }] };
    },
  };
  const presetsService = {
    defaultId: "standard",
    async acquireScope() { throw new Error("agent-preset/invalid"); },
  };
  const { routeOf } = mountRoutes({
    gate,
    policy,
    logger: host.logger,
    config: { policyFile: file },
    services: { skills: skillsService, agentPresets: presetsService },
  });
  const res = await request(routeOf("/api/dsh-gate/skills"), "GET");
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.prescan.active, true, "拿不到 scope 也要列（只是来源可能不准）");
  assert.equal(res.body.prescan.scoped, false);
  assert.equal(res.body.prescan.preset, "standard", "仍要说明原本想用的 preset");
  assert.equal(seen.scope, undefined, "退回无 scope 读");
  ok("acquireScope 抛错 ⇒ 无 scope 读、active:true、scoped:false（不当成失败）");
}

/* ── 6. skills 服务缺失：200 + active:false（服务缺失 ≠ 没有技能）────────────── */
{
  const dir = tmpDir();
  const file = path.join(dir, "gate.json");
  const host = makeHost({ names: ["read"], id: "session-noskills" });
  const policy = resolvePolicy({ policyFile: file }, { logger: host.logger });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  const { routeOf } = mountRoutes({
    gate,
    policy,
    logger: host.logger,
    config: { policyFile: file },
    services: {},
  });
  const res = await request(routeOf("/api/dsh-gate/skills"), "GET");
  assert.equal(res.code, 200, "服务缺失不许 500");
  assert.equal(res.body.prescan.active, false);
  assert.equal(res.body.prescan.reason, "no-skills-service");
  assert.deepEqual(res.body.skills, []);
  ok("skills 服务缺失 ⇒ 200 + prescan.active:false + reason:no-skills-service");
}

/* ── 7. 已挂 agent 但技能表还是空（新建会话、未发消息）：也要预扫描 ─────────── */
{
  const dir = tmpDir();
  const file = path.join(dir, "gate.json");
  const host = makeHost({ names: ["read"], id: "session-attached" });
  const policy = resolvePolicy({ policyFile: file }, { logger: host.logger });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  // 宿主 agent/created 就会 attach：新建会话也是「有 agent」，但技能表要等 pre-step 才填。
  await gate.attach(host.agent);
  const skillsService = {
    async snapshot() {
      return { complete: true, skills: [{ name: "cold-skill", description: "冷", provider: "filesystem" }] };
    },
  };
  const { routeOf } = mountRoutes({
    gate,
    policy,
    logger: host.logger,
    config: { policyFile: file },
    services: { skills: skillsService },
  });
  const res = await request(routeOf("/api/dsh-gate/skills"), "GET");
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.agent, "session-attached", "agent 已挂上（不是无会话）");
  assert.equal(res.body.prescan.active, true, "空表就要预扫描，别让新建会话的技能页还是空的");
  assert.equal(res.body.prescan.reason, null);
  assert.equal(res.body.prescan.scoped, false, "没有 agentPresets 服务 ⇒ scoped:false");
  assert.equal(res.body.skills.length, 1);
  assert.equal(res.body.skills[0].prescan, true);
  await gate.release(host.agent);
  ok("已挂 agent + 空技能表（新建会话）：预扫描填表并标 prescan");
}

console.log("\n全部通过 (" + passed + ")");
