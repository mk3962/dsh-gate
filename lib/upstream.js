/**
 * 上游兼容层（工单 08）—— 「谁被上游藏了」与「能力来源」的唯一判定口。
 *
 * 背景（docs/dsh-gate-0.2.0-02-来源与上游.md §2）：
 *  - 宿主 `view(scope)` 给出 `knownNames`（注册过、不受限制影响）与 `visible`
 *    （被所有层限制过滤后的当前视图），但**不告诉你是谁藏的**；
 *  - 上游（别的插件 / 上层管理器）用 `restrict({deny})` 藏掉的名字，我们既撤不掉、
 *    也不能把它重新放出来 —— 只能标出来，并从候选集里减掉。
 *
 * 所以这里只做三件纯函数的事，全部可单测、不碰宿主状态：
 *   1) upstreamHidden = known − visible − own − 自己 deny（own 不算被上游藏）；
 *   2) usable = known ∪ 全局可见 − upstreamHidden（调用方的候选集）；
 *   3) provenance = 每个名字的来源与置信度（mcp > own/preset > skillpack > plugin > 注册顺序 > 未知）。
 *
 * 判断只在这里做一次：gate.planFor / planSections / surfaceOf 都读同一份结果。
 * 不猜段落归属（除 mcp:<server> 命名约定），也不把「推不出来」当成「可以藏」。
 */
import {
  CONFIDENCE_HIGH,
  CONFIDENCE_LOW,
  CONFIDENCE_MEDIUM,
  CONFIDENCE_UNKNOWN,
  mcpServerOfToolName,
  NATIVE_TOOL_NAMES,
  PLUGIN_PREFIXES,
} from "./capabilities.js";
import { ownerOf } from "./catalog.js";

export const PROVENANCE_HIGH = CONFIDENCE_HIGH;
export const PROVENANCE_MEDIUM = CONFIDENCE_MEDIUM;
export const PROVENANCE_LOW = CONFIDENCE_LOW;
export const PROVENANCE_UNKNOWN = CONFIDENCE_UNKNOWN;

const UNKNOWN_PROVENANCE = Object.freeze({
  source: "unknown",
  confidence: PROVENANCE_UNKNOWN,
  via: "unknown",
});

/** 名字集合归一：Set / Map（取 key）/ 数组 / 空值都接受。 */
function nameSetOf(value) {
  const out = new Set();
  if (value instanceof Set) {
    for (const name of value) if (typeof name === "string" && name.length > 0) out.add(name);
    return out;
  }
  if (value instanceof Map) {
    for (const name of value.keys()) if (typeof name === "string" && name.length > 0) out.add(name);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.length > 0) out.add(item);
      else if (item && typeof item.name === "string" && item.name.length > 0) out.add(item.name);
    }
  }
  return out;
}

function nameListOf(value) {
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item === "string" && item.length > 0) out.push(item);
    else if (item && typeof item.name === "string" && item.name.length > 0) out.push(item.name);
  }
  return out;
}

function skillListOf(value) {
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item.name !== "string" || item.name.length === 0) continue;
    const provider = typeof item.provider === "string" && item.provider.length > 0 ? item.provider : undefined;
    out.push({ name: item.name, provider });
  }
  return out;
}

/** 段落 mcp:<server> → server；其它段落返回 undefined（不猜归属）。 */
export function mcpServerOfSectionName(name) {
  const text = String(name || "");
  if (!text.startsWith("mcp:")) return undefined;
  const server = text.slice(4);
  return server.length > 0 ? server : undefined;
}

/** 该 server 的工具名判定：mcp__<server>__* 与裸 mcp__<server>。 */
export function isMcpToolOfServer(name, server) {
  if (typeof name !== "string" || typeof server !== "string" || server.length === 0) return false;
  const exact = "mcp__" + server;
  return name === exact || name.startsWith(exact + "__");
}

/** 工具的来源标注 —— 优先级从高到低，命中即停。 */
export function provenanceOfTool(name, context) {
  const tool = String(name || "");
  const ctx = context || {};
  // 1 mcp__<server>__* → mcp:<server>（宿主强制命名，最高）
  const mcp = mcpServerOfToolName(tool);
  if (mcp !== undefined) return { source: "mcp:" + mcp, confidence: PROVENANCE_HIGH, via: "naming" };

  const own = nameSetOf(ctx.own);
  const preset = nameSetOf(ctx.preset);
  const globallyVisible = nameSetOf(ctx.globallyVisible);
  const knownNames = nameSetOf(ctx.knownNames);

  // 2 own 层 / preset 平面 → native（注册面就是宿主语义）
  if (own.has(tool)) return { source: "native", confidence: PROVENANCE_HIGH, via: "own" };
  if (preset.has(tool)) return { source: "native", confidence: PROVENANCE_HIGH, via: "preset" };
  // 没有显式 preset 集合时，用「注册过但不在全局视图」判 preset 平面。
  if (ctx.globallyVisible !== undefined && knownNames.size > 0 && knownNames.has(tool) && !globallyVisible.has(tool)) {
    return { source: "native", confidence: PROVENANCE_HIGH, via: "preset" };
  }
  // 3 dsh 原生工具清单（静态、与运行期视图无关）
  if (NATIVE_TOOL_NAMES.has(tool)) return { source: "native", confidence: PROVENANCE_HIGH, via: "native" };

  // 4 包前缀 → plugin（已知前缀 medium；同前缀聚成一组时才 low）
  const prefix = ownerOf(tool);
  if (prefix !== tool && prefix.length > 0) {
    if (Object.prototype.hasOwnProperty.call(PLUGIN_PREFIXES, prefix)) {
      // 已知前缀用 npm 包名，和 capability id（plugin:<包名>）对齐；行与成员的来源才读得一致。
      return { source: "plugin:" + PLUGIN_PREFIXES[prefix], confidence: PROVENANCE_MEDIUM, via: "prefix" };
    }
    let cluster = 0;
    for (const other of knownNames) if (ownerOf(other) === prefix) cluster += 1;
    if (cluster >= 2) return { source: "plugin:" + prefix, confidence: PROVENANCE_LOW, via: "prefix" };
  }

  // 5 注册顺序兜底：只知道「它确实注册过」，不知道归谁。
  if (knownNames.has(tool)) return { source: "order", confidence: PROVENANCE_LOW, via: "registration" };
  // 6 未知：连注册面都无法确认（例如调用方直接问一个没注册的名字）。
  return { ...UNKNOWN_PROVENANCE };
}

/** 段落的来源标注：只有 mcp:<server> 有命名约定；其余一律 unknown，不猜。 */
export function provenanceOfSection(name) {
  const server = mcpServerOfSectionName(name);
  if (server !== undefined) return { source: "mcp:" + server, confidence: PROVENANCE_HIGH, via: "naming" };
  return { ...UNKNOWN_PROVENANCE };
}

/** 技能的来源标注：ctx.skills.list 的 provider 是唯一可信信号（A7）。 */
export function provenanceOfSkill(skill) {
  const provider = skill && typeof skill.provider === "string" ? skill.provider.trim() : "";
  if (provider.length > 0) return { source: "skillpack", confidence: PROVENANCE_HIGH, via: "provider" };
  return { ...UNKNOWN_PROVENANCE };
}

/**
 * 上游表面 —— 纯函数，不碰宿主。
 *
 * @param {{
 *   knownNames?: Set<string>|string[],
 *   visible?: Map<string, any>|Set<string>|string[],
 *   own?: Set<string>|string[],
 *   ourDeny?: Set<string>|string[],
 *   skills?: Array<{name:string, provider?:string}>,
 *   sections?: Array<{name:string}|string>,
 *   preset?: Set<string>|string[],
 *   globallyVisible?: Map<string, any>|Set<string>|string[],
 * }} input
 * @returns {{usable: Set<string>, upstreamHidden: string[], provenance: Map<string, {source:string, confidence:string, via:string}>}}
 */
export function computeSurface(input) {
  const source = input && typeof input === "object" ? input : {};
  const knownNames = nameSetOf(source.knownNames);
  const visible = nameSetOf(source.visible);
  const own = nameSetOf(source.own);
  const ourDeny = nameSetOf(source.ourDeny);
  const globallyVisible = nameSetOf(source.globallyVisible);
  const preset = nameSetOf(source.preset);
  const skills = skillListOf(source.skills);
  const sections = nameListOf(source.sections);

  // 谁被上游藏了：注册过、当前视图没有、不是自己的层、也不是闸门自己 deny 的。
  const upstreamHidden = [];
  const hidden = new Set();
  for (const name of knownNames) {
    if (own.has(name) || visible.has(name) || ourDeny.has(name)) continue;
    hidden.add(name);
    upstreamHidden.push(name);
  }
  upstreamHidden.sort();

  // 可用候选 = 注册过的 ∪ 全局可见，减掉上游藏起来的（只标注、不放出）。
  const usable = new Set();
  for (const name of knownNames) if (!hidden.has(name)) usable.add(name);
  for (const name of globallyVisible) if (!hidden.has(name)) usable.add(name);

  const provenance = new Map();
  // globallyVisible 缺席时不能反推 preset：否则任何「known 但不在（空）全局视图」的名字都会被
  // 误标成 native/high。只有调用方明确给了全局面，才启用 preset 平面的兜底判据。
  const context = {
    own,
    preset,
    globallyVisible: source.globallyVisible === undefined ? undefined : globallyVisible,
    knownNames,
  };
  for (const name of knownNames) provenance.set(name, provenanceOfTool(name, context));
  for (const name of globallyVisible) {
    if (!provenance.has(name)) provenance.set(name, provenanceOfTool(name, context));
  }
  for (const name of visible) {
    if (!provenance.has(name)) provenance.set(name, provenanceOfTool(name, context));
  }
  for (const name of sections) {
    if (!provenance.has(name)) provenance.set(name, provenanceOfSection(name));
  }
  for (const skill of skills) {
    // 同名工具已经占了 key：工具身份优先，技能来源不覆盖它（两者本是两个命名空间）。
    if (!provenance.has(skill.name)) provenance.set(skill.name, provenanceOfSkill(skill));
  }

  return { usable, upstreamHidden, provenance };
}

/**
 * 段落兜底（只做减法）：mcp:<server> 段落对应的工具全部被上游藏了/一个都没注册时摘掉。
 * 非 mcp 段落一律不摘 —— 没有稳定来源，误杀就是不可逆的文本丢失。
 *
 * @param {string} name 段落名
 * @param {{knownNames?: Set<string>|string[], upstreamHidden?: Set<string>|string[]}} context
 */
export function isSectionUpstreamHidden(name, context) {
  const server = mcpServerOfSectionName(name);
  if (server === undefined) return false;
  const ctx = context || {};
  const knownNames = nameSetOf(ctx.knownNames);
  const upstreamHidden = nameSetOf(ctx.upstreamHidden);
  const members = [];
  for (const tool of knownNames) if (isMcpToolOfServer(tool, server)) members.push(tool);
  // 一个都不在 knownNames 里：该 server 在这个 agent 面上没有注册任何工具 ⇒ 段落是孤儿。
  if (members.length === 0) return true;
  return members.every((tool) => upstreamHidden.has(tool));
}
