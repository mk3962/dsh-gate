/**
 * 规划器（0.6.0 工单 #03 · 规格 D7）—— 一次产出**不可变计划**。
 *
 * 为什么要有它：0.5.7 里「谁落哪层」被算了四遍（planFor 的候选循环、tierMap 的第二次
 * resolveTier、planSections 的 shouldDrop、load 的 off/knownSections 各自判），四份答案随时会漂；
 * B20/B22/B24 三条 P1/P2 全是这个结构的直接后果。现在：
 *   - 决策在 lib/decide.js（纯函数）；
 *   - 装配在**这一个**函数；
 *   - 下游七个派生点（限制 deny、目录、快照 tiers、段落摘除、加载口、能力视图、搜索）只读计划。
 *
 * 依赖纪律：只依赖 decide.js 与标准库。不读 ctx、不认识 agent、不写日志 —— 告警由调用方收集后传进来。
 */
import { AXES, REASONS, decideSection, decideSkill, decideTool } from "./decide.js";
import { TIER_OFF, TIER_ONDEMAND, TIER_RESIDENT } from "./tiers.js";

function isObject(value) {
  return value !== null && typeof value === "object" && Array.isArray(value) === false;
}

function frozenList(list) {
  return Object.freeze(Array.isArray(list) ? list.slice() : []);
}

function frozenMap(value) {
  return Object.freeze(Object.assign({}, isObject(value) ? value : {}));
}

/**
 * 装配计划。
 * @param {object} input
 * @param {string} [input.agentId]
 * @param {string|number} [input.revision] 策略版本（同一个 revision 内计划可记忆化）
 * @param {boolean} [input.frozen] PTC 冻结
 * @param {boolean} [input.takeover] 技能接管
 * @param {string[]} [input.takenOver] 被接管的宿主工具名（恒为关闭）
 * @param {boolean} [input.passthrough] 收窄豁免
 * @param {Array<{name:string, description?:string, own?:boolean, decision:object}>} [input.tools]
 * @param {Map<string,object>} [input.visible]
 * @param {Set<string>} [input.own]
 * @param {Map<string,object>} [input.provenance]
 * @param {string[]} [input.upstreamHidden]
 * @param {Array<{name:string, summary?:string}>} [input.sections]
 * @param {Object<string,object>} [input.sectionDecisions]
 * @param {Array<object>} [input.skills] 技能行（含 tier / modelInvocable / shadowed）
 * @param {Array<object>} [input.skillsVisible]
 * @param {Array<{code:string,message:string}>} [input.warnings]
 */
export function buildPlan(input) {
  const source = isObject(input) ? input : {};
  const frozen = source.frozen === true;
  const passthrough = source.passthrough === true;
  const takenOver = Array.isArray(source.takenOver) ? source.takenOver.slice() : [];
  const takenOverSet = new Set(takenOver);
  const own = source.own instanceof Set ? source.own : new Set();
  const provenance = source.provenance instanceof Map ? source.provenance : new Map();
  const visible = source.visible instanceof Map ? source.visible : new Map();

  const resident = [];
  const ondemand = [];
  const off = [];
  const deny = [];
  const preset = new Set();
  const tiers = {};
  const toolDecisions = {};

  for (const row of Array.isArray(source.tools) ? source.tools : []) {
    const name = typeof row.name === "string" ? row.name : "";
    if (name.length === 0) continue;
    const decision = isObject(row.decision) ? row.decision : decideTool({ name, tier: TIER_ONDEMAND });
    toolDecisions[name] = decision;
    // preset 不是层值，而是「身份」：策略没点名、只有宿主 preset 在供的常驻工具。
    // 引擎只按层值出桶（resident），这条身份由命中链的理由保留下来，UI 靠它单独打标。
    const bucket = decision.bucket === "resident" && decision.reason === REASONS.PRESET
      ? "preset"
      : decision.bucket;
    // 归层表与执行面必须同源：被接管的工具强制关闭（宿主 skill 工具在 gate 接管下永不可见）。
    const tier = takenOverSet.has(name) ? TIER_OFF : decision.tier;
    tiers[name] = tier;
    if (row.own === true || decision.bucket === "own") {
      resident.push(name);
      continue;
    }
    if (tier === TIER_OFF || decision.bucket === "off") {
      off.push(name);
      deny.push(name);
      continue;
    }
    if (bucket === "preset") {
      preset.add(name);
      resident.push(name);
      continue;
    }
    if (decision.bucket === "resident") {
      resident.push(name);
      continue;
    }
    ondemand.push({ name, description: row.description });
    deny.push(name);
  }

  // ── 段落 ──────────────────────────────────────────────────────────────────
  const sectionKeep = [];
  const sectionRemoved = [];
  const sectionCatalog = [];
  const sectionProtected = [];
  const sectionTiers = {};
  const sectionDecisions = {};
  const givenDecisions = isObject(source.sectionDecisions) ? source.sectionDecisions : {};
  for (const section of Array.isArray(source.sections) ? source.sections : []) {
    const name = typeof section.name === "string" ? section.name : "";
    if (name.length === 0) continue;
    const decision = isObject(givenDecisions[name])
      ? givenDecisions[name]
      : decideSection({ name, tier: TIER_ONDEMAND, passthrough });
    sectionDecisions[name] = decision;
    sectionTiers[name] = decision.tier;
    if (decision.protected === true) sectionProtected.push(name);
    if (passthrough === true || decision.removed !== true) {
      sectionKeep.push(name);
      continue;
    }
    sectionRemoved.push(name);
    if (decision.catalog === true) sectionCatalog.push({ name, summary: section.summary });
  }

  // ── 技能 ──────────────────────────────────────────────────────────────────
  const skillRows = Array.isArray(source.skills) ? source.skills.slice() : [];
  const skillResident = [];
  const skillCatalog = [];
  const skillSearchable = [];
  const skillOff = [];
  const skillNotInvocable = [];
  const skillTiers = {};
  for (const row of skillRows) {
    const name = typeof row.name === "string" ? row.name : "";
    if (name.length === 0) continue;
    const decision = decideSkill({
      name,
      tier: row.tier,
      modelInvocable: row.modelInvocable,
      shadowed: row.shadowed,
    });
    skillTiers[name] = decision.tier;
    if (decision.tier === TIER_OFF || decision.reason === REASONS.SHADOWED) skillOff.push(name);
    if (decision.notInvocable === true) skillNotInvocable.push(name);
    if (decision.resident === true) skillResident.push(name);
    if (decision.catalog === true) skillCatalog.push(name);
    if (decision.loadable === true) skillSearchable.push(name);
  }

  return Object.freeze({
    agentId: typeof source.agentId === "string" ? source.agentId : undefined,
    revision: source.revision,
    frozen,
    takeover: source.takeover === true,
    takenOver: frozenList(takenOver),
    passthrough,
    // 工具（扁平键保持 0.5.7 形状：下游七个派生点只读这些键）
    resident: frozenList(resident),
    ondemand: frozenList(ondemand),
    off: frozenList(off),
    deny: frozenList(deny),
    preset,
    own,
    visible,
    provenance,
    upstreamHidden: frozenList(source.upstreamHidden),
    tiers: frozenMap(tiers),
    tools: Object.freeze({
      resident: frozenList(resident),
      ondemand: frozenList(ondemand),
      off: frozenList(off),
      deny: frozenList(deny),
      tiers: frozenMap(tiers),
      decisions: Object.freeze(toolDecisions),
    }),
    // 段落
    sections: Object.freeze({
      keep: frozenList(sectionKeep),
      removed: frozenList(sectionRemoved),
      catalog: frozenList(sectionCatalog),
      protected: frozenList(sectionProtected),
      tiers: frozenMap(sectionTiers),
      decisions: Object.freeze(sectionDecisions),
    }),
    // 段落正文映射（加载口与尾块共用；由调用方在装配/加载时填）
    sectionBodies: source.sectionBodies instanceof Map ? source.sectionBodies : new Map(),
    // 技能
    skills: Object.freeze(skillRows),
    skillsVisible: frozenList(source.skillsVisible || []),
    skillsPlan: Object.freeze({
      resident: frozenList(skillResident),
      catalog: frozenList(skillCatalog),
      searchable: frozenList(skillSearchable),
      off: frozenList(skillOff),
      notInvocable: frozenList(skillNotInvocable),
      tiers: frozenMap(skillTiers),
    }),
    warnings: frozenList(source.warnings),
    axis: AXES,
  });
}

/** 计划里某条段落的决策（没有就返回 undefined，调用方按「未知段落」处理）。 */
export function sectionDecisionOf(plan, name) {
  const decisions = plan && plan.sections ? plan.sections.decisions : undefined;
  if (decisions === undefined || decisions === null) return undefined;
  return Object.prototype.hasOwnProperty.call(decisions, name) ? decisions[name] : undefined;
}

/** 计划里某个工具的层值（没有就返回 undefined）。 */
export function toolTierOf(plan, name) {
  const tiers = plan && plan.tiers ? plan.tiers : undefined;
  if (tiers === undefined || tiers === null) return undefined;
  return Object.prototype.hasOwnProperty.call(tiers, name) ? tiers[name] : undefined;
}

/** 计划的历史稳定指纹：用来做「同 agent + 同 revision + 同会话状态只算一次」的记忆化键。 */
export function planStamp(parts) {
  const list = Array.isArray(parts) ? parts : [];
  return list.map((part) => {
    if (part instanceof Set) return [...part].sort().join(",");
    if (Array.isArray(part)) return part.join(",");
    if (part instanceof Map) return [...part.keys()].sort().join(",");
    return part === undefined || part === null ? "" : String(part);
  }).join("\u0001");
}
