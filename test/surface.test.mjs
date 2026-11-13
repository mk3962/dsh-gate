/**
 * gate 对外面投影（票 06）用例。
 *
 * 回归的是「面太宽 ⇒ 里面根本动不了」这件事：以前 gate 把 entries（agent → 内部条目）
 * 直接交出来，HTTP 层于是遍历它挑会话、读 entry.touchedAt，gate_search 读 entry.skills，
 * 测试读 entry.restriction。内部字段一动，一圈外部调用点全要跟着改。
 *
 * 现在对外只有能力：谁挂着（listAgents）、现在什么状态（snapshot / restrictionState）、
 * 目录长什么样（catalogFor）、把它推到目标形状（reapply）……内部表一个都不外露。
 *
 * 宿主来自共享 seam（test/host.mjs）。跑法：node test/surface.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGate, pickStatus, STATUS_KEYS } from "../lib/gate.js";
import { resolvePolicy } from "../lib/policy.js";
import { registerGateTools } from "../lib/proxy.js";
import { makeHost } from "./host.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");
const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-surface-"));

const NAMES = ["read", "write", "pwsh", "univer_sheet", "univer_doc", "ssh_exec", "mnemon_recall"];
const policyOf = (dir) => resolvePolicy(
  { tools: { defaultTier: 2, overrides: { read: 1, write: 1, pwsh: 1 } }, sections: { defaultTier: 1 } },
  { logger: undefined, dshHome: dir },
);

const results = [];
const check = async (label, fn) => {
  try { await fn(); results.push({ ok: true, label }); }
  catch (error) { results.push({ ok: false, label, error: String((error && error.message) || error) }); }
};

// loadedTextFor / canInvoke 是工单 07 加的两个「问得出口的问题」：
//   这一步尾部要追加什么（PTC 冻结） / 这个工具能不能转发（gate_invoke 的准入）。
const ANY = new Set(["attach", "listAgents", "restrictionState", "snapshot", "capabilityView", "knownNames", "canInvoke", "loadedTextFor", "planSections", "reapply", "isApplying", "load", "callThrough", "catalogFor", "searchEntries", "rememberSkills", "recordSections", "release", "releaseAll"]);

await check("公开面恰好是这组能力：内部表与内部函数一个都不外露", async () => {
  const host = makeHost({ names: NAMES });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy: policyOf(policyDir) });
  await gate.attach(host.agent);
  const keys = Object.keys(gate).sort();
  assert.deepEqual(keys, [...ANY].sort(), "公开成员变了：" + JSON.stringify(keys));
  for (const gone of ["entries", "status", "tierMap", "visibleOf", "planFor"]) {
    assert.equal(gate[gone], undefined, "gate." + gone + " 不该再出现");
  }
  await gate.releaseAll();
});

await check("attach 只给就绪承诺，不把内部条目交出去", async () => {
  const host = makeHost({ names: NAMES });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy: policyOf(policyDir) });
  const ready = gate.attach(host.agent);
  assert.equal(typeof ready.then, "function", "attach 必须返回 thenable");
  const value = await ready;
  assert.equal(value, undefined, "attach 决议值不许是内部条目（会诱使调用方读它的字段）");
  await gate.release(host.agent);
});

await check("listAgents 按最近活过排序，并回报 id 与 touchedAt", async () => {
  const host = makeHost({ names: NAMES, id: "session-a" });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy: policyOf(policyDir) });
  const a = host.agent;
  const b = host.addAgent({ id: "session-b" });
  await gate.attach(a);
  await gate.attach(b);
  // 让 a 之后再活一次：它应当排到最前。
  gate.reapply(a);
  const rows = gate.listAgents();
  assert.deepEqual(rows.map((row) => row.id), ["session-a", "session-b"], "最近活过的必须排最前");
  for (const row of rows) {
    assert.equal(typeof row.touchedAt, "number", row.id + " 缺 touchedAt");
    assert.ok(row.agent, row.id + " 缺 agent 句柄（HTTP 层要用它出快照）");
  }
  await gate.releaseAll();
});

await check("内部条目里的字段不再被外部模块读到", async () => {
  // 外部模块只该通过能力成员与快照交互：出现 entry.xxx / .entries 就是越界。
  const outside = ["lib/server.js", "lib/proxy.js", "lib/index.js", "lib/sections.js", "lib/prestep.js"];
  for (const rel of outside) {
    const source = read(rel);
    assert.equal(/gate\.entries\b/.test(source), false, rel + " 还在摸内部条目表");
    assert.equal(/gate\.status\(/.test(source), false, rel + " 还在调内部 status()");
    assert.equal(/gate\.tierMap\(|gate\.planFor\(|gate\.visibleOf\(/.test(source), false, rel + " 还在调内部函数");
    assert.equal(/\.restriction\.state\(/.test(source), false, rel + " 还在直接读限制对象");
  }
  // server 挑会话必须走 listAgents，不许自己遍历。
  const server = read("lib/server.js");
  assert.ok(server.includes("gate.listAgents("), "server.js 必须用公开的 agent 清单挑会话");
  assert.equal(/touchedAt\)/.test(server), false, "server.js 不该自己比较 touchedAt");
});

await check("闸门工具只从 gate 的公开面取字段（检索口带 description，不再拼名字数组）", async () => {
  const proxy = read("lib/proxy.js");
  assert.ok(proxy.includes("pickStatus(gate.snapshot("), "gate_status 必须从快照投影");
  // 0.2.0 缺陷批修 I5-1：候选池从 gate.searchEntries 取（带 description），
  // 不再从快照的 residentNames/onDemandNames/offNames 三个名字数组拼池。
  assert.ok(proxy.includes("gate.searchEntries(exec.agent)"), "gate_search 必须走 gate 的只读检索口");
  assert.equal(/state\.skillEntries/.test(proxy), false, "gate_search 不该再从快照的 skillEntries 拼池");
  assert.equal(/entry\s*&&\s*Array\.isArray\(entry\.skills\)/.test(proxy), false, "gate_search 不该再读 entry.skills");
});

await check("gate_search：工具结果带真实描述首句，未知词返回空", async () => {
  const host = makeHost({ names: NAMES });
  const policy = policyOf(policyDir);
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  registerGateTools({ ctx: host.rootCtx, gate, policy });
  await gate.attach(host.agent);
  gate.rememberSkills(host.agent, [{ name: "office-xlsx", description: "技能目录里的说明。第二句不该出现。", provider: "office" }]);
  const search = host.tool("gate_search");
  const found = await search.execute({ query: "univer_doc" }, { agent: host.agent, signal: undefined });
  const hit = found.results.find((row) => row.name === "univer_doc");
  assert.ok(hit, "gate_search 找不到 univer_doc：" + JSON.stringify(found.results));
  assert.equal(hit.tier, "按需");
  assert.equal(hit.description, "univer_doc 工具的说明文字", "工具描述必须是 definition.description 的首句");
  const skillHit = (await search.execute({ query: "office-xlsx" }, { agent: host.agent, signal: undefined })).results
    .find((row) => row.name === "skill:office-xlsx");
  assert.ok(skillHit, "技能候选必须带 skill: 前缀");
  assert.equal(skillHit.tier, "技能");
  assert.equal(skillHit.description, "技能目录里的说明", "技能仍用 skillEntries.description 的首句");
  const empty = await search.execute({ query: "zzz_no_such_tool" }, { agent: host.agent, signal: undefined });
  assert.deepEqual(empty.results, [], "未知词不许兜底返回全部候选");
  await gate.release(host.agent);
});

await check("gate_status 的输出键集仍然只由 STATUS_KEYS 决定（缓存约束不变）", async () => {
  const host = makeHost({ names: NAMES });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy: policyOf(policyDir) });
  await gate.attach(host.agent);
  const projected = pickStatus(gate.snapshot(host.agent));
  assert.deepEqual(Object.keys(projected), STATUS_KEYS, "键集与顺序都必须与 STATUS_KEYS 逐字节一致");
  await gate.release(host.agent);
});

await check("restrictionState 把「被限制成什么样」作为只读事实交出来", async () => {
  const host = makeHost({ names: NAMES });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy: policyOf(policyDir) });
  await gate.attach(host.agent);
  const before = gate.restrictionState(host.agent);
  assert.equal(before.mode, "limited", "主会话应处于 limited");
  assert.ok(before.count > 0);
  // 没挂过的 agent 不该抛，也不该凭空造状态。
  const stranger = gate.restrictionState({ id: "nobody" });
  assert.equal(stranger.mode, "none");
  assert.equal(stranger.count, 0);
  await gate.release(host.agent);
});

await check("仓内只有一处 view / restrict 适配（宿主 seam 唯一）", async () => {
  // 票 01 的验收：不许再长出第二份假宿主。四个特征同时出现在一个文件里才算一份适配。
  const adapters = fs.readdirSync(here)
    .filter((file) => file.endsWith(".mjs") && file !== "host.mjs")
    .filter((file) => {
      const source = fs.readFileSync(path.join(here, file), "utf8");
      return /restrictableNames\s*:/.test(source) && /knownNames\s*:/.test(source);
    });
  assert.deepEqual(adapters, [], "这些文件自己实现了宿主适配：" + JSON.stringify(adapters));
  const host = read("test/host.mjs");
  assert.ok(host.includes("export function makeHost"), "共享宿主必须导出 makeHost");
});

const failed = results.filter((row) => !row.ok);
for (const row of results) console.log((row.ok ? "  ok    " : "  FAIL  ") + row.label + (row.ok ? "" : "  →  " + row.error));
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exitCode = failed.length === 0 ? 0 : 1;