/**
 * S4 契约：前端零构建垫片 + 反向契约（默认导出只有 inject/apply、require 白名单）
 * + 假传输 6 类失败 + 渲染确定性 + 草稿跨页签 + 默认策略模板跨端一致性（FG-7 判据）。
 *
 * 运行：node --import ./test/stub-loader.mjs test/seams/s4-frontend-contract.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  CLIENT_PATH,
  PLATFORM_MODULES,
  PRODUCTION_EXPORT_KEYS,
  createReact,
  createSandbox,
  loadClient,
  inspectProductionSurface,
  createSlotHost,
  createFakeTransport,
  panelRoutes,
  panelFixtures,
  rootKeys,
  stableTree,
  treeEqual,
  createDraftStorage,
  createDraftRepo,
  readClientDefaultTemplate,
  serverDefaultTemplate,
  compareTemplates,
  summarizeDifferences,
  deepDiff,
} from "./s4-frontend-harness.mjs";
import { applyMutations } from "./mutation.mjs";

const clientSource = () => fs.readFileSync(CLIENT_PATH, "utf8");

const mountPanel = async (options = {}) => {
  const { react, createRenderer } = createReact();
  const transport = createFakeTransport(options.routes || panelRoutes(options.fixtures));
  const sandbox = createSandbox({ react, fetch: transport.fetch, hook: options.hook });
  const loaded = loadClient({ sandbox, source: options.source });
  const host = createSlotHost();
  host.apply(loaded.exports);
  const element = host.component({});
  const mounted = createRenderer().mount(element);
  await mounted.settle();
  return { react, transport, sandbox, loaded, host, mounted };
};

/* ── 1. 加载器捕获与生产态反向契约 ─────────────────────────────────────── */

test("S4 · loader 只调用一次且 id/factory 形状固定", () => {
  const { react } = createReact();
  const loaded = loadClient({ sandbox: createSandbox({ react }) });
  assert.equal(loaded.id, "dsh-gate");
  assert.equal(typeof loaded.factory, "function");
  assert.equal(loaded.loads.length, 1);
  assert.deepEqual(loaded.required, ["react"]);
});

test("S4 · 生产态导出键严格等于 ['apply','inject']（I-6 反向契约）", () => {
  const { react } = createReact();
  const loaded = loadClient({ sandbox: createSandbox({ react }) });
  const surface = inspectProductionSurface(loaded);
  assert.deepEqual(surface.keys, PRODUCTION_EXPORT_KEYS);
  assert.deepEqual(PRODUCTION_EXPORT_KEYS, ["apply", "inject"]);
  assert.equal(surface.ok, true);
  assert.deepEqual(surface.problems, []);
  // exports.inject 在 vm realm 里创建，先规整成本 realm 再深比较（跨 realm 的原型不同）。
  assert.deepEqual(Array.from(loaded.exports.inject), ["slots"]);
  assert.equal(typeof loaded.exports.apply, "function");
});

test("S4 · 生产态没有 __DSH_GATE_TEST_HOOK__（内部面不许裸奔）", () => {
  const { react } = createReact();
  const loaded = loadClient({ sandbox: createSandbox({ react }) });
  assert.deepEqual(loaded.hook, { present: false, source: "absent" });
  assert.equal(loaded.window.__DSH_GATE_TEST_HOOK__, undefined);
});

test("S4 · 载荷 require 白名单恰好 10 个模块，越界必须抛 MODULE_NOT_ALLOWED", () => {
  const { react } = createReact();
  const sandbox = createSandbox({ react });
  for (const name of PLATFORM_MODULES) assert.ok(sandbox.require(name), "白名单模块应可解析：" + name);
  assert.equal(PLATFORM_MODULES.length, 10);
  assert.throws(() => sandbox.require("node:fs"), (error) => error.code === "MODULE_NOT_ALLOWED");
  assert.throws(() => sandbox.require("@deepseek-ai/dsh-tools"), (error) => error.code === "MODULE_NOT_ALLOWED");
  assert.deepEqual(sandbox.unknown, ["node:fs", "@deepseek-ai/dsh-tools"]);
});

test("S4 · 真 client 是单文件 + 无 BOM + 只有一处 require('react')（与 check-spec 同源）", () => {
  const bytes = fs.readFileSync(CLIENT_PATH);
  assert.notDeepEqual(Array.from(bytes.subarray(0, 3)), [0xef, 0xbb, 0xbf], "client 不许带 BOM");
  const source = bytes.toString("utf8");
  assert.equal((source.match(/__ModuleLoader__\.load\(/g) || []).length, 1, "只允许一处 loader.load");
  const requires = source.match(/require\((["'])([^"']+)\1\)/g) || [];
  assert.deepEqual(requires, ['require("react")']);
});

/* ── 2. 槽位注册与两种视图 ─────────────────────────────────────────────── */

test("S4 · apply 只注册 plugins.row.config 的一个槽位（key 固定）", () => {
  const { react } = createReact();
  const loaded = loadClient({ sandbox: createSandbox({ react }) });
  const host = createSlotHost();
  host.apply(loaded.exports);
  assert.deepEqual(host.calls, [
    { kind: "inject", name: "plugins.row.config" },
    { kind: "register", name: "plugins.row.config", key: "dsh-gate#surface-gate" },
  ]);
  assert.equal(typeof host.component, "function");
});

test("S4 · summary 视图是纯字符串（无 DOM、无 React 也能求值）", () => {
  const { react } = createReact();
  const loaded = loadClient({ sandbox: createSandbox({ react }) });
  const host = createSlotHost();
  host.apply(loaded.exports);
  assert.equal(host.component({ view: "summary" }), "两层工具闸门 · 按能力开关");
  assert.equal(host.component({ view: "other" }).type.name, "GatePanel");
});

/* ── 3. 无头挂载：假传输喂真组件 ───────────────────────────────────────── */

test("S4 · 无头挂载真面板：五个接口各取一次，且不落错误态", async () => {
  const mounted = await mountPanel();
  assert.deepEqual(mounted.transport.paths(), [
    "/api/dsh-gate/state",
    "/api/dsh-gate/capabilities",
    "/api/dsh-gate/policy",
    "/api/dsh-gate/skills",
    "/api/dsh-gate/mcp",
  ]);
  assert.equal(mounted.mounted.tree.type, "div");
  assert.ok(mounted.mounted.text.includes("能力"), "面板应渲染能力 Tab");
  assert.ok(!mounted.mounted.text.includes("读不到闸门状态"), "错误 fixture 之外不许进错误态");
  assert.ok(mounted.mounted.renders >= 2, "reload 后必须至少重渲染一次");
});

test("S4 · 失败 fixture（state 500）进错误态并给出重试按钮", async () => {
  const routes = panelRoutes();
  routes["/api/dsh-gate/state"] = { status: 500, body: { message: "state 接口炸了" } };
  const mounted = await mountPanel({ routes });
  assert.ok(mounted.mounted.text.includes("读不到闸门状态"), "必须显示错误态");
  assert.ok(mounted.mounted.text.includes("state 接口炸了"), "错误文案透传 body.message");
  assert.ok(mounted.mounted.text.includes("重试"), "错误态必须提供重试");
});

test("S4 · 行投影两次挂载深相等（同一 fixture 必须逐字节一致）", async () => {
  const first = await mountPanel();
  const second = await mountPanel();
  const a = stableTree(first.mounted.tree);
  const b = stableTree(second.mounted.tree);
  const diffs = deepDiff(a, b);
  assert.deepEqual(diffs.map((item) => item.path + " => " + JSON.stringify(item.left) + " vs " + JSON.stringify(item.right)), [], "两次挂载不得有任何差异");
  assert.deepEqual(a, b, "两次挂载必须深相等（含键序）");
  assert.equal(treeEqual(first.mounted.tree, second.mounted.tree), true);
  assert.deepEqual(rootKeys(first.mounted.tree), rootKeys(second.mounted.tree));
});

test("S4 · 根子节点键稳定：非空、两次渲染同序同集", async () => {
  const mounted = await mountPanel();
  const keysBefore = rootKeys(mounted.mounted.tree);
  assert.ok(keysBefore.length > 0, "根节点必须有子节点");
  const again = mounted.mounted.rerender();
  assert.deepEqual(rootKeys(again.tree), keysBefore);
  assert.equal(treeEqual(again.tree, mounted.mounted.tree), true);
});

test("S4 · 确定性探针是灵敏的：注入随机值必须判不等（反向自检）", async () => {
  const { react, createRenderer } = createReact();
  const h = react.createElement;
  const Chaos = () => h("div", { className: "chaos" }, String(Math.random()));
  const mounted = createRenderer().mount(h(Chaos));
  const before = stableTree(mounted.tree);
  const after = stableTree(mounted.rerender().tree);
  assert.notDeepEqual(before, after, "随机内容必须让确定性判据变红");
});

/* ── 4. 假传输：6 类失败 + 成功 ────────────────────────────────────────── */

test("S4 · 假传输覆盖 timeout / aborted / network / http / protocol / auth", async () => {
  const transport = createFakeTransport({
    "/timeout": { failure: "timeout", detail: 800 },
    "/aborted": { failure: "aborted" },
    "/network": { failure: "network" },
    "/http": { status: 500, body: { message: "服务端 500" } },
    "/protocol": { status: 200, bodyText: "<html>不是 JSON</html>" },
    "/auth": { status: 401, body: { error: "unauthorized" } },
    "/ok": { body: { hello: "world" } },
  });
  const timeout = await transport.request("/timeout");
  assert.deepEqual([timeout.ok, timeout.status, timeout.body], [false, 0, null]);
  assert.match(timeout.error, /timeout|超时/i);

  const aborted = await transport.request("/aborted");
  assert.deepEqual([aborted.ok, aborted.status], [false, 0]);
  assert.match(aborted.error, /aborted|中断/i);

  const network = await transport.request("/network");
  assert.deepEqual([network.ok, network.status], [false, 0]);
  assert.match(network.error, /Failed to fetch/);

  const http = await transport.request("/http");
  assert.deepEqual([http.ok, http.status], [false, 500]);
  assert.equal(http.error, "服务端 500", "非 2xx 必须优先 body.message");

  const protocol = await transport.request("/protocol");
  assert.deepEqual([protocol.ok, protocol.status, protocol.body], [true, 200, null], "非 JSON 响应→body:null 但不判失败");

  const auth = await transport.request("/auth");
  assert.deepEqual([auth.ok, auth.status], [false, 401]);
  assert.equal(auth.error, "unauthorized");

  const ok = await transport.request("/ok");
  assert.deepEqual([ok.ok, ok.status, ok.body], [true, 200, { hello: "world" }]);
  assert.deepEqual(transport.paths(), ["/timeout", "/aborted", "/network", "/http", "/protocol", "/auth", "/ok"]);
});

test("S4 · 假传输返回深拷贝：调用方改坏响应不影响下一次", async () => {
  const transport = createFakeTransport({ "/fixture": { body: { nested: { value: 1 } } } });
  const first = await transport.request("/fixture");
  first.body.nested.value = 99;
  const second = await transport.request("/fixture");
  assert.equal(second.body.nested.value, 1);
});

/* ── 5. 草稿跨页签 ─────────────────────────────────────────────────────── */

test("S4 · 草稿仓库跨页签保存不丢未提交内容", () => {
  const storage = createDraftStorage();
  const tabA = createDraftRepo({ storage });
  const tabB = createDraftRepo({ storage });
  assert.equal(tabA.read(), null);
  const draft = { text: "未保存的 JSON 草稿", dirty: true, tab: "A" };
  tabA.write(draft);
  assert.deepEqual(tabB.read(), draft, "页签 B 必须看到 A 的未提交草稿");
  tabB.write({ text: "B 覆盖", dirty: true, tab: "B" });
  assert.deepEqual(tabA.read(), { text: "B 覆盖", dirty: true, tab: "B" });
  assert.deepEqual(Object.keys(storage.snapshot()), ["dsh-gate:draft"]);
  tabA.clear();
  assert.equal(tabB.read(), null, "清空后两个页签都读到 null");
});

/* ── 6. 默认策略模板跨端一致性（FG-7 判据） ───────────────────────────── */

test("S4 · 静态抽取 client 默认策略模板（hook 出现前唯一读取途径）", () => {
  const source = clientSource();
  const extracted = readClientDefaultTemplate({ source, hook: { present: false } });
  assert.equal(extracted.source, "static-extract");
  assert.ok(Array.isArray(extracted.span) && extracted.span[1] > extracted.span[0]);
  const template = extracted.template;
  assert.equal(template.version, 3);
  assert.deepEqual(template.defaults, { capability: 2, section: 1, skillpack: 2 });
  assert.equal(Object.keys(template.capabilities).length, 9, "空模板只写 9 个原生工具常驻");
  assert.equal(template.narrowPassThrough, 12);
  assert.deepEqual(template.protected, []);
});

test("S4 · 跨端模板比对必须抓到 0.5.7 的 6 处漂移（FG-7 先红）", () => {
  const source = clientSource();
  const client = readClientDefaultTemplate({ source, hook: { present: false } }).template;
  const server = serverDefaultTemplate();
  const compared = compareTemplates(client, server);
  assert.equal(compared.equal, false, "0.5.7 前端手抄模板与服务端权威模板必然不一致");
  const paths = compared.differences.map((item) => item.path);
  assert.deepEqual(paths, [
    "catalog.signatureSummary",
    "catalog.skillGroups",
    "freezePtcToolset",
    "mcp",
    "repeatGuard",
    "skills",
  ], "漂移必须逐键可读：" + summarizeDifferences(compared.differences).join("; "));
  assert.equal(compared.count, 6);
});

test("S4 · 模板比对器本身可靠：同值 0 差异，改一个值 1 条差异", () => {
  const server = serverDefaultTemplate();
  assert.deepEqual(compareTemplates(server, server), { equal: true, differences: [], count: 0 });
  const mutated = JSON.parse(JSON.stringify(server));
  mutated.defaults.capability = 0;
  const compared = compareTemplates(mutated, server);
  assert.equal(compared.count, 1);
  assert.equal(compared.differences[0].path, "defaults.capability");
  assert.deepEqual([compared.differences[0].left, compared.differences[0].right], [2, 0]);
  assert.deepEqual(deepDiff({ a: 1 }, { a: 1 }), []);
});

/* ── 7. 删分支必红：反向契约的故障注入 ─────────────────────────────────── */

test("S4 · 删分支必红：给生产态多挂一个内部导出键，反向契约必须判红", () => {
  const source = clientSource();
  const mutated = applyMutations(source, [{
    label: "生产态漏出内部调试面",
    find: "    return module.exports;\n  },\n});",
    replace: "    exports.debug = {};\n    return module.exports;\n  },\n});",
  }]);
  const { react } = createReact();
  const loaded = loadClient({ source: mutated.text, sandbox: createSandbox({ react }) });
  const surface = inspectProductionSurface(loaded);
  assert.equal(surface.ok, false);
  assert.deepEqual(surface.keys, ["apply", "debug", "inject"]);
  assert.deepEqual(surface.problems.map((item) => item.code), ["EXPORT_KEYS"]);
});

test("S4 · 删分支必红：client 里偷 require 白名单外的模块必须被拒", () => {
  const source = clientSource();
  const mutated = applyMutations(source, [{
    label: "偷偷 require node:fs",
    find: '    const react = require("react");',
    replace: '    const react = require("react");\n    void require("node:fs");',
  }]);
  const { react } = createReact();
  assert.throws(
    () => loadClient({ source: mutated.text, sandbox: createSandbox({ react }) }),
    (error) => error.code === "MODULE_NOT_ALLOWED" && error.message.includes("node:fs"),
  );
});