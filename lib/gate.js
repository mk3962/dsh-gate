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
import { tierForTool, tierForSection, TIER_RESIDENT, TIER_OFF } from "./policy.js";
import { renderCatalog, estimateTokens } from "./catalog.js";

export function createGate(options) {
  const ctx = options.ctx;
  const logger = options.logger;
  const policy = options.policy;
  const entries = new Map(); // agent -> entry

  const warn = (message) => {
    try { logger?.warn?.("dsh-gate: " + message); } catch { /* 忽略 */ }
  };

  const attach = (agent) => {
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
      lift: undefined,
      catalogText: "",
      denyKey: undefined,
      applying: false,
      denyCount: 0,
      offCount: 0,
      ready: undefined,
      // 最近一次“活着”的时间：状态接口在多会话进程里靠它挑出真正的活跃 agent。
      touchedAt: Date.now(),
    };
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

  const planFor = (agent) => {
    const entry = entries.get(agent);
    const loaded = entry ? entry.loaded : new Set();
    const global = globalView();
    const own = ownNamesOf(agent);
    const resident = [];
    const ondemand = [];
    const off = [];
    const deny = [];
    for (const name of own) resident.push(name);
    for (const [name, definition] of global.visible.entries()) {
      // 自己这一层的（含 run_code 传输）已经算进 resident，别再算一遍。
      if (own.has(name)) continue;
      const tier = loaded.has(name) ? TIER_RESIDENT : tierForTool(policy, name);
      if (tier === TIER_RESIDENT) { resident.push(name); continue; }
      if (tier === TIER_OFF) { off.push(name); deny.push(name); continue; }
      ondemand.push({ name, description: definition && definition.description });
      deny.push(name);
    }
    return { resident, ondemand, off, deny, visible: global.visible, own };
  };

  const planSections = (agent) => {
    const entry = entries.get(agent);
    const loaded = entry ? entry.loaded : new Set();
    const gated = [];
    return {
      gated,
      shouldDrop(name) {
        if (loaded.has("section:" + name)) return false;
        if (tierForSection(policy, name) === TIER_RESIDENT) return false;
        gated.push(name);
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
   *  2) 所以：先算 deny 集，跟上次**一模一样就直接返回**，不 lift 不 restrict；
   *     真要动的时候置 entry.applying，让 tools/change 监听者跳过自己引起的这次事件。
   */
  /** 被摘掉的系统提示词段落也要进目录，否则模型永远不知道有这段（摘掉就彻底消失了）。 */
  const sectionEntriesFor = (entry) => {
    const out = [];
    for (const section of entry.sections || []) {
      if (entry.loaded.has("section:" + section.name)) continue;
      if (tierForSection(policy, section.name) === TIER_RESIDENT) continue;
      out.push({ name: section.name, summary: section.summary });
    }
    return out;
  };

  /** 撤掉当前的 deny 限制（幂等）。 */
  const dropDeny = (entry) => {
    if (entry.lift === undefined) {
      entry.denyKey = undefined;
      entry.denyCount = 0;
      return;
    }
    entry.applying = true;
    try {
      try { entry.lift(); } catch { /* 已撤销 */ }
      entry.lift = undefined;
      entry.denyKey = undefined;
      entry.denyCount = 0;
    } finally {
      entry.applying = false;
    }
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
      entry.offCount = 0;
      dropDeny(entry);
      return { resident: [], ondemand: [], off: [], deny: [], visible: visibleOf(agent), own: new Set() };
    }
    const plan = planFor(agent);
    entry.catalogText = renderCatalog({
      tools: plan.ondemand,
      skills: entry.skills,
      sections: sectionEntriesFor(entry),
    }, policy.catalog);
    entry.offCount = plan.off.length;
    if (tools === undefined) { entry.denyCount = 0; return plan; }
    let restrictable = null;
    try {
      const view = tools.view?.(agent);
      if (view && view.restrictableNames instanceof Set) restrictable = view.restrictableNames;
    } catch { /* 忽略 */ }
    const deny = restrictable === null ? plan.deny : plan.deny.filter((name) => restrictable.has(name));
    const key = deny.slice().sort().join("|");
    if (entry.denyKey === key && (entry.lift !== undefined || deny.length === 0)) return plan;
    entry.applying = true;
    try {
      if (entry.lift !== undefined) {
        try { entry.lift(); } catch { /* 已撤销 */ }
        entry.lift = undefined;
      }
      entry.denyCount = 0;
      if (deny.length > 0) {
        try {
          entry.lift = tools.restrict({ deny });
          entry.denyCount = deny.length;
        } catch (error) {
          warn("建立工具限制失败 — " + String((error && error.message) || error));
        }
      }
      entry.denyKey = key;
    } finally {
      entry.applying = false;
    }
    return plan;
  };

  /** 是否有任何 agent 正在应用限制（此时 tools/change 是自己引起的，别跟着重算）。 */
  const isApplying = () => {
    for (const entry of entries.values()) if (entry.applying === true) return true;
    return false;
  };

  const load = async (agent, names) => {
    const entry = attach(agent);
    if (entry === undefined) return { loaded: [], unknown: [] };
    await entry.ready;
    const wanted = (Array.isArray(names) ? names : [names]).map((n) => String(n || "").trim()).filter(Boolean);
    // 校验必须对“未被限制的全局视图”，否则第二层的名字永远认不出来。
    const visible = globalView().visible;
    const accepted = [];
    const unknown = [];
    for (const name of wanted) {
      if (name.startsWith("section:")) { entry.loaded.add(name); accepted.push(name); continue; }
      if (!visible.has(name)) { unknown.push(name); continue; }
      entry.loaded.add(name);
      accepted.push(name);
    }
    reapply(agent);
    return { loaded: accepted, unknown };
  };

  /** 代理执行：临时撤掉限制 → 走宿主完整管线 → 立刻恢复。parent 必须透传，否则 PTC 折叠成 UNKNOWN_TOOL。 */
  const callThrough = async (agent, name, args, signal, parent) => {
    const entry = attach(agent);
    if (entry === undefined) throw new Error("dsh-gate: 没有可用的 agent 上下文");
    await entry.ready;
    const tools = scopedToolsOf(agent);
    if (tools === undefined) throw new Error("dsh-gate: scoped tools 不可用");
    // 撤限制/恢复限制都会发 tools/change；不标 applying 的话每次 gate_call 会多触发两轮全量重算。
    entry.applying = true;
    try {
      const lift = entry.lift;
      if (lift !== undefined) {
        try { lift(); } catch { /* 忽略 */ }
        entry.lift = undefined;
        entry.denyKey = undefined;
      }
      return await tools.execute({
        callId: randomUUID(),
        name,
        agent,
        arguments: args,
        signal,
        ...(parent === undefined ? {} : { parent }),
      });
    } finally {
      entry.applying = false;
      reapply(agent);
    }
  };

  /**
   * 权威归层表（只给 UI 用，不进 gate_status 的 schema）。
   * UI 不该靠“有没有 overrides 条目”猜层：own 层工具没有条目，会被猜成按需（真事故）。
   */
  const tierMap = (agent) => {
    const entry = entries.get(agent);
    const plan = planFor(agent);
    const loadedSet = entry ? entry.loaded : new Set();
    const tiers = {};
    for (const name of plan.visible.keys()) {
      if (plan.own.has(name) || loadedSet.has(name)) tiers[name] = TIER_RESIDENT;
      else tiers[name] = tierForTool(policy, name);
    }
    return { tiers, ownNames: [...plan.own].sort() };
  };

  const status = (agent) => {
    const entry = attach(agent);
    const plan = planFor(agent);
    return {
      enabled: policy.enabled !== false,
      policyFile: policy.policyFile,
      visible: plan.visible.size,
      resident: plan.resident.length,
      onDemand: plan.ondemand.length,
      off: plan.off.length,
      gated: entry ? entry.denyCount : 0,
      loaded: entry ? [...entry.loaded] : [],
      catalogChars: entry ? entry.catalogText.length : 0,
      catalogTokens: estimateTokens(entry ? entry.catalogText : ""),
      residentNames: plan.resident,
      onDemandNames: plan.ondemand.map((t) => t.name),
      offNames: plan.off,
      ownNames: [...plan.own].sort(),
      sections: (entry ? entry.sections : []).map((section) => ({
        name: section.name,
        chars: section.chars,
        tokens: section.tokens,
        gated: tierForSection(policy, section.name) !== TIER_RESIDENT,
      })),
      skills: entry ? entry.skills.map((skill) => skill.name) : [],
    };
  };

  /** 记录本轮实际存在的段落清单（名字 + 体积），UI 与 gate_status 直接读它。 */
  const recordSections = (agent, inventory) => {
    const entry = entries.get(agent);
    if (entry === undefined) return;
    // 并集而不是覆盖：被摘掉的段落下一次 assemble 就不会再出现在清单里了，
    // 覆盖写会让“可加载的段落”清单逐个消失（目录里也就查不到）。
    const merged = new Map();
    for (const item of entry.sections || []) merged.set(item.name, item);
    for (const item of Array.isArray(inventory) ? inventory : []) merged.set(item.name, item);
    entry.sections = [...merged.values()].sort((a, b) => b.chars - a.chars).slice(0, 120);
    // 必须重算目录：否则被摘掉的段落虽然“可 gate_load 加载”，目录里却从没出现过它，
    // 模型永远不知道有这段（两者一起才是闭环）。
    reapply(agent);
  };

  /** 技能目录被摘掉后，把技能名记下来，好让 gate 目录列出来（下一次 assemble 生效）。 */
  const rememberSkills = (agent, skills) => {
    const entry = entries.get(agent);
    if (entry === undefined) return;
    const next = Array.isArray(skills) ? skills : [];
    // 每一步 pre-step 都会走到这里；名单没变就别重算（否则非 PTC profile 每轮多一次全量 reapply）。
    const before = (entry.skills || []).map((s) => s.name).join("\u0000");
    const after = next.map((s) => s.name).join("\u0000");
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
    if (entry.lift !== undefined) { try { entry.lift(); } catch { /* 忽略 */ } }
    try { await entry.fiber?.dispose?.(); } catch { /* 忽略 */ }
  };

  const releaseAll = async () => {
    for (const agent of [...entries.keys()]) await release(agent);
  };

  return { entries, attach, visibleOf, planFor, planSections, reapply, isApplying, load, callThrough, status, tierMap, catalogFor, rememberSkills, recordSections, release, releaseAll };
}