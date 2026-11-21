/**
 * 归层决策引擎（0.6.0 工单 #03 · 规格 D4 + D5）。
 *
 * 这个文件是「一个名字此刻落哪一层」的**唯一**实现：工具、段落、技能三条轴都从这里出结论。
 * 上层（gate 的规划器、能力视图、面板、加载口）只读结论，不许自己再拼一遍判断 ——
 * 以前 planFor / tierMap / planSections / load 各写一遍，于是同一件事有四种答案（B20/B22/B24）。
 *
 * 依赖纪律（D4/领域层）：只依赖 lib/tiers.js 与标准库，不 import 宿主、不读 ctx、不认识 agent。
 * 输入是纯值：轴、名字、策略层值、四个维度的显式状态（已加载 / 冻结 / 上游隐藏 / 保护 + 例外）。
 *
 * 真值表（规格 §D4）：
 *   工具  0→关闭（进摘除集）｜2+未加载→按需｜2+已加载+未冻结→常驻｜2+已加载+冻结→仍按需（声明走尾块）
 *         1→常驻｜保护→常驻且绝不进摘除集
 *   段落  0→摘除、不进目录、不可加载（section-off）｜2→摘除、进目录、可加载｜1→保留、不进目录
 *         受保护→保留、不进目录、可加载｜收窄豁免（passthrough）→一律保留、摘除集为空
 *   技能  0→关闭（skill-off）｜2→进目录、可加载｜1→不进目录、可加载（常驻正文走独立段落）
 *         模型不可调用→不进目录、不可加载（not-invocable）
 *
 * 硬纪律：显式关闭高于一切；已加载只能把「按需」抬成「常驻」，永不能把「关闭」抬成可见；
 * 冻结只影响「是否抬升」；三个被动过滤（不可调用 / 上游隐藏 / 保护）只在引擎里做。
 */
import { TIER_OFF, TIER_ONDEMAND, TIER_RESIDENT } from "./tiers.js";

/** 三条轴。字符串常量而不是 enum：纯 JS 模块，别引入编译期形状。 */
export const AXES = Object.freeze({ TOOL: "tool", SECTION: "section", SKILL: "skill" });
export const AXIS_LIST = Object.freeze([AXES.TOOL, AXES.SECTION, AXES.SKILL]);

/**
 * 拒绝理由与落层理由的唯一词表。
 * 前五个是「为什么不能给你」（规格 D4 的失败原因枚举），后几个是「为什么落这一层」。
 */
export const REASONS = Object.freeze({
  // 拒绝理由（唯一枚举，加载口/转发口/快照共用）
  OFF: "off",
  NOT_INVOCABLE: "not-invocable",
  UNKNOWN: "unknown",
  UPSTREAM_HIDDEN: "upstream-hidden",
  EVICTED: "evicted",
  // 落层理由
  OWN: "own",
  LOADED: "loaded",
  FROZEN_LOADED: "frozen-loaded",
  PROMOTED: "promoted",
  PRESET: "preset",
  PROTECTED: "protected",
  EXCEPTION: "exception",
  CAPABILITY: "capability",
  DEFAULTS: "defaults",
  RESIDENT_GROUP: "resident-group",
  TAKEN_OVER: "taken-over",
  SHADOWED: "shadowed",
  GATE_SECTION: "gate-section",
  PASSTHROUGH: "passthrough",
  INVALID_TIER: "invalid-tier",
});

const BUCKET_RESIDENT = "resident";
const BUCKET_ONDEMAND = "ondemand";
const BUCKET_OFF = "off";

function bucketOf(tier) {
  if (tier === TIER_OFF) return BUCKET_OFF;
  if (tier === TIER_RESIDENT) return BUCKET_RESIDENT;
  return BUCKET_ONDEMAND;
}

/**
 * 层值原语（D5）：只认 0 / 1 / 2 三个**数字**。
 * null / undefined / "" / "0" / false / [] / {} / NaN / 1.5 一律非法 —— 不做任何"看起来像"的归一，
 * 归一化只有 normalizeTier 一份（读策略时用），这里只回答"这个值合法吗"。
 * @returns {{ok:true, tier:0|1|2} | {ok:false, reason:string, value:unknown}}
 */
export function parseTier(value) {
  if (value === TIER_OFF) return { ok: true, tier: TIER_OFF };
  if (value === TIER_RESIDENT) return { ok: true, tier: TIER_RESIDENT };
  if (value === TIER_ONDEMAND) return { ok: true, tier: TIER_ONDEMAND };
  return { ok: false, reason: REASONS.INVALID_TIER, value };
}

/** 严格层值 → 数字；非法时退回调用方给的兜底（兜底本身也必须合法）。 */
export function tierOr(value, fallback) {
  const parsed = parseTier(value);
  if (parsed.ok === true) return parsed.tier;
  const base = parseTier(fallback);
  return base.ok === true ? base.tier : TIER_ONDEMAND;
}

function isObject(value) {
  return value !== null && typeof value === "object" && Array.isArray(value) === false;
}

function freezeRecord(record) {
  return Object.freeze(record);
}

/**
 * 工具轴决策。
 * @param {{name?:string, tier?:unknown, loaded?:boolean, frozen?:boolean, own?:boolean,
 *   protected?:boolean, upstreamHidden?:boolean, unknown?:boolean, takenOver?:boolean}} state
 */
export function decideTool(state) {
  const input = isObject(state) ? state : {};
  const name = typeof input.name === "string" ? input.name : "";
  const parsed = parseTier(input.tier);
  // 非法层值不改变行为：按按需处理并留一个可解释的理由（D5「非法输入无副作用」）。
  const tier = parsed.ok === true ? parsed.tier : TIER_ONDEMAND;
  const reasonOfTier = parsed.ok === true ? undefined : REASONS.INVALID_TIER;
  const protectedName = input.protected === true;
  const own = input.own === true;
  const loaded = input.loaded === true;
  const frozen = input.frozen === true;
  // 命中链的理由码（own/preset/protected/unknown/exception/capability/defaults）由调用方给，
  // 引擎只在「已加载 / 冻结」这两处覆盖它 —— 那是本引擎独有的知识。
  const policyReason = typeof input.reason === "string" && input.reason.length > 0 ? input.reason : undefined;

  const base = {
    axis: AXES.TOOL,
    name,
    tier,
    bucket: bucketOf(tier),
    reason: reasonOfTier !== undefined ? reasonOfTier : policyReason,
    removalReason: undefined,
    removed: false,
    catalog: false,
    loadable: true,
    resident: false,
    protected: protectedName,
    frozenLoaded: false,
    loaded,
    invalidTier: parsed.ok !== true,
    warnings: Object.freeze([]),
  };
  // 1) 保护名单：常驻且绝不进摘除集（哪怕策略写了 0 —— 保护是用户自己加的最后一道锁）。
  if (protectedName) {
    return freezeRecord(Object.assign({}, base, { tier: TIER_RESIDENT, bucket: BUCKET_RESIDENT, resident: true, reason: REASONS.PROTECTED }));
  }
  // 2) own 层（restrict 管不到，宿主语义：永远在工具表里）。
  if (own) {
    return freezeRecord(Object.assign({}, base, { tier: TIER_RESIDENT, bucket: BUCKET_RESIDENT, resident: true, reason: REASONS.OWN }));
  }
  // 3) 上游已隐藏：转不出去，但层值不变（能力视图仍要显示它的档位），只能在执行面拒绝。
  if (input.upstreamHidden === true) {
    return freezeRecord(Object.assign({}, base, { reason: REASONS.UPSTREAM_HIDDEN, loadable: false }));
  }
  // 4) 显式关闭高于一切：已加载、冻结、技能激活都不能把它抬回来（B21/B20 的结构性修法）。
  if (tier === TIER_OFF) {
    return freezeRecord(Object.assign({}, base, {
      removed: true,
      // 工具轴的 reason 保持命中链口径（面板要显示「哪条能力把它关了」），拒绝理由单独给。
      removalReason: REASONS.OFF,
    }));
  }
  // 5) 已加载：只把「按需」抬成「常驻」；冻结下不抬（改工具表会断前缀缓存），声明走尾块。
  if (loaded) {
    if (frozen) {
      return freezeRecord(Object.assign({}, base, {
        tier: TIER_ONDEMAND, bucket: BUCKET_ONDEMAND, resident: false, reason: REASONS.FROZEN_LOADED, frozenLoaded: true,
      }));
    }
    return freezeRecord(Object.assign({}, base, { tier: TIER_RESIDENT, bucket: BUCKET_RESIDENT, resident: true, reason: REASONS.LOADED }));
  }
  if (tier === TIER_RESIDENT) {
    return freezeRecord(Object.assign({}, base, { resident: true, reason: base.reason || REASONS.CAPABILITY }));
  }
  return freezeRecord(Object.assign({}, base, { reason: base.reason || REASONS.CAPABILITY }));
}

/**
 * 段落轴决策。
 * @param {{name?:string, tier?:unknown, loaded?:boolean, frozen?:boolean, protected?:boolean,
 *   upstreamHidden?:boolean, passthrough?:boolean, gateSection?:boolean}} state
 */
export function decideSection(state) {
  const input = isObject(state) ? state : {};
  const name = typeof input.name === "string" ? input.name : "";
  const parsed = parseTier(input.tier);
  const tier = parsed.ok === true ? parsed.tier : TIER_ONDEMAND;
  const protectedName = input.protected === true;
  const loaded = input.loaded === true;
  const frozen = input.frozen === true;
  const policyReason = typeof input.reason === "string" && input.reason.length > 0 ? input.reason : undefined;
  const base = {
    axis: AXES.SECTION,
    name,
    tier,
    bucket: bucketOf(tier),
    reason: parsed.ok === true ? policyReason : REASONS.INVALID_TIER,
    removalReason: undefined,
    removed: false,
    catalog: false,
    loadable: true,
    protected: protectedName,
    frozenLoaded: false,
    invalidTier: parsed.ok !== true,
    warnings: Object.freeze([]),
  };
  // 收窄豁免（D4 的 M 矩阵第 7 行）：不摘、不进目录、摘除集为空。
  if (input.passthrough === true) {
    return freezeRecord(Object.assign({}, base, { removed: false, catalog: false, loadable: true, reason: REASONS.PASSTHROUGH }));
  }
  // gate 自己注入的常驻技能段落：没有档位可配，永远不摘。
  if (input.gateSection === true) {
    return freezeRecord(Object.assign({}, base, { removed: false, catalog: false, loadable: true, protected: true, reason: REASONS.GATE_SECTION }));
  }
  // 保护优先于一切（D4 段落真值第 4 行：保留、不进目录、可加载）。
  if (protectedName) {
    return freezeRecord(Object.assign({}, base, { removed: false, catalog: false, loadable: true, reason: REASONS.PROTECTED }));
  }
  // 上游兜底：段落已经不在系统提示词里，必须进目录，否则连名字都没了。
  if (input.upstreamHidden === true) {
    return freezeRecord(Object.assign({}, base, {
      removed: true, catalog: true, loadable: false, reason: REASONS.UPSTREAM_HIDDEN, removalReason: REASONS.UPSTREAM_HIDDEN,
    }));
  }
  // 关闭：显式关闭高于已加载（与工具轴一致）：摘除 + 进目录（名字要能查到）+ **不可加载**（B22：以前 load 不看档位，关闭段落照样取正文）。
  if (tier === TIER_OFF) {
    return freezeRecord(Object.assign({}, base, {
      removed: true, catalog: true, loadable: false, reason: REASONS.OFF, removalReason: REASONS.OFF,
    }));
  }
  // 已加载：非冻结下留在系统提示词里；冻结下继续留在目录（正文走尾块），与工具同一条纪律。
  if (loaded) {
    if (frozen) {
      return freezeRecord(Object.assign({}, base, { removed: true, catalog: true, loadable: true, reason: REASONS.FROZEN_LOADED, frozenLoaded: true }));
    }
    return freezeRecord(Object.assign({}, base, { removed: false, catalog: false, loadable: true, reason: REASONS.LOADED }));
  }
  // 常驻：不摘、不进目录。
  if (tier === TIER_RESIDENT) {
    return freezeRecord(Object.assign({}, base, { removed: false, catalog: false, loadable: true, reason: base.reason || REASONS.CAPABILITY }));
  }
  // 按需：摘除 + 进目录 + 可加载。
  return freezeRecord(Object.assign({}, base, {
    removed: true, catalog: true, loadable: true, reason: base.reason || REASONS.CAPABILITY,
  }));
}

/**
 * 技能轴决策。
 * @param {{name?:string, tier?:unknown, modelInvocable?:boolean, shadowed?:boolean,
 *   residentGroup?:boolean}} state
 */
export function decideSkill(state) {
  const input = isObject(state) ? state : {};
  const name = typeof input.name === "string" ? input.name : "";
  const parsed = parseTier(input.tier);
  const tier = parsed.ok === true ? parsed.tier : TIER_ONDEMAND;
  const modelInvocable = input.modelInvocable !== false;
  const shadowed = input.shadowed === true;
  const policyReason = typeof input.reason === "string" && input.reason.length > 0 ? input.reason : undefined;
  const base = {
    axis: AXES.SKILL,
    name,
    tier,
    bucket: bucketOf(tier),
    reason: parsed.ok === true ? policyReason : REASONS.INVALID_TIER,
    removalReason: undefined,
    // removed = 「gate 的目录/正文/加载口都不给」，与工具的摘除集同义。
    removed: false,
    catalog: false,
    loadable: true,
    resident: false,
    notInvocable: modelInvocable === false,
    protected: false,
    frozenLoaded: false,
    invalidTier: parsed.ok !== true,
    warnings: Object.freeze([]),
  };
  if (shadowed) {
    return freezeRecord(Object.assign({}, base, {
      removed: true, catalog: false, loadable: false, reason: REASONS.SHADOWED, removalReason: REASONS.SHADOWED,
    }));
  }
  // 显式关闭优先于「模型不可调用」：两个理由都成立时报最外层那个（用户意图）。
  if (tier === TIER_OFF) {
    return freezeRecord(Object.assign({}, base, {
      removed: true, catalog: false, loadable: false, reason: REASONS.OFF, removalReason: REASONS.OFF,
    }));
  }
  // 模型不可调用：不进目录、不可 gate_load（宿主 tool-skill 同口径）。
  if (modelInvocable !== true) {
    return freezeRecord(Object.assign({}, base, {
      removed: true, catalog: false, loadable: false, reason: REASONS.NOT_INVOCABLE, removalReason: REASONS.NOT_INVOCABLE,
    }));
  }
  if (tier === TIER_RESIDENT) {
    return freezeRecord(Object.assign({}, base, { removed: false, catalog: false, loadable: true, resident: true, reason: base.reason || REASONS.CAPABILITY }));
  }
  return freezeRecord(Object.assign({}, base, {
    removed: false, catalog: true, loadable: true, reason: base.reason || REASONS.CAPABILITY,
  }));
}

/**
 * 唯一入口（D4）：按轴分派。
 * @param {"tool"|"section"|"skill"} axis
 * @param {string} name
 * @param {object} state
 */
export function decide(axis, name, state) {
  const input = Object.assign({}, isObject(state) ? state : {});
  if (typeof name === "string" && input.name === undefined) input.name = name;
  if (axis === AXES.SECTION) return decideSection(input);
  if (axis === AXES.SKILL) return decideSkill(input);
  if (axis === AXES.TOOL) return decideTool(input);
  // 未知轴不猜：返回一个明确不可用的记录，调用方看得见原因。
  return freezeRecord({
    axis: String(axis),
    name: typeof name === "string" ? name : "",
    tier: TIER_ONDEMAND,
    bucket: BUCKET_ONDEMAND,
    reason: REASONS.UNKNOWN,
    removed: true,
    catalog: false,
    loadable: false,
    resident: false,
    protected: false,
    frozenLoaded: false,
    invalidTier: false,
    warnings: Object.freeze([]),
  });
}

/** 拒绝理由是否属于规格枚举（测试与快照自检用）。 */
export const FAILURE_REASONS = Object.freeze([
  REASONS.OFF, REASONS.NOT_INVOCABLE, REASONS.UNKNOWN, REASONS.UPSTREAM_HIDDEN, REASONS.EVICTED,
]);
