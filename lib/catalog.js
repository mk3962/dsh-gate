/**
 * 目录渲染：把第二层的东西压成一段紧凑文本，插在系统提示词里（order 4900，PTC SDK 之前）。
 * 每行格式：名字 — 一句说明（取自工具真实 description 的首句，不是猜的）。
 *
 * 0.4.1：搜索加跨语言别名。目录字节不变 —— 别名只被 gate_search 读。
 * 0.5.1：新增「签名摘要」段（只对点名的按需工具、只在 PTC 冻结下渲染）。
 * 0.6.0（工单 #05 · 规格 D17）：本模块成为「目录渲染 + 检索 + 别名 + token 估算」的唯一实现：
 *   - 首句截断只在真句末断：半角句点必须后跟空白或行尾才算句界，扩展名 / 文件名 / 版本号 /
 *     URL / IP 里的点一律不是句界（以前 "v0.5.7 起" 被砍成 "v0"）；
 *   - 检索管线：归一化 → 分词（英文词元 + 中文词组与别名）→ 五级打分 → 中英两路各自计分后
 *     加权求和 → 截断（不再「英文有分就丢掉中文路」）；
 *   - 空查询（真空白 = 浏览全表）与纯符号 / 纯分隔符查询（返回空结果）分离；
 *   - limit 语义：缺省用默认、0 返回空、负数或非数抛 SearchLimitError（code INVALID_LIMIT / 400）；
 *   - token 估算按码点迭代，代理对按两个码元、宽字符与表情单独取系数；签名段预算按最终渲染
 *     字符串计算（块头 + "- " 前缀 + 行尾换行）并留安全余量；
 *   - 别名表合并进本模块（原来单独的 search-alias.js 退化为薄 re-export，外部引用不破）；
 *   - 分组与命名消费 ./naming.js（D6 的唯一实现），本模块不再自己维护一张组序表。
 *
 * 字节不变量（改这里之前先读）：目录文本格式本次不变更（OOS-2）。同一输入两次渲染必须逐字节
 * 相同，声明段的集合与顺序与 0.5.7 一致 —— 用例在 test/catalog-d17.test.mjs 与
 * test/catalog-signature.test.mjs 里，改渲染路径先把那几条断言跑一遍。
 */

import { groupRank as namingGroupRank, orderGroups, prefixOf } from "./naming.js";

/**
 * 组序权重：直接消费命名模块（D6）。历史约定不变 —— 大小写不敏感
 * （ownerOf("mcp__wincu__x") 返回小写 "mcp"，而表里写的是 "MCP"），组名本身原样输出。
 */
export function groupRank(group) {
  return namingGroupRank(group);
}

/**
 * 组名切分：第一个下划线之前（没有下划线时整名就是组名）。
 * 实现在 naming.js —— 全项目只此一处知道「名字怎么切」，这里只是目录侧的稳定出口。
 */
export function ownerOf(name) {
  return prefixOf(name);
}

// ── 首句截断（D17 / E61） ─────────────────────────────────────────────────────

/**
 * 句式终止符（中英文）总是边界；半角句点另有规则，见 isSentenceStopAt。
 * 换行也当边界：以前先压平空白再找句号，换行信息被抹掉，多行说明会被拼成一句。
 */
const SENTENCE_STOPS = new Set(["。", "！", "？", "!", "?", "；", ";", "\n", "\r", "\u2028", "\u2029"]);
const LEADING_STOPS_RE = /^[\s。！？!?；;]+/;
const NON_SPACE_RE = /\S/u;
const ELLIPSIS = "…";

/**
 * 单一规则，不维护扩展名白名单：
 *  - 半角 "." 只有「后面是空白或行尾」才是句界 ⇒ 0.5.7 / cordis.patch.yml / 127.0.0.1 /
 *    https://example.com/a.b 里的点全部天然安全（P2-3）；
 *  - 其余句式终止符（。！？!?；; 与换行）总是句界。
 */
function isSentenceStopAt(text, index) {
  const ch = text[index];
  if (ch === ".") {
    const next = text[index + 1];
    return next === undefined || /\s/.test(next);
  }
  return SENTENCE_STOPS.has(ch);
}

/** 按字符预算截断，且不把代理对切成半个（结果长度一定 ≤ max）。 */
function clipTo(text, max) {
  if (text.length <= max) return text;
  const budget = max - ELLIPSIS.length;
  if (budget <= 0) return ELLIPSIS.slice(0, Math.max(0, max));
  // 不额外裁掉行尾空格：0.5.7 的截断结果就是「前 max-1 个字符 + …」，保持逐字节一致。
  let head = text.slice(0, budget);
  const lastCode = head.charCodeAt(head.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) head = head.slice(0, -1);
  return head + ELLIPSIS;
}

/**
 * 首句：只在真句末截断。
 *  - 首字符即终止符时忽略它本身，继续找下一个真句末（不产空串）；
 *  - 整段只有空白 / 终止符时返回 ""（调用方据此不出说明）；
 *  - 超过 limit 才截断，截断结果带省略号且长度不超过 limit。
 */
export function firstSentence(text, limit) {
  if (typeof text !== "string") return "";
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 64;
  let stop = -1;
  let seenContent = false;
  for (let index = 0; index < text.length; index += 1) {
    if (!isSentenceStopAt(text, index)) {
      if (!seenContent && NON_SPACE_RE.test(text[index])) seenContent = true;
      continue;
    }
    // 句界之前没有任何实义字符（只有空白 / 终止符）⇒ 这不是句界，跳过。
    if (!seenContent) continue;
    stop = index;
    break;
  }
  const head = (stop < 0 ? text : text.slice(0, stop))
    .replace(LEADING_STOPS_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (head.length === 0) return "";
  return clipTo(head, max);
}

// ── token 估算（D17 / E65） ──────────────────────────────────────────────────

/** ASCII 约 3.75 字符 / token（历史口径，README 与成本表都按它折算）。 */
export const TOKEN_CHARS_PER_ASCII = 3.75;
/** 宽字符（CJK / 全角）每码元的系数。 */
export const TOKEN_WEIGHT_WIDE = 0.7;
/** 代理对（emoji 等）两个码元整体系数：2 × 0.7。 */
export const TOKEN_WEIGHT_ASTRAL = 2 * TOKEN_WEIGHT_WIDE;

/**
 * 粗略 token 估算：只用于预算显示与预算判断。
 *
 * 按码点迭代（for...of 给的是一次一个码点），所以：
 *  - 代理对（emoji 等）按**两个码元**计 —— 以前用 text.length - cjk 反推 ASCII 数，
 *    代理对会把 ASCII 数算多一个，预算低估；这里显式给两个码元的权重；
 *  - CJK / 全角宽字符单独取系数（TOKEN_WEIGHT_WIDE）；
 *  - 其余按 ASCII 3.75 字符 / token。
 */
export function estimateTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  let tokens = 0;
  for (const ch of text) {
    if (ch.length > 1) {
      // 代理对：一个码点两个码元，按两个码元的宽字符系数计。
      tokens += TOKEN_WEIGHT_ASTRAL;
      continue;
    }
    const code = ch.codePointAt(0);
    tokens += code > 0x2e80 ? TOKEN_WEIGHT_WIDE : 1 / TOKEN_CHARS_PER_ASCII;
  }
  return Math.round(tokens);
}

// ── 签名摘要（0.5.1 票 01） ──────────────────────────────────────────────────

/**
 * 签名摘要 —— 目录里给「点名的按需工具」加一行参数摘要：
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
 * 预算（目录增量 ≤ +2k tok）：按 renderSignatureLines 的**最终渲染字符串**计 —— 块头
 * （SIGNATURE_BLOCK_HEADER）+ 每行 "- " 前缀 + 行尾换行都算，再留 SIGNATURE_BUDGET_MARGIN_CHARS
 * 的安全余量。逐条另有参数个数上限（SIGNATURE_MAX_PARAMS = 6）—— 参数再多摘要就失去意义。
 */
export const SIGNATURE_MAX_PARAMS = 6;
/** 历史字符预算（≈2k tok，README 成本表按它折算）。 */
export const SIGNATURE_BUDGET_CHARS = 7500;
/** token 预算是同一笔账的另一种说法（7500 字符 ≈ 2000 tok），越界即停。 */
export const SIGNATURE_BUDGET_TOKENS = 2000;
/** 安全余量：块头 / 前缀 / 分隔符 / 取整误差的缓冲，不拿来堆签名行。 */
export const SIGNATURE_BUDGET_MARGIN_CHARS = 300;
/** 签名块可用的字符预算（已扣掉安全余量）。 */
export const SIGNATURE_BLOCK_BUDGET_CHARS = SIGNATURE_BUDGET_CHARS - SIGNATURE_BUDGET_MARGIN_CHARS;
/** 签名块块头（renderCatalog 与预算计算共用同一份，避免两处漂移）。 */
export const SIGNATURE_BLOCK_HEADER = "[签名] 按需工具参数（? 表示可选；gate_invoke 的 arguments 照此写）";

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
 * 签名块的**最终渲染增量**（字符）：块头 + 行尾换行 + 每行 "- " 前缀 + 行尾换行。
 * 预算按这个数走，不按「行文本长度」走 —— 前缀与块头也是每个请求都要重付的前缀。
 */
export function signatureBlockCost(lines) {
  const rows = Array.isArray(lines) ? lines : [];
  if (rows.length === 0) return 0;
  let used = SIGNATURE_BLOCK_HEADER.length + 1;
  for (const line of rows) used += 2 + String(line).length + 1;
  return used;
}

/** 签名块的最终渲染文本（不含末尾空行）；测试与预算共用。 */
export function signatureBlockText(lines) {
  const rows = Array.isArray(lines) ? lines : [];
  if (rows.length === 0) return "";
  return SIGNATURE_BLOCK_HEADER + "\n" + rows.map((line) => "- " + line).join("\n");
}

/** 签名块的 token 估算（estimatetokens 口径，按最终渲染文本算）。 */
export function signatureBlockTokens(lines) {
  return estimateTokens(signatureBlockText(lines));
}

/**
 * 渲染签名摘要行（不含块头）。顺序 = 名字字典序（与配置里的书写顺序无关）。
 * 预算满就停：超出的工具不再出摘要 —— 不截半行、不加省略号，保证结果可预测、字节稳定。
 * 两条预算同时守：字符（含块头 / 前缀 / 换行，已留余量）与 token。
 */
export function renderSignatureLines(tools, options) {
  const opts = options !== null && typeof options === "object" ? options : {};
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
  for (const line of rows) {
    const candidate = out.concat(line);
    if (signatureBlockCost(candidate) > SIGNATURE_BLOCK_BUDGET_CHARS) break;
    if (estimateTokens(signatureBlockText(candidate)) > SIGNATURE_BUDGET_TOKENS) break;
    out.push(line);
  }
  return out;
}

// ── 目录渲染 ─────────────────────────────────────────────────────────────────

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
    body.push(SIGNATURE_BLOCK_HEADER);
    for (const line of signatureLines) body.push("- " + line);
    body.push("");
  }
  const order = orderGroups([...groups.keys()]);
  for (const group of order) {
    body.push("[" + group + "]");
    for (const line of groups.get(group)) body.push(line);
  }
  body.push("</gate-catalog>");
  return body.join("\n");
}

// ── 检索：归一化 / 分词 / 别名 / 计分 ───────────────────────────────────────

/**
 * 搜索归一：下划线 / 连字符 / 点 全部折叠成空格，再压缩空白。
 *
 * 0.3.2 之前的 gate_search 只做逐字子串匹配，模型按自然语言写 "deck issue"、
 * "mnemon remember" 一律打空（实测 55 次里 23 次零命中，41.8%）—— 名字里是下划线，
 * 查询里是空格，两边永远碰不上。归一之后两侧都变成 "deck issue"，空格/下划线随便写。
 */
export function normalizeForSearch(text) {
  return String(text === undefined || text === null ? "" : text)
    .toLowerCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
/** 查询里至少要有一个字母或数字，否则是纯符号 / 纯分隔符（E62）。 */
const MEANINGFUL_QUERY_RE = /[\p{L}\p{N}]/u;

/** 查询里是否含 CJK（决定要不要走别名展开）。 */
export function hasCjk(text) {
  return CJK_CHAR_RE.test(String(text === undefined || text === null ? "" : text));
}

/**
 * 中文 → 英文词根的别名索引（0.4.1 起；0.6.0 合并进本模块，search-alias.js 变薄 re-export）。
 *
 * 真实缺陷（体检票 03 / 2026-11-14）：gate_search 对中文查询 91.2% 零命中。
 * 名字（mnemon_remember / weather / terminal_open）与 description 几乎全是 ASCII，
 * 模型按用户语言写「记忆」「天气」时，子串匹配永远不可能命中。
 *
 * 口径：每个中文词映射到「真名或说明里一定会出现的英文词根」。词根走**词边界**匹配，
 * 长度小于 3 的词根只认整词（E63 / P2-4：搜「界面」不许因为 "ui" 子串命中 build/require/uuid）。
 * 覆盖六类高频域（E66）：表格、工单、仓库、导入导出、渲染、隧道 —— 见 ALIAS_DOMAINS。
 */
export const CJK_ALIASES = Object.freeze([
  ["记忆", ["mnemon", "memory", "recall"]],
  ["回忆", ["mnemon", "recall", "memory"]],
  ["遗忘", ["mnemon", "forget"]],
  ["文档", ["document", "doc", "docx", "word"]],
  ["表格", ["sheet", "excel", "xlsx", "csv", "univer"]],
  ["幻灯片", ["slide", "pptx", "ppt"]],
  ["演示", ["slide", "pptx"]],
  ["天气", ["weather"]],
  ["汇率", ["finance", "currency"]],
  ["搜索", ["search"]],
  ["检索", ["search", "recall"]],
  ["终端", ["terminal", "pty"]],
  ["进程", ["process", "job", "ps"]],
  ["任务", ["job", "task", "todo", "schedule"]],
  ["计划", ["schedule", "plan", "todo"]],
  ["定时", ["schedule", "cron"]],
  ["通知", ["notify", "notifications"]],
  ["截图", ["screenshot", "image"]],
  ["图片", ["image", "picture"]],
  ["视频", ["video"]],
  ["音频", ["audio"]],
  ["语音", ["audio", "voice"]],
  ["专家", ["expert", "agency"]],
  ["团队", ["team", "expert"]],
  ["子代理", ["subagent", "agent"]],
  ["代理", ["subagent", "agent", "proxy"]],
  ["代码", ["code", "shell", "exec"]],
  ["执行", ["exec", "run", "pwsh", "shell"]],
  ["命令", ["command", "pwsh", "shell"]],
  ["文件", ["file", "read", "write", "glob"]],
  ["目录", ["directory", "glob", "list"]],
  ["编辑", ["edit", "write"]],
  ["写入", ["write"]],
  ["读取", ["read"]],
  ["网络", ["web", "fetch", "http"]],
  ["网页", ["web", "fetch", "url"]],
  ["浏览器", ["browser", "web"]],
  ["远程", ["ssh", "remote"]],
  ["主机", ["host", "ssh"]],
  ["压缩", ["compress", "context"]],
  ["上下文", ["context", "compress"]],
  ["会话", ["session"]],
  ["历史", ["session", "trace", "history"]],
  ["追踪", ["trace", "session"]],
  ["渲染", ["render", "preview", "diagram", "mermaid", "ui"]],
  ["界面", ["ui", "render"]],
  ["组件", ["ui", "component"]],
  ["数据库", ["database", "sql", "db"]],
  ["服务", ["server", "service", "mcp"]],
  ["工具", ["tool"]],
  ["技能", ["skill"]],
  ["段落", ["section"]],
  ["策略", ["policy", "gate"]],
  ["闸门", ["gate"]],
  ["刷新", ["refresh", "reload"]],
  ["重启", ["restart", "reload"]],
  ["安装", ["install", "add"]],
  ["卸载", ["uninstall", "remove"]],
  ["升级", ["update", "upgrade"]],
  ["版本", ["version"]],
  ["日志", ["log"]],
  ["调试", ["debug"]],
  ["测试", ["test"]],
  ["运行", ["run", "exec"]],
  ["启动", ["start", "boot"]],
  ["停止", ["stop", "kill"]],
  ["删除", ["delete", "remove", "forget"]],
  ["创建", ["create", "new"]],
  ["更新", ["update", "edit"]],
  ["查询", ["query", "search", "get", "list"]],
  ["列表", ["list"]],
  ["状态", ["status", "state"]],
  ["配置", ["config", "setting"]],
  ["设置", ["config", "setting"]],
  ["权限", ["permission", "auth"]],
  ["安全", ["security", "safe"]],
  ["成本", ["cost", "usage"]],
  ["用量", ["usage", "cost"]],
  ["模型", ["model", "llm"]],
  ["提示词", ["prompt"]],
  ["邮件", ["mail", "email"]],
  ["表格数据", ["sheet", "data"]],
  // ── 六类高频域（E66）──────────────────────────────────────────────────────
  ["工单", ["deck", "issue", "ticket", "kanban"]],
  ["看板", ["kanban", "deck", "board"]],
  ["仓库", ["git", "repo", "branch", "commit"]],
  ["代码库", ["git", "repo"]],
  ["分支", ["branch", "git"]],
  ["提交", ["commit", "git"]],
  ["导入", ["import", "ingest"]],
  ["导出", ["export"]],
  ["备份", ["backup", "snapshot"]],
  ["迁移", ["migrate", "migration"]],
  ["预览", ["preview", "render"]],
  ["图表", ["diagram", "chart", "mermaid"]],
  ["流程图", ["diagram", "mermaid"]],
  ["隧道", ["tunnel", "frp", "proxy", "port", "expose"]],
  ["端口", ["port", "listen"]],
  ["转发", ["forward", "proxy", "tunnel"]],
  ["内网", ["tunnel", "proxy"]],
]);

/**
 * 六类高频域 → 该域的中文查询词（E66 的验收口径）。
 * 用例遍历这张表：每个域至少一个中文词必须能命中最典型的工具。
 */
export const ALIAS_DOMAINS = Object.freeze({
  sheet: ["表格", "表格数据"],
  issue: ["工单", "看板"],
  repo: ["仓库", "分支", "提交"],
  transfer: ["导入", "导出", "备份", "迁移"],
  render: ["渲染", "预览", "图表", "流程图"],
  tunnel: ["隧道", "端口", "转发"],
});

/** 把查询里出现的中文词展开成英文词根（去重、保序）。 */
export function cjkKeywordsOf(text) {
  const raw = String(text === undefined || text === null ? "" : text);
  if (!hasCjk(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const [zh, en] of CJK_ALIASES) {
    if (!raw.includes(zh)) continue;
    for (const word of en) {
      if (seen.has(word)) continue;
      seen.add(word);
      out.push(word);
    }
  }
  return out;
}

/** 查询里的连续中文片段（保留原词，用于中文名字 / 中文说明的直接子串匹配）。 */
export function cjkTermsOf(text) {
  const raw = String(text === undefined || text === null ? "" : text);
  if (!hasCjk(raw)) return [];
  return raw.match(CJK_RUN_RE) || [];
}

// ── 检索：limit 语义（E65） ─────────────────────────────────────────────────

/** 检索默认上限：缺省（undefined / null）时用它。 */
export const SEARCH_DEFAULT_LIMIT = 20;
/** 单次检索硬上限：再多也读不完，服务层同样收到这个天花板。 */
export const SEARCH_MAX_LIMIT = 50;
/** 名字 / 说明的子串匹配要求的最小词元长度（更短只能整词命中）。 */
export const SEARCH_MIN_TOKEN_LENGTH = 3;

/**
 * 非法 limit 的可识别错误：服务层据此转 400（code / status 都在实例上）。
 * 以前 limit=0 与 limit=-1 都退化成「不限制」，检索结果爆量（P2-2），这里显式拒绝。
 */
export class SearchLimitError extends Error {
  constructor(message) {
    super(message || "limit 必须是 ≥ 0 的有限数字：0 返回空结果，缺省用默认上限；负数或非数不接受");
    this.name = "SearchLimitError";
    this.code = "INVALID_LIMIT";
    this.status = 400;
  }
}

/**
 * limit 归一：
 *  - undefined / null ⇒ 默认上限（SEARCH_DEFAULT_LIMIT）
 *  - 0 ⇒ 0（调用方据此返回空结果）
 *  - 正数（含数字字符串）⇒ floor，并封顶 SEARCH_MAX_LIMIT
 *  - 负数 / NaN / Infinity / 非数字字符串 / 其它类型 ⇒ 抛 SearchLimitError
 */
export function normalizeSearchLimit(limit, fallback) {
  const base = Number.isFinite(fallback) && fallback >= 0 ? Math.floor(fallback) : SEARCH_DEFAULT_LIMIT;
  if (limit === undefined || limit === null) return base;
  let value;
  if (typeof limit === "number") value = limit;
  else if (typeof limit === "string" && limit.trim() !== "") value = Number(limit);
  else throw new SearchLimitError();
  if (!Number.isFinite(value) || value < 0) throw new SearchLimitError();
  if (value === 0) return 0;
  return Math.min(SEARCH_MAX_LIMIT, Math.floor(value));
}

/**
 * 查询是否有意义（E62）：
 *  - 真空白（"" 或纯空格）⇒ 无意义，调用方按「浏览全表」处理（保留既有契约）；
 *  - 非空但归一化后为空、或一个字母/数字都没有（"---" / "???" / "..." / "///"）⇒ 无意义。
 */
export function isMeaningfulQuery(query) {
  const raw = String(query === undefined || query === null ? "" : query).trim();
  if (raw.length === 0) return false;
  const normalized = normalizeForSearch(raw);
  if (normalized.length === 0) return false;
  return MEANINGFUL_QUERY_RE.test(normalized);
}

// ── 检索：五级计分 + 中英双路融合（E63 / E64） ──────────────────────────────

/** 五级优先级（分高在前）。exactName 是 namePrefix 的特例，单独留一档以保老行为。 */
export const SEARCH_SCORES = Object.freeze({
  exactName: 120,
  namePrefix: 100,
  nameWord: 80,
  nameSubstring: 60,
  descWord: 40,
  descSubstring: 20,
});

/** 两路权重：中英各自计分后相加（等权即「任一路有分都保留」，不是英文有分就丢中文）。 */
export const SEARCH_PATH_WEIGHTS = Object.freeze({ latin: 1, cjk: 1 });

const tokensOf = (normalized) => normalized.split(" ").filter((token) => token.length > 0);

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * 词边界判定的统一口径：**前后不是字母或数字**（含 CJK）就是边界。
 * 归一化把下划线/连字符/点折成了空格，但冒号、斜杠等仍是分隔符 —— 所以
 * "office xlsx" 必须能命中 skill:office-xlsx（冒号是边界），却永远不能命中
 * build / require / uuid / guide 里的 ui（前面是字母，不是边界）。
 */
function hasBoundaryMatch(text, needle) {
  if (text.length === 0 || needle.length === 0) return false;
  const escaped = needle.replace(REGEXP_SPECIALS, "\\$&");
  return new RegExp("(^|[^\\p{L}\\p{N}])" + escaped, "u").test(text);
}

/**
 * 整段匹配（说明档的最低两档用）：只要求**从词首起算**，允许接在更长的词里 ——
 * 所以「gate」能落到说明里的 "gatekeeper"（最低档 20），而 build / require / uuid 里的
 * ui 依然命不中（那里 ui 前面是字母，不是词首）。
 */
function hasBoundaryPhrase(text, phrase) {
  if (text.length === 0 || phrase.length === 0) return false;
  const escaped = phrase.replace(REGEXP_SPECIALS, "\\$&");
  return new RegExp("(^|[^\\p{L}\\p{N}])" + escaped, "u").test(text);
}

/** 名字的**词**前缀（不是字符前缀）：query "gate" 不能把 "gatekeeper" 当自己的前缀档。 */
function startsWithWords(nameWords, tokens) {
  if (tokens.length > nameWords.length) return false;
  for (let index = 0; index < tokens.length; index += 1) {
    if (nameWords[index] !== tokens[index]) return false;
  }
  return true;
}

/**
 * 一组词元对一个条目的五级打分（0 = 不命中）：
 *   名字前缀 → 名字整词 → 名字子串（词边界 + 每个词元长度 ≥ 3）→ 说明整词 → 说明子串（词边界）。
 * 「词边界」= 前后不是字母或数字（见 hasBoundaryMatch）：子串必须从一个词的开头起算，所以
 * "ui" 永远命不中 build / require / uuid / guide（P2-4），短词元只在整词档出现；
 * 冒号 / 斜杠这类分隔符仍是边界，所以 "office xlsx" 照样命中 skill:office-xlsx。
 */
function scoreTokens(nameNorm, nameWords, nameTokens, descNorm, descTokens, tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return 0;
  const phrase = tokens.join(" ");
  if (startsWithWords(nameWords, tokens)) return SEARCH_SCORES.namePrefix;
  if (tokens.every((token) => nameTokens.has(token))) return SEARCH_SCORES.nameWord;
  if (tokens.every((token) => token.length >= SEARCH_MIN_TOKEN_LENGTH && hasBoundaryMatch(nameNorm, token))) {
    return SEARCH_SCORES.nameSubstring;
  }
  if (tokens.every((token) => descTokens.has(token))) return SEARCH_SCORES.descWord;
  if (hasBoundaryPhrase(descNorm, phrase)) return SEARCH_SCORES.descSubstring;
  return 0;
}

/** 别名词根展开：去重、去空，并剔除英文路已经覆盖的词根（避免同一路重复计分）。 */
function aliasTokenGroupsOf(raw, latinTokens) {
  const latin = new Set(latinTokens);
  const groups = [];
  for (const root of cjkKeywordsOf(raw)) {
    const words = tokensOf(normalizeForSearch(root));
    if (words.length === 0) continue;
    if (words.every((word) => latin.has(word))) continue;
    groups.push(words);
  }
  return groups;
}

/** 中文路：别名词根各算一次取最高档，再加「中文原词直接出现在名字/说明里」的兜底档。 */
function cjkScoreOf(aliasGroups, cjkTerms, nameNorm, nameWords, nameTokens, descNorm, descTokens) {
  let best = 0;
  for (const words of aliasGroups) {
    const score = scoreTokens(nameNorm, nameWords, nameTokens, descNorm, descTokens, words);
    if (score > best) best = score;
  }
  for (const term of cjkTerms) {
    if (term.length < 2) continue;
    if (nameNorm.includes(term)) {
      if (best < SEARCH_SCORES.nameSubstring) best = SEARCH_SCORES.nameSubstring;
      continue;
    }
    if (descNorm.includes(term) && best < SEARCH_SCORES.descSubstring) best = SEARCH_SCORES.descSubstring;
  }
  return best;
}

/**
 * gate_search 的检索管线：归一化 → 分词（英文词元 + 中文词组与别名）→ 五级打分 →
 * 中英两路各计分后加权求和 → 截断。
 *
 *  - 真空白查询 = 浏览全表（原契约，返回前 cap 条，保持输入顺序）；
 *  - 非空但无实义（"---" / "???" / "..." / "///"）= 空结果（E62，不再捞全表）；
 *  - limit：0 ⇒ []，缺省 ⇒ 默认，负数 / 非数 ⇒ 抛 SearchLimitError（code INVALID_LIMIT，服务层 400）；
 *  - 排序：分数降序，同分按名字字典序 —— 同一输入两次结果逐字节相同。
 */
export function searchCatalog(entries, query, limit = SEARCH_DEFAULT_LIMIT) {
  const list = Array.isArray(entries) ? entries : [];
  const cap = normalizeSearchLimit(limit);
  const raw = String(query === undefined || query === null ? "" : query).trim();
  if (raw.length === 0) return cap === 0 ? [] : list.slice(0, cap);
  if (!isMeaningfulQuery(raw)) return [];
  if (cap === 0) return [];

  const q = normalizeForSearch(raw);
  const latinTokens = tokensOf(q).filter((token) => !hasCjk(token));
  const aliasGroups = aliasTokenGroupsOf(raw, latinTokens);
  const cjkTerms = cjkTermsOf(raw);
  const scored = [];
  for (const entry of list) {
    const nameNorm = normalizeForSearch(entry && entry.name);
    const descNorm = normalizeForSearch(entry && entry.description);
    const nameWords = tokensOf(nameNorm);
    const nameTokens = new Set(nameWords);
    const descTokens = new Set(tokensOf(descNorm));
    const latinScore = nameNorm.length > 0 && nameNorm === q
      ? SEARCH_SCORES.exactName
      : scoreTokens(nameNorm, nameWords, nameTokens, descNorm, descTokens, latinTokens);
    const cjkScore = cjkScoreOf(aliasGroups, cjkTerms, nameNorm, nameWords, nameTokens, descNorm, descTokens);
    const score = latinScore * SEARCH_PATH_WEIGHTS.latin + cjkScore * SEARCH_PATH_WEIGHTS.cjk;
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.entry && a.entry.name).localeCompare(String(b.entry && b.entry.name)));
  return scored.slice(0, cap).map((hit) => hit.entry);
}

/**
 * 检索的服务层包装：非法 limit 不抛给宿主，转成 { error, status } 供服务层回 400。
 * 只在这里做错误翻译，领域层的 searchCatalog 仍然「坏输入显式失败」。
 */
export function searchCatalogResult(entries, query, limit) {
  try {
    return { results: searchCatalog(entries, query, limit) };
  } catch (error) {
    if (error && error.code === "INVALID_LIMIT") {
      return { error: error.code, status: error.status, message: error.message };
    }
    throw error;
  }
}
