/**
 * 上游兼容层 + 来源标注用例（0.2.0 工单 08 / I4）。
 *
 * 盯的三件事：
 *  1) 「谁被上游藏」只判一次：known − visible − own − 自己 deny；own / 自己 deny 都不算上游藏。
 *  2) usable 只减不加：上游藏起来的不进候选集，也不进常驻/按需清单，更不能被 gate_load 拉起。
 *  3) 来源（provenance）按证据强度分级；段落只认 mcp:<server>，其余不猜、不摘；
 *     mcp 段落对应的工具全被上游藏了/一个都没注册时才摘，且摘掉的段落要进目录。
 *
 * 宿主来自共享 seam（test/host.mjs）。跑法：node test/upstream.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGate, pickStatus, STATUS_KEYS } from "../lib/gate.js";
import { resolvePolicy, TIER_ONDEMAND, TIER_RESIDENT } from "../lib/policy.js";
import {
  computeSurface,
  isSectionUpstreamHidden,
  provenanceOfSection,
  provenanceOfSkill,
  provenanceOfTool,
} from "../lib/upstream.js";
import { makeHost } from "./host.mjs";

const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-upstream-"));
let passed = 0;
const ok = (label) => { passed += 1; console.log("  ok    " + label); };

const policyOf = (options) => {
  const spec = options || {};
  return resolvePolicy({
    version: 3,
    defaults: {
      capability: spec.capability === undefined ? TIER_RESIDENT : spec.capability,
      section: spec.section === undefined ? TIER_RESIDENT : spec.section,
      skillpack: TIER_ONDEMAND,
    },
    capabilities: spec.capabilities || {},
    sources: {},
  }, { dshHome: policyDir, backup: false });
};

/** 一个 agent 的上游面：known / visible / own / 自己 deny 各就各位。 */
const surfaceFixture = () => computeSurface({
  knownNames: new Set([
    "read", "own_tool", "univer_sheet", "univer_doc", "mcp__wincu__fs_read", "web_search",
  ]),
  visible: new Set(["read", "own_tool", "univer_sheet", "mcp__wincu__fs_read"]),
  own: new Set(["own_tool"]),
  // 闸门自己 deny 的：在 known 里、不在 visible 里，但**不算**上游藏。
  ourDeny: new Set(["univer_doc"]),
  globallyVisible: new Set(["read", "univer_sheet", "global_only", "mcp__wincu__fs_read"]),
  skills: [{ name: "office", provider: "dsh-office-tools" }, { name: "mystery-skill" }],
  sections: [{ name: "mcp:wincu" }, { name: "free-search:engines" }],
});

// ── 1. known − visible − own − 自己 deny ──────────────────────────────────────
{
  const surface = surfaceFixture();
  assert.deepEqual(surface.upstreamHidden, ["web_search"], "只有 known 但 visible/own/ourDeny 都没有的才算上游藏");
  assert.ok(!surface.upstreamHidden.includes("univer_doc"), "闸门自己 deny 的不算上游藏");
  assert.ok(!surface.upstreamHidden.includes("own_tool"), "own 层不算上游藏");
  assert.ok(surface.usable.has("univer_doc"), "自己 deny 的名字仍在候选集里（可加载/可切档）");
  assert.ok(surface.usable.has("global_only"), "全局可见且没被上游藏的名字在候选集里");
  ok("upstreamHidden = known − visible − own − 自己 deny；own 与自己的 deny 都不算上游藏");
}

// ── 2. usable 只减不加 ────────────────────────────────────────────────────────
{
  const surface = computeSurface({
    knownNames: new Set(["gone", "read"]),
    visible: new Set(["read"]),
    own: new Set(),
    ourDeny: new Set(),
    globallyVisible: new Set(["read", "global_only"]),
  });
  assert.deepEqual(surface.upstreamHidden, ["gone"]);
  assert.equal(surface.usable.has("gone"), false, "上游藏起来的不许进候选集（否则目录会挂一个永远加载不了的名字）");
  assert.equal(surface.usable.has("read"), true);
  assert.equal(surface.usable.has("global_only"), true, "全局可见但没注册过的名字仍可管到（preset 没挂载时的兼容）");
  ok("usable 不含上游隐藏名，同时保留 known ∪ 全局可见");
}

// ── 3. provenance：工具按证据强度分级 ─────────────────────────────────────────
{
  const surface = computeSurface({
    knownNames: new Set(["read", "univer_sheet", "zzz_alpha", "zzz_beta", "mystery_tool", "mcp__wincu__fs_read", "own_tool", "office_docx"]),
    visible: new Set(["read", "univer_sheet", "zzz_alpha", "zzz_beta", "mystery_tool", "mcp__wincu__fs_read", "own_tool", "office_docx"]),
    own: new Set(["own_tool"]),
    globallyVisible: new Set(["read", "univer_sheet", "zzz_alpha", "zzz_beta", "mystery_tool", "mcp__wincu__fs_read"]),
  });
  const prov = surface.provenance;
  assert.deepEqual(prov.get("mcp__wincu__fs_read"), { source: "mcp:wincu", confidence: "high", via: "naming" }, "MCP 命名最高");
  assert.deepEqual(prov.get("own_tool"), { source: "native", confidence: "high", via: "own" }, "own 层 → native");
  assert.deepEqual(prov.get("office_docx"), { source: "native", confidence: "high", via: "preset" }, "全局不可见 → preset 平面 → native");
  assert.deepEqual(prov.get("read"), { source: "native", confidence: "high", via: "native" }, "dsh 原生清单 → native");
  assert.deepEqual(prov.get("univer_sheet"), { source: "plugin:dsh-univer-office", confidence: "medium", via: "prefix" }, "已知包前缀 → plugin:<包名> medium");
  assert.deepEqual(prov.get("zzz_alpha"), { source: "plugin:zzz", confidence: "low", via: "prefix" }, "同前缀聚成一组才敢标 plugin low");
  assert.deepEqual(prov.get("mystery_tool"), { source: "order", confidence: "low", via: "registration" }, "推不出来 → 注册顺序兜底");
  assert.deepEqual(provenanceOfTool("ghost_tool", {}), { source: "unknown", confidence: "unknown", via: "unknown" }, "连注册面都确认不了时就是 unknown，不拿顺序硬凑");
  // mcp 命名压过 own：即使它被 own 注册，名字本身就是更高证据。
  assert.equal(provenanceOfTool("mcp__wincu__x", { own: new Set(["mcp__wincu__x"]) }).source, "mcp:wincu");
  ok("工具来源优先级：mcp > own/preset > 原生清单 > 包前缀 > 注册顺序");
}

// ── 4. provenance：技能与段落 ──────────────────────────────────────────────────
{
  const surface = surfaceFixture();
  assert.deepEqual(surface.provenance.get("office"), { source: "skillpack", confidence: "high", via: "provider" }, "skills.list 的 provider 是技能的唯一高置信来源");
  assert.deepEqual(surface.provenance.get("mystery-skill"), { source: "unknown", confidence: "unknown", via: "unknown" }, "没有 provider 的技能只标 unknown");
  assert.deepEqual(provenanceOfSkill({ name: "x" }), { source: "unknown", confidence: "unknown", via: "unknown" });
  assert.deepEqual(surface.provenance.get("mcp:wincu"), { source: "mcp:wincu", confidence: "high", via: "naming" });
  assert.deepEqual(surface.provenance.get("free-search:engines"), { source: "unknown", confidence: "unknown", via: "unknown" }, "非 mcp 段落的归属不猜");
  assert.deepEqual(provenanceOfSection("HARNESS_IDENTITY"), { source: "unknown", confidence: "unknown", via: "unknown" });
  ok("技能来源只用 provider；段落只认 mcp:<server>，其余 unknown（不猜）");
}

// ── 5. 段落兜底规则（纯函数） ─────────────────────────────────────────────────
{
  const hiddenAll = { knownNames: new Set(["mcp__wincu__a", "mcp__wincu__b"]), upstreamHidden: ["mcp__wincu__a", "mcp__wincu__b"] };
  assert.equal(isSectionUpstreamHidden("mcp:wincu", hiddenAll), true, "该 server 的工具全部被上游藏 → 段落该摘");
  const partial = { knownNames: new Set(["mcp__wincu__a", "mcp__wincu__b"]), upstreamHidden: ["mcp__wincu__a"] };
  assert.equal(isSectionUpstreamHidden("mcp:wincu", partial), false, "只要还有可用工具，说明书就留着");
  const noneKnown = { knownNames: new Set(["read"]), upstreamHidden: [] };
  assert.equal(isSectionUpstreamHidden("mcp:ctx", noneKnown), true, "一个工具都没注册 → 孤儿段落该摘");
  assert.equal(isSectionUpstreamHidden("free-search:engines", noneKnown), false, "非 mcp 段落一律不摘（不猜归属）");
  assert.equal(isSectionUpstreamHidden("mcp:wincu", { knownNames: new Set(["mcp__wincu"]), upstreamHidden: ["mcp__wincu"] }), true, "裸 mcp__<server> 也算该 server 的成员");
  ok("mcp 段落：工具全被上游藏 / 一个都没注册才摘；非 mcp 段落不摘");
}

// ── 6. gate 集成：上游隐藏先减掉，自己 deny 不误标 ────────────────────────────
{
  const host = makeHost({ names: ["read", "univer_sheet", "univer_doc"], id: "upstream-agent" });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy: policyOf({ capability: TIER_RESIDENT }) });
  await gate.attach(host.agent);
  const lift = host.agent.ctx.tools.restrict({ deny: ["univer_doc"] });
  gate.reapply(host.agent);

  const snapshot = gate.snapshot(host.agent);
  assert.deepEqual(snapshot.upstreamHidden, ["univer_doc"]);
  assert.ok(!snapshot.residentNames.includes("univer_doc"), "上游隐藏的名字不进常驻清单");
  assert.ok(!snapshot.onDemandNames.includes("univer_doc"));
  const loaded = await gate.load(host.agent, ["univer_doc"]);
  assert.deepEqual(loaded.unknown, ["univer_doc"], "上游隐藏的工具 gate_load 不认（否则永远 UNKNOWN_TOOL）");
  lift();
  gate.reapply(host.agent);
  assert.deepEqual(gate.snapshot(host.agent).upstreamHidden, [], "上游撤销后标记消失");

  // 闸门自己 deny（按需档）≠ 上游藏：upstreamHidden 必须保持空。
  const ownHost = makeHost({ names: ["read", "univer_sheet"], id: "gate-deny-agent" });
  const ownGate = createGate({ ctx: ownHost.rootCtx, logger: ownHost.logger, policy: policyOf({ capability: TIER_ONDEMAND }) });
  await ownGate.attach(ownHost.agent);
  const ownSnapshot = ownGate.snapshot(ownHost.agent);
  assert.ok(ownSnapshot.onDemandNames.includes("univer_sheet"), "按需档的工具仍在候选集里");
  assert.deepEqual(ownSnapshot.upstreamHidden, [], "闸门自己 deny 的不算上游隐藏");
  await ownGate.release(ownHost.agent);
  await gate.release(host.agent);
  ok("上游隐藏先减掉且不可加载；闸门自己的 deny 不误标成上游");
}

// ── 7. gate 集成：mcp 段落全隐藏才摘，摘掉后进目录 ───────────────────────────
{
  const host = makeHost({
    names: ["read", "mcp__wincu__a", "mcp__wincu__b", "mcp__ctx__x"],
    id: "section-agent",
  });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy: policyOf({}) });
  await gate.attach(host.agent);
  const lift = host.agent.ctx.tools.restrict({ deny: ["mcp__wincu__a", "mcp__wincu__b"] });
  gate.reapply(host.agent);
  gate.recordSections(host.agent, [
    { name: "mcp:wincu", chars: 100, tokens: 30 },
    { name: "mcp:ctx", chars: 50, tokens: 15 },
    { name: "free-search:engines", chars: 40, tokens: 12 },
  ]);

  const plan = gate.planSections(host.agent);
  assert.equal(plan.shouldDrop("mcp:wincu"), true, "server 的工具全被上游藏 → 段落摘掉");
  assert.equal(plan.shouldDrop("mcp:ctx"), false, "还有可用工具的 server 段落保留");
  assert.equal(plan.shouldDrop("free-search:engines"), false, "非 mcp 段落在常驻档下保留");
  const catalog = gate.catalogFor(host.agent);
  assert.ok(catalog.includes("- [段落] mcp:wincu"), "被摘的段落必须进目录，否则模型永远不知道有这段：" + catalog);

  const view = gate.capabilityView(host.agent);
  const section = view.sections.find((row) => row.name === "mcp:wincu");
  assert.equal(section.upstreamHidden, true, "能力视图的段落行要标 upstreamHidden");
  assert.deepEqual(section.provenance, { source: "mcp:wincu", confidence: "high", via: "naming" });
  const row = view.capabilities.find((entry) => entry.id === "mcp:wincu");
  assert.deepEqual(row.upstreamHidden, ["mcp:wincu", "mcp__wincu__a", "mcp__wincu__b"], "能力行要列出被上游藏的工具与段落成员");
  assert.ok(view.provenance["mcp__wincu__a"], "来源表覆盖上游隐藏的名字");
  assert.deepEqual(view.provenance["mcp__wincu__a"], { source: "mcp:wincu", confidence: "high", via: "naming" });

  lift();
  gate.reapply(host.agent);
  assert.equal(gate.planSections(host.agent).shouldDrop("mcp:wincu"), false, "上游撤销后段落保留");
  await gate.release(host.agent);
  ok("mcp 段落全隐藏才摘、非 mcp 不摘；摘掉的段落进目录；能力视图带 provenance/upstreamHidden");
}

// ── 8. gate 集成：一个都没注册的 mcp 段落也算孤儿 ─────────────────────────────
{
  const host = makeHost({ names: ["read"], id: "orphan-section-agent" });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy: policyOf({}) });
  await gate.attach(host.agent);
  gate.recordSections(host.agent, [{ name: "mcp:ctx", chars: 10, tokens: 3 }]);
  assert.equal(gate.planSections(host.agent).shouldDrop("mcp:ctx"), true, "server 一个工具都没注册 → 段落是孤儿");
  assert.ok(gate.catalogFor(host.agent).includes("[段落] mcp:ctx"));
  await gate.release(host.agent);
  ok("mcp:<server> 一个工具都没注册时，段落也摘掉并进目录");
}

// ── 9. 能力视图逐行/逐工具/逐段落带来源；gate_status 键集不变 ─────────────────
{
  const host = makeHost({
    names: ["read", "univer_sheet", "brand_new_tool", "mcp__wincu__fs_read"],
    id: "provenance-agent",
  });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy: policyOf({ capability: TIER_RESIDENT }) });
  await gate.attach(host.agent);
  gate.recordSections(host.agent, [{ name: "mcp:wincu", chars: 20, tokens: 6 }]);
  gate.rememberSkills(host.agent, [{ name: "office", provider: "dsh-office-tools" }, { name: "no-provider" }]);
  gate.reapply(host.agent);

  const view = gate.capabilityView(host.agent);
  const tool = view.tools.find((entry) => entry.name === "univer_sheet");
  assert.deepEqual(tool.provenance, { source: "plugin:dsh-univer-office", confidence: "medium", via: "prefix" });
  assert.equal(tool.upstreamHidden, false);
  const unknownTool = view.tools.find((entry) => entry.name === "brand_new_tool");
  assert.deepEqual(unknownTool.provenance, { source: "order", confidence: "low", via: "registration" });
  const unknownRow = view.capabilities.find((entry) => entry.id === "tool:brand_new_tool");
  assert.deepEqual(unknownRow.provenance, { source: "unknown", confidence: "unknown", via: "unknown" }, "推不出来源的能力行不冒充来源");
  const pluginRow = view.capabilities.find((entry) => entry.id === "plugin:dsh-univer-office");
  assert.deepEqual(pluginRow.provenance, { source: "plugin:dsh-univer-office", confidence: "medium", via: "prefix" });
  assert.deepEqual(view.provenance["office"], { source: "skillpack", confidence: "high", via: "provider" }, "技能来源也进 /capabilities 的来源表");
  assert.deepEqual(view.provenance["no-provider"], { source: "unknown", confidence: "unknown", via: "unknown" });

  const status = pickStatus(gate.snapshot(host.agent));
  assert.deepEqual(Object.keys(status), STATUS_KEYS, "gate_status 的 18 键与顺序一个都不许动（缓存约束）");
  assert.equal("provenance" in status, false, "新信息只走 /capabilities，不进 gate_status");
  await gate.release(host.agent);
  ok("能力视图逐行/逐工具/逐段落带 provenance 与 upstreamHidden；gate_status 键集逐字节不变");
}

console.log("\n全部通过 (" + passed + ")");
