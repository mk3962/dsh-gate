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
import { randomUUID } from "node:crypto";
import { tierForSection, resolveTier, TIER_RESIDENT } from "./policy.js";
import { capabilityState } from "./capabilities.js";
import { computeSurface, isSectionUpstreamHidden } from "./upstream.js";
import { renderCatalog, estimateTokens, firstSentence } from "./catalog.js";
import { createRestriction, MODE_LIMITED, MODE_NONE, MODE_PASSTHROUGH } from "./restriction.js";

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

  const warn = (message) => {
    try { logger?.warn?.("dsh-gate: " + message); } catch { /* 忽略 */ }
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
      skills: [],
      sections: [],
      // 段落正文（只给尾部声明用；不参与目录渲染，所以不会动 gate-catalog 的字节）。
      sectionTexts: new Map(),
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

  const planFor = (agent) => {
    const entry = entries.get(agent);
    const loaded = entry ? entry.loaded : new Set();
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
    return {
      shouldDrop(name) {
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
    entry.catalogText = renderCatalog({
      tools: plan.ondemand,
      skills: entry.skills,
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

  const load = async (agent, names) => {
    const entry = ensureEntry(agent);
    if (entry === undefined) return { loaded: [], unknown: [] };
    await entry.ready;
    const wanted = (Array.isArray(names) ? names : [names]).map((n) => String(n || "").trim()).filter(Boolean);
    // 校验必须对“未被限制的全局视图”，否则第二层的名字永远认不出来。
    const plan = planFor(agent);
    const visible = plan.visible;
    const off = new Set(plan.off);
    const accepted = [];
    const unknown = [];
    const denied = [];
    for (const name of wanted) {
      if (name.startsWith("section:")) { entry.loaded.add(name); accepted.push(name); continue; }
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
        const text = entry.sectionTexts.get(bare);
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
    const skills = entry ? entry.skills : [];
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
      skills: skills.map((skill) => skill.name),
      skillEntries: skills.map((skill) => ({ name: skill.name, description: skill.description })),
      tiers: tierMap(agent).tiers,
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
    const tools = [];
    for (const name of [...plan.visible.keys()].sort()) {
      tools.push({
        name,
        own: plan.own.has(name),
        globallyVisible: global.visible.has(name),
        loaded: loaded.has(name),
        // 成员表里只有可用工具（上游隐藏项不进这里，见 capabilities.test.mjs §7）；
        // 它的来源与「是否被上游藏」以顶层 upstreamHidden / provenance 为准。
        provenance: provenanceOf(name),
        upstreamHidden: false,
      });
    }
    const sections = (entry ? entry.sections : []).map((section) => ({
      name: section.name,
      provenance: provenanceOf(section.name),
      upstreamHidden: plan.sectionUpstreamHidden instanceof Set && plan.sectionUpstreamHidden.has(section.name),
    }));
    // 来源表转普通对象：HTTP 层要 JSON，Map 序列化会变成 {}。
    const provenance = {};
    for (const name of [...plan.provenance.keys()].sort()) provenance[name] = provenanceOf(name);
    return {
      tools,
      sections,
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
      merged.set(item.name, { name: item.name, chars: item.chars, tokens: item.tokens });
      if (typeof item.text === "string" && item.text.length > 0) entry.sectionTexts.set(item.name, item.text);
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
    const next = (Array.isArray(skills) ? skills : []).filter((item) => item && typeof item.name === "string");
    // 每一步 pre-step 都会走到这里；名单没变就别重算（否则非 PTC profile 每轮多一次全量 reapply）。
    // 来源（provider）也计入签名：它是能力视图的来源标注输入，变了才值得重算。
    const signature = (list) => list.map((s) => s.name + "\u0001" + (s.provider || "")).join("\u0000");
    const before = signature(entry.skills || []);
    const after = signature(next);
    if (before === after && entry.skills.length > 0) return;
    entry.skills = next;
    reapply(agent);
  };

  const catalogFor = (agent) => {
    const entry = entries.get(agent);
    return entry ? entry.catalogText : "";
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
    isApplying,
    load,
    callThrough,
    catalogFor,
    rememberSkills,
    recordSections,
    release,
    releaseAll,
  };
}