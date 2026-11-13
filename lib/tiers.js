/**
 * 层与匹配的基础件（0.2.0）。
 *
 * 三档常量、通配匹配、值归一这三件事，0.1.8 都在 policy.js 里；0.2.0 又多了两个读者
 * （capabilities.js 解析能力、migrate.js 迁 v2），再各写一份就会重演
 * 「threshold 与 number 各写一遍逐字相同的归一函数」那种分叉。
 * 所以收进这里，policy.js 继续 re-export，老的 import 路径不用改。
 */

export const TIER_OFF = 0;
export const TIER_RESIDENT = 1;
export const TIER_ONDEMAND = 2;

/** 「是不是一个普通对象」—— 全插件只此一份。 */
export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function clone(value) {
  if (Array.isArray(value)) return value.map((item) => clone(item));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = clone(item);
    return out;
  }
  return value;
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

/** 星号 / 问号通配（0.1.8 起的语义，别改）。 */
export function matches(pattern, name) {
  if (pattern === name) return true;
  if (!pattern.includes("*") && !pattern.includes("?")) return false;
  return patternToRegExp(pattern).test(name);
}

/** 通配度 = 去掉通配符后的字面量长度；越长越具体（0.1.8 起「最具体命中」的判据）。 */
export function specificity(pattern) {
  return String(pattern).replace(/[*?]/g, "").length;
}

/**
 * entries（tools.overrides / 能力的 toolExceptions 等）里命中 name 的最具体一条。
 * 没有命中返回 undefined。
 */
export function pickMostSpecific(entries, name) {
  let best;
  let bestScore = -1;
  for (const pattern of Object.keys(entries || {})) {
    if (!matches(pattern, name)) continue;
    const score = specificity(pattern);
    if (score > bestScore) {
      bestScore = score;
      best = pattern;
    }
  }
  if (best === undefined) return undefined;
  return { pattern: best, value: entries[best] };
}

/**
 * 只接受真正的 0/1/2（数字，或纯数字字符串）。
 * 旧实现用 Number(value)：null / "" / false / [] 全被静默转成 0（=关闭），
 * 一个手滑的 null 就能把工具从工具表里删掉。非法值一律回退 fallback。
 */
export function normalizeTier(value, fallback) {
  if (typeof value === "number") {
    if (value === TIER_OFF || value === TIER_RESIDENT || value === TIER_ONDEMAND) return value;
    return fallback;
  }
  if (typeof value === "string" && /^\s*[012]\s*$/.test(value)) return Number(value);
  return fallback;
}

/** 非负整数（版本号、豁免阈值这类）。0 合法、非法值回退默认，绝不静默变 0。 */
export function normalizeCount(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) return Number(value);
  return fallback;
}

/**
 * 宽松度：resident 最松、on-demand 次之、off 最紧。
 * v2 → v3 迁移时同一能力内档位冲突取**最宽松**（fail-open，避免迁移把工具突然关掉）。
 */
export function loosenessRank(tier) {
  if (tier === TIER_RESIDENT) return 0;
  if (tier === TIER_ONDEMAND) return 1;
  return 2;
}
