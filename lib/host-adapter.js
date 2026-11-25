/**
 * 宿主适配层（D14）—— 所有「只有宿主知道」的读取与派发都收在这一层。
 *
 * 领域层（decide / naming / planner / capabilities / skills 的纯函数部分）不得出现宿主私有形状：
 * 事件派发参数形态、执行器类名、会话表面结构、内部派发通道只允许出现在这里。
 * 运行时层（gate / planner 的装配侧）只通过本接口问宿主。
 *
 * 三条硬约束：
 *  1) 能力缺失只探测一次并缓存（成功与失败都缓存），退化告警每项只发一次；
 *  2) 所有读取都不抛错：宿主服务缺失/形状变化只返回 undefined，由调用方降级；
 *  3) 不认识就是不认识：执行器判不出 PTC 时返回 unknown（fail-open），不猜。
 */
import { resolveService, serviceHas } from "./services.js";

/** 执行器判据用的固定名字（宿主 dist 的类名与 run_code 名）。 */
export const PTC_EXECUTOR_CLASS = "PtcExecutor";
export const NATIVE_EXECUTOR_CLASS = "NativeToolExecutor";
export const RUN_CODE_TOOL_NAME = "run_code";

/**
 * 建一个适配器。同一插件实例一个：能力探测缓存与告警去重都挂在实例上。
 *
 * @param {object} ctx 插件 ctx
 * @param {{logger?:object}} [options]
 * @returns {object}
 */
export function createHostAdapter(ctx, options) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const logger = opts.logger;
  /** 能力探测缓存：键 = 服务名[.方法]，值 = 布尔。 */
  const probed = new Map();
  /** 告警去重（每项只发一次）。 */
  const warned = new Set();

  const warnOnce = (code, message) => {
    if (warned.has(code)) return;
    warned.add(code);
    try {
      if (logger && typeof logger.warn === "function") logger.warn("dsh-gate adapter: " + message);
    } catch { /* 日志失败不影响适配结果 */ }
  };

  /** 宿主服务（缺失返回 undefined）。 */
  const service = (name) => resolveService(ctx, name);

  /** 工具面：官方读法是 ctx.get("tools")，cordis 也允许直接挂在 ctx.tools 上（两条都认）。 */
  const toolService = () => service("tools") || (ctx !== null && ctx !== undefined ? ctx.tools : undefined);

  /** loader 面：同上。 */
  const loaderService = () => service("loader") || (ctx !== null && ctx !== undefined ? ctx.loader : undefined);

  /**
   * 能力探测：服务是否存在、是否带某方法。**只探测一次**（成功/失败都缓存）。
   * @param {string} name 服务名
   * @param {string} [method] 方法名
   */
  const has = (name, method) => {
    const key = method === undefined ? String(name) : String(name) + "." + String(method);
    if (probed.has(key)) return probed.get(key);
    let ok = false;
    try { ok = serviceHas(ctx, name, method); } catch { ok = false; }
    probed.set(key, ok);
    if (ok === false) warnOnce(key, "宿主能力缺失：" + key + "（相应功能降级，只提示这一次）");
    return ok;
  };

  /** agent 的完整工具视图（global + 祖先层）；读不到返回 undefined。 */
  const toolView = (agent) => {
    const tools = toolService();
    if (tools === undefined || tools === null || typeof tools.view !== "function") return undefined;
    try {
      const view = tools.view(agent);
      return view !== undefined && view !== null ? view : undefined;
    } catch { return undefined; }
  };

  /** 注册过的名字（restriction 不影响）；只认原生 Set，其余形状交给调用方兜底。 */
  const knownNames = (agent) => {
    const view = toolView(agent);
    if (view === undefined) return undefined;
    return view.knownNames instanceof Set ? view.knownNames : undefined;
  };

  /** 可见名字（受 restriction 影响）；形状不认识返回 undefined。 */
  const visibleNames = (agent) => {
    const view = toolView(agent);
    if (view === undefined) return undefined;
    const visible = view.visible;
    try {
      if (visible && typeof visible.keys === "function") return new Set(visible.keys());
      if (visible && typeof visible[Symbol.iterator] === "function") return new Set(visible);
    } catch { return undefined; }
    return undefined;
  };

  /** 选中执行器（宿主没有 selectExecutor 时返回 undefined）。 */
  const selectExecutor = (agent) => {
    const tools = toolService();
    if (tools === undefined || tools === null || typeof tools.selectExecutor !== "function") return undefined;
    try {
      const executor = tools.selectExecutor(agent);
      return executor === undefined || executor === null ? undefined : executor;
    } catch { return undefined; }
  };

  /**
   * 执行器判定（PTC / native / unknown）。类名优先，其次 describe().schemas；
   * 判不出来就 fail-open（unknown），绝不猜「大概是 PTC」。
   */
  const detectExecutor = (agent) => {
    const executor = selectExecutor(agent);
    if (executor === undefined) return { kind: "unknown", reason: "no-executor" };
    const ctor = executor.constructor && executor.constructor.name;
    if (ctor === PTC_EXECUTOR_CLASS) return { kind: "ptc", reason: "constructor" };
    if (ctor === NATIVE_EXECUTOR_CLASS) return { kind: "native", reason: "constructor" };
    let schemas;
    try {
      const described = typeof executor.describe === "function" ? executor.describe([]) : undefined;
      schemas = described && Array.isArray(described.schemas) ? described.schemas : undefined;
    } catch { schemas = undefined; }
    if (schemas !== undefined && schemas.length === 1 && schemas[0] && schemas[0].name === RUN_CODE_TOOL_NAME) {
      return { kind: "ptc", reason: "schemas" };
    }
    if (schemas !== undefined && schemas.length > 0) return { kind: "native", reason: "schemas" };
    return { kind: "unknown", reason: "unrecognized-executor" };
  };

  /**
   * 隔离派发：cordis 的 emit 是 dispatch().map(cb => cb(...args))，一个监听者抛错会中断后面所有
   * 监听者。这里改走 per-listener 通道，串行调用、各自 try/catch。宿主没有该通道时退回 emit。
   *
   * @returns {{mode:"isolated"|"emit"|"none", listeners:number, delivered:number, failed:string[]}}
   */
  const dispatchIsolated = (event, args) => {
    const info = { mode: "none", listeners: 0, delivered: 0, failed: [] };
    const events = ctx !== null && ctx !== undefined ? ctx.events : undefined;
    let callbacks;
    if (events !== undefined && events !== null && typeof events.dispatch === "function") {
      try {
        callbacks = events.dispatch("emit", [event, ...args]);
      } catch (error) {
        info.failed.push("dispatch: " + String((error && error.message) || error));
      }
    }
    // C45：派发返回**空数组**就是「当前零监听者」—— 不能退回 ctx.emit 再伪造一个
    // delivered=1/listeners=1（那会让激活回执永远说「送到了」，真机却没人收）。
    if (Array.isArray(callbacks)) {
      info.mode = "isolated";
      info.listeners = callbacks.length;
      for (const callback of callbacks) {
        try {
          callback(...args);
          info.delivered += 1;
        } catch (error) {
          info.failed.push(String((error && error.message) || error));
        }
      }
      return info;
    }
    if (typeof ctx.emit !== "function") return info;
    info.mode = "emit";
    try {
      ctx.emit(event, ...args);
      info.delivered = 1;
      info.listeners = 1;
    } catch (error) {
      info.failed.push(String((error && error.message) || error));
    }
    return info;
  };

  /**
   * 取派发用的 scope 载体（waterfall 的 thisArg）。
   *
   * 真实宿主的载体由 @deepseek-ai/dsh-scope 的 `scopeTarget(base, key)` 铸造，而
   * 纬（scope 键 → 祖先链）存在该包的私有 WeakMap 里 —— 闸门**不能**自己造一个等价物，
   * 也不能 import 那个包（本插件只声明 dsh-tools 一个 peer，多一个包解析不到就整插件加载失败）。
   * 所以这里只认宿主**已经交给我们的**载体，找不到就不带载体派发：
   *  1) 调用方显式给（options.carrier / options.scopeTarget）；
   *  2) agent 自己身上带（宿主将来把载体挂到 agent 上时自动生效）；
   *  3) 宿主 ctx 上有 scopeTarget 辅助函数时现算。
   * 都没有 ⇒ undefined，与 dispatchIsolated 今天的口径一致（不带载体 = 不过滤监听者）。
   */
  const scopeCarrierOf = (agent, options) => {
    const opts = options !== null && typeof options === "object" ? options : {};
    const given = opts.carrier;
    if (given !== undefined && given !== null && typeof given === "object") return given;
    const carried = agent !== null && agent !== undefined ? agent.carrier : undefined;
    if (carried !== undefined && carried !== null && typeof carried === "object") return carried;
    const helper = typeof opts.scopeTarget === "function" ? opts.scopeTarget : undefined;
    if (helper !== undefined) {
      try {
        const built = agent === undefined || agent === null ? helper() : helper(agent);
        return built !== undefined && built !== null && typeof built === "object" ? built : undefined;
      } catch { return undefined; }
    }
    return undefined;
  };

  /**
   * **瀑布**隔离派发（A1 兼发的 post-execute 通道）—— 与 dispatchIsolated 是两件事：
   * 那个只做 emit（无返回值、无末参 next），这个按宿主的 waterfall 语义注入 `next`。
   *
   * 为什么不能塞进 dispatchIsolated：`tools/post-execute` 的监听者签名是
   * `(exec, result, next)`，next 缺失就是 TypeError（第三方懒加载插件的激活门正是这样写的：
   * `const decision = await next()` 然后才注册工具）。emit 通道永远给不出 next。
   *
   * 三条纪律：
   *  1) **per-listener 异常隔离**：一个监听者抛错只进 failed，后面的监听者照常收到
   *     （真实 cordis 的 waterfall 是串联上抛，会把后面那家饿死 —— 0.5.4 的老坑）；
   *  2) **next 语义保真**：每个监听者的 next 指向链上下一位，最内层 next 返回
   *     `acceptValue ?? { kind: "accept" }`（宿主 post-execute 的默认决策）；
   *  3) **重复调用 next 当场抛错**（比 cordis 更严）：宿主自己只会 shift 下一位，
   *     重复 next 等于把下游监听者跑两遍、副作用翻倍（插件据此注册工具、记账）。
   *     宁可让这一位失败并进 failed，也不让同一条链被静默执行两次。
   *
   * 回执：`{ mode, listeners, delivered, failed }`
   *  - mode "isolated"：逐个枚举回调（宿主有 events.dispatch）；
   *  - mode "waterfall"：只能整条链调用一次（没有 per-listener 通道）→ 整链算 1 个投递单位；
   *  - mode "none"：宿主两条通道都没有。
   *
   * @param {string} event 事件名（如 "tools/post-execute"）
   * @param {any[]} args 监听者参数（**不含** next —— 由本函数注入）
   * @param {{agent?:object, acceptValue?:any, carrier?:object, scopeTarget?:Function}} [options]
   * @returns {Promise<{mode:"isolated"|"waterfall"|"none", listeners:number, delivered:number, failed:string[]}>}
   */
  const dispatchWaterfallIsolated = async (event, args, options) => {
    const opts = options !== null && typeof options === "object" ? options : {};
    const acceptValue = opts.acceptValue === undefined ? { kind: "accept" } : opts.acceptValue;
    const inner = () => Promise.resolve(acceptValue);
    const list = Array.isArray(args) ? args : [];
    const info = { mode: "none", listeners: 0, delivered: 0, failed: [] };
    const carrier = scopeCarrierOf(opts.agent, opts);
    const events = ctx !== null && ctx !== undefined ? ctx.events : undefined;
    let callbacks;
    if (events !== undefined && events !== null && typeof events.dispatch === "function") {
      try {
        // 与 cordis 同：args 的第一位是 thisArg（载体），第二位是事件名，末位（宿主的 inner）不会被 dispatch 使用。
        const channelArgs = carrier === undefined ? [event, ...list, inner] : [carrier, event, ...list, inner];
        callbacks = events.dispatch("waterfall", channelArgs);
      } catch (error) {
        info.failed.push("dispatch: " + String((error && error.message) || error));
      }
    }
    if (Array.isArray(callbacks)) {
      info.mode = "isolated";
      info.listeners = callbacks.length;
      /** 串行组合：第 i 位的 next 走到第 i+1 位；最内层给 acceptValue。 */
      const runAt = async (index) => {
        const callback = callbacks[index];
        if (callback === undefined) return inner();
        let called = false;
        let chain;
        const next = () => {
          if (called === true) throw new Error("next() called multiple times (gate: 同一监听者只允许委派一次)");
          called = true;
          chain = runAt(index + 1);
          return chain;
        };
        try {
          const decision = await callback(...list, next);
          info.delivered += 1;
          return decision;
        } catch (error) {
          info.failed.push(String((error && error.message) || error));
          // 已经委派过：下游结果才是这条链的真实决策，原样交回（下游自己的失败已各自记账）。
          if (chain !== undefined) {
            try { return await chain; } catch { /* 下游异常不会穿到这里（每层都吞），兜底继续 */ }
            return inner();
          }
          // 没委派就抛错：隔离语义 —— 后面的监听者照常收到，绝不饿死。
          return runAt(index + 1);
        }
      };
      return runAt(0).then(() => info);
    }
    if (typeof ctx.waterfall !== "function") return info;
    info.mode = "waterfall";
    // 无法逐个枚举：整条链算一个投递单位（回执里 listeners/delivered 同为 1 表示「跑过一次」）。
    info.listeners = 1;
    try {
      const channelArgs = carrier === undefined ? [event, ...list, inner] : [carrier, event, ...list, inner];
      await ctx.waterfall(...channelArgs);
      info.delivered = 1;
    } catch (error) {
      info.failed.push(String((error && error.message) || error));
    }
    return info;
  };

  /** 确定性用户消息：同一份输入永远同一份消息对象（无时间戳、无自增 id）。 */
  const userMessage = (text, source) => {
    const content = typeof text === "string" ? text : String(text === undefined || text === null ? "" : text);
    const message = { role: "user", content: [{ type: "text", text: content }] };
    if (source !== undefined) message.source = source;
    return message;
  };

  /** 子代理判定：只认宿主给的标记，不猜。 */
  const isSubagent = (agent) => {
    if (agent === null || agent === undefined) return false;
    try {
      return agent.parent !== undefined && agent.parent !== null;
    } catch { return false; }
  };

  /** loader 条目（生成器/数组都认）；读不到当空表。 */
  const loaderEntries = () => {
    const loader = loaderService();
    if (loader === undefined || loader === null || typeof loader.entries !== "function") return [];
    try {
      const rows = loader.entries();
      if (rows === undefined || rows === null) return [];
      return Array.from(rows);
    } catch { return []; }
  };

  /** preset 租约：拿默认 preset 的 standing scope；服务缺失返回 undefined。 */
  const acquirePresetScope = async (preset) => {
    if (!has("agentPresets", "acquireScope")) return undefined;
    try {
      const presets = service("agentPresets");
      return await presets.acquireScope(preset);
    } catch { return undefined; }
  };

  return {
    service,
    has,
    warnOnce,
    toolView,
    knownNames,
    visibleNames,
    selectExecutor,
    detectExecutor,
    dispatchIsolated,
    dispatchWaterfallIsolated,
    userMessage,
    isSubagent,
    loaderEntries,
    acquirePresetScope,
    /** 探测缓存规模（测试与诊断用）。 */
    probeSize: () => probed.size,
  };
}
