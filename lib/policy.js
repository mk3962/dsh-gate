/**
 * 策略解析（0.2.0 v3；0.6.0 起读取/保存全部经 S2 策略存储接缝）。
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
 * 0.6.0（工单 #02）：
 *   - 读文件经 lib/storage-seam.js：先剥 UTF-8 BOM（P0-1）、五级诊断（absent/bom/syntax/shape/io）、
 *     坏文件绝不被空模板覆盖；syntax/shape/io 优先沿用影子副本（上一次成功策略），冷启动才降级放行；
 *   - 写文件走原子落盘 + revision；合并/归一/严格校验由 lib/policy-schema.js 的唯一字段表驱动。
 */
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
import { normalizeSignatureSummary } from "./catalog.js";
import {
  V2_DEFAULTS,
  backupV2PolicyFile,
  isV2SkillsShape,
  isV3Policy,
  migrateV2ToV3,
  normalizeV3Policy,
} from "./migrate.js";
import {
  INTRINSIC_PROTECTED,
  POLICY_FIELDS,
  POLICY_KEY_NAMES,
  POLICY_VERSION,
  describePolicySchema,
  emptyPolicyTemplate,
  mergePolicyLayer,
  mergeSkillsConfig,
  policyKeyRows,
  validatePolicyInput,
} from "./policy-schema.js";
import {
  STORAGE_CODES,
  StorageError,
  createFilePolicyStore,
  isCorruptRead,
  splitRevision,
} from "./storage-seam.js";
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
  isV2SkillsShape,
  isV3Policy,
  mergeSkillsConfig,
  migrateV2ToV3,
  normalizeSkillsConfig,
  normalizeV3Policy,
} from "./migrate.js";
// #07 面板与 #08 check-spec 的交叉校验入口：字段表、严格校验、内省。
export {
  POLICY_FIELDS,
  describePolicySchema,
  emptyPolicyTemplate,
  mergePolicyLayer,
  validatePolicyInput,
} from "./policy-schema.js";
export { DEFAULT_RESIDENT_NATIVE, INTRINSIC_PROTECTED } from "./policy-schema.js";

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

/**
 * 策略顶层键表 —— 读（resolvePolicy）、合并（mergePolicyFile）、兜底模板
 * （emptyPolicyTemplate）的唯一真源。0.6.0 起这一行只是 policy-schema.js 的投影：
 * 新增字段只改 schema 一处，模板/归一/合并/校验/示例自动跟上。
 */
export const POLICY_KEYS = Object.freeze(policyKeyRows());

/** 空策略模板（来自字段表）：每个键取其内置默认，与 resolvePolicy 的兜底同一份值。 */
export const DEFAULT_POLICY = Object.freeze(emptyPolicyTemplate());

/**
 * 保存策略文件时逐键合并：只合并表里认识的部分，其余键原样保留。
 * 返回对象上附三个非枚举字段（warnings / ignored / changedKeys），供保存回执与诊断使用。
 */
export function mergePolicyFile(current, incoming) {
  const result = mergePolicyLayer(current, incoming);
  const out = result.policy;
  Object.defineProperty(out, "warnings", { value: result.warnings, enumerable: false, configurable: true });
  Object.defineProperty(out, "ignored", { value: result.ignored, enumerable: false, configurable: true });
  Object.defineProperty(out, "changedKeys", { value: result.changedKeys, enumerable: false, configurable: true });
  return out;
}

const TOP_KEYS = new Set(POLICY_KEY_NAMES);
const V2_KEYS = new Set(["version", "enabled", "tools", "sections", "skills", "catalog", "protected", "narrowPassThrough", "policyFile"]);

/**
 * v2 形状判定：tools / sections 是对象，或者 skills 只有 tier（0.1.8 的技能轴）。
 * 0.3.0 的 skills 是接管配置（takeover/off/imports），**不能**被当成老文件迁走 ——
 * 否则一份只写了 skills.takeover=false 的 v3 文件会被静默迁移成默认 true。
 */
function hasV2Shape(layer) {
  if (!isPlainObject(layer)) return false;
  return isPlainObject(layer.tools) || isPlainObject(layer.sections) || isV2SkillsShape(layer.skills);
}

/**
 * 把一层（文件 / 插件行 config）叠到目标上。后叠的赢，所以顺序是 row → file。
 * 只认 v3 的键；v2 的 tools/sections/skills 在进入这里之前已经被迁移吸收。
 */
function applyLayer(target, layer) {
  if (!isPlainObject(layer)) return;
  // P1-2 / A5：布尔开关双向覆盖。文件写 enabled:true 必须压过行 config 的 false，
  // 反过来文件写 false 也必须真的关掉（旧实现只会往下压 false，导致行里的 false 永远翻不回来）。
  if (typeof layer.enabled === "boolean") target.enabled = layer.enabled;
  // 布尔开关：只认 true/false，别的值当作没写（与其它 flag 一样，坏值不静默改语义）。
  if (typeof layer.freezePtcToolset === "boolean") target.freezePtcToolset = layer.freezePtcToolset;
  if (isPlainObject(layer.defaults)) {
    for (const axis of ["capability", "section", "skillpack"]) {
      const tier = normalizeTier(layer.defaults[axis], undefined);
      if (tier !== undefined) target.defaults[axis] = tier;
    }
  }
  if (isPlainObject(layer.capabilities)) target.capabilities = mergeCapabilitiesSafe(target.capabilities, layer.capabilities);
  if (isPlainObject(layer.sources)) target.sources = mergeSourcesSafe(target.sources, layer.sources);
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
  // 技能接管配置：v3 形状才认；v2 的 {tier} 已在迁移里吸收进 defaults.skillpack。
  if (isPlainObject(layer.skills) && !isV2SkillsShape(layer.skills)) {
    target.skills = mergeSkillsConfig(target.skills, layer.skills);
  }
  // MCP 声明：一层写了就整表替换（文件 > 行 config > 内置默认），校验统一在 normalizeV3Policy。
  if (isPlainObject(layer.mcp)) target.mcp = clone(layer.mcp);
  // 护栏配置逐字段叠：enabled 默认 false —— 没写这一层的部署必须保持 0.5.2 行为（不双提醒）。
  if (isPlainObject(layer.repeatGuard)) {
    target.repeatGuard = normalizeRepeatGuardConfigSafe(target.repeatGuard, layer.repeatGuard);
  }
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

// 层合并复用「保存侧」的字段级规则，但把严格校验用的 diagnostics 丢掉（读路径不写盘）。
function mergeCapabilitiesSafe(base, incoming) {
  return mergePolicyLayer({ capabilities: clone(isPlainObject(base) ? base : {}) }, { capabilities: incoming }).policy.capabilities;
}

function mergeSourcesSafe(base, incoming) {
  return mergePolicyLayer({ sources: clone(isPlainObject(base) ? base : {}) }, { sources: incoming }).policy.sources;
}

function normalizeRepeatGuardConfigSafe(base, incoming) {
  // 只借字段级合并规则：清掉别层已经有的键，避免把整个策略当成 base 重复合并。
  const merged = mergePolicyLayer({ repeatGuard: clone(isPlainObject(base) ? base : {}) }, { repeatGuard: clone(incoming) }).policy;
  return merged.repeatGuard;
}

/**
 * 闸门关闭 / 冷启动不可解析时的策略：不是「按默认策略」，而是「一律常驻」——
 * 文件坏了也不能把工具藏掉（I-3）。控制面仍挂载（lib/index.js 负责），用户能把它救回来。
 */
function disabledPolicy(filePath, reason, diagnostic) {
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
    // 闸门整体禁用 = 完全回到宿主行为：技能不接管（否则宿主 skill 工具被藏了却没人补目录）。
    // activationRelay 一并给出：禁用态即使有代码路径读它，也不该回落到「看起来开着」。
    skills: { takeover: false, activationRelay: false, activationPromote: false, off: [], imports: [], tier: TIER_RESIDENT },
    // 闸门禁用时不挂护栏（没有监听器可挂），但形状必须完整，别让下游读 undefined。
    repeatGuard: { ...template.repeatGuard, enabled: false },
    // 禁用时不挂任何 MCP server：声明保留在文件里，重新启用后才会自挂。
    mcp: { servers: {} },
    warnings: [{
      code: reason === "policy-file-invalid" ? "policy-file-invalid" : "policy-file-" + String(reason),
      message: "策略文件不可用（" + String(reason) + "），已退回全部常驻（工具面不放宽、控制面仍可访问）",
    }],
    migrated: false,
    backupFile: undefined,
    degraded: true,
    readDiagnostic: diagnostic,
    recovery: { shadow: false, backup: false, explicit: true },
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
 * @param {{dshHome?: string, logger?: any, knownNames?: Set<string>, backup?: boolean, shadow?: boolean}} [options]
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
  let store;
  let readResult;
  let readDiagnostic;
  let degraded = false;
  let recovery;

  if (filePath !== undefined) {
    try {
      store = createFilePolicyStore({ file: filePath, logger: opts.logger, shadow: opts.shadow !== false });
      readResult = store.readSync();
      readDiagnostic = store.readDiagnostic();
    } catch (error) {
      readResult = undefined;
      readDiagnostic = { status: "io", reason: String((error && error.code) || "EIO"), path: filePath, ok: false, exists: false, hadBom: false };
      try { opts.logger?.warn?.("dsh-gate: 策略存储初始化失败 — " + String((error && error.message) || error)); } catch { /* 忽略 */ }
    }
  } else {
    readDiagnostic = { status: "absent", reason: "no-policy-file", path: undefined, ok: true, exists: false, hadBom: false };
  }

  // 根不是普通对象（null / 数组 / 数字 / 字符串）同样是「形状损坏」：S2 存储为兼容
  // P0-2 可写性判定把它报成 status:ok + shape:<非 object>，这里统一按 shape 降级处理。
  const rootShapeBroken = readResult !== undefined && readResult.ok === true &&
    readResult.status !== "absent" && readResult.shape !== undefined && readResult.shape !== "object";
  if (rootShapeBroken) {
    readDiagnostic = Object.assign({}, readDiagnostic, {
      status: "shape",
      reason: "root-not-object",
      shape: readResult.shape,
      ok: false,
    });
  }

  if (readResult !== undefined && readResult.exists === true && readResult.ok === true && readResult.status !== "shape" && rootShapeBroken === false) {
    const parsed = readResult.value;
    if (readResult.status === "bom") {
      warnings.push({
        code: "policy-bom-stripped",
        message: "策略文件带 UTF-8 BOM（PowerShell Set-Content 的产物），已剥离后正常解析；文件本身没有被改写",
      });
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
          backupFile = backupV2PolicyFile(filePath, readResult.text);
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
  } else if (readResult !== undefined && readResult.status === "absent") {
    // 文件不存在：只用内置模板，绝不自动落盘（absent 不是「写一个空模板」的理由）。
    fileVersion = POLICY_VERSION;
  } else if (filePath !== undefined) {
    // syntax / shape / io：拒绝采用坏文件，也绝不写回空模板。
    // 有影子副本就沿用上一次成功策略（工具面不变）；冷启动没有影子才降级放行。
    degraded = true;
    const shadow = store !== undefined ? store.readShadowSync() : { ok: false };
    recovery = { shadow: shadow.ok === true, backup: false, explicit: true };
    if (shadow.ok === true && isPlainObject(shadow.policy)) {
      fromFile = shadow.policy;
      fileProvided = { defaults: isPlainObject(fromFile.defaults), v2Tools: false };
      fileVersion = POLICY_VERSION;
      warnings.push({
        code: "policy-file-degraded",
        message: "策略文件不可用（" + String(readDiagnostic && readDiagnostic.status) + "），已沿用上一次成功策略（影子副本）；原文件未被改写",
      });
    } else {
      const disabled = disabledPolicy(filePath, readDiagnostic && readDiagnostic.status ? readDiagnostic.status : "policy-file-invalid", readDiagnostic);
      disabled.recovery = recovery;
      for (const warning of disabled.warnings) warnings.push(warning);
      for (const warning of warnings) {
        try { opts.logger?.warn?.("dsh-gate: " + warning.code + " — " + warning.message); } catch { /* 忽略 */ }
      }
      return disabled;
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

  const normalizedResult = normalizeV3Policy(target);
  const normalized = normalizedResult.policy;
  // MCP 归一丢弃的坏条目也要进统一告警流（resolvePolicy 末尾会逐条 logger.warn）。
  for (const warning of normalizedResult.warnings || []) warnings.push(warning);
  const result = Object.assign({}, normalized, {
    // 目录渲染配置（0.5.1 票 01）：签名摘要统一成归一形状（布尔简写也认），
    // 免得「文件里写 true / {enabled:false} / 坏值」三种写法在渲染层各解一次。
    catalog: Object.assign({}, normalized.catalog, {
      signatureSummary: normalizeSignatureSummary(normalized.catalog && normalized.catalog.signatureSummary),
    }),
    policyFile: filePath,
    // 内置受保护名单（闸门四件套 + run_code）永远在里面，用户只能加不能减。
    protectedNames: new Set([...INTRINSIC_PROTECTED, ...normalized.protected]),
    // 技能接管配置 + 只读别名 tier：prestep / 面板仍按 skills.tier 读技能轴（真源是 defaults.skillpack）。
    // tier 只存在于运行时结果里，不进 normalizeV3Policy 的落盘形状。
    skills: Object.assign({}, normalized.skills, { tier: normalized.defaults.skillpack }),
    warnings,
    migrated: fileMigrated,
    backupFile,
    fromVersion: fileVersion,
    degraded,
    readDiagnostic,
    recovery,
  });
  // 读成功后刷新影子副本（规范化结果）：下次文件损坏时这就是「上一次成功策略」。
  // 只对「真的读到文件」刷新：absent 是「从未有过策略」，写影子等于在用户的目录里凭空生成文件。
  if (store !== undefined && degraded === false && readResult !== undefined && readResult.ok === true && readResult.exists === true) {
    try {
      store.writeShadowSync(normalized, {
        revision: readResult.revision,
        seq: splitRevision(readResult.revision)?.seq,
        digest: readResult.digest,
      });
    } catch (error) {
      try { opts.logger?.warn?.("dsh-gate: 影子副本写入失败（不影响读取）— " + String((error && error.message) || error)); } catch { /* 忽略 */ }
    }
  }
  for (const warning of warnings) {
    try { opts.logger?.warn?.("dsh-gate: " + warning.code + " — " + warning.message + (warning.layer ? "（层: " + warning.layer + "）" : "")); } catch { /* 忽略 */ }
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

// ─────────────────────────────────────────────────────────────────────────────
// 读取 / 保存的显式入口（0.6.0 新增；server.js 之外也给脚本与测试用）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 读一份策略文件（同步）：返回文档 + revision + 五级诊断，不写盘。
 * @param {string} file
 * @param {{logger?: object, shadow?: boolean}} [options]
 */
export function loadPolicy(file, options) {
  const opts = options || {};
  const store = createFilePolicyStore({ file, logger: opts.logger, shadow: opts.shadow !== false });
  const read = store.readSync();
  const diagnostic = store.readDiagnostic();
  const corrupt = isCorruptRead(read);
  return {
    ok: corrupt !== true,
    exists: read.exists === true,
    document: read.ok === true && read.status !== "shape" ? read.value : undefined,
    revision: read.revision,
    diagnostic,
    error: corrupt === true
      ? new StorageError(read.code || STORAGE_CODES.UNREADABLE, String(read.error || read.reason || "policy unreadable"), { diagnostic })
      : undefined,
    store,
  };
}

/**
 * 合并式保存（异步）：读当前真源 → 表驱动合并 → 归一 → 原子写。
 * 坏文件默认拒绝写（forceOverwriteCorrupt / replaceCorrupt 才允许整份替换，且先备份原文）。
 *
 * @param {string} file
 * @param {object} patch
 * @param {{logger?: object, shadow?: boolean, expectedRevision?: string, ifRevision?: string,
 *   replaceCorrupt?: boolean, forceOverwriteCorrupt?: boolean, allowExtensions?: boolean}} [options]
 */
export async function savePolicy(file, patch, options) {
  const opts = options || {};
  const store = createFilePolicyStore({ file, logger: opts.logger, shadow: opts.shadow !== false });
  // 读-改-写整体进入进程级写链（storage-seam 的 exclusive）：两个页签同时 savePolicy 时，
  // 后一个事务一定在前一个落盘之后才 readSync，不会拿旧 base 把前者的改动盖回去（A10/A15）。
  return store.exclusive(async () => {
    const read = store.readSync();
    const corrupt = isCorruptRead(read);
    const force = opts.replaceCorrupt === true || opts.forceOverwriteCorrupt === true;
    if (corrupt === true && force !== true) {
      throw new StorageError(
        read.code || STORAGE_CODES.UNREADABLE,
        "策略文件不可读（" + String(read.status) + "）；默认拒绝写，需显式整份替换并确认风险",
        { diagnostic: store.readDiagnostic() },
      );
    }
    const base = read.ok === true && isPlainObject(read.value) ? read.value : emptyPolicyTemplate();
    const merged = mergePolicyLayer(base, isPlainObject(patch) ? patch : {}, { allowExtensions: opts.allowExtensions !== false });
    const policy = normalizeV3Policy(merged.policy).policy;
    const receipt = await store.write(policy, {
      replaceCorrupt: force,
      expectedRevision: opts.expectedRevision !== undefined ? opts.expectedRevision : opts.ifRevision,
      changedKeys: merged.changedKeys,
      warnings: merged.warnings,
    });
    return Object.assign({}, receipt, { policy, ignored: merged.ignored, diagnostic: store.readDiagnostic() });
  });
}
