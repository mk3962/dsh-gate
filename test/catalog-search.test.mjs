/**
 * gate_search 归一化用例（0.3.3）。
 *
 * 真实缺陷（生产体检 2026-11-14）：searchCatalog 只做逐字子串匹配，模型按自然语言写
 * "deck issue" / "mnemon remember" / "video understand" 全部零命中 —— 真实名字里是下划线。
 * 生产日志实测 55 次 gate_search 里 23 次打空（41.8%），发现通道自己坏了。
 *
 * 跑法：node --import ./test/stub-loader.mjs test/catalog-search.test.mjs
 */
import assert from "node:assert/strict";
import { normalizeForSearch, searchCatalog } from "../lib/catalog.js";
import { cjkKeywordsOf, hasCjk } from "../lib/search-alias.js";

let passed = 0;
const ok = (label) => { passed += 1; console.log("  ok    " + label); };

const deck = [
  "deck_context", "deck_issue_get", "deck_map_snapshot", "deck_issue_list", "deck_issue_create",
  "deck_map_plan_create", "deck_map_link", "deck_issue_patch", "deck_issue_report", "deck_work_route",
];
const entries = [
  ...deck.map((name) => ({ name, description: "同属 dsh-mattpocock-skills-deck 插件的 ISSUE 与 map 管理能力。" })),
  { name: "mnemon_remember", description: "Archive one durable insight in a selected provider-backed Memory Space。" },
  { name: "video_understand", description: "Understand a video by sampling frames and audio。" },
  { name: "unlag_refresh", description: "按一下刷新按钮。" },
  { name: "read", description: "Read a UTF-8 text file and return line-numbered content。" },
  { name: "pwsh", description: "Execute a PowerShell command。" },
];
const namesOf = (hits) => hits.map((entry) => entry.name);
const top = (query) => namesOf(searchCatalog(entries, query, 5))[0];

// ── 1. 归一：下划线/连字符/点统一成空格 ─────────────────────────────────────
{
  assert.equal(normalizeForSearch("deck_issue_list"), "deck issue list");
  assert.equal(normalizeForSearch("free-search:engines"), "free search:engines");
  assert.equal(normalizeForSearch("  MCP__wincu__fs_read  "), "mcp wincu fs read");
  assert.equal(normalizeForSearch(undefined), "");
  ok("归一：下划线/连字符折叠成空格、大小写与空白收敛");
}

// ── 2. 空格查下划线：体检里打空的那几条必须命中 ─────────────────────────────
{
  assert.equal(top("deck issue list"), "deck_issue_list", "deck issue list 必须命中 deck_issue_list");
  assert.equal(top("mnemon remember"), "mnemon_remember");
  assert.equal(top("video understand"), "video_understand");
  assert.equal(top("unlag refresh"), "unlag_refresh");
  assert.equal(top("deck map snapshot"), "deck_map_snapshot");
  ok("自然语言查询（空格）命中下划线真名：体检里 4 个打空用例全部救回");
}

// ── 3. 原名精确/前缀仍排第一（老行为不退化） ────────────────────────────────
{
  assert.equal(top("deck_issue_get"), "deck_issue_get");
  assert.equal(top("deck_issue"), "deck_issue_create", "前缀档按名字字典序取第一个");
  assert.equal(top("read"), "read");
  assert.equal(top("mnemon_remember"), "mnemon_remember");
  ok("精确名与前缀查询不退化");
}

// ── 4. 多词按词命中：只写一部分也能找到 ────────────────────────────────────
{
  const hits = namesOf(searchCatalog(entries, "issue patch", 3));
  assert.ok(hits.includes("deck_issue_patch"), "issue patch 应命中 deck_issue_patch：" + hits.join(","));
  const hits2 = namesOf(searchCatalog(entries, "map link", 3));
  assert.ok(hits2.includes("deck_map_link"), "map link 应命中 deck_map_link：" + hits2.join(","));
  ok("多词查询按词命中");
}

// ── 5. 说明里的自然语言仍能搜到（描述档不退化） ─────────────────────────────
{
  const hits = namesOf(searchCatalog(entries, "memory space", 5));
  assert.ok(hits.includes("mnemon_remember"), "memory space 应命中 mnemon_remember：" + hits.join(","));
  const hits2 = namesOf(searchCatalog(entries, "line-numbered", 5));
  assert.ok(hits2.includes("read"), "line-numbered 应命中 read：" + hits2.join(","));
  ok("说明档仍可搜（多词与连字符都能命中描述）");
}

// ── 6. 空查询与无命中：不抛错、顺序稳定 ────────────────────────────────────
{
  assert.equal(searchCatalog(entries, "", 3).length, 3);
  assert.equal(searchCatalog(entries, "   ", 3).length, 3, "纯空白按空查询处理");
  assert.deepEqual(searchCatalog(entries, "zzzz-not-a-tool"), []);
  ok("空查询回前 N 条；无命中回空数组，不抛错");
}

// ── 7. 7 个 deck_* 不再「看起来完全一样」：可按自然语言区分 ─────────────────
{
  for (const [query, want] of [
    ["deck issue get", "deck_issue_get"],
    ["deck issue report", "deck_issue_report"],
    ["deck work route", "deck_work_route"],
    ["deck context", "deck_context"],
  ]) {
    assert.equal(top(query), want, query + " 应命中 " + want);
  }
  ok("体检里「7 行首句完全相同」的 deck_* 可按自然语言区分");
}


// ── 8. 跨语言别名（0.4.1）：中文查询也能命中（体检票 03：91.2% 零命中） ──────
{
  const zhEntries = [
    { name: "mnemon_remember", description: "Archive one durable insight in a selected provider-backed Memory Space。" },
    { name: "mnemon_memory_bodies", description: "Inspect a bounded Memory Space catalog。" },
    { name: "weather", description: "Get current weather and daily forecast for a location。" },
    { name: "terminal_open", description: "Create a persistent terminal session。" },
    { name: "excel_read", description: "Read one or all sheets of an existing workbook。" },
    { name: "slide_create", description: "Create a PowerPoint presentation。" },
    { name: "subagent", description: "Delegate a self-contained task to a subagent。" },
    { name: "deck_issue_list", description: "List shared tasks, including readiness, owner, revision。" },
  ];
  const first = (q) => namesOf(searchCatalog(zhEntries, q, 5))[0];
  // 体检里那 14 个中文词挑 8 个必须命中（以前 17 个里 17 个全空）。
  // 「记忆」会同时命中 mnemon_remember 与 mnemon_memory_bodies（同档 25，按名字排序），
  // 这里只断言「落到了 mnemon 这一族」—— 搜出来的是候选，模型再挑具体那个。
  assert.ok(String(first("记忆")).startsWith("mnemon_"), "记忆 → mnemon 族，实际 " + first("记忆"));
  assert.equal(first("天气"), "weather", "天气 → weather");
  assert.equal(first("终端"), "terminal_open", "终端 → terminal");
  assert.equal(first("表格"), "excel_read", "表格 → excel/sheet");
  assert.equal(first("幻灯片"), "slide_create", "幻灯片 → slide/pptx");
  assert.equal(first("子代理"), "subagent", "子代理 → subagent");
  assert.equal(hasCjk("记忆"), true);
  assert.equal(hasCjk("memory"), false);
  assert.deepEqual(cjkKeywordsOf("记忆"), ["mnemon", "memory", "recall"], "别名展开保序去重");
  assert.deepEqual(cjkKeywordsOf("memory"), [], "纯英文查询不展开别名");
  ok("跨语言别名：体检里打空的 6 个中文词全部命中，纯英文查询不受影响");
}

// ── 9. 别名档低于精确/前缀/包含：老行为不退化 ─────────────────────────────
{
  const mixed = [
    { name: "weather", description: "Get current weather。" },
    { name: "weather_forecast", description: "Extended forecast。" },
  ];
  // "weather" 精确命中名字（100）必须压过别名词根（25）。
  assert.equal(namesOf(searchCatalog(mixed, "weather", 2))[0], "weather");
  // 无别名、无匹配时仍是空数组（不能因为 CJK 分支就把无关条目捞出来）。
  assert.deepEqual(searchCatalog(mixed, "zzzz", 5), []);
  ok("别名档不抢精确名的位次；无关查询仍然回空");
}

console.log("\n全部通过 (" + passed + ")");