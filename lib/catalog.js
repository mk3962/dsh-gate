/**
 * 目录渲染：把第二层的东西压成一段紧凑文本，插在系统提示词里（order 4900，PTC SDK 之前）。
 * 每行格式：名字 — 一句说明（取自工具真实 description 的首句，不是猜的）。
 *
 * 0.4.1：搜索加跨语言别名（见 search-alias.js）。目录字节不变 —— 别名只被 gate_search 读。
 * 0.5.1：新增「签名摘要」段（只对点名的按需工具、只在 PTC 冻结下渲染）。
 */

import { cjkKeywordsOf } from "./search-alias.js";

const GROUP_ORDER = ["宿主核心", "dsh-ops", "free-search", "MCP", "office", "univer", "ssh", "mnemon", "agency", "其他"];

/**
 * 组序表大小写不敏感：ownerOf("mcp__wincu__x") 返回小写 "mcp"，而表里写的是 "MCP"，
 * 以前 indexOf 找不到就排到最后一组（真实缺陷）。这里只归一查找，不改正组名。
 */
const GROUP_RANK = new Map(GROUP_ORDER.map((name, index) => [name.toLowerCase(), index]));

export function groupRank(group) {
  const rank = GROUP_RANK.get(String(group).toLowerCase());
  return rank === undefined ? 99 : rank;
}

export function ownerOf(name) {
  const cut = name.indexOf("_");
  if (cut <= 0) return name;
  return name.slice(0, cut);
}

export function firstSentence(text, limit) {
  if (typeof text !== "string") return "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  const stop = flat.search(/[。.!?！？；;]/);
  const head = stop > 0 ? flat.slice(0, stop) : flat;
  const max = limit > 0 ? limit : 64;
  return head.length > max ? head.slice(0, max - 1) + "…" : head;
}

/** 粗略 token 估算：CJK 1 字≈0.7 token，ASCII 3.75 字符≈1 token。只用于预算显示。 */
export function estimateTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  let cjk = 0;
  for (const ch of text) if (ch.codePointAt(0) > 0x2e80) cjk += 1;
  const ascii = text.length - cjk;
  return Math.round(cjk * 0.7 + ascii / 3.75);
}

/**
 * 签名摘要（0.5.1 票 01）—— 目录里给「点名的按需工具」加一行参数摘要：
 *   名字(必填参数, 可选参数?)
 *
 * 要解决的问题：PTC 冻结下模型写 run_code 时只能用 gate_invoke({ tool, arguments })，而目录
 * 原来只有名字 + 一句说明 —— 参数名得先 gate_load 拿签名，多一次往返、多一次输错的机会。
 *
 * 三条硬约束（改动前先读，别顺手「优化」掉）：
 *  1) 只给 catalog.signatureSummary.tools 里点名的工具出摘要，**按名字字典序**渲染。
 *     不按调用频率排：同一策略 + 同一工具集重复渲染必须逐字节一致，而频率会随会话漂移。
 *  2) 无 required 参数的工具不出摘要行：没有必填参数时摘要没有信息增量，只是白占前缀。
 *  3) 只在 PTC 冻结下渲染（options.ptcFrozen === true）。native 会话照旧「加载即进工具表」，
 *     目录里多一个字符都是每个请求都要重付的前缀 —— native 目录必须与 0.4.1 逐字节相同。
 *
 * 预算（目录增量 ≤ +2k tok）：签名几乎全是 ASCII，按 3.75 字符/token 反推
 *   ⇒ 2000 × 3.75 = 7,500 字符（SIGNATURE_BUDGET_CHARS）；逐条另有参数个数上限
 *   （SIGNATURE_MAX_PARAMS = 6）—— 参数再多摘要就失去意义，模型照样得去读 schema。
 */
export const SIGNATURE_MAX_PARAMS = 6;
export const SIGNATURE_BUDGET_CHARS = 7500;

/** 配置归一：支持布尔简写（true/false）与对象 { enabled, tools }；坏值按默认（开、空名单）。 */
export function normalizeSignatureSummary(raw) {
  if (raw === false) return { enabled: false, tools: [] };
  if (raw === true) return { enabled: true, tools: [] };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { enabled: true, tools: [] };
  const tools = [];
  const seen = new Set();
  for (const name of Array.isArray(raw.tools) ? raw.tools : []) {
    if (typeof name !== "string") continue;
    const trimmed = name.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    tools.push(trimmed);
  }
  return { enabled: raw.enabled !== false, tools };
}

/**
 * 单个工具的签名行（不含 "- " 前缀）。
 * 参数 = required 列表 + properties 名，必填在前、其余按 schema 声明顺序；必填不带后缀，
 * 可选带 ?。没有 properties 或没有 required 时返回 ""（不出行）。
 */
export function signatureLineOf(name, definition) {
  const parameters = definition && definition.parameters;
  const properties = parameters && parameters.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return "";
  const declared = Array.isArray(parameters.required)
    ? parameters.required.filter((key) => typeof key === "string" && key.length > 0)
    : [];
  if (declared.length === 0) return "";
  const required = [...new Set(declared)];
  const requiredSet = new Set(required);
  const optional = Object.keys(properties).filter((key) => !requiredSet.has(key));
  const names = required.concat(optional).slice(0, SIGNATURE_MAX_PARAMS);
  return name + "(" + names.map((key) => (requiredSet.has(key) ? key : key + "?")).join(", ") + ")";
}

/**
 * 渲染签名摘要行（不含块头）。顺序 = 名字字典序（与配置里的书写顺序无关）。
 * 预算满就停：超出的工具不再出摘要 —— 不截半行、不加省略号，保证结果可预测、字节稳定。
 */
export function renderSignatureLines(tools, options) {
  const opts = options || {};
  if (opts.ptcFrozen !== true) return [];
  const summary = normalizeSignatureSummary(opts.signatureSummary);
  if (!summary.enabled || summary.tools.length === 0) return [];
  const wanted = new Set(summary.tools);
  const definitions = opts.definitions;
  const rows = [];
  for (const entry of Array.isArray(tools) ? tools : []) {
    const name = entry && entry.name;
    if (typeof name !== "string" || !wanted.has(name)) continue;
    // 定义优先从 plan.definitions（name → 宿主 definition）取；测试/独立调用也可以把
    // parameters 直接挂在目录条目上。
    const definition = definitions && typeof definitions.get === "function" ? definitions.get(name) : undefined;
    const line = signatureLineOf(name, definition || entry);
    if (line.length > 0) rows.push(line);
  }
  rows.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out = [];
  let used = 0;
  for (const line of rows) {
    const cost = line.length + 1; // 行尾换行也算
    if (used + cost > SIGNATURE_BUDGET_CHARS) break;
    out.push(line);
    used += cost;
  }
  return out;
}

export function renderCatalog(plan, catalogOptions) {
  const options = catalogOptions || {};
  const limit = options.maxDescriptionLength || 64;
  const groups = new Map();
  const push = (group, line) => {
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(line);
  };

  for (const entry of plan.tools || []) {
    const owner = options.groupByPlugin === false ? "其他" : ownerOf(entry.name);
    const detail = firstSentence(entry.description, limit);
    push(owner, detail ? "- " + entry.name + " — " + detail : "- " + entry.name);
  }
  for (const entry of plan.sections || []) {
    push("段落", "- [段落] " + entry.name + (entry.summary ? " — " + firstSentence(entry.summary, limit) : ""));
  }
  // 技能行（0.4.1）：默认逐条列出；skillGroups=true 时按来源折叠成一行。
  // 依据（体检票 01）：57 条技能行占 5,585 字符 / 目录的 37.6%，而 7 天里真正被
  // gate_load 过的技能只有 5 个 —— 逐条列全是在为长尾付全价。折叠后 gate_search
  // 仍能按名字/说明/中文别名逐个命中，发现通道不受影响（这正是先修中文别名的原因）。
  const foldSkills = options.skillGroups === true;
  const skillBuckets = new Map();
  for (const entry of plan.skills || []) {
    const source = entry.source ? "（" + entry.source + "）" : "";
    if (!foldSkills) {
      const detail = entry.description ? " — " + firstSentence(entry.description, limit) : "";
      push("技能", "- [技能] " + entry.name + detail + source);
      continue;
    }
    // 折叠：按来源分桶，桶内只留名字。没有来源的归「其它」。
    const key = entry.source || "其它";
    if (!skillBuckets.has(key)) skillBuckets.set(key, []);
    skillBuckets.get(key).push(entry.name);
  }
  if (foldSkills) {
    // 每桶一行，全部落在 [技能] 组里。
    for (const [source, names] of [...skillBuckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      push("技能", "- [技能] " + source + " " + names.length + " 条：" + names.slice().sort().join(", "));
    }
  }

  if (groups.size === 0) return "";

  // 签名摘要段（0.5.1）：只在 PTC 冻结 + 策略点名时才有内容，位置固定在开头的用法说明之后、
  // 各分组之前 —— 不动既有分组的顺序，native 与否都保持组内逐字节不变。
  // 「是不是 PTC 冻结」是每个 agent 的事实，来自 gate 的 plan（plan.frozen），不是策略键。
  const signatureLines = renderSignatureLines(plan.tools, {
    ptcFrozen: plan.frozen === true,
    signatureSummary: options.signatureSummary,
    definitions: plan.definitions,
  });

  const body = [];
  body.push("<gate-catalog>");
  body.push("第二层（按需加载）：以下能力当前没有写进你的工具表，需要时按下面的方式取用。");
  // 用法行按「工具表冻没冻结」分叉（0.5.3 · 票 P1）：冻结下 gate_load 不改工具表，下一步只能用
  // gate_invoke —— 原来那句「下一步即可直接调用」在 PTC 里是错的，模型照着做会撞 unknown tool，
  // 等于目录自己在教一条失败的路径。native 分支保持原字节，别顺手统一。
  if (plan.frozen === true) {
    body.push("· 工具：先 gate_load([\"名字\"])，再用 gate_invoke({ tool, arguments }) 调用（工具表已冻结，加载不改工具表）；不确定名字就先 gate_search(\"关键词\")。");
  } else {
    body.push("· 工具：先 gate_load([\"名字\"]) 加载，下一步即可直接调用；不确定名字就先 gate_search(\"关键词\")。");
  }
  body.push("· 段落/技能：同样用 gate_load 加载，加载后其内容会出现在后续提示词里。");
  body.push("");
  if (signatureLines.length > 0) {
    body.push("[签名] 按需工具参数（? 表示可选；gate_invoke 的 arguments 照此写）");
    for (const line of signatureLines) body.push("- " + line);
    body.push("");
  }
  const order = [...groups.keys()].sort((a, b) => {
    // 大小写不敏感匹配（mcp / MCP 同一组序），组名本身照旧原样输出。
    return groupRank(a) - groupRank(b) || a.localeCompare(b);
  });
  for (const group of order) {
    body.push("[" + group + "]");
    for (const line of groups.get(group)) body.push(line);
  }
  body.push("</gate-catalog>");
  return body.join("\n");
}

/**
 * 搜索归一：下划线 / 连字符 / 点 全部折叠成空格，再压缩空白。
 *
 * 0.3.2 之前的 gate_search 只做逐字子串匹配，模型按自然语言写 "deck issue"、
 * "mnemon remember" 一律打空（实测 55 次里 23 次零命中，41.8%）——名字里是下划线，
 * 查询里是空格，两边永远碰不上。归一之后两侧都变成 "deck issue"，空格/下划线随便写。
 */
export function normalizeForSearch(text) {
  return String(text === undefined || text === null ? "" : text)
    .toLowerCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * gate_search 的匹配：名字、说明任一命中即算。
 *
 * 打分口径（高分在前）：
 *   100 归一名或原名完全相同 · 80 前缀 · 60 包含 · 55 多词全中名字
 *    40 多词全中名字或说明 · 30 说明包含 · 20 任一词（≥3 字符）命中名字
 * 多词那一档是「自然语言查询」的主要落点：模型写 "deck issue list" 也能命中
 * deck_issue_list，不必先猜出下划线。
 */
export function searchCatalog(entries, query, limit) {
  const raw = String(query === undefined || query === null ? "" : query).trim();
  const cap = limit || 20;
  const list = Array.isArray(entries) ? entries : [];
  if (raw.length === 0) return list.slice(0, cap);
  const flatQuery = raw.toLowerCase();
  const q = normalizeForSearch(raw);
  const tokens = q.split(" ").filter((token) => token.length > 0);
  const multi = tokens.length > 1;
  // 0.4.1 跨语言别名：名字与说明几乎全是 ASCII，中文查询在子串匹配上永远 0 分
  // （生产实测中文查询 91.2% 零命中）。命中别名词根按 25/15 档计 —— 低于精确/前缀/
  // 包含/说明包含（100/80/60/30），高于零，保证老行为不退化。
  const cjkWords = cjkKeywordsOf(raw);
  const scored = [];
  for (const entry of list) {
    const nameFlat = String(entry.name || "").toLowerCase();
    const nameNorm = normalizeForSearch(entry.name);
    const descNorm = normalizeForSearch(entry.description);
    let score = 0;
    if (nameFlat === flatQuery || nameNorm === q) score = 100;
    else if (nameFlat.startsWith(flatQuery) || nameNorm.startsWith(q)) score = 80;
    else if (nameFlat.includes(flatQuery) || nameNorm.includes(q)) score = 60;
    else if (multi && tokens.every((token) => nameNorm.includes(token))) score = 55;
    else if (multi && tokens.every((token) => nameNorm.includes(token) || descNorm.includes(token))) score = 40;
    else if (descNorm.includes(q)) score = 30;
    else if (tokens.some((token) => token.length >= 3 && nameNorm.includes(token))) score = 20;
    // 跨语言别名（0.4.1）：命中别名词根的名字记 25，只在说明里命中记 15。
    if (score === 0 && cjkWords.length > 0) {
      let inName = false;
      let inDesc = false;
      for (const word of cjkWords) {
        if (nameNorm.includes(word)) inName = true;
        else if (descNorm.includes(word)) inDesc = true;
      }
      if (inName) score = 25;
      else if (inDesc) score = 15;
    }
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.entry.name).localeCompare(String(b.entry.name)));
  return scored.slice(0, cap).map((hit) => hit.entry);
}
