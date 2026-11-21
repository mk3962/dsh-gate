/**
 * dsh-gate 入口：把两层闸门挂到宿主上。
 *
 * 安装 = 一个插件行；卸载 = 删掉那一行（restrict 的 disposer 全在插件 fiber 里，卸载即恢复）。
 */
import { resolvePolicy, defaultDshHome } from "./policy.js";
import { createGate, pickStatus } from "./gate.js";
import { mountSectionGate } from "./sections.js";
import { mountPreStepPipeline } from "./prestep.js";
import { mountRepeatGuard, resetRepeatGuard } from "./guardrail.js";
import { registerGateTools } from "./proxy.js";
import { mountServer } from "./server.js";

export const name = "dsh-gate";
export const inject = ["tools"];

export function apply(ctx, config) {
  const logger = ctx.logger;
  // 迁移时判定“悬空键”要用当前工具面（knownNames 不受 restriction 影响，稳定）。
  const knownNames = (() => {
    try {
      const view = ctx.tools?.view?.();
      if (view && view.knownNames instanceof Set) return view.knownNames;
    } catch { /* 忽略 */ }
    return undefined;
  })();
  // Desktop 版不设置 $DSH_HOME，旧代码因此把 policyFile 解析成 undefined：
  // 种进 ~/.dsh/gate.json 的策略读不到、UI 保存恒失败。defaultDshHome() 补上 ~/.dsh 回退。
  const policy = resolvePolicy(config || {}, { logger, dshHome: defaultDshHome(), knownNames });
  if (policy.migrated) {
    try {
      logger?.info?.("dsh-gate: v2 策略已迁移到 v3（原文件未改；备份 " + (policy.backupFile || "未生成") + "）");
    } catch { /* 忽略 */ }
  }

  // A15 / I-3：策略禁用（或策略文件损坏后进入降级保护态）时，限制必须全部撤销，
  // 但控制面与只读诊断仍要挂上 —— 否则用户再也写不回 enabled:true，闸门永久失联。
  const disabled = policy.enabled === false;
  if (disabled) {
    try {
      logger?.info?.("dsh-gate: 策略禁用或降级保护中，只挂控制面与只读诊断，未建立任何限制");
    } catch { /* 忽略 */ }
  }

  const gate = createGate({ ctx, logger, policy });
  const disposers = [];

  // MCP 自挂（0.3.0 工单 15）：声明在 gate.json 里的 server 由 gate 自己挂。
  // apply 必须同步返回卸载函数（loadtest / 宿主 lifecycle 都按同步契约调用），所以这里
  // 启动自挂但不阻塞 apply：连接是网络操作，挂完注册的工具会发 tools/change，gate 自己
  // 的监听会重算限制与段落计划。多个 server 的 mount 在 gate.startMcp 内部并发。
  if (!disabled) {
    try {
      void gate.startMcp().catch((error) => {
        try { logger?.warn?.("dsh-gate: MCP 自挂失败（已降级）— " + String((error && error.message) || error)); } catch { /* 忽略 */ }
      });
    } catch (error) {
      try { logger?.warn?.("dsh-gate: MCP 自挂初始化失败（已降级）— " + String((error && error.message) || error)); } catch { /* 忽略 */ }
    }
  }

  // 防御：任何一段挂载失败都只降级，绝不让插件把宿主启动带崩（fail-soft）。
  const safe = (label, fn) => {
    try {
      const out = fn();
      if (typeof out === "function") disposers.push(out);
      return out;
    } catch (error) {
      try { logger?.warn?.("dsh-gate: " + label + " 挂载失败，已跳过 — " + String((error && error.message) || error)); } catch { /* 忽略 */ }
      return undefined;
    }
  };

  const attachAgent = (agent) => {
    let ready;
    try { ready = gate.attach(agent); } catch (error) {
      try { logger?.warn?.("dsh-gate: 挂载 agent 失败，已跳过 — " + String((error && error.message) || error)); } catch { /* 忽略 */ }
      return;
    }
    if (ready === undefined) return;
    ready.then(() => {
      const status = pickStatus(gate.snapshot(agent));
      try {
        logger?.info?.(
          "dsh-gate: 已挂载 agent " + String(agent.id || "?") + " — 可见 " + status.visible +
          "，常驻 " + status.resident + "，按需 " + status.onDemand + "，隐藏 " + status.gated
        );
      } catch { /* 忽略 */ }
    }).catch(() => undefined);
  };

  if (!disabled) {
    ctx.inject(["tools"], (scoped) => {
      safe("gate_* 工具", () => registerGateTools({ ctx: scoped, gate, policy }));
    });

    safe("提示词段落闸门", () => mountSectionGate({ ctx, gate, logger, policy }));
    // 重复调用护栏（0.5.3 · R2 合并版）：判据升级（窗口 + 结果指纹）在做不了配置层修正的地方只能进源码，
    // 而 gate 是我们自己的包。默认关闭 —— 它替的是宿主自带的 repeat-tool-reminder，
    // 打开前必须把宿主那一行停掉（否则两套监听器双提醒，见 lib/guardrail.js 头注释）。
    // 0.6.0：护栏只挂 post-execute；pre-step 重置交给下面的有序管线（三动作固定顺序，C42/C44）。
    safe("重复调用护栏", () => mountRepeatGuard({ ctx, policy, logger, managePreStep: false }));
    // pre-step 三动作**只注册一次**（技能步骤 → 尾块步骤 → 护栏重置）：
    // 0.5.7 是两次 prepend 插队 + 一次普通注册，靠隐式注册序凑顺序，重排即坏（C42）。
    safe("pre-step 有序管线", () => mountPreStepPipeline({
      ctx,
      gate,
      policy,
      reset: resetRepeatGuard,
    }));

    // 宿主已有的 agent（热加载时先接管，再等新的）
    try {
      const roots = ctx.agents?.roots?.() || [];
      for (const agent of roots) attachAgent(agent);
    } catch (error) {
      try { logger?.warn?.("dsh-gate: 枚举现有 agent 失败 — " + String((error && error.message) || error)); } catch { /* 忽略 */ }
    }

    safe("agent/created 订阅", () => ctx.on("agent/created", ({ agent }) => { attachAgent(agent); }));
    safe("agent/disposed 订阅", () => ctx.on("agent/disposed", ({ agent }) => { void gate.release(agent); }));
  }

  // 工具表变了（插件热插拔）就重算一次，否则会留下过期限制。
  // 0.6.0（C31）：**删除二十次五毫秒轮询猜窗口**。租约状态机让「窗口里的重算」变成只登记待生效目标，
  // 所以这里可以直接重算；窗口关信号会由闸门做一次防抖重算（定时器句柄在 gate 里，卸载时清掉）。
  // restrict() 自己也会发 tools/change：窗口内 restriction 的 apply 只登记、不施加，天然不会自激。
  if (!disabled) safe("tools/change 订阅", () => ctx.on("internal/dispatch", (_type, eventName) => {
    if (eventName !== "tools/change") return;
    gate.reapplyAll();
  }, { prepend: true, global: true }));

  // 把插件行 config 一起交给 server：保存策略后重新解析时要保住行上的自定义项（policyFile/overrides/protected）。
  safe("UI/HTTP 页", () => mountServer({ ctx, gate, policy, logger, config: config || {} }));

  // 卸载时先断 MCP 连接（dispose = 断连 + 注销工具 + 释放 serverName 命名空间），再撤限制。
  // 用 ctx.effect 是为了在异步 apply 的将来也保留清理钩子；宿主没有 effect 时退回返回的 disposer。
  let mcpDisposed = false;
  const disposeMcp = () => {
    if (mcpDisposed) return;
    mcpDisposed = true;
    try { void gate.mcpManager.disposeAll(); } catch { /* 忽略 */ }
  };
  try {
    if (typeof ctx.effect === "function") ctx.effect(() => () => disposeMcp());
    else disposers.push(disposeMcp);
  } catch { disposers.push(disposeMcp); }

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch { /* 忽略 */ }
    }
    disposeMcp();
    void gate.releaseAll();
  };
}
