/**
 * 给 UI 用的本地 HTTP 接口（0.6.0 工单 #06 重写：S3 控制面加法式演进）
 *
 * 路由（全部经 control/decorator.js 的八步装饰器，见 CONTROL_PLANE_ROUTES）：
 *   GET        /api/dsh-gate/state         分层快照
 *   GET|POST   /api/dsh-gate/policy        读/写策略
 *   GET        /api/dsh-gate/capabilities  能力视图
 *   GET|POST   /api/dsh-gate/skills        技能表 / 档位 / 关闭清单 / 导入 / 接管 / batch
 *   GET|POST   /api/dsh-gate/mcp           MCP 清单 / add·update·remove·enable·disable
 *   GET        /api/dsh-gate/diagnostics   只读诊断（read / decisions / runtime / errors）
 *
 * 结构（工单 #06 "控制面拆四部分"）：
 *   lib/control/routes.js       路由表（数据：方法/是否需要体/作用域/摘要）
 *   lib/control/decorator.js    统一装饰器（八步，唯一写出点）
 *   lib/control/env.js          鉴权主门 + 兜底门 + 会话解析 + 宿主能力探测
 *   lib/control/core.js         领域投影与写盘（不含 HTTP）
 *   lib/control/*-service.js    策略、技能、MCP、状态、能力、诊断六个资源服务
 *
 * 安全模型（2026-10-29 二审）不变：这是注册在宿主 webServer 上的精确路由，先于 SPA/认证处理器命中，
 * 所以自己把门 —— 主门借 connection.requestRejection（Host/Origin/sec-fetch-site + launch token/cookie 的
 * 完整校验），宿主没装时才退回自家四道门（回环来源 / Host 回环名 / 同源 / JSON 强预检）。
 */
import { isPlainObject } from "./policy.js";
import { resolveService } from "./services.js";
import { CONTROL_PLANE_ROUTES, buildControlRoutes, routeDocTable } from "./control/routes.js";
import { MAX_BODY_BYTES } from "./control/body.js";
import { PIPELINE_STEPS, createControlHandler } from "./control/decorator.js";
import { createErrorLedger } from "./control/error-ledger.js";
import { createMetrics } from "./control/metrics.js";
import { createCore } from "./control/core.js";
import { createEnvironment } from "./control/env.js";
import { isTrustedRequest, hostAdmission } from "./control/trust.js";
import { createStateService } from "./control/state-service.js";
import { createPolicyService } from "./control/policy-service.js";
import { createCapabilitiesService } from "./control/capabilities-service.js";
import { createSkillsService } from "./control/skills-service.js";
import { createMcpService } from "./control/mcp-service.js";
import { createDiagnosticsService } from "./control/diagnostics-service.js";

// 公共符号（0.5.7 的 import 面一个不动）：selftest 直接 import hostAdmission，
// s3 接缝 import mountServer，domain 层不许 import 本文件（故 resolveService 只是 re-export）。
export { isTrustedRequest, hostAdmission, resolveService };
export { CONTROL_PLANE_ROUTES, routeDocTable, PIPELINE_STEPS, MAX_BODY_BYTES };

export function mountServer(options) {
  const ctx = options.ctx;
  const gate = options.gate;
  const policy = options.policy;
  const logger = options.logger;
  const config = isPlainObject(options.config) ? options.config : {};

  // 路由表 → 八步装饰器 → 资源服务。快照的唯一派生点留在本文件（源码守卫与口径都指这一行）。
  const core = createCore({
    ctx,
    gate,
    policy,
    logger,
    config,
    snapshotOf: (agent) => gate.snapshot(agent),
  });
  const ledger = createErrorLedger();
  const metrics = createMetrics(CONTROL_PLANE_ROUTES.map((route) => route.id));
  const environment = createEnvironment({
    ctx,
    gate,
    ledger,
    logger,
    config,
    token: options.authToken,
    requireToken: options.requireFallbackToken,
  });
  const services = {
    state: createStateService(core),
    policy: createPolicyService(core),
    capabilities: createCapabilitiesService(core),
    skills: createSkillsService(core),
    mcp: createMcpService(core),
    diagnostics: createDiagnosticsService({ core, gate, env: environment, metrics, ledger }),
  };
  const specs = buildControlRoutes({ core, env: environment, services, metrics, ledger, logger, maxBodyBytes: MAX_BODY_BYTES });
  const routes = specs.map((spec) => ({
    kind: "exact",
    path: spec.path,
    id: spec.id,
    methods: spec.methods,
    body: spec.body,
    scope: spec.scope,
    summary: spec.summary,
    handler: createControlHandler(spec, {
      maxBodyBytes: MAX_BODY_BYTES,
      metrics,
      ledger,
      logger,
      authenticate: environment.authenticate,
      resolveScope: environment.resolveScope,
    }),
  }));

  ctx.inject(["webServer"], (sctx) => {
    const disposers = [];
    for (const route of routes) {
      try { disposers.push(sctx.webServer.register(route)); }
      catch (error) { try { logger?.warn?.("dsh-gate: 注册路由失败 " + route.path + " — " + String((error && error.message) || error)); } catch { /* 忽略 */ } }
    }
    return () => { for (const dispose of disposers) { try { dispose(); } catch { /* 忽略 */ } } };
  });

  return () => undefined;
}
