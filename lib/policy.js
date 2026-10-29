/**
 * 策略解析：两层模型（1 = 常驻，2 = 按需，0 = 关闭）。
 *
 * 匹配规则：overrides 的键支持星号通配（ops_* / mcp:*）。
 * 多条命中时取“最具体”的那条 —— 去掉通配符后字面量最长的胜出，
 * 所以 univer_sheet 会压过 univer_*，单独一个星号永远最后。
 *
 * 一切解析失败都 fail-open：退回“全部常驻”，宁可没省 token，也不能让会话崩。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

export const TIER_RESIDENT = 1;
export const TIER_ONDEMAND = 2;
export const TIER_OFF = 0;

/** 闸门自己的工具 + PTC 传输，任何策略都动不了。 */
export const INTRINSIC_PROTECTED = Object.freeze([
  "run_code",
  "gate_search",
  "gate_load",
  "gate_call",
  "gate_status",
]);

export const DEFAULT_POLICY = Object.freeze({
  version: 2,
  enabled: true,
  tools: {
    defaultTier: TIER_ONDEMAND,
    overrides: {
      pwsh: TIER_RESIDENT,
      read: TIER_RESIDENT,
      write: TIER_RESIDENT,
      edit: TIER_RESIDENT,
      grep: TIER_RESIDENT,
      glob: TIER_RESIDENT,
      web_search: TIER_RESIDENT,
      web_fetch: TIER_RESIDENT,
      ws_mcp_call: TIER_RESIDENT,
      skill: TIER_RESIDENT,
    },
  },
  sections: {
    // 段落默认不动：只有显式点名的段落才会被摘掉。
    defaultTier: TIER_RESIDENT,
    overrides: {},
  },
  skills: { tier: TIER_ONDEMAND },
  catalog: { groupByPlugin: true, maxNameLength: 48, hint: true },
  protected: [],
});

const compiled = new Map();

function patternToRegExp(pattern) {
  const cached = compiled.get(pattern);
  if (cached !== undefined) return cached;
  let source = "";
  for (const ch of pattern) {
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  const re = new RegExp("^" + source + "$");
  compiled.set(pattern, re);
  return re;
}

export function matches(pattern, name) {
  if (pattern === name) return true;
  if (!pattern.includes("*") && !pattern.includes("?")) return false;
  return patternToRegExp(pattern).test(name);
}

/**
 * 只接受真正的 0/1/2（数字，或纯数字字符串）。
 * 旧实现用 Number(value)：null / "" / false / [] 全被静默转成 0（=关闭），
 * 一个手滑的 null 就能把工具从工具表里删掉。非法值一律回退默认层。
 */
function normalizeTier(value, fallback) {
  if (typeof value === "number") {
    if (value === TIER_OFF || value === TIER_RESIDENT || value === TIER_ONDEMAND) return value;
    return fallback;
  }
  if (typeof value === "string" && /^\s*[012]\s*$/.test(value)) return Number(value);
  return fallback;
}

/** 最具体命中的层；没有命中返回 fallback。 */
export function tierOf(section, name, fallback) {
  let best;
  let bestScore = -1;
  const overrides = (section && section.overrides) || {};
  for (const pattern of Object.keys(overrides)) {
    if (!matches(pattern, name)) continue;
    const score = pattern.replace(/[*?]/g, "").length;
    if (score > bestScore) {
      bestScore = score;
      best = overrides[pattern];
    }
  }
  return best === undefined ? fallback : normalizeTier(best, fallback);
}

function mergeSection(section, defaults) {
  const source = section && typeof section === "object" ? section : {};
  const overrides = {};
  for (const [k, v] of Object.entries(source.overrides || {})) {
    if (typeof k === "string" && k.length > 0) overrides[k] = normalizeTier(v, defaults.defaultTier);
  }
  return {
    defaultTier: normalizeTier(source.defaultTier === undefined ? defaults.defaultTier : source.defaultTier, defaults.defaultTier),
    overrides,
  };
}

function disabledPolicy(filePath, reason) {
  return {
    enabled: false,
    policyFile: filePath,
    reason,
    tools: { defaultTier: TIER_RESIDENT, overrides: {} },
    sections: { defaultTier: TIER_RESIDENT, overrides: {} },
    skills: { tier: TIER_RESIDENT },
    catalog: { ...DEFAULT_POLICY.catalog },
    protectedNames: new Set(INTRINSIC_PROTECTED),
  };
}

export function resolvePolicy(raw, options) {
  const opts = options || {};
  const merged = Object.assign({}, DEFAULT_POLICY, raw && typeof raw === "object" ? raw : {});
  const filePath =
    typeof merged.policyFile === "string" && merged.policyFile.trim().length > 0
      ? merged.policyFile.trim()
      : opts.dshHome
        ? path.join(opts.dshHome, "gate.json")
        : undefined;

  let fromFile = {};
  if (filePath && fs.existsSync(filePath)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!fromFile || typeof fromFile !== "object") throw new Error("policy file is not an object");
    } catch (error) {
      const detail = String((error && error.message) || error);
      opts.logger?.warn?.("dsh-gate: 策略文件读取失败，已退回全部常驻：" + filePath + " — " + detail);
      return disabledPolicy(filePath, "policy-file-invalid");
    }
  }

  const toolsRaw = Object.assign({}, fromFile.tools || {});
  if (raw && raw.tools && raw.tools.overrides) {
    toolsRaw.overrides = Object.assign({}, toolsRaw.overrides || {}, raw.tools.overrides);
  }
  const sectionsRaw = Object.assign({}, fromFile.sections || {});
  if (raw && raw.sections && raw.sections.overrides) {
    sectionsRaw.overrides = Object.assign({}, sectionsRaw.overrides || {}, raw.sections.overrides);
  }

  // 既没有策略文件、插件行也没写 tools/sections 时，必须保留内置默认的 T1 覆盖，
  // 否则会被 mergeSection 的空对象冲成“全部按需”，把 read/write 也藏掉。
  const hasFileTools = Boolean(fromFile.tools && typeof fromFile.tools === "object");
  const hasRawTools = Boolean(raw && raw.tools && typeof raw.tools === "object");
  const tools = hasFileTools || hasRawTools
    ? mergeSection(toolsRaw, DEFAULT_POLICY.tools)
    : { defaultTier: DEFAULT_POLICY.tools.defaultTier, overrides: { ...DEFAULT_POLICY.tools.overrides } };
  const hasFileSections = Boolean(fromFile.sections && typeof fromFile.sections === "object");
  const hasRawSections = Boolean(raw && raw.sections && typeof raw.sections === "object");
  const sections = hasFileSections || hasRawSections
    ? mergeSection(sectionsRaw, DEFAULT_POLICY.sections)
    : { defaultTier: DEFAULT_POLICY.sections.defaultTier, overrides: { ...DEFAULT_POLICY.sections.overrides } };
  const skillsRaw = (fromFile.skills && fromFile.skills.tier) ?? (raw && raw.skills && raw.skills.tier) ?? DEFAULT_POLICY.skills.tier;
  const catalog = Object.assign({}, DEFAULT_POLICY.catalog, fromFile.catalog || {}, (raw && raw.catalog) || {});
  const protectedNames = new Set(INTRINSIC_PROTECTED);
  for (const list of [fromFile.protected, raw && raw.protected]) {
    if (Array.isArray(list)) for (const name of list) if (typeof name === "string") protectedNames.add(name);
  }

  const enabled = fromFile.enabled !== false && (!raw || raw.enabled !== false) && merged.enabled !== false;

  return { enabled, policyFile: filePath, tools, sections, skills: { tier: normalizeTier(skillsRaw, TIER_ONDEMAND) }, catalog, protectedNames };
}

/** 工具最终归层：protected 永远常驻。 */
export function tierForTool(policy, name) {
  if (policy.protectedNames.has(name)) return TIER_RESIDENT;
  return tierOf(policy.tools, name, policy.tools.defaultTier);
}

export function tierForSection(policy, name) {
  return tierOf(policy.sections, name, policy.sections.defaultTier);
}
