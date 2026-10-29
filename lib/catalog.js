/**
 * 目录渲染：把第二层的东西压成一段紧凑文本，插在系统提示词里（order 4900，PTC SDK 之前）。
 * 每行格式：名字 — 一句说明（取自工具真实 description 的首句，不是猜的）。
 */

const GROUP_ORDER = ["宿主核心", "dsh-ops", "free-search", "MCP", "office", "univer", "ssh", "mnemon", "agency", "其他"];

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
  for (const entry of plan.skills || []) {
    push("技能", "- [技能] " + entry.name + (entry.description ? " — " + firstSentence(entry.description, limit) : ""));
  }

  if (groups.size === 0) return "";
  const body = [];
  body.push("<gate-catalog>");
  body.push("第二层（按需加载）：以下能力当前没有写进你的工具表，需要时按下面的方式取用。");
  body.push("· 工具：先 gate_load([\"名字\"]) 加载，下一步即可直接调用；不确定名字就先 gate_search(\"关键词\")。");
  body.push("· 段落/技能：同样用 gate_load 加载，加载后其内容会出现在后续提示词里。");
  body.push("");
  const order = [...groups.keys()].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a);
    const ib = GROUP_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  for (const group of order) {
    body.push("[" + group + "]");
    for (const line of groups.get(group)) body.push(line);
  }
  body.push("</gate-catalog>");
  return body.join("\n");
}

/** gate_search 的匹配：名字、说明、归属任一命中即算。 */
export function searchCatalog(entries, query, limit) {
  const q = String(query || "").toLowerCase().trim();
  if (q.length === 0) return entries.slice(0, limit || 20);
  const scored = [];
  for (const entry of entries) {
    const name = String(entry.name || "").toLowerCase();
    const desc = String(entry.description || "").toLowerCase();
    let score = 0;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (desc.includes(q)) score = 30;
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.entry.name).localeCompare(String(b.entry.name)));
  return scored.slice(0, limit || 20).map((hit) => hit.entry);
}
