/**
 * 委派收窄豁免（narrowPassThrough）用例 —— 2026-11-01 事故回归。
 *
 * 事故：dsh-mnemon 的写入/复核子代理是「allow 白名单 + PTC」形态，工具面只有
 *   mnemon_document_search / mnemon_runtime_memory / mnemon_document_create / mnemon_subagent_result。
 * 闸门把全局注册的 mnemon_* 全归到「按需」并从**每个** agent deny 掉 ⇒ 子代理一个可用工具都没有，
 *  既记不了结果（mnemon_subagent_result），也无法用 gate_load 自救，父会话最终抛
 *   "memory subagent completed without recording its result"。
 *
 * 结论：origin=subagent 且授予工具数 <= narrowPassThrough（默认 12）的 agent 跳过闸门。
 * 用法：node test/passthrough.test.mjs
 */
import os from "node:os";
import fs from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const LIB = new URL("../lib/", import.meta.url);
const { createGate } = await import(new URL("gate.js", LIB).href);
const { resolvePolicy } = await import(new URL("policy.js", LIB).href);

const MNEMON_CHILD_TOOLS = [
  "mnemon_document_search",
  "mnemon_runtime_memory",
  "mnemon_document_create",
  "mnemon_subagent_result",
];
const BASICS = ["read", "write", "edit", "grep", "glob", "pwsh", "web_search", "web_fetch", "skill", "todo_write"];
const ONDEMAND = ["mnemon_status", "mnemon_recall", "mnemon_remember", "univer_new", "univer_status", "ppt_create", "word_create", "excel_create"];
// 这 4 个在真实宿主里是全局注册的（不在 agent 自己这一层），闸门管得到 —— 这正是事故前提。
const GLOBAL = [...BASICS, ...ONDEMAND, ...MNEMON_CHILD_TOOLS];
const OWN = ["run_code", "subagent", "list_subagent_models"];

const definition = (name) => ({ name, description: "tool " + name });

function makeView(names, own = []) {
  const ownSet = new Set(own);
  return {
    visible: new Map(names.map((name) => [name, definition(name)])),
    restrictableNames: new Set(names.filter((name) => !ownSet.has(name))),
    knownNames: new Set([...names, ...own]),
  };
}

function makeAgent({ id, origin, tools, own = [] }) {
  const restrictCalls = [];
  const agent = { id, restrictCalls, tools, own };
  if (origin !== undefined) agent.session = { header: { origin } };
  agent.ctx = {
    plugin(config) {
      const scoped = {
        tools: {
          view: () => makeView(tools, own),
          restrict: (spec) => { restrictCalls.push(spec); return () => {}; },
          execute: async () => ({}),
        },
      };
      try { config.apply(scoped); } catch { /* 与宿主同：失败只降级 */ }
      return { dispose() { /* noop */ } };
    },
  };
  return agent;
}

function makeContext() {
  const handlers = new Map();
  const logs = [];
  return {
    logs,
    tools: {
      view: (agent) => (agent === undefined ? makeView(GLOBAL, OWN) : makeView(agent.tools, agent.own)),
      restrict: () => () => {},
      execute: async () => ({}),
    },
    logger: { info: (l) => logs.push(String(l)), warn: (l) => logs.push(String(l)), debug: (l) => logs.push(String(l)) },
    on(name, handler) { handlers.set(name, handler); return () => {}; },
    inject() {},
    agents: { roots: () => [] },
  };
}

const policyDir = fs.mkdtempSync(resolvePath(os.tmpdir(), "gate-passthrough-"));

async function run(agents, rawPolicy = {}) {
  const policy = resolvePolicy(
    {
      tools: { defaultTier: 2, overrides: { read: 1, write: 1, edit: 1, grep: 1, glob: 1, pwsh: 1, web_search: 1, web_fetch: 1, skill: 1 } },
      sections: { defaultTier: 1 },
      ...rawPolicy,
    },
    { logger: undefined, dshHome: policyDir },
  );
  const ctx = makeContext();
  const gate = createGate({ ctx, logger: ctx.logger, policy });
  const out = [];
  for (const agent of agents) {
    const entry = gate.attach(agent);
    if (entry !== undefined) await entry.ready;
    const deny = agent.restrictCalls.length > 0 ? (agent.restrictCalls[0].deny || []) : [];
    out.push({ agent, entry, deny });
  }
  await gate.releaseAll();
  return out;
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? "  ok    " : "  FAIL  ") + name + (detail ? " — " + detail : ""));
};

const rootAgent = makeAgent({ id: "session-root", origin: undefined, tools: GLOBAL, own: OWN });
const wideChild = makeAgent({ id: "child-wide", origin: "subagent", tools: GLOBAL, own: OWN });
// 真实 dsh-mnemon 子代理：白名单 4 个 mnemon_* + 自己这一层的 run_code/subagent（restrict 管不到）。
const narrowChild = makeAgent({ id: "child-narrow", origin: "subagent", tools: [...MNEMON_CHILD_TOOLS, ...OWN], own: OWN });
const narrowChild2 = makeAgent({ id: "child-narrow-2", origin: "subagent", tools: MNEMON_CHILD_TOOLS, own: [] });

const [rootOut, wideOut, narrowOut, narrowOut2] = await run([rootAgent, wideChild, narrowChild, narrowChild2]);

check("主会话仍被限制（deny 非空）", rootOut.deny.length > 0, "deny=" + rootOut.deny.length);
check("主会话 deny 含按需工具 mnemon_status", rootOut.deny.includes("mnemon_status"));
check("宽工具面子代理仍被限制（不白送 100+ 声明）", wideOut.deny.length > 0, "deny=" + wideOut.deny.length);
check("收窄子代理不被剥空（mnemon 白名单形态）", narrowOut.deny.length === 0, "deny=" + JSON.stringify(narrowOut.deny.slice(0, 6)));
check("收窄子代理（无 own 层）同样放行", narrowOut2.deny.length === 0, "deny=" + JSON.stringify(narrowOut2.deny.slice(0, 6)));
check("豁免生效时 gate_status.passthrough 为 true", narrowOut.entry !== undefined && narrowOut.entry.passthrough === true);

// 开关：narrowPassThrough = 0 时恢复旧行为（仍按策略隐藏）
const [knobOut] = await run([makeAgent({ id: "child-narrow-3", origin: "subagent", tools: [...MNEMON_CHILD_TOOLS, ...OWN], own: OWN })], { narrowPassThrough: 0 });
check("narrowPassThrough=0 时回到旧行为（deny 非空）", knobOut.deny.length > 0, "deny=" + knobOut.deny.length);

const failed = results.filter((r) => r.ok !== true);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exit(failed.length === 0 ? 0 : 1);
