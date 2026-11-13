/**
 * 加载测试：用真实的 lib/index.js 入口跑一遍 apply()，验证导入、工具注册、钩子挂载、卸载清理。
 * 宿主来自共享 seam（test/host.mjs），@deepseek-ai/dsh-tools 由 node_modules 替身提供（离线，不碰真实宿主）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply, name } from "../lib/index.js";
import { makeHost } from "./host.mjs";

const host = makeHost({
  id: "agent-loadtest",
  names: ["read", "write", "univer_sheet", "ssh_exec", "gate_status", "gate_search", "gate_load", "gate_call"],
});
const agent = host.agent;

const results = [];
const check = (label, fn) => {
  try { fn(); results.push({ ok: true, label }); }
  catch (error) { results.push({ ok: false, label, error: String((error && error.message) || error) }); }
};

check("插件名", () => assert.equal(name, "dsh-gate"));
// 显式给临时 policyFile：绝不读真实 ~/.dsh/gate.json（那会把本机 v2 策略当成用例输入，
// 迁移还会在用户 profile 里写备份 —— 测试不碰桌面 profile）。
const policyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gate-loadtest-")), "gate.json");
const dispose = apply(host.rootCtx, { enabled: true, policyFile });
check("apply 返回卸载函数", () => assert.equal(typeof dispose, "function"));
check("注册了 4 个闸门工具", () => {
  for (const toolName of ["gate_status", "gate_search", "gate_load", "gate_call"]) {
    assert.ok(host.registry.has(toolName), toolName);
  }
});
check("挂了 assemble 与 pre-step 钩子", () => {
  assert.equal(host.hookCount("system-prompt/assemble") >= 1, true);
  assert.equal(host.hookCount("agent/pre-step") >= 1, true);
});
check("挂了 agent 生命周期钩子", () => {
  assert.equal(host.hookCount("agent/created") >= 1, true);
  assert.equal(host.hookCount("agent/disposed") >= 1, true);
});
await new Promise((resolve) => setTimeout(resolve, 10));

check("已有 agent 被接管并建立了限制", () => {
  assert.ok(host.restrictionsFor(agent).length >= 1, "restrictions=" + host.restrictionsFor(agent).length);
  assert.equal(host.visibleOf(agent).has("univer_sheet"), false);
  assert.equal(host.visibleOf(agent).has("read"), true);
});

await new Promise((resolve) => setTimeout(resolve, 10));
check("日志里出现挂载记录", () => {
  assert.ok(host.logs.some((line) => line.startsWith("info dsh-gate: 已挂载 agent")), host.logs.join(" | "));
});

const statusTool = host.tool("gate_status");
const status = await statusTool.execute({}, { agent });
check("gate_status 能执行且数字自洽", () => {
  assert.equal(typeof status.visible, "number");
  assert.ok(status.resident > 0);
  assert.ok(status.onDemand > 0);
  assert.equal(status.visible, status.resident + status.onDemand + status.off);
});
check("gate_status 的 render 产出文本块", () => {
  const blocks = statusTool.output.render({}, status);
  assert.equal(Array.isArray(blocks), true);
  assert.equal(blocks[0].type, "text");
  assert.ok(blocks[0].text.includes("常驻"));
});

dispose();
check("卸载后限制被撤销", () => {
  assert.equal(host.visibleOf(agent).has("univer_sheet"), true);
});

const failed = results.filter((entry) => !entry.ok);
for (const entry of results) console.log((entry.ok ? "  ok  " : "  FAIL") + "  " + entry.label + (entry.ok ? "" : "  →  " + entry.error));
console.log(failed.length === 0 ? "\n全部通过 (" + results.length + ")" : "\n" + failed.length + " 项失败 / " + results.length);
process.exitCode = failed.length === 0 ? 0 : 1;
