/**
 * S4 · #07 前端七层重构回归用例（先红后绿矩阵）
 *
 * 运行（预制目录）：node --test s4-new-tests.mjs
 * 运行（并入仓内后）：node --import ./test/stub-loader.mjs --test test/seams/s4-new-tests.mjs
 *
 * 约定：本文件不修改 client/index.js；被测源码按下面的候选顺序解析
 *   1) 环境变量 DSH_GATE_CLIENT_PATH
 *   2) 同目录 client-index.js（预制目录）
 *   3) 垫片导出的 CLIENT_PATH（并入仓内后即真 client）
 * 0.5.7 基线源码只用于「先红」对照，找不到就跳过对照断言（不静默放过）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const loadHarness = async () => {
  const candidates = [
    "./s4-frontend-harness.mjs",
    "../../../dsh-gate-dev/test/seams/s4-frontend-harness.mjs",
    "../../test/seams/s4-frontend-harness.mjs",
  ];
  for (const candidate of candidates) {
    const file = path.resolve(HERE, candidate);
    if (fs.existsSync(file)) return import(pathToFileURL(file).href);
  }
  throw new Error("找不到 S4 垫片 s4-frontend-harness.mjs（既不在同目录，也不在仓内接缝目录）");
};

const H = await loadHarness();
const {
  CLIENT_PATH,
  createReact,
  createSandbox,
  loadClient,
  createSlotHost,
  createFakeTransport,
  panelRoutes,
  panelFixtures,
  rootKeys,
  inspectProductionSurface,
} = H;

const resolveClientPath = () => {
  const fromEnv = process.env.DSH_GATE_CLIENT_PATH;
  if (typeof fromEnv === "string" && fromEnv.length > 0 && fs.existsSync(fromEnv)) return path.resolve(fromEnv);
  const local = path.join(HERE, "client-index.js");
  if (fs.existsSync(local)) return local;
  return CLIENT_PATH;
};
const CLIENT = resolveClientPath();
const readSource = () => fs.readFileSync(CLIENT, "utf8");

const resolveBaselinePath = () => {
  const candidates = [
    process.env.DSH_GATE_BASELINE_CLIENT,
    path.resolve(HERE, "../../../dsh-gate-dev/client/index.js"),
    path.resolve(HERE, "../../client/index.js"),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    if (!fs.existsSync(candidate)) continue;
    if (path.resolve(candidate) === path.resolve(CLIENT)) continue;
    return path.resolve(candidate);
  }
  return null;
};
const BASELINE = resolveBaselinePath();
const readBaseline = () => (BASELINE === null ? "" : fs.readFileSync(BASELINE, "utf8"));

const loadHook = () => {
  const { react } = createReact();
  const loaded = loadClient({ sandbox: createSandbox({ react, hook: true }), source: readSource() });
  assert.equal(loaded.hook.present, true, "门控钩子必须只在预置时挂载");
  return { hook: loaded.hook.value, loaded };
};

const mount = async (options = {}) => {
  const { react, createRenderer } = createReact();
  const transport = createFakeTransport(options.routes || panelRoutes(options.fixtures));
  const sandbox = createSandbox({ react, fetch: transport.fetch });
  const loaded = loadClient({ sandbox, source: options.source === undefined ? readSource() : options.source });
  const host = createSlotHost();
  host.apply(loaded.exports);
  const element = host.component(options.slotProps || {});
  const mounted = createRenderer().mount(element);
  await mounted.settle();
  return { react, transport, sandbox, loaded, host, mounted, element };
};

const walk = (node, visit) => {
  if (!node) return;
  visit(node);
  const children = node.children || [];
  for (let index = 0; index < children.length; index += 1) walk(children[index], visit);
};
const findAll = (tree, predicate) => {
  const out = [];
  walk(tree, (node) => { if (predicate(node)) out.push(node); });
  return out;
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const plain = (value) => JSON.parse(JSON.stringify(value));
const agentRoutes = (agent) => {
  const base = panelRoutes();
  const out = {};
  for (const [key, value] of Object.entries(base)) out[key + "?agent=" + encodeURIComponent(agent)] = value;
  return out;
};

const createManualTransport = () => {
  const reads = [];
  const writes = [];
  const createSignal = () => {
    const listeners = [];
    let aborted = false;
    return {
      get aborted() { return aborted; },
      abort() { if (aborted) return; aborted = true; listeners.slice().forEach((fn) => fn()); },
      addEventListener(type, fn) { if (type === "abort" && typeof fn === "function") listeners.push(fn); },
      removeEventListener(type, fn) { if (type !== "abort") return; const index = listeners.indexOf(fn); if (index >= 0) listeners.splice(index, 1); },
    };
  };
  const transport = {
    read: (requestPath, options) => new Promise((resolve) => reads.push({ path: requestPath, options: options, resolve: resolve })),
    write: (requestPath, body, options) => new Promise((resolve) => writes.push({ path: requestPath, body: body, options: options, resolve: resolve })),
    diagnose: async () => ({ ok: true, status: 200, body: { sessions: [{ agent: "s1" }, { agent: "s2" }] }, warnings: [] }),
    createSignal: createSignal,
  };
  return { transport, reads, writes };
};

const policyBody = (revision, tag) => ({ version: 3, revision: revision, content: { version: 3, capabilities: {}, agent: tag }, template: { version: 3, capabilities: {} } });
const okRead = (tag, revision) => ({ ok: true, status: 200, body: tag === "policy" ? policyBody(revision, tag) : { agent: tag, version: 3, capabilities: [], servers: [], skills: [] }, warnings: [], error: "" });

const scriptedTransport = (writeResults) => {
  const writes = [];
  const createSignal = () => ({ aborted: false, abort() { this.aborted = true; }, addEventListener() {}, removeEventListener() {} });
  const transport = {
    read: async (requestPath) => {
      if (requestPath.indexOf("/policy") >= 0) return okRead("policy", 3);
      if (requestPath.indexOf("/capabilities") >= 0) return okRead("view", 3);
      if (requestPath.indexOf("/state") >= 0) return okRead("state", 3);
      return { ok: true, status: 200, body: {}, warnings: [], error: "" };
    },
    write: async (requestPath, body, options) => {
      writes.push({ path: requestPath, body: body, options: options });
      const next = writeResults.length > 0 ? writeResults.shift() : { ok: true, status: 200, body: { changed: true, revision: 4 }, warnings: [] };
      return typeof next === "function" ? next(body, options) : next;
    },
    diagnose: async () => ({ ok: true, status: 200, body: { sessions: [] }, warnings: [] }),
    createSignal: createSignal,
  };
  return { transport, writes };
};

/* ── 1. 契约与静态自检 ─────────────────────────────────────────────── */

test("#07 · 单文件外壳内 L1-L7 七个命名空间齐备且可求值", () => {
  const source = readSource();
  for (let index = 1; index <= 7; index += 1) {
    assert.match(source, new RegExp("function createL" + index + "[A-Za-z]+\\("), "缺少 L" + index + " 命名空间工厂");
  }
  const { hook } = loadHook();
  for (const name of ["L1", "L2", "L3", "L4"]) assert.equal(typeof hook[name].create, "function", name + " 必须通过门控钩子暴露工厂");
  assert.equal(typeof hook.primitives.createToastQueue, "function");
  assert.equal(typeof hook.shell.parseArgs, "function");
  assert.equal(hook.constants.PANEL_VERSION, "0.6.0");
});

test("#07 · 生产态导出仍严格是 ['apply','inject']，门控钩子只在预置时出现", () => {
  const { react } = createReact();
  const plain = loadClient({ sandbox: createSandbox({ react }), source: readSource() });
  assert.deepEqual(inspectProductionSurface(plain).keys, ["apply", "inject"]);
  assert.deepEqual(inspectProductionSurface(plain).problems, []);
  assert.equal(plain.window.__DSH_GATE_TEST_HOOK__, undefined, "生产态不许定义门控钩子");
  const { loaded } = loadHook();
  assert.deepEqual(Object.keys(loaded.exports).sort(), ["apply", "inject"], "挂上钩子也不许改变导出键集");
  assert.deepEqual(Array.from(loaded.exports.inject), ["slots"]);
});

test("#07 · 文案常量表每个键都被引用，且没有复活禁用旧称", () => {
  const { hook } = loadHook();
  const source = readSource();
  for (const key of hook.textKeys) assert.ok(source.indexOf(JSON.stringify(key)) >= 0, "文案表键未被引用：" + key);
  const called = new Set();
  const matcher = /text\("([^"]+)"\)/g;
  let match = matcher.exec(source);
  while (match) { called.add(match[1]); match = matcher.exec(source); }
  for (const key of called) assert.ok(hook.textKeys.indexOf(key) >= 0, "text() 用了文案表里不存在的键：" + key);
  for (const banned of ["档位", "屏蔽表", "挂起开关", "未知覆盖"]) assert.equal(source.indexOf(banned), -1, "不许复活旧称：" + banned);
});

test("#07 · 样式只用命名分区、同类规则单定义、焦点环≥2px、尊重减少动态", () => {
  const { hook } = loadHook();
  const sections = hook.style.sections.filter((section) => section[0] !== "responsive" && section[0] !== "motion");
  const css = sections.map((section) => section[1]).join("");
  assert.ok(css.indexOf("--dsw-alias-") >= 0, "必须使用主题令牌");
  assert.ok(css.indexOf(":focus-visible") >= 0 && css.indexOf("outline:2px") >= 0, "焦点环不小于两像素");
  assert.ok(hook.style.text.indexOf("prefers-reduced-motion") >= 0, "必须尊重减少动态");
  const seen = new Set();
  const duplicates = [];
  for (const part of css.split("}")) {
    const selector = part.split("{")[0].trim();
    if (selector.length === 0) continue;
    if (!selector.startsWith(".") && !selector.startsWith("*")) continue;
    if (seen.has(selector)) duplicates.push(selector);
    seen.add(selector);
  }
  assert.deepEqual(duplicates, [], "同类规则必须单定义");
  assert.equal(hook.style.attr, "data-dsh-gate", "幂等注入的宿主节点必须按属性唯一确定");
});

test("#07 · 入口只做装配（注册段不超过二十行）", () => {
  const source = readSource();
  const start = source.indexOf("    exports.inject");
  const end = source.indexOf("    return module.exports;");
  assert.ok(start > 0 && end > start, "找不到入口注册段");
  const lines = source.slice(start, end).split("\n").length;
  assert.ok(lines <= 20, "入口注册段应不超过二十行，实际 " + lines);
});

/* ── 2. L1 传输 ───────────────────────────────────────────────────── */

test("#07 · L1 六类失败归一真值全绿（含 2xx 但 ok:false）", async () => {
  const { hook } = loadHook();
  const response = (status, text) => ({ status: status, ok: status >= 200 && status < 300, text: async () => text });
  const make = (fetchImpl) => hook.L1.create({ fetch: fetchImpl, setTimeout: setTimeout, clearTimeout: clearTimeout, backoffMs: 0 });
  const timeout = await make(() => new Promise(() => {})).read("/timeout", { timeoutMs: 25 });
  assert.deepEqual([timeout.ok, timeout.status, timeout.kind], [false, 0, "timeout"]);

  const abortedSignal = make(async () => new Promise(() => {})).createSignal();
  setTimeout(() => abortedSignal.abort(), 10);
  const aborted = await make(async () => new Promise(() => {})).read("/aborted", { signal: abortedSignal, timeoutMs: 400 });
  assert.deepEqual([aborted.ok, aborted.kind], [false, "aborted"]);

  const network = await make(async () => { throw new TypeError("Failed to fetch"); }).read("/network");
  assert.deepEqual([network.ok, network.status, network.kind], [false, 0, "network"]);

  const http = await make(async () => response(500, JSON.stringify({ message: "服务端 500" }))).read("/http");
  assert.deepEqual([http.ok, http.status, http.kind, http.error], [false, 500, "http", "服务端 500"]);

  const protocol = await make(async () => response(200, "<html>不是 JSON</html>")).read("/protocol");
  assert.deepEqual([protocol.ok, protocol.kind], [false, "protocol"]);

  const envelope = await make(async () => response(200, JSON.stringify({ ok: false, message: "业务失败" }))).read("/envelope");
  assert.deepEqual([envelope.ok, envelope.kind, envelope.error], [false, "protocol", "业务失败"]);

  const auth = await make(async () => response(401, JSON.stringify({ error: "unauthorized" }))).read("/auth");
  assert.deepEqual([auth.ok, auth.kind, auth.status], [false, "auth", 401]);

  const missing = await make(async () => response(404, JSON.stringify({ error: "not found" }))).read("/missing");
  assert.deepEqual([missing.ok, missing.kind, missing.capabilityMissing], [false, "missing", true]);

  const success = await make(async () => response(200, JSON.stringify({ hello: "world" }))).read("/ok");
  assert.deepEqual([success.ok, success.status, success.body], [true, 200, { hello: "world" }]);
});

test("#07 · L1 读重试一次、写不重试、头浅合并、告警上抛", async () => {
  const { hook } = loadHook();
  const response = (status, text) => ({ status: status, ok: status >= 200 && status < 300, text: async () => text });
  const calls = [];
  const flaky = hook.L1.create({
    fetch: async (url, init) => {
      calls.push({ url: url, init: init });
      if (calls.length === 1) throw new TypeError("Failed to fetch");
      return response(200, JSON.stringify({ ok: true, warnings: [{ code: "W1" }] }));
    },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    backoffMs: 0,
  });
  const read = await flaky.read("/read", { headers: { "x-trace": "abc" } });
  assert.equal(calls.length, 2, "读请求遇到连接失败只重试一次");
  assert.equal(read.meta.attempts, 2);
  assert.equal(read.warnings.length, 1, "告警必须上抛");
  assert.equal(calls[0].init.headers["x-trace"], "abc", "自定义头浅合并");
  assert.equal(calls[0].init.headers["content-type"], undefined, "读请求不发 JSON 内容类型");

  const writeCalls = [];
  const failing = hook.L1.create({
    fetch: async (url, init) => { writeCalls.push({ url: url, init: init }); throw new TypeError("Failed to fetch"); },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    backoffMs: 0,
  });
  const write = await failing.write("/write", { a: 1 });
  assert.equal(writeCalls.length, 1, "写请求不自动重试");
  assert.equal(write.kind, "network");
  assert.equal(writeCalls[0].init.headers["content-type"], "application/json");
  assert.ok(String(writeCalls[0].init.headers["x-dsh-gate-idempotency"] || "").length > 0, "写请求必须带客户端幂等键");
});

test("#07 · L1 超时预算 8/15/5 秒，且最坏路径不超过 16 秒", () => {
  const { hook } = loadHook();
  assert.deepEqual(plain(hook.L1.TIMEOUTS), { read: 8000, write: 15000, diagnose: 5000 });
  const transport = hook.L1.create({ fetch: async () => ({ status: 200, ok: true, text: async () => "{}" }), setTimeout: setTimeout, clearTimeout: clearTimeout });
  assert.equal(transport.HARD_CEILING_MS, 16000);
  assert.ok(transport.TIMEOUTS.write + transport.BACKOFF_MS <= 16000, "写 15 秒 + 退避必须落在 16 秒硬上限内");
  assert.ok(transport.TIMEOUTS.read * 2 + transport.BACKOFF_MS <= 16500, "读两次 8 秒加退避仍须有明确结果");
});

/* ── 3. L2 草稿仓库 ──────────────────────────────────────────────── */

const emptyBaseline = () => ({
  version: 3,
  defaults: { capability: 2, section: 1, skillpack: 2 },
  capabilities: { "native:read": { tier: 1 } },
  skills: { takeover: true, off: ["legacy-skill"], imports: [] },
  catalog: { groupByPlugin: true, maxDescriptionLength: 64 },
  repeatGuard: { enabled: true, windowSize: 10, threshold: 3, reminders: 1, previewChars: 400, exclusions: [] },
});

test("#07 · L2 规范键只用 cap/exc/skill/section/imp（禁止显示名与下标当键）", () => {
  const { hook } = loadHook();
  const draft = hook.L2.create({});
  assert.equal(draft.keys.cap("native:read"), "cap:native:read");
  assert.equal(draft.keys.exception("native:read", "tool", "read"), "exc:native:read|tool:read");
  assert.equal(draft.keys.skill("matlab-use-package-manager"), "skill:matlab-use-package-manager");
  assert.equal(draft.keys.section("core"), "section:core");
  assert.match(draft.keys.imports("D:/skills/demo", 0), /^imp:[0-9a-f]+#00$/);
  assert.notEqual(draft.keys.imports("D:/skills/demo", 0), draft.keys.imports("D:/skills/other", 0), "导入按内容哈希区分");
});

test("#07 · L2 动作级撤销重做、栈上限 50、撤销后按基线重算脏", () => {
  const { hook } = loadHook();
  const draft = hook.L2.create({});
  draft.setBaseline(emptyBaseline());
  assert.equal(draft.dirtyCount(), 0);
  draft.stage(draft.keys.cap("native:read"), 2, "改层");
  assert.equal(draft.dirtyCount(), 1);
  assert.equal(draft.undoDepth(), 1);
  draft.undo();
  assert.equal(draft.dirtyCount(), 0, "撤销后必须与基线比对重算脏");
  assert.equal(draft.canRedo(), true);
  draft.redo();
  assert.equal(draft.dirtyCount(), 1);
  for (let index = 0; index < 60; index += 1) draft.stage(draft.keys.cap("cap:" + index), 1);
  assert.equal(draft.undoDepth(), 50, "撤销栈上限五十");
});

test("#07 · L2 刷新前置判据唯一为脏总量，确认文案列出能力/技能/JSON", () => {
  const { hook } = loadHook();
  const draft = hook.L2.create({});
  draft.setBaseline(emptyBaseline());
  draft.stage(draft.keys.cap("native:read"), 2);
  draft.stage(draft.keys.cap("plugin:x"), 0);
  draft.stage(draft.keys.skill("s1"), 0);
  draft.json.setDirty(true);
  const summary = draft.dirtySummary();
  assert.equal(summary.total, 4);
  assert.ok(summary.text.indexOf("能力 2 项") >= 0, summary.text);
  assert.ok(summary.text.indexOf("技能 1 项") >= 0, summary.text);
  assert.ok(summary.text.indexOf("JSON 草稿") >= 0, summary.text);
  assert.equal(draft.dirtyCount() > 0, true, "唯一刷新前置判据是脏总量大于零");
});

test("#07 · L2 服务端基线不覆盖脏切片，提交体来自同一生成器", () => {
  const { hook } = loadHook();
  const draft = hook.L2.create({});
  draft.setBaseline(emptyBaseline());
  draft.stage(draft.keys.cap("native:read"), 2);
  const next = emptyBaseline();
  next.capabilities["native:read"] = { tier: 1 };
  next.capabilities["native:write"] = { tier: 1 };
  draft.setBaseline(next);
  assert.equal(draft.dirtyCount(), 1, "脏切片必须保留");
  assert.equal(draft.toPolicy().capabilities["native:read"].tier, 2, "提交体必须来自同一生成器");
  assert.equal(draft.toPolicy().capabilities["native:write"].tier, 1, "未脏切片用服务端值");
  draft.commitKeys([draft.keys.cap("native:read")]);
  assert.equal(draft.dirtyCount(), 0);
});

test("#07 · L2 JSON 格式化只在真改字节时置脏", () => {
  const { hook } = loadHook();
  const draft = hook.L2.create({});
  assert.equal(draft.json.setDirty(false, "abc"), true);
  assert.equal(draft.json.setDirty(false, "abc"), false, "同值设置不得置脏");
  assert.equal(draft.json.snapshot().dirty, false);
  assert.equal(draft.json.setText("abc"), false);
  assert.equal(draft.json.setText("abcd"), true);
});

/* ── 4. L3 投影 ──────────────────────────────────────────────────── */

const baseBuildInput = (patch) => Object.assign({
  dataKey: 1,
  state: { skills: [], warnings: [] },
  view: { capabilities: [], warnings: [] },
  policy: { content: { version: 3, capabilities: {} } },
  draft: { revision: 1, caps: {}, skills: {}, exceptions: {}, summary: { total: 0 } },
  query: "",
  sourceFilter: "all",
  statusFilter: "all",
}, patch || {});

test("#07 · L3 层值真值表全行（null/空串/布尔/数组/对象/小数负数越界/「七」）", () => {
  const { hook } = loadHook();
  const projection = hook.L3.create({});
  const rows = [
    [0, "set", 0], [1, "set", 1], [2, "set", 2],
    ["2", "set", 2], [" 2 ", "set", 2], ["0", "set", 0],
    [null, "unset", null], [undefined, "unset", null], ["", "unset", null],
    [true, "invalid", null], [false, "invalid", null],
    [[], "invalid", null], [["1"], "invalid", null], [{}, "invalid", null], [{ tier: 1 }, "invalid", null],
    [3, "invalid", null], [-1, "invalid", null], [1.5, "invalid", null], ["七", "invalid", null], ["2.0", "invalid", null],
  ];
  for (const entry of rows) {
    const parsed = projection.parseTierValue(entry[0]);
    assert.equal(parsed.state, entry[1], "输入 " + JSON.stringify(entry[0]) + " 的 state 应为 " + entry[1]);
    assert.equal(parsed.value, entry[2], "输入 " + JSON.stringify(entry[0]) + " 的 value 应为 " + String(entry[2]));
    if (entry[1] === "invalid") assert.equal(parsed.blocking, true, "非法层值必须阻断保存");
  }
  assert.equal(projection.parseTierValue(" 2 ").warning.length > 0, true, "带空白数字串必须记警告");
});

test("#07 · L3 非法层值标红并阻断保存，未知不折算成关闭", () => {
  const { hook } = loadHook();
  const projection = hook.L3.create({});
  const model = projection.build(baseBuildInput({ dataKey: 11, view: { capabilities: [{ id: "native:read", tier: "七" }, { id: "native:write", tier: null }] } }));
  assert.equal(model.rows.length, 2);
  const bad = model.rows.find((row) => row.id === "native:read");
  assert.equal(bad.blocking, true);
  assert.equal(bad.invalid, true);
  assert.equal(model.stats.invalid, 1);
  const unset = model.rows.find((row) => row.id === "native:write");
  assert.equal(unset.savedState, "unset", "null 必须是未设置，不能折算成关闭");
  assert.notEqual(unset.effectiveTier, 0);
});

test("#07 · L3 合成行与真实行去重、种类单派生（H105）", () => {
  const { hook } = loadHook();
  const projection = hook.L3.create({});
  const synthetic = projection.build(baseBuildInput({ dataKey: 21, state: { skills: ["s1", "s2"] } }));
  const syntheticRows = synthetic.rows.filter((row) => row.id === "skillpack:*");
  assert.equal(syntheticRows.length, 1);
  assert.equal(syntheticRows[0].kind, "skillpack", "合成行的种类必须由 id 单派生，不能手写成 skill");
  assert.equal(synthetic.stats.skills, 2);

  const real = projection.build(baseBuildInput({ dataKey: 22, state: { skills: ["s1"] }, view: { capabilities: [{ id: "skillpack:host", tier: 2, skills: ["s1"] }] } }));
  assert.equal(real.rows.filter((row) => row.id === "skillpack:*").length, 0, "有真实行时不许再加合成行");
  assert.equal(real.rows.filter((row) => row.kind === "skillpack").length, 1);
  assert.equal(real.rows.find((row) => row.kind === "skillpack").merged, true);
});

test("#07 · L3 缺字段只降级该卡片：不抛错、记抱怨、其余行照常（P0-2/J114）", () => {
  const { hook } = loadHook();
  const projection = hook.L3.create({});
  const model = projection.build(baseBuildInput({
    dataKey: 31,
    view: {
      capabilities: [null, { id: "native:read", tools: [{ name: "read" }] }, { id: "native:write", deviations: [null], tools: [null] }],
      deviations: [null, { name: "x" }],
      upstreamHidden: "不是数组",
    },
  }));
  assert.equal(model.rows.length, 2, "坏记录被跳过，好记录照常进模型");
  assert.ok(model.complaints.length >= 4, "每条坏字段都必须留下抱怨：" + model.complaints.length);
  assert.equal(model.stats.deviations, 1);
  assert.equal(model.facts, undefined);
});

test("#07 · L3 分组头三值展开：搜索态首点即收起（J119）", () => {
  const { hook } = loadHook();
  const projection = hook.L3.create({});
  assert.equal(projection.groupNextOpen(undefined, true), false, "搜索态未记录时当前是展开，首点必须收起");
  assert.equal(projection.groupNextOpen(false, true), true);
  assert.equal(projection.groupNextOpen(undefined, false), true, "非搜索态未记录时当前是收起，首点必须展开");
  assert.equal(projection.groupNextOpen(true, false), false);
});

test("#07 · L3 决策链与差异计算（影响计数与落盘同源，J109/K129）", () => {
  const { hook } = loadHook();
  const projection = hook.L3.create({});
  const model = projection.build(baseBuildInput({
    dataKey: 41,
    view: { capabilities: [{ id: "native:read", tier: 1, tools: [{ name: "read", tier: 1, reason: "own", confidence: "high", via: "native" }] }] },
  }));
  const chain = model.rows[0].chain;
  assert.equal(chain.winner, "own");
  assert.equal(chain.finalTier, 1);
  assert.ok(chain.text.length > 0);

  const before = { capabilities: { "native:read": { tier: 1 }, "native:write": { tier: 1 } }, defaults: { skillpack: 2 }, skills: { imports: [] } };
  const after = { capabilities: { "native:read": { tier: 0 } }, defaults: { skillpack: 0 }, skills: { imports: [{ path: "D:/skills/new" }] } };
  const diff = projection.diffPolicies(before, after);
  assert.equal(diff.flips.length, 2, "能力翻转 + defaults 翻转");
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.counts.total, 4);
  assert.ok(diff.text.indexOf("翻转 2 项") >= 0, diff.text);
});

test("#07 · L3 按输入指纹缓存：同一输入零重算（J116 的数据侧）", () => {
  const { hook } = loadHook();
  const projection = hook.L3.create({});
  const input = baseBuildInput({ dataKey: 51 });
  projection.build(input);
  const before = projection.metrics().recomputes;
  for (let index = 0; index < 30; index += 1) projection.build(input);
  assert.equal(projection.metrics().recomputes, before, "同一指纹必须命中缓存");
  assert.ok(projection.metrics().hits >= 30);
});

/* ── 5. L4 编排 ──────────────────────────────────────────────────── */

test("#07 · L4 代际：旧轮响应不上屏、引用计数不提前解禁（H101）", async () => {
  const { hook } = loadHook();
  const manual = createManualTransport();
  const orchestrator = hook.L4.create({ transport: manual.transport, draft: hook.L2.create({}), projection: hook.L3.create({}), hardCeilingMs: 5000 });
  const first = orchestrator.loadRound({}).promise;
  const second = orchestrator.loadRound({}).promise;
  assert.equal(manual.reads.length, 10, "两轮各五个源");
  for (let index = 5; index < 10; index += 1) manual.reads[index].resolve(okRead("second-" + index, 2));
  await tick();
  assert.equal(orchestrator.pending(), 1, "第一轮未完不得把 pending 解禁");
  assert.equal(orchestrator.getSnapshot().loading, true, "载入态是引用计数不是布尔");
  for (let index = 0; index < 5; index += 1) manual.reads[index].resolve(okRead("first-" + index, 1));
  const results = await Promise.all([first, second]);
  assert.equal(results[1].applied, true);
  assert.equal(results[1].stale, false);
  assert.equal(results[0].applied, false);
  assert.equal(results[0].stale, true, "旧轮响应必须被判陈旧并丢弃");
  assert.equal(orchestrator.pending(), 0);
  assert.equal(orchestrator.getSnapshot().data.state.agent, "second-5", "上屏的必须是新轮数据（第二个状态源响应）");
});

test("#07 · L4 任何请求不返回都要在硬上限内进错误态（H99）", async () => {
  const { hook } = loadHook();
  const silent = { read: () => new Promise(() => {}), write: () => new Promise(() => {}), diagnose: () => new Promise(() => {}), createSignal: () => ({ aborted: false, abort() {}, addEventListener() {}, removeEventListener() {} }) };
  const orchestrator = hook.L4.create({ transport: silent, draft: hook.L2.create({}), projection: hook.L3.create({}), hardCeilingMs: 30 });
  const result = await orchestrator.loadRound({}).promise;
  assert.equal(result.timedOut, true);
  const snapshot = orchestrator.getSnapshot();
  assert.equal(snapshot.loading, false, "超时后必须解除载入态");
  assert.match(snapshot.lastError, /超时/);
});

test("#07 · L4 单飞加最新优先，写后推进 epoch 让早于写的读作废", async () => {
  const { hook } = loadHook();
  const manual = createManualTransport();
  const draft = hook.L2.create({});
  draft.setBaseline(emptyBaseline());
  const orchestrator = hook.L4.create({ transport: manual.transport, draft: draft, projection: hook.L3.create({}), hardCeilingMs: 5000 });
  const first = orchestrator.refresh({ reason: "manual" });
  const inflightAgain = orchestrator.refresh({ reason: "manual" });
  assert.equal(first, inflightAgain, "同源刷新必须单飞");
  assert.equal(manual.reads.length, 5, "单飞期间不得再发一轮");
  for (let index = 0; index < 5; index += 1) manual.reads[index].resolve(okRead("round-1", 1));
  await Promise.all([first]);
  await tick();
  assert.equal(manual.reads.length, 10, "挂起的刷新要在当前轮结束后补跑且只补一次");

  const stale = orchestrator.loadRound({}).promise;
  assert.equal(manual.reads.length, 15);
  const writePromise = orchestrator.write({ path: "/api/dsh-gate/policy", action: "policy", body: { enabled: true } });
  await tick();
  assert.equal(manual.writes.length, 1);
  manual.writes[0].resolve({ ok: true, status: 200, body: { changed: true, revision: 9 }, warnings: [] });
  const receipt = await writePromise;
  assert.equal(receipt.state, "applied");
  for (let index = 10; index < 15; index += 1) manual.reads[index].resolve(okRead("stale", 1));
  const staleResult = await stale;
  assert.equal(staleResult.stale, true, "写成功后，早于写的在途读必须作废");
  for (let index = 5; index < 10; index += 1) manual.reads[index].resolve(okRead("round-2", 2));
  orchestrator.dispose();
});

test("#07 · L4 双击保存只写一次、写之间排队（H102）", async () => {
  const { hook } = loadHook();
  const manual = createManualTransport();
  const orchestrator = hook.L4.create({ transport: manual.transport, draft: hook.L2.create({}), projection: hook.L3.create({}), hardCeilingMs: 5000 });
  const first = orchestrator.write({ path: "/api/dsh-gate/policy", action: "policy", body: { enabled: true } });
  const second = orchestrator.write({ path: "/api/dsh-gate/policy", action: "policy", body: { enabled: true } });
  assert.equal(first, second, "相同动作与体必须合并成同一次写");
  await tick();
  assert.equal(manual.writes.length, 1);
  manual.writes[0].resolve({ ok: true, status: 200, body: { changed: true, revision: 2 }, warnings: [] });
  await first;
  const queued = orchestrator.write({ path: "/api/dsh-gate/policy", action: "policy", body: {} });
  const queued2 = orchestrator.write({ path: "/api/dsh-gate/policy", action: "policy", body: { other: 1 } });
  await tick();
  assert.equal(manual.writes.length, 2, "不同体排队，一次只有一个写在途");
  manual.writes[1].resolve({ ok: true, status: 200, body: { changed: true, revision: 3 }, warnings: [] });
  await queued;
  await tick();
  assert.equal(manual.writes.length, 3);
  manual.writes[2].resolve({ ok: true, status: 200, body: { changed: false }, warnings: [] });
  await queued2;
});

test("#07 · L4 技能批量一次落盘、无变化提示未写入、部分失败只留未执行（H96/H97/H98）", async () => {
  const { hook } = loadHook();
  const operations = [];
  for (let index = 0; index < 57; index += 1) operations.push({ action: "tier", name: "skill-" + index, tier: 2 });

  const applied = scriptedTransport([{ ok: true, status: 200, body: { changed: true, applied: operations.map((_, index) => ({ index: index, ok: true })), revision: 7 }, warnings: [] }]);
  const orchestrator = hook.L4.create({ transport: applied.transport, draft: hook.L2.create({}), projection: hook.L3.create({}), hardCeilingMs: 3000 });
  const receipt = await orchestrator.saveSkills(operations);
  assert.equal(applied.writes.length, 1, "五十七条技能必须一次请求落盘");
  const sent = JSON.parse(applied.writes[0].body);
  assert.equal(sent.action, "batch");
  assert.equal(sent.operations.length, 57);
  assert.equal(receipt.state, "applied");

  const partialTransport = scriptedTransport([{ ok: true, status: 200, body: { changed: true, applied: [{ index: 0, ok: true }], failed: [{ index: 1, reason: "目录不存在" }], notExecuted: [{ index: 2 }], revision: 7 }, warnings: [] }]);
  const partialOrch = hook.L4.create({ transport: partialTransport.transport, draft: hook.L2.create({}), projection: hook.L3.create({}), hardCeilingMs: 3000 });
  const partial = await partialOrch.saveSkills([{ action: "tier", name: "a", tier: 1 }, { action: "imports", imports: [] }, { action: "takeover", value: false }]);
  assert.equal(partial.state, "partial");
  assert.equal(partial.notExecuted.length, 1, "未执行项必须点名留在草稿");
  assert.equal(partial.failed[0].reason, "目录不存在");

  const noChange = scriptedTransport([{ ok: true, status: 200, body: { changed: false }, warnings: [] }]);
  const noChangeOrch = hook.L4.create({ transport: noChange.transport, draft: hook.L2.create({}), projection: hook.L3.create({}), hardCeilingMs: 3000 });
  const untouched = await noChangeOrch.saveSkills([{ action: "tier", name: "a", tier: 1 }]);
  assert.equal(untouched.state, "no-change");
  assert.match(untouched.message, /没有变化/);
});

test("#07 · L4 服务端缺批量动作时按顺序降级并给部分失败回执（H97）", async () => {
  const { hook } = loadHook();
  const scripted = scriptedTransport([
    { ok: false, status: 400, code: "UNSUPPORTED_ACTION", body: { ok: false, code: "UNSUPPORTED_ACTION", message: "unknown action" }, error: "unknown action", warnings: [] },
    { ok: true, status: 200, body: { changed: true, revision: 5 }, warnings: [] },
    { ok: false, status: 400, code: "INVALID_TIER", body: { ok: false, code: "INVALID_TIER", message: "非法层值" }, error: "非法层值", warnings: [] },
  ]);
  const orchestrator = hook.L4.create({ transport: scripted.transport, draft: hook.L2.create({}), projection: hook.L3.create({}), hardCeilingMs: 3000 });
  const receipt = await orchestrator.saveSkills([{ action: "tier", name: "a", tier: 1 }, { action: "tier", name: "b", tier: 7 }, { action: "takeover", value: true }]);
  assert.equal(receipt.degraded, true);
  assert.equal(receipt.state, "partial");
  assert.equal(receipt.applied.length, 1);
  assert.equal(receipt.failed.length, 1);
  assert.equal(receipt.notExecuted.length, 1, "失败处之后的动作必须点名未执行");
  assert.equal(scripted.writes.length, 3, "批量 + 成功一条 + 失败一条（失败即停）");
});

test("#07 · L4 revision 冲突给三选一，不静默覆盖（H98/I112）", async () => {
  const { hook } = loadHook();
  const scripted = scriptedTransport([{ ok: false, status: 409, code: "REVISION_CONFLICT", body: { ok: false, code: "REVISION_CONFLICT", message: "revision 冲突", revision: 12 }, error: "revision 冲突", warnings: [] }]);
  const orchestrator = hook.L4.create({ transport: scripted.transport, draft: hook.L2.create({}), projection: hook.L3.create({}), hardCeilingMs: 3000 });
  const receipt = await orchestrator.savePolicy({ enabled: true });
  assert.equal(receipt.state, "conflict");
  assert.equal(receipt.choices.length, 3);
  assert.deepEqual(plain(receipt.choices.map((choice) => choice.value)), ["load-latest", "overwrite", "diff"]);
  assert.ok(receipt.choices.every((choice) => typeof choice.consequence === "string" && choice.consequence.length > 0));
});

test("#07 · L4 五入口统一脏集合确认 + 外部改动二选一（H93/I112）", () => {
  const { hook } = loadHook();
  const draft = hook.L2.create({});
  draft.setBaseline(emptyBaseline());
  const orchestrator = hook.L4.create({ transport: createManualTransport().transport, draft: draft, projection: hook.L3.create({}), hardCeilingMs: 3000 });
  assert.equal(orchestrator.preflight("reload").needsConfirm, false, "干净时不得弹确认");
  draft.stage(draft.keys.cap("native:read"), 2);
  draft.stage(draft.keys.skill("s"), 0);
  draft.json.setDirty(true);
  for (const action of ["reload", "save-policy", "save-skills", "save-signature", "mcp"]) {
    const gate = orchestrator.preflight(action);
    assert.equal(gate.needsConfirm, true, action + " 必须走同一确认");
    assert.ok(gate.summaryText.indexOf("能力") >= 0, action + " 的文案必须列出能力");
    assert.ok(gate.summaryText.indexOf("技能") >= 0, action + " 的文案必须列出技能");
    assert.ok(gate.summaryText.indexOf("JSON") >= 0, action + " 的文案必须列出 JSON");
    assert.ok(gate.consequence.indexOf("丢弃") >= 0);
  }
});

test("#07 · L4 自动刷新可关可调，脏/写在途/不可见时暂停（K132）", () => {
  const { hook } = loadHook();
  const orchestrator = hook.L4.create({ transport: createManualTransport().transport, draft: hook.L2.create({}), projection: hook.L3.create({}), hardCeilingMs: 3000 });
  assert.deepEqual(plain(orchestrator.AUTO_INTERVALS), [15, 30, 60]);
  assert.equal(orchestrator.autoRefreshDecision({ enabled: false }).run, false);
  assert.match(orchestrator.autoRefreshDecision({ enabled: false }).reason, /关闭/);
  assert.match(orchestrator.autoRefreshDecision({ enabled: true, dirtyCount: 2 }).reason, /草稿/);
  assert.equal(orchestrator.autoRefreshDecision({ enabled: true, dirtyCount: 2 }).run, false);
  assert.match(orchestrator.autoRefreshDecision({ enabled: true, dirtyCount: 0, writing: true }).reason, /写在途/);
  assert.match(orchestrator.autoRefreshDecision({ enabled: true, dirtyCount: 0, writing: false, visible: false }).reason, /不可见/);
  const run = orchestrator.autoRefreshDecision({ enabled: true, dirtyCount: 0, writing: false, visible: true });
  assert.equal(run.run, true);
  assert.equal(run.interval, 30);
});

test("#07 · L4 会话三级来源，读写一律带 agent（I110）", async () => {
  const { hook } = loadHook();
  const manual = createManualTransport();
  const orchestrator = hook.L4.create({ transport: manual.transport, draft: hook.L2.create({}), projection: hook.L3.create({}), agent: "session-7", hardCeilingMs: 3000 });
  assert.deepEqual(plain(orchestrator.session()), { agent: "session-7", source: "host" });
  assert.equal(hook.helpers.sessionLabelOf({ agent: "session-7", source: "host" }, (key) => key), "session-7（settings.sessionHost）");
  assert.deepEqual(plain(orchestrator.resolveSessionSource({ hostAgent: "h", selectedAgent: "p", autoAgent: "a" })), { agent: "h", source: "host" });
  assert.deepEqual(plain(orchestrator.resolveSessionSource({ selectedAgent: "p", autoAgent: "a" })), { agent: "p", source: "panel" });
  assert.deepEqual(plain(orchestrator.resolveSessionSource({ autoAgent: "a" })), { agent: "a", source: "auto" });
  const listed = await orchestrator.listSessions();
  assert.equal(listed.ok, true);
  assert.equal(listed.sessions.length, 2);
  void orchestrator.refresh({ reason: "test" });
  assert.equal(manual.reads.length, 5);
  for (const read of manual.reads) assert.equal(read.options.query.agent, "session-7", "所有读都必须携带会话标识");
});

test("#07 · L4 外部改动：无脏自动载入并提示，有脏给二选一并说明后果（I112）", async () => {
  const { hook } = loadHook();
  const scripted = scriptedTransport([]);
  const draft = hook.L2.create({});
  const orchestrator = hook.L4.create({ transport: scripted.transport, draft: draft, projection: hook.L3.create({}), hardCeilingMs: 3000 });
  await orchestrator.loadRound({}).promise;
  const clean = orchestrator.detectExternalChange({ revision: 99 });
  assert.equal(clean.changed, true);
  assert.equal(clean.automatic, true);
  assert.match(clean.message, /自动载入/);
  draft.stage(draft.keys.cap("native:read"), 0);
  const dirty = orchestrator.detectExternalChange({ revision: 99 });
  assert.equal(dirty.automatic, false);
  assert.equal(dirty.choices.length, 2);
  assert.deepEqual(plain(dirty.choices.map((choice) => choice.value)), ["load", "keep"]);
  assert.ok(dirty.choices.every((choice) => choice.consequence.length > 0));
});

/* ── 6. L5 原语 ──────────────────────────────────────────────────── */

test("#07 · L5 提示分级存活、同键合并、不堆叠超过五条（H108/J116）", () => {
  const { hook } = loadHook();
  const queue = hook.primitives.createToastQueue();
  assert.equal(hook.primitives.lifetimeOf("ok"), 4000);
  assert.equal(hook.primitives.lifetimeOf("info"), 6000);
  assert.equal(hook.primitives.lifetimeOf("warn"), 8000);
  assert.equal(hook.primitives.lifetimeOf("error"), 0, "错误驻留可关闭");
  for (let index = 0; index < 7; index += 1) queue.push({ key: "k" + index, tone: "info", text: "t" + index });
  assert.equal(queue.size(), 5, "固定槽位后最多五条");
  const merged = queue.push({ key: "k6", tone: "info", text: "合并后" });
  assert.equal(merged.count, 2, "同键合并");
  assert.equal(queue.size(), 5);
});

test("#07 · L5 确认条是对话框语义：焦点先落取消、Esc 取消、焦点可归还（L136）", () => {
  const { hook } = loadHook();
  const element = hook.primitives.confirmBar({ id: "dshg-confirm", title: "确认", text: "会丢草稿", onConfirm: () => {}, onCancel: () => {}, onKeyDown: () => {} });
  assert.equal(element.props.role, "alertdialog");
  assert.equal(element.props["aria-modal"], "true");
  assert.equal(element.props["aria-labelledby"], "dshg-confirm-title");
  const children = element.props.children;
  assert.equal(children.length, 3, "确认条 = 文本块 + 取消 + 确认");
  const cancel = children[1];
  const confirm = children[2];
  assert.equal(cancel.props.autoFocus, true, "初始焦点必须在取消");
  assert.equal(cancel.props["data-autofocus"], "cancel");
  assert.equal(confirm.props["data-primary"], "true");
  assert.equal(typeof element.props.onKeyDown, "function", "必须能处理 Esc");
});

test("#07 · L5 五态容器：未知永不冒充空态（K133）", () => {
  const { hook } = loadHook();
  const loading = hook.primitives.stateContainer({ state: "loading", rows: 2 });
  assert.equal(loading.props["aria-busy"], "true");
  const ready = hook.primitives.stateContainer({ state: "ready", children: "内容" });
  assert.equal(ready.props.className, "dshg-col");
  const empty = hook.primitives.stateContainer({ state: "empty", message: "确实没有数据" });
  assert.equal(empty.props.className, "dshg-empty");
  const error = hook.primitives.stateContainer({ state: "error", message: "读取失败", onRetry: () => {} });
  assert.equal(error.props.children[0].props.role, "alert");
  assert.equal(error.props.children[1].props.children, "重试");
  const partial = hook.primitives.stateContainer({ state: "partial", message: "部分源失败", children: "旧数据" });
  assert.equal(partial.props.children[0].props["data-tone"], "warn");
  assert.equal(hook.primitives.FIVE_STATES.length, 5);
});

/* ── 7. L6/L7 视图与外壳 ─────────────────────────────────────────── */

test("#07 · X-1 未知路由必须降级不白屏，其它页签照常可用", async () => {
  const mounted = await mount({ slotProps: { route: "detail/unknown" } });
  assert.ok(mounted.mounted.text.indexOf("这个视图暂不可用") >= 0, "未知视图必须降级到局部错误卡片");
  assert.ok(mounted.mounted.text.indexOf("能力") >= 0, "页签栏必须照常可用");
  assert.ok(mounted.mounted.text.indexOf("重试") >= 0, "降级卡片必须给重试");
  if (BASELINE) {
    const baseline = await mount({ slotProps: { route: "detail/unknown" }, source: readBaseline() });
    assert.equal(baseline.mounted.text.indexOf("这个视图暂不可用"), -1, "0.5.7 基线没有降级分支（先红证据）");
  }
});

test("#07 · P0-2 服务端少字段只降级该卡片，基线白屏（先红后绿）", async () => {
  const routes = panelRoutes();
  const fixtures = panelFixtures();
  routes["/api/dsh-gate/capabilities"] = { body: Object.assign({}, fixtures.view, { deviations: [null] }) };
  const mounted = await mount({ routes: routes });
  assert.ok(mounted.mounted.text.indexOf("数据不完整") >= 0, "必须显示数据不完整而不是空白");
  assert.ok(mounted.mounted.text.indexOf("能力") >= 0, "其余卡片照常可用");
  assert.ok(mounted.mounted.text.indexOf("读不到闸门状态") < 0, "局部降级不得升级成整页错误");
  if (BASELINE) {
    const { react, createRenderer } = createReact();
    const transport = createFakeTransport(routes);
    const sandbox = createSandbox({ react, fetch: transport.fetch });
    const loaded = loadClient({ sandbox, source: readBaseline() });
    const host = createSlotHost();
    host.apply(loaded.exports);
    await assert.rejects(async () => {
      const baselineMounted = createRenderer().mount(host.component({}));
      await baselineMounted.settle();
    }, (error) => /Cannot read properties|not a function/.test(String(error && error.message)), "0.5.7 在同一 fixture 上必须抛错（先红证据）");
  }
});

test("#07 · J116 固定槽位：载入态与就绪态根键完全相同，提示出现不平移兄弟", async () => {
  const { react, createRenderer } = createReact();
  const transport = createFakeTransport(panelRoutes());
  const sandbox = createSandbox({ react, fetch: transport.fetch });
  const loaded = loadClient({ sandbox, source: readSource() });
  const host = createSlotHost();
  host.apply(loaded.exports);
  const mounted = createRenderer().mount(host.component({}));
  const loadingKeys = rootKeys(mounted.tree);
  await mounted.settle();
  const readyKeys = rootKeys(mounted.tree);
  assert.deepEqual(loadingKeys, readyKeys, "根槽位必须固定，载入态与就绪态不得换位");
  assert.equal(loadingKeys.length, 9, "九个固定槽位：头/统计/健康/提示/对话框/工具条/页签/面板/页脚");
  assert.ok(loadingKeys.indexOf("div:toasts") >= 0, "提示槽必须永久占位");
});

test("#07 · L135 tablist 键盘与 roving tabindex、aria-controls 齐备", async () => {
  const mounted = await mount();
  const tabs = findAll(mounted.mounted.tree, (node) => node.props && node.props.role === "tab");
  assert.equal(tabs.length, 5, "五个页签：能力/技能/MCP/策略 JSON/设置");
  const selected = tabs.filter((tab) => tab.props["aria-selected"] === true);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].props.tabIndex, 0, "roving tabindex 只让当前页签可 Tab");
  for (const tab of tabs) {
    assert.match(String(tab.props["aria-controls"]), /^dshg-panel-/);
    assert.equal(typeof tab.props.tabIndex, "number");
  }
  const tablist = findAll(mounted.mounted.tree, (node) => node.props && node.props.role === "tablist");
  assert.equal(tablist.length, 1);
  assert.match(String(tablist[0].props.onKeyDown), /^\[fn:/, "tablist 必须处理方向键与 Home/End");
  const groupHeads = findAll(mounted.mounted.tree, (node) => node.props && node.props.className === "dshg-groupHead");
  assert.ok(groupHeads.length > 0);
  for (const head of groupHeads) assert.equal(typeof head.props["aria-expanded"], "boolean");
});

test("#07 · I110 宿主注入会话：五次读取全部带 ?agent=，健康条标注来源", async () => {
  const mounted = await mount({ slotProps: { agent: "session-7" }, routes: agentRoutes("session-7") });
  const paths = mounted.transport.paths();
  assert.equal(paths.length, 5);
  for (const requestPath of paths) {
    assert.equal(requestPath.indexOf("?agent=session-7") >= 0, true, "必须带会话标识：" + requestPath);
  }
  assert.ok(mounted.mounted.text.indexOf("宿主注入") >= 0, "健康条必须标注会话来源");
  const auto = await mount();
  for (const requestPath of auto.transport.paths()) assert.equal(requestPath.indexOf("agent="), -1, "未选择会话时不得擅自带参");
});

test("#07 · K129-K134 后端已有能力全量有入口（静态可读）", async () => {
  const mounted = await mount();
  const page = mounted.mounted.text;
  const required = [
    "重复劳动护栏", "自动刷新", "目录三选项", "撤销", "重做", "签名摘要", "会话",
    "尚未统计", "缓存", "恒在项", "导入导出", "整组设置", "旧关闭清单", "单键还原",
    "窗口（2–200）", "阈值（2–50）", "提醒（1–5）", "预览字符（40–4000）",
  ];
  for (const label of required) assert.ok(page.indexOf(label) >= 0, "缺少入口文案：" + label);
});

test("#07 · 默认模板只做兜底：服务端给了 template 就用服务端（FG-7 收口）", () => {
  const { hook } = loadHook();
  const server = { version: 3, defaults: { capability: 2, section: 1, skillpack: 2 }, capabilities: {} };
  const resolvedServer = hook.L3.create({}).resolveDefaultTemplate({ serverTemplate: server, fallback: hook.template() });
  assert.equal(resolvedServer.source, "server");
  assert.equal(resolvedServer.stale, false);
  assert.equal(resolvedServer.template, server);
  const resolvedFallback = hook.L3.create({}).resolveDefaultTemplate({ serverTemplate: null, fallback: hook.template() });
  assert.equal(resolvedFallback.source, "fallback");
  assert.equal(resolvedFallback.stale, true);
  assert.equal(resolvedFallback.template.version, 3);
});
