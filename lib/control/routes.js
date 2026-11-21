/**
 * 控制面路由表（0.6.0 工单 #06 · F79 "路由表是数据"）
 *
 * 这张表是**唯一事实来源**：方法、是否需要体、作用域、摘要、错误码集合都在这里，
 * 装饰器按它装配八步，文档端点表由它生成（#08 断言文档一致）。
 * 新增路由只能加一行；忘了加鉴权/信封是不可能的 —— 处理函数根本拿不到 res。
 */
export const CONTROL_PLANE_ROUTES = Object.freeze([
  Object.freeze({
    id: "state",
    path: "/api/dsh-gate/state",
    methods: Object.freeze(["GET"]),
    body: false,
    scope: "agent",
    readOnly: true,
    summary: "分层快照（面板列表 + 预算 + UI 默认层）",
    success: "gate.snapshot 的投影 + own/preset/defaults",
  }),
  Object.freeze({
    id: "policy",
    path: "/api/dsh-gate/policy",
    methods: Object.freeze(["GET", "POST"]),
    body: true,
    scope: "agent",
    readOnly: false,
    summary: "读取 v3 策略 / 保存策略（含整份替换与 revision 冲突检测）",
    success: "GET: v3 形状 + 模板 + revision；POST: 写回执 + state",
  }),
  Object.freeze({
    id: "capabilities",
    path: "/api/dsh-gate/capabilities",
    methods: Object.freeze(["GET"]),
    body: false,
    scope: "agent",
    readOnly: true,
    summary: "能力视图（能力 / 段落 / 技能 / 告警）",
    success: "gate.capabilityView 的投影",
  }),
  Object.freeze({
    id: "skills",
    path: "/api/dsh-gate/skills",
    methods: Object.freeze(["GET", "POST"]),
    body: true,
    scope: "agent",
    readOnly: false,
    summary: "技能表 / 档位 / 关闭清单 / 导入目录 / 接管开关 / batch 原子批量",
    success: "GET: 技能表 + imports + prescan；POST: 写回执 + applied(仅 batch)",
  }),
  Object.freeze({
    id: "mcp",
    path: "/api/dsh-gate/mcp",
    methods: Object.freeze(["GET", "POST"]),
    body: true,
    scope: "none",
    readOnly: false,
    summary: "MCP 清单（GET）/ add·update·remove·enable·disable（POST）",
    success: "servers + warnings + writable + result",
  }),
  Object.freeze({
    id: "diagnostics",
    path: "/api/dsh-gate/diagnostics",
    methods: Object.freeze(["GET"]),
    body: false,
    scope: "agent",
    readOnly: true,
    summary: "只读诊断：read / decisions / runtime / errors 四组固定键",
    success: "四组投影，形状稳定",
  }),
]);

/** 文档端点表（#08 断言它与文档一致；由路由表生成，不手写第二份）。 */
export function routeDocTable() {
  return CONTROL_PLANE_ROUTES.map((route) => ({
    id: route.id,
    path: route.path,
    methods: route.methods.join(", "),
    body: route.body,
    scope: route.scope,
    readOnly: route.readOnly,
    summary: route.summary,
  }));
}

/**
 * 装配路由表：把服务绑到表上，handler 只接收装饰器给的 rc。
 * @param {{core:object, env:object, metrics:object, ledger:object, logger:object, maxBodyBytes:number}} deps
 */
export function buildControlRoutes(deps) {
  const core = deps.core;
  // 服务是惰性 import 的（避免 createCore ↔ 服务互相依赖；也方便单测只 import 一个服务）。
  const services = deps.services;
  return CONTROL_PLANE_ROUTES.map((route) => {
    const service = services[route.id];
    // 刻意**不冻结**：接缝夹具会给注册出去的 route 打 disposed 标记（disposeAll 断言用它）。
    return {
      kind: "exact",
      path: route.path,
      id: route.id,
      methods: route.methods,
      body: route.body,
      scope: route.scope,
      summary: route.summary,
      handler: async (rc) => {
        const method = String(rc && rc.req && rc.req.method ? rc.req.method : "GET").toUpperCase();
        if (method === "POST") {
          if (service === undefined || typeof service.post !== "function") {
            throw new Error("路由 " + route.id + " 没有 post 服务");
          }
          return service.post(rc);
        }
        if (service === undefined || typeof service.get !== "function") {
          throw new Error("路由 " + route.id + " 没有 get 服务");
        }
        return service.get(rc);
      },
    };
  });
}
