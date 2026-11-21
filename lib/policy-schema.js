/**
 * 策略字段规格表（#02 · ADR A-2 / be:D1 / A6–A12）—— **唯一一份**字段真源。
 *
 * 这张表同时驱动六件事，任何一件都不许再手抄第二份：
 *   1) 空策略模板（emptyPolicyTemplate）的键与默认值；
 *   2) 磁盘读取的宽容归一（normalizePolicyDocument，旧的 normalizeV3Policy）；
 *   3) 保存时的逐键合并（mergePolicyLayer，旧的 mergePolicyFile 内核）；
 *   4) 严格写入校验（validatePolicyInput：未知键 / 非法类型 / 越界 / 非法枚举立即拒绝）；
 *   5) 前端模板与文档的内省（describePolicySchema，供 #07 面板与 #08 check-spec 交叉校验）；
 *   6) v2 迁移的透传键集（migrate.js 从 schema 派生，不再手写 V3_KEYS）。
 *
 * 字段声明形状：
 *   key         顶层键名（策略文件与插件行 config 同名）
 *   kind        合并/归一策略：flag / number / threshold / defaults / capabilities /
 *               sources / legacy / object / names / skills / mcp / guardrail
 *   merge       保存语义：replace / object / union
 *   type        严格校验的类型：boolean / integer / tier / tierMap / stringList /
 *               object / map / importList / serverMap
 *   fallback    内置默认值（同时是空模板里该键的值）
 *   constraints 数值边界（严格校验用）
 *   children    嵌套字段声明（对象型的已知子键）
 *   entry       映射型（capabilities / sources）的条目声明
 *   closed      严格校验时未知子键是否拒绝（false = 允许扩展键，如 legacy / catalog）
 *
 * 纪律：新增一个策略字段 = 在这里加一行；模板、归一、合并、校验、示例、迁移自动跟上。
 */
import { CAPABILITY_DEFAULTS } from "./capabilities.js";
import { normalizeSignatureSummary } from "./catalog.js";
import { normalizeRepeatGuardConfig } from "./guardrail.js";
import { normalizeServerConfig } from "./mcp.js";
import {
  TIER_OFF,
  TIER_ONDEMAND,
  TIER_RESIDENT,
  clone,
  isPlainObject,
  normalizeCount,
  normalizeTier,
} from "./tiers.js";

/** 策略版本（v3）。数字唯一出口：模板、归一、迁移都读这里。 */
export const POLICY_VERSION = 3;

/** 委派收窄豁免阈值的默认值（2026-11-01 事故，见 policy.js 说明）。 */
export const NARROW_PASS_THROUGH_DEFAULT = 12;

/** 目录渲染默认值（catalog 三键 + 签名摘要）。 */
export const CATALOG_DEFAULTS = Object.freeze({
  groupByPlugin: true,
  maxDescriptionLength: 64,
  skillGroups: false,
});

/** 技能接管默认值（键序固定：takeover / activationRelay / activationPromote / off / imports）。 */
export const SKILLS_DEFAULTS = Object.freeze({
  takeover: true,
  activationRelay: true,
  activationPromote: true,
  off: [],
  imports: [],
});

/** 闸门自己的工具 + PTC 传输，任何策略都动不了。 */
export const INTRINSIC_PROTECTED = Object.freeze([
  "run_code",
  "gate_search",
  "gate_load",
  "gate_call",
  "gate_status",
  // PTC 冻结下的唯一执行口（工单 07）：被策略藏掉就再也调不动任何按需工具了。
  "gate_invoke",
]);

/**
 * 没写策略时默认常驻的原生工具（0.1.8 的「十件套」去掉已退休的 ws_mcp_call）。
 * 原生工具彼此独立成能力（native:<tool>），这里只是把它们的默认档显式写出来，
 * 免得展开成 defaults.capability=2 把 read/write/pwsh 一起藏掉。
 */
export const DEFAULT_RESIDENT_NATIVE = Object.freeze([
  "read", "write", "edit", "grep", "glob", "pwsh", "web_search", "web_fetch", "skill",
]);

function residentNativeCapabilities() {
  const out = {};
  for (const name of DEFAULT_RESIDENT_NATIVE) out["native:" + name] = { tier: TIER_RESIDENT };
  return out;
}

/** 深冻结（表本身不许被运行期改坏；值由 clone 提供新副本）。 */
function freezeDeep(value) {
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
    return Object.freeze(value);
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    return Object.freeze(value);
  }
  return value;
}

const field = (spec) => freezeDeep(spec);

const DEFAULT_REPEAT_GUARD = normalizeRepeatGuardConfig(undefined);

/**
 * 顶层字段规格表（键序 = 落盘键序 = 模板键序）。
 * v2 的 tools / sections / skills.tier 不是独立真源：工具与段落由「能力 + 例外」派生。
 */
export const POLICY_FIELDS = Object.freeze([
  field({
    key: "version",
    kind: "number",
    merge: "replace",
    type: "integer",
    constraints: { min: 1 },
    fallback: POLICY_VERSION,
    summary: "策略版本（v3 = 3）",
  }),
  field({
    key: "enabled",
    kind: "flag",
    merge: "replace",
    type: "boolean",
    fallback: true,
    summary: "总开关；关闭时撤销全部限制（I-3 / A15）",
  }),
  field({
    key: "freezePtcToolset",
    kind: "flag",
    merge: "replace",
    type: "boolean",
    fallback: true,
    summary: "PTC 会话冻结工具表、改由末尾声明 + gate_invoke 执行",
  }),
  field({
    key: "defaults",
    kind: "defaults",
    merge: "object",
    type: "object",
    closed: true,
    fallback: {
      capability: CAPABILITY_DEFAULTS.capability,
      section: CAPABILITY_DEFAULTS.section,
      skillpack: CAPABILITY_DEFAULTS.skillpack,
    },
    children: [
      field({ key: "capability", type: "tier", fallback: CAPABILITY_DEFAULTS.capability, summary: "未声明能力档" }),
      field({ key: "section", type: "tier", fallback: CAPABILITY_DEFAULTS.section, summary: "未声明段落档" }),
      field({ key: "skillpack", type: "tier", fallback: CAPABILITY_DEFAULTS.skillpack, summary: "未声明技能包档" }),
    ],
    summary: "能力 / 段落 / 技能包三轴的默认档",
  }),
  field({
    key: "capabilities",
    kind: "capabilities",
    merge: "object",
    type: "map",
    closed: true,
    fallback: residentNativeCapabilities(),
    entry: field({
      type: "object",
      closed: true,
      children: [
        field({ key: "tier", type: "tier", summary: "该能力档" }),
        field({ key: "toolExceptions", type: "tierMap", summary: "工具成员例外（最具体命中）" }),
        field({ key: "sectionExceptions", type: "tierMap", summary: "段落成员例外" }),
      ],
    }),
    summary: "能力档与成员例外：<能力 id> -> { tier, toolExceptions, sectionExceptions }",
  }),
  field({
    key: "sources",
    kind: "sources",
    merge: "object",
    type: "map",
    closed: true,
    fallback: {},
    entry: field({
      type: "object",
      closed: true,
      children: [
        field({ key: "tools", type: "stringList", summary: "显式成员工具名" }),
        field({ key: "sections", type: "stringList", summary: "显式成员段落名" }),
      ],
    }),
    summary: "显式来源映射：<能力 id> -> { tools[], sections[] }",
  }),
  field({
    key: "legacy",
    kind: "legacy",
    merge: "object",
    type: "object",
    closed: false,
    fallback: { unknownOverrides: {} },
    children: [
      field({ key: "unknownOverrides", type: "tierMap", fallback: {}, summary: "迁移留下的悬空键（只展示不解析）" }),
    ],
    summary: "v2 遗留键（unknownOverrides + 用户自定义扩展）",
  }),
  field({
    key: "catalog",
    kind: "object",
    merge: "object",
    type: "object",
    closed: false,
    fallback: {
      groupByPlugin: CATALOG_DEFAULTS.groupByPlugin,
      maxDescriptionLength: CATALOG_DEFAULTS.maxDescriptionLength,
      skillGroups: CATALOG_DEFAULTS.skillGroups,
      signatureSummary: { enabled: true, tools: [] },
    },
    children: [
      field({ key: "groupByPlugin", type: "boolean", fallback: CATALOG_DEFAULTS.groupByPlugin, summary: "按插件分组" }),
      field({
        key: "maxDescriptionLength",
        type: "integer",
        fallback: CATALOG_DEFAULTS.maxDescriptionLength,
        constraints: { min: 0, max: 4096 },
        summary: "描述截断长度",
      }),
      field({ key: "skillGroups", type: "boolean", fallback: CATALOG_DEFAULTS.skillGroups, summary: "技能行折叠分组" }),
      field({
        key: "signatureSummary",
        type: "object",
        closed: true,
        fallback: { enabled: true, tools: [] },
        children: [
          field({ key: "enabled", type: "boolean", fallback: true, summary: "是否渲染签名摘要" }),
          field({ key: "tools", type: "stringList", fallback: [], summary: "点名渲染摘要的工具" }),
        ],
        summary: "PTC 冻结下的工具签名摘要",
      }),
    ],
    summary: "目录渲染配置",
  }),
  field({
    key: "protected",
    kind: "names",
    merge: "union",
    type: "stringList",
    fallback: [],
    summary: "额外受保护工具名（内置名单不可减，只能加）",
  }),
  field({
    key: "narrowPassThrough",
    kind: "threshold",
    merge: "replace",
    type: "integer",
    constraints: { min: 0, max: 1000 },
    fallback: NARROW_PASS_THROUGH_DEFAULT,
    summary: "委派收窄豁免阈值（0 = 关闭豁免）",
  }),
  field({
    key: "skills",
    kind: "skills",
    merge: "object",
    type: "object",
    closed: true,
    fallback: SKILLS_DEFAULTS,
    children: [
      field({ key: "takeover", type: "boolean", fallback: true, summary: "gate 接管宿主技能目录与正文" }),
      field({ key: "activationRelay", type: "boolean", fallback: true, summary: "补发宿主 skill 激活伪事件" }),
      field({ key: "activationPromote", type: "boolean", fallback: true, summary: "加载时放出 conditional 注册工具" }),
      field({ key: "off", type: "stringList", fallback: [], summary: "逐技能关闭接管的名单" }),
      field({ key: "imports", type: "importList", fallback: [], summary: "外部技能目录 [{ id?, path }]" }),
    ],
    summary: "技能接管配置",
  }),
  field({
    key: "mcp",
    kind: "mcp",
    merge: "object",
    type: "object",
    closed: true,
    fallback: { servers: {} },
    children: [
      field({ key: "servers", type: "serverMap", fallback: {}, summary: "<name> -> MCP server 声明（整表替换）" }),
    ],
    summary: "MCP 接管声明",
  }),
  field({
    key: "repeatGuard",
    kind: "guardrail",
    merge: "object",
    type: "object",
    closed: true,
    fallback: DEFAULT_REPEAT_GUARD,
    children: [
      field({ key: "enabled", type: "boolean", fallback: false, summary: "是否启用重复调用护栏（默认关）" }),
      field({ key: "windowSize", type: "integer", fallback: 20, constraints: { min: 2, max: 200 }, summary: "统计窗口" }),
      field({ key: "windowThreshold", type: "integer", fallback: 3, constraints: { min: 2, max: 50 }, summary: "触发阈值" }),
      field({ key: "maxRemindersPerEpisode", type: "integer", fallback: 2, constraints: { min: 1, max: 5 }, summary: "每回合最多提醒次数" }),
      field({ key: "exclude", type: "stringList", fallback: [], summary: "追加豁免名单（默认五项恒在）" }),
      field({ key: "argumentsPreviewChars", type: "integer", fallback: 500, constraints: { min: 40, max: 4000 }, summary: "参数预览字符数" }),
    ],
    summary: "重复调用护栏配置",
  }),
]);

/** 顶层键名（按表序）。 */
export const POLICY_KEY_NAMES = Object.freeze(POLICY_FIELDS.map((spec) => spec.key));

const FIELD_BY_KEY = new Map(POLICY_FIELDS.map((spec) => [spec.key, spec]));

export function isPolicySchemaKey(key) {
  return FIELD_BY_KEY.has(key);
}

export function schemaFieldOf(key) {
  return FIELD_BY_KEY.get(key);
}

/** 兼容旧 POLICY_KEYS 形状（{key, kind, merge, fallback}），由同一张表派生。 */
export function policyKeyRows() {
  return Object.freeze(POLICY_FIELDS.map((spec) => field({
    key: spec.key,
    kind: spec.kind,
    merge: spec.merge,
    fallback: clone(spec.fallback),
  })));
}

/** 空策略模板：每个键取其内置默认，与 normalize 的兜底同一份值。 */
export function emptyPolicyTemplate() {
  const out = {};
  for (const spec of POLICY_FIELDS) out[spec.key] = clone(spec.fallback);
  return out;
}

/** 内省用：把表展开成可序列化描述（#07 面板 / #08 check-spec / 文档共用）。 */
export function describePolicySchema() {
  const describeField = (spec) => {
    const out = { key: spec.key, type: spec.type, summary: spec.summary };
    if (spec.kind !== undefined) out.kind = spec.kind;
    if (spec.merge !== undefined) out.merge = spec.merge;
    if (spec.constraints !== undefined) out.constraints = clone(spec.constraints);
    if (spec.fallback !== undefined) out.fallback = clone(spec.fallback);
    if (spec.closed !== undefined) out.closed = spec.closed;
    if (Array.isArray(spec.children)) out.children = spec.children.map(describeField);
    if (spec.entry !== undefined) {
      out.entry = {
        type: spec.entry.type,
        closed: spec.entry.closed === true,
        children: (spec.entry.children || []).map(describeField),
      };
    }
    return out;
  };
  return {
    version: POLICY_VERSION,
    keys: [...POLICY_KEY_NAMES],
    fields: POLICY_FIELDS.map(describeField),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 宽容归一（磁盘读取一侧）：与 strict 校验分离——读进来的历史文件不该因为多一个
// 扩展键就整份失效，但形状问题必须在结果里可识别（normalize 只做归一，不吞诊断）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v2 的 skills 只有 { tier } 一个字段（0.1.8 的技能轴）。
 * 0.3.0 起 skills 是 v3 的接管配置（takeover/off/imports），名字撞了但语义不同：
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

/** 技能接管配置的归一形状（键序固定：takeover / activationRelay / activationPromote / off / imports）。 */
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
  return {
    takeover: input.takeover !== false,
    activationRelay: input.activationRelay !== false,
    activationPromote: input.activationPromote !== false,
    off,
    imports,
  };
}

/** 合并技能接管配置：提交了的字段整条替换（off/imports 是清单，不逐项拼）。 */
export function mergeSkillsConfig(base, incoming) {
  const out = normalizeSkillsConfig(base);
  if (!isPlainObject(incoming)) return out;
  if (typeof incoming.takeover === "boolean") out.takeover = incoming.takeover;
  if (typeof incoming.activationRelay === "boolean") out.activationRelay = incoming.activationRelay;
  if (typeof incoming.activationPromote === "boolean") out.activationPromote = incoming.activationPromote;
  if (Array.isArray(incoming.off)) out.off = normalizeSkillsConfig({ off: incoming.off }).off;
  if (Array.isArray(incoming.imports)) out.imports = normalizeSkillsConfig({ imports: incoming.imports }).imports;
  return out;
}

/**
 * MCP 接管配置的归一形状：{ servers: { <name>: <server config> } }。
 * 单条非法只丢弃这一条并告警，不让整份策略失败（一条写坏的 MCP 配置不该把整个闸门带崩）。
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

/** 显式来源映射：{ "能力 id": { tools: [...], sections: [...] } }，成员名去重排序。 */
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

function normalizeCatalog(raw) {
  const input = isPlainObject(raw) ? raw : {};
  const out = {
    groupByPlugin: input.groupByPlugin !== false,
    maxDescriptionLength: normalizeCount(input.maxDescriptionLength, CATALOG_DEFAULTS.maxDescriptionLength),
    skillGroups: input.skillGroups === true,
    signatureSummary: normalizeSignatureSummary(input.signatureSummary),
  };
  // 表外扩展子键：用户手写的，保存一次不能消失（0.1.8 的承诺，v3 继续守）。
  const known = new Set(["groupByPlugin", "maxDescriptionLength", "skillGroups", "signatureSummary"]);
  for (const key of Object.keys(input).sort()) {
    if (known.has(key)) continue;
    out[key] = clone(input[key]);
  }
  return out;
}

/**
 * 宽容归一：把任意（半）v3 形状规范成落盘/运行时唯一形状。
 * 返回 { policy, provided, warnings }；provided 记录「这一层显式写了什么」，
 * 供 resolvePolicy 决定要不要拿空模板里的常驻九件套当基底。
 */
export function normalizePolicyDocument(raw) {
  const input = isPlainObject(raw) ? raw : {};
  const keys = new Set(Object.keys(input));
  const provided = {
    keys,
    defaults: isPlainObject(input.defaults),
    capabilities: isPlainObject(input.capabilities),
    sources: isPlainObject(input.sources),
    legacy: isPlainObject(input.legacy),
    v2Tools: hasV2ToolsShape(input),
  };
  const givenDefaults = isPlainObject(input.defaults) ? input.defaults : {};
  const warnings = [];
  const policy = {};
  for (const spec of POLICY_FIELDS) {
    switch (spec.key) {
      case "version":
        policy.version = POLICY_VERSION;
        break;
      case "enabled":
        policy.enabled = input.enabled !== false;
        break;
      case "freezePtcToolset":
        // 只认显式 false：没写 / 坏值都按默认 true（PTC 冻结）。
        policy.freezePtcToolset = input.freezePtcToolset !== false;
        break;
      case "defaults":
        policy.defaults = {
          capability: normalizeTier(givenDefaults.capability, CAPABILITY_DEFAULTS.capability),
          section: normalizeTier(givenDefaults.section, CAPABILITY_DEFAULTS.section),
          // 0.1.8 的 skills.tier 是技能轴的旧写法，等价于 defaults.skillpack（只读别名）。
          skillpack: normalizeTier(
            givenDefaults.skillpack,
            isV2SkillsShape(input.skills) ? mapLegacySkillTier(input.skills.tier, CAPABILITY_DEFAULTS.skillpack) : CAPABILITY_DEFAULTS.skillpack,
          ),
        };
        break;
      case "capabilities":
        policy.capabilities = normalizeCapabilities(input.capabilities);
        break;
      case "sources":
        policy.sources = normalizeSources(input.sources);
        break;
      case "legacy":
        policy.legacy = normalizeLegacy(input.legacy);
        break;
      case "catalog":
        policy.catalog = normalizeCatalog(input.catalog);
        break;
      case "protected":
        policy.protected = [...new Set((Array.isArray(input.protected) ? input.protected : []).filter((name) => typeof name === "string" && name.length > 0))].sort();
        break;
      case "narrowPassThrough":
        policy.narrowPassThrough = normalizeCount(input.narrowPassThrough, NARROW_PASS_THROUGH_DEFAULT);
        break;
      case "skills":
        policy.skills = normalizeSkillsConfig(input.skills);
        break;
      case "mcp": {
        const mcp = normalizeMcpConfig(input.mcp);
        policy.mcp = mcp.mcp;
        for (const warning of mcp.warnings) warnings.push(warning);
        break;
      }
      case "repeatGuard":
        policy.repeatGuard = normalizeRepeatGuardConfig(input.repeatGuard);
        break;
      default:
        throw new Error("policy-schema: 字段 " + spec.key + " 缺归一分支");
    }
  }
  // 表外扩展键：用户手写的，保存一次不能消失；按 key 排序保证字节稳定。
  const knownKeys = new Set(POLICY_KEY_NAMES);
  for (const key of Object.keys(input).sort()) {
    if (knownKeys.has(key)) continue;
    if (key === "tools" || key === "sections") continue;
    policy[key] = clone(input[key]);
  }
  const legacySkillResident = isV2SkillsShape(input.skills)
    && normalizeTier(input.skills.tier, CAPABILITY_DEFAULTS.skillpack) === TIER_RESIDENT;
  if (legacySkillResident && givenDefaults.skillpack === undefined) {
    warnings.push({
      code: "skills-tier-remapped",
      kind: "skills",
      message: "skills.tier=1 是「保留宿主目录」；0.3.0 接管后常驻等于正文注入，已降为按需（2），需要正文常驻请逐条设 skill:<name>=1",
    });
  }
  return { policy, provided, warnings };
}

/** v2 是否对工具表做过显式表态（迁移后要不要丢掉模板里的常驻九件套，就看它）。 */
export function hasV2ToolsShape(raw) {
  if (!isPlainObject(raw) || !isPlainObject(raw.tools)) return false;
  if (raw.tools.defaultTier !== undefined) return true;
  return isPlainObject(raw.tools.overrides) && Object.keys(raw.tools.overrides).length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 合并（保存一侧）：逐键表驱动。
// D2 六类键：标量双向覆盖 / 数值与枚举 / 名称集只增不减 / 映射表逐键覆盖 + null 删除 /
// 深对象逐子键深合并 / 有序表整表替换。
// ─────────────────────────────────────────────────────────────────────────────

const SKIP = Symbol("skip");

const stable = (value) => (value === undefined ? "\u0000undefined" : JSON.stringify(value));

/** 路径片段：合法标识符用点号，否则用 ["..."]。 */
export function policyPath(...segments) {
  let out = "";
  for (const segment of segments) {
    if (typeof segment !== "string" || segment.length === 0) continue;
    if (/^[A-Za-z_$][\w$-]*$/.test(segment)) out = out.length === 0 ? segment : out + "." + segment;
    else out += "[" + JSON.stringify(segment) + "]";
  }
  return out;
}

function makeContext(warnings, ignored) {
  // ignored：本次提交里到底被忽略了什么（字段路径 / 保护名单名字）。保存回执与 P0-2 诊断
  // 都要能点名，而不是只说「有告警」；同一路径只记一次。
  const list = Array.isArray(ignored) ? ignored : [];
  const note = (value) => {
    if (typeof value !== "string" || value.length === 0) return;
    if (!list.includes(value)) list.push(value);
  };
  return {
    ignored: list,
    ignoreName(value) { note(value); },
    warn(code, path, message) {
      warnings.push({ code, path, message });
      note(path);
    },
    invalid(path, raw, expected) {
      const actual = raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw;
      warnings.push({
        code: "invalid-type",
        path,
        message: path + " 的类型非法（期望 " + (expected || "合法值") + "，实际 " + actual + "），该字段已保持原值",
      });
      note(path);
    },
    unknown(path) {
      warnings.push({ code: "unknown-key", path, message: "未知字段 " + path + "，已忽略" });
      note(path);
    },
  };
}

function checkInteger(value, constraints) {
  if (!Number.isInteger(value)) return false;
  if (constraints === undefined) return true;
  if (constraints.min !== undefined && value < constraints.min) return false;
  if (constraints.max !== undefined && value > constraints.max) return false;
  return true;
}

function mergeTierMapFields(base, incoming, pathPrefix, ctx) {
  const out = Object.assign({}, isPlainObject(base) ? base : {});
  let touched = false;
  for (const name of Object.keys(incoming).sort()) {
    const raw = incoming[name];
    const path = policyPath(pathPrefix, name);
    if (raw === null) {
      delete out[name];
      touched = true;
      continue;
    }
    const tier = normalizeTier(raw, undefined);
    if (tier === undefined) {
      ctx.warn("invalid-enum", path, path + " 必须是 0 / 1 / 2（off / resident / on-demand），已忽略");
      continue;
    }
    out[name] = tier;
    touched = true;
  }
  if (!touched) return SKIP;
  return sortedTierMap(out);
}

function mergeStringList(_base, value, path, ctx) {
  if (value === null) return SKIP;
  if (!Array.isArray(value)) {
    ctx.invalid(path, value, "字符串数组");
    return SKIP;
  }
  return [...new Set(value.filter((item) => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0))];
}

/** 字段级合并：返回新值，或 SKIP（本次提交对该字段无效）。 */
function mergeField(spec, base, value, ctx) {
  const path = spec.key;
  switch (spec.kind) {
    case "flag": {
      if (typeof value !== "boolean") {
        ctx.invalid(path, value, "boolean");
        return SKIP;
      }
      return value;
    }
    case "number":
    case "threshold": {
      const number = normalizeCount(value, undefined);
      if (number === undefined || !checkInteger(number, spec.constraints)) {
        ctx.warn("out-of-range", path, path + " 必须是" + rangeText(spec.constraints) + "整数，已忽略");
        return SKIP;
      }
      return number;
    }
    case "defaults":
      return mergeDefaultsField(spec, base, value, ctx);
    case "capabilities":
      return mergeCapabilitiesField(spec, base, value, ctx);
    case "sources":
      return mergeSourcesField(spec, base, value, ctx);
    case "legacy":
      return mergeLegacyField(spec, base, value, ctx);
    case "object":
      return mergeObjectField(spec, base, value, ctx);
    case "names":
      return mergeNamesField(spec, base, value, ctx);
    case "skills":
      return mergeSkillsField(spec, base, value, ctx);
    case "mcp":
      return mergeMcpField(spec, base, value, ctx);
    case "guardrail":
      return mergeGuardrailField(spec, base, value, ctx);
    default:
      throw new Error("policy-schema: 未知 kind " + spec.kind);
  }
}

function rangeText(constraints) {
  if (constraints === undefined) return "正整数";
  if (constraints.min !== undefined && constraints.max !== undefined) return " " + constraints.min + "–" + constraints.max + " 的";
  if (constraints.min !== undefined) return " >= " + constraints.min + " 的";
  return "";
}

function mergeDefaultsField(spec, base, value, ctx) {
  if (value === null) return SKIP;
  if (!isPlainObject(value)) {
    ctx.invalid(spec.key, value, "object");
    return SKIP;
  }
  const out = Object.assign({}, isPlainObject(base) ? base : {});
  for (const child of spec.children) {
    if (!Object.prototype.hasOwnProperty.call(value, child.key)) continue;
    const raw = value[child.key];
    const path = policyPath(spec.key, child.key);
    if (raw === null) {
      delete out[child.key];
      continue;
    }
    const tier = normalizeTier(raw, undefined);
    if (tier === undefined) {
      ctx.warn("invalid-enum", path, path + " 必须是 0 / 1 / 2");
      continue;
    }
    out[child.key] = tier;
  }
  for (const key of Object.keys(value)) {
    if (!spec.children.some((child) => child.key === key)) ctx.unknown(policyPath(spec.key, key));
  }
  return out;
}

function mergeCapabilitiesField(spec, base, value, ctx) {
  if (value === null) return SKIP;
  if (!isPlainObject(value)) {
    ctx.invalid(spec.key, value, "object");
    return SKIP;
  }
  const out = clone(isPlainObject(base) ? base : {});
  for (const id of Object.keys(value).sort()) {
    const entry = value[id];
    const entryPath = policyPath(spec.key, id);
    if (entry === null) {
      delete out[id];
      continue;
    }
    if (!isPlainObject(entry)) {
      ctx.invalid(entryPath, entry, "object");
      continue;
    }
    const current = isPlainObject(out[id]) ? out[id] : {};
    const next = Object.assign({}, current);
    for (const child of spec.entry.children) {
      if (!Object.prototype.hasOwnProperty.call(entry, child.key)) continue;
      const raw = entry[child.key];
      const path = entryPath + "." + child.key;
      if (raw === null) {
        delete next[child.key];
        continue;
      }
      if (child.type === "tier") {
        const tier = normalizeTier(raw, undefined);
        if (tier === undefined) {
          ctx.warn("invalid-enum", path, path + " 必须是 0 / 1 / 2");
          continue;
        }
        next[child.key] = tier;
      } else {
        if (!isPlainObject(raw)) {
          ctx.invalid(path, raw, "object");
          continue;
        }
        const merged = mergeTierMapFields(current[child.key], raw, path, ctx);
        if (merged !== SKIP) next[child.key] = merged;
      }
    }
    for (const key of Object.keys(entry)) {
      if (!spec.entry.children.some((child) => child.key === key)) ctx.unknown(entryPath + "." + key);
    }
    out[id] = next;
  }
  return out;
}

function mergeSourcesField(spec, base, value, ctx) {
  if (value === null) return SKIP;
  if (!isPlainObject(value)) {
    ctx.invalid(spec.key, value, "object");
    return SKIP;
  }
  const out = clone(isPlainObject(base) ? base : {});
  for (const id of Object.keys(value).sort()) {
    const entry = value[id];
    const entryPath = policyPath(spec.key, id);
    if (entry === null) {
      delete out[id];
      continue;
    }
    if (!isPlainObject(entry)) {
      ctx.invalid(entryPath, entry, "object");
      continue;
    }
    const next = Object.assign({}, isPlainObject(out[id]) ? out[id] : {});
    for (const child of spec.entry.children) {
      if (!Object.prototype.hasOwnProperty.call(entry, child.key)) continue;
      const merged = mergeStringList(next[child.key], entry[child.key], entryPath + "." + child.key, ctx);
      if (merged === SKIP) delete next[child.key];
      else next[child.key] = merged;
    }
    out[id] = next;
  }
  return out;
}

function mergeLegacyField(spec, base, value, ctx) {
  if (value === null) return SKIP;
  if (!isPlainObject(value)) {
    ctx.invalid(spec.key, value, "object");
    return SKIP;
  }
  const out = clone(isPlainObject(base) ? base : {});
  for (const key of Object.keys(value).sort()) {
    const raw = value[key];
    if (key === "unknownOverrides") {
      if (raw === null) {
        out.unknownOverrides = {};
        continue;
      }
      if (!isPlainObject(raw)) {
        ctx.invalid(policyPath(spec.key, key), raw, "object");
        continue;
      }
      const merged = mergeTierMapFields(out.unknownOverrides, raw, policyPath(spec.key, key), ctx);
      out.unknownOverrides = merged === SKIP ? (out.unknownOverrides || {}) : merged;
      continue;
    }
    // legacy 是扩展逃生口：未知子键原样保留，null 删除。
    if (raw === null) delete out[key];
    else out[key] = clone(raw);
  }
  return out;
}

function mergeObjectField(spec, base, value, ctx) {
  if (value === null) return SKIP;
  if (!isPlainObject(value)) {
    ctx.invalid(spec.key, value, "object");
    return SKIP;
  }
  const out = clone(isPlainObject(base) ? base : {});
  const known = new Set(spec.children.map((child) => child.key));
  for (const child of spec.children) {
    if (!Object.prototype.hasOwnProperty.call(value, child.key)) continue;
    const raw = value[child.key];
    const path = child.key;
    if (raw === null) {
      delete out[child.key];
      continue;
    }
    if (child.children !== undefined) {
      if (!isPlainObject(raw)) {
        ctx.invalid(path, raw, "object");
        continue;
      }
      const nested = Object.assign({}, isPlainObject(out[child.key]) ? out[child.key] : {});
      for (const grand of child.children) {
        if (!Object.prototype.hasOwnProperty.call(raw, grand.key)) continue;
        const inner = raw[grand.key];
        const innerPath = child.key + "." + grand.key;
        if (inner === null) {
          delete nested[grand.key];
          continue;
        }
        if (grand.type === "boolean") {
          if (typeof inner !== "boolean") ctx.invalid(innerPath, inner, "boolean");
          else nested[grand.key] = inner;
        } else if (grand.type === "integer") {
          const number = normalizeCount(inner, undefined);
          if (number === undefined || !checkInteger(number, grand.constraints)) ctx.warn("out-of-range", innerPath, innerPath + " 必须是" + rangeText(grand.constraints) + "整数");
          else nested[grand.key] = number;
        } else if (grand.type === "stringList") {
          const list = mergeStringList(nested[grand.key], inner, innerPath, ctx);
          if (list !== SKIP) nested[grand.key] = list;
        } else {
          nested[grand.key] = clone(inner);
        }
      }
      for (const key of Object.keys(raw)) {
        if (!child.children.some((grand) => grand.key === key)) ctx.unknown(child.key + "." + key);
      }
      out[child.key] = nested;
      continue;
    }
    if (child.type === "boolean") {
      if (typeof raw !== "boolean") {
        ctx.invalid(path, raw, "boolean");
        continue;
      }
      out[child.key] = raw;
      continue;
    }
    if (child.type === "integer") {
      const number = normalizeCount(raw, undefined);
      if (number === undefined || !checkInteger(number, child.constraints)) {
        ctx.warn("out-of-range", path, path + " 必须是" + rangeText(child.constraints) + "整数");
        continue;
      }
      out[child.key] = number;
      continue;
    }
    out[child.key] = clone(raw);
  }
  for (const key of Object.keys(value)) {
    if (known.has(key)) continue;
    if (value[key] === null) delete out[key];
    else out[key] = clone(value[key]);
  }
  return out;
}

function mergeNamesField(spec, base, value, ctx) {
  if (!Array.isArray(value)) {
    ctx.invalid(spec.key, value, "字符串数组");
    return SKIP;
  }
  const baseNames = (Array.isArray(base) ? base : []).filter((name) => typeof name === "string" && name.length > 0);
  const incoming = [...new Set(value.filter((name) => typeof name === "string").map((name) => name.trim()).filter((name) => name.length > 0))];
  const missing = baseNames.filter((name) => !incoming.includes(name));
  if (missing.length > 0) {
    ctx.warn(
      "protected-subtract-ignored",
      spec.key,
      "protected 只增不减：提交里缺的 " + missing.join(", ") + " 已保留",
    );
    // 被忽略的是「名字」本身：诊断里点名 beta，而不是只报 protected 这个键。
    for (const name of missing) ctx.ignoreName(name);
  }
  const out = [];
  for (const name of [...baseNames, ...incoming]) if (!out.includes(name)) out.push(name);
  return out;
}

function mergeSkillsField(spec, base, value, ctx) {
  if (value === null) return SKIP;
  if (!isPlainObject(value)) {
    ctx.invalid(spec.key, value, "object");
    return SKIP;
  }
  const out = normalizeSkillsConfig(base);
  for (const child of spec.children) {
    if (!Object.prototype.hasOwnProperty.call(value, child.key)) continue;
    const raw = value[child.key];
    const path = policyPath(spec.key, child.key);
    if (raw === null) {
      const fallback = child.fallback === undefined ? SKILLS_DEFAULTS[child.key] : child.fallback;
      out[child.key] = clone(fallback);
      continue;
    }
    if (child.type === "boolean") {
      if (typeof raw !== "boolean") {
        ctx.invalid(path, raw, "boolean");
        continue;
      }
      out[child.key] = raw;
      continue;
    }
    if (child.type === "stringList" || child.type === "importList") {
      if (!Array.isArray(raw)) {
        ctx.invalid(path, raw, child.type === "importList" ? "{ id?, path } 数组" : "字符串数组");
        continue;
      }
      out[child.key] = normalizeSkillsConfig({ [child.key]: raw })[child.key];
    }
  }
  for (const key of Object.keys(value)) {
    if (!spec.children.some((child) => child.key === key)) ctx.unknown(policyPath(spec.key, key));
  }
  return out;
}

function mergeMcpField(spec, base, value, ctx) {
  if (value === null) return SKIP;
  if (!isPlainObject(value)) {
    ctx.invalid(spec.key, value, "object");
    return SKIP;
  }
  const current = isPlainObject(base) ? base : { servers: {} };
  const out = Object.assign({}, current, { servers: clone(isPlainObject(current.servers) ? current.servers : {}) });
  if (Object.prototype.hasOwnProperty.call(value, "servers")) {
    const raw = value.servers;
    if (raw === null) {
      out.servers = {};
    } else if (!isPlainObject(raw)) {
      ctx.invalid("mcp.servers", raw, "object");
    } else {
      // 整表替换：删掉一个 server 必须真的删掉（合并式写入会让「移除」永远不生效）。
      const servers = {};
      for (const name of Object.keys(raw).sort()) {
        const entry = raw[name];
        if (entry === null) continue;
        if (!isPlainObject(entry)) {
          ctx.invalid(policyPath("mcp.servers", name), entry, "object");
          continue;
        }
        servers[name] = clone(entry);
      }
      out.servers = servers;
    }
  }
  for (const key of Object.keys(value)) {
    if (key !== "servers") ctx.unknown(policyPath(spec.key, key));
  }
  return out;
}

function mergeGuardrailField(spec, base, value, ctx) {
  if (value === null) return SKIP;
  if (!isPlainObject(value)) {
    ctx.invalid(spec.key, value, "object");
    return SKIP;
  }
  const merged = Object.assign({}, isPlainObject(base) ? base : {});
  for (const child of spec.children) {
    if (!Object.prototype.hasOwnProperty.call(value, child.key)) continue;
    const raw = value[child.key];
    const path = policyPath(spec.key, child.key);
    if (raw === null) {
      delete merged[child.key];
      continue;
    }
    if (child.type === "boolean") {
      if (typeof raw !== "boolean") {
        ctx.invalid(path, raw, "boolean");
        continue;
      }
      merged[child.key] = raw;
      continue;
    }
    if (child.type === "integer") {
      const number = normalizeCount(raw, undefined);
      if (number === undefined || !checkInteger(number, child.constraints)) {
        ctx.warn("out-of-range", path, path + " 必须是" + rangeText(child.constraints) + "整数，已忽略");
        continue;
      }
      merged[child.key] = number;
      continue;
    }
    if (child.type === "stringList") {
      if (!Array.isArray(raw)) {
        ctx.invalid(path, raw, "字符串数组");
        continue;
      }
      merged[child.key] = raw.filter((name) => typeof name === "string" && name.length > 0);
    }
  }
  for (const key of Object.keys(value)) {
    if (!spec.children.some((child) => child.key === key)) ctx.unknown(policyPath(spec.key, key));
  }
  return normalizeRepeatGuardConfig(merged);
}

/**
 * 逐键合并一层提交（保存路径的内核）。
 *
 * @param {object} current 当前策略文档（磁盘真源或空模板）
 * @param {object} incoming 本次提交（UI 只提交它渲染得出来的键）
 * @param {{allowExtensions?: boolean}} [options]
 * @returns {{policy: object, warnings: object[], ignored: string[], changedKeys: string[]}}
 */
export function mergePolicyLayer(current, incoming, options) {
  const opts = options || {};
  const warnings = [];
  const ignored = [];
  const changedKeys = [];
  const out = Object.assign({}, isPlainObject(current) ? current : {});
  if (incoming === undefined || incoming === null) return { policy: out, warnings, ignored, changedKeys };
  if (!isPlainObject(incoming)) {
    warnings.push({ code: "invalid-policy", path: "", message: "策略提交必须是 JSON 对象，本次提交已忽略" });
    return { policy: out, warnings, ignored, changedKeys };
  }
  const ctx = makeContext(warnings, ignored);
  for (const spec of POLICY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(incoming, spec.key)) continue;
    const value = incoming[spec.key];
    if (value === undefined) continue;
    const before = stable(out[spec.key]);
    const merged = mergeField(spec, out[spec.key], value, ctx);
    if (merged === SKIP) continue;
    out[spec.key] = merged;
    if (stable(merged) !== before) changedKeys.push(spec.key);
  }
  // 表外扩展键：默认保留（老承诺：保存一次不能丢用户手写键）；strict 模式拒绝。
  for (const key of Object.keys(incoming).sort()) {
    if (isPolicySchemaKey(key)) continue;
    const value = incoming[key];
    if (opts.allowExtensions === false) {
      warnings.push({ code: "unknown-key", path: key, message: "未知的顶层策略键 " + key + "，严格模式下已拒绝" });
      continue;
    }
    const before = stable(out[key]);
    if (value === null) delete out[key];
    else out[key] = clone(value);
    if (stable(out[key]) !== before) changedKeys.push(key);
  }
  return { policy: out, warnings, ignored, changedKeys };
}

// ─────────────────────────────────────────────────────────────────────────────
// 严格校验（控制面写入一侧）：未知键 / 非法类型 / 越界 / 非法枚举立即拒绝，
// 每条错误带精确 path、稳定 code 与可读 message，绝不静默丢弃或回退默认值。
// ─────────────────────────────────────────────────────────────────────────────

function errorOf(errors, path, code, message) {
  errors.push({ path, code, message });
}

function strictTypeName(spec) {
  switch (spec.type) {
    case "integer": return "整数";
    case "boolean": return "布尔值";
    case "tier": return "0 / 1 / 2（档位）";
    case "tierMap": return "对象（名字 -> 档位）";
    case "stringList": return "字符串数组";
    case "importList": return "{ id?, path } 或字符串数组";
    case "serverMap": return "对象（server 名 -> 声明）";
    case "map": return "对象";
    default: return "对象";
  }
}

function validateTierValue(raw, path, allowNull, errors) {
  if (raw === null) {
    if (allowNull) return true;
    errorOf(errors, path, "invalid-type", path + " 不允许 null");
    return false;
  }
  if (typeof raw !== "number" || (raw !== TIER_OFF && raw !== TIER_RESIDENT && raw !== TIER_ONDEMAND)) {
    errorOf(errors, path, "invalid-enum", path + " 必须是 0 / 1 / 2（off / resident / on-demand），实际 " + JSON.stringify(raw));
    return false;
  }
  return true;
}

function validateStringList(raw, path, allowNull, errors) {
  if (raw === null) {
    if (allowNull) return true;
    errorOf(errors, path, "invalid-type", path + " 不允许 null");
    return false;
  }
  if (!Array.isArray(raw)) {
    errorOf(errors, path, "invalid-type", path + " 必须是字符串数组");
    return false;
  }
  for (let index = 0; index < raw.length; index += 1) {
    if (typeof raw[index] !== "string" || raw[index].trim().length === 0) {
      errorOf(errors, path + "[" + index + "]", "invalid-type", path + "[" + index + "] 必须是非空字符串");
      return false;
    }
  }
  return true;
}

function validateIntegerValue(raw, spec, path, errors) {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    errorOf(errors, path, "invalid-type", path + " 必须是整数");
    return false;
  }
  const constraints = spec.constraints;
  if (constraints !== undefined) {
    if (constraints.min !== undefined && raw < constraints.min) {
      errorOf(errors, path, "out-of-range", path + " 必须 >= " + constraints.min + "，实际 " + raw);
      return false;
    }
    if (constraints.max !== undefined && raw > constraints.max) {
      errorOf(errors, path, "out-of-range", path + " 必须 <= " + constraints.max + "，实际 " + raw);
      return false;
    }
  }
  return true;
}

function validateFieldValue(spec, raw, path, errors, options) {
  const allowNull = options.allowNull === true;
  if (raw === null) {
    if (allowNull) return true;
    errorOf(errors, path, "invalid-type", path + " 不允许 null");
    return false;
  }
  switch (spec.type) {
    case "boolean":
      if (typeof raw !== "boolean") {
        errorOf(errors, path, "invalid-type", path + " 必须是" + strictTypeName(spec));
        return false;
      }
      return true;
    case "integer":
      return validateIntegerValue(raw, spec, path, errors);
    case "tier":
      return validateTierValue(raw, path, allowNull, errors);
    case "stringList":
      return validateStringList(raw, path, allowNull, errors);
    case "importList": {
      if (!Array.isArray(raw)) {
        errorOf(errors, path, "invalid-type", path + " 必须是" + strictTypeName(spec));
        return false;
      }
      for (let index = 0; index < raw.length; index += 1) {
        const item = raw[index];
        const itemPath = path + "[" + index + "]";
        if (typeof item === "string") {
          if (item.trim().length === 0) errorOf(errors, itemPath, "invalid-type", itemPath + " 必须是非空路径字符串");
          continue;
        }
        if (!isPlainObject(item)) {
          errorOf(errors, itemPath, "invalid-type", itemPath + " 必须是字符串或 { id?, path }");
          continue;
        }
        for (const key of Object.keys(item)) {
          if (key !== "id" && key !== "path") errorOf(errors, itemPath + "." + key, "unknown-key", "未知字段 " + itemPath + "." + key);
        }
        if (typeof item.path !== "string" || item.path.trim().length === 0) {
          errorOf(errors, itemPath + ".path", "invalid-type", itemPath + ".path 必须是非空字符串");
        }
        if (item.id !== undefined && (typeof item.id !== "string" || item.id.trim().length === 0)) {
          errorOf(errors, itemPath + ".id", "invalid-type", itemPath + ".id 必须是非空字符串");
        }
      }
      return errors.length === 0;
    }
    case "tierMap": {
      if (!isPlainObject(raw)) {
        errorOf(errors, path, "invalid-type", path + " 必须是" + strictTypeName(spec));
        return false;
      }
      const before = errors.length;
      for (const name of Object.keys(raw)) validateTierValue(raw[name], path + "[" + JSON.stringify(name) + "]", allowNull, errors);
      return errors.length === before;
    }
    case "serverMap": {
      if (!isPlainObject(raw)) {
        errorOf(errors, path, "invalid-type", path + " 必须是" + strictTypeName(spec));
        return false;
      }
      const before = errors.length;
      for (const name of Object.keys(raw)) validateServerEntry(raw[name], path + "[" + JSON.stringify(name) + "]", errors);
      return errors.length === before;
    }
    default:
      return validateObjectValue(spec, raw, path, errors, options);
  }
}

const SERVER_FIELDS = Object.freeze({
  transport: "string",
  enabled: "boolean",
  command: "string",
  args: "stringList",
  env: "stringMap",
  cwd: "string",
  url: "string",
  headers: "stringMap",
  toolCallTimeoutMs: "integer",
  maxInstructionBytes: "integer",
});

function validateServerEntry(raw, path, errors) {
  if (!isPlainObject(raw)) {
    errorOf(errors, path, "invalid-type", path + " 必须是 MCP server 声明对象");
    return;
  }
  for (const key of Object.keys(raw)) {
    if (SERVER_FIELDS[key] === undefined) {
      errorOf(errors, path + "." + key, "unknown-key", "未知的 MCP server 字段 " + path + "." + key);
      continue;
    }
    const value = raw[key];
    if (value === null) continue;
    const type = SERVER_FIELDS[key];
    const valuePath = path + "." + key;
    if (type === "string") {
      if (typeof value !== "string") errorOf(errors, valuePath, "invalid-type", valuePath + " 必须是字符串");
      continue;
    }
    if (type === "boolean") {
      if (typeof value !== "boolean") errorOf(errors, valuePath, "invalid-type", valuePath + " 必须是布尔值");
      continue;
    }
    if (type === "integer") {
      if (!Number.isInteger(value) || value < 0) errorOf(errors, valuePath, "invalid-type", valuePath + " 必须是非负整数");
      continue;
    }
    if (type === "stringList") {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) errorOf(errors, valuePath, "invalid-type", valuePath + " 必须是字符串数组");
      continue;
    }
    if (type === "stringMap") {
      if (!isPlainObject(value)) {
        errorOf(errors, valuePath, "invalid-type", valuePath + " 必须是对象");
        continue;
      }
      for (const mapKey of Object.keys(value)) {
        if (typeof value[mapKey] !== "string") errorOf(errors, valuePath + "." + mapKey, "invalid-type", valuePath + "." + mapKey + " 必须是字符串");
      }
    }
  }
  const transport = raw.transport;
  if (transport !== undefined && transport !== null && transport !== "stdio" && transport !== "streamable-http") {
    errorOf(errors, path + ".transport", "invalid-enum", path + ".transport 必须是 \"stdio\" 或 \"streamable-http\"");
  }
}

function validateObjectValue(spec, raw, path, errors, options) {
  if (!isPlainObject(raw)) {
    errorOf(errors, path, "invalid-type", path + " 必须是" + strictTypeName(spec));
    return false;
  }
  const children = spec.children || [];
  const childMap = new Map(children.map((child) => [child.key, child]));
  const before = errors.length;
  for (const key of Object.keys(raw)) {
    const childPath = path.length === 0 ? key : path + "." + key;
    const child = childMap.get(key);
    if (child === undefined) {
      if (spec.closed === true && options.allowExtensions !== true) {
        errorOf(errors, childPath, "unknown-key", "未知字段 " + childPath);
      }
      continue;
    }
    validateFieldValue(child, raw[key], childPath, errors, { allowNull: false });
  }
  return errors.length === before;
}

/**
 * 严格校验一份待写入的策略文档。
 *
 * @param {unknown} raw
 * @param {{allowExtensions?: boolean}} [options] allowExtensions=true 时允许表外扩展键（老文件写回）
 * @returns {{ok: boolean, errors: {path: string, code: string, message: string}[], warnings: object[], policy?: object}}
 */
export function validatePolicyInput(raw, options) {
  const opts = options || {};
  const errors = [];
  const warnings = [];
  if (!isPlainObject(raw)) {
    errorOf(errors, "", "invalid-type", "策略文档必须是 JSON 对象");
    return { ok: false, errors, warnings };
  }
  for (const key of Object.keys(raw).sort()) {
    const spec = FIELD_BY_KEY.get(key);
    if (spec === undefined) {
      if (opts.allowExtensions === true) continue;
      errorOf(errors, key, "unknown-key", "未知的顶层策略键 " + key);
      continue;
    }
    const value = raw[key];
    if (value === undefined) continue;
    if (value === null) {
      errorOf(errors, key, "invalid-type", key + " 不允许 null");
      continue;
    }
    if (spec.type === "map") {
      if (!isPlainObject(value)) {
        errorOf(errors, key, "invalid-type", key + " 必须是" + strictTypeName(spec));
        continue;
      }
      const entryChildren = new Map((spec.entry.children || []).map((child) => [child.key, child]));
      for (const id of Object.keys(value)) {
        const entry = value[id];
        const entryPath = key + "[" + JSON.stringify(id) + "]";
        if (entry === null) continue;
        if (!isPlainObject(entry)) {
          errorOf(errors, entryPath, "invalid-type", entryPath + " 必须是对象");
          continue;
        }
        for (const entryKey of Object.keys(entry)) {
          const child = entryChildren.get(entryKey);
          const childPath = entryPath + "." + entryKey;
          if (child === undefined) {
            if (spec.closed === true && opts.allowExtensions !== true) errorOf(errors, childPath, "unknown-key", "未知字段 " + childPath);
            continue;
          }
          validateFieldValue(child, entry[entryKey], childPath, errors, { allowNull: true });
        }
      }
      continue;
    }
    validateFieldValue(spec, value, key, errors, { allowNull: false });
  }
  const ok = errors.length === 0;
  if (!ok) return { ok, errors, warnings };
  const merged = mergePolicyLayer(emptyPolicyTemplate(), raw);
  for (const warning of merged.warnings) warnings.push(warning);
  return { ok, errors, warnings, policy: merged.policy };
}

/** 能力条目逐字段合并（迁移与层合并共用）。后写的赢；null 删除条目。 */
export function mergeCapabilities(base, incoming) {
  const out = clone(isPlainObject(base) ? base : {});
  if (!isPlainObject(incoming)) return out;
  for (const [id, entry] of Object.entries(incoming)) {
    if (entry === null) { delete out[id]; continue; }
    if (!isPlainObject(entry)) continue;
    const current = isPlainObject(out[id]) ? out[id] : {};
    const next = Object.assign({}, current);
    if (entry.tier !== undefined) {
      const tier = normalizeTier(entry.tier, undefined);
      if (tier !== undefined) next.tier = tier;
    }
    for (const key of ["toolExceptions", "sectionExceptions"]) {
      if (entry[key] === null) { delete next[key]; continue; }
      if (!isPlainObject(entry[key])) continue;
      next[key] = Object.assign({}, isPlainObject(current[key]) ? current[key] : {});
      for (const [pattern, value] of Object.entries(entry[key])) {
        if (value === null) { delete next[key][pattern]; continue; }
        const tier = normalizeTier(value, undefined);
        if (tier !== undefined) next[key][pattern] = tier;
      }
    }
    out[id] = next;
  }
  return out;
}

/** 显式来源映射逐 id 合并：提交了哪个 id 就整条替换它的成员清单（null 删除该 id）。 */
export function mergeSources(base, incoming) {
  const out = clone(isPlainObject(base) ? base : {});
  if (!isPlainObject(incoming)) return out;
  for (const [id, entry] of Object.entries(incoming)) {
    if (entry === null) { delete out[id]; continue; }
    if (!isPlainObject(entry)) continue;
    const next = Object.assign({}, isPlainObject(out[id]) ? out[id] : {});
    for (const key of ["tools", "sections"]) {
      if (entry[key] === null) { delete next[key]; continue; }
      if (!Array.isArray(entry[key])) continue;
      next[key] = entry[key].filter((name) => typeof name === "string" && name.length > 0);
    }
    out[id] = next;
  }
  return out;
}
