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
import { tierForSection, resolveTier, TIER_OFF, TIER_ONDEMAND, TIER_RESIDENT } from "./policy.js";
import { capabilityState, resolveSkillDecision } from "./capabilities.js";
import { computeSurface, isSectionUpstreamHidden } from "./upstream.js";
import { renderCatalog, estimateTokens, firstSentence } from "./catalog.js";
import {
  SKILL_ORIGIN_HOST,
  GATE_SKILL_SECTION_PREFIX,
  getHostSkill,
  listHostSkills,
  makeSkill,
  mergeSkills,
  renderSkillContent,
  residentSkillSections,
  scanImports,
  skillCatalogEntry,
} from "./skills.js";
import { createRestriction, MODE_LIMITED, MODE_NONE, MODE_PASSTHROUGH } from "./restriction.js";
import { createMcpManager } from "./mcp.js";

/** PTC 传输名：PTC 执行器的 describe() 只投影这一条声明 —— 也是「是不是 PTC」的语义判据。 */
const RUN_CODE_NAME = "run_code";

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
  const entries = new Map(); // agent -> entry
  // MCP 自挂：gate.json 里声明的 server 由 gate 自己 ctx.plugin(mcp-client) 挂上去。
  // 外部（宿主 loader 行里已有的）只观察，绝不 dispose —— manager 负责这条纪律。
  const manager = createMcpManager({ ctx, logger });

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
    warn(message);
  };

  /** 内部：拿到该 agent 的条目（不存在就建）。对外只给「挂载完成」的 promise。 */
  const ensureEntry = (agent) => {
    if (!agent || !agent.ctx) return undefined;
    const existing = entries.get(agent);
    if (existing !== undefined) return existing;
    const entry = {
      agent,
      scoped: undefined,
      fiber: undefined,
      loaded: new Set(),
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
      // 这个 agent 身上“当前被限制成什么样”的唯一真源（见 lib/restriction.js）。
      restriction: undefined,
      catalogText: "",
      ready: undefined,
      // 最近一次“活着”的时间：状态接口在多会话进程里靠它挑出真正的活跃 agent。
      touchedAt: Date.now(),
    };
    entry.restriction = createRestriction({
      restrict(filter) {
        const tools = entry.scoped && entry.scoped.tools;
        if (!tools) throw new Error("dsh-gate: scoped tools 不可用");
        return tools.restrict(filter);
      },
      logger,
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
   * 候选集必须是“未被限制过的全局视图”，否则算完 deny 再算一次就会看不见、限制被误撤销（震荡）。
   * view() 不带 scope = 全局视图（restriction 只在 admits() 里生效，view(undefined) 不受 agent 限制影响）。
   */
  const globalView = () => {
    try {
      const view = ctx.tools.view?.();
      if (view && view.visible instanceof Map) return view;
    } catch (error) {
      warn("读取全局工具视图失败 — " + String((error && error.message) || error));
    }
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
   * 授予数 = 去掉 agent 自己这一层 own 工具后的可见工具数。主会话 / 宽工具面子代理不受影响。
   *
   * 授予数必须从**未受限制**的视图算：knownNames 不受 restriction 影响，而 visibleOf(agent)
   * 会掉进自指陷阱 —— 上一轮的限制已经把这些名字藏了，重算时授予数变成 0，本该豁免的永远豁免不了
   * （这也正是旧实现必须先 lift 再判断的原因，顺序一错就错到底）。
   * 也不能用 plan.visible：它是「agent 链 ∪ 全局」的并集，会把全局一百多个工具算进窄子代理的授予数。
   */
  const narrowPassThroughFor = (agent, plan) => {
    const limit = policy.narrowPassThrough;
    if (typeof limit !== "number" || limit <= 0) return false;
    if (!isDelegatedChild(agent)) return false;
    const scoped = scopedViewOf(agent);
    const names = scoped !== undefined ? scoped.knownNames : new Set(plan.visible.keys());
    let granted = 0;
    for (const name of names) if (!plan.own.has(name)) granted += 1;
    return granted > 0 && granted <= limit;
  };

  /**
   * 该 agent 的完整工具视图：global 层 + 所有**祖先层**（agent preset 注册的工具就在这）。
   * knownNames 不受 restriction 影响，是唯一稳定、不震荡的候选集来源 ——
   * 旧实现只用 view() 全局视图，preset 平面的工具（pwsh/read/write/grep/glob/web_search/skill…）
   * 根本进不了候选集，于是“gate.json 里给它们写层不生效”，面板上也看不到（真误诊来源）。
   */
  const scopedViewOf = (agent) => {
    try {
      const view = ctx.tools.view?.(agent);
      if (view && view.knownNames instanceof Set) return view;
    } catch (error) {
      warn("读取 agent 工具视图失败 — " + String((error && error.message) || error));
    }
    return undefined;
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
  const detectExecutor = (agent) => {
    let executor;
    try { executor = ctx.tools.selectExecutor?.(agent); } catch { executor = undefined; }
    if (executor === undefined || executor === null) return { kind: "unknown", reason: "no-executor" };
    const ctor = executor.constructor && executor.constructor.name;
    if (ctor === "PtcExecutor") return { kind: "ptc", reason: "constructor" };
    if (ctor === "NativeToolExecutor") return { kind: "native", reason: "constructor" };
    let schemas;
    try {
      const described = executor.describe?.([]);
      schemas = described && Array.isArray(described.schemas) ? described.schemas : undefined;
    } catch { schemas = undefined; }
    if (schemas !== undefined && schemas.length === 1 && schemas[0] && schemas[0].name === RUN_CODE_NAME) {
      return { kind: "ptc", reason: "schemas" };
    }
    if (schemas !== undefined && schemas.length > 0) return { kind: "native", reason: "schemas" };
    return { kind: "unknown", reason: "unrecognized-executor" };
  };

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

  const planFor = (agent) => {
    const entry = entries.get(agent);
    const loaded = entry ? entry.loaded : new Set();
    const skillPlan = planSkillsFor(agent);
    const takeover = skillPlan.takeover;
    // 冻结时「已加载」不再影响归层：工具继续留在第二层（继续 deny），声明逐字节不变。
    const frozen = freezeFor(agent);
    const global = globalView();
    const scoped = scopedViewOf(agent);
    const own = ownNamesOf(agent);
    const known = scoped !== undefined && scoped.knownNames instanceof Set ? scoped.knownNames : new Set();
    const current = entry ? entry.restriction.state() : NO_RESTRICTION;
    /**
     * 上游已隐藏 / 可用候选 / 来源标注只有一个出口（lib/upstream.js）：
     * 以前这里内联算 upstreamHidden，planSections 与能力视图各自再猜一遍 —— 三本账迟早漂。
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
    // 候选集 = 注册过的 ∪ 全局可见，减掉上游藏起来的（knownNames 不受限制影响，重算不震荡）。
    const candidates = new Map();
    for (const name of surface.usable) {
      const definition = scoped !== undefined ? scoped.visible.get(name) : undefined;
      candidates.set(name, definition ?? global.visible.get(name));
    }
    const resident = [];
    const ondemand = [];
    const off = [];
    const deny = [];
    const preset = new Set();
    for (const name of own) resident.push(name);
    for (const [name, definition] of candidates.entries()) {
      // 自己这一层的（含 run_code 传输）已经算进 resident，别再算一遍。
      if (own.has(name)) continue;
      // 技能接管（工单 14）：宿主 skill 工具**无条件** deny —— 即使用户把它设成常驻。
      // 这是 B 案的前提：tool-skill 的目录 pre-step 靠 ctx.tools.get("skill",agent) 判可见性，
      // 工具一旦不可见，宿主就不再生成目录（TS:936-945），gate 才有唯一的技能入口。
      // own 层的工具 restrict 管不到，那种情况下接管只能降级（不 deny，避免限制抛错）。
      if (takeover && name === "skill") { off.push(name); deny.push(name); continue; }
      // 归层只有一个出口：规则写错只会在 resolveTier 里错一次。
      const { bucket } = resolveTier(policy, name, {
        loaded: !frozen && loaded.has(name),
        globallyVisible: global.visible.has(name),
        own: false,
      });
      if (bucket === "preset") { preset.add(name); resident.push(name); continue; }
      if (bucket === "resident") { resident.push(name); continue; }
      if (bucket === "off") { off.push(name); deny.push(name); continue; }
      ondemand.push({ name, description: definition && definition.description });
      deny.push(name);
    }
    // 段落兜底与工具用同一份 upstreamHidden：谁被藏只判一次，段落只读结论。
    const sectionUpstreamHidden = new Set();
    for (const section of entry ? entry.sections || [] : []) {
      if (isSectionUpstreamHidden(section.name, { knownNames: known, upstreamHidden: surface.upstreamHidden })) {
        sectionUpstreamHidden.add(section.name);
      }
    }
    return {
      resident, ondemand, off, deny, visible: candidates, own, preset,
      upstreamHidden: surface.upstreamHidden,
      provenance: surface.provenance,
      sectionUpstreamHidden,
      frozen,
      // 技能（工单 14）：rows=全部（含 shadowed），visible=可用，takeover=是否由 gate 接管。
      skills: skillPlan.rows,
      skillsVisible: skillPlan.visible,
      takeover,
      takenOver: takeover ? ["skill"].filter((name) => !own.has(name) && candidates.has(name)) : [],
    };
  };

  /**
   * 段落闸门的判定口：调用方逐段问 shouldDrop，自己决定怎么摘。
   * 只答这一个问题 —— 以前还顺带回一个 gated 数组累积「摘了哪些」，但没有任何调用方读它
   * （sections.js 自己就有一份 dropped），那只是又一处会漂的第二本账。
   */
  const planSections = (agent) => {
    const entry = entries.get(agent);
    const loaded = entry ? entry.loaded : new Set();
    // 冻结时「已加载的段落」也不再回到系统提示词：那一步会改装配结果 ⇒ 前缀缓存从段落处断掉。
    // 段落正文由 loadedTextFor 搬到尾部声明里（与工具同一条纪律）。native 下保持 0.1.8 行为。
    const frozen = freezeFor(agent);
    // 段落兜底优先于档位：mcp:<server> 的工具全被上游藏了/没注册时，说明书也不该留着。
    const plan = planFor(agent);
    const upstreamHidden = plan.sectionUpstreamHidden instanceof Set ? plan.sectionUpstreamHidden : new Set();
    const protectedName = (name) => INTRINSIC_PROTECTED_SECTIONS.includes(name) ||
      (policy.protectedNames instanceof Set && policy.protectedNames.has(name));
    return {
      shouldDrop(name) {
        // 保护优先于一切：tools:sdk / tools:ptc-only 被摘掉，模型就看不到任何工具签名；
        // 用户 protected 名单里追加的段落同理。这条判断必须在 upstreamHidden/档位之前。
        // gate 自己注入的常驻技能段落（gate-skill:<name>）永远不摘：它们没有档位可配，
        // 被 sections.defaultTier=0 这类设置误摘会直接丢掉常驻技能正文。
        if (typeof name === "string" && name.startsWith(GATE_SKILL_SECTION_PREFIX)) return false;
        if (protectedName(name)) return false;
        if (upstreamHidden.has(name)) return true;
        if (!frozen && loaded.has("section:" + name)) return false;
        if (tierForSection(policy, name) === TIER_RESIDENT) return false;
        return true;
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
  /** 被摘掉的系统提示词段落也要进目录，否则模型永远不知道有这段（摘掉就彻底消失了）。 */
  const sectionEntriesFor = (entry, frozen, upstreamHidden) => {
    const out = [];
    const orphaned = upstreamHidden instanceof Set ? upstreamHidden : new Set();
    for (const section of entry.sections || []) {
      // gate 自己注入的技能段落不进目录：它不是宿主段落，没有档位可切（正文就在系统提示词里）。
      if (typeof section.name === "string" && section.name.startsWith(GATE_SKILL_SECTION_PREFIX)) continue;
      // 上游兜底摘掉的段落优先：它已经不在系统提示词里，必须进目录，否则连名字都没了
      // （与「冻结时加载过的段落」同一条纪律：从系统提示词消失的东西要有第二入口）。
      if (!orphaned.has(section.name)) {
        // 冻结时加载过的段落**继续留在目录里**：把它从目录摘掉同样会改系统提示词，
        // 那一步的前缀缓存照样断 —— 与工具表同一条纪律（正文走尾部声明）。
        if (!frozen && entry.loaded.has("section:" + section.name)) continue;
        if (tierForSection(policy, section.name) === TIER_RESIDENT) continue;
      }
      out.push({ name: section.name, summary: section.summary });
    }
    return out;
  };

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
    const catalogSkills = plan.skills
      .filter((row) => !row.shadowed && (plan.takeover ? row.tier === TIER_ONDEMAND : true))
      .map((row) => skillCatalogEntry(row, policy.catalog && policy.catalog.maxDescriptionLength));
    entry.catalogText = renderCatalog({
      tools: plan.ondemand,
      skills: catalogSkills,
      sections: sectionEntriesFor(entry, plan.frozen, plan.sectionUpstreamHidden),
    }, policy.catalog);
    // scoped tools 拿不到（agent 还没就绪 / plugin 挂载失败）：撤销现有状态，别留着一个撤不掉的限制。
    if (tools === undefined) { entry.restriction.drop(); return plan; }
    let restrictable = null;
    try {
      const view = tools.view?.(agent);
      if (view && view.restrictableNames instanceof Set) restrictable = view.restrictableNames;
    } catch { /* 忽略 */ }
    const deny = restrictable === null ? plan.deny : plan.deny.filter((name) => restrictable.has(name));
    // 目标形状算出来交给限制对象：它自己比模式与键，相同就什么都不做（幂等由所有权保证，
    // 调用方不再比较键或句柄 —— 那句隐式判据在收窄豁免分支上是错的）。
    // 豁免判定必须在「已撤销」的前提下做：view 里还留着上一次的 deny 就会把授予数少算。
    const target = narrowPassThroughFor(agent, plan)
      ? { mode: MODE_PASSTHROUGH, deny: [] }
      : { mode: deny.length > 0 ? MODE_LIMITED : MODE_NONE, deny };
    const before = entry.restriction.state();
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
    for (const name of wanted) {
      if (name.startsWith("section:")) {
        // 段落名必须真实出现在当前装配清单里：不存在的名字收下只会让尾部永远是一段占位，
        // 模型还以为自己已经加载了什么（0.2.0 缺陷批修 I5-6）。
        const bare = name.slice("section:".length);
        if (bare.length === 0 || !knownSections.has(bare)) { unknown.push(name); continue; }
        sectionTextOf(entry, bare);
        entry.loaded.add(name);
        accepted.push(name);
        continue;
      }
      // off 不收：否则模型会看到「已加载」，转头 gate_invoke 又被拒，白转一圈。
      if (off.has(name)) { denied.push(name); continue; }
      if (!visible.has(name)) { unknown.push(name); continue; }
      entry.loaded.add(name);
      accepted.push(name);
    }
    reapply(agent);
    return { loaded: accepted, unknown, denied };
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

  const callThrough = async (agent, name, args, signal) => {
    const entry = ensureEntry(agent);
    if (entry === undefined) throw new Error("dsh-gate: 没有可用的 agent 上下文");
    await entry.ready;
    const tools = scopedToolsOf(agent);
    if (tools === undefined) throw new Error("dsh-gate: scoped tools 不可用");
    const payload = args === undefined || args === null ? {} : args;
    // 撤限制/恢复限制都会发 tools/change；窗口里 applying 为 true，监听者就不会跟着重算
    // （否则每次转发多触发两轮全量重算）。窗口结束时状态是 none，reapply 重新算目标。
    try {
      return await entry.restriction.suspend(async () => {
        const api = await pipelineApiOf();
        if (api === null) {
          // 旧宿主：保持 0.1.x 的单调用语义（含它自己的 UNKNOWN_TOOL / 参数校验）。
          try {
            return await tools.execute({ callId: randomUUID(), name, agent, arguments: payload, signal });
          } catch (error) {
            // 宿主侧错误（工具不存在 / 参数被拒 / 执行抛错）→ 结果，不抛给模型。
            return errorResult(String((error && error.message) || error));
          }
        }
        if (pipeline === undefined) pipeline = new api.ToolExecutionPipeline(ctx, {});
        try {
          const batch = await api.executeToolBatch(
            { calls: [{ id: randomUUID(), name, arguments: JSON.stringify(payload) }], agent, signal },
            pipeline,
            () => 1,
          );
          const first = batch && Array.isArray(batch.results) ? batch.results[0] : undefined;
          const result = first && first.result;
          if (result === undefined) return errorResult("目标工具没有返回结果（" + name + "）");
          return result;
        } catch (error) {
          // 批量/管线自己抛的错（宿主侧）一律转成 isError 结果；闸门自己的参数错误在 proxy 层就抛了。
          return errorResult(String((error && error.message) || error));
        }
      });
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
  const loadedTextFor = (agent) => {
    const entry = entries.get(agent);
    if (entry === undefined || entry.loaded.size === 0) return "";
    if (!freezeFor(agent)) return "";
    const plan = planFor(agent);
    const lines = [];
    const sectionBlocks = [];
    for (const name of [...entry.loaded].sort()) {
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
      blocks.push([
        "<gate-loaded>",
        "已加载的能力（工具表已冻结，不要再次 gate_load 同名）：在 run_code 里用 tools.gate_invoke({ tool: \"名字\", arguments: { … } }) 执行。",
        "目标工具的参数校验照旧；参数不对会得到 isError 结果（错误文本），不会静默成功。",
        ...lines,
        "</gate-loaded>",
      ].join("\n"));
    }
    for (const block of sectionBlocks) blocks.push(block);
    return blocks.join("\n");
  };

  /**
   * 权威归层表（只给 UI 用，不进 gate_status 的 schema）。
   * UI 不该靠“有没有 overrides 条目”猜层：own 层工具没有条目，会被猜成按需（真事故）。
   */
  const tierMap = (agent) => {
    const entry = entries.get(agent);
    const plan = planFor(agent);
    const loadedSet = entry ? entry.loaded : new Set();
    const global = globalView();
    const tiers = {};
    for (const name of plan.visible.keys()) {
      tiers[name] = resolveTier(policy, name, {
        loaded: loadedSet.has(name),
        globallyVisible: global.visible.has(name),
        own: plan.own.has(name),
      }).tier;
    }
    return { tiers, ownNames: [...plan.own].sort(), presetNames: [...plan.preset].sort() };
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
      sections: (entry ? entry.sections : []).map((section) => ({
        name: section.name,
        chars: section.chars,
        tokens: section.tokens,
        gated: tierForSection(policy, section.name) !== TIER_RESIDENT,
      })),
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
      // 归层表与实际执行必须同口径：被接管的工具（宿主 skill）强制落 off，
      // 否则面板会显示「常驻」而它其实不在工具表里（tier.test.mjs 穷举断言的就是这个）。
      tiers: (() => {
        const map = tierMap(agent).tiers;
        for (const name of plan.takenOver) map[name] = TIER_OFF;
        return map;
      })(),
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
  const recordSections = (agent, inventory) => {
    const entry = entries.get(agent);
    if (entry === undefined) return;
    // 并集而不是覆盖：被摘掉的段落下一次 assemble 就不会再出现在清单里了，
    // 覆盖写会让“可加载的段落”清单逐个消失（目录里也就查不到）。
    const merged = new Map();
    for (const item of entry.sections || []) merged.set(item.name, item);
    for (const item of Array.isArray(inventory) ? inventory : []) {
      if (!item || typeof item.name !== "string") continue;
      // 正文单独存：目录渲染只读 name/summary，多带一个 text 会改 gate-catalog 的字节。
      // 这里只更新「最近一次装配的原文」；已加载段落的那一份在 gate_load 时定格，
      // 后续装配改文也不会再动尾部声明（消息字节稳定 = 前缀缓存稳定）。
      merged.set(item.name, { name: item.name, chars: item.chars, tokens: item.tokens });
      if (typeof item.text === "string" && item.text.length > 0) entry.sectionInventory.set(item.name, item.text);
    }
    entry.sections = [...merged.values()].sort((a, b) => b.chars - a.chars).slice(0, 120);
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
    // 签名覆盖所有会进目录/正文/能力视图的字段（来源、描述、路径、遮蔽），变了才值得重算。
    const signature = (list) => list
      .map((s) => [s.name, s.provider || "", s.description || "", s.origin, s.path || "", s.shadowed ? 1 : 0].join("\u0001"))
      .join("\u0000");
    const before = signature(entry.skills || []);
    const after = signature(next);
    if (before === after && entry.skills.length > 0) return;
    entry.skills = next;
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
    let hostRows;
    try { hostRows = await listHostSkills(ctx, agent, signal); } catch { hostRows = undefined; }
    const imported = takeover
      ? scanImports(policy.skills && policy.skills.imports, { baseDir: policyBaseDir() })
      : { skills: [], warnings: [] };
    for (const warning of imported.warnings) warnOnce(entry, warning.code + ":" + warning.message, warning.message);
    if (hostRows === undefined && !takeover) return entry.skills;
    // 宿主服务缺失（旧宿主 / 假宿主 / 单测）时：优先用本轮目录消息里的 entries，
    // 其次保留已有名单 —— 绝不能因为查不到宿主就把技能表清空。
    const fallbackHost = hostRows === undefined
      ? (Array.isArray(fallback) && fallback.length > 0 ? fallback : (entry.skills || []).filter((item) => item.origin !== "import" || !takeover))
      : hostRows;
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
  const skillSections = async (agent) => {
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
  const loadSkill = async (agent, name, signal) => {
    const entry = ensureEntry(agent);
    if (entry === undefined) return { ok: false, name: String(name || ""), reason: "unknown" };
    const resolved = await resolveSkill(agent, name, signal);
    if (!resolved.ok) return resolved;
    entry.loaded.add("skill:" + resolved.name);
    reapply(agent);
    return resolved;
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
    try { entry.restriction.drop(); } catch { /* 忽略 */ }
    try { await entry.fiber?.dispose?.(); } catch { /* 忽略 */ }
  };

  const releaseAll = async () => {
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