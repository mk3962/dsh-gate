/**
 * v2 → v3 迁移与 v3 规范化（0.2.0）。
 *
 * v2 是「一张工具表 + 一张段落表 + 默认层」，v3 是「能力 + 例外 + defaults」。
 * 迁移的硬要求（docs/dsh-gate-0.2.0-04-能力模型与v3策略.md §5）：
 *   - 同一能力内档位冲突取**最宽松**（resident < on-demand < off），其余成员写成例外；
 *   - 推断不了的键进 `legacy.unknownOverrides` 只告警、不参与解析；
 *   - 同一份 v2 迁两次必须逐字节一致 —— 所以键序、数组序全部在这里定死；
 *   - 原 v2 文件不动：先在旁边留一份 `gate.json.v2.bak-<时间戳>`，回滚包照旧可用。
 *
 * 这里同时是「v3 规范化」的唯一出口：resolvePolicy 读完文件、server 保存后都调
 * normalizeV3Policy，保证落盘字节与运行时形状同源。
 */
import fs from "node:fs";
import path from "node:path";
import {
  CAPABILITY_DEFAULTS,
  capabilityIdOfSectionName,
  capabilityIdOfToolName,
} from "./capabilities.js";
import {
  clone,
  isPlainObject,
  loosenessRank,
  normalizeCount,
  normalizeTier,
  TIER_OFF,
  TIER_ONDEMAND,
  TIER_RESIDENT,
} from "./tiers.js";
import { normalizeServerConfig } from "./mcp.js";

export const POLICY_VERSION = 3;

/** v2 的默认层（迁移时逐轴回落；与 0.1.8 的默认一致）。 */
export const V2_DEFAULTS = Object.freeze({
  capability: TIER_ONDEMAND,
  section: TIER_RESIDENT,
  skillpack: TIER_ONDEMAND,
  narrowPassThrough: 12,
});

/** v2 里曾经存在、现在已经没有对应工具的名字：迁移时直接进 legacy 并告警。 */
export const RETIRED_TOOL_NAMES = Object.freeze(new Set(["ws_mcp_call"]));

export const CATALOG_DEFAULTS = Object.freeze({ groupByPlugin: true, maxDescriptionLength: 64, skillGroups: false });

/** v3 的顶层键（规范化时的固定键序，多余键作为扩展键排在最后）。 */
const V3_KEYS = Object.freeze([
  "version", "enabled", "freezePtcToolset", "defaults", "capabilities", "sources", "legacy",
  "catalog", "narrowPassThrough", "protected", "skills", "mcp",
]);

/** v2 的顶层键：迁移时被吸收，不原样保留。 */
const V2_KEYS = Object.freeze([
  "version", "enabled", "tools", "sections", "skills", "catalog", "protected", "narrowPassThrough",
]);

/**
 * v2 的 `skills` 只有 `{tier}` 一个字段（0.1.8 的技能轴）。
 * 0.3.0 起 `skills` 是 v3 的**接管配置**（takeover/off/imports），名字撞了但语义不同：
 * 只有带 tier 且不带接管字段的才是 v2 形状，别把 v3 配置当老文件迁走。
 */
export function isV2SkillsShape(value) {
  if (!isPlainObject(value)) return false;
  if (value.takeover !== undefined || value.off !== undefined || value.imports !== undefined) return false;
  return value.tier !== undefined;
}

/**
 * 0.1.8 的 skills.tier=1 语义是「保留宿主技能目录」，不是「把每条技能正文塞进系统提示词」。
 * 0.3.0 接管后 resident 变成正文注入，照字面迁移会把整库技能正文灌进提示词。
 * 迁移时把 1 降到按需（目录可见、gate_load 取正文），并让调用方记一条告警。
 */
export function mapLegacySkillTier(value, fallback) {
  const tier = normalizeTier(value, fallback);
  return tier === TIER_RESIDENT ? TIER_ONDEMAND : tier;
}

/** 技能接管配置的归一形状（键序固定：takeover / off / imports）。 */
export function normalizeSkillsConfig(raw) {
  const input = isPlainObject(raw) ? raw : {};
  const off = [...new Set((Array.isArray(input.off) ? input.off : []).filter((name) => typeof name === "string" && name.length > 0))].sort();
  const imports = [];
  const seen = new Set();
  for (const item of Array.isArray(input.imports) ? input.imports : []) {
    // 也接受裸字符串写法（等价于 {path}），省得手写配置时多一层括号。
    const entry = typeof item === "string" ? { path: item } : isPlainObject(item) ? item : undefined;
    if (entry === undefined) continue;
    const rawPath = typeof entry.path === "string" ? entry.path.trim() : "";
    if (rawPath.length === 0) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const key = id + "\u0000" + rawPath;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = {};
    if (id.length > 0) row.id = id;
    row.path = rawPath;
    imports.push(row);
  }
  return { takeover: input.takeover !== false, off, imports };
}

/** 合并技能接管配置：提交了的字段整条替换（off/imports 是清单，不逐项拼）。 */
export function mergeSkillsConfig(base, incoming) {
  const out = normalizeSkillsConfig(base);
  if (!isPlainObject(incoming)) return out;
  if (typeof incoming.takeover === "boolean") out.takeover = incoming.takeover;
  if (Array.isArray(incoming.off)) out.off = normalizeSkillsConfig({ off: incoming.off }).off;
  if (Array.isArray(incoming.imports)) out.imports = normalizeSkillsConfig({ imports: incoming.imports }).imports;
  return out;
}

/**
 * MCP 接管配置的归一形状（0.3.0 票 15）：`{ servers: { <name>: <server config> } }`。
 *
 * 服务器声明逐项走 lib/mcp.js 的 normalizeServerConfig（serverName 语法、stdio/http 必填项、
 * args/env/headers 类型都在那一处校验）。**单条非法只丢弃这一条并告警**，不让整份策略失败 ——
 * 一条写坏的 MCP 配置不该把整个闸门（以及全部工具面）带崩。
 *
 * servers 按名字排序、字段序固定（transport / enabled / 超时 / transport 专属字段），保证落盘字节稳定。
 * 存进 gate.json 的条目不带 name（名字就是键），避免两份真源。
 *
 * @param {object} raw
 * @returns {{mcp: {servers: object}, warnings: object[]}}
 */
export function normalizeMcpConfig(raw) {
  const warnings = [];
  const input = isPlainObject(raw) ? raw : {};
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    warnings.push({ code: "invalid-mcp", message: "mcp 必须是对象，已忽略" });
  }
  const servers = {};
  if (input.servers !== undefined && !isPlainObject(input.servers)) {
    warnings.push({ code: "invalid-mcp-servers", message: "mcp.servers 必须是对象，已忽略" });
  } else {
    const source = isPlainObject(input.servers) ? input.servers : {};
    for (const name of Object.keys(source).sort()) {
      try {
        const normalized = normalizeServerConfig(name, source[name]);
        const { name: _ignored, ...rest } = normalized;
        servers[name] = rest;
      } catch (error) {
        warnings.push({
          code: "invalid-mcp-server",
          name,
          message: "MCP server \"" + name + "\" 配置非法，已丢弃 — " + String((error && error.message) || error),
        });
      }
    }
  }
  return { mcp: { servers }, warnings };
}

/** 这份文件是 v3 吗？有 version 就信 version；没有就看 v3 独有的键（容忍手写文件漏 version）。 */
export function isV3Policy(raw) {
  if (!isPlainObject(raw)) return false;
  const version = Number(raw.version);
  if (Number.isFinite(version)) return version >= POLICY_VERSION;
  return isPlainObject(raw.capabilities) || isPlainObject(raw.sources) || isPlainObject(raw.legacy) || isPlainObject(raw.defaults);
}

/** v2 是否对工具表做过显式表态（迁移后要不要丢掉模板里的常驻九件套，就看它）。 */
export function hasV2Tools(raw) {
  if (!isPlainObject(raw) || !isPlainObject(raw.tools)) return false;
  if (raw.tools.defaultTier !== undefined) return true;
  return isPlainObject(raw.tools.overrides) && Object.keys(raw.tools.overrides).length > 0;
}

function tierMapOf(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const key of Object.keys(raw).sort()) {
    const tier = normalizeTier(raw[key], undefined);
    if (tier !== undefined) out[key] = tier;
  }
  return out;
}

function sortedTierMap(map) {
  const out = {};
  for (const key of Object.keys(map || {}).sort()) out[key] = map[key];
  return out;
}

function mergeTierMap(base, incoming) {
  const out = Object.assign({}, isPlainObject(base) ? base : {});
  if (!isPlainObject(incoming)) return out;
  for (const [key, value] of Object.entries(incoming)) {
    const tier = normalizeTier(value, undefined);
    if (tier !== undefined) out[key] = tier;
  }
  return out;
}

/** 能力条目只保留 v3 认识的字段，键序固定（落盘字节稳定的前提）。 */
function normalizeCapabilities(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const id of Object.keys(raw).sort()) {
    const entry = raw[id];
    if (!isPlainObject(entry)) continue;
    const next = {};
    const tier = normalizeTier(entry.tier, undefined);
    if (tier !== undefined) next.tier = tier;
    const toolExceptions = tierMapOf(entry.toolExceptions);
    if (Object.keys(toolExceptions).length > 0) next.toolExceptions = toolExceptions;
    const sectionExceptions = tierMapOf(entry.sectionExceptions);
    if (Object.keys(sectionExceptions).length > 0) next.sectionExceptions = sectionExceptions;
    out[id] = next;
  }
  return out;
}

/** 显式来源映射：`{ "能力 id": { tools: [...], sections: [...] } }`，成员名去重排序。 */
function normalizeSources(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const id of Object.keys(raw).sort()) {
    const entry = raw[id];
    if (!isPlainObject(entry)) continue;
    const next = {};
    for (const key of ["tools", "sections"]) {
      const list = Array.isArray(entry[key]) ? entry[key].filter((name) => typeof name === "string" && name.length > 0) : [];
      if (list.length > 0) next[key] = [...new Set(list)].sort();
    }
    out[id] = next;
  }
  return out;
}

function normalizeLegacy(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  out.unknownOverrides = sortedTierMap(tierMapOf(raw.unknownOverrides));
  for (const key of Object.keys(raw).sort()) {
    if (key === "unknownOverrides") continue;
    out[key] = clone(raw[key]);
  }
  return out;
}

/**
 * 把任意 v3（或半 v3）形状规范化成落盘/运行时唯一形状。
 * 返回 { policy, provided }：provided 记录「这一层显式写了什么」，供 resolvePolicy 决定
 * 要不要拿空模板里的常驻九件套当基底（写了 defaults 或 v2 工具表就说明用户想自己定）。
 */
export function normalizeV3Policy(raw) {
  const input = isPlainObject(raw) ? raw : {};
  const keys = new Set(Object.keys(input));
  const provided = {
    keys,
    defaults: isPlainObject(input.defaults),
    capabilities: isPlainObject(input.capabilities),
    sources: isPlainObject(input.sources),
    legacy: isPlainObject(input.legacy),
    v2Tools: hasV2Tools(input),
  };
  const givenDefaults = isPlainObject(input.defaults) ? input.defaults : {};
  const legacyInput = isPlainObject(input.legacy) ? input.legacy : {};
  // MCP 归一可能丢弃坏条目：告警随结果一起交给 resolvePolicy，由它统一写日志。
  const mcp = normalizeMcpConfig(input.mcp);
  const policy = {
    version: POLICY_VERSION,
    enabled: input.enabled !== false,
    // 只认显式 false：没写 / 坏值都按默认 true（PTC 冻结），与 POLICY_KEYS 的 fallback 同源。
    freezePtcToolset: input.freezePtcToolset !== false,
    defaults: {
      capability: normalizeTier(givenDefaults.capability, CAPABILITY_DEFAULTS.capability),
      section: normalizeTier(givenDefaults.section, CAPABILITY_DEFAULTS.section),
      // 0.1.8 的 skills.tier 是技能轴的旧写法，等价于 defaults.skillpack（只读别名）。
      // 0.3.0 的 v3 skills 是接管配置（takeover/off/imports），没有 tier，别拿它当默认层。
      skillpack: normalizeTier(
        givenDefaults.skillpack,
        isV2SkillsShape(input.skills) ? mapLegacySkillTier(input.skills.tier, CAPABILITY_DEFAULTS.skillpack) : CAPABILITY_DEFAULTS.skillpack,
      ),
    },
    capabilities: normalizeCapabilities(input.capabilities),
    sources: normalizeSources(input.sources),
    legacy: normalizeLegacy(legacyInput),
    catalog: Object.assign({}, CATALOG_DEFAULTS, isPlainObject(input.catalog) ? clone(input.catalog) : {}),
    narrowPassThrough: normalizeCount(input.narrowPassThrough, V2_DEFAULTS.narrowPassThrough),
    protected: [...new Set((Array.isArray(input.protected) ? input.protected : []).filter((name) => typeof name === "string" && name.length > 0))].sort(),
    // 0.3.0（工单 14）：技能接管配置。追加在末尾，既有键的落盘字节不动。
    skills: normalizeSkillsConfig(input.skills),
    // 0.3.0（工单 15）：MCP 接管声明（servers 逐项校验，坏条目丢弃并告警）。
    mcp: mcp.mcp,
  };
  // 表外扩展键：用户手写的，保存一次不能消失（0.1.8 的承诺，v3 继续守）。
  for (const key of Object.keys(input).sort()) {
    if (V3_KEYS.includes(key)) continue;
    if (key === "tools" || key === "sections") continue;
    policy[key] = clone(input[key]);
  }
  const legacySkillResident = isV2SkillsShape(input.skills)
    && normalizeTier(input.skills.tier, CAPABILITY_DEFAULTS.skillpack) === TIER_RESIDENT;
  const warnings = [...mcp.warnings];
  if (legacySkillResident && givenDefaults.skillpack === undefined) {
    warnings.push({
      code: "skills-tier-remapped",
      kind: "skills",
      message: "skills.tier=1 是「保留宿主目录」；0.3.0 接管后常驻等于正文注入，已降为按需（2），需要正文常驻请逐条设 skill:<name>=1",
    });
  }
  return { policy, provided, warnings };
}

/**
 * v2 → v3 迁移。
 *
 * 归并口径：每个 override 先按名字归到能力 id（mcp / plugin / native / tool / section），
 * 同一能力内档位冲突取最宽松；该轴有任何一个成员偏离能力档，就把该轴**全部**成员写成
 * 例外 —— 否则“univer_*:0 + univer_sheet:1”这种更具体压过通配的语义会在迁移里丢掉。
 *
 * @param {object} raw v2 策略
 * @param {{knownNames?: Set<string>}} [options] 当前视图里的工具名（没有就只认 RETIRED 清单）
 * @returns {{policy: object, warnings: object[], provided: object, migrated: boolean, fromVersion: number}}
 */
export function migrateV2ToV3(raw, options) {
  const input = isPlainObject(raw) ? raw : {};
  const opts = options || {};
  const warnings = [];
  const known = opts.knownNames instanceof Set && opts.knownNames.size > 0 ? opts.knownNames : undefined;
  const tools = isPlainObject(input.tools) ? input.tools : {};
  const sections = isPlainObject(input.sections) ? input.sections : {};
  const toolDefaults = normalizeTier(tools.defaultTier, V2_DEFAULTS.capability);
  const sectionDefaults = normalizeTier(sections.defaultTier, V2_DEFAULTS.section);
  const rawSkillTier = isPlainObject(input.skills) ? normalizeTier(input.skills.tier, V2_DEFAULTS.skillpack) : V2_DEFAULTS.skillpack;
  const skillTier = mapLegacySkillTier(rawSkillTier, V2_DEFAULTS.skillpack);
  if (rawSkillTier === TIER_RESIDENT) {
    warnings.push({
      code: "skills-tier-remapped",
      kind: "skills",
      message: "v2 的 skills.tier=1 是「保留宿主目录」；0.3.0 接管后常驻等于正文注入，已降为按需（2），需要正文常驻请逐条设 skill:<name>=1",
    });
  }
  const unknownOverrides = {};
  /** @type {{kind: "tool"|"section", name: string, tier: number, id: string}[]} */
  const assignments = [];

  for (const [name, value] of Object.entries(isPlainObject(tools.overrides) ? tools.overrides : {})) {
    if (typeof name !== "string" || name.length === 0) continue;
    const tier = normalizeTier(value, toolDefaults);
    const id = capabilityIdOfToolName(name);
    // 退休名单永远优先：ws_mcp_call 已经不存在于任何一层，就算当前视图里碰巧有同名注册，
    // 迁成能力也只会得到一个永远不生效的开关 —— 必须落 legacy.unknownOverrides 并告警。
    // 其余推不出来源的键：当前工具面里确认没有才当悬空键（有就照常迁成能力）。
    const retired = RETIRED_TOOL_NAMES.has(name);
    const dangling = retired || (id.startsWith("tool:") && !name.includes("*") && !name.includes("?") &&
      known !== undefined && !known.has(name));
    if (dangling) {
      unknownOverrides[name] = tier;
      warnings.push({ code: "dangling-key", kind: "tool", name, message: "v2 遗留键 " + name + " 当前无对应工具/能力，已移入 legacy.unknownOverrides" });
      continue;
    }
    assignments.push({ kind: "tool", name, tier, id });
  }

  for (const [name, value] of Object.entries(isPlainObject(sections.overrides) ? sections.overrides : {})) {
    if (typeof name !== "string" || name.length === 0) continue;
    assignments.push({ kind: "section", name, tier: normalizeTier(value, sectionDefaults), id: capabilityIdOfSectionName(name) });
  }

  const groups = new Map();
  for (const row of assignments) {
    if (!groups.has(row.id)) groups.set(row.id, []);
    groups.get(row.id).push(row);
  }

  const capabilities = {};
  for (const id of [...groups.keys()].sort()) {
    const rows = groups.get(id);
    let loosest = rows[0].tier;
    for (const row of rows) if (loosenessRank(row.tier) < loosenessRank(loosest)) loosest = row.tier;
    const entry = { tier: loosest };
    let conflicted = false;
    for (const kind of ["tool", "section"]) {
      const axis = rows.filter((row) => row.kind === kind);
      if (axis.length === 0) continue;
      if (axis.some((row) => row.tier !== loosest)) {
        conflicted = true;
        const exceptions = {};
        for (const row of axis) exceptions[row.name] = row.tier;
        entry[kind === "section" ? "sectionExceptions" : "toolExceptions"] = sortedTierMap(exceptions);
      }
    }
    if (conflicted) {
      warnings.push({
        code: "tier-conflict",
        kind: "capability",
        capability: id,
        message: "v2 里同一能力档位冲突，已取最宽松 " + loosest + "，偏离成员写成例外：" +
          rows.map((row) => row.kind + " " + row.name + "=" + row.tier).join(", "),
      });
    }
    capabilities[id] = entry;
  }

  const givenDefaults = isPlainObject(input.defaults) ? input.defaults : {};
  const defaults = {
    capability: normalizeTier(givenDefaults.capability, toolDefaults),
    section: normalizeTier(givenDefaults.section, sectionDefaults),
    skillpack: normalizeTier(givenDefaults.skillpack, skillTier),
  };
  // 已存在的 v3 片段优先（保存路径会把 v2 旧文件与 v3 新提交合成一份再走这里）：
  // 迁移只负责补 v2 的落点，不能把新模型里已经写好的能力/来源/遗留键抹掉。
  const mergedCapabilities = mergeCapabilities(capabilities, input.capabilities);
  const mergedSources = mergeSources({}, input.sources);
  const legacyIn = isPlainObject(input.legacy) ? input.legacy : {};
  const mergedLegacy = Object.assign({}, clone(legacyIn), {
    unknownOverrides: mergeTierMap(unknownOverrides, legacyIn.unknownOverrides),
  });
  const extra = {};
  for (const key of Object.keys(input).sort()) {
    if (V2_KEYS.includes(key) || V3_KEYS.includes(key)) continue;
    extra[key] = clone(input[key]);
  }
  const normalized = normalizeV3Policy(Object.assign({
    version: POLICY_VERSION,
    enabled: input.enabled,
    freezePtcToolset: input.freezePtcToolset,
    defaults,
    capabilities: mergedCapabilities,
    sources: mergedSources,
    legacy: mergedLegacy,
    catalog: input.catalog,
    narrowPassThrough: input.narrowPassThrough,
    protected: input.protected,
    // v2 的 skills 只有 tier（已吸收进 defaults.skillpack）；v3 的接管配置原样带过去。
    skills: isV2SkillsShape(input.skills) ? undefined : input.skills,
    // 0.3.0：v2 没有 mcp；混写 v3 片段时原样带过去，缺省由 normalize 补 { servers: {} }。
    mcp: input.mcp,
  }, extra));
  for (const warning of normalized.warnings || []) warnings.push(warning);
  const policy = normalized.policy;

  return {
    policy,
    warnings,
    provided: {
      keys: new Set(Object.keys(input)),
      // v2 的 defaults 是从 tools/sections/skills 派生的，不算“用户显式写了 defaults”。
      defaults: false,
      capabilities: Object.keys(mergedCapabilities).length > 0,
      sources: Object.keys(mergedSources).length > 0,
      legacy: Object.keys(mergedLegacy.unknownOverrides).length > 0,
      v2Tools: hasV2Tools(input),
      mcp: isPlainObject(input.mcp),
      fromV2: true,
    },
    migrated: true,
    fromVersion: Number(input.version) || 2,
  };
}

/**
 * 备份 v2 策略文件。同名内容只留一份（迁移会在每次插件启动时重跑，别每秒堆一个备份）。
 * 写入无 BOM：宿主会 JSON.parse 这个目录里的策略文件。
 * @returns {string|undefined} 新备份路径；已存在同内容备份时 undefined
 */
export function backupV2PolicyFile(file, text) {
  if (typeof file !== "string" || file.length === 0) return undefined;
  const dir = path.dirname(file);
  const base = path.basename(file);
  const prefix = base + ".v2.bak-";
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return undefined; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      if (fs.readFileSync(path.join(dir, name), "utf8") === text) return undefined;
    } catch { /* 单个备份读不了不影响主流程 */ }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let target = path.join(dir, prefix + stamp);
  let suffix = 1;
  while (fs.existsSync(target)) target = path.join(dir, prefix + stamp + "-" + suffix++);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, Buffer.from(text, "utf8"));
  return target;
}

/** 能力条目逐字段合并（保存路径与层合并共用）。后写的赢。 */
export function mergeCapabilities(base, incoming) {
  const out = clone(isPlainObject(base) ? base : {});
  if (!isPlainObject(incoming)) return out;
  for (const [id, entry] of Object.entries(incoming)) {
    if (!isPlainObject(entry)) continue;
    const current = isPlainObject(out[id]) ? out[id] : {};
    const next = Object.assign({}, current);
    if (entry.tier !== undefined) {
      const tier = normalizeTier(entry.tier, undefined);
      if (tier !== undefined) next.tier = tier;
    }
    for (const key of ["toolExceptions", "sectionExceptions"]) {
      if (!isPlainObject(entry[key])) continue;
      next[key] = Object.assign({}, isPlainObject(current[key]) ? current[key] : {});
      for (const [pattern, value] of Object.entries(entry[key])) {
        const tier = normalizeTier(value, undefined);
        if (tier !== undefined) next[key][pattern] = tier;
      }
    }
    out[id] = next;
  }
  return out;
}

/** 显式来源映射逐 id 合并：提交了哪个 id 就整条替换它的成员清单。 */
export function mergeSources(base, incoming) {
  const out = clone(isPlainObject(base) ? base : {});
  if (!isPlainObject(incoming)) return out;
  for (const [id, entry] of Object.entries(incoming)) {
    if (!isPlainObject(entry)) continue;
    const next = Object.assign({}, isPlainObject(out[id]) ? out[id] : {});
    for (const key of ["tools", "sections"]) {
      if (!Array.isArray(entry[key])) continue;
      next[key] = entry[key].filter((name) => typeof name === "string" && name.length > 0);
    }
    out[id] = next;
  }
  return out;
}
