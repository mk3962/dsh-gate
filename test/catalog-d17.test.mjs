/**
 * 工单 #05（0.6.0 · 规格 D17）—— 目录渲染与检索单实现。
 *
 * 覆盖 E61–E66 / 登记表 P2-2 · P2-3 · P2-4：
 *   E61 首句截断：中英终止符、句点后空白或行尾、扩展名/文件名/版本号/URL/IP 内的点、首字符即终止符；
 *   E62 空查询（浏览全表）与纯分隔符查询（空结果）分离；
 *   E63 短词根与别名守词边界与最小长度（搜「界面」不许命中 build / require / uuid / guide）；
 *   E64 中英两路各自计分后加权求和（英文有分不得丢掉中文路）；
 *   E65 limit 缺省 / 零 / 负数语义 + token 估算（代理对两个码元、宽字符与表情系数、预算含块头与前缀）；
 *   E66 别名覆盖六类高频域，且没有一条别名在管线里是死的；
 *   另附：五级排序优先级、目录字节不变量（同输入两次相同 + 0.5.7 golden 逐字节一致）。
 *
 * 跑法：node --import ./test/stub-loader.mjs test/catalog-d17.test.mjs
 */
import assert from "node:assert/strict";
import {
  ALIAS_DOMAINS,
  CJK_ALIASES,
  SIGNATURE_BLOCK_BUDGET_CHARS,
  SIGNATURE_BLOCK_HEADER,
  SIGNATURE_BUDGET_CHARS,
  SIGNATURE_BUDGET_MARGIN_CHARS,
  SIGNATURE_BUDGET_TOKENS,
  SearchLimitError,
  TOKEN_WEIGHT_ASTRAL,
  TOKEN_WEIGHT_WIDE,
  cjkKeywordsOf,
  estimateTokens,
  firstSentence,
  isMeaningfulQuery,
  normalizeSearchLimit,
  renderCatalog,
  renderSignatureLines,
  searchCatalog,
  searchCatalogResult,
  signatureBlockCost,
  signatureBlockText,
  signatureBlockTokens,
} from "../lib/catalog.js";
import { cjkKeywordsOf as cjkFromCompatLayer } from "../lib/search-alias.js";

let passed = 0;
const ok = (label) => { passed += 1; console.log("  ok    " + label); };
const namesOf = (hits) => hits.map((entry) => entry.name);

// ── E61 / P2-3：首句截断真值表 ───────────────────────────────────────────────
{
  const S = (text, limit) => firstSentence(text, limit);
  // 中英句式终止符总是边界。
  assert.equal(S("第一句。第二句"), "第一句");
  assert.equal(S("第一句！第二句"), "第一句");
  assert.equal(S("第一句？第二句"), "第一句");
  assert.equal(S("第一句！第二句？第三句。"), "第一句");
  assert.equal(S("First sentence. Second one"), "First sentence", "半角句点后跟空白 = 句界");
  assert.equal(S("First sentence!Second one"), "First sentence");
  assert.equal(S("First sentence?Second one"), "First sentence");
  assert.equal(S("trailing sentence."), "trailing sentence", "句点在行尾 = 句界");
  // 分号与换行也是边界（以前先把空白压平，换行信息被抹掉）。
  assert.equal(S("前半段；后半段"), "前半段");
  assert.equal(S("semi one; two"), "semi one");
  assert.equal(S("第一行\n第二行"), "第一行");
  assert.equal(S("first line\nsecond line"), "first line");
  // 扩展名 / 文件名 / 版本号 / URL / IP 内的点绝不是句界（P2-3 的原始症状：v0.5.7 被砍成 v0）。
  assert.equal(S("0.5.7 起支持，第二句。"), "0.5.7 起支持，第二句");
  assert.equal(S("升级到 0.6.0 后生效。"), "升级到 0.6.0 后生效");
  assert.equal(S("读取 cordis.patch.yml 与 gate.json，第二句。"), "读取 cordis.patch.yml 与 gate.json，第二句");
  assert.equal(S("访问 127.0.0.1 与 https://example.com/a.b 之后。"), "访问 127.0.0.1 与 https://example.com/a.b 之后");
  // 文件名的点不切，真句末的点照样切。
  assert.equal(S("run node test/catalog.test.mjs. Then stop"), "run node test/catalog.test.mjs");
  // 首字符即终止符：忽略它本身，继续找下一个真句末（不产空串）。
  assert.equal(S("。注意：这是正文。"), "注意：这是正文");
  assert.equal(S("！？First real sentence. second"), "First real sentence");
  assert.equal(S("。。。"), "", "整段只有终止符 ⇒ 空串");
  assert.equal(S("   "), "");
  assert.equal(S(undefined), "");
  assert.equal(S(null), "");
  assert.equal(S(42), "");
  ok("E61/P2-3 真值表：中英终止符、句点后空白或行尾、扩展名/文件名/版本/URL/IP 内点、首字符即终止符");
}

// ── E61：三条性质断言（不断言具体截断文案） ─────────────────────────────────
{
  // 性质 1：首句不会在扩展名 / 文件名 / 版本号 / URL / IP 的点上截断。
  const cases = [
    ["升级到 0.5.7 后生效。第二句。", "0.5.7"],
    ["读取 cordis.patch.yml 配置。第二句。", "cordis.patch.yml"],
    ["打开 gate.json 与 test/catalog.test.mjs。第二句。", "gate.json"],
    ["访问 https://example.com/a.b 即可。第二句。", "https://example.com/a.b"],
    ["本机 127.0.0.1 监听。第二句。", "127.0.0.1"],
  ];
  for (const [text, mustKeep] of cases) {
    const head = firstSentence(text, 200);
    assert.ok(head.includes(mustKeep), "首句必须完整保留 " + mustKeep + "，实际：" + head);
    assert.equal(head.endsWith("."), false, "首句不该以半角句点收尾：" + head);
  }
  // 性质 2：有实义内容的说明永远不产空串。
  const descriptions = [
    "Read a UTF-8 text file and return line-numbered content。第二句不该出现。",
    "v0.5.7 起支持签名摘要。第二句。",
    "打开 cordis.patch.yml 后重启。第二句。",
    "Probe the dsh-ops surface. Second sentence.",
    "本段只有一句",
  ];
  for (const text of descriptions) {
    assert.ok(firstSentence(text, 64).length > 0, "不产空串：" + text);
    assert.ok(firstSentence("。" + text, 64).length > 0, "首字符是终止符时也不产空串：" + text);
  }
  // 性质 3：任何 limit 下都不超预算（含 proxy 上限 1 与 0 的退化写法）。
  const long = "这是一段很长的说明，用来验证截断预算。" + "内容".repeat(80);
  for (let limit = 1; limit <= 64; limit += 1) {
    const head = firstSentence(long, limit);
    assert.ok(head.length <= limit, "limit=" + limit + " 时不得超预算（实际 " + head.length + "）");
    assert.ok(head.length > 0, "limit=" + limit + " 时也不产空串");
  }
  ok("E61 三条性质：扩展名点不截断、不产空串、任何 limit 都不超预算");
}

// ── E62 / P2-3：空查询（浏览全表）与纯分隔符查询（空结果）分离 ──────────────
{
  const pool = [
    { name: "deck_issue_list", description: "List shared tasks。" },
    { name: "weather", description: "Get current weather。" },
    { name: "read", description: "Read a file。" },
    { name: "univer_sheet", description: "Inspect Univer content。" },
    { name: "gate_search", description: "Search the catalog。" },
    { name: "mnemon_remember", description: "Archive an insight。" },
    { name: "video_search", description: "Find videos。" },
  ];
  // 真空白 = 浏览（原契约）：按输入顺序回前 cap 条，不排序。
  assert.deepEqual(namesOf(searchCatalog(pool, "", 3)), ["deck_issue_list", "weather", "read"]);
  assert.deepEqual(namesOf(searchCatalog(pool, "   ", 3)), ["deck_issue_list", "weather", "read"], "纯空白按空查询处理");
  assert.deepEqual(namesOf(searchCatalog(pool, undefined, 2)), ["deck_issue_list", "weather"]);
  assert.equal(searchCatalog(pool, "", 0).length, 0, "浏览 + limit 0 = 空");
  // 纯符号 / 纯分隔符：必须空结果，绝不落回全表（以前 nameNorm.includes("") 恒真 ⇒ 全表 score 60）。
  for (const query of ["---", "???", "...", "///", "___", " .-_ ", "...!!!", "、、、", "。。。"]) {
    assert.deepEqual(searchCatalog(pool, query, 20), [], "纯符号查询必须为空：" + JSON.stringify(query));
    assert.equal(isMeaningfulQuery(query), false, "无实义查询：" + JSON.stringify(query));
  }
  assert.equal(isMeaningfulQuery(""), false);
  assert.equal(isMeaningfulQuery("   "), false);
  assert.equal(isMeaningfulQuery("deck"), true);
  assert.equal(isMeaningfulQuery("工单"), true);
  assert.equal(isMeaningfulQuery("c++"), true, "字母量词保留（c++）");
  ok("E62 空查询浏览全表；纯分隔符（--- / ??? / ... / ///）返回空结果，不落回全表");
}

// ── E63 / P2-4：短词根与别名守词边界与最小长度 ──────────────────────────────
{
  const pool = [
    { name: "build_widget", description: "Build a widget." },
    { name: "require_loader", description: "Require a module." },
    { name: "uuid_gen", description: "Generate a uuid." },
    { name: "guide_book", description: "Write a guide." },
    { name: "validate_dsh_ui", description: "Validate a UI spec." },
    { name: "render_ui", description: "Render a UI card." },
  ];
  const hits = namesOf(searchCatalog(pool, "界面", 20));
  assert.deepEqual(hits, ["render_ui", "validate_dsh_ui"], "界面 只许命中词边界上的 ui/render：" + hits.join(","));
  for (const bad of ["build_widget", "require_loader", "uuid_gen", "guide_book"]) {
    assert.equal(hits.includes(bad), false, "短别名 ui 不得子串误命中 " + bad);
  }
  // 中文「界面」也一样：没有对应中文说明时不许乱捞。
  assert.equal(namesOf(searchCatalog(pool, "界面", 20)).every((name) => name.includes("ui")), true);
  // 英文短词元：小于 3 的只在整词档命中；子串档要求词边界。
  assert.deepEqual(searchCatalog([{ name: "build_widget", description: "Build a widget." }], "ui", 5), [], "ui 不是 build_widget 的词");
  assert.deepEqual(searchCatalog([{ name: "build_widget", description: "Build a widget." }], "ild", 5), [], "子串必须从词首算");
  assert.equal(namesOf(searchCatalog([{ name: "build_widget", description: "Build a widget." }], "bui", 5))[0], "build_widget", "3 字符词首子串仍可命中");
  assert.equal(namesOf(searchCatalog([{ name: "validate_dsh_ui", description: "x" }], "ui", 5))[0], "validate_dsh_ui", "整词 ui 命中");
  // 别名本身也守边界：短词根只认整词，长词根才走词首子串档。
  const aliasPool = [
    { name: "deployment_tool", description: "Deploy." },
    { name: "expose_port", description: "Expose a local port." },
  ];
  const tunnelHits = namesOf(searchCatalog(aliasPool, "隧道", 5));
  assert.deepEqual(tunnelHits, ["expose_port"], "隧道 → port/expose 只命中词边界，不命中 deployment：" + tunnelHits.join(","));
  ok("E63/P2-4 词边界与最小长度：界面 不再命中 build/require/uuid/guide；短词元只认整词");
}

// ── E64：中英混合双路各自计分后加权求和 ────────────────────────────────────
{
  const bilingual = [
    { name: "univer_sheet", description: "Inspect structured Univer content." },
    { name: "univer_doc", description: "Edit one Univer document." },
    { name: "excel_read", description: "Read one sheet of a workbook." },
    { name: "read", description: "Read a UTF-8 text file." },
  ];
  const first = namesOf(searchCatalog(bilingual, "univer 表格", 5))[0];
  assert.equal(first, "univer_sheet", "univer 表格 必须把表格工具排前，实际 " + first);
  assert.ok(namesOf(searchCatalog(bilingual, "表格", 5)).includes("univer_sheet"), "纯中文查询仍命中表格工具");

  // 英文路有分时不得丢弃中文路：deck_context 英文前缀分与 deck_issue_list 相同档，
  // 中文路的 工单→issue 必须把 deck_issue_list 顶上去（以前英文有分就短路，中文路不参与）。
  const mixed = [
    { name: "deck_context", description: "Show deck context。" },
    { name: "deck_issue_list", description: "List shared tasks。" },
  ];
  assert.equal(namesOf(searchCatalog(mixed, "deck 工单", 5))[0], "deck_issue_list", "中英两路必须相加");
  assert.equal(namesOf(searchCatalog(mixed, "deck", 5))[0], "deck_context", "纯英文查询按名字字典序取第一个");
  ok("E64 中英双路加权求和：univer 表格 排到表格工具；英文有分仍保留中文路");
}

// ── E65 / P2-2：limit 语义（缺省 / 零 / 负数 / 非数 / 封顶） ──────────────────
{
  const pool = [];
  for (let index = 0; index < 30; index += 1) {
    pool.push({ name: "tool_" + String(index).padStart(2, "0"), description: "A generic tool。" });
  }
  // 缺省（undefined / null）= 默认上限 20。
  assert.equal(searchCatalog(pool, "tool").length, 20, "缺省 limit 用默认上限");
  assert.equal(searchCatalog(pool, "tool", undefined).length, 20);
  assert.equal(searchCatalog(pool, "tool", null).length, 20);
  assert.equal(normalizeSearchLimit(undefined), 20);
  // 零 = 空结果（不再退化成「不限制」）。
  assert.deepEqual(searchCatalog(pool, "tool", 0), []);
  assert.deepEqual(searchCatalog(pool, "", 0), []);
  assert.equal(normalizeSearchLimit(0), 0);
  // 正数：floor + 封顶 50（以前 -1 退化成不限制，结果爆量）。
  assert.equal(searchCatalog(pool, "tool", 3).length, 3);
  assert.equal(normalizeSearchLimit(3.9), 3);
  assert.equal(normalizeSearchLimit(999), 50, "硬上限 50");
  assert.equal(searchCatalog(pool, "tool", 999).length, 30, "只有 30 条时全给（上限之内）");
  assert.equal(normalizeSearchLimit("7"), 7, "数字字符串兼容");
  // 负数 / 非数：可识别错误（code INVALID_LIMIT / status 400）。
  for (const bad of [-1, -0.5, -100, NaN, Infinity, -Infinity, "abc", " ", true, {}]) {
    assert.throws(
      () => searchCatalog(pool, "tool", bad),
      (error) => error instanceof SearchLimitError && error.code === "INVALID_LIMIT" && error.status === 400,
      "非法 limit 必须抛 INVALID_LIMIT/400：" + String(bad),
    );
  }
  // 服务层包装：不抛给宿主，转成 { error, status }。
  assert.deepEqual(searchCatalogResult(pool, "tool", -1), {
    error: "INVALID_LIMIT",
    status: 400,
    message: searchCatalogResult(pool, "tool", -1).message,
  });
  assert.equal(searchCatalogResult(pool, "tool", 2).results.length, 2);
  ok("E65/P2-2 limit：缺省用默认、零返回空、负数/非数抛 INVALID_LIMIT(400)、正数封顶 50");
}

// ── E65：token 估算（码点迭代 / 代理对两个码元 / 宽字符与表情系数 / 预算含块头） ─
{
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens("hello world"), 3, "ASCII 3.75 字符 / token");
  // 一个 emoji 是代理对（两个 UTF-16 码元），按两个码元的宽字符系数计 —— 不能比同样码元数的宽字符便宜。
  const emoji10 = "😀".repeat(10);
  const wide10 = "天".repeat(10);
  assert.equal(emoji10.length, 20, "10 个 emoji = 20 个 UTF-16 码元");
  assert.equal(wide10.length, 10);
  assert.equal(TOKEN_WEIGHT_ASTRAL, 2 * TOKEN_WEIGHT_WIDE, "代理对 = 两个码元的宽字符系数");
  assert.equal(estimateTokens(wide10), 7, "宽字符 0.7 / 码元");
  assert.equal(estimateTokens(emoji10), 14, "10 个 emoji = 20 码元 × 0.7");
  assert.ok(estimateTokens(emoji10) > estimateTokens(wide10), "代理对不得被低估成 ASCII");
  // 预算按**最终渲染字符串**算：块头 + "- " 前缀 + 行尾换行都计入，并留安全余量。
  const lines = ["a_tool(x)", "b_tool(y, z?)"];
  const expected = SIGNATURE_BLOCK_HEADER.length + 1
    + (2 + "a_tool(x)".length + 1)
    + (2 + "b_tool(y, z?)".length + 1);
  assert.equal(signatureBlockCost(lines), expected, "块成本 = 块头 + 每行 '- ' 前缀与换行");
  assert.equal(signatureBlockText(lines), SIGNATURE_BLOCK_HEADER + "\n- a_tool(x)\n- b_tool(y, z?)");
  assert.equal(signatureBlockTokens(lines), estimateTokens(signatureBlockText(lines)));
  assert.equal(signatureBlockCost([]), 0);
  assert.ok(SIGNATURE_BLOCK_BUDGET_CHARS + SIGNATURE_BUDGET_MARGIN_CHARS === SIGNATURE_BUDGET_CHARS, "块预算 + 余量 = 总预算");

  const fat = [];
  const names = [];
  for (let index = 0; index < 300; index += 1) {
    const name = "zz_long_tool_name_" + String(index).padStart(3, "0");
    names.push(name);
    fat.push({ name, parameters: { type: "object", properties: { alpha01: {}, alpha02: {}, alpha03: {}, beta01: {}, beta02: {}, beta03: {} }, required: ["alpha01", "alpha02", "alpha03"] } });
  }
  const rendered = renderSignatureLines(fat, { ptcFrozen: true, signatureSummary: { enabled: true, tools: names } });
  assert.ok(rendered.length > 0 && rendered.length < fat.length, "必须被预算截断（实际 " + rendered.length + "）");
  assert.ok(signatureBlockCost(rendered) <= SIGNATURE_BLOCK_BUDGET_CHARS, "块增量（含块头与前缀）不得越界");
  assert.ok(signatureBlockCost(rendered) + SIGNATURE_BUDGET_MARGIN_CHARS <= SIGNATURE_BUDGET_CHARS, "总预算含安全余量");
  assert.ok(signatureBlockTokens(rendered) <= SIGNATURE_BUDGET_TOKENS, "token 预算同样不越界");
  assert.ok(signatureBlockCost(rendered) > rendered.reduce((sum, line) => sum + line.length, 0), "预算按最终渲染串算，不是纯行文本");
  const nextLine = renderSignatureLines(fat.slice(rendered.length), { ptcFrozen: true, signatureSummary: { enabled: true, tools: names } }).slice(0, 1);
  assert.ok(signatureBlockCost(rendered.concat(nextLine)) > SIGNATURE_BLOCK_BUDGET_CHARS, "停下的位置必须是「再加一条就超预算」");
  ok("E65 token 估算：代理对两个码元、宽字符与表情系数、预算含块头/前缀并留余量不越界");
}

// ── E66：别名覆盖六类高频域，且没有死别名 ──────────────────────────────────
{
  const domainPool = [
    { name: "univer_sheet", description: "Inspect structured Univer content." },
    { name: "univer_import", description: "Import an xlsx as a new Unit." },
    { name: "univer_export", description: "Export a Unit to xlsx." },
    { name: "deck_issue_create", description: "Create one unowned pending task on the shared Team task board." },
    { name: "repo_branch_list", description: "List git branches in the repo." },
    { name: "git_commit", description: "Create a git commit." },
    { name: "storage_backup", description: "Backup the store to a file." },
    { name: "policy_migrate", description: "Migrate an old policy file." },
    { name: "render_ui", description: "Render an interactive UI card." },
    { name: "office_preview", description: "Preview a document before printing." },
    { name: "diagram_draw", description: "Draw a diagram or mermaid chart." },
    { name: "ssh_tunnel", description: "Manage local port-forward tunnels to a configured SSH host." },
  ];
  const expect = {
    sheet: ["univer_sheet"],
    issue: ["deck_issue_create"],
    repo: ["repo_branch_list", "git_commit"],
    transfer: ["univer_import", "univer_export", "storage_backup", "policy_migrate"],
    render: ["render_ui", "office_preview", "diagram_draw"],
    tunnel: ["ssh_tunnel"],
  };
  assert.deepEqual(Object.keys(ALIAS_DOMAINS).sort(), ["issue", "render", "repo", "sheet", "transfer", "tunnel"], "六类高频域都在表里");
  for (const [domain, words] of Object.entries(ALIAS_DOMAINS)) {
    assert.ok(words.length > 0, domain + " 域必须有中文查询词");
    for (const word of words) {
      const hits = namesOf(searchCatalog(domainPool, word, 20));
      const wanted = expect[domain].filter((name) => hits.includes(name));
      assert.ok(wanted.length > 0, domain + " 域中文词「" + word + "」没有命中任何代表工具：" + hits.join(","));
    }
  }
  // 无死别名：每一条中文词都能通过管线命中它自己的词根（映射被真正引用，而不是躺在表里）。
  for (const [zh, roots] of CJK_ALIASES) {
    const corpus = roots.map((root) => ({ name: root + "_tool", description: "root: " + root }));
    const hits = searchCatalog(corpus, zh, 10);
    assert.ok(hits.length > 0, "死别名（管线里匹配不到自己的词根）：" + zh + " → " + roots.join(","));
  }
  // 兼容层：search-alias.js 仍是同一份实现的薄 re-export（外部引用不破）。
  assert.deepEqual(cjkFromCompatLayer("记忆"), cjkKeywordsOf("记忆"));
  assert.deepEqual(cjkKeywordsOf("记忆"), ["mnemon", "memory", "recall"], "别名展开保序去重");
  assert.deepEqual(cjkKeywordsOf("memory"), []);
  ok("E66 六类高频域全覆盖（表格/工单/仓库/导入导出/渲染/隧道），且 " + CJK_ALIASES.length + " 条别名条条被管线引用（无死别名）");
}

// ── 排序：五级优先级性质用例（不断言具体文案） ──────────────────────────────
{
  const ladder = [
    { name: "gate_status", description: "Report the gate status." },
    { name: "surface_gate", description: "List the surface." },
    { name: "gatekeeper_x", description: "A keeper." },
    { name: "misc_tool", description: "The gate is open." },
    { name: "other_tool", description: "gatekeeper helper." },
    { name: "noise_tool", description: "unrelated." },
  ];
  assert.deepEqual(
    namesOf(searchCatalog(ladder, "gate", 10)),
    ["gate_status", "surface_gate", "gatekeeper_x", "misc_tool", "other_tool"],
    "名字前缀 > 名字整词 > 词边界名字子串 > 说明整词 > 说明子串",
  );
  // 同分按名字字典序：确定性（同输入两次结果逐字节相同）。
  const tied = [
    { name: "zeta_sheet", description: "x" },
    { name: "alpha_sheet", description: "x" },
    { name: "beta_sheet", description: "x" },
  ];
  const once = namesOf(searchCatalog(tied, "sheet", 5));
  assert.deepEqual(once, ["alpha_sheet", "beta_sheet", "zeta_sheet"]);
  assert.deepEqual(namesOf(searchCatalog(tied, "sheet", 5)), once, "重复检索顺序稳定");
  ok("五级优先级与同分字典序：名前缀 > 名整词 > 名子串 > 说明整词 > 说明子串");
}

// ── 字节不变量：同输入两次逐字节相同；声明段集合与顺序与 0.5.7 逐字节一致 ──
{
  const tools = [
    { name: "dsh-ops_probe", description: "Probe the dsh-ops surface. Second sentence must not appear." },
    { name: "free_search_test", description: "Test every configured web search engine and report which ones work。" },
    { name: "mcp__wincu__fs_read", description: "Read one file through the Windows bridge." },
    { name: "office_docx", description: "Render an Office document to PDF for review." },
    { name: "univer_sheet", description: "Inspect structured Univer content and commit mutations to a draft。" },
    { name: "ssh_exec", description: "Execute a shell command on a REMOTE SSH host by alias。" },
    { name: "mnemon_remember", description: "Archive one durable insight in a selected provider-backed Memory Space." },
    { name: "agency_x", description: "" },
  ];
  // 0.5.7（git HEAD 的 lib/catalog.js）渲染这段固定输入的 golden 文本，逐字节比对。
  const GOLDEN = [
    "<gate-catalog>",
    "第二层（按需加载）：以下能力当前没有写进你的工具表，需要时按下面的方式取用。",
    "· 工具：先 gate_load([\"名字\"]) 加载，下一步即可直接调用；不确定名字就先 gate_search(\"关键词\")。",
    "· 段落/技能：同样用 gate_load 加载，加载后其内容会出现在后续提示词里。",
    "",
    "[dsh-ops]",
    "- dsh-ops_probe — Probe the dsh-ops surface",
    "[mcp]",
    "- mcp__wincu__fs_read — Read one file through the Windows bridge",
    "[office]",
    "- office_docx — Render an Office document to PDF for review",
    "[univer]",
    "- univer_sheet — Inspect structured Univer content and commit mutations to a dra…",
    "[ssh]",
    "- ssh_exec — Execute a shell command on a REMOTE SSH host by alias",
    "[mnemon]",
    "- mnemon_remember — Archive one durable insight in a selected provider-backed Memor…",
    "[agency]",
    "- agency_x",
    "[free]",
    "- free_search_test — Test every configured web search engine and report which ones w…",
    "</gate-catalog>",
  ].join("\n");
  const plan = { tools, sections: [], skills: [] };
  const rendered = renderCatalog(plan);
  assert.equal(rendered, GOLDEN, "目录声明段必须与 0.5.7 逐字节一致（改渲染路径前先想清楚）");
  assert.equal(renderCatalog(plan), rendered, "同一输入两次渲染逐字节相同");
  assert.equal(Buffer.byteLength(rendered, "utf8"), Buffer.byteLength(GOLDEN, "utf8"));
  const headers = rendered.split("\n").filter((line) => /^\[.+\]$/.test(line));
  assert.deepEqual(headers, ["[dsh-ops]", "[mcp]", "[office]", "[univer]", "[ssh]", "[mnemon]", "[agency]", "[free]"], "声明段的集合与顺序不变");
  assert.equal(rendered.includes("第二句"), false, "说明只取首句");

  // 更富的形态（段落 / 技能 / PTC 签名段）也要字节稳定。
  const rich = {
    frozen: true,
    tools: tools.concat([
      { name: "univer_doc", description: "Edit one document。", parameters: { type: "object", properties: { doc: { type: "string" }, sheet: { type: "string" } }, required: ["doc"] } },
    ]),
    sections: [{ name: "mcp:wincu", summary: "Windows 自动化段落。" }],
    skills: [
      { name: "alpha", description: "Alpha 技能", source: "宿主:pkg-a" },
      { name: "beta", description: "Beta 技能", source: "导入:local" },
    ],
  };
  const options = { signatureSummary: { enabled: true, tools: ["univer_doc"] } };
  const richFirst = renderCatalog(rich, options);
  assert.equal(renderCatalog(rich, options), richFirst, "PTC + 段落 + 技能 形态重复渲染逐字节一致");
  assert.ok(richFirst.includes("[签名]"), "PTC 冻结下签名段照旧出现");
  assert.ok(richFirst.includes("- univer_doc(doc, sheet?)"), richFirst);
  ok("字节不变量：同输入两次相同；声明段集合/顺序与 0.5.7 golden 逐字节一致（含 PTC 签名形态）");
}

console.log("\n全部通过 (" + passed + ")");
