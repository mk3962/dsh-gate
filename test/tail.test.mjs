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
import { failBatchTimes } from "./vendor/dsh-tools/pipeline.js";

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
  // 0.4.0：签名走增量投递（gate_load 的工具结果），尾部只剩索引行。
  const sig = gate.deltaTextFor(agent, ["univer_doc", "tail_sig"]);
  assert.ok(sig.text.includes("univer_doc()"), "无参数工具也要有签名");
  assert.ok(sig.text.includes("- tail_sig({ text: string, limit?: number })"), "声明里要有必填/可选标记的紧凑签名：" + sig.text);
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

/**
 * 0.3.1 回归：宿主的 pre-step 只交本轮 claim 的新增消息（dsh-agent-loop 的 claimed），
 * 历史里的尾部块不会出现在 decision.messages 里；返回数组只走 append。
 * 所以「内容不变就复用同一条消息」在真机上不可能发生 —— 曾经的实现因此每步追加一条，
 * 一条 40 多步的会话累积成 57 条 / 约 1 万 token（session.v4.jsonl.zstd 实测）。
 */
await check("delta 契约：清单没变就一条都不再追加（历史不累积）", async () => {
  const { gate, host, agent } = makeRig({ executor: makePtcExecutor() });
  mountTailGate({ ctx: host.rootCtx, gate, policy: policyFor() });
  await gate.attach(agent);
  await gate.load(agent, ["univer_doc"]);
  const first = await host.preStep({ kind: "enter", messages: [userMessage("u1", "一")] }, agent);
  assert.equal(first.messages.length, 2, "第一次要追加一条声明");
  assert.equal(isTailMessage(first.messages[1]), true);
  // 第二步：宿主只交本轮新消息（不含历史里那条声明）
  const assistant = { id: "a1", role: "assistant", content: [{ type: "text", text: "调工具" }] };
  const second = await host.preStep({ kind: "enter", messages: [assistant] }, agent);
  assert.equal(second.messages.length, 1, "清单没变，不能再追加一条");
  assert.equal(second.messages[0], assistant, "本轮消息必须原对象返回");
  const third = await host.preStep({ kind: "enter", messages: [userMessage("u2", "二")] }, agent);
  assert.equal(third.messages.length, 1, "同一份声明不能每步发一次");
  assert.equal(third.messages[0].id, "u2");
  await gate.release(agent);
});

await check("continuation 步（本轮 claimed 为空）照样能补发变化的声明", async () => {
  const { gate, host, agent } = makeRig({ executor: makePtcExecutor() });
  mountTailGate({ ctx: host.rootCtx, gate, policy: policyFor() });
  await gate.attach(agent);
  await gate.load(agent, ["univer_doc"]);
  const first = await host.preStep({ kind: "enter", messages: [userMessage("u1", "一")] }, agent);
  assert.equal(first.messages.length, 2);
  // 工具循环内部：claimed 是空的（工具结果不进 inbox），此时清单变了必须补一条
  await gate.load(agent, ["ssh_exec"]);
  const empty = await host.preStep({ kind: "enter", messages: [] }, agent);
  assert.equal(empty.messages.length, 1, "claimed 为空也要补发（否则模型永远不知道刚加载了什么）");
  assert.equal(isTailMessage(empty.messages[0]), true);
  const text = messageTextOf(empty.messages[0]);
  assert.ok(text.includes("univer_doc") && text.includes("ssh_exec"), text);
  // 再往下一步还是空 claimed，但清单没变：不再发
  const again = await host.preStep({ kind: "enter", messages: [] }, agent);
  assert.equal(again.messages.length, 0, "清单没变就不再追加");
  await gate.release(agent);
});

await check("delta 契约：清单变了才追加一条新的，旧声明不回收也不重复", async () => {
  const { gate, host, agent } = makeRig({ executor: makePtcExecutor() });
  mountTailGate({ ctx: host.rootCtx, gate, policy: policyFor() });
  await gate.attach(agent);
  await gate.load(agent, ["univer_doc"]);
  const first = await host.preStep({ kind: "enter", messages: [userMessage("u1", "一")] }, agent);
  assert.equal(first.messages.length, 2);
  await gate.load(agent, ["ssh_exec"]);
  const second = await host.preStep({ kind: "enter", messages: [userMessage("u2", "二")] }, agent);
  assert.equal(second.messages.length, 2, "清单变了要追加一条新的");
  const text = messageTextOf(second.messages[1]);
  assert.ok(text.includes("univer_doc") && text.includes("ssh_exec"), text);
  // 再下一步（还是同一份清单）：不再追加
  const third = await host.preStep({ kind: "enter", messages: [userMessage("u3", "三")] }, agent);
  assert.equal(third.messages.length, 1);
  await gate.release(agent);
});

await check("表面自愈：插件重启（内存里没有记录）时按会话表面判断，不重复追加", async () => {
  const first = makeRig({ executor: makePtcExecutor() });
  mountTailGate({ ctx: first.host.rootCtx, gate: first.gate, policy: policyFor() });
  await first.gate.attach(first.agent);
  await first.gate.load(first.agent, ["univer_doc"]);
  const text = first.gate.loadedTextFor(first.agent);
  assert.ok(text.length > 0);

  // 新 rig = 新插件实例（WeakMap 里没有这个 agent 的记录），但会话表面里已经有那条声明。
  const second = makeRig({ executor: makePtcExecutor() });
  second.agent.session = {
    surface: { nodes: [1, 7] },
    eventAt: (seq) => (seq === 7
      ? { type: "user/message", data: { id: "gate-tail-x", role: "user", source: { kind: "gate-tail" }, content: [{ type: "text", text }] } }
      : (seq === 1 ? { type: "user/message", data: userMessage("u1", "一") } : undefined)),
  };
  await second.gate.attach(second.agent);
  await second.gate.load(second.agent, ["univer_doc"]);
  const decision = await second.host.preStep({ kind: "enter", messages: [userMessage("u2", "二")] }, second.agent);
  assert.equal(decision.messages.length, 1, "表面里已有同一份声明，不该再追加");
  await first.gate.release(first.agent);
  await second.gate.release(second.agent);
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

// ── 5b. 宿主批量委派失败的补偿（0.3.3 生产体检） ─────────────────────────────
await check("宿主批量委派失败：自动重试一次并成功（生产日志里 95 次同一条报错）", async () => {
  const rig = makeRig({ executor: makePtcExecutor() });
  const { gate, host, agent } = rig;
  registerGateTools({ ctx: host.rootCtx, gate, policy: rig.policy });
  await gate.attach(agent);
  failBatchTimes(1);
  const forwarded = await host.tool("gate_invoke").execute({ tool: "ssh_exec", arguments: { command: "echo hi" } }, { agent, signal: undefined });
  assert.equal(forwarded.isError, false, "第一次批量失败、重试成功 ⇒ 不能把失败交给模型");
  assert.equal(forwarded.text, 'ssh_exec ok {"command":"echo hi"}');
  await gate.release(agent);
});

await check("宿主批量委派失败：连续两次都失败时，文案要说明「参数没错」且只重试一次", async () => {
  const rig = makeRig({ executor: makePtcExecutor() });
  const { gate, host, agent } = rig;
  registerGateTools({ ctx: host.rootCtx, gate, policy: rig.policy });
  await gate.attach(agent);
  failBatchTimes(99);
  const forwarded = await host.tool("gate_invoke").execute({ tool: "ssh_exec", arguments: { command: "echo hi" } }, { agent, signal: undefined });
  assert.equal(forwarded.isError, true, "两次都失败 ⇒ 仍是 isError 结果");
  assert.match(forwarded.text, /宿主执行通道暂时不可用/);
  assert.match(forwarded.text, /参数没有错/);
  assert.doesNotMatch(forwarded.text, /Tool batch execution failed/, "不能再把宿主内部报错原样丢给模型");
  failBatchTimes(0);
  await gate.release(agent);
});

await check("真实工具报错不触发重试：副作用只做一次（判据是「抛」不是「文案」）", async () => {
  const rig = makeRig({ executor: makePtcExecutor() });
  const { gate, host, agent } = rig;
  failBatchTimes(0);
  let runs = 0;
  host.registry.set("tail_count", {
    name: "tail_count",
    description: "计数后失败。",
    // 目标工具自己抛的错误文本恰好与宿主文案相同 —— 宿主管线会把它变成结果（不是抛），
    // 所以不会命中重试判据。这条用例守的就是「别因为文案相同把副作用做两遍」。
    execute: async () => { runs += 1; throw new Error("Tool batch execution failed"); },
  });
  registerGateTools({ ctx: host.rootCtx, gate, policy: rig.policy });
  await gate.attach(agent);
  const forwarded = await host.tool("gate_invoke").execute({ tool: "tail_count", arguments: {} }, { agent, signal: undefined });
  assert.equal(forwarded.isError, true);
  assert.equal(runs, 1, "工具只执行一次（重试判据只认宿主抛出的批量失败）");
  assert.match(forwarded.text, /Tool batch execution failed/, "工具自己的错误原样返回，不被改写成「通道不可用」");
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
  // 0.4.0：段落正文与工具签名一样走**增量投递**（在加载那一刻渲染一次），
  // 尾部只留索引行 —— 所以正文断言改在 deltaTextFor 的产物上做。
  const delta = gate.deltaTextFor(agent, ["section:free-search:engines"]);
  const text = delta.text;
  assert.ok(text.includes('<gate-section name="free-search:engines">'), text);
  assert.ok(text.includes("ENGINES-BODY-42"), "段落正文必须出现");
  assert.equal(text.includes("you are dsh"), false, "常驻段落不该被重复搬一遍");
  const decision = await host.preStep({ kind: "enter", messages: [userMessage("u1", "hi")] }, agent);
  const tail = decision.messages[decision.messages.length - 1];
  assert.equal(isTailMessage(tail), true);
  const tailText = messageTextOf(tail);
  assert.equal(tailText.includes("ENGINES-BODY-42"), false, "0.4.0 尾部不再重复正文（签名/正文都在增量块里）");
  assert.ok(tailText.includes("本次会话已加载"), "尾部必须留名字索引：" + tailText);
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

// ── 7. 段落保护：tools:sdk / tools:ptc-only 永不被摘（tier=off 也不行） ───────
await check("段落保护：tools:sdk / tools:ptc-only 内在保护，用户 protected 追加同样生效", async () => {
  const { gate, host, policy, agent } = makeRig({
    executor: makePtcExecutor(),
    policy: {
      capabilities: {
        "section:tools:sdk": { tier: 0 },
        "section:tools:ptc-only": { tier: 0 },
        "section:custom:keep": { tier: 0 },
      },
      protected: ["custom:keep"],
    },
  });
  mountSectionGate({ ctx: host.rootCtx, gate, logger: host.logger, policy });
  await gate.attach(agent);
  const plan = gate.planSections(agent);
  assert.equal(plan.shouldDrop("tools:sdk"), false, "tools:sdk 内在保护，即使策略明确 tier=0 也不许摘");
  assert.equal(plan.shouldDrop("tools:ptc-only"), false, "tools:ptc-only 内在保护，tier=0 也不许摘");
  assert.equal(plan.shouldDrop("custom:keep"), false, "用户 protected 追加的段落同样永不被摘");
  assert.equal(plan.shouldDrop("free-search:engines"), true, "未保护的按需段落仍照常摘");

  const assembly = () => ({
    sections: [
      { name: "tools:sdk", text: "SDK-SIGNATURES" },
      { name: "tools:ptc-only", text: "PTC-SIGNATURES" },
      { name: "custom:keep", text: "KEEP-ME" },
      { name: "free-search:engines", text: "DROP-ME" },
    ],
    contexts: [],
    tools: [],
    variables: {},
  });
  const result = await host.assemble(assembly(), agent);
  const names = result.sections.map((section) => section.name);
  assert.ok(names.includes("tools:sdk"), "装配结果必须保留 tools:sdk：" + JSON.stringify(names));
  assert.ok(names.includes("tools:ptc-only"), "装配结果必须保留 tools:ptc-only：" + JSON.stringify(names));
  assert.ok(names.includes("custom:keep"), "装配结果必须保留用户 protected 段落");
  assert.equal(names.includes("free-search:engines"), false, "未保护段落照常摘");
  await gate.release(agent);
});

// ── 8. gate_load("section:不存在") 不收：按当前清单校验 bare 名 ───────────────
await check("段落加载校验：不存在的段落进 unknown，真实段落才收；先记录清单再生效", async () => {
  const { gate, host, policy, agent } = makeRig({ executor: makePtcExecutor() });
  mountSectionGate({ ctx: host.rootCtx, gate, logger: host.logger, policy });
  await gate.attach(agent);

  // 还没装配过：清单为空，任何段落名都不该被收下。
  const early = await gate.load(agent, ["section:free-search:engines"]);
  assert.deepEqual(early.loaded, [], "没有清单时不许收段落");
  assert.deepEqual(early.unknown, ["section:free-search:engines"]);

  await host.assemble({
    sections: [{ name: "free-search:engines", text: "ENGINES-BODY" }],
    contexts: [],
    tools: [],
    variables: {},
  }, agent);

  const missing = await gate.load(agent, ["section:不存在", "section:"]);
  assert.deepEqual(missing.loaded, [], "不存在的段落名不许进 loaded");
  assert.deepEqual(missing.unknown, ["section:不存在", "section:"], "不存在 / 空名都要进 unknown");

  const real = await gate.load(agent, ["section:free-search:engines"]);
  assert.deepEqual(real.loaded, ["section:free-search:engines"], "真实段落必须能加载");
  assert.deepEqual(real.unknown, []);
  assert.ok(gate.loadedTextFor(agent).includes("ENGINES-BODY"));
  await gate.release(agent);
});

// ── 9. 段落正文加载时定格：尾部先出正文，后改装配文本也不变 ──────────────────
await check("段落正文定格：加载时从 inventory 抄正文，后续装配改文不改尾部声明（不出占位）", async () => {
  const { gate, host, policy, agent } = makeRig({ executor: makePtcExecutor() });
  mountSectionGate({ ctx: host.rootCtx, gate, logger: host.logger, policy });
  mountTailGate({ ctx: host.rootCtx, gate, policy });
  await gate.attach(agent);
  const assembly = (text) => ({
    sections: [
      { name: "HARNESS_IDENTITY", text: "you are dsh" },
      { name: "free-search:engines", text },
    ],
    contexts: [],
    tools: [],
    variables: {},
  });

  await host.assemble(assembly("BODY-A"), agent);
  const loaded = await gate.load(agent, ["section:free-search:engines"]);
  assert.deepEqual(loaded.loaded, ["section:free-search:engines"]);
  const first = gate.loadedTextFor(agent);
  assert.ok(first.includes("BODY-A"), "首次加载必须直接拿到正文：" + first);
  assert.equal(first.includes("未取到段落正文"), false, "不许先出正文缺失占位");

  // 装配文本变了，但加载时已定格：尾部声明逐字节不变。
  await host.assemble(assembly("BODY-B"), agent);
  const second = gate.loadedTextFor(agent);
  assert.equal(second, first, "加载后改装配文本，尾部声明必须逐字节不变");
  assert.equal(second.includes("BODY-B"), false, "后改的正文不许漏进尾部声明");
  await gate.release(agent);
});

// ── 10. 0.4.0 增量投递：只发新增、索引给全集、不覆盖工具表 ──────────────────
await check("0.4.0 增量：第一次只发本次新增的签名，块头改口径", async () => {
  const rig = makeRig({ executor: makePtcExecutor() });
  const { gate, host, agent } = rig;
  registerGateTools({ ctx: host.rootCtx, gate, policy: rig.policy });
  await gate.attach(agent);
  await gate.load(agent, ["univer_doc"]);
  const first = gate.deltaTextFor(agent, ["univer_doc"]);
  assert.ok(first.text.includes("本次新增"), "增量块表头必须是「本次新增」：" + first.text);
  assert.ok(first.text.includes("univer_doc"), first.text);
  assert.ok(first.text.includes("本次会话已加载 1 个"), "必须带名字索引：" + first.text);
  assert.deepEqual(first.fresh, ["univer_doc"]);
  await gate.release(agent);
});

await check("0.4.0 增量：同一工具第二次加载不再重复投递（省字节的关键）", async () => {
  const rig = makeRig({ executor: makePtcExecutor() });
  const { gate, host, agent } = rig;
  await gate.attach(agent);
  await gate.load(agent, ["univer_doc"]);
  gate.deltaTextFor(agent, ["univer_doc"]);
  const again = gate.deltaTextFor(agent, ["univer_doc"]);
  assert.equal(again.text, "", "已投递过的签名必须一条都不再发");
  assert.deepEqual(again.fresh, []);
  await gate.release(agent);
});

await check("0.4.0 增量：第二次加载只发第二个，索引行变成 2 个", async () => {
  const rig = makeRig({ executor: makePtcExecutor() });
  const { gate, host, agent } = rig;
  await gate.attach(agent);
  await gate.load(agent, ["univer_doc"]);
  gate.deltaTextFor(agent, ["univer_doc"]);
  await gate.load(agent, ["ssh_exec"]);
  const second = gate.deltaTextFor(agent, ["ssh_exec"]);
  assert.deepEqual(second.fresh, ["ssh_exec"]);
  assert.ok(second.text.includes("- ssh_exec("), second.text);
  assert.equal(second.text.includes("- univer_doc("), false, "已投递过的签名不许再出现（索引行里的名字除外）");
  assert.ok(second.text.includes("本次会话已加载 2 个"), "索引必须反映全集：" + second.text);
  assert.ok(second.text.includes("univer_doc"), "索引行必须列出全集的名字");
  await gate.release(agent);
});

await check("0.4.0 增量：字节账 —— 20 次加载的增量累计远小于全量重发", async () => {
  const rig = makeRig({ executor: makePtcExecutor() });
  const { gate, host, agent } = rig;
  await gate.attach(agent);
  const names = [...(rig.host.registry ?? new Map()).keys()]
    .filter((name) => !name.startsWith("gate_") && name !== "skill")
    .slice(0, 8);
  assert.ok(names.length >= 3, "测试宿主里至少要有 3 个可加载工具");
  let fullTotal = 0;
  let deltaTotal = 0;
  const loadedSoFar = [];
  for (const name of names) {
    await gate.load(agent, [name]);
    loadedSoFar.push(name);
    fullTotal += gate.loadedTextFor(agent).length;
    deltaTotal += gate.deltaTextFor(agent, [name]).text.length;
  }
  assert.ok(deltaTotal < fullTotal, "增量累计(" + deltaTotal + ")必须小于全量重发累计(" + fullTotal + ")");
  await gate.release(agent);
});

await check("0.4.0 尾部：只发索引行，不含签名与段落正文", async () => {
  const rig = makeRig({ executor: makePtcExecutor() });
  const { gate, host, agent, policy } = rig;
  mountTailGate({ ctx: host.rootCtx, gate, policy });
  await gate.attach(agent);
  await gate.load(agent, ["univer_doc"]);
  gate.deltaTextFor(agent, ["univer_doc"]);
  const decision = await host.preStep({ kind: "enter", messages: [userMessage("u1", "hi")] }, agent);
  const tail = decision.messages[decision.messages.length - 1];
  const text = messageTextOf(tail);
  assert.ok(text.includes("本次会话已加载 1 个"), text);
  assert.equal(text.includes("univer_doc()"), false, "尾部不许重复签名：" + text);
  await gate.release(agent);
});

const failed = results.filter((row) => !row.ok);
for (const row of results) console.log((row.ok ? "  ok    " : "  FAIL  ") + row.label + (row.ok ? "" : "  →  " + row.error));
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exitCode = failed.length === 0 ? 0 : 1;
