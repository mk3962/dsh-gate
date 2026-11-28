/**
 * v2 → v3 迁移与 v3 规范化（0.2.0；0.6.0 起键集/默认值全部来自 policy-schema.js）。
 *
 * v2 是「一张工具表 + 一张段落表 + 默认层」，v3 是「能力 + 例外 + defaults」。
 * 迁移的硬要求（docs/dsh-gate-0.2.0-04-能力模型与v3策略.md §5）：
 *   - 同一能力内档位冲突取**最宽松**（resident < on-demand < off），其余成员写成例外；
 *   - 推断不了的键进 legacy.unknownOverrides 只告警、不参与解析；
 *   - 同一份 v2 迁两次必须逐字节一致 —— 所以键序、数组序全部在这里定死；
 *   - 原 v2 文件不动：先在旁边留一份 gate.json.v2.bak-<时间戳>（独占创建 + 原子落地），回滚包照旧可用；
 *   - 进入 v3 键集合的键**必然透传**（0.6.0 修 P1-3：repeatGuard 曾被漏掉而静默重置）。
 *
 * 规范化本身只有一份实现（policy-schema.js 的 normalizePolicyDocument）；这里只是
 * v2 形状的翻译层 + 备份，外加保持旧的导出符号不变。
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
import { pruneBackups } from "./storage-seam.js";
import {
  CATALOG_DEFAULTS,
  NARROW_PASS_THROUGH_DEFAULT,
  POLICY_KEY_NAMES,
  POLICY_VERSION,
  isV2SkillsShape,
  mapLegacySkillTier,
  mergeCapabilities,
  mergeSkillsConfig,
  mergeSources,
  normalizeMcpConfig,
  normalizePolicyDocument,
  normalizeSkillsConfig,
} from "./policy-schema.js";

// 旧导出路径保持不变（policy.js / server.js / 测试都从这里取）。
export {
  CATALOG_DEFAULTS,
  POLICY_VERSION,
  isV2SkillsShape,
  mapLegacySkillTier,
  mergeCapabilities,
  mergeSkillsConfig,
  mergeSources,
  normalizeMcpConfig,
  normalizeSkillsConfig,
};

/** v2 的默认层（迁移时逐轴回落；与 0.1.8 的默认一致）。 */
export const V2_DEFAULTS = Object.freeze({
  capability: TIER_ONDEMAND,
  section: TIER_RESIDENT,
  skillpack: TIER_ONDEMAND,
  narrowPassThrough: NARROW_PASS_THROUGH_DEFAULT,
});

/** v2 里曾经存在、现在已经没有对应工具的名字：迁移时直接进 legacy 并告警。 */
export const RETIRED_TOOL_NAMES = Object.freeze(new Set(["ws_mcp_call", "gate_call"]));

/** v3 的顶层键（从 schema 派生，不再手写第二份）。 */
const V3_KEYS = Object.freeze([...POLICY_KEY_NAMES]);

/** v2 的顶层键：迁移时被吸收，不原样保留。 */
const V2_KEYS = Object.freeze([
  "version", "enabled", "tools", "sections", "skills", "catalog", "protected", "narrowPassThrough",
]);

/** 迁移自己计算、不从 v2 输入透传的键。 */
const MIGRATION_COMPUTED = new Set(["version", "enabled", "freezePtcToolset", "defaults", "capabilities", "sources", "legacy"]);

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

/**
 * 把任意 v3（或半 v3）形状规范化成落盘/运行时唯一形状。
 * 归一只有一份实现（policy-schema.js），这里只保留旧导出名。
 *
 * @returns {{policy: object, provided: object, warnings: object[]}}
 */
export function normalizeV3Policy(raw) {
  return normalizePolicyDocument(raw);
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
    // 退休名单永远优先：ws_mcp_call / gate_call 已经不存在于任何一层，就算当前视图里碰巧有同名注册，
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
  // 进入 v3 键集合的其余键**必然透传**（P1-3：repeatGuard 曾经漏在这里，被静默重置成默认值）。
  const carried = {};
  for (const key of V3_KEYS) {
    if (MIGRATION_COMPUTED.has(key)) continue;
    if (key === "skills" && isV2SkillsShape(input.skills)) continue;
    if (input[key] !== undefined) carried[key] = input[key];
  }
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
  }, carried, extra));
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
 * 备份 v2 策略文件（D3：先建目录、独占创建、原子落地、保留上限可配）。
 *
 * 同名内容只留一份（迁移会在每次插件启动时重跑，别每秒堆一个备份）。
 * 写入无 BOM：宿主会 JSON.parse 这个目录里的策略文件。
 * 失败**绝不覆盖**已有备份：临时文件独占创建，rename 失败就清掉临时文件后抛错。
 *
 * @param {string} file 原策略文件路径
 * @param {string} text 原文
 * @param {{retention?: number, stamp?: string}} [options]
 * @returns {string|undefined} 新备份路径；已存在同内容备份时 undefined
 */
export function backupV2PolicyFile(file, text, options) {
  if (typeof file !== "string" || file.length === 0) return undefined;
  const opts = options || {};
  const dir = path.dirname(file);
  const base = path.basename(file);
  const prefix = base + ".v2.bak-";
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 目录建不出来时下面的写会明确失败 */ }
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return undefined; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      if (fs.readFileSync(path.join(dir, name), "utf8") === text) return undefined;
    } catch { /* 单个备份读不了不影响主流程 */ }
  }
  const stamp = typeof opts.stamp === "string" && opts.stamp.length > 0
    ? opts.stamp
    : new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(dir, prefix + stamp);
  if (fs.existsSync(target)) return undefined; // 同名内容已存在（stamp 固定时可复现）
  const temp = target + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2, 8);
  try {
    fs.writeFileSync(temp, Buffer.from(text, "utf8"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* 忽略 */ }
    throw error;
  }
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* 忽略 */ }
    throw error;
  }
  pruneBackups(dir, prefix, opts.retention === undefined ? 20 : opts.retention);
  return target;
}
