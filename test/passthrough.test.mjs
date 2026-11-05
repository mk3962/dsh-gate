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
 * 宿主来自共享 seam（test/host.mjs）。
 * 用法：node test/passthrough.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import { resolve as resolvePath } from "node:path";
import { createGate } from "../lib/gate.js";
import { resolvePolicy } from "../lib/policy.js";
import { makeHost } from "./host.mjs";

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
const OWN = ["subagent", "list_subagent_models"];

const policyDir = fs.mkdtempSync(resolvePath(os.tmpdir(), "gate-passthrough-"));

const policyOf = (rawPolicy = {}) =>
  resolvePolicy(
    {
      tools: { defaultTier: 2, overrides: { read: 1, write: 1, edit: 1, grep: 1, glob: 1, pwsh: 1, web_search: 1, web_fetch: 1, skill: 1 } },
      sections: { defaultTier: 1 },
      ...rawPolicy,
    },
    { logger: undefined, dshHome: policyDir },
  );

/** 建一个宿主：全员可见 GLOBAL 的注册面，每个 agent 单独带自己的工具面与自有层。 */
function hostOf(specs) {
  const host = makeHost({ names: GLOBAL, id: specs[0] ? specs[0].id : undefined });
  const agents = specs.map((spec, index) => (index === 0
    ? Object.assign(host.agent, { names: spec.names || GLOBAL, own: spec.own || [] }, spec.origin === undefined ? {} : { session: { header: { origin: spec.origin } } })
    : host.addAgent(spec)));
  return { host, agents };
}

async function run(specs, rawPolicy = {}) {
  const { host, agents } = hostOf(specs);
  const policy = policyOf(rawPolicy);
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  const out = [];
  for (const agent of agents) {
    await gate.attach(agent);
    const restrictCalls = host.restrictCalls(agent).filter((call) => call.kind === "restrict");
    const deny = restrictCalls.length > 0 ? restrictCalls[0].deny : [];
    out.push({ agent, deny, status: gate.snapshot(agent) });
  }
  await gate.releaseAll();
  return out;
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? "  ok    " : "  FAIL  ") + name + (detail ? " — " + detail : ""));
};

const specs = [
  { id: "session-root", origin: undefined, names: GLOBAL, own: OWN },
  { id: "child-wide", origin: "subagent", names: GLOBAL, own: OWN },
  // 真实 dsh-mnemon 子代理：白名单 4 个 mnemon_* + 自己这一层的 subagent（restrict 管不到）。
  { id: "child-narrow", origin: "subagent", names: [...MNEMON_CHILD_TOOLS, ...OWN], own: OWN },
  { id: "child-narrow-2", origin: "subagent", names: MNEMON_CHILD_TOOLS, own: [] },
];

const [rootOut, wideOut, narrowOut, narrowOut2] = await run(specs);

check("主会话仍被限制（deny 非空）", rootOut.deny.length > 0, "deny=" + rootOut.deny.length);
check("主会话 deny 含按需工具 mnemon_status", rootOut.deny.includes("mnemon_status"));
check("宽工具面子代理仍被限制（不白送 100+ 声明）", wideOut.deny.length > 0, "deny=" + wideOut.deny.length);
check("收窄子代理不被剥空（mnemon 白名单形态）", narrowOut.deny.length === 0, "deny=" + JSON.stringify(narrowOut.deny.slice(0, 6)));
check("收窄子代理（无 own 层）同样放行", narrowOut2.deny.length === 0, "deny=" + JSON.stringify(narrowOut2.deny.slice(0, 6)));
check("豁免生效时 gate_status.passthrough 为 true", narrowOut.status !== undefined && narrowOut.status.passthrough === true);

// 开关：narrowPassThrough = 0 时恢复旧行为（仍按策略隐藏）
const [knobOut] = await run([{ id: "child-narrow-3", origin: "subagent", names: [...MNEMON_CHILD_TOOLS, ...OWN], own: OWN }], { narrowPassThrough: 0 });
check("narrowPassThrough=0 时回到旧行为（deny 非空）", knobOut.deny.length > 0, "deny=" + knobOut.deny.length);

const failed = results.filter((r) => r.ok !== true);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exit(failed.length === 0 ? 0 : 1);
