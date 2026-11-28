/**
 * gate_invoke 的唯一转发契约与目标工具名别名（tool ⇄ name）。
 *
 * 0.8.0 起已彻底移除 gate_call，闸门工具面收敛为 4 个（gate_status / gate_search /
 * gate_load / gate_invoke）。gate_invoke 在 native 与 PTC 下均无条件常驻，免 gate_load
 * 直呼可见非 off 工具，并以 tool 为主键、name 为容错别名（两个都为空才报错，且报错文本
 * 同时点出两个键名）。转发语义、arguments 语义、required 都不动。
 *
 * 跑法：node test/proxy-args.test.mjs
 *   （不必带 --import ./test/stub-loader.mjs：本文件自己在 import proxy.js 之前挂上解析钩子，
 *    这样两种跑法都成立；proxy.js 依赖裸包名 @deepseek-ai/dsh-tools，没有钩子在干净 checkout 会死。）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { createGate } from "../lib/gate.js";
import { resolvePolicy } from "../lib/policy.js";
import { makeHost, makeNativeExecutor, makePtcExecutor } from "./host.mjs";

// 静态 import 已经解析完毕，这里注册的钩子只影响后续动态 import —— proxy.js 正是动态导入的。
register("./stub-resolver.mjs", import.meta.url);
const { registerGateTools, resolveTargetName } = await import("../lib/proxy.js");

const results = [];
const check = async (label, fn) => {
  try { await fn(); results.push({ ok: true, label }); }
  catch (error) { results.push({ ok: false, label, error: String((error && error.message) || error) }); }
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gate-proxy-args-"));
/** 一个能真正转发的最小 rig：宿主 + 策略（第二层按需，ssh_exec 被藏）+ 闸门。 */
const makeRig = (executor = makePtcExecutor()) => {
  const host = makeHost();
  host.setExecutor(host.agent, executor);
  const policy = resolvePolicy({
    defaults: { capability: 2, section: 2, skillpack: 2 },
    capabilities: { "native:read": { tier: 1 }, "native:pwsh": { tier: 1 } },
  }, { dshHome: tmp() });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  registerGateTools({ ctx: host.rootCtx, gate, policy });
  return { host, gate, policy, agent: host.agent };
};

// ── 1. 取值函数本身（proxy.js 里可导出的 resolveTargetName） ──────────────────
await check("resolveTargetName：主键优先，主键为空才取别名", () => {
  assert.equal(resolveTargetName({ name: "a", tool: "b" }, "name", "tool"), "a");
  assert.equal(resolveTargetName({ name: "a", tool: "b" }, "tool", "name"), "b");
  assert.equal(resolveTargetName({ tool: "b" }, "name", "tool"), "b");
  assert.equal(resolveTargetName({ name: "a" }, "tool", "name"), "a");
});
await check("resolveTargetName：空串 / 纯空白 / undefined 都让位给别名", () => {
  assert.equal(resolveTargetName({ name: "", tool: "b" }, "name", "tool"), "b");
  assert.equal(resolveTargetName({ name: "   ", tool: " b " }, "name", "tool"), "b");
  assert.equal(resolveTargetName({ name: undefined, tool: null }, "name", "tool"), "");
  assert.equal(resolveTargetName({}, "name", "tool"), "");
  assert.equal(resolveTargetName(undefined, "name", "tool"), "");
});
await check("resolveTargetName：非字符串取 String() 再 trim（与旧实现同口径）", () => {
  assert.equal(resolveTargetName({ name: 0, tool: "b" }, "name", "tool"), "b", "0 是假值，旧实现同样让位");
  assert.equal(resolveTargetName({ tool: 123 }, "name", "tool"), "123");
});

// ── 2. 工具面与参数 schema：只注册 4 个闸门工具，gate_call 彻底消失 ──────────
await check("工具面：gate_call 已移除，native 与 PTC 下仅注册 4 个闸门工具", () => {
  for (const executor of [makePtcExecutor(), makeNativeExecutor()]) {
    const { host } = makeRig(executor);
    assert.equal(host.tool("gate_call"), undefined, "gate_call 不得再注册");
    assert.equal(host.registry.has("gate_call"), false, "registry 不得包含 gate_call");
    const gateNames = [...host.registry.keys()].filter((n) => n.startsWith("gate_")).sort();
    assert.deepEqual(gateNames, ["gate_invoke", "gate_load", "gate_search", "gate_status"]);
  }
});
await check("schema：gate_invoke 声明 tool 与 name，别名键说明写「等价」且不含 gate_call", () => {
  const { host } = makeRig();
  const tool = host.tool("gate_invoke");
  assert.ok(tool, "gate_invoke 没注册上");
  // 本仓的 parameters 就是一张属性表（gate_search / gate_load 同样写法），不是 { type, properties }。
  const properties = tool.parameters;
  assert.ok(properties && properties.tool && properties.name, "两个键都必须声明");
  assert.match(properties.name.description, /等价/, "name 的 description=" + properties.name.description);
  assert.match(properties.name.description, /二选一/);
  assert.doesNotMatch(properties.name.description, /gate_call/, "不得留对 gate_call 的悬空指涉");
  assert.doesNotMatch(properties.tool.description, /gate_call/, "不得留对 gate_call 的悬空指涉");
  assert.doesNotMatch(tool.description, /gate_call/, "工具说明不得留对 gate_call 的悬空指涉");
  assert.ok(properties.arguments, "arguments 语义不变，仍在");
  assert.equal(properties.arguments.type, "object");
});
await check("schema：没有新增 required（宿主不接受 required 就不加）", () => {
  const { host } = makeRig();
  const parameters = host.tool("gate_invoke").parameters;
  assert.equal(parameters.required, undefined, "gate_invoke 不该新增 required: " + JSON.stringify(parameters.required));
});

// ── 3. 端到端：gate_invoke 转发（PTC 与 native 均免 gate_load 直呼） ─────────
await check("gate_invoke 传别名 name：免 gate_load 直接转发成功", async () => {
  const { host, gate, agent } = makeRig();
  await gate.attach(agent);
  const forwarded = await host.tool("gate_invoke").execute({ name: "ssh_exec", arguments: { command: "echo hi" } }, { agent, signal: undefined });
  assert.equal(forwarded.isError, false, forwarded.text);
  assert.equal(forwarded.text, 'ssh_exec ok {"command":"echo hi"}');
  await gate.release(agent);
});
await check("gate_invoke 传主键 tool：免 gate_load 直接转发成功", async () => {
  const { host, gate, agent } = makeRig();
  await gate.attach(agent);
  const forwarded = await host.tool("gate_invoke").execute({ tool: "ssh_exec", arguments: { command: "echo hi" } }, { agent, signal: undefined });
  assert.equal(forwarded.isError, false, forwarded.text);
  assert.equal(forwarded.text, 'ssh_exec ok {"command":"echo hi"}');
  await gate.release(agent);
});
await check("gate_invoke 在 native 模式下无条件常驻且免 gate_load 直接转发成功", async () => {
  const { host, gate, agent } = makeRig(makeNativeExecutor());
  await gate.attach(agent);
  assert.equal(host.visibleOf(agent).has("gate_invoke"), true, "native 下 gate_invoke 必须常驻可见");
  assert.equal(host.visibleOf(agent).has("gate_call"), false, "native 下不得出现 gate_call");
  const forwarded = await host.tool("gate_invoke").execute({ tool: "ssh_exec", arguments: { command: "echo native" } }, { agent, signal: undefined });
  assert.equal(forwarded.isError, false, forwarded.text);
  assert.equal(forwarded.text, 'ssh_exec ok {"command":"echo native"}');
  await gate.release(agent);
});
await check("两个键都传时按主键：gate_invoke 取 tool（不被别名 name 带歪）", async () => {
  const { host, gate, agent } = makeRig();
  await gate.attach(agent);
  const exec = { agent, signal: undefined };
  const invoke = await host.tool("gate_invoke").execute({ tool: "ssh_exec", name: "no_such_tool_xyz", arguments: { command: "x" } }, exec);
  assert.equal(invoke.isError, false, "主键是有效工具就不能被别名带歪: " + invoke.text);
  await gate.release(agent);
});

// ── 4. 两个都为空：报错，且文本同时点出两个键名 ──────────────────────────────
await check("两个键都不传或全空白：gate_invoke 报错文本带 gate_invoke: 前缀且含 tool 与 name", async () => {
  const { host, gate, agent } = makeRig();
  await gate.attach(agent);
  await assert.rejects(
    () => host.tool("gate_invoke").execute({}, { agent, signal: undefined }),
    (error) => {
      assert.match(error.message, /^gate_invoke:/);
      assert.match(error.message, /tool/);
      assert.match(error.message, /name/);
      return true;
    },
  );
  // 空白串同样算空（旧实现是 trim 后判空）。
  await assert.rejects(
    () => host.tool("gate_invoke").execute({ tool: "  ", name: " " }, { agent, signal: undefined }),
    /不能为空/,
  );
  await gate.release(agent);
});

// ── 收尾输出（与仓内其它套件同风格） ─────────────────────────────────────────
const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log((result.ok ? "  ok  " : "  FAIL") + "  " + result.label + (result.ok ? "" : "  →  " + result.error));
}
console.log("");
console.log(failed.length === 0 ? "全部通过 (" + results.length + ")" : failed.length + " 项失败 / " + results.length);
process.exitCode = failed.length === 0 ? 0 : 1;
