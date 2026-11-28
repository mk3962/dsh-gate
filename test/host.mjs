/**
 * 测试宿主 seam（票 01 · S1 宿主契约）—— 仓内唯一的假宿主，三份旧测试 + 新契约夹具共用。
 *
 * 只模拟宿主 tools 服务的对外语义，不模拟 gate 的任何内部字段：
 *  - view(scope)：visible / registrations / restrictableNames / knownNames 四件套。
 *      scope 省略 = 全局视图（不受任何 agent 限制影响）。
 *  - restrict({deny} | {allow})：真实契约的完整投影（票 01 收口 FG-2，见下）。
 *  - register / execute：注册工具、按名字执行。
 *  - emit（广播）/ emitIsolated（逐个派发）：两种派发时序（FG-1）。
 *  - sessions：会话表面回放（FG-3）。
 *  - lifecycle：撤销器账本，dispose() 强制执行并记泄漏（FG-4）。
 *
 * 六条宿主事实（契约测试逐条断言，见 test/seams/s1-host-contract.test.mjs）：
 *  1) 双派发语义：广播遇抛错即中断并上抛；隔离派发逐监听者收集错误。
 *  2) 限制完整契约：两种目标形状、同形幂等短路、句柄身份、受保护名抛错。
 *  3) 视图三件套与注册面：visible / registrations / restrictableNames / knownNames + 注册动作进账。
 *  4) 会话表面：追加式消息列表、表面查询、事件定位（尾块自愈的可观测面）。
 *  5) 撤销器生命周期：hook / tool / effect / inject / preset / timer / connection / scope 全登记。
 *  6) 消息构造两态：由 test/stub-resolver.mjs 的 DSH_GATE_STUB_LLM 开关驱动（本文件只提供宿主侧入口）。
 *
 * 四本账（只读访问器 readLedger(name)，另导出 ledgers 活引用给同文件夹具用）：
 *  - restrictions：限制动作（apply / noop / lift / lift-noop / reject / apply-seeded），有序。
 *  - dispatches：一次派发的汇总（mode / listeners / delivered / failed / aborted）。
 *  - deliveries：逐监听者投递结果（index / status / error）。
 *  - lifecycle：撤销器登记与执行（kind / surface / status），注册面也落在这里。
 *
 * 用法（完全向后兼容 0.5.7 的既有调用）：
 *   const host = makeHost();                       // 默认工具面 + 一个 agent
 *   const host = makeHost({ preset: ["pwsh"] });    // agent preset 平面（全局视图看不到）
 *   const host = makeHost({ names: ["read"] });     // 自定义工具面
 *   const host = makeHost({ id: "a1", names: [...] }); // 指定首个 agent 的 id 与工具面
 *   const host = makeHost({ protected: ["gate_status"] }); // 受保护工具名（摘除即抛）
 *   const host = makeHost({ session: true });       // 自动给 agent 挂会话表面
 *   const child = host.addAgent({ id: "c", origin: "subagent", names: [...], own: [...] });
 *   host.setExecutor(agent, makePtcExecutor());   // 选中 PTC / native 执行器（工单 07）
 *   const host = makeHost({ conditional: ["univer_status"] }); // 带 when 的 conditional 注册（0.5.4）
 *
 * view(scope) 还带 registrations（name → {definition, when}）：真实宿主把 when 留在注册面上，
 * restriction 只影响 visible —— 技能激活放行（gate.js conditionalNamesOf）读的就是这一份。
 */

import { createHash } from "node:crypto";

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
  "gate_status", "gate_search", "gate_load", "gate_invoke",
];

/** 派发时序（一致性夹具的对拍口径）。 */
export const DISPATCH_BROADCAST = "broadcast";
export const DISPATCH_ISOLATED = "isolated";

/** 限制目标形状（真实宿主 tools.restrict 的两种入参）。 */
export const TARGET_DENY = "deny";
export const TARGET_ALLOW = "allow";

const desc = (name) => name + " 工具的说明文字。第二句不该出现。";

const messageOf = (error) => String((error && error.message) || error);
const copy = (value) => JSON.parse(JSON.stringify(value));

function definitionOf(name) {
  return {
    name,
    description: desc(name),
    execute: async (args) => ({ content: [{ type: "text", text: name + " ok " + JSON.stringify(args) }] }),
  };
}

const sortedUnique = (names) => [...new Set(names)].sort();

/**
 * 会话表面（FG-3）：真实宿主给 agent.session 的是「节点序列 + 按节点取事件」。
 * 这里只投影 gate 用得到的那一层：
 *   session.surface.nodes  —— 节点 id 序列（追加式，末尾是最新）
 *   session.eventAt(id)    —— { type: "user/message", data: { message } }
 * 另加 surface()/locate()/textOf() 三个查询口，供契约夹具读事实而不是读内部数组。
 */
export function createSessionStore(options) {
  const opts = options || {};
  const events = [];
  let nextId = 1;
  const header = { ...(opts.header || {}) };

  const session = {
    header,
    surface: {
      get nodes() { return events.map((event) => event.id); },
    },
    eventAt(id) {
      const hit = events.find((event) => event.id === id);
      return hit === undefined ? undefined : { type: hit.type, data: hit.data };
    },
    append(message) {
      if (message === undefined || message === null) throw new Error("session.append() requires a message");
      return session.appendEvent("user/message", { message });
    },
    appendEvent(type, data) {
      const id = nextId;
      nextId += 1;
      events.push({ id, type, data });
      return id;
    },
    /** 表面查询：只给可断言的摘要（角色 / 来源 / 长度 / 指纹），不把正文整段交出去。 */
    surfaceSummary() {
      return events.map((event) => {
        const data = event.data || {};
        const message = data.message !== undefined ? data.message : data;
        const text = textOfMessage(message);
        const source = message && typeof message === "object" ? message.source : undefined;
        return {
          id: event.id,
          type: event.type,
          role: message && message.role,
          kind: source && typeof source === "object" ? source.kind : undefined,
          textLength: text.length,
          textDigest: createHash("sha1").update(text).digest("hex").slice(0, 12),
        };
      });
    },
    /** 事件定位：从末尾往前找，返回第一条命中的节点（找不到返回 undefined）。 */
    locate(predicate) {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        const data = event.data || {};
        const message = data.message !== undefined ? data.message : data;
        const row = { id: event.id, type: event.type, message, text: textOfMessage(message) };
        let hit = false;
        try { hit = predicate(row) === true; } catch { hit = false; }
        if (hit) return row;
      }
      return undefined;
    },
    textOf(id) {
      const event = events.find((row) => row.id === id);
      if (event === undefined) return undefined;
      const data = event.data || {};
      return textOfMessage(data.message !== undefined ? data.message : data);
    },
    count() { return events.length; },
    ids() { return events.map((event) => event.id); },
    dispose() { events.length = 0; },
  };
  if (Array.isArray(opts.messages)) for (const message of opts.messages) session.append(message);
  return session;
}

/** 单段正文提取（只认 text 块；结构化块原样保留在 message.content 里）。 */
export function textOfMessage(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block && block.type === "text").map((block) => block.text).join("");
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

  // ── 四本观测账（票 01） ────────────────────────────────────────────────────
  const ledgers = { restrictions: [], dispatches: [], deliveries: [], lifecycle: [] };
  let seq = 0;
  const nextSeq = () => { seq += 1; return seq; };
  /** 只读访问器：深拷贝，调用方改了也污染不了账本。 */
  const readLedger = (name) => {
    if (!Object.prototype.hasOwnProperty.call(ledgers, name)) throw new Error("unknown ledger: " + name);
    return copy(ledgers[name]);
  };
  const ledgerCount = (name) => readLedger(name).length;
  const restrictionRow = (action, agent, extra) => {
    const row = Object.assign(
      { seq: nextSeq(), action, agentId: agent && agent.id !== undefined ? agent.id : undefined },
      extra || {},
    );
    ledgers.restrictions.push(row);
    return row;
  };
  /** 施加次数（幂等断言的唯一口径：noop 不增加它）。 */
  const applyCount = (agent) => ledgers.restrictions.filter(
    (row) => row.agentId === (agent && agent.id) && (row.action === "apply" || row.action === "apply-seeded"),
  ).length;

  // ── 生命周期账本（FG-4） ──────────────────────────────────────────────────
  const liveTimers = new Set();
  const liveConnections = new Set();
  const liveScopes = new Set();
  let liveInjections = 0;
  let handleSeq = 0;

  const trackDisposer = (kind, dispose, meta) => {
    const row = {
      seq: nextSeq(),
      kind,
      surface: (meta && meta.surface) || kind,
      id: kind + "-" + nextSeq(),
      status: "registered",
      meta: meta || {},
      result: undefined,
      error: undefined,
    };
    ledgers.lifecycle.push(row);
    let done = false;
    const wrapped = () => {
      if (done) { row.status = "already-disposed"; return; }
      done = true;
      row.status = "disposed";
      try { dispose(); row.result = "ok"; } catch (error) { row.result = "threw"; row.error = messageOf(error); }
    };
    wrapped.id = row.id;
    wrapped.row = row;
    // 账本行的可执行入口（readLedger 拷贝时会被 JSON 丢掉，只有活账本能用它）。
    row.run = wrapped;
    return wrapped;
  };

  const liveOf = () => ({
    hooks: [...handlers.values()].reduce((sum, list) => sum + list.length, 0),
    injections: liveInjections,
    timers: liveTimers.size,
    connections: liveConnections.size,
    scopes: liveScopes.size,
    effects: ledgers.lifecycle.filter((row) => row.kind === "effect" && row.status === "registered").length,
    tools: registry.size,
  });

  // ── 限制契约（FG-2） ──────────────────────────────────────────────────────
  const restrictedOwners = new Map(); // agent -> Map(key -> entry)
  const ownerOf = (agent) => {
    if (!restrictedOwners.has(agent)) restrictedOwners.set(agent, new Map());
    return restrictedOwners.get(agent);
  };
  const ownOf = (agent) => new Set([TRANSPORT, ...((agent && agent.own) || [])]);
  const namesOf = (agent) => (agent && Array.isArray(agent.names) ? agent.names.slice() : [...registry.keys()]);
  const setsOf = (agent) => {
    if (!restrictionsByAgent.has(agent)) restrictionsByAgent.set(agent, []);
    return restrictionsByAgent.get(agent);
  };
  /** 兼容口径：只回 deny 形状的集合（restrictions() / restrictionsFor() 的既有语义）。 */
  const deniedOf = (agent) => {
    const denied = new Set();
    for (const set of setsOf(agent)) for (const name of set) denied.add(name);
    return denied;
  };
  const allowSetsOf = (agent) => [...ownerOf(agent).values()]
    .filter((entry) => entry.shape === TARGET_ALLOW)
    .map((entry) => entry.set);
  const protectedNames = new Set(opts.protected || []);

  const normalizeTarget = (agent, filter) => {
    if (filter === null || typeof filter !== "object") {
      throw new Error("tools.restrict() requires a target object ({deny} or {allow})");
    }
    const hasDeny = Object.prototype.hasOwnProperty.call(filter, "deny");
    const hasAllow = Object.prototype.hasOwnProperty.call(filter, "allow");
    if (hasDeny && hasAllow) throw new Error("tools.restrict() takes exactly one target shape (deny | allow)");
    if (!hasDeny && !hasAllow) throw new Error("tools.restrict() requires {deny} or {allow}");
    const shape = hasDeny ? TARGET_DENY : TARGET_ALLOW;
    const raw = hasDeny ? filter.deny : filter.allow;
    const list = Array.isArray(raw) ? raw : [];
    for (const name of list) {
      if (typeof name !== "string" || name.length === 0) throw new Error("tools.restrict() names must be non-empty strings");
    }
    const names = sortedUnique(list);
    const own = ownOf(agent);
    if (shape === TARGET_DENY) {
      // 与真实宿主同：点自己的层或压根没注册的名字直接抛（静默忽略会让限制看着生效其实没生效）。
      for (const name of names) {
        if (own.has(name) || !registry.has(name)) throw new Error("tools.restrict() names unknown global tool " + name);
      }
      const hit = names.filter((name) => protectedNames.has(name));
      if (hit.length > 0) {
        const error = new Error("tools.restrict() refuses to strip protected tool " + hit.join(", "));
        error.code = "PROTECTED_TOOL";
        error.protectedNames = hit;
        throw error;
      }
      return { shape, names, notes: [] };
    }
    // allow 形状（只保留这些）：own 层不可限制、未知名字不进白名单（记账说明，不抛）。
    const notes = [];
    const allowed = [];
    for (const name of names) {
      if (own.has(name)) { notes.push({ name, reason: "own-layer-not-restrictable" }); continue; }
      if (!registry.has(name)) { notes.push({ name, reason: "unknown-name-ignored" }); continue; }
      allowed.push(name);
    }
    const restrictable = namesOf(agent).filter((name) => !own.has(name));
    const stripped = restrictable.filter((name) => !allowed.includes(name));
    const hit = stripped.filter((name) => protectedNames.has(name));
    if (hit.length > 0) {
      const error = new Error("tools.restrict() refuses to strip protected tool " + hit.join(", "));
      error.code = "PROTECTED_TOOL";
      error.protectedNames = hit;
      throw error;
    }
    return { shape, names: allowed, notes };
  };

  const releaseEntry = (agent, entry) => {
    const own = ownerOf(agent);
    // 句柄身份校验（FG-2）：过期 / 已被别人替换的句柄释放只能是空操作，并进账。
    if (entry.released === true) {
      restrictionRow("lift-noop", agent, { reason: "already-released", handleId: entry.handleId });
      return false;
    }
    if (own.get(entry.key) !== entry) {
      entry.released = true;
      restrictionRow("lift-noop", agent, { reason: "stale-handle", handleId: entry.handleId });
      return false;
    }
    own.delete(entry.key);
    entry.released = true;
    if (entry.shape === TARGET_DENY) {
      const sets = setsOf(agent);
      const index = sets.indexOf(entry.set);
      if (index >= 0) sets.splice(index, 1);
      const row = record("lift", agent, entry.set);
      row.lifted = true;
    }
    restrictionRow("lift", agent, { shape: entry.shape, names: entry.names.slice(), handleId: entry.handleId });
    return true;
  };

  const applyRestriction = (agent, filter) => {
    let target;
    try {
      target = normalizeTarget(agent, filter);
    } catch (error) {
      restrictionRow("reject", agent, {
        reason: error.code || "invalid-target",
        message: messageOf(error),
        shape: filter && (Object.prototype.hasOwnProperty.call(filter, "allow") ? TARGET_ALLOW : TARGET_DENY),
      });
      throw error;
    }
    const key = target.shape + "\u0000" + target.names.join("\u0000");
    const own = ownerOf(agent);
    const existing = own.get(key);
    // 同形幂等短路（FG-2）：一模一样的目标第二次零动作，返回同一个独占句柄。
    if (existing !== undefined && existing.released !== true) {
      restrictionRow("noop", agent, {
        reason: "same-target", shape: target.shape, names: target.names.slice(), handleId: existing.handleId,
      });
      return existing.handle;
    }
    const entry = {
      key,
      shape: target.shape,
      names: target.names.slice(),
      notes: target.notes,
      set: new Set(target.names),
      handleId: "restrict-" + (handleSeq += 1),
      released: false,
    };
    const handle = () => releaseEntry(agent, entry);
    handle.id = entry.handleId;
    handle.target = { shape: entry.shape, names: entry.names.slice() };
    handle.agent = agent;
    entry.handle = handle;
    own.set(key, entry);
    if (entry.shape === TARGET_DENY) {
      setsOf(agent).push(entry.set);
      record("restrict", agent, entry.set);
    }
    restrictionRow("apply", agent, {
      shape: entry.shape, names: entry.names.slice(), handleId: entry.handleId, notes: entry.notes,
    });
    return handle;
  };

  /** 测试用：模拟「另一条代码路径已经在宿主侧施加了同一目标」——用来构造过期句柄。 */
  const seedRestriction = (agent, names) => {
    const sorted = sortedUnique(names || []);
    const key = TARGET_DENY + "\u0000" + sorted.join("\u0000");
    const entry = { key, shape: TARGET_DENY, names: sorted, set: new Set(sorted), handleId: "seeded-" + (handleSeq += 1), released: false, seeded: true };
    ownerOf(agent).set(key, entry);
    setsOf(agent).push(entry.set);
    restrictionRow("apply-seeded", agent, { shape: TARGET_DENY, names: sorted, handleId: entry.handleId });
    return entry;
  };

  const passesRestriction = (agent, name) => {
    const entries = [...ownerOf(agent).values()];
    for (const entry of entries) {
      if (entry.released === true) continue;
      if (entry.shape === TARGET_DENY && entry.set.has(name)) return false;
    }
    const allows = entries.filter((entry) => entry.released !== true && entry.shape === TARGET_ALLOW);
    if (allows.length === 0) return true;
    if (ownOf(agent).has(name)) return true; // 自有层不受 allow 收窄
    return allows.every((entry) => entry.set.has(name));
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

  /** agent 视图：registry（含 preset 平面）∪ 自有层，减去该 agent 身上生效的限制（deny / allow）。 */
  const agentView = (agent) => {
    const visible = new Map();
    for (const name of namesOf(agent)) {
      if (!passesRestriction(agent, name)) continue;
      visible.set(name, registry.get(name) || definitionOf(name));
    }
    for (const name of ownOf(agent)) {
      if (visible.has(name) || !passesRestriction(agent, name)) continue;
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
      const dispose = trackDisposer("tool", () => { registry.delete(definition.name); }, { surface: "tool", name: definition.name });
      return dispose;
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
   * ctx.emit：与 cordis 同语义 —— 记一笔然后**同步广播**给同名监听者。
   * 0.5.3 起要测「技能激活转发」（gate_load 成功后补发 tools/result），所以这里必须能
   * 断言「发出了什么」，而不只是「谁能收」。
   */
  const emitted = [];
  /**
   * 广播语义（票 01 收口 FG-1）：真实 cordis 的 emit 是 dispatch().map(cb => cb(...args))，
   * **没有 try/catch** —— 一个监听者抛错就中断后续监听者并把异常抛回调用方。
   * 0.5.7 的假宿主逐个 try/catch 后继续派发，于是「零监听者/半路抛错」两种时序永远测不到。
   * 现在默认就是广播；需要逐个隔离的用例显式调 emitIsolated / host.emitIsolated。
   */
  const emittedErrors = [];
  const deliveriesOf = (event) => ledgers.deliveries.filter((row) => row.event === event);

  /**
   * 一次派发。mode=broadcast：遇抛错即中断并上抛（投递账里留下到哪一位中断）；
   * mode=isolated：逐监听者隔离，错误只进 failed / 投递账，不回抛。
   * 回执字段与真实监听者数一一对应：零监听者 delivered 恒为 0。
   */
  const runDispatch = (event, args, mode) => {
    const list = listeners(event).slice();
    const row = {
      seq: nextSeq(), event, mode, listeners: list.length, delivered: 0, failed: [], aborted: false, abortedAt: undefined,
    };
    ledgers.dispatches.push(row);
    for (let index = 0; index < list.length; index += 1) {
      const listener = list[index];
      try {
        listener(...args);
        row.delivered += 1;
        ledgers.deliveries.push({ seq: nextSeq(), event, mode, index, status: "ok" });
      } catch (thrown) {
        const message = messageOf(thrown);
        row.failed.push(message);
        ledgers.deliveries.push({ seq: nextSeq(), event, mode, index, status: "threw", error: message });
        emittedErrors.push({ event, error: thrown });
        if (mode === DISPATCH_BROADCAST) {
          row.aborted = true;
          row.abortedAt = index;
          throw thrown;
        }
      }
    }
    return row;
  };

  const emit = (event, ...args) => {
    emitted.push({ event, args });
    return runDispatch(event, args, DISPATCH_BROADCAST);
  };
  const emitIsolated = (event, ...args) => runDispatch(event, args, DISPATCH_ISOLATED);

  const on = (event, handler, subscribeOptions) => {
    const list = listeners(event);
    if (subscribeOptions && subscribeOptions.prepend) list.unshift(handler);
    else list.push(handler);
    const dispose = trackDisposer("hook", () => {
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    }, { surface: "hook", event, prepend: Boolean(subscribeOptions && subscribeOptions.prepend) });
    return dispose;
  };

  // ── 会话表面（FG-3） ──────────────────────────────────────────────────────
  const sessions = new Map(); // agent -> createSessionStore()
  const attachSession = (agent, spec) => {
    const store = createSessionStore(spec);
    sessions.set(agent, store);
    const header = (agent.session && agent.session.header) || {};
    agent.session = store;
    store.header = Object.assign({}, header, (spec && spec.header) || {});
    return store;
  };
  const sessionOf = (agent) => sessions.get(agent) || (agent && agent.session);

  const makeAgent = (config) => {
    const spec = config || {};
    const agent = { id: spec.id || "agent-1", names: spec.names, own: spec.own || [], registered: spec.registered };
    if (spec.origin !== undefined) agent.session = { header: { origin: spec.origin } };
    const scopedTools = {
      view: () => agentView(agent),
      restrict: (filter) => applyRestriction(agent, filter),
      execute: (input) => tools.execute({ ...input, agent }),
    };
    agent.ctx = {
      tools: scopedTools,
      on,
      emit,
      emitIsolated,
      effect: (callback) => {
        const result = callback();
        return typeof result === "function" ? trackDisposer("effect", result, { surface: "effect" }) : result;
      },
      // 与宿主同：拿 scoped ctx 的唯一正路是 agent.ctx.plugin({inject:["tools"]})。
      plugin(descriptor) {
        try {
          const result = descriptor.apply({
            tools: scopedTools, on, emit, emitIsolated, effect: (callback) => callback(),
          });
          return { dispose() { if (typeof result === "function") result(); } };
        } catch { /* 与宿主同：失败只降级 */ }
        return { dispose() { /* noop */ } };
      },
    };
    if (opts.session === true) attachSession(agent, { messages: opts.messages });
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
    emitIsolated,
    inject(_deps, callback) {
      liveInjections += 1;
      const result = callback(rootCtx);
      const release = () => { liveInjections -= 1; };
      if (typeof result === "function") {
        // cordis 的 inject 回调可以返回自己的 disposer：两者都要执行。
        return trackDisposer("inject", () => { release(); result(); }, { surface: "inject", deps: _deps, note: "callback-disposer" });
      }
      return trackDisposer("inject", release, { surface: "inject", deps: _deps });
    },
    effect: (callback) => {
      const result = callback();
      return typeof result === "function" ? trackDisposer("effect", result, { surface: "effect" }) : result;
    },
    /** 受追踪的定时器：dispose() 时强制执行（FG-4 的「存活定时器为零」）。 */
    timer(callback, ms) {
      const handle = setTimeout(() => { liveTimers.delete(entry); callback(); }, ms);
      const entry = trackDisposer("timer", () => { clearTimeout(handle); liveTimers.delete(entry); }, { surface: "timer", ms });
      liveTimers.add(entry);
      entry.clear = () => entry();
      return entry;
    },
    /** 受追踪的连接（MCP / SSE 之类）：close 后存活连接数归零。 */
    openConnection(label) {
      const token = { label: label || "connection", closed: false };
      liveConnections.add(token);
      const entry = trackDisposer("connection", () => { token.closed = true; liveConnections.delete(token); }, { surface: "connection", label: token.label });
      return entry;
    },
    /** 作用域：释放后到达的异步结果不许再改状态（FG-4 后半句）。 */
    createScope(label) {
      let alive = true;
      const scope = {
        label: label || "scope",
        get alive() { return alive; },
        run(callback) {
          if (!alive) return { skipped: true };
          return callback();
        },
        dispose() { alive = false; liveScopes.delete(scope); },
      };
      liveScopes.add(scope);
      const entry = trackDisposer("scope", () => scope.dispose(), { surface: "scope", label: scope.label });
      scope.dispose = () => { alive = false; liveScopes.delete(scope); entry(); };
      return scope;
    },
    /** 注册面（视图 / 路由 / 工具 / 钩子）：动作进生命周期账本，dispose 时撤掉。 */
    registerSurface(kind, name, dispose) {
      return trackDisposer("registration", typeof dispose === "function" ? dispose : () => undefined, { surface: kind, name });
    },
  };

  /**
   * cordis 的 per-listener 通道（0.5.5 激活信号隔离派发；0.7.2 升级为**任意事件 + 真瀑布**）。
   *
   * 真实宿主里 `ctx.events.dispatch(mode, args)` 只把绑定好的回调取出来、不执行；
   * 执行与 try/catch 由调用方负责（宿主自己的 emitPluginDisposed 就是这么用的）。
   * 两种 mode 的实参形状（cordis src/events.ts）：
   *   - "emit"      → args = [event, ...payload]，第 0 位就是事件名；
   *   - "waterfall" → args = [thisArg?, event, ...payload, inner]，带载体时第 0 位不是事件名。
   * 载荷里出现字符串事件名时，说明调用方没有给载体 —— 两种形状都要认，不能像 0.5.5 那样
   * 只硬编码 "tools/result"（票 01：gate 现在还要发 tools/post-execute，旧夹具会把瀑布吞成 0 监听者）。
   */
  if (opts.isolatedEvents === true) {
    rootCtx.events = {
      dispatch(type, args) {
        if (!Array.isArray(args)) return [];
        if (type !== "emit" && type !== "waterfall") return [];
        // 事件名 = 载荷里第一个字符串（载体是 scopeTarget 铸的对象，永远排在前面）。
        const event = args.find((token) => typeof token === "string");
        if (typeof event !== "string") return [];
        return listeners(event).slice();
      },
    };
  }

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
    // ── 票 01 新增：四本账 + 只读访问器 ──
    ledgers,
    readLedger,
    ledgerCount,
    applyCount,
    liveCounts: liveOf,
    broadcast: emit,
    emit,
    dispatchEvent: (event, args, mode) => (mode === DISPATCH_ISOLATED ? emitIsolated(event, ...(args || [])) : emit(event, ...(args || []))),
    emitIsolated,
    deliveriesOf,
    // ── 限制契约（FG-2） ──
    protectedNames,
    allowTargets: (agent) => allowSetsOf(agent).map((set) => [...set].sort()),
    activeTargets: (agent) => [...ownerOf(agent).values()].filter((entry) => entry.released !== true)
      .map((entry) => ({ shape: entry.shape, names: entry.names.slice(), handleId: entry.handleId })),
    seedRestriction,
    // ── 会话表面（FG-3） ──
    sessions,
    attachSession,
    sessionOf,
    createSessionStore,
    // ── 生命周期（FG-4） ──
    trackDisposer,
    disposers: ledgers.lifecycle,
    dispose() {
      // 释放顺序：后登记的先释放（cordis 的作用域退出顺序）。
      const rows = ledgers.lifecycle.filter((row) => row.status === "registered");
      let disposed = 0;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (typeof row.run !== "function") continue;
        row.run();
        disposed += 1;
      }
      sessions.clear();
      return { disposed, leaks: liveOf(), statuses: ledgers.lifecycle.map((row) => row.status) };
    },
    addAgent,
    makeAgent,
    addPreset(name, definition) {
      presetNames.add(name);
      if (!registry.has(name)) registry.set(name, definition || definitionOf(name));
      return trackDisposer("preset", () => { presetNames.delete(name); }, { surface: "preset", name });
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
     * 真实宿主会把返回的 messages 追加进会话表面 —— 挂了会话表面时这里照做（FG-3）。
     */
    async preStep(decision, agent, messages) {
      const list = listeners("agent/pre-step");
      let current = async () => decision;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const handler = list[i];
        const inner = current;
        current = () => handler({ agent, messages }, inner);
      }
      const result = await current();
      const store = sessions.get(agent);
      if (store !== undefined && result && Array.isArray(result.messages)) {
        const before = Array.isArray(decision && decision.messages) ? decision.messages : [];
        for (const message of result.messages) {
          if (before.includes(message)) continue; // 本轮输入不重复进表面
          store.append(message);
        }
      }
      return result;
    },
    hookCount(event) {
      return listeners(event).length;
    },
  };
}
