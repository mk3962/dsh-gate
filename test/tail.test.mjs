/**
 * PTC 冻结 + 末尾声明 + gate_invoke（工单 07）用例。
 *
 * 回归的是三件真事故/真结论（docs/dsh-gate-0.2.0-03-A原型实验.md）：
 *  1) PTC 判据不能靠 view.visible.has("run_code")（0.2.2 的 view 不含 transport，判据恒假 ⇒
 *     冻结静默失效）；只能看选中的执行器，认不出来就 fail-open 并记录原因。
 *  2) PTC 下每次 gate_load 都改工具表 = 每次从前缀缓存断掉（实测 2.3–2.6K 未命中/步）。
 *     冻结后加载只追加一条尾部声明：工具表、gate-catalog、deny 集逐字节不变。
 *  3) gate_invoke 必须走宿主完整执行管线（参数校验还在），宿主侧错误变成 isError 结果，
 *     闸门自己的越界调用（自调 / 未知 / 上游隐藏）才是程序错误。
 *
 * 宿主来自共享 seam（test/host.mjs），批量管线来自 test/vendor/dsh-tools/pipeline.js。
 * 跑法：node --import ./test/stub-loader.mjs test/tail.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGate } from "../lib/gate.js";
import { DEFAULT_POLICY, resolvePolicy } from "../lib/policy.js";
import { mountSectionGate } from "../lib/sections.js";
import { mountTailGate, isTailMessage, messageTextOf } from "../lib/prestep.js";
import { registerGateTools } from "../lib/proxy.js";
import { makeHost, makePtcExecutor, makeNativeExecutor, makeOpaqueExecutor } from "./host.mjs";

let seq = 0;
const results = [];
const check = async (label, fn) => {
  try { await fn(); results.push({ ok: true, label }); }
  catch (error) { results.push({ ok: false, label, error: String((error && error.message) || error) }); }
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gate-tail-"));
const policyFor = (freeze, extra) => {
  const raw = Object.assign({
    defaults: { capability: 2, section: 2, skillpack: 2 },
    capabilities: { "native:read": { tier: 1 }, "native:pwsh": { tier: 1 } },
  }, extra || {});
  if (freeze !== undefined) raw.freezePtcToolset = freeze;
  return resolvePolicy(raw, { dshHome: tmp() });
};

/** 一个完整 rig：宿主 + 策略 + 闸门（执行器可选）。 */
const makeRig = (options) => {
  const opts = options || {};
  let host;
  if (opts.names !== undefined) host = makeHost({ id: "tail-" + (++seq), names: opts.names });
  else host = makeHost({ id: "tail-" + (++seq) });
  if (opts.executor !== undefined) host.setExecutor(host.agent, opts.executor);
  const policy = policyFor(opts.freeze, opts.policy);
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  return { host, gate, policy, agent: host.agent };
};

const userMessage = (id, text) => ({ id, role: "user", content: [{ type: "text", text }] });
const denySnapshot = (host, agent) => JSON.stringify(host.restrictionsFor(agent).map((set) => [...set].sort()).sort());
/** 类名认不出来、describe 只给 run_code 的执行器（走语义判据那条分支）。 */
const schemasOnlyPtc = () => new (class CustomExecutor {
  describe() { return { schemas: [{ name: "run_code" }] }; }
})();

// ── 1. PTC 判据（工单 07 的硬前提） ──────────────────────────────────────────
await check("PTC 判据：constructor.name 命中 PtcExecutor ⇒ ptc 且冻结", async () => {
  const { gate, agent } = makeRig({ executor: makePtcExecutor() });
  await gate.attach(agent);
  const state = gate.snapshot(agent);
  assert.deepEqual(state.executor, { kind: "ptc", reason: "constructor" });
  assert.equal(state.frozen, true);
  await gate.release(agent);
});

await check("PTC 判据：类名不认识时看 describe().schemas，只有 run_code ⇒ ptc", async () => {
  const { gate, agent } = makeRig({ executor: schemasOnlyPtc() });
  await gate.attach(agent);
  assert.deepEqual(gate.snapshot(agent).executor, { kind: "ptc", reason: "schemas" });
  assert.equal(gate.snapshot(agent).frozen, true);
  await gate.release(agent);
});

await check("PTC 判据：NativeToolExecutor ⇒ native，不冻结（保持 0.1.8 行为）", async () => {
  const { gate, agent } = makeRig({ executor: makeNativeExecutor() });
  await gate.attach(agent);
  assert.deepEqual(gate.snapshot(agent).executor, { kind: "native", reason: "constructor" });
  assert.equal(gate.snapshot(agent).frozen, false);
  await gate.release(agent);
});

await check("PTC 判据：拿不到执行器 / 认不出来 ⇒ fail-open，不冻结也不追加声明", async () => {
  for (const executor of [undefined, makeOpaqueExecutor()]) {
    const { gate, host, agent } = makeRig({ executor });
    await gate.attach(agent);
    const state = gate.snapshot(agent);
    assert.equal(state.executor.kind, "unknown", JSON.stringify(state.executor));
    assert.equal(state.frozen, false);
    assert.ok(["no-executor", "unrecognized-executor"].includes(state.executor.reason), state.executor.reason);
    // fail-open 的意思就是回到 0.1.8：加载会把工具放回工具表。
    await gate.load(agent, ["univer_doc"]);
    assert.equal(host.visibleOf(agent).has("univer_doc"), true, "判不出来时必须保持旧行为");
    assert.equal(gate.loadedTextFor(agent), "", "判不出来时不许启用尾部声明");
    await gate.release(agent);
  }
});

// ── 2. 冻结：加载不再改工具表 / 目录 / 拒绝集 ───────────────────────────────
await check("冻结：gate_load 后工具仍不在工具表里，但仍可 gate_invoke", async () => {
  const rig = makeRig({ executor: makePtcExecutor() });
  const { gate, host, agent } = rig;
  registerGateTools({ ctx: host.rootCtx, gate, policy: rig.policy });
  await gate.attach(agent);
  await gate.load(agent, ["univer_doc"]);
  assert.equal(host.visibleOf(agent).has("univer_doc"), false, "冻结后已加载工具不该进工具表");
  assert.equal(gate.canInvoke(agent, "univer_doc").ok, true, "已加载工具必须仍可转发");
  const forwarded = await host.tool("gate_invoke").execute({ tool: "univer_doc", arguments: { q: 1 } }, { agent, signal: undefined });
  assert.equal(forwarded.isError, false);
  assert.ok(forwarded.text.includes("univer_doc ok"), forwarded.text);
  assert.ok(gate.snapshot(agent).onDemandNames.includes("univer_doc"), "冻结下加载过的工具仍在第二层（否则目录会变）");
  await gate.release(agent);
});

await check("关闭就是关闭：off 的工具 gate_load 不收、gate_invoke / gate_call 不转发", async () => {
  const rig = makeRig({ executor: makePtcExecutor(), policy: { capabilities: { "plugin:dsh-univer-office": { tier: 0 } } } });
  const { gate, host, agent } = rig;
  registerGateTools({ ctx: host.rootCtx, gate, policy: rig.policy });
  await gate.attach(agent);
  const loaded = await gate.load(agent, ["univer_doc"]);
  assert.deepEqual(loaded.denied, ["univer_doc"], "off 的工具不能算 loaded");
  assert.deepEqual(loaded.loaded, []);
  assert.deepEqual(gate.canInvoke(agent, "univer_doc"), { ok: false, reason: "off" });
  const invoke = host.tool("gate_invoke");
  await assert.rejects(() => invoke.execute({ tool: "univer_doc", arguments: {} }, { agent, signal: undefined }), /关闭/);
  const call = host.tool("gate_call");
  await assert.rejects(() => call.execute({ name: "univer_doc", arguments: {} }, { agent, signal: undefined }), /关闭/);
  await gate.release(agent);
});

await check("冻结：加载前后 gate-catalog 与 deny 集逐字节不变", async () => {
  const { gate, host, agent } = makeRig({ executor: makePtcExecutor() });
  await gate.attach(agent);
  const catalogBefore = gate.catalogFor(agent);
  const denyBefore = denySnapshot(host, agent);
  const restrictCallsBefore = host.restrictCalls(agent).length;
  await gate.load(agent, ["univer_doc", "ssh_exec"]);
  assert.equal(gate.catalogFor(agent), catalogBefore, "gate-catalog 必须逐字节不变");
  assert.equal(denySnapshot(host, agent), denyBefore, "deny 集必须不变（否则工具表就变了）");
  assert.equal(host.restrictCalls(agent).length, restrictCallsBefore, "加载不该再建立/撤销限制");
  await gate.release(agent);
});

await check("冻结：第二次 gate_load 只让尾部声明变长，工具表与目录不动", async () => {
  const { gate, host, agent } = makeRig({ executor: makePtcExecutor() });
  await gate.attach(agent);
  const catalogBefore = gate.catalogFor(agent);
  await gate.load(agent, ["univer_doc"]);
  const first = gate.loadedTextFor(agent);
  await gate.load(agent, ["ssh_exec"]);
  const second = gate.loadedTextFor(agent);
  assert.ok(first.length > 0);
  assert.ok(second.includes("univer_doc") && second.includes("ssh_exec"), second);
  assert.ok(second.length > first.length);
  assert.equal(host.visibleOf(agent).has("ssh_exec"), false);
  assert.equal(gate.catalogFor(agent), catalogBefore);
  await gate.release(agent);
});

// ── 3. 末尾声明：只追加、不改历史、同输入逐字节一致 ─────────────────────────
await check("尾部声明是一条 user 消息，追加在末尾，已有消息引用与顺序都不动", async () => {
  const { gate, host, agent, policy } = makeRig({ executor: makePtcExecutor() });
  mountTailGate({ ctx: host.rootCtx, gate, policy });
  host.registry.set("tail_sig", {
    name: "tail_sig",
    description: "带参数的工具。第二句不该出现。",
    parameters: {
      type: "object",
      properties: { text: { type: "string" }, limit: { type: "number" } },
      required: ["text"],
    },
    execute: async () => ({ content: [{ type: "text", text: "tail_sig ok" }] }),
  });
  await gate.attach(agent);
  await gate.load(agent, ["univer_doc", "tail_sig"]);
  const messages = [userMessage("u1", "第一句"), userMessage("u2", "第二句"), { id: "a1", role: "assistant", content: [{ type: "text", text: "答" }] }];
  const decision = await host.preStep({ kind: "enter", messages: messages.slice() }, agent);
  assert.equal(decision.messages.length, messages.length + 1);
  for (let i = 0; i < messages.length; i += 1) assert.equal(decision.messages[i], messages[i], "已有消息必须原对象、原位置");
  const tail = decision.messages[decision.messages.length - 1];
  assert.equal(isTailMessage(tail), true, "尾部块必须带 source.kind");
  assert.equal(tail.role, "user");
  assert.ok(messageTextOf(tail).includes("<gate-loaded>"));
  assert.ok(messageTextOf(tail).includes("gate_invoke"));
  assert.ok(messageTextOf(tail).includes("univer_doc()"), "无参数工具也要有签名");
  const signature = messageTextOf(tail);
  assert.ok(signature.includes("- tail_sig({ text: string, limit?: number })"), "声明里要有必填/可选标记的紧凑签名：" + signature);
  await gate.release(agent);
});

await check("尾部声明幂等：同一清单重复 pre-step 一条都不动（逐字节一致）", async () => {
  const { gate, host, agent } = makeRig({ executor: makePtcExecutor() });
  const policy = policyFor();
  mountTailGate({ ctx: host.rootCtx, gate, policy });
  await gate.attach(agent);
  await gate.load(agent, ["univer_doc"]);
  const decision = await host.preStep({ kind: "enter", messages: [userMessage("u1", "hi")] }, agent);
  const again = await host.preStep({ kind: "enter", messages: decision.messages }, agent);
  assert.equal(again.messages, decision.messages, "清单没变就不该新建数组/消息");
  assert.equal(JSON.stringify(again.messages), JSON.stringify(decision.messages));
  await gate.release(agent);
});

await check("尾部声明随清单变化：旧块移除、新块在末尾，历史消息顺序不变", async () => {
  const { gate, host, agent } = makeRig({ executor: makePtcExecutor() });
  const policy = policyFor();
  mountTailGate({ ctx: host.rootCtx, gate, policy });
  await gate.attach(agent);
  await gate.load(agent, ["univer_doc"]);
  const messages = [userMessage("u1", "一"), userMessage("u2", "二")];
  const first = await host.preStep({ kind: "enter", messages: messages.slice() }, agent);
  await gate.load(agent, ["ssh_exec"]);
  const second = await host.preStep({ kind: "enter", messages: first.messages }, agent);
  assert.equal(second.messages.length, messages.length + 1, "块必须被替换而不是累积");
  assert.equal(second.messages[0], messages[0]);
  assert.equal(second.messages[1], messages[1]);
  const tail = second.messages[second.messages.length - 1];
  assert.notEqual(tail, first.messages[first.messages.length - 1], "清单变了要换新块");
  assert.ok(messageTextOf(tail).includes("univer_doc") && messageTextOf(tail).includes("ssh_exec"));
  await gate.release(agent);
});

await check("用户新消息落在尾部块之后：复用同一条消息对象搬到末尾（id/字节不变）", async () => {
  const { gate, host, agent } = makeRig({ executor: makePtcExecutor() });
  const policy = policyFor();
  mountTailGate({ ctx: host.rootCtx, gate, policy });
  await gate.attach(agent);
  await gate.load(agent, ["univer_doc"]);
  const first = await host.preStep({ kind: "enter", messages: [userMessage("u1", "一")] }, agent);
  const tail = first.messages[1];
  const u3 = userMessage("u3", "用户又说话了");
  const moved = await host.preStep({ kind: "enter", messages: [...first.messages, u3] }, agent);
  assert.equal(moved.messages.length, 3);
  assert.equal(moved.messages[0], first.messages[0], "历史消息顺序不变");
  assert.equal(moved.messages[1], u3, "新用户消息排在尾部块之前");
  assert.equal(moved.messages[2], tail, "尾部块复用同一条消息对象（id 与字节都不变）");
  await gate.release(agent);
});

await check("同输入字节一致：两次渲染 / 两个独立 rig / 不同加载顺序都逐字节相同", async () => {
  const a = makeRig({ executor: makePtcExecutor() });
  const b = makeRig({ executor: makePtcExecutor() });
  for (const rig of [a, b]) { await rig.gate.attach(rig.agent); }
  await a.gate.load(a.agent, ["univer_doc", "ssh_exec"]);
  await b.gate.load(b.agent, ["ssh_exec", "univer_doc"]);
  const first = a.gate.loadedTextFor(a.agent);
  const again = a.gate.loadedTextFor(a.agent);
  assert.equal(again, first, "同一份清单两次渲染必须相同");
  assert.equal(b.gate.loadedTextFor(b.agent), first, "加载顺序不该影响声明字节（按名字排序）");
  assert.equal(a.gate.catalogFor(a.agent), b.gate.catalogFor(b.agent), "目录也必须逐字节相同");
  await a.gate.release(a.agent);
  await b.gate.release(b.agent);
});

// ── 4. native / 开关 ────────────────────────────────────────────────────────
await check("native：不启用尾部声明，gate_load 仍进工具表（0.1.8 行为）", async () => {
  const { gate, host, agent } = makeRig({ executor: makeNativeExecutor() });
  const policy = policyFor();
  mountTailGate({ ctx: host.rootCtx, gate, policy });
  await gate.attach(agent);
  const catalogBefore = gate.catalogFor(agent);
  await gate.load(agent, ["univer_doc"]);
  assert.equal(host.visibleOf(agent).has("univer_doc"), true, "native 下加载要进工具表");
  assert.equal(gate.catalogFor(agent).includes("univer_doc"), false, "native 下目录要少一行（0.1.8 行为）");
  assert.notEqual(gate.catalogFor(agent), catalogBefore);
  assert.equal(gate.loadedTextFor(agent), "");
  const decision = await host.preStep({ kind: "enter", messages: [userMessage("u1", "hi")] }, agent);
  assert.equal(decision.messages.length, 1, "native 下不该追加尾部块");
  await gate.release(agent);
});

await check("freezePtcToolset=false：PTC 下也回到 0.1.8 行为（开关是策略键，不是常量）", async () => {
  assert.equal(DEFAULT_POLICY.freezePtcToolset, true, "默认必须冻结");
  const { gate, host, agent } = makeRig({ executor: makePtcExecutor(), freeze: false });
  await gate.attach(agent);
  assert.equal(gate.snapshot(agent).frozen, false);
  await gate.load(agent, ["univer_doc"]);
  assert.equal(host.visibleOf(agent).has("univer_doc"), true);
  assert.equal(gate.loadedTextFor(agent), "");
  await gate.release(agent);
});

await check("坏值不静默改语义：freezePtcToolset 非布尔值按默认 true", async () => {
  const resolved = resolvePolicy({ freezePtcToolset: "yes", defaults: { capability: 2, section: 2, skillpack: 2 } }, { dshHome: tmp() });
  assert.equal(resolved.freezePtcToolset, true);
  const explicit = resolvePolicy({ freezePtcToolset: false, defaults: { capability: 2, section: 2, skillpack: 2 } }, { dshHome: tmp() });
  assert.equal(explicit.freezePtcToolset, false);
});

// ── 5. gate_invoke 的转发与护栏 ──────────────────────────────────────────────
await check("gate_invoke：成功转发（未加载的工具也能调，走宿主管线）", async () => {
  const rig = makeRig({ executor: makePtcExecutor() });
  const { gate, host, agent } = rig;
  registerGateTools({ ctx: host.rootCtx, gate, policy: rig.policy });
  await gate.attach(agent);
  const forwarded = await host.tool("gate_invoke").execute({ tool: "ssh_exec", arguments: { command: "echo hi" } }, { agent, signal: undefined });
  assert.equal(forwarded.isError, false);
  assert.equal(forwarded.text, 'ssh_exec ok {"command":"echo hi"}');
  // 强制 suspend 结束后限制自动恢复。
  assert.equal(host.visibleOf(agent).has("ssh_exec"), false);
  await gate.release(agent);
});

await check("gate_invoke：参数错误由宿主管线变成 isError 结果，不静默成功", async () => {
  const rig = makeRig({ executor: makePtcExecutor() });
  const { gate, host, agent } = rig;
  host.registry.set("tail_echo", {
    name: "tail_echo",
    description: "回显参数。第二句不该出现。",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: async (args) => ({ content: [{ type: "text", text: "tail_echo:" + args.text }] }),
  });
  registerGateTools({ ctx: host.rootCtx, gate, policy: rig.policy });
  await gate.attach(agent);
  const bad = await host.tool("gate_invoke").execute({ tool: "tail_echo", arguments: {} }, { agent, signal: undefined });
  assert.equal(bad.isError, true, "缺必填参数必须 isError");
  assert.match(bad.text, /^Error: invalid arguments: missing required property "text"/);
  const wrongType = await host.tool("gate_invoke").execute({ tool: "tail_echo", arguments: { text: 42 } }, { agent, signal: undefined });
  assert.equal(wrongType.isError, true);
  assert.match(wrongType.text, /should be string/);
  const good = await host.tool("gate_invoke").execute({ tool: "tail_echo", arguments: { text: "hi" } }, { agent, signal: undefined });
  assert.equal(good.isError, false);
  assert.equal(good.text, "tail_echo:hi");
  await gate.release(agent);
});

await check("gate_invoke：目标工具抛错 → isError 结果（不打断整轮）", async () => {
  const rig = makeRig({ executor: makePtcExecutor() });
  const { gate, host, agent } = rig;
  host.registry.set("tail_boom", {
    name: "tail_boom",
    description: "总是失败。",
    execute: async () => { throw new Error("boom"); },
  });
  registerGateTools({ ctx: host.rootCtx, gate, policy: rig.policy });
  await gate.attach(agent);
  const forwarded = await host.tool("gate_invoke").execute({ tool: "tail_boom", arguments: {} }, { agent, signal: undefined });
  assert.equal(forwarded.isError, true);
  assert.match(forwarded.text, /^Error: boom/);
  await gate.release(agent);
});

await check("gate_invoke：自调 / 未知 / 上游隐藏是程序错误（抛错，不是 isError）", async () => {
  const rig = makeRig({ executor: makePtcExecutor() });
  const { gate, host, agent } = rig;
  registerGateTools({ ctx: host.rootCtx, gate, policy: rig.policy });
  await gate.attach(agent);
  const invoke = host.tool("gate_invoke");
  const exec = { agent, signal: undefined };
  await assert.rejects(() => invoke.execute({ tool: "gate_invoke" }, exec), /不能自调/);
  await assert.rejects(() => invoke.execute({ tool: "" }, exec), /不能为空/);
  await assert.rejects(() => invoke.execute({ tool: "no_such_tool_xyz" }, exec), /未知工具/);
  // 上游隐藏：注册过、当前视图没有、又不是闸门自己藏的。
  const lift = agent.ctx.tools.restrict({ deny: ["read"] });
  assert.equal(gate.snapshot(agent).upstreamHidden.includes("read"), true);
  await assert.rejects(() => invoke.execute({ tool: "read" }, exec), /被上游隐藏/);
  lift();
  await gate.release(agent);
});

// ── 6. 段落：冻结下搬到尾部，不再改系统提示词 ───────────────────────────────
await check("段落：冻结下加载段落不进系统提示词，正文搬到尾部声明（系统提示词逐字节不变）", async () => {
  const { gate, host, policy, agent } = makeRig({
    executor: makePtcExecutor(),
    policy: { capabilities: { "native:read": { tier: 1 }, "native:pwsh": { tier: 1 }, "section:HARNESS_IDENTITY": { tier: 1 } } },
  });
  mountSectionGate({ ctx: host.rootCtx, gate, logger: host.logger, policy });
  mountTailGate({ ctx: host.rootCtx, gate, policy });
  await gate.attach(agent);
  const assembly = () => ({
    sections: [
      { name: "HARNESS_IDENTITY", text: "you are dsh" },
      { name: "free-search:engines", text: "ENGINES-BODY-42" },
      { name: "tools:sdk", text: "sdk" },
    ],
    contexts: [],
    tools: [],
    variables: {},
  });
  const before = await host.assemble(assembly(), agent);
  const promptBefore = JSON.stringify(before.sections);
  assert.equal(before.sections.some((s) => s.name === "free-search:engines"), false, "按需段落应被摘掉");
  assert.ok(before.sections.some((s) => s.name === "gate-catalog"));
  await gate.load(agent, ["section:free-search:engines"]);
  const after = await host.assemble(assembly(), agent);
  assert.equal(JSON.stringify(after.sections), promptBefore, "加载段落不许改系统提示词（缓存纪律）");
  const decision = await host.preStep({ kind: "enter", messages: [userMessage("u1", "hi")] }, agent);
  const tail = decision.messages[decision.messages.length - 1];
  assert.equal(isTailMessage(tail), true);
  const text = messageTextOf(tail);
  assert.ok(text.includes('<gate-section name="free-search:engines">'), text);
  assert.ok(text.includes("ENGINES-BODY-42"), "段落正文必须出现");
  assert.equal(text.includes("you are dsh"), false, "常驻段落不该被重复搬一遍");
  await gate.release(agent);
});

await check("段落：native 下加载仍回系统提示词（保持现状，理由见 README）", async () => {
  const { gate, host, policy, agent } = makeRig({
    executor: makeNativeExecutor(),
    policy: { capabilities: { "native:read": { tier: 1 }, "native:pwsh": { tier: 1 }, "section:HARNESS_IDENTITY": { tier: 1 } } },
  });
  mountSectionGate({ ctx: host.rootCtx, gate, logger: host.logger, policy });
  mountTailGate({ ctx: host.rootCtx, gate, policy });
  await gate.attach(agent);
  const assembly = () => ({
    sections: [
      { name: "HARNESS_IDENTITY", text: "you are dsh" },
      { name: "free-search:engines", text: "ENGINES-BODY-42" },
    ],
    contexts: [],
    tools: [],
    variables: {},
  });
  await host.assemble(assembly(), agent);
  await gate.load(agent, ["section:free-search:engines"]);
  const after = await host.assemble(assembly(), agent);
  assert.ok(after.sections.some((s) => s.name === "free-search:engines"), "native 下加载的段落要回提示词");
  const decision = await host.preStep({ kind: "enter", messages: [userMessage("u1", "hi")] }, agent);
  assert.equal(decision.messages.length, 1, "native 下不追加尾部声明");
  await gate.release(agent);
});

const failed = results.filter((row) => !row.ok);
for (const row of results) console.log((row.ok ? "  ok    " : "  FAIL  ") + row.label + (row.ok ? "" : "  →  " + row.error));
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exitCode = failed.length === 0 ? 0 : 1;
