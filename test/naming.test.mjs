/**
 * D6：命名与分组只有这一份实现。能力 id、技能来源标签、目录分组/组序、单条组并入全靠它。
 */
import assert from "node:assert/strict";
import {
  CATALOG_GROUP_ORDER,
  CATALOG_OTHER_GROUP,
  MCP_TOOL_PREFIX,
  NATIVE_TOOL_NAMES,
  PLUGIN_PREFIXES,
  capabilityIdOfSectionName,
  capabilityIdOfSkill,
  capabilityIdOfSkillName,
  capabilityIdOfToolName,
  catalogGroupOf,
  groupRank,
  mergeSingleMemberGroups,
  mcpServerOfToolName,
  orderGroups,
  pickPattern,
  pluginOfToolName,
  prefixOf,
  skillSourceLabel,
  SKILL_TOOL_PREFIXES,
  TOOL_PREFIX_RE,
  isToolPrefix,
  skillsForToolPrefix,
  toolPrefixesForSkill,
} from "../lib/naming.js";

const results = [];
const check = (label, fn) => {
  try { fn(); results.push({ ok: true, label }); }
  catch (error) { results.push({ ok: false, label, error }); }
};

check("前缀切分：第一个下划线之前；无下划线/非字符串原样", () => {
  assert.equal(prefixOf("univer_sheet"), "univer");
  assert.equal(prefixOf("mcp__wincu__fs_read"), "mcp");
  assert.equal(prefixOf("read"), "read");
  assert.equal(prefixOf("_leading"), "_leading");
  assert.equal(prefixOf(42), "");
  assert.equal(prefixOf(undefined), "");
});

check("MCP 归属：mcp__<server>__<raw>；非 MCP 名字返回 undefined", () => {
  assert.equal(mcpServerOfToolName("mcp__wincu__fs_read"), "wincu");
  assert.equal(mcpServerOfToolName("mcp__wincu"), "wincu", "没有 raw 名时也认 server");
  assert.equal(mcpServerOfToolName("read"), undefined);
  assert.equal(mcpServerOfToolName("mcp__"), undefined);
  assert.equal(mcpServerOfToolName(undefined), undefined);
  assert.equal(MCP_TOOL_PREFIX, "mcp__");
});

check("插件归属：静态前缀表，未知前缀不猜", () => {
  assert.equal(pluginOfToolName("univer_sheet"), PLUGIN_PREFIXES.univer);
  assert.equal(pluginOfToolName("ssh_exec"), PLUGIN_PREFIXES.ssh);
  assert.equal(pluginOfToolName("nope_tool"), undefined);
  assert.equal(pluginOfToolName("read"), undefined, "无前缀的原生工具没有插件归属");
});

check("能力 id：mcp > plugin > glob > native > tool 的优先级固定", () => {
  assert.equal(capabilityIdOfToolName("mcp__wincu__fs_read"), "mcp:wincu");
  assert.equal(capabilityIdOfToolName("univer_sheet"), "plugin:" + PLUGIN_PREFIXES.univer);
  assert.equal(capabilityIdOfToolName("web_*"), "glob:web_*", "v2 通配键落 glob");
  assert.equal(capabilityIdOfToolName("read"), "native:read");
  assert.equal(capabilityIdOfToolName("brand_new"), "tool:brand_new");
  assert.equal(capabilityIdOfSectionName("mcp:wincu"), "mcp:wincu");
  assert.equal(capabilityIdOfSectionName("free-*"), "glob:free-*");
  assert.equal(capabilityIdOfSectionName("pwsh-notes"), "section:pwsh-notes");
  assert.equal(capabilityIdOfSkill("dsh-univer-office"), "skillpack:dsh-univer-office");
  assert.equal(capabilityIdOfSkill(""), "skillpack:unknown");
  assert.equal(capabilityIdOfSkillName("office"), "skill:office");
  assert.ok(NATIVE_TOOL_NAMES.has("gate_load") && NATIVE_TOOL_NAMES.has("create_worktree"));
});

check("技能来源标签：宿主/导入两条口径，缺 provider 各有兜底", () => {
  assert.equal(skillSourceLabel({ origin: "host", provider: "dsh-univer-office" }), "宿主:dsh-univer-office");
  assert.equal(skillSourceLabel({ origin: "host" }), "宿主");
  assert.equal(skillSourceLabel({ origin: "import", provider: "local" }), "导入:local");
  assert.equal(skillSourceLabel({ origin: "import" }), "导入:gate-import");
  assert.equal(skillSourceLabel(undefined), "宿主");
});

check("目录分组：显式表内的组名归一，未知前缀原样进自己的组", () => {
  assert.equal(catalogGroupOf("univer_sheet"), "univer");
  assert.equal(catalogGroupOf("mcp__wincu__fs_read"), "MCP");
  assert.equal(catalogGroupOf("free_search"), "free", "前缀表里没有 free-search 这一刀，未知组名按前缀原样");
  assert.equal(catalogGroupOf("read"), "read");
  assert.equal(CATALOG_GROUP_ORDER[0], "宿主核心");
  assert.equal(CATALOG_OTHER_GROUP, "其他");
  assert.ok(groupRank("MCP") < groupRank("univer"));
  assert.equal(groupRank("未知组"), 99);
});

check("组序三键：显式表顺序 → 条目数降序（仅 byCount）→ 组名升序", () => {
  const groups = ["univer", "MCP", "宿主核心", "unknown-b"];
  assert.deepEqual(orderGroups(groups), ["宿主核心", "MCP", "univer", "unknown-b"]);
  const counts = new Map([["b", 5], ["a", 2]]);
  assert.deepEqual(orderGroups(["b", "a"], counts, { byCount: true }), ["b", "a"], "表外同 rank 时条目多的在前");
  assert.deepEqual(orderGroups(["a", "b"], counts), ["a", "b"], "不带 byCount 时只按名字升序");
  assert.deepEqual(orderGroups(["univer", "MCP"]), ["MCP", "univer"], "显式表顺序压过名字");
  assert.deepEqual(orderGroups(["b", "a", "c"]), ["a", "b", "c"], "表外组按名字升序");
});

check("单条组并入其他（最小 2 条）：保持原行顺序，其他组合并", () => {
  const rows = [
    { group: "univer", row: "u1" }, { group: "read", row: "r1" },
    { group: "univer", row: "u2" }, { group: "其他", row: "o1" },
  ];
  const merged = mergeSingleMemberGroups(rows);
  assert.deepEqual(merged.map((item) => item.group), ["univer", "其他"]);
  const other = merged.find((item) => item.group === "其他");
  assert.deepEqual(other.rows, ["o1", "r1"], "单条组追加到其他组尾部");
  assert.deepEqual(rows.map((item) => item.row), ["u1", "r1", "u2", "o1"], "不改输入");
});

check("工具前缀判据：标识符形状（字母开头、只含字母数字）", () => {
  assert.equal(isToolPrefix("bsk"), true);
  assert.equal(isToolPrefix("univer"), true);
  assert.equal(isToolPrefix("Bsk2"), true, "大小写不敏感（前缀本身区分大小写由调用方决定）");
  assert.equal(isToolPrefix("9lives"), false, "数字开头不是标识符");
  assert.equal(isToolPrefix("bsk-x"), false, "连字符不是前缀");
  assert.equal(isToolPrefix(""), false);
  assert.equal(isToolPrefix(undefined), false);
  assert.equal(isToolPrefix(42), false);
  assert.ok(TOOL_PREFIX_RE.test("bsk"));
});

check("技能 → 工具前缀（skill→prefix 方向）：显式别名精确优先，未命中回退首段", () => {
  // 显式表是唯一事实源：browser-skill 的插件工具全叫 bsk_*，首段 browser 一个都不存在。
  assert.deepEqual(toolPrefixesForSkill("browser-skill"), ["bsk"]);
  assert.deepEqual(toolPrefixesForSkill("skill:browser-skill"), ["bsk"], "允许带 skill: 前缀（调用方未必剥过）");
  assert.deepEqual(toolPrefixesForSkill("  browser-skill  "), ["bsk"], "前后空白不算名字的一部分");
  assert.deepEqual(SKILL_TOOL_PREFIXES["browser-skill"], ["bsk"], "表本身也要可读（面板/排障读它）");
  // 未命中显式表 ⇒ 与 0.5.4 起逐字节一致的首段切法。
  assert.deepEqual(toolPrefixesForSkill("univer-sheet"), ["univer"]);
  assert.deepEqual(toolPrefixesForSkill("office-docx"), ["office"]);
  assert.deepEqual(toolPrefixesForSkill("univer"), ["univer"]);
  // 切不出标识符形状 ⇒ 空数组（宁可不放，也不误放）。
  assert.deepEqual(toolPrefixesForSkill(""), []);
  assert.deepEqual(toolPrefixesForSkill("-leading"), [], "第一段为空");
  assert.deepEqual(toolPrefixesForSkill("9lives"), []);
  assert.deepEqual(toolPrefixesForSkill("中文技能"), []);
  assert.deepEqual(toolPrefixesForSkill(undefined), []);
  assert.deepEqual(toolPrefixesForSkill(null), []);
});

check("工具前缀 → 技能（prefix→skill 反向）：只反映显式表，绝不按首段反推", () => {
  assert.deepEqual(skillsForToolPrefix("bsk"), ["browser-skill"]);
  assert.deepEqual(skillsForToolPrefix("BSK"), ["browser-skill"], "大小写不敏感：与 TOOL_PREFIX_RE / toolPrefixesForSkill 同口径");
  assert.deepEqual(skillsForToolPrefix("browser"), [], "首段推断不是映射，反查不给答案");
  assert.deepEqual(skillsForToolPrefix("univer"), [], "同名族不在显式表里");
  assert.deepEqual(skillsForToolPrefix("9lives"), [], "非法前缀");
  assert.deepEqual(skillsForToolPrefix(undefined), []);
  // 双向一致性：表里每个技能的正向结果都能反查回自己。
  for (const [skill, prefixes] of Object.entries(SKILL_TOOL_PREFIXES)) {
    for (const prefix of prefixes) {
      assert.ok(skillsForToolPrefix(prefix).includes(skill), skill + " → " + prefix + " 的逆向对不上");
    }
    assert.deepEqual(toolPrefixesForSkill(skill), prefixes.slice(), skill + " 正向必须等于表里的前缀集");
  }
});

check("模式决胜：具体度降序，同分按字典序", () => {
  assert.equal(pickPattern(["univer_*", "univer_sheet"], "univer_sheet"), "univer_sheet");
  assert.equal(pickPattern(["a*", "ab"], "abc"), "a*", "同具体度取字典序小的模式");
  assert.equal(pickPattern(["z*", "a*"], "anything"), "a*", "同分取字典序小的");
  assert.equal(pickPattern([], "x"), undefined);
});

console.log("");
for (const row of results) {
  if (row.ok) console.log("  ok    " + row.label);
  else { console.log("  FAIL  " + row.label + "  →  " + (row.error && row.error.message ? row.error.message : row.error)); process.exitCode = 1; }
}
const failed = results.filter((row) => row.ok === false).length;
console.log("");
console.log((results.length - failed) + "/" + results.length + " passed");
