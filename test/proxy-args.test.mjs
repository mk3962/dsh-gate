/**
 * gate_call / gate_invoke 的目标工具名别名（name ⇄ tool）。
 *
 * 起因（2026-11-14 真机）：两个兄弟工具的参数名不一致 —— gate_call 只认 name，gate_invoke 只认 tool。
 * 模型按另一个工具的习惯写就必然失败：给 gate_call 传 { tool: "deck_issue_list" } 直接抛
 * "gate_call: name 不能为空"，调用方只能靠猜重试。这不是历史失败的主因（历史那批是宿主
 * 批量委派失败，0.3.3 已用「重试一次」修掉），而是一次真实踩坑 + 设计上易踩。
 *
 * 现在两边都认两个键（主键优先、为空再取别名），两个都为空才报错，且报错文本同时点出两个键名。
 * 转发语义、arguments 语义、required 都不动。
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
import { makeHost, makePtcExecutor } from "./host.mjs";

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
const makeRig = () => {
  const host = makeHost();
  // PTC 执行器：冻结工具表，已加载/被藏的能力只能从 gate_invoke / gate_call 走（真机形态）。
  host.setExecutor(host.agent, makePtcExecutor());
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

// ── 2. 参数 schema：两个键都声明，且没有新增 required ─────────────────────────
await check("schema：gate_call / gate_invoke 都声明 name 与 tool，别名键说明写「等价」", () => {
  const { host } = makeRig();
  for (const [primary, alias] of [["name", "tool"], ["tool", "name"]]) {
    const tool = host.tool(primary === "name" ? "gate_call" : "gate_invoke");
    assert.ok(tool, "没注册上");
    // 本仓的 parameters 就是一张属性表（gate_search / gate_load 同样写法），不是 { type, properties }。
    const properties = tool.parameters;
    assert.ok(properties && properties.name && properties.tool, "两个键都必须声明");
    assert.match(properties[alias].description, /等价/, alias + " 的 description=" + properties[alias].description);
    assert.match(properties[alias].description, /二选一/);
    assert.ok(properties.arguments, "arguments 语义不变，仍在");
    assert.equal(properties.arguments.type, "object");
  }
});
await check("schema：没有新增 required（宿主不接受 required 就不加）", () => {
  const { host } = makeRig();
  for (const name of ["gate_call", "gate_invoke"]) {
    const parameters = host.tool(name).parameters;
    assert.equal(parameters.required, undefined, name + " 不该新增 required: " + JSON.stringify(parameters.required));
  }
});

// ── 3. 端到端：真的转发（走 host.mjs 的注册 + 执行路径） ─────────────────────
await check("gate_call 传别名 tool：转发成功（原来是必失败的那一次）", async () => {
  const { host, gate, agent } = makeRig();
  await gate.attach(agent);
  const forwarded = await host.tool("gate_call").execute({ tool: "ssh_exec", arguments: { command: "echo hi" } }, { agent, signal: undefined });
  assert.equal(forwarded.isError, false, forwarded.text);
  assert.equal(forwarded.text, 'ssh_exec ok {"command":"echo hi"}');
  await gate.release(agent);
});
await check("gate_call 传主键 name：行为不变（不破坏既有调用）", async () => {
  const { host, gate, agent } = makeRig();
  await gate.attach(agent);
  const forwarded = await host.tool("gate_call").execute({ name: "ssh_exec", arguments: { command: "echo hi" } }, { agent, signal: undefined });
  assert.equal(forwarded.isError, false, forwarded.text);
  assert.equal(forwarded.text, 'ssh_exec ok {"command":"echo hi"}');
  await gate.release(agent);
});
await check("gate_invoke 传别名 name：转发成功", async () => {
  const { host, gate, agent } = makeRig();
  await gate.attach(agent);
  const forwarded = await host.tool("gate_invoke").execute({ name: "ssh_exec", arguments: { command: "echo hi" } }, { agent, signal: undefined });
  assert.equal(forwarded.isError, false, forwarded.text);
  assert.equal(forwarded.text, 'ssh_exec ok {"command":"echo hi"}');
  await gate.release(agent);
});
await check("gate_invoke 传主键 tool：行为不变", async () => {
  const { host, gate, agent } = makeRig();
  await gate.attach(agent);
  const forwarded = await host.tool("gate_invoke").execute({ tool: "ssh_exec", arguments: { command: "echo hi" } }, { agent, signal: undefined });
  assert.equal(forwarded.isError, false, forwarded.text);
  assert.equal(forwarded.text, 'ssh_exec ok {"command":"echo hi"}');
  await gate.release(agent);
});
await check("两个键都传时按主键：gate_call 取 name、gate_invoke 取 tool", async () => {
  const { host, gate, agent } = makeRig();
  await gate.attach(agent);
  const exec = { agent, signal: undefined };
  const call = await host.tool("gate_call").execute({ name: "ssh_exec", tool: "no_such_tool_xyz", arguments: { command: "x" } }, exec);
  assert.equal(call.isError, false, "主键是有效工具就不能被别名带歪: " + call.text);
  const invoke = await host.tool("gate_invoke").execute({ tool: "ssh_exec", name: "no_such_tool_xyz", arguments: { command: "x" } }, exec);
  assert.equal(invoke.isError, false, "主键是有效工具就不能被别名带歪: " + invoke.text);
  await gate.release(agent);
});

// ── 4. 两个都为空：报错，且文本同时点出两个键名 ──────────────────────────────
await check("两个键都不传：gate_call 报错文本含 name 与 tool", async () => {
  const { host, gate, agent } = makeRig();
  await gate.attach(agent);
  await assert.rejects(
    () => host.tool("gate_call").execute({}, { agent, signal: undefined }),
    (error) => {
      assert.match(error.message, /name/);
      assert.match(error.message, /tool/);
      return true;
    },
  );
  // 空白串同样算空（旧实现是 trim 后判空）。
  await assert.rejects(() => host.tool("gate_call").execute({ name: "  ", tool: " " }, { agent, signal: undefined }), /不能为空/);
  await gate.release(agent);
});
await check("两个键都不传：gate_invoke 报错文本含 tool 与 name", async () => {
  const { host, gate, agent } = makeRig();
  await gate.attach(agent);
  await assert.rejects(
    () => host.tool("gate_invoke").execute({}, { agent, signal: undefined }),
    (error) => {
      assert.match(error.message, /tool/);
      assert.match(error.message, /name/);
      return true;
    },
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
