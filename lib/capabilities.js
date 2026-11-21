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
import {
  NATIVE_TOOL_NAMES,
  PLUGIN_PREFIXES,
  capabilityIdOfSectionName,
  capabilityIdOfSkill,
  capabilityIdOfSkillName,
  capabilityIdOfToolName,
  mcpServerOfToolName,
  pluginOfToolName,
  skillSourceLabel,
} from "./naming.js";
import { decideSection, decideTool, REASONS } from "./decide.js";

/**
 * 命名与分组只有一份实现（0.6.0 D6）：这里只做再导出，老 import 路径（policy.js / 测试）不用改。
 * 数据表（PLUGIN_PREFIXES / NATIVE_TOOL_NAMES）与 id 构造都在 lib/naming.js。
 */
export {
  NATIVE_TOOL_NAMES,
  PLUGIN_PREFIXES,
  capabilityIdOfSectionName,
  capabilityIdOfSkill,
  capabilityIdOfSkillName,
  capabilityIdOfToolName,
  mcpServerOfToolName,
  pluginOfToolName,
  skillSourceLabel,
};

export const CONFIDENCE_HIGH = "high";
export const CONFIDENCE_MEDIUM = "medium";
export const CONFIDENCE_LOW = "low";
export const CONFIDENCE_UNKNOWN = "unknown";

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
 * 先精确匹配能力 id，再按 id 通配（mcp:* 覆盖 mcp:wincu），最后才是 glob:<pattern>。
 *
 * **轴隔离（0.6.0 · P1-4 / be:D5）**：glob:<pattern> 是 v2 通配键的落点，它只能拿
 * **工具名**去比。0.5.7 里它也拿段落名/技能名去比，于是一条 `glob:pwsh*` 会顺带把
 * `pwsh-notes` 段落与 `pwsh-guide` 技能一起关掉 —— 一个开关跨三条轴。
 * 段落轴的"通配回退"只允许非 glob 的通配键（如 mcp:*）按能力 id 命中，这是同轴回退。
 *
 * @param {object} policy
 * @param {string} id 能力 id
 * @param {string} [memberName] 成员名（只有工具轴会用它跑 glob）
 * @param {"tool"|"section"|"skill"} [kind] 轴（缺省 tool：老调用点零改动）
 */
export function capabilityEntryFor(policy, id, memberName, kind) {
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
  // 轴隔离（P1-4）：glob: 键只作用工具轴，段落/技能不许跨轴命中。
  const axis = kind === "section" ? "section" : kind === "skill" ? "skill" : "tool";
  if (axis !== "tool") return undefined;
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

/** 三根轴各自的 defaults（工具 / 段落 / 技能包）。 */
function axisDefaultOf(policy, kind) {
  const defaults = defaultsOf(policy);
  if (kind === "section") return defaults.section;
  if (kind === "skill") return defaults.skillpack;
  return defaults.capability;
}

function capabilityTierOf(policy, entry, kind) {
  const fallback = axisDefaultOf(policy, kind);
  if (entry !== undefined && isPlainObject(entry.config) && entry.config.tier !== undefined) {
    return normalizeTier(entry.config.tier, fallback);
  }
  return fallback;
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
  const isProtected = protectedNamesOf(policy).has(name);
  /**
   * 命中链只回答「策略给了哪一层」，已加载 / 冻结怎么改写交给引擎（D4：归层只有一个入口）。
   * 这一步同时修掉 B21/P1-7：0.5.7 的 loaded 短路在链的最前面，于是「已加载」永远压过「显式关闭」。
   */
  let chainTier;
  let chainReason;
  if (ctx.own === true) {
    chainTier = TIER_RESIDENT;
    chainReason = REASONS.OWN;
  } else if (ctx.globallyVisible === false && configured === false) {
    // 2 preset 平面：没被能力策略点名就保持常驻（默认策略不能把基础工具一起藏掉）
    chainTier = TIER_RESIDENT;
    chainReason = REASONS.PRESET;
  } else if (isProtected) {
    // 3 protected（只护工具名）
    chainTier = TIER_RESIDENT;
    chainReason = REASONS.PROTECTED;
  } else if (capability.confidence === CONFIDENCE_UNKNOWN && configured === false) {
    // 来源推不出来、能力策略里也没点名：只标注、不隐藏（docs 04 §2）。
    chainTier = TIER_RESIDENT;
    chainReason = REASONS.UNKNOWN;
  } else if (exception !== undefined) {
    // 7 例外（显式，唯一允许同能力不同档的地方）
    chainTier = exception.tier;
    chainReason = REASONS.EXCEPTION;
  } else if (configured && isPlainObject(entry.config) && entry.config.tier !== undefined) {
    // 6 能力档
    chainTier = normalizeTier(entry.config.tier, defaults.capability);
    chainReason = REASONS.CAPABILITY;
  } else {
    // 8 defaults
    chainTier = defaults.capability;
    chainReason = REASONS.DEFAULTS;
  }
  const decided = decideTool({
    name,
    tier: chainTier,
    reason: chainReason,
    loaded: ctx.loaded === true,
    frozen: ctx.frozen === true,
    own: ctx.own === true,
    protected: isProtected,
  });
  // 面板的桶口径保持 0.5.7：own / preset 是独立桶，其余按层值。
  const bucket = ctx.own === true
    ? "own"
    : chainReason === REASONS.PRESET ? "preset" : decided.bucket;
  return Object.assign(base, {
    tier: decided.tier,
    bucket,
    reason: decided.reason || chainReason,
    removalReason: decided.removalReason,
    deviation: exception !== undefined ? exception.tier !== capabilityTier : false,
  });
}

/** 段落的归层（与工具同一条链，只是没有 own/preset 两种身份）。 */
export function resolveSectionDecision(policy, name) {
  const defaults = defaultsOf(policy);
  const capability = capabilityOfSection(policy, name);
  // 轴隔离（P1-4）：段落只认自己的能力 id，glob:<pattern> 是工具轴的东西。
  const entry = capabilityEntryFor(policy, capability.id, name, "section");
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
  let tier;
  let reason;
  if (exception !== undefined) {
    tier = exception.tier;
    reason = "exception";
  } else if (configured && isPlainObject(entry.config) && entry.config.tier !== undefined) {
    tier = normalizeTier(entry.config.tier, defaults.section);
    reason = "capability";
  } else {
    tier = defaults.section;
    reason = "defaults";
  }
  // 段落轴的最终形态（摘除 / 进目录 / 可加载）由引擎给：调用方不许再各写一遍。
  const decided = decideSection({ name, tier, reason });
  return Object.assign(base, {
    tier: decided.tier,
    bucket: decided.bucket,
    // reason 保持命中链口径（面板与排障要它），摘除理由单独给。
    reason,
    removalReason: decided.removalReason,
    removed: decided.removed,
    catalog: decided.catalog,
    loadable: decided.loadable,
    deviation: exception !== undefined ? exception.tier !== capabilityTier : false,
  });
}

/**
 * 技能的能力归属：provider 是唯一可信信号，id 构造在 naming.js（D6 唯一实现）。
 */
export function capabilityOfSkill(provider) {
  const text = typeof provider === "string" ? provider.trim() : "";
  if (text.length > 0) return { id: capabilityIdOfSkill(text), confidence: CONFIDENCE_HIGH, via: "provider" };
  return { id: capabilityIdOfSkill(text), confidence: CONFIDENCE_UNKNOWN, via: "unknown" };
}

/**
 * 技能归层（与工具/段落同一条链）。0.3.0 起解析顺序是三层（工单 14）：
 *   skill:<name> 单技能 → skillpack:<provider> 组 → defaults.skillpack
 * 单技能条目永远赢过组（「这一条单独关掉」是最具体的意图）。
 * capability 字段仍报 skillpack:<provider>：能力视图按来源聚合，单技能命中记在 capabilityEntry。
 */
export function resolveSkillDecision(policy, item) {
  const skill = isPlainObject(item) ? item : {};
  const name = typeof skill.name === "string" ? skill.name : "";
  const defaults = defaultsOf(policy);
  const capability = capabilityOfSkill(skill.provider);
  // 轴隔离（P1-4）：glob: 通配只作用工具轴，技能只认 skill:<name> / skillpack:<provider>。
  const single = name.length > 0 ? capabilityEntryFor(policy, capabilityIdOfSkillName(name), name, "skill") : undefined;
  const pack = capabilityEntryFor(policy, capability.id, name, "skill");
  const entry = single !== undefined ? single : pack;
  const configured = entry !== undefined;
  const base = {
    capability: capability.id,
    capabilityEntry: entry === undefined ? undefined : entry.key,
    confidence: capability.confidence,
    via: configured && single !== undefined ? "skill" : capability.via,
    configured,
    // 命中的是单技能条目还是组条目：/capabilities 与排障要能分出来。
    single: single !== undefined,
  };
  // skills.off 是按名字直接关的清单（工单 14），优先于能力解析链；
  // 只在 gate 接管时生效：takeover=false 是完整退回宿主行为，不能偷偷按 gate 的名单摘技能。
  const offList = policy.skills && policy.skills.takeover !== false && Array.isArray(policy.skills.off)
    ? policy.skills.off
    : [];
  if (name.length > 0 && offList.includes(name)) {
    return Object.assign(base, { tier: TIER_OFF, reason: "skills.off" });
  }
  if (configured && isPlainObject(entry.config) && entry.config.tier !== undefined) {
    const tier = normalizeTier(entry.config.tier, defaults.skillpack);
    return Object.assign(base, { tier, reason: single !== undefined ? "skill" : "capability" });
  }
  return Object.assign(base, { tier: defaults.skillpack, reason: "defaults" });
}

function sortedStrings(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((item) => typeof item === "string" && item.length > 0))].sort();
}

const UNKNOWN_PROVENANCE = Object.freeze({
  source: "unknown",
  confidence: CONFIDENCE_UNKNOWN,
  via: "unknown",
});

/**
 * 能力行的来源（工单 08）：行是能力的聚合，来源直接由能力 id 的前缀决定，
 * 不拿成员来源投票 —— 一个能力里混进 unknown 成员不该让整行失去可读的来源。
 */
function provenanceOfCapabilityId(id) {
  const text = String(id || "");
  if (text.startsWith("mcp:") && text.length > 4) {
    return { source: text, confidence: CONFIDENCE_HIGH, via: "naming" };
  }
  if (text.startsWith("native:")) return { source: "native", confidence: CONFIDENCE_HIGH, via: "native" };
  if (text.startsWith("plugin:") && text.length > 7) {
    return { source: "plugin:" + text.slice(7), confidence: CONFIDENCE_MEDIUM, via: "prefix" };
  }
  // 单技能条目（skill:<name>，工单 14）：名字本身就是来源，和 provider 一样高置信。
  if (text.startsWith("skill:") && text.length > "skill:".length) {
    return { source: "skill", confidence: CONFIDENCE_HIGH, via: "name" };
  }
  if (text.startsWith("skillpack:") && text.length > "skillpack:".length) {
    // provider 是技能来源的唯一高置信信号（与 lib/upstream.js 的 provenanceOfSkill 同口径）。
    return text === "skillpack:unknown"
      ? { ...UNKNOWN_PROVENANCE }
      : { source: "skillpack", confidence: CONFIDENCE_HIGH, via: "provider" };
  }
  return { ...UNKNOWN_PROVENANCE };
}

/** 来源表归一：Host 传普通对象，单元测试可能直接传 Map。 */
function provenanceTableOf(raw) {
  if (raw instanceof Map) return Object.fromEntries(raw);
  return isPlainObject(raw) ? raw : {};
}

function normalizedProvenance(entry) {
  if (!isPlainObject(entry) || typeof entry.source !== "string" || entry.source.length === 0) {
    return { ...UNKNOWN_PROVENANCE };
  }
  return {
    source: entry.source,
    confidence: typeof entry.confidence === "string" ? entry.confidence : CONFIDENCE_UNKNOWN,
    via: typeof entry.via === "string" ? entry.via : "unknown",
  };
}

function sortedProvenance(table) {
  const out = {};
  for (const key of Object.keys(table).sort()) out[key] = normalizedProvenance(table[key]);
  return out;
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
  const skills = [];
  const deviations = [];
  // 上游隐藏的工具名（已知但当前视图不可见）；来源表由 lib/upstream.js 算，这里只读取。
  const hiddenNames = new Set(Array.isArray(input.upstreamHidden) ? input.upstreamHidden : []);
  const provenanceTable = provenanceTableOf(input.provenance);
  const provenanceOf = (name) => normalizedProvenance(provenanceTable[name]);

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
        skills: [],
        deviations: [],
        // 新增字段只追加（旧消费者按名字读，不依赖键序；这里保持旧键的相对顺序）。
        provenance: provenanceOfCapabilityId(key),
        upstreamHidden: [],
      });
    }
    return rows.get(key);
  };

  // 上游隐藏的工具不进成员表（tools），但要挂在所属能力行的 upstreamHidden 上：
  // 否则 UI 只知道「有这么个名字被藏了」，不知道它属于哪个开关。
  const hiddenTools = Array.isArray(input.hiddenTools)
    ? input.hiddenTools.filter((name) => typeof name === "string" && name.length > 0)
    : [...hiddenNames];

  for (const item of Array.isArray(input.tools) ? input.tools : []) {
    if (!item || typeof item.name !== "string") continue;
    const resolved = resolveToolDecision(policy, item.name, {
      own: item.own === true,
      globallyVisible: item.globallyVisible !== false,
      loaded: item.loaded === true,
      // P2-1：冻结下「已加载」不再抬升，能力视图的桶必须与快照层值同口径。
      frozen: item.frozen === true,
    });
    // 强制档（工单 14：skills.takeover=true 时宿主 skill 工具无条件 deny）。
    // 不是策略条目，所以不算 deviation：它是闸门自己的接管，策略怎么写都改变不了。
    const forced = normalizeTier(item.forcedTier, undefined);
    const decision = forced === undefined
      ? resolved
      : Object.assign({}, resolved, { tier: forced, bucket: bucketOf(forced), reason: "takeover", exception: undefined, deviation: false });
    const key = decision.capabilityEntry || decision.capability;
    const row = rowOf(key, decision.configured);
    row.tools.push(item.name);
    const hidden = item.upstreamHidden === true || hiddenNames.has(item.name);
    if (hidden) row.upstreamHidden.push(item.name);
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
      // 由 gate 接管（而不是被策略关掉）：UI 要能解释「为什么 native:skill=常驻却不在工具表」。
      takenOver: item.takenOver === true || forced !== undefined,
      provenance: provenanceOf(item.name),
      upstreamHidden: hidden,
    });
  }

  for (const name of hiddenTools) {
    // 只归类、不进成员表：能力 id 仍由解析链算，来源与档位不另抄一份。
    const decision = resolveToolDecision(policy, name, { globallyVisible: true });
    const key = decision.capabilityEntry || decision.capability;
    const row = rowOf(key, decision.configured);
    if (!row.upstreamHidden.includes(name)) row.upstreamHidden.push(name);
  }

  for (const item of Array.isArray(input.sections) ? input.sections : []) {
    if (!item || typeof item.name !== "string") continue;
    const decision = resolveSectionDecision(policy, item.name);
    const key = decision.capabilityEntry || decision.capability;
    const row = rowOf(key, decision.configured);
    row.sections.push(item.name);
    const hidden = item.upstreamHidden === true;
    if (hidden) row.upstreamHidden.push(item.name);
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
      chars: Number.isFinite(item.chars) ? item.chars : 0,
      tokens: Number.isFinite(item.tokens) ? item.tokens : 0,
      loaded: item.loaded === true,
      reason: decision.reason,
      exception: decision.exception,
      deviation: decision.deviation,
      provenance: provenanceOf(item.name),
      upstreamHidden: hidden,
    });
  }

  // 技能：按 provider 聚合到 skillpack:<provider>，档位由能力条目或 defaults.skillpack 决定。
  // 成员表与顶部 skills 并存：行回答「哪个来源一组的开关」，列表回答「一共哪些技能」。
  for (const item of Array.isArray(input.skills) ? input.skills : []) {
    if (!item || typeof item.name !== "string") continue;
    const decision = resolveSkillDecision(policy, item);
    const key = decision.capabilityEntry || decision.capability;
    const row = rowOf(key, decision.configured);
    row.skills.push(item.name);
    skills.push({
      name: item.name,
      capability: decision.capability,
      capabilityEntry: decision.capabilityEntry,
      confidence: decision.confidence,
      via: decision.via,
      tier: decision.tier,
      reason: decision.reason,
      provider: typeof item.provider === "string" ? item.provider : undefined,
      // 工单 14：gate 接管后 UI 要能说明「这条技能从哪来、能不能用、被谁遮了」。
      origin: item.origin === "import" ? "import" : "host",
      path: typeof item.path === "string" ? item.path : undefined,
      shadowed: item.shadowed === true,
      single: decision.single === true,
      // 与 gate-catalog 同一份来源口径（宿主:provider / 导入:id）。
      source: item.origin === "import"
        ? "导入:" + (typeof item.provider === "string" && item.provider.length > 0 ? item.provider : "gate-import")
        : typeof item.provider === "string" && item.provider.length > 0 ? "宿主:" + item.provider : "宿主",
      provenance: provenanceOf(item.name),
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
    skills: sortedStrings(row.skills),
    upstreamHidden: sortedStrings(row.upstreamHidden),
    deviations: row.deviations.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  }));
  rowsOut.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  sections.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  deviations.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    version: 3,
    defaults,
    upstreamHidden: sortedStrings(input.upstreamHidden),
    capabilities: rowsOut,
    tools,
    sections,
    skills,
    deviations,
    sources,
    legacy: isPlainObject(policy && policy.legacy) ? policy.legacy : { unknownOverrides: {} },
    warnings: Array.isArray(policy && policy.warnings) ? policy.warnings : [],
    // 新增字段只追加：来源表覆盖工具/段落/技能，包含上游隐藏的名字（成员表里看不到它们）。
    provenance: sortedProvenance(provenanceTable),
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
