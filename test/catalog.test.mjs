/**
 * 目录分组顺序（0.2.0 缺陷批修 I5-2）用例。
 *
 * 真实缺陷：GROUP_ORDER 里写的是 "MCP"，而 ownerOf("mcp__wincu__x") 返回小写 "mcp"，
 * 旧实现用 indexOf 精确匹配 → 找不到 → MCP 组被排到最后。组名大小写不敏感匹配，
 * 但输出仍原样使用 ownerOf 的结果（不改名，不合并组）。
 *
 * 跑法：node --import ./test/stub-loader.mjs test/catalog.test.mjs
 */
import assert from "node:assert/strict";
import { groupRank, ownerOf, renderCatalog } from "../lib/catalog.js";

let passed = 0;
const ok = (label) => { passed += 1; console.log("  ok    " + label); };

const planOf = (names) => ({ tools: names.map((name) => ({ name })) });

// ── 1. 组序表大小写不敏感 ─────────────────────────────────────────────────────
{
  assert.equal(groupRank("MCP"), 3);
  assert.equal(groupRank("mcp"), 3, "ownerOf 返回的小写 mcp 必须落到 MCP 的组序");
  assert.equal(groupRank("Mcp"), 3, "任意大小写都认");
  assert.equal(groupRank("free-search"), 2);
  assert.equal(groupRank("office"), 4);
  assert.equal(groupRank("不存在的组"), 99, "未知组仍排最后");
  ok("组序表大小写不敏感：mcp / Mcp / MCP 同序，未知组仍 99");
}

// ── 2. mcp 组排在 free-search 之后、office 之前 ──────────────────────────────
{
  const catalog = renderCatalog(planOf(["office_docx", "mcp__wincu__fs_read", "free-search"]));
  const free = catalog.indexOf("[free-search]");
  const mcp = catalog.indexOf("[mcp]");
  const office = catalog.indexOf("[office]");
  assert.ok(free >= 0, "缺 [free-search] 组：" + catalog);
  assert.ok(mcp >= 0, "缺 [mcp] 组：" + catalog);
  assert.ok(office >= 0, "缺 [office] 组：" + catalog);
  assert.ok(free < mcp, "mcp 组必须排在 free-search 之后：" + catalog);
  assert.ok(mcp < office, "mcp 组必须排在 office 之前：" + catalog);
  ok("MCP 组（小写 mcp）排在 free-search 后、office 前");
}

// ── 3. 组名原样输出：大小写不同的组名不改写、不合并 ──────────────────────────
{
  const catalog = renderCatalog(planOf(["Mcp__srv__x", "office_docx"]));
  assert.ok(catalog.includes("[Mcp]"), "组名必须原样输出（不强制改成 MCP）：" + catalog);
  const mcp = catalog.indexOf("[Mcp]");
  const office = catalog.indexOf("[office]");
  assert.ok(mcp >= 0 && mcp < office, "Mcp 组也要按 MCP 的组序排");
  ok("组名原样输出（[Mcp] 仍叫 Mcp），但排序按 MCP 的位置");
}

// ── 3b. 技能行：名字 + 描述首句 + 来源（0.3.0 接管） ─────────────────────────
{
  const catalog = renderCatalog({
    tools: [],
    skills: [
      // gate.reapply 用 skillCatalogEntry 先生成 {name, description, source}：来源标在行尾。
      { name: "alpha", description: "Alpha 技能", source: "宿主:pkg-a" },
      { name: "solo", description: "导入技能", source: "导入:local" },
    ],
  });
  assert.ok(catalog.includes("- [技能] alpha — Alpha 技能（宿主:pkg-a）"), "宿主技能行要带来源：" + catalog);
  assert.ok(catalog.includes("- [技能] solo — 导入技能（导入:local）"), "导入技能行要带来源：" + catalog);
  assert.equal(catalog.includes("第二句"), false, "描述只取首句");
  ok("技能行：名字 + 描述首句 + 来源（宿主:provider / 导入:id）");
}

// ── 4. ownerOf 行为不变（分组边界的既有约定） ────────────────────────────────
{
  assert.equal(ownerOf("mcp__wincu__fs_read"), "mcp");
  assert.equal(ownerOf("univer_sheet"), "univer");
  assert.equal(ownerOf("read"), "read", "没有下划线时整名就是组名");
  assert.equal(ownerOf("_leading"), "_leading", "下划线在开头不切");
  ok("ownerOf 切分规则不变（第一个下划线之前；无下划线保留整名）");
}


// ── 5. 技能行折叠（0.4.1）：skillGroups=true 时按来源折叠成一行 ────────────────
{
  const plan = {
    tools: [],
    skills: [
      { name: "alpha", description: "A 技能", source: "宿主:pkg-a" },
      { name: "beta", description: "B 技能", source: "宿主:pkg-a" },
      { name: "gamma", description: "C 技能", source: "导入:local" },
    ],
  };
  // 默认（不折叠）：逐条列出，与 0.4.0 逐字节一致。
  const plain = renderCatalog(plan);
  assert.ok(plain.includes("- [技能] alpha — A 技能（宿主:pkg-a）"), plain);
  assert.ok(plain.includes("- [技能] beta — B 技能（宿主:pkg-a）"), plain);
  assert.ok(plain.includes("- [技能] gamma — C 技能（导入:local）"), plain);

  // 折叠：每来源一行，只留名字，描述全部消失。
  const folded = renderCatalog(plan, { skillGroups: true });
  assert.ok(folded.includes("- [技能] 宿主:pkg-a 2 条：alpha, beta"), folded);
  assert.ok(folded.includes("- [技能] 导入:local 1 条：gamma"), folded);
  assert.equal(folded.includes("A 技能"), false, "折叠后不再逐条带描述");
  assert.ok(folded.length < plain.length, "折叠必须更短：" + folded.length + " vs " + plain.length);
  ok("技能行折叠：skillGroups=true 按来源折叠，默认逐条列出（0.4.0 字节不变）");
}

console.log("\n全部通过 (" + passed + ")");