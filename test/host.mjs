/**
 * 测试宿主单 seam（票 01）—— 三份测试共用的假宿主，仓内唯一的 view / restrict 实现。
 *
 * 只模拟宿主 tools 服务的对外语义，不模拟 gate 的任何内部字段：
 *  - view(scope)：visible / restrictableNames / knownNames 三件套。
 *      scope 省略 = 全局视图（不受任何 agent 限制影响）。
 *  - restrict({deny})：记录调用、返回可撤销句柄；对未知名字或自有层名字抛错（与真实宿主同）。
 *  - register / execute：注册工具、按名字执行。
 * 一次「系统提示词装配」与一次「agent 前-step」各有入口，供段落闸门与技能闸门断言。
 *
 * 用法：
 *   const host = makeHost();                       // 默认工具面 + 一个 agent
 *   const host = makeHost({ preset: ["pwsh"] });    // agent preset 平面（全局视图看不到）
 *   const host = makeHost({ names: ["read"] });     // 自定义工具面
 *   const host = makeHost({ id: "a1", names: [...] }); // 指定首个 agent 的 id 与工具面
 *   const child = host.addAgent({ id: "c", origin: "subagent", names: [...], own: [...] });
 *   host.setExecutor(agent, makePtcExecutor());   // 选中 PTC / native 执行器（工单 07）
 *   const host = makeHost({ conditional: ["univer_status"] }); // 带 when 的 conditional 注册（0.5.4）
 *
 * view(scope) 还带 registrations（name → {definition, when}）：真实宿主把 when 留在注册面上，
 * restriction 只影响 visible —— 技能激活放行（gate.js conditionalNamesOf）读的就是这一份。
 */

/** PTC 传输：只进 visible，不进 restrictableNames（所以闸门把它算成自有层）。 */
export const TRANSPORT = "run_code";

/**
 * 执行器替身（工单 07 的 PTC 判据）。
 * 类名与真实 dist 一致：闸门先看 constructor.name。describe() 只投影 run_code 的是 PTC；
 * 投影多条声明的是 native；什么都没给的是「认不出来」→ 闸门必须 fail-open。
 */
class PtcExecutor {
  describe() { return { schemas: [{ name: TRANSPORT }] }; }
}
class NativeToolExecutor {
  describe() { return { schemas: [{ name: "read" }, { name: "pwsh" }] }; }
}
class OpaqueExecutor {
  describe() { return { schemas: [] }; }
}
export const makePtcExecutor = () => new PtcExecutor();
export const makeNativeExecutor = () => new NativeToolExecutor();
export const makeOpaqueExecutor = () => new OpaqueExecutor();

export const DEFAULT_TOOL_NAMES = [
  "pwsh", "read", "write", "edit", "grep", "glob", "web_search", "web_fetch", "ws_mcp_call", "skill",
  "univer_sheet", "univer_doc", "office_docx", "ssh_exec", "mnemon_recall", "todo_write", "terminal_open",
  "gate_status", "gate_search", "gate_load", "gate_call",
];

const desc = (name) => name + " 工具的说明文字。第二句不该出现。";

function definitionOf(name) {
  return {
    name,
    description: desc(name),
    execute: async (args) => ({ content: [{ type: "text", text: name + " ok " + JSON.stringify(args) }] }),
  };
}

export function makeHost(options) {
  const opts = options || {};
  const presetNames = new Set(opts.preset || []);
  const registry = new Map();
  for (const name of opts.names || DEFAULT_TOOL_NAMES) registry.set(name, definitionOf(name));
  // conditional 注册：真实宿主 registration.when 是 step admission 的谓词（dsh-tools resolve()）。
  // 测试里固定 true —— 闸门只看「有没有 when」，不看它此刻求值成什么。
  const conditional = new Set(opts.conditional || []);
  const whenOf = (name) => (conditional.has(name) ? () => true : undefined);
  /** 与真实 view() 同形：registrations 覆盖 visible 的每个名字（when 可 undefined）。 */
  const registrationsOf = (visible) => {
    const out = new Map();
    for (const [name, definition] of visible) out.set(name, { definition, when: whenOf(name) });
    return out;
  };

  const logs = [];
  const logger = {
    info: (message) => logs.push("info " + message),
    warn: (message) => logs.push("warn " + message),
    debug: (message) => logs.push("debug " + message),
  };

  const handlers = new Map();
  const calls = [];
  const restrictionsByAgent = new Map();

  const ownOf = (agent) => new Set([TRANSPORT, ...((agent && agent.own) || [])]);
  const namesOf = (agent) => (agent && Array.isArray(agent.names) ? agent.names.slice() : [...registry.keys()]);
  const setsOf = (agent) => {
    if (!restrictionsByAgent.has(agent)) restrictionsByAgent.set(agent, []);
    return restrictionsByAgent.get(agent);
  };
  const deniedOf = (agent) => {
    const denied = new Set();
    for (const set of setsOf(agent)) for (const name of set) denied.add(name);
    return denied;
  };

  /** 全局视图（无 scope）：agent preset 平面看不到，也不受任何 agent 的限制影响。 */
  const globalView = () => {
    const visible = new Map();
    for (const [name, definition] of registry) {
      if (presetNames.has(name)) continue;
      visible.set(name, definition);
    }
    visible.set(TRANSPORT, { name: TRANSPORT, description: "ptc transport" });
    // 真实宿主：run_code 只进 visible，不进 restrictableNames / knownNames（所以闸门把它算自有层）。
    const restrictable = new Set([...visible.keys()].filter((name) => name !== TRANSPORT));
    return {
      visible,
      registrations: registrationsOf(visible),
      restrictableNames: restrictable,
      knownNames: new Set(restrictable),
    };
  };

  /** agent 视图：registry（含 preset 平面）∪ 自有层，减去该 agent 身上生效的 restrict。 */
  const agentView = (agent) => {
    const denied = deniedOf(agent);
    const visible = new Map();
    for (const name of namesOf(agent)) {
      if (denied.has(name)) continue;
      visible.set(name, registry.get(name) || definitionOf(name));
    }
    for (const name of ownOf(agent)) {
      if (visible.has(name) || denied.has(name)) continue;
      visible.set(name, { name, description: "own layer" });
    }
    const restrictable = new Set(namesOf(agent).filter((name) => !ownOf(agent).has(name)));
    // knownNames = **注册面**（真实宿主口径）：别人的 restrict({allow}) 只收窄 visible，
    // 不会把它改小。测试要复现这一点时给 agent 传 registered（默认仍等于本 agent 的工具面）。
    const registered = Array.isArray(agent.registered) ? agent.registered : namesOf(agent);
    return {
      visible,
      registrations: registrationsOf(visible),
      restrictableNames: restrictable,
      knownNames: new Set([...registered, ...ownOf(agent)].filter((name) => name !== TRANSPORT)),
    };
  };

  const record = (kind, agent, names) => {
    const row = { kind, agent, deny: [...names] };
    calls.push(row);
    if (agent) {
      if (!Array.isArray(agent.restrictCalls)) agent.restrictCalls = [];
      if (kind === "restrict") agent.restrictCalls.push({ deny: row.deny });
    }
    return row;
  };

  /** 建立一条限制；返回可撤销句柄（撤销时把名字真的放回去）。 */
  const restrictFor = (agent, filter) => {
    const deny = [...((filter && filter.deny) || [])];
    const own = ownOf(agent);
    for (const name of deny) {
      if (own.has(name) || !registry.has(name)) throw new Error("tools.restrict() names unknown global tool " + name);
    }
    const set = new Set(deny);
    setsOf(agent).push(set);
    const row = record("restrict", agent, set);
    return () => {
      const list = setsOf(agent);
      const index = list.indexOf(set);
      if (index < 0) return;
      list.splice(index, 1);
      record("lift", agent, set);
      if (row) row.lifted = true;
    };
  };

  // 选中执行器（宿主 tools.selectExecutor(agent)）：不设置 = 闸门判不出来，必须 fail-open。
  const executors = new Map();

  const tools = {
    view(scope) {
      return scope === undefined ? globalView() : agentView(scope);
    },
    selectExecutor(scope) {
      return executors.get(scope);
    },
    restrict(filter) {
      // 真实宿主：restrict 必须有 agent scope，根 ctx 上调会直接抛错。
      throw new Error("tools.restrict() requires an agent-scoped ctx");
    },
    register(definition) {
      registry.set(definition.name, definition);
      return () => { registry.delete(definition.name); };
    },
    async execute(input) {
      const view = input && input.agent !== undefined ? agentView(input.agent) : globalView();
      const definition = view.visible.get(input.name);
      if (definition === undefined) throw new Error("UNKNOWN_TOOL: " + input.name);
      return definition.execute(input.arguments, input);
    },
  };

  const listeners = (event) => {
    if (!handlers.has(event)) handlers.set(event, []);
    return handlers.get(event);
  };

  /**
   * ctx.emit：与 cordis 同语义 —— 记一笔然后同步派发给同名监听者。
   * 0.5.3 起要测「技能激活转发」（gate_load 成功后补发 tools/result），所以这里必须能
   * 断言「发出了什么」，而不只是「谁能收」。
   */
  const emitted = [];
  /**
   * 监听者抛错会被记下来而不是静默吞掉（真实 cordis 的 emit 没有 try/catch：一个监听者抛错
   * 就中断后续监听者）。这里保留「继续派发」以免单个坏桩打断用例，但把异常交给用例断言 ——
   * 0.5.3 复审 B1 正是「伪事件的 exec 缺字段、真实监听者抛 TypeError、后面的监听者收不到」，
   * 这条记录就是抓它的钩子。
   */
  const emittedErrors = [];
  const emit = (event, ...args) => {
    emitted.push({ event, args });
    for (const handler of listeners(event).slice()) {
      try { handler(...args); } catch (error) { emittedErrors.push({ event, error }); }
    }
  };

  const on = (event, handler, subscribeOptions) => {
    const list = listeners(event);
    if (subscribeOptions && subscribeOptions.prepend) list.unshift(handler);
    else list.push(handler);
    return () => {
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  };

  const makeAgent = (config) => {
    const spec = config || {};
    const agent = { id: spec.id || "agent-1", names: spec.names, own: spec.own || [], registered: spec.registered };
    if (spec.origin !== undefined) agent.session = { header: { origin: spec.origin } };
    const scopedTools = {
      view: () => agentView(agent),
      restrict: (filter) => restrictFor(agent, filter),
      execute: (input) => tools.execute({ ...input, agent }),
    };
    agent.ctx = {
      tools: scopedTools,
      on,
      emit,
      effect: (callback) => callback(),
      // 与宿主同：拿 scoped ctx 的唯一正路是 agent.ctx.plugin({inject:["tools"]})。
      plugin(descriptor) {
        try { descriptor.apply({ tools: scopedTools, on, effect: (callback) => callback() }); }
        catch { /* 与宿主同：失败只降级 */ }
        return { dispose() { /* noop */ } };
      },
    };
    return agent;
  };

  const agents = [];
  const addAgent = (config) => {
    const agent = makeAgent(config);
    agents.push(agent);
    return agent;
  };
  const agent = addAgent({ id: opts.id || "agent-1" });

  const rootCtx = {
    tools,
    logger,
    agents: { roots: () => agents.slice() },
    on,
    emit,
    inject(_deps, callback) { return callback(rootCtx); },
    effect: (callback) => callback(),
  };

  return {
    tools,
    rootCtx,
    agent,
    agents,
    logger,
    logs,
    handlers,
    registry,
    preset: presetNames,
    calls,
    emitted,
    emittedErrors,
    addAgent,
    makeAgent,
    addPreset(name, definition) {
      presetNames.add(name);
      if (!registry.has(name)) registry.set(name, definition || definitionOf(name));
      return () => { presetNames.delete(name); };
    },
    setExecutor(agent, executor) {
      if (executor === undefined) executors.delete(agent);
      else executors.set(agent, executor);
      return () => { executors.delete(agent); };
    },
    restrictions() {
      const out = [];
      for (const sets of restrictionsByAgent.values()) for (const set of sets) out.push(set);
      return out;
    },
    restrictionsFor: (agent) => setsOf(agent).slice(),
    restrictCalls: (agent) => calls.filter((row) => row.agent === agent),
    visibleOf: (agent) => (agent === undefined ? globalView() : agentView(agent)).visible,
    namesOf,
    hasTool: (name) => registry.has(name),
    tool: (name) => registry.get(name),
    /** 跑一次「系统提示词装配」，返回装配结果。 */
    assemble(assembly, agent) {
      const list = listeners("system-prompt/assemble");
      let current = async () => assembly;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const handler = list[i];
        const inner = current;
        current = () => handler(assembly, { scope: agent }, inner);
      }
      return current();
    },
    /**
     * 跑一次「工具执行后」（tools/post-execute），返回最终决策。
     * 与真实宿主同签名：(exec, result, next) —— 护栏这类监听者要先委派再折上下文。
     */
    postExecute(exec, result) {
      const list = listeners("tools/post-execute");
      let current = async () => ({ kind: "accept" });
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const handler = list[i];
        const inner = current;
        current = () => handler(exec, result, inner);
      }
      return current();
    },
    /**
     * 跑一次「agent 前-step」，返回决策结果。
     * messages 要能传：护栏靠「这一步有没有用户插话」决定是否清状态（0.5.3）。
     */
    preStep(decision, agent, messages) {
      const list = listeners("agent/pre-step");
      let current = async () => decision;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const handler = list[i];
        const inner = current;
        current = () => handler({ agent, messages }, inner);
      }
      return current();
    },
    hookCount(event) {
      return listeners(event).length;
    },
  };
}
