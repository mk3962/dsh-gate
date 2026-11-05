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

/** 「是不是一个普通对象」—— 全插件只此一份（server.js 也用它，别各写各的）。 */
export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map((item) => clone(item));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clone(v);
    return out;
  }
  return value;
}

/**
 * 策略顶层键表 —— 读（resolveKey）、合并（mergePolicyFile）、兜底模板
 * （emptyPolicyTemplate）的唯一真源（票 05 加深）。
 *
 * 每条记录：
 *   key       顶层键名（策略文件与插件行 config 用同一个名字）
 *   kind      读取时怎么解释：flag / number / threshold / section / tier / object / names
 *   merge     保存（UI POST）时怎么合并：replace / object
 *   fallback  内置默认值，同时就是空策略模板里该键的值
 *
 * 这三件事以前各写一份：resolvePolicy 里七段分支、server.js 里一条手工白名单
 * if 链（加新键会被 UI 保存静默抹掉 —— 豁免阈值已经踩过一次）、还有一份手抄的
 * 空策略模板，它跟这里的默认互相矛盾（skills.tier 1 对 2、catalog 少了键）。
 * 现在加一个键 = 这张表加一行。
 */
export const POLICY_KEYS = Object.freeze([
  { key: "version", kind: "number", merge: "replace", fallback: 2 },
  { key: "enabled", kind: "flag", merge: "replace", fallback: true },
  {
    key: "tools",
    kind: "section",
    merge: "object",
    fallback: {
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
  },
  {
    key: "sections",
    kind: "section",
    merge: "object",
    // 段落默认不动：只有显式点名的段落才会被摘掉。
    fallback: { defaultTier: TIER_RESIDENT, overrides: {} },
  },
  { key: "skills", kind: "tier", merge: "object", fallback: { tier: TIER_ONDEMAND } },
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
  { key: "narrowPassThrough", kind: "threshold", merge: "replace", fallback: 12 },
]);

/** 空策略模板：每个键取其内置默认，与 resolvePolicy 的兜底同一份值。 */
export function emptyPolicyTemplate() {
  const out = {};
  for (const spec of POLICY_KEYS) out[spec.key] = clone(spec.fallback);
  return out;
}

export const DEFAULT_POLICY = Object.freeze(emptyPolicyTemplate());

/**
 * 保存策略文件时的合并（UI 只提交它认识的那几个键）。
 * 未在表里的键原样保留 —— 用户手写的扩展键不该因为点一次「保存」就消失。
 */
export function mergePolicyFile(current, incoming) {
  const base = isPlainObject(current) ? current : {};
  const next = isPlainObject(incoming) ? incoming : {};
  const out = Object.assign({}, base);
  for (const spec of POLICY_KEYS) {
    const value = next[spec.key];
    if (value === undefined) continue;
    if (spec.merge === "replace") {
      if (spec.kind === "flag" && typeof value !== "boolean") continue;
      if (spec.kind === "names" && !Array.isArray(value)) continue;
      out[spec.key] = value;
      continue;
    }
    // object：逐键合并；段里的 overrides 再逐键合并，别让一次保存丢掉没渲染出来的覆盖项。
    if (!isPlainObject(value)) continue;
    const merged = Object.assign({}, isPlainObject(base[spec.key]) ? base[spec.key] : {}, value);
    if (isPlainObject(value.overrides) || isPlainObject(base[spec.key] && base[spec.key].overrides)) {
      merged.overrides = Object.assign(
        {},
        isPlainObject(base[spec.key] && base[spec.key].overrides) ? base[spec.key].overrides : {},
        isPlainObject(value.overrides) ? value.overrides : {},
      );
    }
    out[spec.key] = merged;
  }
  return out;
}

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
  const template = emptyPolicyTemplate();
  return {
    enabled: false,
    policyFile: filePath,
    reason,
    // 关掉闸门时不是「按默认策略」，而是「一律常驻」：文件坏了也不能把工具藏掉。
    tools: { defaultTier: TIER_RESIDENT, overrides: {} },
    sections: { defaultTier: TIER_RESIDENT, overrides: {} },
    skills: { tier: TIER_RESIDENT },
    catalog: template.catalog,
    protectedNames: new Set(INTRINSIC_PROTECTED),
    narrowPassThrough: 0,
  };
}

/**
 * 非负整数（版本号、豁免阈值这类）。0 合法、非法值回退默认，绝不静默变 0。
 * 以前 threshold 与 number 各写一份逐字相同的函数，改一处忘另一处就会让两类键行为分叉。
 */
function normalizeCount(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) return Number(value);
  return fallback;
}

/** 这个键在文件里怎么写、插件行 config 里怎么写；两者都没有就说明没写。 */
function sourcesOf(spec, fromFile, row) {
  const fileValue = fromFile[spec.key];
  const rowValue = row[spec.key];
  return {
    hasFile: fileValue !== undefined && fileValue !== null,
    fileValue,
    hasRow: rowValue !== undefined && rowValue !== null,
    rowValue,
  };
}

/**
 * 段落（tools / sections）：overrides 是两张表的并集，defaultTier 逐字段回落。
 *
 * 优先级是**逐字段**的：文件里写了的字段以文件为准，文件没写才回落到插件行 config，
 * 最后才是内置默认。两边都没写时必须保留内置默认的那 10 条 T1 覆盖 ——
 * 否则会被 mergeSection 的空对象冲成「全部按需」，把 read/write 一起藏掉。
 */
function sectionValue(spec, sources) {
  const fileSection = isPlainObject(sources.fileValue) ? sources.fileValue : undefined;
  const rowSection = isPlainObject(sources.rowValue) ? sources.rowValue : undefined;
  if (fileSection === undefined && rowSection === undefined) return clone(spec.fallback);
  const fileOverrides = isPlainObject(fileSection && fileSection.overrides) ? fileSection.overrides : {};
  const rowOverrides = isPlainObject(rowSection && rowSection.overrides) ? rowSection.overrides : {};
  const pickDefaultTier = () => {
    if (fileSection && fileSection.defaultTier !== undefined) return fileSection.defaultTier;
    if (rowSection && rowSection.defaultTier !== undefined) return rowSection.defaultTier;
    return spec.fallback.defaultTier;
  };
  const source = {
    defaultTier: pickDefaultTier(),
    // 冲突时文件赢（与其它键、与文档写的「文件 > 插件行 config」一致）。
    overrides: Object.assign({}, rowOverrides, fileOverrides),
  };
  return mergeSection(source, spec.fallback);
}

/**
 * 一个顶层键的读取：文件 > 插件行 config > 表里的 fallback。
 * 加一个键 = POLICY_KEYS 加一行，这里不用动。
 */
function resolveKey(spec, fromFile, row) {
  const sources = sourcesOf(spec, fromFile, row);
  const primary = sources.hasFile ? sources.fileValue : sources.hasRow ? sources.rowValue : undefined;
  switch (spec.kind) {
    case "flag":
      // 任何一处写 false 就关；写别的类型当没写。
      if (sources.hasFile && sources.fileValue === false) return false;
      if (sources.hasRow && sources.rowValue === false) return false;
      return spec.fallback;
    case "number":
      return primary === undefined ? spec.fallback : normalizeCount(primary, spec.fallback);
    case "threshold":
      return primary === undefined ? spec.fallback : normalizeCount(primary, spec.fallback);
    case "tier": {
      const raw = isPlainObject(primary) ? primary.tier : undefined;
      return { tier: normalizeTier(raw, spec.fallback.tier) };
    }
    case "section":
      return sectionValue(spec, sources);
    case "object": {
      // 逐层覆盖，后写的赢 —— 所以顺序必须是「先行 config、后文件」，
      // 与其它种类的「文件 > 插件行 config」优先级保持一致（旧实现把行放最后，
      // 于是 catalog 这一个键的优先级跟别的键反着来）。
      const base = clone(spec.fallback);
      for (const layer of [sources.hasRow ? sources.rowValue : undefined, sources.hasFile ? sources.fileValue : undefined]) {
        if (!isPlainObject(layer)) continue;
        Object.assign(base, layer);
      }
      return base;
    }
    // 没有 case "names"：这类键（protected）不是「一个值」，而是往内置名单里加名字，
    // 由 resolvePolicy 自己的合并循环处理；写在这里的 return [] 从来没被用过。
    default:
      return clone(spec.fallback);
  }
}

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

  let fromFile = {};
  if (filePath && fs.existsSync(filePath)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!isPlainObject(fromFile)) throw new Error("policy file is not an object");
    } catch (error) {
      const detail = String((error && error.message) || error);
      opts.logger?.warn?.("dsh-gate: 策略文件读取失败，已退回全部常驻：" + filePath + " — " + detail);
      return disabledPolicy(filePath, "policy-file-invalid");
    }
  }

  const out = { policyFile: filePath, enabled: true, protectedNames: new Set(INTRINSIC_PROTECTED) };
  for (const spec of POLICY_KEYS) {
    const value = resolveKey(spec, fromFile, row);
    if (spec.kind === "names") {
      // 内置受保护名单（闸门四件套 + run_code）永远在里面，用户只能加不能减。
      for (const list of [fromFile[spec.key], row[spec.key]]) {
        if (!Array.isArray(list)) continue;
        for (const name of list) if (typeof name === "string") out.protectedNames.add(name);
      }
      continue;
    }
    out[spec.key] = value;
  }
  return out;
}

/** 工具最终归层：protected 永远常驻。 */
export function tierForTool(policy, name) {
  if (policy.protectedNames.has(name)) return TIER_RESIDENT;
  return tierOf(policy.tools, name, policy.tools.defaultTier);
}

/**
 * 「谁归哪层」的唯一出口（票 04）。
 *
 * 以前这条规则有两份实现：planFor 里的 if 链决定限制什么，tierMap 里又写一遍
 * 决定面板显示什么。两份一起漂就等于：面板说常驻、工具表里却没了（或反过来）。
 *
 * @param {object} policy
 * @param {string} name
 * @param {{loaded?: boolean, globallyVisible?: boolean, own?: boolean}} context
 *   loaded          本轮已被 gate_load 认领
 *   globallyVisible 在全局视图（view() 无 scope）里可见 —— preset 平面为 false
 *   own             agent 自己这一层注册的（restrict 管不到）
 * @returns {{tier: number, bucket: "own"|"preset"|"resident"|"ondemand"|"off"}}
 */
export function resolveTier(policy, name, context) {
  const ctx = context || {};
  if (ctx.own === true) return { tier: TIER_RESIDENT, bucket: "own" };
  // preset 平面（只在 agent 链上、不在全局视图里）默认**不受管**：没被 overrides / 已加载点名
  // 就保持常驻、不写 deny。否则默认策略会把 read/write/pwsh 这类基础工具一起藏掉。
  if (ctx.globallyVisible === false && ctx.loaded !== true && !hasToolOverride(policy, name)) {
    return { tier: TIER_RESIDENT, bucket: "preset" };
  }
  // 已加载的名字恒常驻；受保护名字由 tierForTool 内部保证常驻。
  const tier = ctx.loaded === true ? TIER_RESIDENT : tierForTool(policy, name);
  if (tier === TIER_RESIDENT) return { tier, bucket: "resident" };
  if (tier === TIER_OFF) return { tier, bucket: "off" };
  return { tier, bucket: "ondemand" };
}

/** 该名字是否被 overrides 显式点名（含通配命中）。preset 平面的工具靠这个“点名才受管”。 */
export function hasToolOverride(policy, name) {
  for (const pattern of Object.keys((policy.tools && policy.tools.overrides) || {})) {
    if (matches(pattern, name)) return true;
  }
  return false;
}

export function tierForSection(policy, name) {
  return tierOf(policy.sections, name, policy.sections.defaultTier);
}
