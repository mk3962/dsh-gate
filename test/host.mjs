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
    return { visible, restrictableNames: restrictable, knownNames: new Set(restrictable) };
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
    return {
      visible,
      restrictableNames: restrictable,
      knownNames: new Set([...namesOf(agent), ...ownOf(agent)].filter((name) => name !== TRANSPORT)),
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
    const agent = { id: spec.id || "agent-1", names: spec.names, own: spec.own || [] };
    if (spec.origin !== undefined) agent.session = { header: { origin: spec.origin } };
    const scopedTools = {
      view: () => agentView(agent),
      restrict: (filter) => restrictFor(agent, filter),
      execute: (input) => tools.execute({ ...input, agent }),
    };
    agent.ctx = {
      tools: scopedTools,
      on,
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
    /** 跑一次「agent 前-step」，返回决策结果。 */
    preStep(decision, agent) {
      const list = listeners("agent/pre-step");
      let current = async () => decision;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const handler = list[i];
        const inner = current;
        current = () => handler({ agent }, inner);
      }
      return current();
    },
    hookCount(event) {
      return listeners(event).length;
    },
  };
}
