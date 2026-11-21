/**
 * S1 宿主契约夹具（票 01 · 四域五缝 S1 · 两段式迁移阶段①）
 *
 * 这一条缝把「宿主语义」和「测试观测」分开：
 *   - 假宿主仍是 test/host.mjs 一份（不引第二份替身），但导出四本观测账
 *     （限制动作 / 派发 / 投递 / 生命周期）；
 *   - 六条宿主事实各有可读的契约夹具：双派发语义、限制完整契约、视图三件套与注册面、
 *     会话表面、撤销器生命周期、消息构造两态；
 *   - 五处假绿 FG-1..FG-5 与两处同源问题 FG-6/FG-7 逐条留证；
 *   - 每个事实都做一次「删被测分支必须红」的定点变异（规格 §805），不引变异框架。
 *
 * 跑法：node --import ./test/stub-loader.mjs test/seams/s1-host-contract.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeHost,
  makePtcExecutor,
  createSessionStore,
  DISPATCH_BROADCAST,
  DISPATCH_ISOLATED,
  TARGET_DENY,
  TARGET_ALLOW,
} from "../host.mjs";
import { createGate } from "../../lib/gate.js";
import { resolvePolicy } from "../../lib/policy.js";
import { mountTailGate } from "../../lib/prestep.js";
import {
  DEFECT_COUNT,
  adrs,
  crossDomainDefects,
  defects,
  falseGreens,
  invariants,
  seams,
  terms,
  validateRegistry,
} from "./defect-registry.mjs";
import { REPO_ROOT, expectRed, loadMutated, cleanupMutations } from "./mutation.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const check = async (label, fn) => {
  try {
    await fn();
    results.push({ label, ok: true });
  } catch (error) {
    results.push({ label, ok: false, error: String((error && error.message) || error) });
  }
};
const lastRow = (rows) => rows[rows.length - 1];
const L = (lines) => lines.join("\n");

// ─────────────────────────────────────────────────────────────────────────────
// 六条宿主事实的契约审计（正例与变异共用同一份断言 —— 变异时必须原样变红）
// ─────────────────────────────────────────────────────────────────────────────

/** 事实一：双派发语义（FG-1）。 */
async function auditDispatch({ makeHost: make }) {
  const order = [];
  const host = make();
  host.rootCtx.on("demo", (value) => order.push(["a", value]));
  host.rootCtx.on("demo", () => { order.push(["b"]); throw new Error("boom"); });
  host.rootCtx.on("demo", () => order.push(["c"]));
  assert.throws(() => host.emit("demo", 7), /boom/, "广播遇抛错必须把异常抛回调用方");
  assert.deepEqual(order, [["a", 7], ["b"]], "广播必须在抛错处中断：第三个监听者不得执行");
  const broadcast = lastRow(host.readLedger("dispatches"));
  assert.equal(broadcast.mode, DISPATCH_BROADCAST);
  assert.equal(broadcast.listeners, 3);
  assert.equal(broadcast.delivered, 1);
  assert.equal(broadcast.failed.length, 1);
  assert.equal(broadcast.aborted, true);
  assert.equal(broadcast.abortedAt, 1);
  assert.deepEqual(host.deliveriesOf("demo").map((row) => row.status), ["ok", "threw"]);

  // 零监听者不得记「已投递一」（0.5.7 在激活回执上的假阳性）。
  const zero = host.emit("tools/result", { name: "x" }, { content: [] });
  assert.equal(zero.listeners, 0);
  assert.equal(zero.delivered, 0, "零监听者不得记已投递");
  assert.equal(zero.aborted, false);

  // 隔离派发：逐监听者隔离，错误只进 failed / 投递账，不回抛。
  const isolatedHost = make();
  const seen = [];
  isolatedHost.rootCtx.on("demo", () => seen.push(1));
  isolatedHost.rootCtx.on("demo", () => { throw new Error("boom"); });
  isolatedHost.rootCtx.on("demo", () => seen.push(3));
  const receipt = isolatedHost.emitIsolated("demo");
  assert.deepEqual(seen, [1, 3], "隔离派发必须继续执行后续监听者");
  assert.equal(receipt.mode, DISPATCH_ISOLATED);
  assert.equal(receipt.listeners, 3);
  assert.equal(receipt.delivered, 2);
  assert.equal(receipt.failed.length, 1);
  assert.equal(receipt.aborted, false);
  assert.equal(isolatedHost.deliveriesOf("demo").filter((row) => row.status === "threw").length, 1);
}

/** 事实二 a：摘除形状 + 同形幂等短路 + 句柄独占（FG-2）。 */
async function auditRestrictionDeny({ makeHost: make }) {
  const host = make();
  const agent = host.agent;
  const first = agent.ctx.tools.restrict({ deny: ["read"] });
  assert.equal(typeof first, "function", "限制必须返回独占撤销句柄");
  assert.equal(first.target.shape, TARGET_DENY);
  assert.equal(host.applyCount(agent), 1);
  assert.equal(host.visibleOf(agent).has("read"), false, "摘除形状必须真的把工具从视图里去掉");
  assert.equal(host.visibleOf(agent).has("write"), true);
  assert.ok(host.restrictionsFor(agent).some((set) => set.has("read")), "限制必须进 restrictionsFor 的兼容口径");

  const second = agent.ctx.tools.restrict({ deny: ["read"] });
  assert.equal(second, first, "同一目标第二次必须返回同一个句柄");
  assert.equal(host.applyCount(agent), 1, "同形幂等短路不得增加施加次数");
  assert.equal(lastRow(host.readLedger("restrictions")).action, "noop");
  assert.equal(lastRow(host.readLedger("restrictions")).reason, "same-target");

  assert.equal(first(), true, "首次释放必须真的撤销");
  assert.equal(host.visibleOf(agent).has("read"), true, "撤销后工具必须回到视图");
  assert.equal(host.applyCount(agent), 1);
  assert.equal(lastRow(host.readLedger("restrictions")).action, "lift");

  assert.equal(first(), false, "重复释放必须为空操作");
  assert.equal(lastRow(host.readLedger("restrictions")).action, "lift-noop");
  assert.equal(lastRow(host.readLedger("restrictions")).reason, "already-released");
}

/** 事实二 b：句柄身份（过期 / 被替换的句柄释放只能是空操作）。 */
async function auditHandleIdentity({ makeHost: make }) {
  const host = make();
  const agent = host.agent;
  const handle = agent.ctx.tools.restrict({ deny: ["write"] });
  // 另一条代码路径在宿主侧施加了同一目标：旧句柄已经不是当前句柄了。
  host.seedRestriction(agent, ["write"]);
  assert.equal(handle(), false, "过期句柄的释放必须为空操作");
  assert.equal(lastRow(host.readLedger("restrictions")).reason, "stale-handle");
  assert.equal(host.visibleOf(agent).has("write"), false, "别人的同目标限制仍然生效");
  assert.equal(host.applyCount(agent), 2);
}

/** 事实二 c：放行形状（allow-list）与自有层豁免。 */
async function auditRestrictionAllow({ makeHost: make }) {
  const host = make();
  const agent = host.agent;
  const knownBefore = [...host.tools.view(agent).knownNames].sort();
  const handle = agent.ctx.tools.restrict({ allow: ["read", "write", "run_code"] });
  assert.equal(handle.target.shape, TARGET_ALLOW);
  assert.deepEqual(handle.target.names, ["read", "write"], "自有层（run_code）不得进白名单");
  // 自有层（run_code）不受 allow 收窄，所以视图里仍应有它。
  assert.deepEqual([...host.visibleOf(agent).keys()].sort(), ["read", "run_code", "write"], "放行形状收窄到白名单（自有层保留）");
  assert.deepEqual([...host.tools.view(agent).knownNames].sort(), knownBefore, "放行形状不得改注册面");
  assert.deepEqual(host.allowTargets(agent), [["read", "write"]]);
  handle();
  assert.equal(host.visibleOf(agent).has("read"), true);
  assert.deepEqual(host.allowTargets(agent), []);
}

/** 事实二 d：受保护名被点名时抛出，非法目标显式失败。 */
async function auditProtected({ makeHost: make }) {
  const host = make({ protected: ["gate_load"] });
  const agent = host.agent;
  const denied = await expectRed("deny-protected", () => Promise.resolve(agent.ctx.tools.restrict({ deny: ["gate_load"] })));
  assert.equal(denied.red, true);
  assert.equal(denied.error.code, "PROTECTED_TOOL");
  assert.match(denied.message, /protected tool/);
  const allowed = await expectRed("allow-strips-protected", () => Promise.resolve(agent.ctx.tools.restrict({ allow: ["read"] })));
  assert.equal(allowed.red, true, "放行形状若会摘掉受保护名也必须抛错");
  assert.equal(allowed.error.code, "PROTECTED_TOOL");
  assert.equal(lastRow(host.readLedger("restrictions")).action, "reject");
  assert.equal(lastRow(host.readLedger("restrictions")).reason, "PROTECTED_TOOL");

  const plain = make();
  assert.throws(() => plain.agent.ctx.tools.restrict({ deny: ["does_not_exist"] }), /unknown global tool/);
  assert.throws(() => plain.agent.ctx.tools.restrict({ deny: ["run_code"] }), /unknown global tool/, "自有层不可限制");
  assert.throws(() => plain.agent.ctx.tools.restrict({}), /requires/);
  assert.throws(() => plain.agent.ctx.tools.restrict({ deny: [], allow: [] }), /exactly one target shape/);
  assert.throws(() => plain.rootCtx.tools.restrict({ deny: ["read"] }), /agent-scoped/, "根 ctx 上限制必须直接抛");
}

/** 事实三：视图三件套与注册面。 */
async function auditViews({ makeHost: make }) {
  const host = make({ preset: ["pwsh"] });
  const agent = host.agent;
  const view = host.tools.view(agent);
  assert.ok(view.visible instanceof Map);
  assert.ok(view.registrations instanceof Map);
  assert.ok(view.restrictableNames instanceof Set);
  assert.ok(view.knownNames instanceof Set);
  assert.equal(view.visible.has("pwsh"), true, "agent 视图含 preset 平面");
  assert.equal(view.restrictableNames.has("run_code"), false, "run_code 是自有层，不进可限制名单");
  assert.equal(host.tools.view().visible.has("pwsh"), false, "全局视图看不到 preset 平面");

  const dispose = host.rootCtx.tools.register({ name: "s1_registered", description: "x", execute: async () => ({ content: [] }) });
  assert.equal(host.tools.view(agent).visible.has("s1_registered"), true);
  const row = lastRow(host.readLedger("lifecycle"));
  assert.equal(row.kind, "tool");
  assert.equal(row.surface, "tool");
  assert.equal(row.status, "registered");
  dispose();
  assert.equal(host.tools.view(agent).visible.has("s1_registered"), false);
  assert.equal(lastRow(host.readLedger("lifecycle")).status, "disposed");

  const routeDispose = host.rootCtx.registerSurface("route", "/api/dsh-gate/state", () => {});
  assert.equal(lastRow(host.readLedger("lifecycle")).surface, "route");
  routeDispose();
  assert.equal(lastRow(host.readLedger("lifecycle")).status, "disposed");
}

/** 事实三 b：系统提示词装配的 onion 串接。 */
async function auditOnion({ makeHost: make }) {
  const host = make();
  host.rootCtx.on("system-prompt/assemble", async (assembly, _scope, next) => {
    const out = await next();
    return { ...out, system: out.system + "\n[section-A]" };
  });
  host.rootCtx.on("system-prompt/assemble", async (assembly, _scope, next) => {
    const out = await next();
    return { ...out, system: out.system + "\n[section-B]" };
  });
  const out = await host.assemble({ system: "BASE" });
  assert.match(out.system, /\[section-A\]/);
  assert.match(out.system, /\[section-B\]/);
}

/** 事实四：会话表面 + 尾块自愈（FG-3 / FG-6）。 */
async function auditSessionSurface({ makeHost: make, mountTailGate: mount }) {
  const host = make();
  const store = host.attachSession(host.agent, {
    header: { origin: "s1-contract" },
    messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "第一句" }] }],
  });
  assert.deepEqual(store.surface.nodes, [1]);
  assert.equal(store.count(), 1);
  assert.equal(store.textOf(1), "第一句");
  assert.equal(store.eventAt(1).type, "user/message");
  store.append({ id: "m2", role: "assistant", content: [{ type: "text", text: "第二句" }] });
  assert.deepEqual(store.ids(), [1, 2]);
  const summary = store.surfaceSummary();
  assert.deepEqual(Object.keys(summary[0]).sort(), ["id", "kind", "role", "textDigest", "textLength", "type"]);
  assert.equal(store.locate((row) => row.text === "第二句").id, 2);
  assert.equal(store.locate((row) => row.text === "没有这一句"), undefined);

  // 尾块：正文不变不追加；表面存在时复用判断生效；内容变化只追加一条且在末尾。
  const tailHost = make({ session: true });
  let text = "TAIL-1：你这轮可用工具见索引行。";
  const gate = { indexTextFor: () => text, loadedTextFor: () => text };
  mount({ ctx: tailHost.rootCtx, gate, policy: { enabled: true } });
  const first = await tailHost.preStep({ kind: "enter", messages: [] }, tailHost.agent, []);
  assert.equal(first.messages.length, 1, "首次必须追加一条尾块");
  assert.equal(first.messages[0].source.kind, "gate-tail", "尾块来源必须由构造入口打标（FG-6：不得自拼）");
  assert.match(first.messages[0].id, /^gate-tail-/, "退化构造的确定性标识");
  const surface = tailHost.sessionOf(tailHost.agent);
  assert.equal(surface.count(), 1, "宿主把 pre-step 返回的消息追加进表面");

  const second = await tailHost.preStep({ kind: "enter", messages: [] }, tailHost.agent, []);
  assert.equal(second.messages.length, 0, "正文不变时不得再追加（删掉 known===text 分支这里必红）");
  assert.equal(surface.count(), 1);

  text = "TAIL-2：可用工具变了。";
  const third = await tailHost.preStep({ kind: "enter", messages: [] }, tailHost.agent, []);
  assert.equal(third.messages.length, 1, "内容变化只追加一条");
  assert.equal(surface.count(), 2);
  assert.equal(surface.textOf(surface.ids().at(-1)), text, "追加必须落在末尾");
  assert.equal(surface.locate((row) => row.text === text).id, surface.ids().at(-1));
}

/** 事实五：撤销器生命周期（FG-4）。 */
async function auditLifecycle({ makeHost: make }) {
  const host = make();
  host.rootCtx.on("x", () => {});
  host.rootCtx.effect(() => () => {});
  host.rootCtx.timer(() => {}, 60_000);
  host.rootCtx.openConnection("mcp");
  const scope = host.rootCtx.createScope("reload");
  host.rootCtx.inject(["webServer"], () => {});
  const toolDispose = host.rootCtx.tools.register({ name: "s1_effect_tool", description: "x", execute: async () => ({ content: [] }) });
  const registered = host.liveCounts();
  assert.equal(registered.hooks >= 1, true);
  assert.equal(registered.timers, 1);
  assert.equal(registered.connections, 1);
  assert.equal(registered.scopes, 1);
  assert.equal(registered.injections, 1);
  assert.equal(registered.effects, 1);

  const outcome = host.dispose();
  assert.equal(outcome.disposed >= 7, true, "dispose 必须逐个执行已登记的撤销器");
  const leaks = outcome.leaks;
  assert.deepEqual(
    { hooks: leaks.hooks, injections: leaks.injections, timers: leaks.timers, connections: leaks.connections, scopes: leaks.scopes, effects: leaks.effects },
    { hooks: 0, injections: 0, timers: 0, connections: 0, scopes: 0, effects: 0 },
    "释放后存活定时器 / 监听 / 注入 / 连接必须为零",
  );
  assert.deepEqual(scope.run(() => "late"), { skipped: true }, "释放期间到达的异步结果不得再改状态");
  assert.equal(toolDispose(), undefined);
  assert.equal(lastRow(host.readLedger("lifecycle")).status, "already-disposed");
  assert.equal(outcome.statuses.includes("registered"), false);
}

/** 事实六：消息构造两态（FG-5）。 */
async function auditMessageAdapter({ runAdapter }) {
  const absent = runAdapter({});
  assert.equal(absent.state.mode, "fallback");
  assert.equal(absent.state.reason, "module-missing");
  assert.match(absent.id, /^gate-tail-/);
  const present = runAdapter({ DSH_GATE_STUB_LLM: "present" });
  assert.equal(present.state.mode, "host");
  assert.equal(present.state.reason, "resolved");
  assert.match(present.id, /^msg-/);
  assert.equal(present.frozen, true, "宿主编译器返回的消息必须深冻结");

  for (const [mode, payload] of [["absent", absent], ["present", present]]) {
    assert.equal(payload.deterministic, true, mode + "：同一份正文重放两次必须得到同一个标识");
    assert.equal(payload.text, "S1 尾块正文：同一份正文重放两次必须得到同一个标识。");
    assert.equal(payload.sourceKind, "gate-tail");
    assert.equal(payload.role, "user");
    assert.equal(payload.blocksPreserved, true, mode + "：结构化块必须原样保留");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 子进程：两态适配器
// ─────────────────────────────────────────────────────────────────────────────

function runAdapter(extraEnv) {
  const child = spawnSync(
    process.execPath,
    ["--import", "./test/stub-loader.mjs", "test/seams/s1-message-adapter.mjs"],
    { cwd: REPO_ROOT, env: { ...process.env, DSH_GATE_STUB_LLM: "", ...extraEnv }, encoding: "utf8" },
  );
  assert.equal(child.status, 0, "两态适配器子进程失败：" + child.stderr);
  const lines = child.stdout.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]);
}

const world = { makeHost, mountTailGate, runAdapter };

// ─────────────────────────────────────────────────────────────────────────────
// 正例：六条宿主事实
// ─────────────────────────────────────────────────────────────────────────────

await check("四本观测账齐备且只读（readLedger 深拷贝）", async () => {
  const host = makeHost();
  for (const name of ["restrictions", "dispatches", "deliveries", "lifecycle"]) {
    assert.ok(Array.isArray(host.readLedger(name)), name + " 必须是账本数组");
    assert.equal(host.ledgerCount(name), 0);
  }
  assert.throws(() => host.readLedger("unknown"), /unknown ledger/);
  const copy = host.readLedger("restrictions");
  copy.push({ injected: true });
  assert.equal(host.ledgerCount("restrictions"), 0, "改拷贝不得污染账本");
  assert.equal(typeof host.applyCount, "function");
  assert.deepEqual(Object.keys(host.liveCounts()).sort(), ["connections", "effects", "hooks", "injections", "scopes", "timers", "tools"]);
});

await check("事实一 · 双派发语义（FG-1）", () => auditDispatch(world));
await check("事实二 a · 摘除形状 + 同形幂等 + 句柄撤销（FG-2）", () => auditRestrictionDeny(world));
await check("事实二 b · 句柄身份：过期句柄释放为空操作", () => auditHandleIdentity(world));
await check("事实二 c · 放行形状 allow-list", () => auditRestrictionAllow(world));
await check("事实二 d · 受保护名与非法目标", () => auditProtected(world));
await check("事实三 · 视图三件套与注册面", () => auditViews(world));
await check("事实三 b · 系统提示词装配 onion 串接", () => auditOnion(world));
await check("事实四 · 会话表面 + 尾块自愈（FG-3 / FG-6）", () => auditSessionSurface(world));
await check("事实五 · 撤销器生命周期（FG-4）", () => auditLifecycle(world));
await check("事实六 · 消息构造两态（FG-5）", () => auditMessageAdapter(world));

await check("createSessionStore 独立可用（不依赖宿主）", () => {
  const store = createSessionStore({ header: { h: 1 } });
  assert.equal(store.header.h, 1);
  store.append({ role: "user", content: [{ type: "text", text: "x" }], source: { kind: "gate-tail" } });
  assert.equal(store.surfaceSummary()[0].kind, "gate-tail");
  store.dispose();
  assert.equal(store.count(), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 五处假绿 + 两处同源问题的登记与留证
// ─────────────────────────────────────────────────────────────────────────────

await check("五处假绿 + 两处同源问题逐条留证（FG-1..FG-7）", () => {
  assert.equal(falseGreens.length, 7);
  const ids = falseGreens.map((row) => row.id);
  assert.deepEqual(ids, ["FG-1", "FG-2", "FG-3", "FG-4", "FG-5", "FG-6", "FG-7"]);
  for (const row of falseGreens) {
    assert.ok(row.was && row.now, row.id + " 必须写清收口前 / 收口后");
    assert.ok(row.test, row.id + " 必须指向契约夹具里的断言");
    assert.ok(row.seam === "S1" || row.seam === "S4");
  }
  assert.equal(new Set(ids).size, 7);
});

// ─────────────────────────────────────────────────────────────────────────────
// 缺陷回放登记表（17 条 counted + 跨域前端 P0 + 术语/ADR/不变量基线）
// ─────────────────────────────────────────────────────────────────────────────

await check("缺陷回放登记表：17 条 counted，分级 P0×2 + P1×10 + P2×5", () => {
  const report = validateRegistry();
  assert.deepEqual(report.problems, []);
  assert.equal(report.ok, true);
  assert.equal(report.counted, DEFECT_COUNT);
  assert.deepEqual(report.severityCount, { P0: 2, P1: 10, P2: 5 });
  assert.equal(defects.length, 17);
  for (const row of defects) {
    assert.match(row.replay.file, /^test\/seams\/(s[1-5])-.*\.test\.mjs$/);
    assert.ok(row.deleteBranch, row.id + " 必须写明删分支靶点");
    // #02 起逐票激活：state 只能是 registered（票 01 只登记）或 verified（本票已收口，必须带 verifiedBy）。
    assert.ok(row.state === "registered" || row.state === "verified", row.id + " state 非法");
    if (row.state === "verified") {
      assert.ok(row.verifiedBy && row.verifiedBy.file && row.verifiedBy.case, row.id + " verified 缺 verifiedBy");
    }
  }
});

await check("缺陷回放登记表：票 02–07 全覆盖，跨域前端 P0 归 #07", () => {
  const tickets = new Set([...defects, ...crossDomainDefects].map((row) => row.ticket));
  for (let n = 2; n <= 7; n += 1) assert.equal(tickets.has("#0" + n), true, "缺 #0" + n + " 承接");
  assert.equal(crossDomainDefects.length, 1);
  assert.equal(crossDomainDefects[0].id, "X-1");
  assert.equal(crossDomainDefects[0].ticket, "#07");
  assert.equal(crossDomainDefects[0].counted, false);
  // 决策编号必须带消歧前缀（be: / gate: / ui:）。
  for (const row of [...defects, ...crossDomainDefects]) {
    assert.ok(row.decisions.length > 0, row.id + " 缺决策号");
    for (const decision of row.decisions) assert.match(decision, /^(be|gate|ui):D\d+$/);
  }
});

await check("基线清单：18 术语 + 12 ADR + 16 不变量 + 6 条接缝入口", () => {
  assert.equal(terms.length, 18);
  assert.equal(new Set(terms.map((row) => row.term)).size, 18);
  for (const row of terms) assert.ok(row.term && row.gloss);
  assert.equal(adrs.length, 12);
  assert.deepEqual(adrs.map((row) => row.id), Array.from({ length: 12 }, (_v, index) => "A-" + (index + 1)));
  assert.equal(invariants.length, 16);
  assert.deepEqual(invariants.map((row) => row.id), Array.from({ length: 16 }, (_v, index) => "I-" + (index + 1)));
  assert.deepEqual(Object.keys(seams).sort(), ["S1", "S1b", "S2", "S3", "S4", "S5"]);
  for (const [id, seam] of Object.entries(seams)) {
    assert.equal(seam.scripts.length, 1, id + " 必须有一条命令入口");
    assert.equal(seam.blocking, id !== "S1b");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #03 缺陷回放（P1-4 / P1-5 / P1-6 / P1-7 / P2-1）
//
// 这五条是「归层决策被算了四遍」的直接后果：planFor 的候选循环、tierMap 的第二次
// resolveTier、planSections 的 shouldDrop、load 的 off/knownSections 各判一遍。
// 每条回放只断言**用户可见的结果**（快照层值 / 桶 / 目录 / 加载回执 / 工具表可见性），
// 不摸内部函数 —— 这样修复可以把实现整体换掉，而这几条断言原样成立。
// ─────────────────────────────────────────────────────────────────────────────

const s1PolicyDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), "gate-s1-" + label + "-"));
const s1Policy = (label, raw) => resolvePolicy(raw, { dshHome: s1PolicyDir(label) });
const s1Rig = async ({ label, names, raw, executor }) => {
  const host = makeHost({ names, id: label });
  if (executor !== undefined) host.setExecutor(host.agent, executor);
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy: s1Policy(label, raw) });
  await gate.attach(host.agent);
  return { host, gate, agent: host.agent };
};

await check("P1-4 glob 不跨轴：一条工具通配不得连带关掉段落与技能", async () => {
  const { gate, agent } = await s1Rig({
    label: "p1-4",
    names: ["read", "pwsh", "pwsh_probe", "todo_write"],
    raw: {
      defaults: { capability: 2, section: 1, skillpack: 2 },
      capabilities: { "glob:pwsh*": { tier: 0 } },
    },
  });
  gate.recordSections(agent, [{ name: "pwsh-notes", chars: 40, tokens: 12 }]);
  gate.rememberSkills(agent, [{ name: "pwsh-guide", provider: "pkg-pwsh", description: "g", origin: "import", content: "正文" }]);
  gate.reapply(agent);
  const snap = gate.snapshot(agent);
  assert.equal(snap.tiers.pwsh_probe, 0, "glob:pwsh* 必须作用在工具轴");
  assert.equal(gate.planSections(agent).shouldDrop("pwsh-notes"), false, "段落轴不得被工具通配关掉");
  assert.equal(snap.sections.find((row) => row.name === "pwsh-notes").gated, false, "段落仍是常驻（不进摘除集）");
  assert.equal(snap.skills.includes("pwsh-guide"), true, "技能轴不得被工具通配关掉");
  await gate.releaseAll();
});

await check("P1-5 激活不得绕过 off：技能加载不得把显式关闭的工具装回工具表", async () => {
  const { host, gate, agent } = await s1Rig({
    label: "p1-5",
    names: ["read", "univer_status", "univer_sheet", "todo_write"],
    raw: {
      defaults: { capability: 2, section: 1, skillpack: 2 },
      capabilities: { "plugin:dsh-univer-office": { tier: 0 } },
    },
  });
  gate.rememberSkills(agent, [{
    name: "univer", provider: "dsh-univer-office", origin: "import", content: "用法正文",
  }]);
  const receipt = await gate.loadSkill(agent, "univer");
  assert.equal(receipt.ok, true, "技能本身可加载");
  assert.deepEqual(receipt.promoted, [], "显式关闭的工具不得被技能激活放出");
  const snap = gate.snapshot(agent);
  assert.equal(snap.tiers.univer_status, 0, "关闭工具必须保持关闭");
  assert.equal(snap.offNames.includes("univer_status"), true);
  assert.equal(host.visibleOf(agent).has("univer_status"), false, "关闭工具不得被装回工具表");
  await gate.releaseAll();
});

await check("P1-6 off 必须不可 load：关闭段落不得从加载口取正文", async () => {
  const { gate, agent } = await s1Rig({
    label: "p1-6",
    names: ["read", "pwsh", "todo_write"],
    raw: {
      defaults: { capability: 2, section: 2, skillpack: 2 },
      capabilities: { "section:pwsh-notes": { tier: 0 } },
    },
  });
  gate.recordSections(agent, [{ name: "pwsh-notes", chars: 10, tokens: 3, text: "这段本该被关掉" }]);
  assert.equal(gate.planSections(agent).shouldDrop("pwsh-notes"), true, "关闭段落必须被摘掉");
  const receipt = await gate.load(agent, ["section:pwsh-notes"]);
  assert.deepEqual(receipt.loaded, [], "关闭段落不得被加载");
  assert.equal(receipt.denied.includes("section:pwsh-notes"), true, "必须以拒绝回执说明原因");
  assert.equal(gate.loadedTextFor(agent).includes("这段本该被关掉"), false, "关闭段落正文不得进尾部声明");
  await gate.releaseAll();
});

await check("P1-7 重载后 off 仍生效：已加载不得压过显式关闭", async () => {
  const host = makeHost({ names: ["read", "todo_write"], id: "p1-7" });
  const policy = s1Policy("p1-7", { defaults: { capability: 2, section: 1, skillpack: 2 } });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  const agent = host.agent;
  await gate.attach(agent);
  const first = await gate.load(agent, ["todo_write"]);
  assert.deepEqual(first.loaded, ["todo_write"]);
  assert.equal(gate.snapshot(agent).tiers.todo_write, 1, "加载后按需抬成常驻");
  // 面板把这条改成「关闭」：策略对象就地替换（0.5.7 的 server 保存后就是这么做的）。
  Object.assign(policy, s1Policy("p1-7b", {
    defaults: { capability: 2, section: 1, skillpack: 2 },
    capabilities: { "native:todo_write": { tier: 0 } },
  }));
  gate.reapply(agent);
  const snap = gate.snapshot(agent);
  assert.equal(snap.tiers.todo_write, 0, "显式关闭必须压过已加载");
  assert.equal(snap.residentNames.includes("todo_write"), false, "已加载不得让它留在常驻");
  assert.equal(snap.offNames.includes("todo_write"), true);
  assert.equal(host.visibleOf(agent).has("todo_write"), false, "关闭必须真的从工具表消失");
  await gate.releaseAll();
});

await check("P2-1 冻结视图与快照一致：PTC 冻结下已加载工具仍是按需", async () => {
  const { gate, agent } = await s1Rig({
    label: "p2-1",
    names: ["read", "todo_write", "gate_load"],
    executor: makePtcExecutor(),
    raw: { defaults: { capability: 2, section: 1, skillpack: 2 } },
  });
  await gate.load(agent, ["todo_write"]);
  const snap = gate.snapshot(agent);
  assert.equal(snap.frozen, true, "PTC 下必须冻结工具表");
  assert.equal(snap.tiers.todo_write, 2, "冻结下已加载仍是按需（桶不变、声明走尾块）");
  assert.equal(snap.onDemandNames.includes("todo_write"), true);
  assert.equal(snap.residentNames.includes("todo_write"), false, "冻结下不得把已加载算成常驻");
  const row = gate.capabilityView(agent).tools.find((tool) => tool.name === "todo_write");
  assert.ok(row, "能力视图必须包含该工具");
  assert.equal(row.bucket, "ondemand", "能力视图的桶必须与快照层值一致");
  await gate.releaseAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// 删被测分支必须红（规格 §805：六条宿主事实 + 两条同源问题逐条定点验证）
// ─────────────────────────────────────────────────────────────────────────────

const broadcastBlock = L([
  "        if (mode === DISPATCH_BROADCAST) {",
  "          row.aborted = true;",
  "          row.abortedAt = index;",
  "          throw thrown;",
  "        }",
]);
const sameTargetBlock = L([
  "    if (existing !== undefined && existing.released !== true) {",
  "      restrictionRow(\"noop\", agent, {",
  "        reason: \"same-target\", shape: target.shape, names: target.names.slice(), handleId: existing.handleId,",
  "      });",
  "      return existing.handle;",
  "    }",
]);
const handleIdentityBlock = L([
  "    if (entry.released === true) {",
  "      restrictionRow(\"lift-noop\", agent, { reason: \"already-released\", handleId: entry.handleId });",
  "      return false;",
  "    }",
  "    if (own.get(entry.key) !== entry) {",
  "      entry.released = true;",
  "      restrictionRow(\"lift-noop\", agent, { reason: \"stale-handle\", handleId: entry.handleId });",
  "      return false;",
  "    }",
]);
const protectedBlock = L([
  "      const hit = names.filter((name) => protectedNames.has(name));",
  "      if (hit.length > 0) {",
  "        const error = new Error(\"tools.restrict() refuses to strip protected tool \" + hit.join(\", \"));",
  "        error.code = \"PROTECTED_TOOL\";",
  "        error.protectedNames = hit;",
  "        throw error;",
  "      }",
]);
const onionBlock = L([
  "        const handler = list[i];",
  "        const inner = current;",
  "        current = () => handler(assembly, { scope: agent }, inner);",
]);
const prestepDedupBlock = L([
  "    if (known === text) {",
  "      rememberTail(agent, text);",
  "      return existing.length === 0 ? decision : { ...decision, messages: kept };",
  "    }",
]);

const hostMutations = [
  { audit: "dispatch", label: "广播不中断（逐监听者吞错继续）", run: () => auditDispatch(world), find: broadcastBlock },
  { audit: "restriction-deny", label: "同形幂等短路被删（每次都重新施加）", run: () => auditRestrictionDeny(world), find: sameTargetBlock },
  { audit: "handle-identity", label: "句柄身份校验被删（过期句柄仍能撤销别人的限制）", run: () => auditHandleIdentity(world), find: handleIdentityBlock },
  { audit: "protected", label: "受保护名不再抛错（静默摘除）", run: () => auditProtected(world), find: protectedBlock },
  { audit: "lifecycle", label: "dispose 不执行撤销器（泄漏不记账）", run: () => auditLifecycle(world), find: L(["        row.run();", "        disposed += 1;"]) },
  { audit: "onion", label: "系统提示词装配不再串监听者（onion 循环被删）", run: () => auditOnion(world), find: onionBlock },
];

const auditTable = {
  dispatch: (mod) => auditDispatch(mod),
  "restriction-deny": (mod) => auditRestrictionDeny(mod),
  "handle-identity": (mod) => auditHandleIdentity(mod),
  protected: (mod) => auditProtected(mod),
  lifecycle: (mod) => auditLifecycle(mod),
  onion: (mod) => auditOnion(mod),
};

for (const entry of hostMutations) {
  await check("删分支必红 · 正例先绿：" + entry.label, async () => { await entry.run(); });
  await check("删分支必红 · " + entry.label, async () => {
    const mutated = await loadMutated("test/host.mjs", [{ label: entry.audit, find: entry.find }], { name: "host" });
    try {
      assert.equal(mutated.applied.length, 1);
      const mutatedWorld = { makeHost: mutated.namespace.makeHost, mountTailGate, runAdapter };
      const red = await expectRed(entry.audit, () => auditTable[entry.audit](mutatedWorld));
      assert.equal(red.red, true, "删掉被测分支后契约夹具必须变红，实际仍然全绿（假绿）");
    } finally {
      mutated.cleanup();
    }
  });
}

await check("删分支必红 · 尾块去重分支（FG-3）", async () => {
  const mutated = await loadMutated("lib/prestep.js", [{ label: "drop-tail-dedup", find: prestepDedupBlock }], { name: "prestep" });
  try {
    const red = await expectRed("tail-dedupe", () => auditSessionSurface({ makeHost, mountTailGate: mutated.namespace.mountTailGate }));
    assert.equal(red.red, true, "删掉 known===text 去重分支后，尾块去重用例必须变红");
    assert.match(red.message, /不得再追加/);
  } finally {
    mutated.cleanup();
  }
});

await check("删分支必红 · 宿主消息标识确定性（FG-5）", async () => {
  const mutated = await loadMutated("test/vendor/dsh-llm/index.js", [{
    label: "random-id",
    find: "  const id = \"msg-\" + createHash(\"sha1\").update(seed).digest(\"hex\").slice(0, 16);",
    replace: "  const id = \"msg-\" + Math.random().toString(16).slice(2, 18);",
  }], { name: "vendor-llm" });
  try {
    const red = await expectRed("deterministic-id", () => auditMessageAdapter({
      runAdapter: (extraEnv) => runAdapter({ DSH_GATE_STUB_LLM_PATH: mutated.file, ...extraEnv }),
    }));
    assert.equal(red.red, true, "宿主构造器带随机 id 时确定性断言必须变红");
    assert.match(red.message, /同一个标识/);
  } finally {
    mutated.cleanup();
  }
});

await check("擦除临时变异副本", async () => {
  cleanupMutations();
  const fs = await import("node:fs");
  assert.equal(fs.existsSync(path.join(HERE, ".mut", String(process.pid))), false, "本进程的 .mut 桶必须清干净");
});

const failed = results.filter((entry) => !entry.ok);
for (const entry of results) {
  console.log((entry.ok ? "  ok    " : "  FAIL  ") + entry.label + (entry.ok ? "" : "  →  " + entry.error));
}
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exitCode = failed.length === 0 ? 0 : 1;