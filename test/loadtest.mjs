/**
 * 加载测试：用真实的 lib/index.js 入口跑一遍 apply()，验证导入、工具注册、钩子挂载、卸载清理。
 * @deepseek-ai/dsh-tools 由 test 旁边的 node_modules 替身提供（离线，不碰真实宿主）。
 */
import assert from "node:assert/strict";
import { apply, name } from "../lib/index.js";

const registered = new Map();
const handlers = new Map();
const disposers = [];
const logger = { info: (m) => log.push("info " + m), warn: (m) => log.push("warn " + m), debug: () => {} };
const log = [];

const global = new Map();
for (const toolName of ["read", "write", "univer_sheet", "ssh_exec", "gate_status", "gate_search", "gate_load", "gate_call"]) {
  global.set(toolName, { name: toolName, description: toolName + " 说明", execute: async () => ({ content: [{ type: "text", text: "ok" }] }) });
}
let restrictions = [];
const visibleFor = () => {
  const visible = new Map();
  for (const [key, value] of global) if (!restrictions.some((set) => set.has(key))) visible.set(key, value);
  visible.set("run_code", { name: "run_code", description: "ptc" });
  return visible;
};
const tools = {
  view(scope) {
    const visible = scope === undefined ? new Map(global) : visibleFor();
    if (scope === undefined) visible.set("run_code", { name: "run_code", description: "ptc" });
    return { visible, restrictableNames: new Set(global.keys()), knownNames: new Set([...global.keys(), "run_code"]) };
  },
  restrict({ deny }) {
    const set = new Set(deny);
    for (const key of set) if (!global.has(key)) throw new Error("unknown tool " + key);
    restrictions.push(set);
    return () => { restrictions = restrictions.filter((entry) => entry !== set); };
  },
  register(definition) {
    registered.set(definition.name, definition);
    global.set(definition.name, definition);
    return () => { registered.delete(definition.name); global.delete(definition.name); };
  },
  async execute(input) {
    const definition = visibleFor().get(input.name);
    if (definition === undefined) throw new Error("UNKNOWN_TOOL " + input.name);
    return definition.execute(input.arguments, input);
  },
};

const agent = { id: "agent-loadtest", ctx: undefined };
const rootCtx = {
  tools,
  logger,
  agents: { roots: () => [agent] },
  on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(handler);
    const dispose = () => handlers.set(event, (handlers.get(event) || []).filter((entry) => entry !== handler));
    disposers.push(dispose);
    return dispose;
  },
  inject(_deps, callback) { return callback(rootCtx); },
  effect(callback) { return callback(); },
};
agent.ctx = {
  tools,
  on: rootCtx.on,
  plugin(descriptor) {
    descriptor.apply({ tools, on: rootCtx.on, effect: rootCtx.effect });
    return { dispose() {} };
  },
};

const results = [];
const check = (label, fn) => {
  try { fn(); results.push({ ok: true, label }); }
  catch (error) { results.push({ ok: false, label, error: String((error && error.message) || error) }); }
};

check("插件名", () => assert.equal(name, "dsh-gate"));
const dispose = apply(rootCtx, { enabled: true });
check("apply 返回卸载函数", () => assert.equal(typeof dispose, "function"));
check("注册了 4 个闸门工具", () => {
  for (const toolName of ["gate_status", "gate_search", "gate_load", "gate_call"]) assert.ok(registered.has(toolName), toolName);
});
check("挂了 assemble 与 pre-step 钩子", () => {
  assert.equal(handlers.get("system-prompt/assemble").length >= 1, true);
  assert.equal(handlers.get("agent/pre-step").length >= 1, true);
});
check("挂了 agent 生命周期钩子", () => {
  assert.equal(handlers.get("agent/created").length >= 1, true);
  assert.equal(handlers.get("agent/disposed").length >= 1, true);
});
await new Promise((resolve) => setTimeout(resolve, 10));

check("已有 agent 被接管并建立了限制", () => {
  assert.ok(restrictions.length >= 1, "restrictions=" + restrictions.length);
  assert.equal(visibleFor().has("univer_sheet"), false);
  assert.equal(visibleFor().has("read"), true);
});

await new Promise((resolve) => setTimeout(resolve, 10));
check("日志里出现挂载记录", () => {
  assert.ok(log.some((line) => line.startsWith("info dsh-gate: 已挂载 agent")), log.join(" | "));
});

const statusTool = registered.get("gate_status");
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
  assert.equal(visibleFor().has("univer_sheet"), true);
});

const failed = results.filter((entry) => !entry.ok);
for (const entry of results) console.log((entry.ok ? "  ok  " : "  FAIL") + "  " + entry.label + (entry.ok ? "" : "  →  " + entry.error));
console.log(failed.length === 0 ? "\n全部通过 (" + results.length + ")" : "\n" + failed.length + " 项失败 / " + results.length);
process.exitCode = failed.length === 0 ? 0 : 1;
