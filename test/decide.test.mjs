/**
 * D4/D5：归层决策引擎的 M 矩阵（三轴 × 四维状态）与层值原语。
 *
 * 这些用例只碰 lib/decide.js（纯函数、无宿主），任何一条红都说明「为什么这个工具/段落/技能
 * 是常驻、被关掉或不可加载」的答案不再唯一。
 */
import assert from "node:assert/strict";
import {
  AXES,
  AXIS_LIST,
  FAILURE_REASONS,
  REASONS,
  decide,
  decideSection,
  decideSkill,
  decideTool,
  parseTier,
  tierOr,
} from "../lib/decide.js";

const results = [];
const check = (label, fn) => {
  try {
    fn();
    results.push({ ok: true, label });
  } catch (error) {
    results.push({ ok: false, label, error });
  }
};

// ── 1. 层值原语：只认 0 / 1 / 2，其余一律非法 ────────────────────────────────
check("D5 层值：0/1/2 合法，null/空串/false/空数组/数字字符串/NaN 全非法", () => {
  for (const tier of [0, 1, 2]) {
    assert.deepEqual(parseTier(tier), { ok: true, tier }, "合法层值 " + String(tier));
  }
  for (const value of [null, undefined, "", "0", "1", "2", false, true, [], [1], {}, NaN, Infinity, 3, -1, 1.5]) {
    const parsed = parseTier(value);
    assert.equal(parsed.ok, false, "必须拒绝非法层值：" + JSON.stringify(value));
    assert.equal(parsed.reason, "invalid-tier");
  }
  assert.equal(tierOr(undefined, 1), 1, "tierOr 只在非法时用 fallback");
  assert.equal(tierOr(0, 1), 0, "0 是合法层值，不能被 fallback 吃掉");
  assert.equal(tierOr("2", 1), 1, "数字字符串非法");
});

// ── 2. 轴命名空间与原因枚举 ─────────────────────────────────────────────────
check("D4 轴表：工具/段落/技能三轴，失败原因四类 + off 组成可区分枚举", () => {
  assert.deepEqual(AXIS_LIST, [AXES.TOOL, AXES.SECTION, AXES.SKILL]);
  assert.deepEqual([...FAILURE_REASONS], ["off", "not-invocable", "unknown", "upstream-hidden", "evicted"]);
  assert.equal(REASONS.OFF, "off");
  assert.equal(REASONS.NOT_INVOCABLE, "not-invocable");
  const bogus = decide("bogus", "x", {});
  assert.equal(bogus.loadable, false, "未知轴不猜：给一条明确不可用的记录");
  assert.equal(bogus.reason, "unknown");
  assert.equal(bogus.removed, true);
});

// ── 3. 工具轴真值：关闭 > 已加载；冻结只影响抬升；保护绝不进摘除集 ─────────────
check("D4 工具真值：显式关闭对已加载/冻结一律优先，且进摘除集", () => {
  for (const state of [
    { loaded: true },
    { loaded: true, frozen: true },
    { loaded: false, frozen: true },
  ]) {
    const decision = decideTool({ name: "pwsh_probe", tier: 0, ...state });
    assert.equal(decision.tier, 0, "关闭必须压过 " + JSON.stringify(state));
    assert.equal(decision.bucket, "off");
    assert.equal(decision.removalReason, "off");
    assert.equal(decision.catalog, false, "关闭的工具不进目录");
  }
});

check("D4 工具真值：已加载只把按需抬常驻，冻结下仍按需且桶不变", () => {
  const resident = decideTool({ name: "univer_sheet", tier: 2, loaded: true });
  assert.equal(resident.tier, 1);
  assert.equal(resident.bucket, "resident");
  assert.equal(resident.reason, "loaded");
  const frozen = decideTool({ name: "univer_sheet", tier: 2, loaded: true, frozen: true });
  assert.equal(frozen.tier, 2, "冻结只影响抬升");
  assert.equal(frozen.bucket, "ondemand");
  assert.equal(frozen.frozenLoaded, true);
  assert.equal(frozen.removalReason, undefined, "冻结的已加载工具不进摘除集");
});

check("D4 工具真值：常驻恒常驻、保护恒常驻且绝不进摘除集、上游隐藏只过滤", () => {
  const resident = decideTool({ name: "read", tier: 1 });
  assert.equal(resident.tier, 1);
  const protectedTool = decideTool({ name: "gate_load", tier: 0, protected: true });
  assert.equal(protectedTool.tier, 1, "保护名单覆盖显式关闭（它连关都关不掉）");
  assert.equal(protectedTool.removalReason, undefined);
  const hidden = decideTool({ name: "univer_doc", tier: 2, upstreamHidden: true });
  assert.equal(hidden.loadable, false, "上游隐藏不可加载");
  assert.equal(hidden.reason, "upstream-hidden");
  const ownTool = decideTool({ name: "gate_status", tier: 0, own: true });
  assert.equal(ownTool.tier, 1, "own 层工具连策略都关不掉（宿主语义）");
  assert.equal(decideTool({ name: "x", tier: 9 }).invalidTier, true, "非法层值落到 defaults 并标 invalidTier");
});

// ── 4. 段落轴五行真值 ───────────────────────────────────────────────────────
check("D4 段落真值：0 摘除且不可加载；1 不摘不目录；2 摘除进目录可加载；受保护不摘不目录可加载", () => {
  const off = decideSection({ name: "pwsh-notes", tier: 0 });
  assert.deepEqual([off.removed, off.catalog, off.loadable, off.removalReason], [true, true, false, "off"]);
  const residentSection = decideSection({ name: "mcp:wincu", tier: 1 });
  assert.deepEqual([residentSection.removed, residentSection.catalog, residentSection.loadable], [false, false, true]);
  const ondemand = decideSection({ name: "free-search", tier: 2 });
  assert.deepEqual([ondemand.removed, ondemand.catalog, ondemand.loadable], [true, true, true]);
  const protectedSection = decideSection({ name: "skills", tier: 0, protected: true });
  assert.deepEqual([protectedSection.removed, protectedSection.catalog, protectedSection.loadable], [false, false, true]);
  const passthrough = decideSection({ name: "skills", tier: 0, passthrough: true });
  assert.deepEqual([passthrough.removed, passthrough.catalog, passthrough.loadable], [false, false, true], "收窄豁免：不摘不注入");
  const gateSection = decideSection({ name: "gate-skill:x", tier: 0, gateSection: true });
  assert.equal(gateSection.removed, false, "gate 自己的技能段永不摘除");
});

// ── 5. 技能轴真值 ───────────────────────────────────────────────────────────
check("D4 技能真值：0 关闭不可加载；不可调用不进目录；1 不目录；2 进目录可加载；shadowed 全隐", () => {
  const off = decideSkill({ name: "univer", tier: 0 });
  assert.deepEqual([off.removalReason, off.loadable, off.catalog], ["off", false, false]);
  const notInvocable = decideSkill({ name: "hidden", tier: 2, modelInvocable: false });
  assert.equal(notInvocable.notInvocable, true);
  assert.equal(notInvocable.catalog, false);
  assert.equal(notInvocable.loadable, false, "不可调用技能的加载失败原因是 not-invocable");
  assert.equal(notInvocable.removalReason, "not-invocable");
  const resident = decideSkill({ name: "base", tier: 1 });
  assert.equal(resident.catalog, false, "常驻技能正文已在段落里，不再列目录");
  assert.equal(resident.loadable, true);
  const ondemand = decideSkill({ name: "office", tier: 2 });
  assert.equal(ondemand.catalog, true);
  const shadowed = decideSkill({ name: "dup", tier: 2, shadowed: true });
  assert.deepEqual([shadowed.catalog, shadowed.loadable], [false, false]);
  assert.equal(shadowed.removalReason, "shadowed");
});

// ── 6. 非字符串通配不抛错 ────────────────────────────────────────────────────
check("D5 通配安全：名字不是字符串时匹配返回假、不抛错", async () => {
  const { matches } = await import("../lib/tiers.js");
  assert.equal(matches("univer_*", 42), false);
  assert.equal(matches("univer_*", null), false);
  assert.equal(matches("univer_*", ["univer_sheet"]), false);
  assert.equal(matches("*", "anything"), true);
});

console.log("");
for (const row of results) {
  if (row.ok) console.log("  ok    " + row.label);
  else {
    console.log("  FAIL  " + row.label + "  →  " + (row.error && row.error.message ? row.error.message : row.error));
    process.exitCode = 1;
  }
}
const failed = results.filter((row) => row.ok === false).length;
console.log("");
console.log((results.length - failed) + "/" + results.length + " passed");
