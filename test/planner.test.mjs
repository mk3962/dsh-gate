/**
 * D7：一次产出不可变计划，下游七个派生点只读它。
 * 计划里的每个桶 / 层值 / 段落目录 / 技能集合都必须与决策记录同源。
 */
import assert from "node:assert/strict";
import { REASONS, decideSection, decideSkill, decideTool } from "../lib/decide.js";
import { TIER_OFF, TIER_ONDEMAND, TIER_RESIDENT } from "../lib/tiers.js";
import { buildPlan, planStamp, sectionDecisionOf, toolTierOf } from "../lib/planner.js";

const results = [];
const check = (label, fn) => {
  try { fn(); results.push({ ok: true, label }); }
  catch (error) { results.push({ ok: false, label, error }); }
};

function toolRow(name, tier, extra) {
  const options = Object.assign({ name, tier }, extra || {});
  return { name, description: name + " 的说明", own: options.own === true, decision: decideTool(options) };
}

check("计划整体冻结：顶层、桶数组、层值表、决策表都不可改", () => {
  const plan = buildPlan({ tools: [toolRow("read", TIER_RESIDENT)], sections: [], skills: [] });
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.tools));
  assert.ok(Object.isFrozen(plan.tools.resident));
  assert.ok(Object.isFrozen(plan.tiers));
  assert.ok(Object.isFrozen(plan.sections));
  assert.ok(Object.isFrozen(plan.skillsPlan));
  assert.ok(Object.isFrozen(plan.warnings));
  assert.throws(() => { plan.tiers.read = TIER_OFF; }, TypeError, "层值表冻结");
  assert.throws(() => { plan.tools.resident.push("x"); }, TypeError, "桶数组冻结");
});

check("工具三桶与层值同源：常驻 / 按需（进 deny）/ 关闭（进 deny）", () => {
  const plan = buildPlan({
    tools: [
      toolRow("read", TIER_RESIDENT, { own: true }),
      toolRow("pwsh", TIER_RESIDENT),
      toolRow("web_search", TIER_ONDEMAND),
      toolRow("univer_sheet", TIER_OFF),
    ],
  });
  assert.deepEqual(plan.resident, ["read", "pwsh"]);
  assert.deepEqual(plan.ondemand.map((row) => row.name), ["web_search"]);
  assert.deepEqual(plan.off, ["univer_sheet"]);
  assert.deepEqual(plan.deny.slice().sort(), ["univer_sheet", "web_search"]);
  assert.equal(plan.tiers.read, TIER_RESIDENT);
  assert.equal(plan.tiers.web_search, TIER_ONDEMAND);
  assert.equal(plan.tiers.univer_sheet, TIER_OFF);
  assert.deepEqual(plan.tools.tiers, plan.tiers, "工具子表与顶层层值一致");
  assert.deepEqual(plan.tools.off, plan.off);
  assert.equal(plan.tools.decisions.univer_sheet.removed, true);
});

check("preset 身份与层值分离：常驻但单独标出，不混进普通常驻", () => {
  const presetDecision = decideTool({ name: "web_search", tier: TIER_RESIDENT, reason: REASONS.PRESET });
  const plan = buildPlan({
    tools: [
      { name: "web_search", decision: presetDecision },
      toolRow("read", TIER_RESIDENT),
    ],
  });
  assert.deepEqual([...plan.preset], ["web_search"]);
  assert.deepEqual(plan.resident, ["web_search", "read"], "preset 也是常驻，声明位置不变");
  assert.ok(plan.deny.includes("web_search") === false);
});

check("takenOver 强制关闭：归层表、桶、deny 三处必须一致", () => {
  const plan = buildPlan({
    takenOver: ["skill"],
    tools: [toolRow("skill", TIER_RESIDENT), toolRow("read", TIER_RESIDENT)],
  });
  assert.equal(plan.tiers.skill, TIER_OFF);
  assert.deepEqual(plan.off, ["skill"]);
  assert.ok(plan.deny.includes("skill"));
  assert.ok(plan.resident.includes("skill") === false);
  assert.deepEqual(plan.takenOver, ["skill"]);
});

check("段落：保留 / 摘除进目录 / 摘除不进目录 / 受保护集 / 正文映射", () => {
  const sections = [
    { name: "pwsh-notes", summary: "被关掉" },
    { name: "free-search", summary: "可加载" },
    { name: "mcp:wincu", summary: "受保护" },
    { name: "univer-guide", summary: "默认保留" },
  ];
  const sectionDecisions = {
    "pwsh-notes": decideSection({ name: "pwsh-notes", tier: TIER_OFF }),
    "free-search": decideSection({ name: "free-search", tier: TIER_ONDEMAND }),
    "mcp:wincu": decideSection({ name: "mcp:wincu", tier: TIER_RESIDENT, protected: true }),
  };
  const plan = buildPlan({ sections, sectionDecisions });
  assert.deepEqual(plan.sections.keep, ["mcp:wincu"]);
  assert.deepEqual(plan.sections.removed, ["pwsh-notes", "free-search", "univer-guide"], "没给定决策的段落走默认按需：摘除并进目录");
  assert.deepEqual(plan.sections.catalog, [
    { name: "pwsh-notes", summary: "被关掉" },
    { name: "free-search", summary: "可加载" },
    { name: "univer-guide", summary: "默认保留" },
  ], "关闭段落也留在目录里（可见但不可加载），受保护段落不进目录");
  assert.deepEqual(plan.sections.protected, ["mcp:wincu"]);
  assert.equal(plan.sections.tiers["pwsh-notes"], TIER_OFF);
  assert.equal(sectionDecisionOf(plan, "free-search").loadable, true);
  assert.equal(sectionDecisionOf(plan, "pwsh-notes").loadable, false);
  assert.equal(sectionDecisionOf(plan, "nope"), undefined);
  assert.ok(plan.sectionBodies instanceof Map);
});

check("收窄豁免：段落一条都不摘，deny 由调用方给（这里给空）", () => {
  const plan = buildPlan({
    passthrough: true,
    sections: [{ name: "pwsh-notes" }],
    sectionDecisions: { "pwsh-notes": decideSection({ name: "pwsh-notes", tier: TIER_OFF }) },
    tools: [toolRow("read", TIER_RESIDENT)],
  });
  assert.equal(plan.passthrough, true);
  assert.deepEqual(plan.sections.keep, ["pwsh-notes"]);
  assert.deepEqual(plan.sections.removed, []);
  assert.deepEqual(plan.sections.catalog, []);
});

check("技能计划：常驻 / 目录 / 可检索 / 关闭 / 不可调用五集合互不越界", () => {
  const plan = buildPlan({
    skills: [
      { name: "office", tier: TIER_ONDEMAND, modelInvocable: true },
      { name: "quiet", tier: TIER_ONDEMAND, modelInvocable: false },
      { name: "closed", tier: TIER_OFF },
      { name: "shadow", tier: TIER_ONDEMAND, shadowed: true },
      { name: "core", tier: TIER_RESIDENT },
    ],
  });
  assert.deepEqual(plan.skillsPlan.searchable, ["office", "core"], "常驻技能同样可检索；被覆盖的同名技能不可检索");
  assert.deepEqual(plan.skillsPlan.catalog, ["office"], "只有按需技能进目录检索列表，常驻技能不进");
  assert.deepEqual(plan.skillsPlan.notInvocable, ["quiet"]);
  assert.deepEqual(plan.skillsPlan.off, ["closed", "shadow"]);
  assert.deepEqual(plan.skillsPlan.resident, ["core"]);
  assert.equal(plan.skillsPlan.tiers.core, TIER_RESIDENT);
  assert.equal(decideSkill({ name: "quiet", tier: TIER_ONDEMAND, modelInvocable: false }).loadable, false);
});

check("工具层值查询与 planStamp：同输入同指纹，集合/映射顺序无关", () => {
  const plan = buildPlan({ tools: [toolRow("read", TIER_RESIDENT)] });
  assert.equal(toolTierOf(plan, "read"), TIER_RESIDENT);
  assert.equal(toolTierOf(plan, "missing"), undefined);
  assert.equal(planStamp(["a", 3, true]), planStamp(["a", 3, true]));
  assert.equal(planStamp([new Set(["b", "a"])]), planStamp([new Set(["a", "b"])]), "集合顺序无关");
  assert.equal(planStamp([new Map([["b", 1], ["a", 2]])]), planStamp([new Map([["a", 2], ["b", 1]])]), "映射键顺序无关");
  assert.notEqual(planStamp(["a", 3]), planStamp(["a", 4]));
});

check("空输入也给出完整形状：不抛错，空桶", () => {
  const plan = buildPlan(undefined);
  assert.deepEqual(plan.resident, []);
  assert.deepEqual(plan.ondemand, []);
  assert.deepEqual(plan.off, []);
  assert.deepEqual(plan.deny, []);
  assert.deepEqual(plan.sections.removed, []);
  assert.deepEqual(plan.skillsPlan.off, []);
  assert.equal(plan.frozen, false);
  assert.equal(plan.passthrough, false);
});

console.log("");
for (const row of results) {
  if (row.ok) console.log("  ok    " + row.label);
  else { console.log("  FAIL  " + row.label + "  →  " + (row.error && row.error.message ? row.error.message : row.error)); process.exitCode = 1; }
}
const failed = results.filter((row) => row.ok === false).length;
console.log("");
console.log((results.length - failed) + "/" + results.length + " passed");
