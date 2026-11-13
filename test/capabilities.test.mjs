/**
 * 能力模型 + 解析链用例（0.2.0 工单 04）。
 *
 * 盯的是「一个开关」这件事到底有没有做到：
 *  1) 来源推断（mcp / native / plugin / unknown）与显式 sources 覆盖；
 *  2) 解析链每一层的 reason 可判读（own / preset / protected / unknown / exception / capability / defaults）；
 *  3) 例外只允许显式设置，读回带 deviation；
 *  4) 一个能力档变化**同时**作用于 tools 与 sections 两条限制（原子）；
 *  5) gate_status 键集不变，能力视图走单独查询；
 *  6) 上游已隐藏先减掉，闸门不许把它重新放出来。
 *
 * 宿主来自共享 seam（test/host.mjs）。跑法：node test/capabilities.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGate, pickStatus, STATUS_KEYS } from "../lib/gate.js";
import { normalizeV3Policy } from "../lib/migrate.js";
import { resolvePolicy, TIER_OFF, TIER_ONDEMAND, TIER_RESIDENT } from "../lib/policy.js";
import {
  capabilityIdOfSectionName,
  capabilityIdOfSkill,
  capabilityIdOfToolName,
  capabilityOfSection,
  capabilityOfSkill,
  capabilityOfTool,
  capabilityState,
  resolveSectionDecision,
  resolveSkillDecision,
  resolveToolDecision,
  withCapabilityTier,
  withMemberException,
} from "../lib/capabilities.js";
import { makeHost } from "./host.mjs";

const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-capabilities-"));
let passed = 0;
const ok = (label) => { passed += 1; console.log("  ok    " + label); };

const basePolicy = () => resolvePolicy({
  version: 3,
  defaults: { capability: TIER_ONDEMAND, section: TIER_RESIDENT, skillpack: TIER_ONDEMAND },
  capabilities: {
    "mcp:wincu": { tier: TIER_ONDEMAND, toolExceptions: { "mcp__wincu__read": TIER_RESIDENT } },
    "mcp:ctx": { tier: TIER_ONDEMAND, toolExceptions: { "mcp__ctx__sync": TIER_OFF } },
    "mcp:same": { tier: TIER_ONDEMAND, toolExceptions: { "mcp__same__x": TIER_ONDEMAND } },
    "native:read": { tier: TIER_RESIDENT },
    "plugin:dsh-univer-office": { tier: TIER_RESIDENT },
  },
  sources: {},
  legacy: { unknownOverrides: { ws_mcp_call: 1 } },
}, { dshHome: policyDir, backup: false });

// ── 1. 来源推断 ───────────────────────────────────────────────────────────────
{
  assert.equal(capabilityIdOfToolName("mcp__wincu__fs_read"), "mcp:wincu", "mcp__<server>__* → mcp:<server>");
  assert.equal(capabilityIdOfToolName("mcp__wincu"), "mcp:wincu", "只有 server 名也认得");
  assert.equal(capabilityIdOfToolName("mcp__*"), "mcp:*", "通配 server 就是 mcp:*");
  assert.equal(capabilityIdOfToolName("read"), "native:read", "原生工具单工具成能力");
  assert.equal(capabilityIdOfToolName("univer_sheet"), "plugin:dsh-univer-office", "已知包前缀推断成插件能力");
  assert.equal(capabilityIdOfToolName("ssh_exec"), "plugin:@linxin666/dsh-ssh", "带 scope 的包名也对");
  assert.equal(capabilityIdOfToolName("brand_new_tool"), "tool:brand_new_tool", "推不出来 → tool:<name>（unknown）");
  assert.equal(capabilityIdOfToolName("web_*"), "glob:web_*", "无命名空间的通配键按名字匹配");
  assert.equal(capabilityIdOfSectionName("mcp:wincu"), "mcp:wincu", "段落只有 mcp:<server> 有命名约定");
  assert.equal(capabilityIdOfSectionName("free-search:engines"), "section:free-search:engines", "其余段落不猜归属");
  assert.equal(capabilityIdOfSectionName("free-*"), "glob:free-*");
  ok("能力 id 推断：mcp / native / 已知包前缀 / 未归属 / 段落都按文档规则");
}

// ── 2. 显式 sources 压过命名推断 ──────────────────────────────────────────────
{
  const policy = resolvePolicy({
    version: 3,
    defaults: { capability: 2, section: 1, skillpack: 2 },
    capabilities: {},
    sources: { "plugin:custom": { tools: ["univer_sheet", "x_*"], sections: ["free-search:engines"] } },
  }, { dshHome: policyDir, backup: false });
  const explicit = capabilityOfTool(policy, "univer_sheet");
  assert.equal(explicit.id, "plugin:custom", "显式 sources 压过包前缀推断");
  assert.equal(explicit.confidence, "medium", "显式映射是 medium（比前缀推断高）");
  assert.equal(explicit.via, "sources");
  assert.equal(capabilityOfTool(policy, "x_any").id, "plugin:custom", "sources 的成员名支持通配");
  assert.equal(capabilityOfTool(policy, "read").id, "native:read", "没被 sources 点名的仍走命名推断");
  assert.equal(capabilityOfTool(policy, "read").confidence, "medium");
  assert.equal(capabilityOfTool(policy, "mcp__wincu__x").confidence, "high", "MCP 命名是 high");
  assert.equal(capabilityOfTool(policy, "brand_new_tool").confidence, "unknown");
  assert.equal(capabilityOfSection(policy, "free-search:engines").id, "plugin:custom", "段落也认显式 sources");
  assert.equal(capabilityOfSection(policy, "mcp:wincu").confidence, "high");
  ok("显式 sources 优先于命名推断；置信度按来源分级（high / medium / low / unknown）");
}

// ── 3. 解析链每一层都留 reason ────────────────────────────────────────────────
{
  const policy = basePolicy();
  assert.equal(resolveToolDecision(policy, "anything", { own: true }).reason, "own");
  assert.equal(resolveToolDecision(policy, "anything", { own: true }).bucket, "own");
  assert.equal(resolveToolDecision(policy, "brand_new_tool", { loaded: true }).reason, "loaded");
  const preset = resolveToolDecision(policy, "office_docx", { globallyVisible: false });
  assert.equal(preset.reason, "preset");
  assert.equal(preset.tier, TIER_RESIDENT, "preset 平面默认不受管");
  // 被能力策略点名的 preset 工具就该受管，不再走 preset 豁免。
  assert.equal(resolveToolDecision(policy, "mcp__wincu__fs_read", { globallyVisible: false }).reason, "capability");
  assert.equal(resolveToolDecision(policy, "run_code", { globallyVisible: true }).reason, "protected");
  const unknown = resolveToolDecision(policy, "brand_new_tool", { globallyVisible: true });
  assert.equal(unknown.reason, "unknown");
  assert.equal(unknown.tier, TIER_RESIDENT, "unknown 只标注、不隐藏");
  assert.equal(unknown.confidence, "unknown");
  const exception = resolveToolDecision(policy, "mcp__wincu__read", { globallyVisible: true });
  assert.equal(exception.reason, "exception");
  assert.equal(exception.tier, TIER_RESIDENT);
  assert.equal(exception.deviation, true, "例外与能力档不同就是偏离");
  assert.equal(resolveToolDecision(policy, "mcp__same__x", { globallyVisible: true }).deviation, false, "例外恰好等于能力档时不算偏离");
  const deviated = resolveToolDecision(policy, "mcp__wincu__write", { globallyVisible: true });
  assert.equal(deviated.reason, "capability");
  const sync = resolveToolDecision(policy, "mcp__ctx__sync", { globallyVisible: true });
  assert.equal(sync.reason, "exception");
  assert.equal(sync.tier, TIER_OFF);
  assert.equal(sync.deviation, true, "例外与能力档不同必须标 deviation");
  assert.deepEqual(sync.exception, { pattern: "mcp__ctx__sync", tier: TIER_OFF }, "命中链要能读回例外条目");
  const fallback = resolveToolDecision(policy, "ssh_exec", { globallyVisible: true });
  assert.equal(fallback.reason, "defaults", "没出现的能力走 defaults");
  assert.equal(fallback.tier, TIER_ONDEMAND);
  assert.equal(fallback.confidence, "low", "包前缀推断是 low（UI 要能提示纠正）");
  // 段落：能力档 + sectionExceptions。
  const sectionException = resolveSectionDecision(policy, "mcp:wincu");
  assert.equal(sectionException.reason, "capability");
  assert.equal(sectionException.tier, TIER_ONDEMAND);
  assert.equal(resolveSectionDecision(policy, "HARNESS_IDENTITY").reason, "defaults");
  assert.equal(resolveSectionDecision(policy, "HARNESS_IDENTITY").tier, TIER_RESIDENT);
  ok("解析链 own → preset → protected → unknown → 例外 → 能力档 → defaults，每层都有 reason 与 deviation");
}

// ── 4. 例外只允许显式设置，写回读仍是同一个判定 ──────────────────────────────
{
  const policy = basePolicy();
  const withException = withMemberException(policy, "mcp:wincu", "tool", "mcp__wincu__write", TIER_OFF);
  assert.equal(withException.capabilities["mcp:wincu"].tier, TIER_ONDEMAND, "设例外不许动能力档");
  assert.equal(withException.capabilities["mcp:wincu"].toolExceptions["mcp__wincu__write"], TIER_OFF);
  // 读回（序列化 → 规范化）仍能判定这是偏离。
  const roundTrip = normalizeV3Policy(JSON.parse(JSON.stringify(withException))).policy;
  const decision = resolveToolDecision(roundTrip, "mcp__wincu__write", { globallyVisible: true });
  assert.equal(decision.reason, "exception");
  assert.equal(decision.deviation, true);
  assert.deepEqual(decision.exception, { pattern: "mcp__wincu__write", tier: TIER_OFF });
  // 切能力档：所有没设例外的成员一起变，例会保留。
  const switched = withCapabilityTier(withException, "mcp:wincu", TIER_RESIDENT);
  assert.equal(resolveToolDecision(switched, "mcp__wincu__other", { globallyVisible: true }).tier, TIER_RESIDENT);
  assert.equal(resolveToolDecision(switched, "mcp__wincu__write", { globallyVisible: true }).tier, TIER_OFF, "例外必须压过能力档");
  ok("例外只能显式设置、写回可判定 deviation；切能力档时例外保持原样");
}

// ── 5. 一个能力档 = 两条限制同源（原子） ──────────────────────────────────────
{
  const host = makeHost({ names: ["read", "univer_sheet", "mcp__wincu__fs_read"], id: "cap-agent" });
  const policy = basePolicy();
  policy.capabilities["mcp:wincu"].tier = TIER_ONDEMAND;
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  await gate.attach(host.agent);
  gate.recordSections(host.agent, [{ name: "mcp:wincu", chars: 100, tokens: 30 }]);

  assert.equal(host.visibleOf(host.agent).has("mcp__wincu__fs_read"), false, "能力档=按需：工具被藏");
  assert.equal(gate.planSections(host.agent).shouldDrop("mcp:wincu"), true, "同一个能力档：段落被摘");
  assert.equal(gate.capabilityView(host.agent).capabilities.find((row) => row.id === "mcp:wincu").tier, TIER_ONDEMAND);

  // 只改能力档（没有 tools/sections 表可改）→ 两条限制同时回到常驻。
  policy.capabilities["mcp:wincu"].tier = TIER_RESIDENT;
  gate.reapply(host.agent);
  assert.equal(host.visibleOf(host.agent).has("mcp__wincu__fs_read"), true, "能力档恢复：工具回来");
  assert.equal(gate.planSections(host.agent).shouldDrop("mcp:wincu"), false, "能力档恢复：段落也回来");

  // 段落例外只动段落，不动同能力的工具。
  policy.capabilities["mcp:wincu"].sectionExceptions = { "mcp:wincu": TIER_ONDEMAND };
  gate.reapply(host.agent);
  assert.equal(host.visibleOf(host.agent).has("mcp__wincu__fs_read"), true, "段落例外不该顺手把工具也藏了");
  assert.equal(gate.planSections(host.agent).shouldDrop("mcp:wincu"), true);
  const section = gate.capabilityView(host.agent).sections.find((row) => row.name === "mcp:wincu");
  assert.equal(section.deviation, true, "段落例外读回必须标偏离");
  await gate.release(host.agent);
  ok("一个能力档变化同时驱动 tools 与 sections；段落例外只影响段落，且读回标 deviation");
}

// ── 6. gate_status 字节稳定，能力数据走单独查询 ───────────────────────────────
{
  const host = makeHost({ names: ["read", "univer_sheet", "mcp__wincu__fs_read", "brand_new_tool"], id: "cap-status" });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy: basePolicy() });
  await gate.attach(host.agent);
  gate.recordSections(host.agent, [{ name: "mcp:wincu", chars: 10, tokens: 3 }]);
  gate.reapply(host.agent);

  const status = pickStatus(gate.snapshot(host.agent));
  assert.deepEqual(Object.keys(status), STATUS_KEYS, "gate_status 的键集与顺序不许变（前缀缓存约束）");
  const snapshot = gate.snapshot(host.agent);
  assert.ok(Array.isArray(snapshot.upstreamHidden), "快照带 upstreamHidden（不在 STATUS_KEYS 里）");
  assert.equal(snapshot.policyVersion, 3);
  assert.ok(Array.isArray(snapshot.warnings));

  const view = gate.capabilityView(host.agent);
  assert.equal(view.version, 3);
  const row = view.capabilities.find((entry) => entry.id === "mcp:wincu");
  assert.ok(row, "能力视图要有 mcp:wincu 一行");
  assert.equal(row.configured, true);
  assert.deepEqual(row.tools, ["mcp__wincu__fs_read"], "能力行要带自己的工具成员");
  assert.deepEqual(row.sections, ["mcp:wincu"], "能力行要带自己的段落成员");
  assert.deepEqual(row.toolExceptions, { "mcp__wincu__read": TIER_RESIDENT });
  const tool = view.tools.find((entry) => entry.name === "mcp__wincu__fs_read");
  assert.equal(tool.capability, "mcp:wincu");
  assert.equal(tool.confidence, "high");
  assert.equal(tool.via, "naming");
  assert.equal(tool.reason, "capability");
  const unknownTool = view.tools.find((entry) => entry.name === "brand_new_tool");
  assert.equal(unknownTool.confidence, "unknown");
  assert.equal(unknownTool.tier, TIER_RESIDENT, "unknown 工具在视图里也能看出「没被隐藏」");
  assert.equal(view.legacy.unknownOverrides.ws_mcp_call, 1, "legacy 只在能力视图里出现");
  await gate.release(host.agent);
  ok("gate_status 键集逐字节不变；能力/来源/例外/legacy 走 capabilityView 单独查询");
}

// ── 7. 上游已隐藏先减掉：闸门不许把它重新放出来 ──────────────────────────────
{
  const host = makeHost({ names: ["read", "univer_doc", "univer_sheet", "mcp__wincu__fs_read"], id: "cap-upstream" });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy: basePolicy() });
  await gate.attach(host.agent);
  // 模拟上游（别的插件）把 univer_doc 藏掉：宿主里的另一条 restriction。
  const lift = host.agent.ctx.tools.restrict({ deny: ["univer_doc"] });
  gate.reapply(host.agent);

  const snapshot = gate.snapshot(host.agent);
  assert.ok(snapshot.upstreamHidden.includes("univer_doc"), "upstreamHidden=" + JSON.stringify(snapshot.upstreamHidden));
  assert.ok(!snapshot.residentNames.includes("univer_doc"), "上游隐藏的名字不许再出现在常驻清单里");
  assert.ok(!snapshot.onDemandNames.includes("univer_doc"));
  assert.ok(!gate.capabilityView(host.agent).tools.some((entry) => entry.name === "univer_doc"), "上游隐藏的名字不进能力视图的成员表");
  const loaded = await gate.load(host.agent, ["univer_doc"]);
  assert.deepEqual(loaded.unknown, ["univer_doc"], "上游隐藏的工具不可加载（否则永远 UNKNOWN_TOOL）");
  // 上游遮的是 univer_doc，同插件的 univer_sheet 不受影响。
  assert.equal(host.visibleOf(host.agent).has("univer_sheet"), true);
  lift();
  gate.reapply(host.agent);
  assert.deepEqual(gate.snapshot(host.agent).upstreamHidden, [], "上游撤销后不再标记");
  assert.ok(gate.snapshot(host.agent).residentNames.includes("univer_doc"), "上游撤销后工具回到常驻");
  await gate.release(host.agent);
  ok("上游隐藏（known−visible−自己 deny）先减掉：只标注不放出，也不算进自己的 deny");
}

// ── 8. 原生工具清单补齐：团队 / 专家 / 闸门工具不再落 tool:unknown ─────────────
{
  const names = [
    "spawn_teammate", "wait_agent",
    "team_task_create", "team_task_get", "team_task_list", "team_task_update",
    "list_experts", "summon_expert", "summon_experts", "summon_expert_team",
    "propose_custom_expert", "propose_expert_team",
    "open_custom_expert_editor", "open_expert_team_editor",
    "get_expert_team", "list_expert_teams",
    "gate_status", "gate_load", "gate_search", "gate_invoke", "gate_call",
  ];
  for (const name of names) {
    assert.equal(capabilityIdOfToolName(name), "native:" + name, name + " 的来源必须是 native");
    const decision = resolveToolDecision(basePolicy(), name, { globallyVisible: true });
    assert.equal(decision.capability, "native:" + name, name + " 的能力 id 错了");
    assert.notEqual(decision.capability, "tool:unknown", name + " 不许落 unknown");
    assert.equal(decision.confidence, "medium", name + " 的来源置信度应为 native 级");
  }
  ok("原生清单补齐：团队 / 专家 / 闸门工具的能力 id 是 native:<name>，不是 tool:<name>");
}

// ── 9. 原生来源在能力视图里也读得出来（行 provenance） ────────────────────────
{
  const names = ["spawn_teammate", "list_experts", "gate_status", "gate_load", "gate_search", "gate_call"];
  const view = capabilityState(basePolicy(), { tools: names.map((name) => ({ name })) });
  for (const name of names) {
    const tool = view.tools.find((entry) => entry.name === name);
    assert.equal(tool.capability, "native:" + name);
    assert.equal(tool.confidence, "medium");
  }
  const statusRow = view.capabilities.find((row) => row.id === "native:gate_status");
  assert.ok(statusRow, "能力视图里应有 native:gate_status 一行");
  assert.deepEqual(statusRow.tools, ["gate_status"]);
  assert.equal(statusRow.provenance.source, "native", "闸门工具这一行的来源必须是 native");
  assert.equal(statusRow.provenance.confidence, "high");
  ok("能力视图：原生工具落 native:<name> 行，行 provenance 读作 native（不是 unknown）");
}

// ── 10. 技能包：provider 聚合 + defaults.skillpack 生效 ───────────────────────
{
  const policy = resolvePolicy({
    version: 3,
    defaults: { capability: TIER_ONDEMAND, section: TIER_RESIDENT, skillpack: TIER_ONDEMAND },
    capabilities: {
      "skillpack:alpha": { tier: TIER_OFF },
      "skillpack:beta": { tier: TIER_ONDEMAND },
    },
    sources: {},
  }, { dshHome: policyDir, backup: false });
  assert.equal(capabilityIdOfSkill("alpha"), "skillpack:alpha");
  assert.equal(capabilityIdOfSkill(undefined), "skillpack:unknown", "没有 provider 仍聚到 unknown，不丢成员");
  assert.equal(capabilityOfSkill("alpha").confidence, "high");
  assert.equal(capabilityOfSkill(undefined).confidence, "unknown");
  assert.equal(resolveSkillDecision(policy, { name: "x", provider: "gamma" }).reason, "defaults");
  assert.equal(resolveSkillDecision(policy, { name: "x", provider: "gamma" }).tier, TIER_ONDEMAND, "未配置 pack 走 defaults.skillpack");
  assert.equal(resolveSkillDecision(policy, { name: "x", provider: "alpha" }).tier, TIER_OFF, "能力条目压过 defaults");
  assert.equal(resolveSkillDecision(policy, { name: "x", provider: "alpha" }).reason, "capability");

  const view = capabilityState(policy, {
    skills: [
      { name: "alpha-one", provider: "alpha" },
      { name: "alpha-two", provider: "alpha" },
      { name: "beta-one", provider: "beta" },
      { name: "no-provider" },
    ],
  });
  const alpha = view.capabilities.find((row) => row.id === "skillpack:alpha");
  assert.ok(alpha, "必须生成 skillpack:alpha 行");
  assert.equal(alpha.configured, true);
  assert.equal(alpha.tier, TIER_OFF);
  assert.deepEqual(alpha.skills, ["alpha-one", "alpha-two"], "同 provider 的技能聚合进行成员表");
  assert.equal(alpha.provenance.source, "skillpack");
  assert.equal(alpha.provenance.confidence, "high");
  const unknown = view.capabilities.find((row) => row.id === "skillpack:unknown");
  assert.ok(unknown, "没有 provider 的技能聚到 skillpack:unknown 一行");
  assert.equal(unknown.configured, false);
  assert.deepEqual(unknown.skills, ["no-provider"]);
  // 行本身没有配置条目时 tier=null；成员的有效档位在 view.skills 里读。
  const unknownMember = view.skills.find((entry) => entry.name === "no-provider");
  assert.equal(unknownMember.tier, TIER_ONDEMAND, "unknown pack 也走 defaults.skillpack（只标注，不隐藏）");
  assert.equal(unknownMember.reason, "defaults");
  assert.deepEqual(view.skills.map((entry) => entry.name), ["alpha-one", "alpha-two", "beta-one", "no-provider"], "顶部技能列表按名字排序");

  // defaults.skillpack 是技能轴的唯一真源：改成 0，未配置的 pack 一起关闭。
  const defaultsPolicy = resolvePolicy({
    version: 3,
    defaults: { capability: TIER_ONDEMAND, section: TIER_RESIDENT, skillpack: TIER_OFF },
    capabilities: {},
  }, { dshHome: policyDir, backup: false });
  assert.equal(resolveSkillDecision(defaultsPolicy, { name: "x", provider: "alpha" }).tier, TIER_OFF, "defaults.skillpack=0 必须生效");
  ok("技能包按 provider 聚合成 skillpack:<provider> 行；无 provider 聚 unknown；defaults.skillpack 生效");
}

// ── 11. gate 快照带技能 provider；能力视图有对应 skillpack 行与成员 ───────────
{
  const host = makeHost({ names: ["read"], id: "cap-skillpack" });
  const policy = basePolicy();
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  await gate.attach(host.agent);
  gate.rememberSkills(host.agent, [
    { name: "alpha-one", provider: "alpha", description: "A" },
    { name: "beta-one", provider: "beta", description: "B" },
    { name: "no-provider", description: "N" },
  ]);
  const snapshot = gate.snapshot(host.agent);
  const alphaEntry = snapshot.skillEntries.find((entry) => entry.name === "alpha-one");
  assert.equal(alphaEntry.provider, "alpha", "快照 skillEntries 必须带 provider");
  assert.equal(alphaEntry.description, "A");

  const view = gate.capabilityView(host.agent);
  const alphaRow = view.capabilities.find((row) => row.id === "skillpack:alpha");
  assert.ok(alphaRow, "能力视图必须有 skillpack:alpha 行");
  assert.deepEqual(alphaRow.skills, ["alpha-one"]);
  assert.equal(alphaRow.configured, false);
  assert.equal(view.skills.find((entry) => entry.name === "alpha-one").tier, TIER_ONDEMAND, "成员有效档位走 defaults.skillpack");
  const unknownRow = view.capabilities.find((row) => row.id === "skillpack:unknown");
  assert.ok(unknownRow);
  assert.deepEqual(unknownRow.skills, ["no-provider"]);
  assert.deepEqual(view.skills.map((entry) => entry.name), ["alpha-one", "beta-one", "no-provider"]);

  // defaults.skillpack 改了，能力视图立刻跟着变（同一个 policy 引用）。
  policy.defaults.skillpack = TIER_OFF;
  gate.reapply(host.agent);
  const after = gate.capabilityView(host.agent);
  assert.ok(after.capabilities.some((row) => row.id === "skillpack:alpha"));
  assert.equal(after.skills.find((entry) => entry.name === "alpha-one").tier, TIER_OFF, "defaults.skillpack 改后成员档位立即生效");
  await gate.release(host.agent);
  ok("gate 技能 provider 进快照；能力视图生成 skillpack 行与成员，defaults.skillpack 生效");
}

console.log("\n全部通过 (" + passed + ")");
