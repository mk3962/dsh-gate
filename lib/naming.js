/**
 * 命名与分组（0.6.0 工单 #03 · 规格 D6）—— 全项目**唯一**一处知道"名字怎么切"的模块。
 *
 * 谁需要它：能力 id 构造（capabilities）、目录分组（catalog）、技能来源标签（skills）、
 * 面板分组与排序权重。以前这些切法散在三个文件里，改一处就漂一处：
 *   - capabilityIdOfToolName 按第一个下划线切插件前缀；
 *   - catalog.ownerOf 按第一个下划线切分组名；
 *   - skills.skillSourceLabel 自己拼"宿主:/导入:"。
 *
 * 依赖纪律（领域层）：只依赖 lib/tiers.js 与标准库。
 */
import { matches, specificity } from "./tiers.js";

/**
 * 已知插件包前缀 → npm 包名（能力 id 用包名，与 docs 的 plugin:<包名> 一致）。
 * 只是**推断兜底**（低置信）：显式 sources 永远压过它。
 */
export const PLUGIN_PREFIXES = Object.freeze({
  univer: "dsh-univer-office",
  ssh: "@linxin666/dsh-ssh",
  mnemon: "dsh-mnemon",
  office: "dsh-office-tools",
  excel: "dsh-office-tools",
  word: "dsh-office-tools",
  ppt: "dsh-office-tools",
  comfyui: "dsh-comfyui",
  design: "dsh-ui-ux-pro-max",
  deck: "dsh-mattpocock-skills-deck",
  bsk: "@wxg-prc-cpg/browser-skill-dsh-plugin",
  free: "dsh-free-search",
  unlag: "dsh-unlag",
  fnos: "fnos-cli",
});

/**
 * 技能名 → 工具前缀的**显式别名表**（非同名族的唯一事实源）。
 *
 * 为什么必须有一张表：族切分原本只取技能名第一段（`browser-skill` → `browser`），
 * 但插件的工具前缀可以完全不同（`@wxg-prc-cpg/browser-skill-dsh-plugin` 的工具全是 `bsk_*`）。
 * 于是技能加载成功、激活信号也送到了，族内却一个工具都放不出来（0.7.1 真机缺陷）。
 *
 * 只写「读源码核实过」的映射：猜错的代价是把别的族误放回工具表（0.5.3 那次前缀失效）。
 * 值一律是**前缀数组**：一个技能可以放出多个前缀族（例如将来对外改名时保留旧前缀）。
 */
export const SKILL_TOOL_PREFIXES = Object.freeze({
  "browser-skill": Object.freeze(["bsk"]),
});

/** 工具前缀的标识符形状（族前缀与技能名第一段共用这一条判据）。 */
export const TOOL_PREFIX_RE = /^[a-z][a-z0-9]*$/i;

/** 是不是合法的工具前缀（字母开头、只含字母数字）。 */
export function isToolPrefix(value) {
  return typeof value === "string" && TOOL_PREFIX_RE.test(value);
}

/**
 * 技能名 → 该技能能放出的工具前缀集合（**双向单一事实源**的 skill→prefix 方向）。
 *
 * 两条判据（改这里之前先读）：
 *  1) 命中 {@link SKILL_TOOL_PREFIXES} 的显式映射 ⇒ **精确按该前缀集**匹配（不再叠加首段），
 *     因为首段往往与插件工具前缀毫无关系（`browser-skill` 的首段 `browser` 在本例里一个工具都不存在）；
 *  2) 未命中 ⇒ 回退技能名第一段（`univer-sheet` → `univer`，与 0.5.4 起的行为逐字节一致），
 *     第一段不是标识符形状时返回空数组（宁可不放，也不误放）。
 *
 * @param {string} skillName 技能名（允许带 `skill:` 前缀，函数自己剥）
 * @returns {string[]} 前缀集合；切不出族时返回空数组
 */
export function toolPrefixesForSkill(skillName) {
  const name = typeof skillName === "string" ? skillName.replace(/^skill:/, "").trim() : "";
  if (name.length === 0) return [];
  const explicit = Object.prototype.hasOwnProperty.call(SKILL_TOOL_PREFIXES, name)
    ? SKILL_TOOL_PREFIXES[name]
    : Object.prototype.hasOwnProperty.call(SKILL_TOOL_PREFIXES, name.toLowerCase())
      ? SKILL_TOOL_PREFIXES[name.toLowerCase()]
      : undefined;
  if (Array.isArray(explicit)) {
    const kept = explicit.filter(isToolPrefix);
    if (kept.length > 0) return kept.slice();
  }
  const first = name.split("-")[0];
  return isToolPrefix(first) ? [first] : [];
}

/**
 * 工具前缀 → 显式映射到它的技能名（reverse 方向：排障与面板提示用）。
 * 只反映显式别名表；未登记的前缀返回空数组，绝不按「首段相同」反推。
 */
export function skillsForToolPrefix(prefix) {
  if (!isToolPrefix(prefix)) return [];
  // 大小写不敏感：与 TOOL_PREFIX_RE、toolPrefixesForSkill 的口径一致（表里的值未必是全小写）。
  const wanted = prefix.toLowerCase();
  const out = [];
  for (const [skill, prefixes] of Object.entries(SKILL_TOOL_PREFIXES)) {
    if (Array.isArray(prefixes) && prefixes.some((value) => typeof value === "string" && value.toLowerCase() === wanted)) out.push(skill);
  }
  return out.sort();
}

/** dsh 原生工具名：单工具成能力，不并组（把 read/write/pwsh 绑成一个开关是错的）。 */
export const NATIVE_TOOL_NAMES = Object.freeze(new Set([
  "run_code",
  "read", "write", "edit", "grep", "glob", "pwsh",
  "web_search", "web_fetch",
  "skill",
  "todo_write", "present", "read_image", "ask_user_question", "send_message",
  "list_agents", "list_subagent_models", "subagent", "subagent_fork", "interrupt_agent",
  "job_output", "job_list", "job_kill",
  "compress", "decompress", "search_context", "acp_status", "acp_cache", "acp_read_original_image",
  "validate_dsh_ui", "render_ui",
  "schedule_create", "schedule_list", "schedule_view", "schedule_edit", "schedule_delete",
  "get_goal", "create_goal", "update_goal", "exit_plan_mode", "ralph",
  "session_search", "session_event_search", "session_trace", "session_event_trace", "session_event_read",
  "terminal_open", "terminal_send", "terminal_read", "terminal_signal", "terminal_close", "terminal_list",
  "working_directory", "suggest_next_steps", "load_workspace_dependencies",
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
  "weather", "video_search", "platform_search", "advanced_search", "multi_search",
  "research", "domain_search", "cache_search", "free_search_test",
  "spawn_teammate", "wait_agent",
  "team_task_create", "team_task_get", "team_task_list", "team_task_update",
  "list_experts", "summon_expert", "summon_experts", "summon_expert_team",
  "propose_custom_expert", "propose_expert_team",
  "open_custom_expert_editor", "open_expert_team_editor",
  "get_expert_team", "list_expert_teams",
  "gate_status", "gate_load", "gate_search", "gate_invoke",
  "create_worktree",
]));

/** MCP 工具名前缀：mcp__<server>__<raw>。 */
export const MCP_TOOL_PREFIX = "mcp__";

/** 工具名前缀切分（第一个下划线之前）。分组名与插件推断共用这一刀。 */
export function prefixOf(name) {
  const text = typeof name === "string" ? name : "";
  const cut = text.indexOf("_");
  if (cut <= 0) return text;
  return text.slice(0, cut);
}

/** `mcp__<server>__<raw>` 的 server；不是 MCP 名字返回 undefined。 */
export function mcpServerOfToolName(name) {
  if (typeof name !== "string" || name.startsWith(MCP_TOOL_PREFIX) === false) return undefined;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const cut = rest.indexOf("__");
  const server = cut < 0 ? rest : rest.slice(0, cut);
  return server.length > 0 ? server : undefined;
}

/** 工具名 → 所属插件包名（静态前缀表，低置信推断）。 */
export function pluginOfToolName(name) {
  if (typeof name !== "string") return undefined;
  const prefix = prefixOf(name);
  if (prefix === name) return undefined;
  return Object.prototype.hasOwnProperty.call(PLUGIN_PREFIXES, prefix) ? PLUGIN_PREFIXES[prefix] : undefined;
}

/** 工具名（含 v2 的通配键）→ 能力 id。 */
export function capabilityIdOfToolName(name) {
  const tool = typeof name === "string" ? name : String(name || "");
  const mcp = mcpServerOfToolName(tool);
  if (mcp !== undefined) return "mcp:" + mcp;
  const plugin = pluginOfToolName(tool);
  if (plugin !== undefined) return "plugin:" + plugin;
  if (tool.includes("*") || tool.includes("?")) return "glob:" + tool;
  if (NATIVE_TOOL_NAMES.has(tool)) return "native:" + tool;
  return "tool:" + tool;
}

/** 段落名 → 能力 id。段落只有 mcp:<server> 这一族有命名约定（MCPC:738），其余不猜。 */
export function capabilityIdOfSectionName(name) {
  const section = typeof name === "string" ? name : String(name || "");
  if (section.startsWith("mcp:")) return section;
  if (section.includes("*") || section.includes("?")) return "glob:" + section;
  return "section:" + section;
}

/** 技能 provider → 技能包能力 id。 */
export function capabilityIdOfSkill(provider) {
  const text = typeof provider === "string" ? provider.trim() : "";
  return text.length > 0 ? "skillpack:" + text : "skillpack:unknown";
}

/** 单技能能力 id：skill:<name> 比 skillpack:<provider> 更具体。 */
export function capabilityIdOfSkillName(name) {
  const text = typeof name === "string" ? name.trim() : "";
  return text.length > 0 ? "skill:" + text : "skill:";
}

/**
 * 技能来源标签（目录与 /capabilities 共用一份口径）。
 * origin/provider 是纯值：这里不 import skills.js（领域层不许反向依赖运行时模块）。
 */
export function skillSourceLabel(skill) {
  const item = skill !== null && typeof skill === "object" ? skill : {};
  if (item.origin === "import") return "导入:" + (item.provider || "gate-import");
  return item.provider ? "宿主:" + item.provider : "宿主";
}

/**
 * 目录分组的显式表顺序（D6）：先按这张表，再按名字升序。
 * 表里的名字是「展示名」，比较时大小写不敏感（历史数据 ownerOf("mcp__x__y") 给的是小写 mcp）。
 */
export const CATALOG_GROUP_ORDER = Object.freeze(["宿主核心", "dsh-ops", "free-search", "MCP", "office", "univer", "ssh", "mnemon", "agency", "其他"]);

/** 兜底组名：分不出归属的、以及被并入的单条组都落这里。 */
export const CATALOG_OTHER_GROUP = "其他";

const GROUP_RANK = new Map(CATALOG_GROUP_ORDER.map((name, index) => [name.toLowerCase(), index]));

/** 组序权重：显式表里的位置，表外的排最后（99）。 */
export function groupRank(group) {
  const rank = GROUP_RANK.get(String(group).toLowerCase());
  return rank === undefined ? 99 : rank;
}

/** 目录分组名：能落到显式表里的用表里的写法，否则用前缀名（未知前缀原样保留）。 */
export function catalogGroupOf(name) {
  const prefix = prefixOf(name);
  if (prefix.length === 0) return CATALOG_OTHER_GROUP;
  for (const group of CATALOG_GROUP_ORDER) {
    if (group.toLowerCase() === prefix.toLowerCase()) return group;
  }
  return prefix;
}

/**
 * 组序（D6 的唯一实现）：显式表顺序 → 条目数降序（仅 mergeSingle 模式）→ 组名升序。
 * 默认参数下与 0.5.7 的目录字节完全一致（rank 后 localeCompare），所以既有测试逐字节不变。
 */
export function orderGroups(groups, counts, options) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const byCount = opts.byCount === true;
  const tally = counts instanceof Map ? counts : new Map();
  return [...groups].sort((left, right) => {
    const rank = groupRank(left) - groupRank(right);
    if (rank !== 0) return rank;
    if (byCount) {
      const diff = (tally.get(right) || 0) - (tally.get(left) || 0);
      if (diff !== 0) return diff;
    }
    return String(left).localeCompare(String(right));
  });
}

/**
 * 单条组并入其他（D6）：成员数少于 minGroup 的组整体并进「其他」，保持原行顺序。
 * 只在显式打开时执行（默认 false）—— 合并会改目录字节，字节不变量优先。
 *
 * @param {Array<{group:string, row:any}>} rows 已分好组的行（group 由调用方给）
 * @param {{minGroup?:number, other?:string}} [options]
 * @returns {Array<{group:string, rows:any[]}>}
 */
export function mergeSingleMemberGroups(rows, options) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const minGroup = Number.isFinite(opts.minGroup) && opts.minGroup > 0 ? Math.floor(opts.minGroup) : 2;
  const other = typeof opts.other === "string" && opts.other.length > 0 ? opts.other : CATALOG_OTHER_GROUP;
  const buckets = new Map();
  for (const item of Array.isArray(rows) ? rows : []) {
    const group = typeof item.group === "string" && item.group.length > 0 ? item.group : other;
    if (!buckets.has(group)) buckets.set(group, []);
    buckets.get(group).push(item.row);
  }
  const merged = new Map();
  const tail = [];
  for (const [group, list] of buckets) {
    if (group !== other && list.length < minGroup) {
      for (const row of list) tail.push(row);
      continue;
    }
    merged.set(group, list);
  }
  if (tail.length > 0) {
    const existing = merged.get(other) || [];
    merged.set(other, existing.concat(tail));
  }
  return [...merged.entries()].map(([group, list]) => ({ group, rows: list }));
}

/** 最具体的模式（D6 也用它挑「显式 sources」的归属）：具体度降序，同分按字典序。 */
export function pickPattern(patterns, name) {
  let best;
  let bestScore = -1;
  for (const pattern of Array.isArray(patterns) ? patterns : []) {
    if (typeof pattern !== "string" || matches(pattern, name) === false) continue;
    const score = specificity(pattern);
    if (score > bestScore || (score === bestScore && best !== undefined && pattern < best)) {
      bestScore = score;
      best = pattern;
    }
  }
  return best;
}
