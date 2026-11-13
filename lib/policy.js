/**
 * 策略解析（0.2.0 v3）：能力 + 例外 + defaults。
 *
 * 0.1.8 是「工具表 + 段落表 + 默认层」两层模型；0.2.0 把开关单位换成**能力**
 * （一个来源实例），一个能力档同时驱动 tools 与 sections 两条限制 —— 两条限制同源，
 * 所以「改了能力档、只藏工具不摘段落」这类半截状态在结构上不可能出现。
 *
 * 解析顺序（docs/dsh-gate-0.2.0-04-能力模型与v3策略.md §4）：
 *   own → preset → protected → sources → 命名推断 → 能力档 → 例外 → defaults
 * 具体实现在 lib/capabilities.js（resolveToolDecision / resolveSectionDecision），
 * 这里只负责「把各层策略合成本轮生效的那一份」。
 *
 * 优先级仍是**逐字段**的：策略文件 > 插件行 config > 内置默认；任何解析失败都 fail-open
 * （退回全部常驻），宁可没省 token，也不能让会话崩。
 *
 * v2 文件在读取时自动迁移到 v3（先备份 gate.json.v2.bak-<时间戳>），首次保存写 v3；
 * 原文件在保存前不会被改写，0.1.8 回滚包照旧可用。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CAPABILITY_DEFAULTS,
  capabilityOfSection,
  capabilityOfTool,
  capabilityState,
  defaultsOf,
  resolveSectionDecision,
  resolveToolDecision,
  withCapabilityTier,
  withMemberException,
} from "./capabilities.js";
import {
  POLICY_VERSION,
  V2_DEFAULTS,
  backupV2PolicyFile,
  isV3Policy,
  mergeCapabilities,
  mergeSources,
  migrateV2ToV3,
  normalizeV3Policy,
} from "./migrate.js";
import {
  TIER_OFF,
  TIER_ONDEMAND,
  TIER_RESIDENT,
  clone,
  isPlainObject,
  matches,
  normalizeCount,
  normalizeTier,
  specificity,
} from "./tiers.js";

export {
  TIER_OFF,
  TIER_ONDEMAND,
  TIER_RESIDENT,
  clone,
  isPlainObject,
  matches,
  normalizeCount,
  normalizeTier,
  specificity,
} from "./tiers.js";
export {
  CAPABILITY_DEFAULTS,
  capabilityIdOfSectionName,
  capabilityIdOfToolName,
  capabilityOfSection,
  capabilityOfTool,
  capabilityState,
  defaultsOf,
  resolveSectionDecision,
  resolveToolDecision,
  withCapabilityTier,
  withMemberException,
} from "./capabilities.js";
export {
  POLICY_VERSION,
  RETIRED_TOOL_NAMES,
  V2_DEFAULTS,
  isV3Policy,
  migrateV2ToV3,
  normalizeV3Policy,
} from "./migrate.js";

/**
 * DeepSeek Harness 的用户根目录（与宿主 dsh-home-paths 的 resolveDshHome 同规则）：
 * 显式配置 > $DSH_HOME > ~/.dsh。
 * Desktop 版**不设置** $DSH_HOME，所以只认环境变量会解析到 undefined（真事故：种入的
 * gate.json 不被读取、UI 保存恒失败）。这里补上 ~/.dsh 回退。
 */
export function defaultDshHome() {
  const raw = process.env.DSH_HOME;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  try { return path.join(os.homedir(), ".dsh"); } catch { return undefined; }
}

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

/**
 * 策略顶层键表 —— 读（resolvePolicy）、合并（mergePolicyFile）、兜底模板
 * （emptyPolicyTemplate）的唯一真源。
 *
 * 每条记录：
 *   key       顶层键名（策略文件与插件行 config 用同一个名字）
 *   kind      读取/写入时怎么解释：flag / number / threshold / defaults / capabilities /
 *             sources / legacy / object / names
 *   merge     保存（UI POST）时怎么合并：replace / object
 *   fallback  内置默认值，同时就是空策略模板里该键的值
 *
 * v3 删掉了 v2 的 tools / sections / skills 三个键：它们由能力 + 例外派生，
 * 不再是独立真源。skills.tier 作为只读别名（→ defaults.skillpack）仍被读入。
 */
export const POLICY_KEYS = Object.freeze([
  { key: "version", kind: "number", merge: "replace", fallback: POLICY_VERSION },
  { key: "enabled", kind: "flag", merge: "replace", fallback: true },
  /**
   * PTC 下的「工具表冻结 + 末尾声明」开关（工单 07，A 案）。默认 true：
   * PTC 会话里 gate_load 不再改工具表，已加载能力由尾部声明 + gate_invoke 执行（省前缀缓存）；
   * native 会话不受影响（保持 0.1.8 的「加载即进工具表」）。false = 整体回到 0.1.8 行为。
   */
  { key: "freezePtcToolset", kind: "flag", merge: "replace", fallback: true },
  {
    key: "defaults",
    kind: "defaults",
    merge: "object",
    fallback: {
      capability: CAPABILITY_DEFAULTS.capability,
      section: CAPABILITY_DEFAULTS.section,
      skillpack: CAPABILITY_DEFAULTS.skillpack,
    },
  },
  // 空模板里只写「基础原生工具常驻」：其余能力没出现就走 defaults（按需）。
  { key: "capabilities", kind: "capabilities", merge: "object", fallback: residentNativeCapabilities() },
  { key: "sources", kind: "sources", merge: "object", fallback: {} },
  { key: "legacy", kind: "legacy", merge: "object", fallback: { unknownOverrides: {} } },
  {
    key: "catalog",
    kind: "object",
    merge: "object",
    // 目录渲染只认这两个键（描述按 maxDescriptionLength 截断、按插件分组）。
    fallback: { groupByPlugin: true, maxDescriptionLength: 64 },
  },
  { key: "protected", kind: "names", merge: "replace", fallback: [] },
  /**
   * 委派收窄豁免阈值（2026-11-01 事故）：
   * 被委派出去的子代理（origin=subagent）如果本来只被授予了个位数工具，闸门藏掉它们
   * 省不到 token，却会把「委派协议的必需工具」一起剥光 —— dsh-mnemon 的写入/复核子代理
   * 白名单只有 mnemon_* + mnemon_subagent_result，被藏掉后它什么都调不了，只能纯文本收尾，
   * 父会话最终抛 "memory subagent completed without recording its result"。
   * 授予数（去掉 agent 自己这一层的 own 工具）<= 该值时不设闸门。0 = 关闭豁免。
   */
  { key: "narrowPassThrough", kind: "threshold", merge: "replace", fallback: V2_DEFAULTS.narrowPassThrough },
]);

/** 空策略模板：每个键取其内置默认，与 resolvePolicy 的兜底同一份值。 */
export function emptyPolicyTemplate() {
  const out = {};
  for (const spec of POLICY_KEYS) out[spec.key] = clone(spec.fallback);
  return out;
}

export const DEFAULT_POLICY = Object.freeze(emptyPolicyTemplate());

/** 保存策略文件时逐键合并：只合并表里认识的部分，其余键原样保留。 */
export function mergePolicyFile(current, incoming) {
  const base = isPlainObject(current) ? current : {};
  const next = isPlainObject(incoming) ? incoming : {};
  const out = Object.assign({}, base);
  for (const spec of POLICY_KEYS) {
    const value = next[spec.key];
    if (value === undefined) continue;
    switch (spec.kind) {
      case "flag":
        if (typeof value === "boolean") out[spec.key] = value;
        break;
      case "number":
      case "threshold": {
        const number = normalizeCount(value, undefined);
        if (number !== undefined) out[spec.key] = number;
        break;
      }
      case "names":
        if (Array.isArray(value)) out[spec.key] = value.filter((name) => typeof name === "string" && name.length > 0);
        break;
      case "defaults": {
        if (!isPlainObject(value)) break;
        const merged = Object.assign({}, isPlainObject(base[spec.key]) ? base[spec.key] : {});
        for (const axis of ["capability", "section", "skillpack"]) {
          if (value[axis] === undefined) continue;
          const tier = normalizeTier(value[axis], undefined);
          if (tier !== undefined) merged[axis] = tier;
        }
        out[spec.key] = merged;
        break;
      }
      case "capabilities":
        if (isPlainObject(value)) out[spec.key] = mergeCapabilities(base[spec.key], value);
        break;
      case "sources":
        if (isPlainObject(value)) out[spec.key] = mergeSources(base[spec.key], value);
        break;
      case "legacy": {
        if (!isPlainObject(value)) break;
        const merged = Object.assign({}, isPlainObject(base[spec.key]) ? base[spec.key] : {});
        if (isPlainObject(value.unknownOverrides)) {
          const overrides = Object.assign({}, isPlainObject(merged.unknownOverrides) ? merged.unknownOverrides : {});
          for (const [name, tier] of Object.entries(value.unknownOverrides)) {
            const normalized = normalizeTier(tier, undefined);
            if (normalized !== undefined) overrides[name] = normalized;
          }
          merged.unknownOverrides = overrides;
        }
        for (const key of Object.keys(value)) {
          if (key === "unknownOverrides") continue;
          merged[key] = clone(value[key]);
        }
        out[spec.key] = merged;
        break;
      }
      case "object":
      default:
        // 逐键覆盖：保存时 UI 只提交它渲染得出来的键，没提交的键必须活下来。
        if (isPlainObject(value)) {
          out[spec.key] = Object.assign({}, isPlainObject(base[spec.key]) ? base[spec.key] : {}, value);
        }
    }
  }
  return out;
}

const TOP_KEYS = new Set(["version", "enabled", "freezePtcToolset", "defaults", "capabilities", "sources", "legacy", "catalog", "narrowPassThrough", "protected"]);
const V2_KEYS = new Set(["version", "enabled", "tools", "sections", "skills", "catalog", "protected", "narrowPassThrough", "policyFile"]);

function hasV2Shape(layer) {
  if (!isPlainObject(layer)) return false;
  return isPlainObject(layer.tools) || isPlainObject(layer.sections) || isPlainObject(layer.skills);
}

/**
 * 把一层（文件 / 插件行 config）叠到目标上。后叠的赢，所以顺序是 row → file。
 * 只认 v3 的键；v2 的 tools/sections/skills 在进入这里之前已经被迁移吸收。
 */
function applyLayer(target, layer) {
  if (!isPlainObject(layer)) return;
  if (layer.enabled === false) target.enabled = false;
  // 布尔开关：只认 true/false，别的值当作没写（与其它 flag 一样，坏值不静默改语义）。
  if (typeof layer.freezePtcToolset === "boolean") target.freezePtcToolset = layer.freezePtcToolset;
  if (isPlainObject(layer.defaults)) {
    for (const axis of ["capability", "section", "skillpack"]) {
      const tier = normalizeTier(layer.defaults[axis], undefined);
      if (tier !== undefined) target.defaults[axis] = tier;
    }
  }
  if (isPlainObject(layer.capabilities)) target.capabilities = mergeCapabilities(target.capabilities, layer.capabilities);
  if (isPlainObject(layer.sources)) target.sources = mergeSources(target.sources, layer.sources);
  if (isPlainObject(layer.legacy)) {
    const legacy = Object.assign({}, target.legacy);
    const overrides = Object.assign({}, isPlainObject(legacy.unknownOverrides) ? legacy.unknownOverrides : {});
    if (isPlainObject(layer.legacy.unknownOverrides)) {
      for (const [name, tier] of Object.entries(layer.legacy.unknownOverrides)) {
        const normalized = normalizeTier(tier, undefined);
        if (normalized !== undefined) overrides[name] = normalized;
      }
    }
    legacy.unknownOverrides = overrides;
    for (const key of Object.keys(layer.legacy)) {
      if (key === "unknownOverrides") continue;
      legacy[key] = clone(layer.legacy[key]);
    }
    target.legacy = legacy;
  }
  if (isPlainObject(layer.catalog)) target.catalog = Object.assign({}, target.catalog, clone(layer.catalog));
  if (layer.narrowPassThrough !== undefined) {
    const count = normalizeCount(layer.narrowPassThrough, undefined);
    if (count !== undefined) target.narrowPassThrough = count;
  }
  if (Array.isArray(layer.protected)) {
    const names = new Set(target.protected || []);
    for (const name of layer.protected) if (typeof name === "string" && name.length > 0) names.add(name);
    target.protected = [...names].sort();
  }
  // 表外扩展键原样保留（用户手写的键不该因为一次保存/读入就消失），按 key 排序保证字节稳定。
  for (const key of Object.keys(layer).sort()) {
    if (TOP_KEYS.has(key) || V2_KEYS.has(key)) continue;
    target[key] = clone(layer[key]);
  }
}

/** 闸门关闭时的策略：不是「按默认策略」，而是「一律常驻」—— 文件坏了也不能把工具藏掉。 */
function disabledPolicy(filePath, reason) {
  const template = emptyPolicyTemplate();
  return {
    version: POLICY_VERSION,
    enabled: false,
    freezePtcToolset: template.freezePtcToolset,
    policyFile: filePath,
    reason,
    defaults: { capability: TIER_RESIDENT, section: TIER_RESIDENT, skillpack: TIER_RESIDENT },
    capabilities: {},
    sources: {},
    legacy: { unknownOverrides: {} },
    catalog: template.catalog,
    narrowPassThrough: 0,
    protectedNames: new Set(INTRINSIC_PROTECTED),
    // 只读别名：prestep / 面板仍按 skills.tier 读技能轴。
    skills: { tier: TIER_RESIDENT },
    warnings: [{ code: "policy-file-invalid", message: reason === "policy-file-invalid" ? "策略文件不是合法 JSON，已退回全部常驻" : String(reason) }],
    migrated: false,
    backupFile: undefined,
  };
}

/** 迁移一层并收集告警；v2 才有副作用（文件层会备份）。 */
function migrateLayer(layer, layerName, options) {
  const migrated = migrateV2ToV3(layer, { knownNames: options.knownNames });
  const warnings = migrated.warnings.map((warning) => Object.assign({ layer: layerName }, warning));
  return { layer: migrated.policy, provided: migrated.provided, warnings, fromVersion: migrated.fromVersion };
}

/**
 * 解析本轮生效的策略。
 * @param {object} raw 插件行 config（policyFile / enabled / 自定义默认都在这里）
 * @param {{dshHome?: string, logger?: any, knownNames?: Set<string>, backup?: boolean}} [options]
 */
export function resolvePolicy(raw, options) {
  const opts = options || {};
  const row = isPlainObject(raw) ? raw : {};
  // policyFile 是「策略文件在哪」的配置路径，不是策略内容，所以不占表里的一行。
  const filePath =
    typeof row.policyFile === "string" && row.policyFile.trim().length > 0
      ? row.policyFile.trim()
      : opts.dshHome
        ? path.join(opts.dshHome, "gate.json")
        : undefined;

  const warnings = [];
  let fromFile;
  let fileProvided = { defaults: false, v2Tools: false };
  let fileVersion;
  let fileMigrated = false;
  let backupFile;
  if (filePath && fs.existsSync(filePath)) {
    let text;
    let parsed;
    try {
      text = fs.readFileSync(filePath, "utf8");
      parsed = JSON.parse(text);
      if (!isPlainObject(parsed)) throw new Error("policy file is not an object");
    } catch (error) {
      const detail = String((error && error.message) || error);
      try { opts.logger?.warn?.("dsh-gate: 策略文件读取失败，已退回全部常驻：" + filePath + " — " + detail); } catch { /* 忽略 */ }
      return disabledPolicy(filePath, "policy-file-invalid");
    }
    // v2 形状（带 tools/sections/skills）一律迁移，哪怕顺手写了 version:3 —— 否则那几个键会被
    // 当成表外扩展键静默丢掉。备份只对真正的 v2 文件做（v3 文件不需要回滚到 v2）。
    const v2Shape = hasV2Shape(parsed);
    const v2Version = !isV3Policy(parsed);
    if (!v2Shape && !v2Version) {
      fromFile = parsed;
      fileProvided = { defaults: isPlainObject(parsed.defaults), v2Tools: false };
      fileVersion = POLICY_VERSION;
    } else {
      fileVersion = v2Version ? (Number(parsed.version) || 2) : POLICY_VERSION;
      fileMigrated = v2Version;
      // 自动迁移 + 备份：原文件一个字都不动，旁边留一份 v2.bak-<时间戳> 供回滚。
      if (v2Version && opts.backup !== false) {
        try {
          backupFile = backupV2PolicyFile(filePath, text);
          if (backupFile !== undefined) {
            try { opts.logger?.info?.("dsh-gate: v2 策略已备份到 " + backupFile); } catch { /* 忽略 */ }
          }
        } catch (error) {
          try { opts.logger?.warn?.("dsh-gate: v2 策略备份失败（迁移继续进行）— " + String((error && error.message) || error)); } catch { /* 忽略 */ }
        }
      }
      const migrated = migrateLayer(parsed, "file", opts);
      fromFile = migrated.layer;
      fileProvided = migrated.provided;
      for (const warning of migrated.warnings) warnings.push(warning);
    }
  }

  let fromRow;
  let rowProvided = { defaults: false, v2Tools: false };
  if (hasV2Shape(row)) {
    // 行 config 里混写 v2 键也走迁移（migrate 会保留同一份 config 里的 v3 片段）。
    const migrated = migrateLayer(row, "config", opts);
    fromRow = migrated.layer;
    rowProvided = migrated.provided;
    for (const warning of migrated.warnings) warnings.push(warning);
  } else if (isV3Policy(row)) {
    fromRow = row;
    rowProvided = { defaults: isPlainObject(row.defaults), v2Tools: false };
  } else {
    // 只写了 enabled / catalog / narrowPassThrough 这类标量键，没有动层模型。
    fromRow = row;
  }

  const target = emptyPolicyTemplate();
  // 用户显式写了 defaults（v3）或整张 v2 工具表（迁移）时，模板里的常驻九件套不能当基底：
  // 否则「defaults.capability=0 全关」会被 read/write/pwsh 的隐式常驻顶掉。
  if (fileProvided.defaults || fileProvided.v2Tools || rowProvided.defaults || rowProvided.v2Tools) {
    target.capabilities = {};
  }
  applyLayer(target, fromRow);
  applyLayer(target, fromFile);

  const { policy: normalized } = normalizeV3Policy(target);
  const result = Object.assign({}, normalized, {
    policyFile: filePath,
    // 内置受保护名单（闸门四件套 + run_code）永远在里面，用户只能加不能减。
    protectedNames: new Set([...INTRINSIC_PROTECTED, ...normalized.protected]),
    // 只读别名：prestep 与面板仍按 skills.tier 读技能轴（真源是 defaults.skillpack）。
    skills: { tier: normalized.defaults.skillpack },
    warnings,
    migrated: fileMigrated,
    backupFile,
    fromVersion: fileVersion,
  });
  for (const warning of warnings) {
    try { opts.logger?.warn?.(("dsh-gate: " + warning.code + " — " + warning.message) + (warning.layer ? "（层: " + warning.layer + "）" : "")); } catch { /* 忽略 */ }
  }
  return result;
}

/** 工具最终归层：protected 永远常驻，其余走解析链。 */
export function tierForTool(policy, name) {
  return resolveToolDecision(policy, name, { globallyVisible: true }).tier;
}

/**
 * 「谁归哪层」的唯一出口。
 *
 * @param {object} policy
 * @param {string} name
 * @param {{loaded?: boolean, globallyVisible?: boolean, own?: boolean}} context
 * @returns {{tier:number, bucket:string, capability:string, capabilityEntry?:string,
 *   confidence:string, via:string, configured:boolean, reason:string,
 *   exception?:{pattern:string,tier:number}, deviation:boolean}}
 */
export function resolveTier(policy, name, context) {
  return resolveToolDecision(policy, name, context);
}

/** 段落归层（与工具同一条解析链，只是没有 own/preset 两种身份）。 */
export function tierForSection(policy, name) {
  return resolveSectionDecision(policy, name).tier;
}
