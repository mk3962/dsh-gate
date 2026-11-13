/**
 * 能力模型（0.2.0 v3）—— 一个能力 = 一个开关，工具与段落同时受它管。
 *
 * 能力 id 由**来源**决定（docs/dsh-gate-0.2.0-04-能力模型与v3策略.md §2）：
 *   mcp:<server>        MCP server（工具 mcp__<server>__* + 段落 mcp:<server>），高置信
 *   plugin:<包名>        插件包；显式 sources 优先，否则按已知包前缀推断（低置信）
 *   native:<tool>        dsh 原生工具，单工具一个能力（与 0.1.8 的「不并组」一致）
 *   tool:<name>          推不出来源的单个工具（unknown：只标注，不合并、不隐藏）
 *   section:<name>       推不出来源的单个段落
 *   glob:<pattern>       v2 的通配键没有命名空间可归时（如 web_*），按名字匹配
 *
 * 解析顺序（§4），命中即停：
 *   1 own 层 → 2 preset 平面 → 3 protected → 4 显式 sources → 5 命名推断
 *   → 6 能力档 → 7 例外（toolExceptions / sectionExceptions，唯一允许「同能力不同档」的地方）
 *   → 8 defaults
 *
 * 4/5 只回答「它属于哪个能力」，6/7/8 回答「它落在哪一档」；例外是显式的，读回带 deviation。
 * 一个能力档变化同时驱动工具与段落，是因为两边都从这里取档位（gate 的两条限制同源）。
 */
import {
  clone,
  isPlainObject,
  matches,
  normalizeTier,
  pickMostSpecific,
  specificity,
  TIER_OFF,
  TIER_ONDEMAND,
  TIER_RESIDENT,
} from "./tiers.js";

export const CONFIDENCE_HIGH = "high";
export const CONFIDENCE_MEDIUM = "medium";
export const CONFIDENCE_LOW = "low";
export const CONFIDENCE_UNKNOWN = "unknown";

/**
 * 已知插件包前缀 → npm 包名（能力 id 用包名，与 docs 的 plugin:<包名> 一致）。
 * 只是**推断兜底**（低置信）：显式 sources 永远压过它，UI 上标 low 让用户能纠正。
 * 前缀取工具名第一个下划线之前的部分（catalog.ownerOf 同款切法）。
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
 * dsh 原生工具名：单工具成能力，不并组（把 read/write/pwsh 绑成一个开关是错的）。
 *
 * 为什么要一份静态清单：能力 id 必须**与运行期视图无关**，否则 v2 迁移时（看不到
 * agent 视图）算出的 id 与运行时算出的 id 会不一致，迁移出来的档位就落不到同一个开关上。
 * own / preset 层仍然是「原生」的高置信信号（bucket 用），只是不参与 id 生成。
 * 清单外又无插件前缀的工具一律 tool:<name>（unknown），宁可不猜。
 */
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
]));

/** 能力的默认档位（defaults 的兜底；与 0.1.8 的默认一致）。 */
export const CAPABILITY_DEFAULTS = Object.freeze({
  capability: TIER_ONDEMAND,
  section: TIER_RESIDENT,
  skillpack: TIER_ONDEMAND,
});

export function defaultsOf(policy) {
  const raw = isPlainObject(policy && policy.defaults) ? policy.defaults : {};
  return {
    capability: normalizeTier(raw.capability, CAPABILITY_DEFAULTS.capability),
    section: normalizeTier(raw.section, CAPABILITY_DEFAULTS.section),
    skillpack: normalizeTier(raw.skillpack, CAPABILITY_DEFAULTS.skillpack),
  };
}

function protectedNamesOf(policy) {
  return policy && policy.protectedNames instanceof Set ? policy.protectedNames : new Set();
}

function bucketOf(tier) {
  if (tier === TIER_RESIDENT) return "resident";
  if (tier === TIER_OFF) return "off";
  return "ondemand";
}

/** `mcp__<server>__<raw>` 的 server；通配键 mcp__* 的 server 就是 "*"。 */
export function mcpServerOfToolName(name) {
  if (typeof name !== "string" || !name.startsWith("mcp__")) return undefined;
  const rest = name.slice(5);
  const cut = rest.indexOf("__");
  const server = cut < 0 ? rest : rest.slice(0, cut);
  return server.length > 0 ? server : undefined;
}

export function pluginOfToolName(name) {
  if (typeof name !== "string") return undefined;
  const cut = name.indexOf("_");
  if (cut <= 0) return undefined;
  const prefix = name.slice(0, cut);
  return Object.prototype.hasOwnProperty.call(PLUGIN_PREFIXES, prefix) ? PLUGIN_PREFIXES[prefix] : undefined;
}

/** 工具名（含 v2 的通配键）→ 能力 id。 */
export function capabilityIdOfToolName(name) {
  const tool = String(name || "");
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
  const section = String(name || "");
  if (section.startsWith("mcp:")) return section;
  if (section.includes("*") || section.includes("?")) return "glob:" + section;
  return "section:" + section;
}

/** 显式 sources 映射：成员名（可带通配）→ 能力 id，最具体的一条胜出。 */
function sourceMatch(sources, name, memberKey) {
  let best;
  let bestScore = -1;
  if (!isPlainObject(sources)) return undefined;
  for (const id of Object.keys(sources)) {
    const entry = sources[id];
    if (!isPlainObject(entry) || !Array.isArray(entry[memberKey])) continue;
    for (const pattern of entry[memberKey]) {
      if (typeof pattern !== "string" || !matches(pattern, name)) continue;
      const score = specificity(pattern);
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
  }
  return best;
}

/** 工具的能力归属：显式 sources > mcp 命名 > 插件前缀 > 原生清单 > 未归属。 */
export function capabilityOfTool(policy, name) {
  const sources = policy && policy.sources;
  const explicit = sourceMatch(sources, name, "tools");
  if (explicit !== undefined) return { id: explicit, confidence: CONFIDENCE_MEDIUM, via: "sources" };
  const mcp = mcpServerOfToolName(name);
  if (mcp !== undefined) return { id: "mcp:" + mcp, confidence: CONFIDENCE_HIGH, via: "naming" };
  const plugin = pluginOfToolName(name);
  if (plugin !== undefined) return { id: "plugin:" + plugin, confidence: CONFIDENCE_LOW, via: "prefix" };
  if (NATIVE_TOOL_NAMES.has(name)) return { id: "native:" + name, confidence: CONFIDENCE_MEDIUM, via: "native" };
  return { id: "tool:" + name, confidence: CONFIDENCE_UNKNOWN, via: "unknown" };
}

/** 段落的能力归属：显式 sources > mcp:<server> 命名 > section:<name>。 */
export function capabilityOfSection(policy, name) {
  const sources = policy && policy.sources;
  const explicit = sourceMatch(sources, name, "sections");
  if (explicit !== undefined) return { id: explicit, confidence: CONFIDENCE_MEDIUM, via: "sources" };
  if (String(name).startsWith("mcp:")) return { id: name, confidence: CONFIDENCE_HIGH, via: "naming" };
  return { id: "section:" + name, confidence: CONFIDENCE_UNKNOWN, via: "naming" };
}

/**
 * 成员的档位该由哪条能力策略决定。
 * 先精确匹配能力 id，再按 id 通配（mcp:* 覆盖 mcp:wincu），最后才是 glob:<pattern>
 * —— 后者是 v2 通配键的落点，只能拿成员**名字**去比。
 */
export function capabilityEntryFor(policy, id, memberName) {
  const capabilities = isPlainObject(policy && policy.capabilities) ? policy.capabilities : {};
  if (Object.prototype.hasOwnProperty.call(capabilities, id) && isPlainObject(capabilities[id])) {
    return { key: id, config: capabilities[id], exact: true };
  }
  const pick = (onlyGlobs) => {
    let best;
    let bestScore = -1;
    for (const key of Object.keys(capabilities)) {
      const isGlob = key.startsWith("glob:");
      if (isGlob !== onlyGlobs) continue;
      if (!isGlob && !key.includes("*") && !key.includes("?")) continue;
      const haystack = isGlob ? String(memberName || "") : id;
      const pattern = isGlob ? key.slice(5) : key;
      if (!matches(pattern, haystack)) continue;
      const score = specificity(key);
      if (score > bestScore) {
        bestScore = score;
        best = key;
      }
    }
    return best;
  };
  const idMatch = pick(false);
  if (idMatch !== undefined) return { key: idMatch, config: capabilities[idMatch], exact: false };
  const globMatch = pick(true);
  if (globMatch !== undefined) return { key: globMatch, config: capabilities[globMatch], exact: false };
  return undefined;
}

/** 能力条目里、命中该成员的最具体例外。 */
export function memberExceptionOf(config, kind, name) {
  if (!isPlainObject(config)) return undefined;
  const map = kind === "section" ? config.sectionExceptions : config.toolExceptions;
  const hit = pickMostSpecific(map, name);
  if (hit === undefined) return undefined;
  const tier = normalizeTier(hit.value, undefined);
  if (tier === undefined) return undefined;
  return { pattern: hit.pattern, tier };
}

function capabilityTierOf(policy, entry, kind) {
  if (entry !== undefined && isPlainObject(entry.config) && entry.config.tier !== undefined) {
    return normalizeTier(entry.config.tier, kind === "section" ? defaultsOf(policy).section : defaultsOf(policy).capability);
  }
  return kind === "section" ? defaultsOf(policy).section : defaultsOf(policy).capability;
}

/**
 * 一个工具最终归哪一档 —— 解析链的唯一出口（gate 的 plan 与面板的 tiers 都走它）。
 * @returns {{tier:number, bucket:string, capability:string, capabilityEntry?:string,
 *   confidence:string, via:string, configured:boolean, reason:string,
 *   exception?:{pattern:string,tier:number}, deviation:boolean}}
 */
export function resolveToolDecision(policy, name, context) {
  const ctx = context || {};
  const defaults = defaultsOf(policy);
  const capability = capabilityOfTool(policy, name);
  const entry = capabilityEntryFor(policy, capability.id, name);
  const configured = entry !== undefined;
  const capabilityTier = capabilityTierOf(policy, entry, "tool");
  const exception = memberExceptionOf(configured ? entry.config : undefined, "tool", name);
  const base = {
    capability: capability.id,
    capabilityEntry: entry === undefined ? undefined : entry.key,
    confidence: capability.confidence,
    via: capability.via,
    configured,
    exception: exception === undefined ? undefined : { pattern: exception.pattern, tier: exception.tier },
    deviation: false,
  };
  // 1 own 层（restrict 管不到，宿主语义）
  if (ctx.own === true) return Object.assign(base, { tier: TIER_RESIDENT, bucket: "own", reason: "own" });
  // 运行时覆盖：本轮被 gate_load 认领
  if (ctx.loaded === true) return Object.assign(base, { tier: TIER_RESIDENT, bucket: "resident", reason: "loaded" });
  // 2 preset 平面：没被能力策略点名就保持常驻（默认策略不能把基础工具一起藏掉）
  if (ctx.globallyVisible === false && configured === false) {
    return Object.assign(base, { tier: TIER_RESIDENT, bucket: "preset", reason: "preset" });
  }
  // 3 protected（只护工具名）
  if (protectedNamesOf(policy).has(name)) return Object.assign(base, { tier: TIER_RESIDENT, bucket: "resident", reason: "protected" });
  // 来源推不出来、能力策略里也没点名：只标注、不隐藏（docs 04 §2「unknown 只标注，不合并、不隐藏」）。
  // 藏一个我们看不懂来源的工具，代价是模型少了一件能用的工具，收益却只是它可能本可以省的那点 token。
  if (capability.confidence === CONFIDENCE_UNKNOWN && configured === false) {
    return Object.assign(base, { tier: TIER_RESIDENT, bucket: "resident", reason: "unknown" });
  }
  // 7 例外（显式，唯一允许同能力不同档的地方）
  if (exception !== undefined) {
    return Object.assign(base, {
      tier: exception.tier,
      bucket: bucketOf(exception.tier),
      reason: "exception",
      deviation: exception.tier !== capabilityTier,
    });
  }
  // 6 能力档
  if (configured && isPlainObject(entry.config) && entry.config.tier !== undefined) {
    const tier = normalizeTier(entry.config.tier, defaults.capability);
    return Object.assign(base, { tier, bucket: bucketOf(tier), reason: "capability" });
  }
  // 8 defaults
  return Object.assign(base, { tier: defaults.capability, bucket: bucketOf(defaults.capability), reason: "defaults" });
}

/** 段落的归层（与工具同一条链，只是没有 own/preset 两种身份）。 */
export function resolveSectionDecision(policy, name) {
  const defaults = defaultsOf(policy);
  const capability = capabilityOfSection(policy, name);
  const entry = capabilityEntryFor(policy, capability.id, name);
  const configured = entry !== undefined;
  const capabilityTier = capabilityTierOf(policy, entry, "section");
  const exception = memberExceptionOf(configured ? entry.config : undefined, "section", name);
  const base = {
    capability: capability.id,
    capabilityEntry: entry === undefined ? undefined : entry.key,
    confidence: capability.confidence,
    via: capability.via,
    configured,
    exception: exception === undefined ? undefined : { pattern: exception.pattern, tier: exception.tier },
    deviation: false,
  };
  if (exception !== undefined) {
    return Object.assign(base, {
      tier: exception.tier,
      reason: "exception",
      deviation: exception.tier !== capabilityTier,
    });
  }
  if (configured && isPlainObject(entry.config) && entry.config.tier !== undefined) {
    const tier = normalizeTier(entry.config.tier, defaults.section);
    return Object.assign(base, { tier, reason: "capability" });
  }
  return Object.assign(base, { tier: defaults.section, reason: "defaults" });
}

function sortedStrings(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((item) => typeof item === "string" && item.length > 0))].sort();
}

function sortedTierMap(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const key of Object.keys(raw).sort()) {
    const tier = normalizeTier(raw[key], undefined);
    if (tier !== undefined) out[key] = tier;
  }
  return out;
}

/**
 * 能力视图（给 UI/HTTP 的单独查询，不进 gate_status 的固定键集）。
 * 行 = 一个能力；configured=false 表示策略里没有显式条目、按 defaults 走。
 */
export function capabilityState(policy, surface) {
  const input = isPlainObject(surface) ? surface : {};
  const defaults = defaultsOf(policy);
  const capabilities = isPlainObject(policy && policy.capabilities) ? policy.capabilities : {};
  const rows = new Map();
  const tools = [];
  const sections = [];
  const deviations = [];

  const rowOf = (key, configured) => {
    if (!rows.has(key)) {
      const config = configured && isPlainObject(capabilities[key]) ? capabilities[key] : undefined;
      rows.set(key, {
        id: key,
        configured,
        tier: config === undefined || config.tier === undefined ? null : normalizeTier(config.tier, null),
        toolExceptions: sortedTierMap(config && config.toolExceptions),
        sectionExceptions: sortedTierMap(config && config.sectionExceptions),
        tools: [],
        sections: [],
        deviations: [],
      });
    }
    return rows.get(key);
  };

  for (const item of Array.isArray(input.tools) ? input.tools : []) {
    if (!item || typeof item.name !== "string") continue;
    const decision = resolveToolDecision(policy, item.name, {
      own: item.own === true,
      globallyVisible: item.globallyVisible !== false,
      loaded: item.loaded === true,
    });
    const key = decision.capabilityEntry || decision.capability;
    const row = rowOf(key, decision.configured);
    row.tools.push(item.name);
    if (decision.deviation) {
      const detail = { kind: "tool", name: item.name, capability: key, tier: decision.tier, capabilityTier: row.tier };
      row.deviations.push(detail);
      deviations.push(detail);
    }
    tools.push({
      name: item.name,
      capability: decision.capability,
      capabilityEntry: decision.capabilityEntry,
      confidence: decision.confidence,
      via: decision.via,
      tier: decision.tier,
      bucket: decision.bucket,
      reason: decision.reason,
      exception: decision.exception,
      deviation: decision.deviation,
    });
  }

  for (const item of Array.isArray(input.sections) ? input.sections : []) {
    if (!item || typeof item.name !== "string") continue;
    const decision = resolveSectionDecision(policy, item.name);
    const key = decision.capabilityEntry || decision.capability;
    const row = rowOf(key, decision.configured);
    row.sections.push(item.name);
    if (decision.deviation) {
      const detail = { kind: "section", name: item.name, capability: key, tier: decision.tier, capabilityTier: row.tier };
      row.deviations.push(detail);
      deviations.push(detail);
    }
    sections.push({
      name: item.name,
      capability: decision.capability,
      capabilityEntry: decision.capabilityEntry,
      confidence: decision.confidence,
      via: decision.via,
      tier: decision.tier,
      gated: decision.tier !== TIER_RESIDENT,
      reason: decision.reason,
      exception: decision.exception,
      deviation: decision.deviation,
    });
  }

  // 显式 sources 声明了、但本轮表面里没有的成员也列出来（UI 要能纠正映射）。
  const sources = isPlainObject(policy && policy.sources) ? policy.sources : {};
  for (const id of Object.keys(sources)) {
    const entry = sources[id];
    if (!isPlainObject(entry)) continue;
    const row = rowOf(id, Object.prototype.hasOwnProperty.call(capabilities, id));
    for (const name of Array.isArray(entry.tools) ? entry.tools : []) if (!row.tools.includes(name)) row.tools.push(name);
    for (const name of Array.isArray(entry.sections) ? entry.sections : []) if (!row.sections.includes(name)) row.sections.push(name);
  }

  const rowsOut = [...rows.values()].map((row) => Object.assign({}, row, {
    tools: sortedStrings(row.tools),
    sections: sortedStrings(row.sections),
    deviations: row.deviations.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  }));
  rowsOut.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  sections.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  deviations.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    version: 3,
    defaults,
    upstreamHidden: sortedStrings(input.upstreamHidden),
    capabilities: rowsOut,
    tools,
    sections,
    deviations,
    sources,
    legacy: isPlainObject(policy && policy.legacy) ? policy.legacy : { unknownOverrides: {} },
    warnings: Array.isArray(policy && policy.warnings) ? policy.warnings : [],
  };
}

/** 切一个能力档（显式写进 capabilities；返回值不是新开关，UI 保存仍走文件）。 */
export function withCapabilityTier(policy, id, tier) {
  const next = clone(isPlainObject(policy) ? policy : {});
  if (!isPlainObject(next.capabilities)) next.capabilities = {};
  const current = isPlainObject(next.capabilities[id]) ? next.capabilities[id] : {};
  const fallback = current.tier === undefined ? defaultsOf(policy).capability : current.tier;
  next.capabilities[id] = Object.assign({}, current, { tier: normalizeTier(tier, fallback) });
  return next;
}

/** 给单个成员设例外（唯一允许「同能力不同档」的入口；读回 deviation=true）。 */
export function withMemberException(policy, id, kind, member, tier) {
  const next = clone(isPlainObject(policy) ? policy : {});
  if (!isPlainObject(next.capabilities)) next.capabilities = {};
  const current = isPlainObject(next.capabilities[id]) ? next.capabilities[id] : {};
  const key = kind === "section" ? "sectionExceptions" : "toolExceptions";
  const map = Object.assign({}, isPlainObject(current[key]) ? current[key] : {});
  const fallback = kind === "section" ? defaultsOf(policy).section : defaultsOf(policy).capability;
  map[member] = normalizeTier(tier, fallback);
  next.capabilities[id] = Object.assign({}, current, { [key]: map });
  return next;
}
