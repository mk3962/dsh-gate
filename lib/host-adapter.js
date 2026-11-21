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
    if (Array.isArray(callbacks) && callbacks.length > 0) {
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
    userMessage,
    isSubagent,
    loaderEntries,
    acquirePresetScope,
    /** 探测缓存规模（测试与诊断用）。 */
    probeSize: () => probed.size,
  };
}
