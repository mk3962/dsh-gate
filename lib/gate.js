/**
 * 闸门核心。
 *
 * 宿主硬约束（读源码确认，别绕）：
 *  - tools.restrict() 必须在一个 **有 agent scope 的 ctx** 上调用，否则直接抛错（dsh-tools :2994）。
 *    正确做法照抄 dsh-ops：agent.ctx.plugin({inject:["tools"], apply(scoped){...}}) 拿到 scoped ctx，再 scoped.tools.restrict()。
 *  - restrict 只过滤“继承的全局工具”，插件自己这一层注册的豁免；多条 restriction 取交集；返回 disposer。
 *  - 被 deny 的工具从 view 消失 → 不进 SDK 声明、也不能被调用（UNKNOWN_TOOL）。
 *  - system-prompt/assemble 的 context.scope 就是 agent。
 */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { tierForSection, resolveTier, policyStamp, TIER_OFF, TIER_ONDEMAND, TIER_RESIDENT } from "./policy.js";
import { capabilityState, resolveSectionDecision, resolveSkillDecision, resolveToolDecision } from "./capabilities.js";
// D4/D5：归层决策的唯一实现（工具 / 段落 / 技能三条轴）。
import { decideSection, decideTool, REASONS } from "./decide.js";
// D7：把三条轴的决策装配成一份不可变计划，下游七个派生点只读它。
import { buildPlan, planStamp, sectionDecisionOf } from "./planner.js";
import { computeSurface, isSectionUpstreamHidden } from "./upstream.js";
import { renderCatalog, estimateTokens, firstSentence } from "./catalog.js";
import {
  SKILL_ORIGIN_HOST,
  GATE_SKILL_SECTION_PREFIX,
  getHostSkill,
  listHostSkills,
  snapshotHostSkills,
  makeSkill,
  mergeSkills,
  renderSkillContent,
  residentSkillSections,
  scanImports,
  skillCatalogEntry,
} from "./skills.js";
import { createRestriction, MODE_LIMITED, MODE_NONE, MODE_PASSTHROUGH } from "./restriction.js";
import { familyToolNames, pickPromotable, pickPromotableBatch, skillFamiliesOf, skillFamilyOf } from "./activation.js";
// D9/D10：转发禁令、结果规范化与「内层已计入」标记的唯一实现（零依赖，护栏也读它）。
import { COUNTED_MARK, isGateToolName } from "./normalize.js";
import { createMcpManager } from "./mcp.js";
// D14：宿主适配层 —— 执行器判定、视图读取、隔离派发只经这一层（领域层不得出现宿主形状）。
import { createHostAdapter } from "./host-adapter.js";

/** PTC 传输名：PTC 执行器的 describe() 只投影这一条声明 —— 也是「是不是 PTC」的语义判据。 */
const RUN_CODE_NAME = "run_code";

/** 资源有界（D20）：告警去重集合、agent 条目表、转发回执的上限。 */
export const WARNED_LIMIT = 200;
export const AGENT_ENTRY_LIMIT = 64;
export const AGENT_ENTRY_TTL_MS = 30 * 60 * 1000;
export const RELAY_RECEIPT_LIMIT = 32;

/**
 * 目录渲染选项（0.4.1）：skillGroups 只在策略显式打开时才为 true。
 * 单独抽出来是为了让「哪些键会改目录字节」只有一处 —— 每多一个 true 都是一次前缀失效。
 */
const catalogOptionsOf = (policy) => {
  const catalog = (policy && policy.catalog) || {};
  return {
    groupByPlugin: catalog.groupByPlugin !== false,
    maxDescriptionLength: catalog.maxDescriptionLength || 64,
    // 严格 === true：写 "true" 字符串、1、分号都不要当成打开。
    skillGroups: catalog.skillGroups === true,
    // 0.5.1 票 01：签名摘要配置原文传下去，归一在 lib/catalog.js（唯一真源）。
    signatureSummary: catalog.signatureSummary,
  };
};

/**
 * gate_status 工具的输出键 —— 唯一清单。
 * lib/proxy.js 的 output.schema 属性集必须与它逐项一致（additionalProperties:false，
 * 多一个键真机会报 ToolCallError，少一个键模型就永远看不到）。
 * 键集在 0.1.7 定稿后不得变化：工具声明一变，宿主的前缀缓存就从那一刻起失效。
 */
export const STATUS_KEYS = [
  "enabled", "visible", "resident", "onDemand", "off", "gated", "passthrough", "catalogTokens",
  "policyFile", "residentNames", "onDemandNames", "offNames", "loaded", "ownNames", "presetNames",
  "catalogChars", "sections", "skills",
];

/**
 * 段落的内在保护集：这两段承载**全部工具签名**（tools:sdk）或 PTC 专有声明，
 * 被摘掉模型就看不到任何工具怎么调 —— 比省下的 token 严重得多。
 * 用户策略的 protected 名单可以追加保护（同一份集合同时保护工具名与段落名）。
 */
export const INTRINSIC_PROTECTED_SECTIONS = Object.freeze(["tools:sdk", "tools:ptc-only"]);

/**
 * 从快照里取出 gate_status 的 18 个键 —— 纯函数，不碰任何内部状态。
 * 工具执行与 schema 都从这一处取，键集漂移就只有一个地方可漂。
 */
/** 「这个 agent 没有限制」的只读形状 —— 三态里的 none，别处都用 MODE_NONE 这个常量。 */
const NO_RESTRICTION = Object.freeze({ mode: MODE_NONE, key: undefined, count: 0 });

export function pickStatus(source) {
  const out = {};
  for (const key of STATUS_KEYS) out[key] = source[key];
  return out;
}

export function createGate(options) {
  const ctx = options.ctx;
  const logger = options.logger;
  const policy = options.policy;
  // D20 资源上限：都可按实例调小（测试用），缺省给生产值。
  const entryTtlMs = Number.isFinite(options.entryTtlMs) && options.entryTtlMs > 0 ? options.entryTtlMs : AGENT_ENTRY_TTL_MS;
  const entryLimit = Number.isFinite(options.entryLimit) && options.entryLimit > 0 ? Math.floor(options.entryLimit) : AGENT_ENTRY_LIMIT;
  const entries = new Map(); // agent -> entry
  // MCP 自挂：gate.json 里声明的 server 由 gate 自己 ctx.plugin(mcp-client) 挂上去。
  // 外部（宿主 loader 行里已有的）只观察，绝不 dispose —— manager 负责这条纪律。
  const manager = createMcpManager({ ctx, logger });
  // D14：同一插件实例一个适配器（能力探测与退化告警都按实例去重）。
  const host = createHostAdapter(ctx, { logger });

  const warn = (message) => {
    try { logger?.warn?.("dsh-gate: " + message); } catch { /* 忽略 */ }
  };

  /**
   * 技能接管开关（0.3.0 工单 14）：缺省 true。
   * takeover=false 是逃生门 —— 完整退回 0.1.8 宿主行为（宿主 skill 工具、宿主目录、gate_load 转发）。
   * 策略整体禁用（enabled:false）时也一律不接管：否则宿主工具被藏了，没人补目录。
   */
  const skillsTakeover = () => policy.enabled !== false && !(policy.skills && policy.skills.takeover === false);

  /** 导入路径的相对基准：策略文件所在目录（没配策略文件时用进程 cwd）。 */
  const policyBaseDir = () => {
    const file = policy.policyFile;
    return typeof file === "string" && file.length > 0 ? path.dirname(file) : undefined;
  };

  /** 告警去重：同一件事每个 agent 只写一次日志（pre-step 每一步都会走到这里）。 */
  const warnOnce = (entry, key, message) => {
    if (entry === undefined || entry === null) { warn(message); return; }
    if (entry.warned.has(key)) return;
    entry.warned.add(key);
    // D20：告警去重集合有界 —— 录入目录/宿主技能每步都可能带新键，集合不能无限长。
    while (entry.warned.size > WARNED_LIMIT) {
      const oldest = entry.warned.values().next();
      if (oldest.done === true) break;
      entry.warned.delete(oldest.value);
    }
    warn(message);
  };

  /**
   * D20：空闲 TTL 回收 + 孤儿对账。条目对应的 agent 已经不可达（ctx 没了）也一并清掉，
   * 否则多会话进程里条目表只增不减。
   */
  const sweepIdleEntries = () => {
    const now = Date.now();
    const stale = [];
    for (const [agent, entry] of entries) {
      const orphan = agent === null || agent === undefined || agent.ctx === undefined || agent.ctx === null;
      const idle = now - (Number(entry && entry.touchedAt) || 0) > entryTtlMs;
      if (orphan || idle) stale.push([agent, entry]);
    }
    for (const [agent, entry] of stale) {
      entries.delete(agent);
      clearSettle(entry);
      try { entry.restriction.destroy(); } catch { /* 已失效 */ }
      try { Promise.resolve(entry.fiber?.dispose?.()).catch(() => {}); } catch { /* 清场失败不影响新条目 */ }
    }
  };

  /** D20：条目表满时按最近活跃时间淘汰最久没动过的一个（同步摘表，dispose 异步收尾）。 */
  const enforceEntryLimit = (keep) => {
    while (entries.size >= entryLimit) {
      let victim;
      let oldest = Infinity;
      for (const [agent, entry] of entries) {
        if (agent === keep) continue;
        const touched = Number(entry && entry.touchedAt) || 0;
        if (touched < oldest) { oldest = touched; victim = agent; }
      }
      if (victim === undefined) break;
      const entry = entries.get(victim);
      entries.delete(victim);
      clearSettle(entry);
      try { entry.restriction.destroy(); } catch { /* 已失效 */ }
      try { Promise.resolve(entry.fiber?.dispose?.()).catch(() => {}); } catch { /* 同上 */ }
    }
  };

  /** 内部：拿到该 agent 的条目（不存在就建）。对外只给「挂载完成」的 promise。 */
  /** 派生自限制窗口关信号的**单次防抖调度**：全进程最多 SETTLE_TIMER_CAP 个待跑定时器。 */
  const SETTLE_TIMER_CAP = 8;
  const settleTimers = new Map();
  /** 闸门整体是否已卸载（卸载后不再安排任何定时器，C36）。 */
  let disposed = false;
  /** 被吞异常的计数与最近样本（D20 / C48；诊断端点读这里，不参与判定）。 */
  const swallowed = { count: 0, samples: [] };
  const noteSwallowed = (where, error) => {
    swallowed.count += 1;
    swallowed.samples.push({ where, at: Date.now(), message: String((error && error.message) || error) });
    while (swallowed.samples.length > 16) swallowed.samples.shift();
  };
  /** 诊断投影（只读；供 #06 诊断端点读，不进 gate_status 的 18 键）。 */
  const diagnosticsView = () => ({
    swallowed: { count: swallowed.count, samples: swallowed.samples.slice(-8).map((row) => ({ ...row })) },
  });
  /** 本轮要重算一次的 agent（窗口关 / 限制落地后）。同名请求合并成一次（已释放标志 + 句柄）。 */
  const scheduleSettle = (agent) => {
    if (disposed) return false;
    const entry = entries.get(agent);
    if (entry === undefined || entry.disposed === true) return false;
    if (entry.settleTimer !== undefined) return false;    // 已有一次待跑：合并
    if (settleTimers.size >= SETTLE_TIMER_CAP) return false; // 并发上限：宁可晚一轮，也不堆定时器
    const timer = setTimeout(() => {
      if (entry.settleTimer !== timer) return;
      entry.settleTimer = undefined;
      settleTimers.delete(agent);
      if (disposed || entry.disposed === true) return;
      try { reapply(agent); } catch (error) { noteSwallowed("settle", error); }
    }, 0);
    try { timer.unref?.(); } catch { /* 宿主无 unref 时忽略 */ }
    entry.settleTimer = timer;
    settleTimers.set(agent, timer);
    return true;
  };
  const clearSettle = (entry) => {
    if (entry === undefined || entry.settleTimer === undefined) return;
    try { clearTimeout(entry.settleTimer); } catch { /* 忽略 */ }
    settleTimers.delete(entry.agent);
    entry.settleTimer = undefined;
  };

  const ensureEntry = (agent) => {
    if (!agent || !agent.ctx) return undefined;
    const existing = entries.get(agent);
    if (existing !== undefined) return existing;
    sweepIdleEntries();
    enforceEntryLimit(agent);
    const entry = {
      agent,
      scoped: undefined,
      fiber: undefined,
      loaded: new Set(),
      // 技能激活放出的工具（0.5.4）：这些名字在 planFor 里按常驻处理，不再被 deny。
      // 与 loaded 分开记 —— loaded 是「模型要过什么」，promoted 是「技能门控把谁放进了工具表」。
      promoted: new Set(),
      // 已经**投递过签名**的名字（0.4.0 增量投递）：与 loaded 分开记 —— loaded 是「能用什么」，
      // emitted 是「模型已经被告知过什么」。同一个工具只投递一次，此前的留在原处不重发。
      emitted: new Set(),
      // 技能表（宿主 + 导入，含 shadowed）：由 prestep 的 refreshSkills 维护，目录/正文/加载三处都读它。
      skills: [],
      // 已告警过的键（导入目录缺失、同名遮蔽、常驻正文超长……），避免每步刷屏。
      warned: new Set(),
      // 常驻技能正文缓存（name → content）：宿主技能的正文只在 ctx.skills.get，装配是同步路径，
      // 这里缓存住，保证同策略下每次装配拿到逐字节相同的正文。
      skillBodies: new Map(),
      sections: [],
      // 段落正文（只给尾部声明用；不参与目录渲染，所以不会动 gate-catalog 的字节）。
      // sectionTexts = 加载那一刻定格的那一份（尾部声明必须逐字节稳定）；
      // sectionInventory = 最近一次装配拿到的原文，只在加载/首次取正文时抄一份。
      sectionTexts: new Map(),
      sectionInventory: new Map(),
      // 执行器判定结果（{kind: "ptc"|"native"|"unknown", reason}）：判据一次算清，快照/日志都读它。
      executor: undefined,
      // 计划缓存（D7 记忆化）：epoch 由任何「会改归层输入」的状态变更推进，
      // 键 = epoch + 策略指纹 + 冻结 + 豁免 + 上一轮限制形状 + 视图规模。
      planEpoch: 0,
      planCache: undefined,
      // 这个 agent 身上“当前被限制成什么样”的唯一真源（见 lib/restriction.js）。
      restriction: undefined,
      catalogText: "",
      ready: undefined,
      // 最近一次“活着”的时间：状态接口在多会话进程里靠它挑出真正的活跃 agent。
      touchedAt: Date.now(),
      // 已加载集合是在哪个策略 revision 下清点过的（D20：revision 变更时清理已消失名字）。
      loadedRevision: policy.version,
      // 防抖重算的定时器句柄（C31/C36：窗口关后只跑一次；卸载时全部清掉）。
      settleTimer: undefined,
      /** 窗口是否打开（开窗口期间限制被摘除，重算只登记待生效目标）。 */
      windowOpen: false,
      /** 已淘汰的段落名（C43：后续加载返回 evicted，而不是 unknown）。 */
      evictedSections: new Set(),
      /** 条目是否已卸载（卸载后不再安排定时器）。 */
      disposed: false,
    };
    entry.restriction = createRestriction({
      restrict(filter) {
        const tools = entry.scoped && entry.scoped.tools;
        if (!tools) throw new Error("dsh-gate: scoped tools 不可用");
        return tools.restrict(filter);
      },
      logger,
    });
    // 窗口开/关信号驱动单次防抖调度（C31）：**删除二十次五毫秒轮询猜窗口**，
    // 窗口关后落地的目标由 restriction 自己施加，这里只负责「状态变了，重算一次」。
    entry.offWindowOpen = entry.restriction.onWindowOpen(() => { entry.windowOpen = true; });
    entry.offWindowClose = entry.restriction.onWindowClose(() => {
      entry.windowOpen = false;
      scheduleSettle(agent);
    });
    entries.set(agent, entry);
    try {
      entry.fiber = agent.ctx.plugin({
        inject: ["tools"],
        apply(scoped) { entry.scoped = scoped; },
      });
    } catch (error) {
      warn("挂载 scoped ctx 失败 — " + String((error && error.message) || error));
    }
    entry.ready = Promise.resolve(entry.fiber).then(() => {
      reapply(agent);
      return entry;
    }).catch((error) => {
      warn("初始化失败 — " + String((error && error.message) || error));
      return entry;
    });
    return entry;
  };

  const scopedToolsOf = (agent) => {
    const entry = entries.get(agent);
    if (entry && entry.scoped && entry.scoped.tools) return entry.scoped.tools;
    return undefined;
  };

  /**
   * 这个 agent 身上**带 when 的注册**（conditional registration）。
   *
   * 宿主 view(agent).registrations 保留 when 字段（restriction 只影响 visible），所以这里是
   * 「哪些工具不声明就不可执行」的唯一判据（0.5.4 · 上游票 B2）。宿主形状变化时退化成空集
   * —— 等于回到 0.5.3 行为，不会把别的工具误放出来。
   */
  const conditionalNamesOf = (agent) => {
    const out = new Set();
    /**
     * 必须读**全局视图**（不带 scope）：aggregate `view(agent)` 的 registrations 只覆盖
     * 「restriction 之后仍然可见」的名字 —— 我们刚 deny 掉的工具在那里根本不存在，
     * 于是 conditional 判据永远为空（这是 0.5.4 第一版实测撞上的坑）。全局视图不受任何
     * agent 的 restrict 影响，注册面（含 when）完整。
     */
    const views = [];
    try { views.push(ctx.tools.view?.()); } catch { /* 忽略 */ }
    try { views.push(scopedToolsOf(agent)?.view?.(agent)); } catch { /* 忽略 */ }
    for (const view of views) {
      const registrations = view && view.registrations;
      if (!(registrations instanceof Map)) continue;
      for (const [name, registration] of registrations) {
        if (registration && registration.when !== undefined) out.add(name);
      }
    }
    return out;
  };

  /**
   * 候选集必须是“未被限制过的全局视图”，否则算完 deny 再算一次就会看不见、限制被误撤销（震荡）。
   * view() 不带 scope = 全局视图（restriction 只在 admits() 里生效，view(undefined) 不受 agent 限制影响）。
   */
  const globalView = () => {
    const view = host.toolView(undefined);
    if (view && view.visible instanceof Map) return view;
    return { visible: new Map(), restrictableNames: new Set(), knownNames: new Set() };
  };

  /** 该 agent 自己这一层注册的工具（restrict 管不到，永远常驻）。 */
  const ownNamesOf = (agent) => {
    try {
      const view = ctx.tools.view?.(agent);
      if (view && view.visible instanceof Map) {
        const restrictable = view.restrictableNames instanceof Set ? view.restrictableNames : new Set();
        return new Set([...view.visible.keys()].filter((name) => !restrictable.has(name)));
      }
    } catch { /* 忽略 */ }
    return new Set();
  };

  const visibleOf = (agent) => {
    try {
      const view = ctx.tools.view?.(agent);
      if (view && view.visible instanceof Map) return view.visible;
    } catch (error) {
      warn("读取工具视图失败 — " + String((error && error.message) || error));
    }
    return new Map();
  };

  /** 被委派出去的子代理：宿主在 session.header.origin 上标 "subagent"（其它 provider 的判据同此）。 */
  const isDelegatedChild = (agent) => {
    try { return agent?.session?.header?.origin === "subagent"; } catch { return false; }
  };

  /**
   * 委派收窄豁免（2026-11-01 事故：dsh-mnemon 写记忆恒失败）：
   * 子代理本来只被授予个位数工具时，闸门藏掉它们省不到 token，却会把白名单里的
   * **委派协议工具**（mnemon_subagent_result 之类）一起剥光 —— 子代理再也记不了结果，
   * 父会话抛 "memory subagent completed without recording its result"。
   * 授予数 = 去掉 agent 自己这一层 own 工具后的**真实可见**工具数。主会话 / 宽工具面子代理不受影响。
   *
   * 口径变更（2026-11-14）：以前用 knownNames，理由是「它不受 restriction 影响，重算不震荡」。
   * 但真实宿主的 knownNames 是**注册面**，别人的 restrict({allow}) 只收窄 visible —— 于是白名单
   * 子代理也数出全量 156，豁免永远不触发（生产实测 passthrough 一次都没出现过）。
   * 现在改从 visible 数，并把「上一轮自己 deny 掉的」加回来：自己的 deny 同样躲在 visible 里，
   * 不加回来就恒为 0（自指陷阱）。别人的 allow/deny 造成的收窄留着不动，那才是真实授予面。
   * 也不能用 plan.visible：它是「agent 链 ∪ 全局」的并集，会把全局一百多个工具算进窄子代理的授予数。
   */
  const narrowPassThroughFor = (agent, plan, ourDeny) => {
    const limit = policy.narrowPassThrough;
    if (typeof limit !== "number" || limit <= 0) return false;
    if (!isDelegatedChild(agent)) return false;
    const scoped = scopedViewOf(agent);
    // 真实宿主（2026-11-14 复核，归因见 _scratch/dsh-gate-audit-20261114/CONFLICT-AUDIT.md §3）：
    // 别人的 restrict({allow}) 只收窄 visible，**不改 knownNames** —— 那是注册面。旧实现拿
    // knownNames 数授予数，于是恒等于全量注册（实测 156），narrowPassThrough 永远不触发，
    // 2026-11-01「白名单子代理被剥空」的结构性前提一直在。
    // 正确口径 = 真实可见 + 自己上一轮藏掉的（自己的 deny 也躲在 visible 里，不加回来就恒为 0，
    // 那是自指陷阱）；别人 allow/deny 造成的收窄留着不动，那才是真实授予面。
    if (scoped === undefined || !(scoped.visible instanceof Map)) return false;
    const granted = new Set();
    for (const name of scoped.visible.keys()) if (!plan.own.has(name)) granted.add(name);
    for (const name of Array.isArray(ourDeny) ? ourDeny : []) if (!plan.own.has(name)) granted.add(name);
    return granted.size > 0 && granted.size <= limit;
  };

  /**
   * 该 agent 的完整工具视图：global 层 + 所有**祖先层**（agent preset 注册的工具就在这）。
   * knownNames 不受 restriction 影响，是唯一稳定、不震荡的候选集来源 ——
   * 旧实现只用 view() 全局视图，preset 平面的工具（pwsh/read/write/grep/glob/web_search/skill…）
   * 根本进不了候选集，于是“gate.json 里给它们写层不生效”，面板上也看不到（真误诊来源）。
   */
  const scopedViewOf = (agent) => {
    const view = host.toolView(agent);
    return view && view.knownNames instanceof Set ? view : undefined;
  };

  /**
   * PTC 判据（工单 07 的一条硬前提，见 docs/dsh-gate-0.2.0-03-A原型实验.md §6.1）：
   * 0.2.2 起宿主删掉了「按 agent 设 mode」的配置，所以只能看**选中的执行器**。
   *   1 constructor.name === "PtcExecutor" / "NativeToolExecutor"（当前 dist 的类名）；
   *   2 类名不认识时看 describe().schemas：恰好只有 run_code ⇒ PTC；有条目但不是只有它 ⇒ native；
   *   3 仍不确定（没有执行器 / describe 抛错 / schemas 为空）⇒ fail-open：不冻结、不启用尾部声明，
   *     并记录原因（快照 executor.reason + 第一条 info 日志），行为与 0.1.8 一致。
   * 不再用 view.visible.has("run_code") 兜底：0.2.2 的 view 不含 transport，那条判据恒假
   * （原型 0.1.9-a 就是这么静默失效的）。
   */
  // 判据的唯一实现在 host-adapter.js（D14）；这里只保留「判定结果记账 + 首见日志」这一层。
  const detectExecutor = (agent) => host.detectExecutor(agent);

  /** 判一次执行器并记账（同一次判定不重复写日志：planFor / snapshot 每一步都会问）。 */
  const executorOf = (agent) => {
    const signal = detectExecutor(agent);
    const entry = entries.get(agent);
    if (entry !== undefined) {
      const before = entry.executor;
      if (before === undefined || before.kind !== signal.kind || before.reason !== signal.reason) {
        entry.executor = signal;
        try {
          logger?.info?.(
            "dsh-gate: 执行器判定 " + signal.kind + "（" + signal.reason + "）" +
            (signal.kind === "ptc" ? "，工具表冻结 + 末尾声明" : "，保持 0.1.8 行为"),
          );
        } catch { /* 忽略 */ }
      }
    }
    return signal;
  };

  /**
   * 冻结开关：默认 true（策略键 freezePtcToolset），只对 PTC 生效。
   * 冻结必须**从第一次 gate_load 之前就是真**：如果第一次加载还把工具放回工具表，那一步就已经
   * 把前缀缓存断掉了，之后再冻也补不回来（原型 §4 的降幅正是来自「加载从来没改过工具表」）。
   */
  const freezeFor = (agent) => {
    if (policy.freezePtcToolset === false) return false;
    if (!entries.has(agent)) return false;
    return executorOf(agent).kind === "ptc";
  };

  /**
   * 技能计划（工单 14）：entry.skills 逐条判档。档位解析链只有一份实现（capabilities.js：
   * skill:<name> → skillpack:<provider> → defaults.skillpack），这里只做「可见 / 常驻 / 按需 / 关闭」分组。
   *  - shadowed（被宿主或先声明的导入遮住）永远不可见、不可加载；
   *  - takeover=false 时保留 0.1.8 口径：不看档位、全部列进目录（改写由宿主决定）。
   */
  const planSkillsFor = (agent) => {
    const entry = entries.get(agent);
    const takeover = skillsTakeover();
    const rows = [];
    for (const item of entry ? entry.skills : []) {
      const skill = makeSkill(item);
      if (skill.name.length === 0) continue;
      // 档位（含 skills.off 优先）只有一份实现：capabilities.resolveSkillDecision。
      const decision = resolveSkillDecision(policy, skill);
      // P0（复核 2026-11-14）：组级/默认「常驻」不再等于「全部正文进系统提示词」。
      // 旧 v2 的 skills.tier=1 语义是「保留宿主目录」，迁到 0.3.0 后若照字面执行，
      // 本机 53 个技能 ≈ 78.6k token/次。常驻正文只接受**单技能显式**档位；
      // 组级/默认常驻降级为按需（目录可见、gate_load 可取正文），并给出原因。
      const groupResident = decision.tier === TIER_RESIDENT && decision.single !== true;
      rows.push(Object.assign({}, skill, {
        tier: groupResident ? TIER_ONDEMAND : decision.tier,
        capability: decision.capability,
        capabilityEntry: decision.capabilityEntry,
        reason: groupResident ? "resident-group" : decision.reason,
        single: decision.single === true,
      }));
    }
    rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const visible = rows.filter((row) => !row.shadowed
      && row.modelInvocable !== false
      && (takeover ? row.tier !== TIER_OFF : true));
    return { rows, visible, takeover };
  };

  /**
   * 归层输入 → **一份计划**（D7）。这个函数只做「收集事实上报」，判断全在 decide.js：
   * 以前候选循环自己写一遍 if 链、tierMap 再算一遍 resolveTier、planSections 又判一遍、
   * load 再判一遍 —— 四份答案迟早漂，B20/B22/B24 全是这个结构的后果。
   *
   * 记忆化（D7「同 agent+revision+会话状态只算一次」）：键 = epoch + 策略指纹 + 冻结 +
   * 豁免 + 上一轮限制形状 + 视图规模。epoch 只由真正会改归层的状态变更推进
   * （加载 / 技能激活 / 段落清单 / 技能表），所以同一次 HTTP 请求里
   * snapshot → capabilityView → planSections 拿到的是同一个冻结对象。
   */
  const planFor = (agent) => {
    const entry = entries.get(agent);
    const frozen = freezeFor(agent);
    const current = entry ? entry.restriction.state() : NO_RESTRICTION;
    const own = ownNamesOf(agent);
    // 收窄豁免必须在建计划之前定：它改变段落真值（D4 第 7 行：一律保留、摘除集为空）。
    // 判据要拿「上一轮自己藏掉的」补回真实授予面（见 narrowPassThroughFor 注释）。
    const passthrough = entry !== undefined
      && narrowPassThroughFor(agent, { own }, current.deny);
    const loaded = entry ? entry.loaded : new Set();
    const global = globalView();
    const scoped = scopedViewOf(agent);
    const known = scoped !== undefined && scoped.knownNames instanceof Set ? scoped.knownNames : new Set();
    // D20：策略 revision 变了就清理已加载集合里已经消失的名字（含段落键）——
    // 否则旧名字会永远占着「常驻」，尾部声明也会带一条不存在的工具。
    if (entry !== undefined && entry.loadedRevision !== policy.version) {
      const knownTools = known instanceof Set ? known : new Set();
      const sectionKeys = new Set((entry.sections || []).map((section) => "section:" + section.name));
      let pruned = false;
      for (const name of [...entry.loaded]) {
        const alive = name.startsWith("section:") ? sectionKeys.has(name) : (knownTools.has(name) || own.has(name));
        if (alive === false) { entry.loaded.delete(name); pruned = true; }
      }
      entry.loadedRevision = policy.version;
      if (pruned === true) entry.planEpoch += 1;
    }
    // 工具面的**成员**（不只是规模）也进键：别人的 restrict/撤销会让 known−visible 变，
    // 只比 size 时「藏 A 放 B」会命中旧计划，上游隐藏就永远是上一轮的答案。
    const visibleKeys = scoped !== undefined && scoped.visible instanceof Map
      ? [...scoped.visible.keys()].sort().join(",")
      : "";
    /**
     * knownNames 的**稳定指纹**（0.7.2）：以前键里只有 known.size —— 插件卸载一个工具、
     * 同时注册另一个同前缀工具时规模不变，成员却换了，旧计划会被原样命中：
     * 上游隐藏集合、候选定义（description）、canInvoke 全是上一轮的答案。
     * 用排序后成员串的 sha1 前 16 位（规模已单独进键，这里只要区分「同规模不同成员」）。
     * 定长是为了不让键随工具数增长（几十上百个名字拼进缓存键本身也是开销）。
     */
    const knownNames = scoped !== undefined && scoped.knownNames instanceof Set
      ? [...scoped.knownNames].sort().join(",")
      : "";
    const knownKey = knownNames.length === 0
      ? ""
      : createHash("sha1").update(knownNames).digest("hex").slice(0, 16);
    const stamp = planStamp([
      entry === undefined ? -1 : entry.planEpoch,
      policyStamp(policy),
      frozen ? 1 : 0,
      passthrough ? 1 : 0,
      current.mode,
      current.count,
      own.size,
      visibleKeys,
      known.size,
      knownKey,
      global.visible.size,
    ]);
    if (entry !== undefined && entry.planCache !== undefined && entry.planCache.stamp === stamp) {
      return entry.planCache.plan;
    }
    const skillPlan = planSkillsFor(agent);
    const takeover = skillPlan.takeover;
    /**
     * 上游已隐藏 / 可用候选 / 来源标注只有一个出口（lib/upstream.js）。
     * 判定口径：known − visible − own − 自己 deny；own 不算被上游藏。
     */
    const surface = computeSurface({
      knownNames: known,
      visible: scoped !== undefined && scoped.visible instanceof Map ? scoped.visible : new Map(),
      own,
      ourDeny: Array.isArray(current.deny) ? current.deny : [],
      skills: entry ? entry.skills : [],
      sections: entry ? entry.sections : [],
      globallyVisible: global.visible,
    });
    const upstreamHidden = new Set(
      surface.upstreamHidden instanceof Set ? [...surface.upstreamHidden] : Array.isArray(surface.upstreamHidden) ? surface.upstreamHidden : [],
    );
    // 候选集 = 注册过的 ∪ 全局可见，减掉上游藏起来的（knownNames 不受限制影响，重算不震荡）。
    const candidates = new Map();
    for (const name of surface.usable) {
      const definition = scoped !== undefined ? scoped.visible.get(name) : undefined;
      candidates.set(name, definition ?? global.visible.get(name));
    }
    const promoted = entry ? entry.promoted : undefined;
    const protectedName = (name) => (policy.protectedNames instanceof Set && policy.protectedNames.has(name));
    const tools = [];
    for (const [name, definition] of candidates.entries()) {
      let decision;
      if (own.has(name)) {
        // own 层（restrict 管不到）永远在工具表里。它不进候选循环的档位判断。
        decision = decideTool({ name, tier: TIER_RESIDENT, own: true, reason: REASONS.OWN });
      } else if (takeover && name === "skill") {
        // 技能接管（工单 14）：宿主 skill 工具**无条件** deny —— 即使用户把它设成常驻。
        // 这是 B 案的前提：tool-skill 的目录 pre-step 靠可见性判据，工具一旦不可见，
        // 宿主就不再生成目录，gate 才有唯一的技能入口。
        decision = decideTool({ name, tier: TIER_OFF, reason: REASONS.TAKEN_OVER });
      } else {
        // 命中链只回答「策略给了哪一层」，已加载/冻结/保护怎么改写交给引擎。
        const base = resolveToolDecision(policy, name, {
          own: false,
          globallyVisible: global.visible.has(name),
          loaded: false,
        });
        if (promoted !== undefined && promoted.has(name) && base.bucket !== "off") {
          // 技能激活放出的工具按常驻；显式关闭的照样落到下面那条（绝不被激活绕过）。
          decision = decideTool({ name, tier: TIER_RESIDENT, reason: REASONS.PROMOTED });
        } else {
          decision = decideTool({
            name,
            tier: base.tier,
            reason: base.reason,
            loaded: loaded.has(name),
            frozen,
            protected: protectedName(name),
            upstreamHidden: upstreamHidden.has(name),
          });
        }
      }
      tools.push({ name, description: definition && definition.description, own: own.has(name), decision });
    }
    // 段落：与工具同一条引擎、同一份 upstreamHidden。受保护集 = 内在保护 ∪ 策略名单。
    const sectionRows = entry ? entry.sections || [] : [];
    const sectionDecisions = {};
    const sectionUpstreamHidden = new Set();
    for (const section of sectionRows) {
      const name = section.name;
      if (typeof name !== "string" || name.length === 0) continue;
      const hidden = isSectionUpstreamHidden(name, { knownNames: known, upstreamHidden: surface.upstreamHidden });
      if (hidden === true) sectionUpstreamHidden.add(name);
      const chain = resolveSectionDecision(policy, name);
      sectionDecisions[name] = decideSection({
        name,
        tier: chain.tier,
        reason: chain.reason,
        loaded: loaded.has("section:" + name),
        frozen,
        protected: INTRINSIC_PROTECTED_SECTIONS.includes(name) || protectedName(name),
        upstreamHidden: hidden === true,
        passthrough,
        gateSection: name.startsWith(GATE_SKILL_SECTION_PREFIX),
      });
    }
    const takenOver = takeover
      ? ["skill"].filter((name) => !own.has(name) && candidates.has(name))
      : [];
    const built = buildPlan({
      agentId: String((agent && agent.id) || ""),
      revision: policy.version,
      frozen,
      takeover,
      takenOver,
      passthrough,
      tools,
      visible: candidates,
      own,
      provenance: surface.provenance,
      upstreamHidden: [...upstreamHidden],
      sections: sectionRows,
      sectionDecisions,
      skills: skillPlan.rows,
      skillsVisible: skillPlan.visible,
      warnings: policy.warnings,
    });
    // 段落兜底集与上游隐藏集是计划要用的输入副产物，挂在同一份冻结对象上（不另立第二本账）。
    const plan = Object.freeze(Object.assign({}, built, { sectionUpstreamHidden }));
    if (entry !== undefined) entry.planCache = { stamp, plan };
    return plan;
  };


  /**
   * 段落闸门的判定口：调用方逐段问 shouldDrop，自己决定怎么摘。
   *
   * 答案**只来自计划**（D4 段落真值表）。以前这里把 upstreamHidden / loaded / 档位
   * 又拼了一遍 if 链 —— 那是第三本账：B19/P1-4 里工具轴的 glob 通配顺着 tierForSection
   * 把段落一起关掉，就是这条链绕过引擎自己判档位造成的。
   * 计划里没有的段落（装配早于 recordSections）用同一个引擎按当前策略补算，绝不回退旧 if 链。
   */
  const planSections = (agent) => {
    const entry = entries.get(agent);
    const plan = planFor(agent);
    return {
      shouldDrop(name) {
        if (typeof name !== "string" || name.length === 0) return true;
        // 收窄豁免：摘除集为空（D4 第 7 行）。
        if (plan.passthrough === true) return false;
        const decided = sectionDecisionOf(plan, name);
        if (decided !== undefined) return decided.removed === true;
        const chain = resolveSectionDecision(policy, name);
        return decideSection({
          name,
          tier: chain.tier,
          reason: chain.reason,
          loaded: entry !== undefined && entry.loaded.has("section:" + name),
          frozen: plan.frozen === true,
          protected: INTRINSIC_PROTECTED_SECTIONS.includes(name)
            || (policy.protectedNames instanceof Set && policy.protectedNames.has(name)),
          gateSection: name.startsWith(GATE_SKILL_SECTION_PREFIX),
        }).removed === true;
      },
    };
  };

  /**
   * 重算并应用限制。
   *
   * 两个防回环的硬约束（2026-10-29 真事故）：
   *  1) restrict() 与 disposer 都会发 tools/change；监听者若直接 reapply 就是自激循环，
   *     事件循环被占满 → 整个 web server 卡死（GET / 25s 超时、CPU 打满）。
   *  2) 所以：先把目标形状（模式 + 键）算出来交给限制对象，跟当前**一模一样就一点动作都不做**；
   *     真要动的时候由限制对象自己把 applying 置上，让 tools/change 监听者跳过自己引起的这次事件。
   */
  /** 撤掉当前的 deny 限制（幂等）。 */
  const dropDeny = (entry) => {
    entry.restriction.drop();
  };

  const reapply = (agent) => {
    const entry = entries.get(agent);
    if (entry === undefined) return undefined;
    entry.touchedAt = Date.now();
    const tools = scopedToolsOf(agent);
    // 策略被关掉（gate.json 写 enabled:false / 行 config enabled:false）必须**撤销**已有限制，
    // 否则“关了闸门”只是不再新加限制，已经藏起来的工具永远回不来。
    if (policy.enabled === false) {
      entry.catalogText = "";
      dropDeny(entry);
      return { resident: [], ondemand: [], off: [], deny: [], visible: visibleOf(agent), own: new Set() };
    }
    const plan = planFor(agent);
    // 技能目录（工单 14）：接管时只列**按需**档（常驻正文走系统提示词独立段落、关闭的连名字都不给）；
    // 不接管时保持 0.1.8 口径（宿主名单原样列出，不按档位筛）。
    // P2-11（复核 2026-11-14）：非接管且 skillpack=1 时宿主目录没被摘，gate 再列一遍就是双份
    // （两处描述长度还不同，模型看到两个口径）。只有宿主目录真被摘掉时才补列。
    const skillTier = policy.skills && policy.skills.tier !== undefined ? policy.skills.tier : policy.defaults.skillpack;
    const listSkills = plan.takeover ? true : skillTier !== TIER_RESIDENT;
    const catalogSkills = plan.skills
      .filter((row) => !row.shadowed && (plan.takeover ? row.tier === TIER_ONDEMAND : listSkills))
      .map((row) => skillCatalogEntry(row, policy.catalog && policy.catalog.maxDescriptionLength));
    entry.catalogText = renderCatalog({
      tools: plan.ondemand,
      skills: catalogSkills,
      // 段落目录直接读计划的 sections.catalog（摘除 + 该进目录），不再另算一遍。
      sections: plan.sections.catalog,
      // 0.5.1 票 01：签名摘要要工具定义的 parameters，冻结与否由 plan.frozen 决定
      //（native 不冻结 ⇒ 渲染层不出摘要行，目录字节与 0.4.1 逐字节相同）。
      frozen: plan.frozen,
      definitions: plan.visible,
    }, catalogOptionsOf(policy));
    // scoped tools 拿不到（agent 还没就绪 / plugin 挂载失败 / 刚热重载完 entry 还是新的）：
    // **保持原样返回 plan，绝不 drop**。撤销等于把全部工具放出来一次 —— 那一步的
    // tools:sdk 会渲染成全量声明（实测 147 个工具 / 162,551 字符 vs 正常 31 个 / 45,245），
    // 前缀缓存从那一刻断掉两跳（cacheRead 199,552 → 2,048 → 6,144，命中 0.9% / 3.1%）。
    // 代价对比：留着一条撤得掉的 deny 只是「暂时多藏了几个工具」，而撤销是「一次性放全表
    // + 两跳缓存全废」。恢复路径是有保证的：entry.scoped 一就绪就会走下面的正常 reapply 分支重算。
    // 从没限制过（MODE_NONE，没有句柄）时 drop 本来就是空操作，行为不变。
    if (tools === undefined) return plan;
    let restrictable = null;
    try {
      const view = tools.view?.(agent);
      if (view && view.restrictableNames instanceof Set) restrictable = view.restrictableNames;
    } catch { /* 忽略 */ }
    const deny = restrictable === null ? plan.deny : plan.deny.filter((name) => restrictable.has(name));
    // 目标形状算出来交给限制对象：它自己比模式与键，相同就什么都不做（幂等由所有权保证，
    // 调用方不再比较键或句柄 —— 那句隐式判据在收窄豁免分支上是错的）。
    // 豁免判定要拿「上一轮自己藏掉的」补回真实可见面（见 narrowPassThroughFor 注释）。
    const before = entry.restriction.state();
    // 豁免标志由计划给（唯一一次判定），这里只翻成限制形状。
    const target = plan.passthrough === true
      ? { mode: MODE_PASSTHROUGH, deny: [] }
      : { mode: deny.length > 0 ? MODE_LIMITED : MODE_NONE, deny };
    if (target.mode === MODE_PASSTHROUGH && before.mode !== MODE_PASSTHROUGH) {
      try {
        logger?.info?.("dsh-gate: 子代理工具面过窄（<=" + policy.narrowPassThrough + "），跳过闸门以免剥掉委派协议工具");
      } catch { /* 忽略 */ }
    }
    entry.restriction.apply(target);
    return plan;
  };

  /** 是否有任何 agent 正在应用限制（此时 tools/change 是自己引起的，别跟着重算）。 */
  const isApplying = () => {
    for (const entry of entries.values()) if (entry.restriction.isApplying()) return true;
    return false;
  };

  /**
   * 启动时自挂 gate.json 里声明的 MCP server（0.3.0 工单 15）。
   * 只跑一次（幂等）：重复调用返回同一个 promise —— 插件 apply 与 UI 保存都可能走到这里。
   * 多个 server **并发** mount（mount 会等初始连接，串行会把启动时间叠成 N 倍）。
   * 失败只 warn、不抛：一个 MCP server 连不上不该让闸门或宿主启动失败。
   * @returns {Promise<{mounted: object[], failed: object[]}>}
   */
  let mcpStart;
  const startMcp = () => {
    if (mcpStart !== undefined) return mcpStart;
    mcpStart = (async () => {
      const servers = policy.mcp && policy.mcp.servers && typeof policy.mcp.servers === "object"
        ? policy.mcp.servers
        : {};
      const names = Object.keys(servers).sort().filter((name) => servers[name] && servers[name].enabled !== false);
      const results = await Promise.all(names.map(async (name) => {
        try {
          return await manager.mount(name, servers[name]);
        } catch (error) {
          return { ok: false, name, reason: "exception", message: String((error && error.message) || error) };
        }
      }));
      const mounted = [];
      const failed = [];
      for (const result of results) {
        if (result.ok) mounted.push(result);
        else {
          failed.push(result);
          warn("MCP server " + result.name + " 未挂载（" + result.reason + "）— " + String(result.message || ""));
        }
      }
      return { mounted, failed };
    })();
    return mcpStart;
  };

  /** 重算全部已挂 agent：挂/卸 MCP 后工具面与段落计划都变了，限制必须跟着刷新。 */
  const reapplyAll = () => {
    let count = 0;
    for (const agent of [...entries.keys()]) {
      try { reapply(agent); count += 1; }
      catch (error) { warn("重算 agent 失败 — " + String((error && error.message) || error)); }
    }
    return count;
  };

  /**
   * 段落正文取一份：优先取加载时定格的副本；没有就从最近一次装配的原文抄一份并存下。
   * 为什么要在这里定格：尾部声明是消息的一部分，正文一变前缀缓存就从那条消息断掉；
   * 首次装配若没取到正文，尾部会出现「本次装配没有取到」的占位，下一次又变成正文 —— 同一处抖动两次。
   */
  const sectionTextOf = (entry, name) => {
    const stored = entry.sectionTexts.get(name);
    if (typeof stored === "string" && stored.length > 0) return stored;
    const latest = entry.sectionInventory.get(name);
    if (typeof latest === "string" && latest.length > 0) {
      entry.sectionTexts.set(name, latest);
      return latest;
    }
    return "";
  };

  const load = async (agent, names) => {
    const entry = ensureEntry(agent);
    if (entry === undefined) return { loaded: [], unknown: [] };
    await entry.ready;
    const wanted = (Array.isArray(names) ? names : [names]).map((n) => String(n || "").trim()).filter(Boolean);
    // 校验必须对“未被限制的全局视图”，否则第二层的名字永远认不出来。
    const plan = planFor(agent);
    const visible = plan.visible;
    const off = new Set(plan.off);
    const knownSections = new Set((entry.sections || []).map((section) => section.name));
    const accepted = [];
    const unknown = [];
    const denied = [];
    const evicted = [];
    for (const name of wanted) {
      if (name.startsWith("section:")) {
        const bare = name.slice("section:".length);
        // C43：被库存淘汰的段落名字是对的，只是正文被回收 —— 报 evicted，
        // 不报 unknown（否则模型会去 gate_search 换名字，永远换不到）。
        if (bare.length > 0 && entry.evictedSections !== undefined && entry.evictedSections.has(bare)) {
          evicted.push(name);
          continue;
        }
        // 段落名必须真实出现在当前装配清单里：不存在的名字收下只会让尾部永远是一段占位，
        // 模型还以为自己已经加载了什么（0.2.0 缺陷批修 I5-6）。
        if (bare.length === 0 || !knownSections.has(bare)) { unknown.push(name); continue; }
        // 可加载性由计划给（D4 段落真值：关闭段落 removed + catalog + **不可加载**）。
        // 0.5.7 这里只校验名字存在，于是「关闭的段落」照样能从加载口取正文（B22/P1-6）。
        const decided = sectionDecisionOf(plan, bare);
        if (decided !== undefined && decided.loadable === false) { denied.push(name); continue; }
        if (decided === undefined) {
          const chain = resolveSectionDecision(policy, bare);
          const fallback = decideSection({ name: bare, tier: chain.tier, reason: chain.reason, loaded: false, frozen: plan.frozen === true });
          if (fallback.loadable === false) { denied.push(name); continue; }
        }
        sectionTextOf(entry, bare);
        entry.loaded.add(name);
        entry.planEpoch += 1;
        accepted.push(name);
        continue;
      }
      // off 不收：否则模型会看到「已加载」，转头 gate_invoke 又被拒，白转一圈。
      if (off.has(name)) { denied.push(name); continue; }
      if (!visible.has(name)) { unknown.push(name); continue; }
      entry.loaded.add(name);
      entry.planEpoch += 1;
      accepted.push(name);
    }
    reapply(agent);
    // 0.4.0：增量投递。render 里用 deltaTextFor 取「本次真正要投递的签名」；
    // 这里不预先记账 —— 投递与否由 deltaTextFor 自己判（entry.emitted 为唯一真源）。
    return { loaded: accepted, unknown, denied, evicted };
  };

  /**
   * 走宿主执行管线（0.2.x）—— gate_invoke / gate_call / gate_load(skill) 唯一的转发口。
   *
   * 不能再交 tools.execute({name,…})：0.2.x 的 execute 是**批量委派**，缺 calls 就在内部报
   * "Tool batch execution failed"（工单 01）。批量输入里也没有 parent，而 PTC 的「只能直调
   * run_code」reject 只能靠自建 pipeline（空 options ⇒ source:{}，内部来源）绕开。
   * 目标工具的参数校验、pre/post-execute、输出校验仍在管线上 —— 所以 gate_invoke 自己不校验参数。
   *
   * 宿主版本没有 /pipeline 导出（0.1.x）时退化为旧的单调用 tools.execute：PTC 下那条路会被
   * 拒，但那是旧宿主的既有行为，不能因此把整个插件带崩（fail-soft）。
   */
  let pipeline;
  let pipelineApi; // undefined = 还没探测；null = 该宿主没有这个导出
  const pipelineApiOf = async () => {
    if (pipelineApi !== undefined) return pipelineApi;
    try {
      const mod = await import("@deepseek-ai/dsh-tools/pipeline");
      pipelineApi = typeof mod.executeToolBatch === "function" && typeof mod.ToolExecutionPipeline === "function" ? mod : null;
    } catch { pipelineApi = null; }
    return pipelineApi;
  };

  const errorResult = (text) => ({
    content: [{ type: "text", text: "Error: " + (text || "目标工具执行失败") }],
    isError: true,
  });

  /**
   * 宿主批量委派失败（0.3.3 生产体检）：`Tool batch execution failed` 是 tools.execute
   * 批量入口缺 calls 时的通用报错。生产日志里它在 gate_call / gate_load(skill) / gate_invoke
   * 上共出现 95 次（2026-11-06 ~ 11-14），且**同一个调用重试一次就能成** —— 说明是宿主侧
   * 瞬时状态（管线在 PTC 步里被复用/并发时拿不到），不是参数错或工具不存在。
   *
   * 判据收窄到这条固定文案（不能把真正的工具报错也重试：那会让副作用执行两次）。
   */
  const BATCH_FAILURE = /tool batch execution failed/i;

  const callThroughOnce = async (tools, agent, name, payload, signal, toolSet) => {
    // 0.5.4（上游票 B2 执行面）：conditional 注册（带 when 的工具）只能经 step admission 执行。
    // 宿主 executable() 在 toolSet === undefined 时对它们一律返回 undefined（dsh-tools:531-535），
    // 所以只有 caller 明确要求时才把 toolSet 塞进批量输入；非 conditional 工具保持 0.5.3 语义
    // （不带 toolSet ⇒ 不吃 step 的 admit 快照，gate 放在 ondemand 的工具仍可转发）。
    const step = toolSet === undefined ? {} : { toolSet };
    const api = await pipelineApiOf();
    if (api === null) {
      // 旧宿主：保持 0.1.x 的单调用语义（含它自己的 UNKNOWN_TOOL / 参数校验）。
      try {
        return await tools.execute({ callId: randomUUID(), name, agent, arguments: payload, signal, ...step });
      } catch (error) {
        return errorResult(String((error && error.message) || error));
      }
    }
    if (pipeline === undefined) pipeline = new api.ToolExecutionPipeline(ctx, {});
    const batch = await api.executeToolBatch(
      { calls: [{ id: randomUUID(), name, arguments: JSON.stringify(payload) }], agent, signal, ...step },
      pipeline,
      () => 1,
    );
    const first = batch && Array.isArray(batch.results) ? batch.results[0] : undefined;
    const result = first && first.result;
    if (result === undefined) return errorResult("目标工具没有返回结果（" + name + "）");
    return result;
  };

  const textOfResult = (result) => {
    const content = result && Array.isArray(result.content) ? result.content : [];
    let text = "";
    for (const part of content) if (part && part.type === "text" && typeof part.text === "string") text += part.text;
    return text;
  };

  /**
   * @param {string} [toolSet] 调用方所在这一步的 admission（PTC 里就是 exec.toolSet）。
   *   只在目标是 conditional 注册时才往下传：那是这类工具唯一的执行入口。
   */
  /**
   * 「内层执行已计入」标记（C40）：转发结果盖一个不可枚举符号。
   * 护栏看到它就不再推进时钟 —— 一次转发只记一次（内层那次才是真的执行）。
   */
  const markCounted = (result) => {
    if (result === null || typeof result !== "object") return result;
    try { Object.defineProperty(result, COUNTED_MARK, { value: true, enumerable: false, configurable: true }); }
    catch { /* 冻结结果：标记不上就靠闸门工具族排除兜底 */ }
    return result;
  };
  /** 取消计数（C47：已取消的调用不重试，但让诊断看得见「发生过几次」）。 */
  const cancels = { before: 0, retry: 0 };
  const aborted = (signal) => Boolean(signal && signal.aborted === true);

  /**
   * 转发入口的**闸门族拒绝**（C32 / P2-5）：proxy 层已按同一份判据抛错，这里再挡一次 ——
   * 别的调用方（gate_load 的逃生门、测试、未来的直连）也走同一条路，不能只靠入口自觉。
   */
  const refuseGateTarget = (name) => {
    if (!isGateToolName(name)) return undefined;
    const error = new Error("dsh-gate: " + name + " 属于闸门工具族，不能作为转发目标（gate-tool-not-forwardable）");
    error.code = "gate-tool-not-forwardable";
    return error;
  };

  const callThrough = async (agent, name, args, signal, toolSet) => {
    const refusal = refuseGateTarget(name);
    if (refusal !== undefined) throw refusal;
    const entry = ensureEntry(agent);
    if (entry === undefined) throw new Error("dsh-gate: 没有可用的 agent 上下文");
    await entry.ready;
    const tools = scopedToolsOf(agent);
    if (tools === undefined) throw new Error("dsh-gate: scoped tools 不可用");
    const payload = args === undefined || args === null ? {} : args;
    // conditional 工具（带 when）没有 step admission 就不可执行：拿不到调用方的 toolSet 时
    // 不假装成功，也不原样抛宿主那句 "unknown tool"（模型会以为名字写错）。
    const conditional = conditionalNamesOf(agent).has(name) || entry.promoted.has(name);
    const stepToolSet = conditional ? toolSet : undefined;
    // 撤限制/恢复限制都会发 tools/change；窗口里 applying 为 true，监听者就不会跟着重算
    // （否则每次转发多触发两轮全量重算）。窗口结束时状态是 none，reapply 重新算目标。
    try {
      const forwarded = await entry.restriction.suspend(async () => {
        let result;
        let thrown = false;
        // C47：进窗口前已取消 ⇒ 目标工具一次都不执行（更不能重试）。
        if (aborted(signal)) {
          cancels.before += 1;
          return errorResult("调用已取消（" + name + " 未被执行，参数没有错）");
        }
        try {
          result = await callThroughOnce(tools, agent, name, payload, signal, stepToolSet);
        } catch (error) {
          // 批量/管线自己抛的错（宿主侧）一律转成 isError 结果；闸门自己的参数错误在 proxy 层就抛了。
          thrown = true;
          result = errorResult(String((error && error.message) || error));
        }
        // 只在「宿主批量通道**抛**了这条固定文案」时重试：那时目标工具根本没被执行，重试不会做两遍副作用。
        // 目标工具自己返回同名字样（isError 结果、不是抛）一律不重试 —— 判据不能只看文本。
        if (thrown && result && result.isError === true && BATCH_FAILURE.test(textOfResult(result))) {
          // C47：重试前先查取消 —— 已取消的调用绝不重试（重试一次也可能是副作用两次）。
          if (aborted(signal)) {
            cancels.retry += 1;
            return errorResult("调用已取消，批量失败未重试（" + name + " 未被执行）");
          }
          try { logger?.warn?.("dsh-gate: 宿主批量委派失败，重试一次 —— " + name); } catch { /* 忽略 */ }
          try {
            const retried = await callThroughOnce(tools, agent, name, payload, signal, stepToolSet);
            if (!(retried && retried.isError === true && BATCH_FAILURE.test(textOfResult(retried)))) return retried;
            result = retried;
          } catch (error) {
            const detail = String((error && error.message) || error);
            // 重试抛的还是同一条批量失败：按「通道不可用」交回（不是参数错）。
            if (BATCH_FAILURE.test(detail)) {
              return errorResult("宿主执行通道暂时不可用（" + name + " 未被执行，参数没有错；重试同一次调用即可）");
            }
            // 重试时抛了别的东西：那是真实错误，原样交回。
            return errorResult(detail);
          }
          // 还是同一条批量失败：把「不是你的参数错」说清楚，别让模型去改参数。
          return errorResult("宿主执行通道暂时不可用（" + name + " 未被执行，参数没有错；重试同一次调用即可）");
        }
        // 转发目标既可能是「本步已认出的 conditional」，也可能是「被 0.5.4 放出来、但这步 toolSet
        // 冻结在放行之前的 promoted 工具」—— 两种情况宿主都会回 unknown tool，提示同一句。
        if ((conditional || entry.promoted.has(name)) && result && result.isError === true
          && /unknown tool/i.test(textOfResult(result))) {
          return errorResult(name + " 是受「技能激活」门控的工具（宿主 conditional 注册）："
            + "先 gate_load(\"skill:<名字>\") 激活，然后在**新的一步 / 新的 run_code 程序里**再调用一次 —— "
            + "宿主只在这一步的 admission 里认它。");
        }
        return result;
      });
      return markCounted(forwarded);
    } finally {
      reapply(agent);
    }
  };

  /** 参数表 → 紧凑签名：read({ file_path: string, limit?: number })。声明文本要稳定、小。 */
  const typeOf = (schema) => {
    if (!schema || typeof schema !== "object") return "any";
    if (Array.isArray(schema.type)) return schema.type.join("|");
    if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join("|");
    if (schema.type === "array") return "array<" + typeOf(schema.items) + ">";
    if (schema.type === "object") return "object";
    return typeof schema.type === "string" ? schema.type : "any";
  };

  const signatureOf = (name, definition) => {
    const parameters = definition && definition.parameters;
    const properties = parameters && parameters.properties;
    if (!properties || typeof properties !== "object") return name + "()";
    const required = new Set(Array.isArray(parameters.required) ? parameters.required : []);
    const parts = [];
    for (const [key, value] of Object.entries(properties)) {
      parts.push(key + (required.has(key) ? "" : "?") + ": " + typeOf(value));
    }
    return name + "({ " + parts.join(", ") + " })";
  };

  const SECTION_TEXT_MISSING = "（这段正文本次装配没有取到；下一次装配后会补齐。）";

  /**
   * 已加载能力的声明块 —— pre-step 把它作为**一条 user 消息追加到消息末尾**。
   * 不进系统提示词、不进工具声明：那两个位置一变，前缀缓存就从那里断掉。
   * 文本对同一份加载清单恒定（排序后的名字，没有时间戳/序号），所以可以原地复用、不累积。
   */
  const loadedTextFor = (agent) => loadedBlockFor(agent, undefined);

  /**
   * 声明块渲染器（0.4.0 支持增量）。`only` 为 undefined ⇒ 全量快照（旧行为，测试与调试用）；
   * 传一个名字集合 ⇒ 只渲染这些名字（增量投递）。
   *
   * 为什么要有增量：0.3.x 的做法是「清单一变，追加一条**全量**快照」。会话里加载 n 次，
   * 累计就是 n×(190+110n) 字符 —— 20 次加载约 26,900 字符，而真正的增量只要 190n+110n ≈ 6,000。
   * 差额会永久留在前缀里、此后每个请求都重付一遍。（量化见 .scratch/dsh-gate-尾块增量注入-…/issues/05）
   *
   * 纪律：已投递过的名字**永不重发**，旧块留在原处自然过时；模型靠块内索引行拼全集。
   */
  const loadedBlockFor = (agent, only) => {
    const entry = entries.get(agent);
    if (entry === undefined || entry.loaded.size === 0) return "";
    if (!freezeFor(agent)) return "";
    const plan = planFor(agent);
    const lines = [];
    const sectionBlocks = [];
    const wanted = only instanceof Set ? only : undefined;
    for (const name of [...entry.loaded].sort()) {
      if (wanted !== undefined && !wanted.has(name)) continue;
      if (name.startsWith("section:")) {
        const bare = name.slice("section:".length);
        // 常驻段落本来就在系统提示词里，别再重复一遍（否则同一段文本出现两次）。
        if (tierForSection(policy, bare) === TIER_RESIDENT) continue;
        const text = sectionTextOf(entry, bare);
        sectionBlocks.push(
          "<gate-section name=\"" + bare + "\">\n" +
          (typeof text === "string" && text.length > 0 ? text : SECTION_TEXT_MISSING) +
          "\n</gate-section>",
        );
        continue;
      }
      // 技能正文由 gate_load 的返回值给出，不再重复搬进声明块。
      if (name.startsWith("skill:")) continue;
      const definition = plan.visible.get(name);
      const detail = firstSentence(definition && definition.description, 72);
      lines.push("- " + signatureOf(name, definition) + (detail ? " — " + detail : ""));
    }
    const blocks = [];
    if (lines.length > 0) {
      const head = wanted === undefined
        ? [
          "已加载的能力（工具表已冻结，不要再次 gate_load 同名）：在 run_code 里用 tools.gate_invoke({ tool: \"名字\", arguments: { … } }) 执行。",
          "目标工具的参数校验照旧；参数不对会得到 isError 结果（错误文本），不会静默成功。",
        ]
        : [
          "本次新增的能力（工具表已冻结）：在 run_code 里用 tools.gate_invoke({ tool: \"名字\", arguments: { … } }) 执行。",
          "此前已加载的不再重复列出 —— 看下面这行索引就是全集。",
        ];
      const body = [...head, ...lines];
      const index = wanted === undefined ? "" : loadedIndexLine(entry);
      if (index) body.push(index);
      blocks.push(["<gate-loaded>", ...body, "</gate-loaded>"].join("\n"));
    }
    for (const block of sectionBlocks) blocks.push(block);
    return blocks.join("\n");
  };

  /**
   * 一行名字索引（0.4.0）：`本次会话已加载 3 个：a, b, c`。
   * 增量块必须带它 —— 否则模型要往回翻历史才知道自己一共加载过什么，
   * 那比这一行 40 字符贵得多（体检票 03 已量出绕路率 45.6%）。
   * 只列名字、不列签名，所以不会随加载次数产生 O(n²)。
   */
  const loadedIndexLine = (entry) => {
    const names = [...entry.loaded]
      .filter((name) => !name.startsWith("skill:"))
      .sort();
    if (names.length === 0) return "";
    return "本次会话已加载 " + names.length + " 个：" + names.join(", ");
  };

  /**
   * 增量投递：把**还没投递过**的已加载签名渲染成一块，投递过的永不重发。
   * 返回 { text, fresh } —— fresh 是本次真正投递的名字，工具结果的 render 与 pre-step 都要用。
   */
  const deltaTextFor = (agent, names) => {
    const entry = entries.get(agent);
    if (entry === undefined || entry.loaded.size === 0) return { text: "", fresh: [] };
    if (!freezeFor(agent)) return { text: "", fresh: [] };
    const pool = Array.isArray(names) && names.length > 0 ? names : [...entry.loaded];
    const fresh = [];
    for (const name of pool) {
      if (typeof name !== "string" || name.length === 0) continue;
      if (name.startsWith("skill:")) continue;
      if (name.startsWith("section:")) {
        const bare = name.slice("section:".length);
        if (tierForSection(policy, bare) === TIER_RESIDENT) continue;
      }
      if (!entry.loaded.has(name)) continue;
      if (entry.emitted.has(name)) continue;
      fresh.push(name);
    }
    if (fresh.length === 0) return { text: "", fresh: [] };
    const text = loadedBlockFor(agent, new Set(fresh));
    if (text.length === 0) return { text: "", fresh: [] };
    for (const name of fresh) entry.emitted.add(name);
    return { text, fresh };
  };

  /** 尾部声明（0.4.0 只留索引行）：签名已经在 gate_load 的工具结果里给过了，不再重复。 */
  const indexTextFor = (agent) => {
    const entry = entries.get(agent);
    if (entry === undefined || entry.loaded.size === 0) return "";
    if (!freezeFor(agent)) return "";
    const line = loadedIndexLine(entry);
    if (line === "") return "";
    return "<gate-loaded>\n" + line + "\n签名已在各自的 gate_load 结果里给出；参数不对就用 gate_invoke 试，报错会说明。\n</gate-loaded>";
  };

  /**
   * 状态快照 —— 唯一的状态形状。
   *
   * 面板接口与 gate_status 都从这一份派生：前者只挑字段与补默认值，后者按 STATUS_KEYS 取子集。
   * 以前是三处各拼一遍（status / server 的快照 / proxy 里手抄的 schema），
   * 拼漏一个键就是真机上 additionalProperties 报错或面板一栏永远 0（「关闭」那一栏就是这么丢的）。
   */
  const snapshot = (agent) => {
    if (agent === undefined || agent === null) {
      return {
        enabled: policy.enabled !== false,
        policyFile: policy.policyFile,
        agent: null,
        visible: 0,
        resident: 0,
        onDemand: 0,
        off: 0,
        gated: 0,
        passthrough: false,
        loaded: [],
        catalogChars: 0,
        catalogTokens: 0,
        residentNames: [],
        onDemandNames: [],
        offNames: [],
        ownNames: [],
        presetNames: [],
        sections: [],
        skills: [],
        skillEntries: [],
        tiers: {},
        // 新增的 v3 字段只进快照，不进 STATUS_KEYS（gate_status 的投影字节必须稳定）。
        upstreamHidden: [],
        // PTC 判据与冻结态（工单 07）：UI 靠它解释「为什么加载后工具表没变」。
        executor: { kind: "unknown", reason: "no-agent" },
        frozen: false,
        policyVersion: policy.version,
        warnings: Array.isArray(policy.warnings) ? policy.warnings : [],
        // D20 / C48：被吞异常进计数并保留最近样本（#06 诊断端点从这里读；不进 STATUS_KEYS）。
        diagnostics: diagnosticsView(),
      };
    }
    // 只读：不建条目。快照会被 HTTP 层对「roots() 里但没挂过闸门」的 agent 调用，
    // 用 ensureEntry 会顺手替它注册一个 scoped ctx 并施加限制 —— 读操作不该有这种副作用。
    const entry = entries.get(agent);
    const plan = planFor(agent);
    const restriction = entry ? entry.restriction.state() : NO_RESTRICTION;
    // 只读：executorOf 只在该 agent 已有条目时记账，不会替陌生人建条目。
    const executor = executorOf(agent);
    return {
      enabled: policy.enabled !== false,
      policyFile: policy.policyFile,
      agent: String(agent.id || ""),
      visible: plan.visible.size,
      resident: plan.resident.length,
      onDemand: plan.ondemand.length,
      // 数字，不是数组：面板曾经对数字取 .length，拿到 undefined 后整栏被 JSON 丢掉。
      off: plan.off.length,
      gated: restriction.count,
      passthrough: restriction.mode === MODE_PASSTHROUGH,
      loaded: entry ? [...entry.loaded] : [],
      catalogChars: entry ? entry.catalogText.length : 0,
      catalogTokens: estimateTokens(entry ? entry.catalogText : ""),
      residentNames: plan.resident,
      onDemandNames: plan.ondemand.map((tool) => tool.name),
      offNames: plan.off,
      ownNames: [...plan.own].sort(),
      presetNames: [...plan.preset].sort(),
      diagnostics: diagnosticsView(),
      // 段落 gated 与能力视图同口径（gated = 档位不是常驻），但读计划而不是再查一次策略：
      // 「是否真的被摘掉」是另一件事（loaded 的段落保留），这里保持 0.5.7 的对外语义不变。
      sections: (entry ? entry.sections : []).map((section) => {
        const decided = sectionDecisionOf(plan, section.name);
        const gated = decided !== undefined
          ? decided.tier !== TIER_RESIDENT
          : tierForSection(policy, section.name) !== TIER_RESIDENT;
        return { name: section.name, chars: section.chars, tokens: section.tokens, gated };
      }),
      // 技能（工单 14）：gate 可见 = 宿主 + 导入 − off − shadowed（名字清单，键序/形状不变）。
      skills: plan.skillsVisible.map((skill) => skill.name),
      // provider 是能力视图 skillpack:<provider> 行的唯一来源（prestep 已从 ctx.skills.list 补齐）。
      skillEntries: plan.skillsVisible.map((skill) => ({
        name: skill.name,
        provider: skill.provider,
        description: skill.description,
        origin: skill.origin,
        // 宿主技能没有路径：不带这个键，而不是带一个 undefined（HTTP 序列化会把它丢掉，
        // 于是 /state 与 gate.snapshot 在 deepEqual 下对不上）。
        ...(skill.path === undefined ? {} : { path: skill.path }),
        shadowed: false,
      })),
      // 归层表与执行面同源：计划已经包含「已加载 / 冻结 / 激活 / 接管」的全部改写，
      // 这里不再第二次调用 resolveTier —— tierMap 那份实现就是 P2-1（冻结下谎报常驻）的根源。
      tiers: plan.tiers,
      upstreamHidden: plan.upstreamHidden,
      executor: { kind: executor.kind, reason: executor.reason },
      frozen: entry !== undefined && policy.freezePtcToolset !== false && executor.kind === "ptc",
      // 策略版本与迁移告警：给 UI 的单独查询用（不是 gate_status 的键）。
      policyVersion: policy.version,
      warnings: Array.isArray(policy.warnings) ? policy.warnings : [],
    };
  };

  /**
   * 这个 agent 的工具面（给能力视图用）：名字 + 三种身份，外加段落清单与上游隐藏。
   * 只回答「有哪些成员」，档位与命中链由 capabilities.js 算 —— 解析链只有一份实现。
   */
  const surfaceOf = (agent) => {
    const entry = entries.get(agent);
    const plan = planFor(agent);
    const loaded = entry ? entry.loaded : new Set();
    const global = globalView();
    const provenanceOf = (name) => {
      const prov = plan.provenance instanceof Map ? plan.provenance.get(name) : undefined;
      return prov === undefined
        ? { source: "unknown", confidence: "unknown", via: "unknown" }
        : { source: prov.source, confidence: prov.confidence, via: prov.via };
    };
    const takenOver = plan.takenOver instanceof Set ? plan.takenOver : new Set(plan.takenOver || []);
    const tools = [];
    for (const name of [...plan.visible.keys()].sort()) {
      tools.push({
        name,
        own: plan.own.has(name),
        globallyVisible: global.visible.has(name),
        loaded: loaded.has(name),
        // 冻结（PTC）参与归层：已加载在冻结下仍是按需，能力视图必须与快照同口径（P2-1）。
        frozen: plan.frozen === true,
        // 被 gate 接管的工具（当前只有宿主 skill）：能力视图要用强制档解释「为什么它不在工具表」。
        // undefined 键在 HTTP 层会被丢掉，所以用展开而不是赋值。
        ...(takenOver.has(name) ? { forcedTier: TIER_OFF } : {}),
        takenOver: takenOver.has(name),
        // 成员表里只有可用工具（上游隐藏项不进这里，见 capabilities.test.mjs §7）；
        // 它的来源与「是否被上游藏」以顶层 upstreamHidden / provenance 为准。
        provenance: provenanceOf(name),
        upstreamHidden: false,
      });
    }
    const sections = (entry ? entry.sections : []).map((section) => ({
      name: section.name,
      // 体积与加载态和 gate_status.sections 同源：能力视图不该只给名字，否则对表时缺两列。
      chars: section.chars,
      tokens: section.tokens,
      loaded: loaded.has("section:" + section.name),
      provenance: provenanceOf(section.name),
      upstreamHidden: plan.sectionUpstreamHidden instanceof Set && plan.sectionUpstreamHidden.has(section.name),
    }));
    // 技能：all=含 shadowed（能力视图要说明它被谁遮了），可见性由 shadowed/档位决定。
    const skills = (entry ? entry.skills : []).map((skill) => ({
      name: skill.name,
      provider: skill.provider,
      description: skill.description,
      origin: skill.origin,
      path: skill.path,
      shadowed: skill.shadowed === true,
    }));
    // 来源表转普通对象：HTTP 层要 JSON，Map 序列化会变成 {}。
    const provenance = {};
    for (const name of [...plan.provenance.keys()].sort()) provenance[name] = provenanceOf(name);
    return {
      tools,
      sections,
      skills,
      upstreamHidden: plan.upstreamHidden,
      // 上游隐藏的工具：不进成员表（它们不可用），但要能挂回所属能力行。
      hiddenTools: plan.upstreamHidden,
      provenance,
    };
  };

  /** 能力视图：一个能力一行（成员、档位、例外/偏离、来源置信度）。UI 工单接这里。 */
  const capabilityView = (agent) => capabilityState(policy, surfaceOf(agent));

  /** 当前视图里注册过的全部工具名（v2 迁移判定“悬空键”用；不受限制影响）。 */
  const knownNames = (agent) => {
    const scoped = scopedViewOf(agent);
    if (scoped !== undefined) return new Set(scoped.knownNames);
    return new Set(globalView().knownNames);
  };

  /**
   * gate_invoke 的准入判据（与 gate_load 同一份候选集）：known 且非 upstreamHidden。
   * 只回答「能不能转发」，不校验参数 —— 参数校验留在宿主 defineTool 里，闸门不抄第二份。
   * @returns {{ok: boolean, reason?: "unknown"|"upstream-hidden"}}
   */
  const canInvoke = (agent, name) => {
    const plan = planFor(agent);
    // 「关闭」必须真的关：off 的工具仍在 candidates（只是被 deny），不先拒就会被 gate_invoke 绕过。
    if (plan.off.includes(name)) return { ok: false, reason: "off" };
    if (plan.visible.has(name)) return { ok: true };
    if (plan.upstreamHidden.includes(name)) return { ok: false, reason: "upstream-hidden" };
    return { ok: false, reason: "unknown" };
  };

  /**
   * 记录本轮实际存在的段落清单（名字 + 体积），UI 与 gate_status 直接读它。
   *
   * 已知问题：没记 section.summary，而 catalog.js:48 的段落行会读它 ⇒ 目录里段落行永远没有摘要。
   * 补上会让 gate-catalog 段落字节变化，从该段起前缀缓存失效，所以现在**只记录不修**（README 已知限制同步）。
   */
  /** 段落库存容量（C43：可配；默认 120 与旧的上限一致）。 */
  const sectionLimit = Number.isFinite(options.sectionsLimit) && options.sectionsLimit > 0
    ? Math.min(500, Math.floor(options.sectionsLimit))
    : 120;

  /** 是否是被策略引用 / 在目录里 / 当前已加载的段落（淘汰时的保留优先级）。 */
  const sectionPriority = (agent, entry, name) => {
    // 1) 当前已加载（尾部声明已经引用了它的正文，淘汰会让声明变成悬空 id）。
    if (entry.loaded !== undefined && entry.loaded.has("section:" + name)) return true;
    // 2) 出现在本轮目录里（模型看得见、点得到）。
    try {
      const plan = planFor(agent);
      const catalog = plan && plan.sections ? plan.sections.catalog : undefined;
      if (Array.isArray(catalog)) {
        for (const row of catalog) {
          const rowName = typeof row === "string" ? row : row && row.name;
          if (rowName === name) return true;
        }
      }
    } catch { /* 计划算不出来就不当引用 */ }
    // 3) 策略显式引用（段落配置里点名 / 覆盖）。
    try {
      const sections = policy && policy.sections;
      if (sections && typeof sections === "object") {
        for (const holder of [sections.overrides, sections.paragraphs, sections.names, sections.keep]) {
          if (holder === undefined || holder === null) continue;
          if (Array.isArray(holder) && holder.includes(name)) return true;
          if (!Array.isArray(holder) && typeof holder === "object" && Object.prototype.hasOwnProperty.call(holder, name)) return true;
        }
      }
    } catch { /* 策略形状不熟就当没引用 */ }
    // 4) 常驻段落（策略档位=常驻）：它的正文会进系统提示词，名字不该消失。
    try {
      const chain = resolveSectionDecision(policy, name);
      if (chain && chain.tier === TIER_RESIDENT) return true;
    } catch { /* 忽略 */ }
    return false;
  };

  const recordSections = (agent, inventory) => {
    const entry = entries.get(agent);
    if (entry === undefined) return;
    // 并集而不是覆盖：被摘掉的段落下一次 assemble 就不会再出现在清单里了，
    // 覆盖写会让“可加载的段落”清单逐个消失（目录里也就查不到）。
    const merged = new Map();
    for (const item of entry.sections || []) merged.set(item.name, item);
    let removedNames = [];
    for (const item of Array.isArray(inventory) ? inventory : []) {
      if (!item || typeof item.name !== "string") continue;
      // 段落回来了就解除淘汰标记（自愈；否则重新装配后加载仍报 evicted）。
      if (entry.evictedSections !== undefined && entry.evictedSections.has(item.name)) entry.evictedSections.delete(item.name);
      // 正文单独存：目录渲染只读 name/summary，多带一个 text 会改 gate-catalog 的字节。
      // 这里只更新「最近一次装配的原文」；已加载段落的那一份在 gate_load 时定格，
      // 后续装配改文也不会再动尾部声明（消息字节稳定 = 前缀缓存稳定）。
      merged.set(item.name, { name: item.name, chars: item.chars, tokens: item.tokens });
      if (typeof item.text === "string" && item.text.length > 0) entry.sectionInventory.set(item.name, item.text);
    }
    const all = [...merged.values()].sort((a, b) => b.chars - a.chars);
    // C43：容量可配，优先保留被策略引用 / 在目录 / 已加载；只淘汰孤儿名字。
    let kept = all;
    if (all.length > sectionLimit) {
      const priority = [];
      const orphans = [];
      for (const item of all) {
        if (sectionPriority(agent, entry, item.name)) priority.push(item);
        else orphans.push(item);
      }
      const room = Math.max(0, sectionLimit - priority.length);
      kept = [...priority, ...orphans.slice(0, room)];
      removedNames = orphans.slice(room).map((item) => item.name);
    }
    entry.sections = kept.sort((a, b) => b.chars - a.chars);
    // 正文与清单**同批**淘汰：只删清单会留下正文残影，下次装配又变回占位段落。
    for (const name of removedNames) {
      entry.sectionInventory.delete(name);
      entry.sectionTexts.delete(name);
      if (entry.evictedSections === undefined) entry.evictedSections = new Set();
      entry.evictedSections.add(name);
    }
    if (removedNames.length > 0) {
      noteSwallowed("section-evicted", new Error("段落库存淘汰 " + removedNames.length + " 个孤儿段落: " + removedNames.slice(0, 8).join(", ")));
      try { logger?.warn?.("dsh-gate: 段落库存已满（" + sectionLimit + "），淘汰孤儿段落 —— " + removedNames.slice(0, 8).join(", ")); } catch { /* 忽略 */ }
    }
    entry.planEpoch += 1;
    // 必须重算目录：否则被摘掉的段落虽然“可 gate_load 加载”，目录里却从没出现过它，
    // 模型永远不知道有这段（两者一起才是闭环）。
    reapply(agent);
  };

  /** 技能目录被摘掉后，把技能名记下来，好让 gate 目录列出来（下一次 assemble 生效）。 */
  const rememberSkills = (agent, skills) => {
    const entry = entries.get(agent);
    if (entry === undefined) return;
    const next = (Array.isArray(skills) ? skills : [])
      .map((item) => makeSkill(item))
      .filter((item) => item.name.length > 0);
    // 每一步 pre-step 都会走到这里；名单没变就别重算（否则非 PTC profile 每轮多一次全量 reapply）。
    // 签名覆盖所有会进目录/正文/能力视图的字段（来源、描述、路径、遮蔽），**以及正文的 hash**：
    // P1-4（复核 2026-11-14）发现在导入技能改正文但文件名/描述不变时，旧签名相同就直接 return，
    // 于是 entry.skills 一直留着旧 content，改文件永远不生效、gate_load 却读新文件（两个版本）。
    const signature = (list) => list
      .map((s) => [
        s.name, s.provider || "", s.description || "", s.origin, s.path || "", s.shadowed ? 1 : 0,
        // 宿主技能没有本地正文，hash 恒空；导入技能才有，够用来发现「文件改了」。
        typeof s.content === "string" ? createHash("sha1").update(s.content).digest("hex").slice(0, 12) : "",
      ].join("\u0001"))
      .join("\u0000");
    const before = signature(entry.skills || []);
    const after = signature(next);
    if (before === after && entry.skills.length > 0) return;
    // P2-14：名单空 → 空（宿主没有技能 / 旧宿主查不到）时不值得 reapply，每步都算一遍是白费。
    if (before === after && next.length === 0) {
      entry.skills = next;
      return;
    }
    entry.skills = next;
    entry.planEpoch += 1;
    reapply(agent);
  };

  /**
   * 刷新技能表（prestep 每步调用）：宿主 ctx.skills.list + gate.json 的 skills.imports 扫描。
   * 宿主服务缺失（旧宿主 / 离线 / 单测假宿主）时**不清空**已有名单：prestep 的目录消息兜底路径
   * 还会继续供给（0.1.8 行为），takeover=false 时更是完全靠它。
   */
  const refreshSkills = async (agent, signal, fallback) => {
    const entry = entries.get(agent);
    if (entry === undefined) return [];
    const takeover = skillsTakeover();
    let hostSnapshot;
    try { hostSnapshot = await snapshotHostSkills(ctx, agent, signal); } catch { hostSnapshot = undefined; }
    const imported = takeover
      ? scanImports(policy.skills && policy.skills.imports, { baseDir: policyBaseDir() })
      : { skills: [], warnings: [] };
    for (const warning of imported.warnings) warnOnce(entry, warning.code + ":" + warning.message, warning.message);
    if (hostSnapshot === undefined && !takeover) return entry.skills;
    // P2-6（复核 2026-11-14）：名字清单是部分结果时不能覆盖 last-good。
    // 宿主 provider 发现超时/被 abort 会给出 complete=false 的部分名单，照收会让技能先消失再回来
    // （两次改字节 = 两次断缓存，常驻正文还会凭空消失一轮）。这里保留上次宿主名单并记一次告警。
    const hostIncomplete = hostSnapshot !== undefined && hostSnapshot.complete === false;
    if (hostIncomplete) {
      warnOnce(entry, "skill-snapshot-incomplete", "宿主技能名单这次不完整（发现未完成），沿用上一份可用名单");
    }
    // 宿主服务缺失（旧宿主 / 假宿主 / 单测）时：优先用本轮目录消息里的 entries，
    // 其次保留已有名单 —— 绝不能因为查不到宿主就把技能表清空。
    const hostRows = hostSnapshot === undefined || hostIncomplete
      ? (Array.isArray(fallback) && fallback.length > 0
        ? fallback
        : (entry.skills || []).filter((item) => item.origin !== "import"))
      : hostSnapshot.skills;
    const fallbackHost = hostRows;
    const merged = mergeSkills(fallbackHost, imported.skills);
    for (const warning of merged.warnings) warnOnce(entry, warning.code + ":" + warning.message, warning.message);
    rememberSkills(agent, merged.skills);
    // P1（复核 2026-11-14）：常驻正文缓存必须能失效。每步 pre-step 回查一次常驻技能的正文
    // （只有显式单技能常驻才在这里，数量很小），正文变了才换缓存 —— 改 SKILL.md 下一步生效，
    // 没变则装配字节不动（前缀缓存不抖）。
    await refreshResidentBodies(agent, signal);
    return entry.skills;
  };

  /**
   * 首步兜底（P1-2）：宿主是「先 assemble 后 pre-step」，第一轮装配时 pre-step 还没跑过，
   * 技能表是空的 —— 第一轮没目录/正文，第二轮 system prompt 又变一次，前缀缓存必断。
   * 装配钩子在渲染目录前调用这里：名单为空就先刷一次，之后每步由 pre-step 维护。
   */
  const ensureSkills = async (agent, signal) => {
    const entry = entries.get(agent);
    if (entry === undefined || entry.skills.length > 0) return;
    try { await refreshSkills(agent, signal); } catch { /* 首步失败不阻断装配，下一步再试 */ }
  };

  /** 刷新常驻技能正文缓存（name → {text, hash}）：只查 plan 里 resident 且未被遮的技能。 */
  const refreshResidentBodies = async (agent, signal) => {
    const entry = entries.get(agent);
    if (entry === undefined) return;
    const plan = planSkillsFor(agent);
    const keep = new Set();
    for (const row of plan.rows) {
      if (row.shadowed || row.tier !== TIER_RESIDENT || row.modelInvocable === false) continue;
      keep.add(row.name);
      let content = typeof row.content === "string" ? row.content : undefined;
      if (row.origin === SKILL_ORIGIN_HOST) {
        try {
          const fetched = await getHostSkill(ctx, agent, row.name, signal);
          content = fetched && typeof fetched.content === "string" ? fetched.content : undefined;
        } catch { content = undefined; }
      }
      if (typeof content !== "string") {
        warnOnce(entry, "skill-body:" + row.name, "技能 " + row.name + " 正文取不到，常驻段落跳过");
        continue;
      }
      const hash = createHash("sha1").update(content).digest("hex");
      const prev = entry.skillBodies.get(row.name);
      if (prev === undefined || prev.hash !== hash) entry.skillBodies.set(row.name, { text: content, hash });
    }
    for (const name of [...entry.skillBodies.keys()]) if (!keep.has(name)) entry.skillBodies.delete(name);
  };

  /**
   * 常驻技能正文 → 系统提示词独立段落（工单 14 第 7 条：不进 gate-catalog 行）。
   * 段落名 gate-skill:<name>，text 是 <skill_content> 包装后的正文；同策略下逐字节稳定。
   */
  const skillSections = async (agent, signal) => {
    if (!skillsTakeover()) return [];
    const entry = entries.get(agent);
    const plan = planFor(agent);
    const resident = plan.skills.filter((row) => !row.shadowed && row.tier === TIER_RESIDENT);
    if (resident.length === 0) return [];
    // 正文只读 refreshResidentBodies 维护的缓存（hash 变化才更新），装配路径不再回查宿主：
    // 同一步里 assemble 可能跑多次，回查会让系统提示词字节随网络/文件时序抖动。
    const withBodies = [];
    for (const row of resident) {
      const cached = entry ? entry.skillBodies.get(row.name) : undefined;
      const content = typeof cached === "object" && cached !== null && typeof cached.text === "string"
        ? cached.text
        : typeof row.content === "string" ? row.content : undefined;
      if (typeof content !== "string") continue; // 取不到正文就不出占位段，避免每步字节抖动
      withBodies.push(Object.assign({}, row, { content }));
    }
    const { sections, warnings } = residentSkillSections(withBodies);
    for (const warning of warnings) warnOnce(entry, warning.code + ":" + warning.message, warning.message);
    return sections;
  };

  /**
   * 取一条技能正文（不改状态）。gate_load 与 pre-step 的 /name 注入共用这一份解析：
   * 档位（off/shadowed）与正文来源（宿主 ctx.skills.get / 导入文件）只有一处实现。
   * @returns {{ok:boolean, name:string, reason?: "unknown"|"off"|"error", text?:string, provider?:string, origin?:string, message?:string}}
   */
  const resolveSkill = async (agent, name, signal, opts) => {
    const entry = ensureEntry(agent);
    if (entry === undefined) return { ok: false, name: String(name || ""), reason: "unknown" };
    await entry.ready;
    const wanted = String(name || "").trim();
    if (wanted.length === 0) return { ok: false, name: wanted, reason: "unknown" };
    let rows = planSkillsFor(agent).rows;
    // 还没跑过 pre-step（新会话第一句就 gate_load）：现查一次宿主名单，别让模型等一轮。
    if (rows.length === 0) {
      await refreshSkills(agent, signal);
      rows = planSkillsFor(agent).rows;
    }
    const row = rows.find((item) => item.name === wanted);
    if (row === undefined || row.shadowed) return { ok: false, name: wanted, reason: "unknown" };
    if (row.tier === TIER_OFF) return { ok: false, name: wanted, reason: "off" };
    // 宿主权限边界（TS:874-879 / 910-912）：模型不可调用的技能连 gate_load 也拒；
    // /name 手势另外要求 userInvocable（宿主对这两件事的判据不同）。
    if (row.modelInvocable === false) return { ok: false, name: wanted, reason: "not-invocable" };
    if (opts && opts.forUser === true && row.userInvocable === false) return { ok: false, name: wanted, reason: "not-invocable" };
    let content = row.content;
    if (row.origin === SKILL_ORIGIN_HOST) {
      const fetched = await getHostSkill(ctx, agent, wanted, signal);
      content = fetched && typeof fetched.content === "string" ? fetched.content : undefined;
    }
    if (typeof content !== "string") {
      return {
        ok: false, name: wanted, reason: "error",
        message: row.origin === SKILL_ORIGIN_HOST ? "宿主没有返回正文（ctx.skills.get 失败或技能已不可用）" : "导入技能的正文文件读不到",
      };
    }
    return {
      ok: true,
      name: wanted,
      provider: row.provider,
      origin: row.origin,
      text: renderSkillContent({ name: wanted, content }),
    };
  };

  /**
   * gate_load("skill:<name>") 的唯一实现（native 与 PTC 同一条路）。
   * 不再转发宿主 skill 工具：那个工具已被我们 deny（接管），转发只会得到 UNKNOWN_TOOL。
   * 加载成功才记账（loaded + reapply）；pre-step 的 /name 注入走 resolveSkill，不污染加载态。
   */
  /**
   * 技能激活转发（0.5.3 · 上游票 B2）。
   *
   * 第三方插件的「技能激活门」只认宿主 skill 工具的 `tools/result(exec.name === "skill")`
   * （dsh-univer-office / @deepseek-ai/dsh-tool-office 都是这么写的）。接管后那个工具被我们
   * deny，信号永远不来 ⇒ univer_* 14 + office_* 3 共 17 个工具「目录可见、gate_load 报成功、
   * 执行 unknown tool」。正解只能是补发信号，不是转发工具调用（上面 :1351 已说明转发只会
   * 拿到 UNKNOWN_TOOL）。
   *
   * 三条纪律：
   *  1) 只在**加载成功**时发一次，toolCallId 带可识别前缀 —— 伪事件对其它监听者是噪音，
   *     重复计数必须能被一眼指出来；
   *  2) 可一键关掉（skills.activationRelay === false）：万一有监听者把它当真结果写进历史，
   *     改配置 + 重启就能止血，不必卸载包；
   *  3) 失败只告警，绝不影响加载本身（宿主没有 emit 也只是少一次激活）。
   *
   *  4) 伪 exec 必须补齐真实形状（0.5.3 复审 B1）：cordis 的 emit 是 dispatch().map(cb => cb(...args))，
   *     没有 try/catch —— 一个监听者抛错就中断后续监听者，并把异常抛回这里。宿主 dsh-agent-instructions
   *     的监听者会读 exec.signal.aborted；只发 {agent,name,arguments,toolCallId} 会让它抛 TypeError，
   *     排在它后面的目标监听者（univer/office 的激活门）就永远收不到信号。所以 callId / rootCallId /
   *     signal 一个都不能省。
   */
  const relaySkillActivation = async (agent, skillName) => {
    const info = {
      mode: "off",
      // 顶层汇总：兼容既有调用方（proxy 只读 listeners / delivered / failed / mode）。
      listeners: 0,
      delivered: 0,
      failed: [],
      // 0.7.2：两条通道**分别**记账 —— 排障时一眼能分清「waterfall 没人收」还是「emit 没人收」。
      waterfall: { mode: "off", listeners: 0, delivered: 0, failed: [] },
      emit: { mode: "off", listeners: 0, delivered: 0, failed: [] },
    };
    if (policy.skills && policy.skills.activationRelay === false) return info;
    // C46：id 必须**每次激活都不同**（技能名 + 递增序号）。0.5.7 用固定 id，
    // 二次加载同一个技能时宿主/监听者会把第二次当成同一个事件去重，激活回执永远只到第一条。
    activationSeq += 1;
    const callId = "gate-load-skill-" + skillName + "-" + activationSeq;
    // 独立 controller：伪事件不会真的被取消，但监听者会读 .aborted —— 缺了就是 TypeError。
    const controller = new AbortController();
    const exec = {
      callId,
      rootCallId: callId,
      name: "skill",
      arguments: { name: skillName },
      agent,
      parent: undefined,
      signal: controller.signal,
    };
    const result = { isError: false, content: [{ type: "text", text: "" }] };
    /**
     * A1 兼发（0.7.2 · 票 01 根治）：**两条宿主通道各发一次**，谁都不能省。
     *
     *  1) `tools/post-execute`（**waterfall**，末参 next → { kind: "accept" }）：
     *     新一批懒加载插件（如 @wxg-prc-cpg/browser-skill-dsh-plugin 的 armLazyTools）只监听
     *     这一条 —— 它们在 `await next()` 之后才注册工具。0.7.1 只发 tools/result，
     *     于是「gate_load 成功、信号送到 13 个监听者、promoted 为空、bsk_* 不可见」。
     *  2) `tools/result`（**emit**）：dsh-univer-office / dsh-tool-office / dsh-mnemon / deck
     *     这批存量插件只认这一条，替换（而不是兼发）会让它们当场断链。
     *
     * 两条通道各自隔离：一个监听者抛错只进该通道的 failed，不影响同通道后面的监听者，
     * 也不影响另一条通道（0.5.4 真机：univer 亮、office 不亮，就是串联上抛饿死后排）。
     */
    const accepted = await host.dispatchWaterfallIsolated("tools/post-execute", [exec, result], {
      agent,
      acceptValue: { kind: "accept" },
    });
    info.waterfall = {
      mode: accepted.mode,
      listeners: accepted.listeners,
      delivered: accepted.delivered,
      failed: accepted.failed.slice(),
    };
    if (accepted.delivered === 0 && accepted.failed.length > 0) {
      warn("技能激活 waterfall 通道投递失败（不影响加载）— " + accepted.failed[0]);
    }
    // 隔离派发的唯一实现在 host-adapter.js（D14）：per-listener 通道 → 串行 try/catch → 退回 emit。
    const dispatched = host.dispatchIsolated("tools/result", [exec, result]);
    info.emit = {
      mode: dispatched.mode === "none" ? "emit" : dispatched.mode,
      listeners: dispatched.listeners,
      delivered: dispatched.delivered,
      failed: dispatched.failed.slice(),
    };
    if (dispatched.delivered === 0 && dispatched.failed.length > 0) {
      warn("技能激活 emit 通道投递失败（不影响加载）— " + dispatched.failed[0]);
    }
    // 顶层汇总：listeners/delivered 相加，failed 合并（每条都带通道前缀，排障不用再猜是谁的）。
    info.mode = info.emit.mode !== "off" ? info.emit.mode : info.waterfall.mode;
    info.listeners = info.waterfall.listeners + info.emit.listeners;
    info.delivered = info.waterfall.delivered + info.emit.delivered;
    for (const failure of info.waterfall.failed) info.failed.push("post-execute: " + failure);
    for (const failure of info.emit.failed) info.failed.push("result: " + failure);
    return info;
  };

  /**
   * 技能激活放行（0.5.4 · 上游票 B2 的执行面）。
   *
   * 先把该族 conditional 工具记进 entry.promoted，下一次 planFor 就把它们当常驻 ——
   * deny 少一条、工具进 visible、下一步的 tools.resolve() 才会按 when 把它们 admit 进
   * step toolSet。只放 conditional（没 when 的按档位走）、只放族内、绝不碰 explicit off。
   *
   * 顺序要紧：relaySkillActivation 先发（把 when 置真），再 promote，最后 reapply 一次
   * 把 deny 与目录一起算好 —— 中间任何一步失败都不影响技能加载本身。
   *
   * @returns {string[]} 本次新放出的工具名（空数组 = 该族没有可放的 conditional 工具）
   */
  const promoteSkillFamily = (agent, skillName, batch) => {
    const entry = entries.get(agent);
    if (entry === undefined) return [];
    if (policy.skills && policy.skills.activationPromote === false) return [];
    // C46：一次 gate_load 带多个技能时，工具名集合与 off/resident 只解析一次（batch 由调用方共享），
    // 族成员集合也一次求出 —— 不逐个技能重建一遍宿主视图投影。
    const shared = batch !== null && typeof batch === "object" ? batch : undefined;
    if (shared !== undefined && shared.names === undefined) {
      const plan = planFor(agent);
      const globallyVisible = globalView().visible;
      shared.names = [...plan.visible.keys()];
      shared.resident = new Set(plan.resident);
      shared.off = new Set();
      for (const name of shared.names) {
        // 只问「策略给的是不是关闭」：技能激活是抬升，永远不参与关闭判定（B20 的语义明确化）。
        const { bucket } = resolveTier(policy, name, {
          loaded: false,
          globallyVisible: globallyVisible.has(name),
          own: false,
        });
        if (bucket === "off") shared.off.add(name);
      }
    }
    let names;
    let resident;
    let off;
    if (shared !== undefined) {
      ({ names, resident, off } = shared);
    } else {
      // 单个技能（gate.loadSkill 的直接调用方 / 测试）：同样必须逐名判 off，
      // 否则「显式关闭的工具」会被技能激活装回工具表（P1-5 回归点）。
      const plan = planFor(agent);
      const globallyVisible = globalView().visible;
      names = [...plan.visible.keys()];
      resident = new Set(plan.resident);
      off = new Set();
      for (const name of names) {
        const { bucket } = resolveTier(policy, name, {
          loaded: false,
          globallyVisible: globallyVisible.has(name),
          own: false,
        });
        if (bucket === "off") off.add(name);
      }
    }
    const picked = pickPromotableBatch({ skillNames: [skillName], names, off, resident });
    if (picked.length > 0) {
      for (const name of picked) entry.promoted.add(name);
      entry.planEpoch += 1;
    }
    return picked;
  };

  /** 激活事件的递增序号（C46：id = 技能名 + 递增序号；二次加载必须是一次新事件）。 */
  let activationSeq = 0;

  const loadSkill = async (agent, name, signal, batch) => {
    const entry = ensureEntry(agent);
    if (entry === undefined) return { ok: false, name: String(name || ""), reason: "unknown" };
    const resolved = await resolveSkill(agent, name, signal);
    if (!resolved.ok) return resolved;
    entry.loaded.add("skill:" + resolved.name);
    entry.planEpoch += 1;
    // 顺序（0.5.4）：先补发激活信号（条件门 when 见真），再放出该族工具，最后一次性重算。
    const conditionalBefore = conditionalNamesOf(agent).size;
    const relay = await relaySkillActivation(agent, resolved.name);
    const promoted = promoteSkillFamily(agent, resolved.name, batch);
    reapply(agent);
    if (promoted.length > 0) {
      try { logger?.info?.("dsh-gate: 技能 " + resolved.name + " 激活，放出 " + promoted.join(", ")); } catch { /* 忽略 */ }
    }
    /**
     * 激活诊断（0.5.5）：把「信号发给了几个监听者、谁抛错、这次认出了几个 conditional」
     * 一并回给调用方 —— 真机日志看不到 ctx.logger，只有这条回执能区分
     * 「信号没送到」「送了但 when 仍是假」「压根没认出 conditional」三种失败。
     */
    const receiptPromoted = promoted.slice(0, RELAY_RECEIPT_LIMIT);
    /**
     * 空放行诊断（0.7.2 · 票 01 的可排障性）：promoted 为空有两种完全不同的原因，
     * 以前回执一个字段都不给，真机只能靠猜 ——
     *  a) 族内确实没有可放的工具：技能名与插件工具前缀**不是同一个词**
     *     （browser-skill ↔ bsk_*：首段 browser 一个工具都不存在）。这条必须点到
     *     naming.js 的显式别名表，否则下一个人还会去 activation.js 里找。
     *  b) 本族工具已经全部常驻 / 全被 explicit off 挡住：那是正常幂等，不是缺陷。
     * 只在「有族前缀、族内零命中」时给诊断，其余情况留空（避免噪音）。
     */
    let diagnostic;
    if (promoted.length === 0) {
      const families = skillFamiliesOf(resolved.name);
      const knownNow = knownNames(agent) || [];
      if (families.length > 0 && familyToolNames(resolved.name, knownNow).length === 0) {
        diagnostic = "技能 " + resolved.name + " 的族前缀 [" + families.join(", ")
          + "] 在已注册工具里一个都没匹配到：技能名首段不一定等于插件工具前缀（如 browser-skill ↔ bsk_*）。"
          + "若该插件确实用别的前缀，在 lib/naming.js 的 SKILL_TOOL_PREFIXES 登记显式别名；"
          + "若前缀正确，则本族工具要么已全部常驻、要么被 explicit off 挡住（后者查策略的 off 名单）。";
        warn(diagnostic);
      }
    }
    const receipt = Object.assign({}, resolved, {
      promoted: receiptPromoted,
      ...(diagnostic === undefined ? {} : { diagnostic }),
      // 0.5.7：promoted 必须进回执本身 —— 0.5.6 只把它放在顶层，而 proxy 只透出 activation，
      // 于是「去看 activation.promoted」这件事在真机上等于没发生（与 0.5.5 回执被 schema 裁掉同类）。
      activation: {
        relay,
        conditional: conditionalBefore,
        skill: resolved.name,
        promoted: receiptPromoted,
        // D20：回执数组单次上限 32；截断时明确标出总数，别让调用方以为只有这么几个。
        promotedTotal: promoted.length,
        truncated: promoted.length > RELAY_RECEIPT_LIMIT,
      },
    });
    return receipt;
  };

  /** 只渲染正文、不记加载态：pre-step 的 /name 注入与 off 过滤用这个。 */
  const renderSkill = async (agent, name, signal) => resolveSkill(agent, name, signal, { forUser: true });

  const catalogFor = (agent) => {
    const entry = entries.get(agent);
    return entry ? entry.catalogText : "";
  };

  /**
   * gate_search 的只读检索口。
   *
   * 以前 proxy 从快照的 residentNames / onDemandNames / offNames 拼候选池，那三个数组只有名字，
   * 于是工具搜索结果的说明恒为空（只有技能有）—— 搜索退化成「猜名字」。
   * 这里从 plan.visible（scoped 视图 ∪ 全局视图）取 definition.description 的首句；
   * 技能仍用约定好的 skillEntries（name / description / provider）。
   * 只读：不建条目、不改任何状态。
   */
  const searchEntries = (agent) => {
    const entry = entries.get(agent);
    const plan = planFor(agent);
    const global = globalView();
    const out = [];
    const pushTool = (name, tier) => {
      const definition = plan.visible.get(name) ?? global.visible.get(name);
      out.push({ name, description: firstSentence(definition && definition.description, 120), tier });
    };
    for (const name of plan.resident) pushTool(name, "常驻");
    for (const tool of plan.ondemand) pushTool(tool.name, "按需");
    for (const name of plan.off) pushTool(name, "关闭");
    // 技能：接管后带真实档位（常驻/按需/关闭），不再一律写「技能」——
    // 否则模型无法判断该不该 gate_load，而「已关闭」的技能会看着像可加载的。
    for (const skill of plan.skills || []) {
      if (skill.shadowed) continue;
      // off 的技能不该在搜索里显得「可加载」：目录不列它，搜索也不列。
      if (plan.takeover && skill.tier === TIER_OFF) continue;
      const label = plan.takeover
        ? skill.tier === TIER_RESIDENT ? "技能·常驻" : skill.tier === TIER_OFF ? "技能·关闭" : "技能·按需"
        : "技能";
      out.push({ name: "skill:" + skill.name, description: firstSentence(skill.description, 120), tier: label });
    }
    return out;
  };

  const release = async (agent) => {
    const entry = entries.get(agent);
    if (entry === undefined) return;
    entries.delete(agent);
    // C36：卸载不留定时器 / 监听器 / 限制句柄。
    entry.disposed = true;
    clearSettle(entry);
    try { entry.offWindowOpen?.(); } catch { /* 忽略 */ }
    try { entry.offWindowClose?.(); } catch { /* 忽略 */ }
    try { entry.restriction.destroy(); } catch { /* 忽略 */ }
    try { await entry.fiber?.dispose?.(); } catch { /* 忽略 */ }
  };

  const releaseAll = async () => {
    disposed = true;
    for (const timer of settleTimers.values()) { try { clearTimeout(timer); } catch { /* 忽略 */ } }
    settleTimers.clear();
    for (const agent of [...entries.keys()]) await release(agent);
  };

  /**
   * 这个 agent 此刻的限制状态（只读快照）：{ mode, key, count }。
   * 内部仍由 restriction.js 拥有，这里只把「被限制成什么样」这一个事实读出来。
   */
  const restrictionState = (agent) => {
    const entry = entries.get(agent);
    return entry ? entry.restriction.state() : NO_RESTRICTION;
  };

  /**
   * 当前挂着的 agent 清单（最近活过的在前）。
   * HTTP 层靠它挑「当前会话」与列出已知会话，不再直接遍历内部条目表。
   * touchedAt 由 reapply / attach 维护；同毫秒时靠 id 兜底排序，保证结果稳定。
   */
  const listAgents = () => {
    const rows = [];
    for (const [agent, entry] of entries.entries()) {
      rows.push({
        id: String((agent && agent.id) || ""),
        touchedAt: Number(entry && entry.touchedAt) || 0,
        agent,
      });
    }
    rows.sort((a, b) => (b.touchedAt - a.touchedAt) || a.id.localeCompare(b.id));
    return rows;
  };

  /**
   * 对外面 —— 只给能力，不给内部数据结构（票 06）。
   *
   * 以前这里连 `entries`（agent → 内部条目）一起交出去，外部于是直接读 entry.touchedAt /
   * entry.skills / entry.loaded，还各自调用 visibleOf / planFor / tierMap 自己算一遍。
   * 内部字段一动，HTTP 层、五个工具、测试全要跟着改 —— 面越宽，能深的地方越浅。
   *
   * 现在每个成员都是一个「问得出口的问题」：
   *   谁挂着、多久前活过 → listAgents()
   *   模型现在能看到什么 → snapshot(agent)（工具面用 pickStatus 裁成 STATUS_KEYS）
   *   目录长什么样     → catalogFor(agent)
   *   这一步尾部要追加什么 → loadedTextFor(agent)（PTC 冻结下的已加载能力声明块）
   *   这个工具能不能转发   → canInvoke(agent, name)（known 且非 upstreamHidden）
   *   把它推到目标形状 → reapply(agent)
   */
  return {
    /**
     * 挂载并等到就绪（内部先跑一次 reapply）。返回的只是一个就绪承诺，
     * 不交条目本身 —— 条目长什么样、有哪些字段，都归 gate 自己管。
     */
    attach: (agent) => {
      const entry = ensureEntry(agent);
      return entry === undefined ? undefined : entry.ready.then(() => undefined);
    },
    listAgents,
    restrictionState,
    snapshot,
    capabilityView,
    knownNames,
    canInvoke,
    loadedTextFor,
    loadedBlockFor,
    deltaTextFor,
    indexTextFor,
    planSections,
    reapply,
    reapplyAll,
    isApplying,
    // MCP 接管（工单 15）：启动自挂入口 + manager（server.js 的 /mcp 路由用）。
    startMcp,
    mcpManager: manager,
    load,
    callThrough,
    catalogFor,
    searchEntries,
    rememberSkills,
    // 技能接管的公开口（工单 14）：刷新名单 / 常驻正文段落 / 按名取正文（不记加载态）。
    refreshSkills,
    ensureSkills,
    skillSections,
    renderSkill,
    loadSkill,
    recordSections,
    release,
    releaseAll,
  };
}