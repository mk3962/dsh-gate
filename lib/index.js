/**
 * dsh-gate 入口：把两层闸门挂到宿主上。
 *
 * 安装 = 一个插件行；卸载 = 删掉那一行（restrict 的 disposer 全在插件 fiber 里，卸载即恢复）。
 */
import { resolvePolicy, defaultDshHome } from "./policy.js";
import { createGate } from "./gate.js";
import { mountSectionGate } from "./sections.js";
import { mountSkillGate } from "./prestep.js";
import { registerGateTools } from "./proxy.js";
import { mountServer } from "./server.js";

export const name = "dsh-gate";
export const inject = ["tools"];

export function apply(ctx, config) {
  const logger = ctx.logger;
  // Desktop 版不设置 $DSH_HOME，旧代码因此把 policyFile 解析成 undefined：
  // 种进 ~/.dsh/gate.json 的策略读不到、UI 保存恒失败。defaultDshHome() 补上 ~/.dsh 回退。
  const policy = resolvePolicy(config || {}, { logger, dshHome: defaultDshHome() });

  if (policy.enabled === false) {
    try { logger?.info?.("dsh-gate: 策略禁用，未建立任何限制"); } catch { /* 忽略 */ }
    return;
  }

  const gate = createGate({ ctx, logger, policy });
  const disposers = [];

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
    let entry;
    try { entry = gate.attach(agent); } catch (error) {
      try { logger?.warn?.("dsh-gate: 挂载 agent 失败，已跳过 — " + String((error && error.message) || error)); } catch { /* 忽略 */ }
      return;
    }
    if (entry === undefined) return;
    entry.ready.then(() => {
      const status = gate.status(agent);
      try {
        logger?.info?.(
          "dsh-gate: 已挂载 agent " + String(agent.id || "?") + " — 可见 " + status.visible +
          "，常驻 " + status.resident + "，按需 " + status.onDemand + "，隐藏 " + status.gated
        );
      } catch { /* 忽略 */ }
    }).catch(() => undefined);
  };

  ctx.inject(["tools"], (scoped) => {
    safe("gate_* 工具", () => registerGateTools({ ctx: scoped, gate, policy }));
  });

  safe("提示词段落闸门", () => mountSectionGate({ ctx, gate, logger, policy }));
  safe("skill 目录闸门", () => mountSkillGate({ ctx, gate, policy }));

  // 宿主已有的 agent（热加载时先接管，再等新的）
  try {
    const roots = ctx.agents?.roots?.() || [];
    for (const agent of roots) attachAgent(agent);
  } catch (error) {
    try { logger?.warn?.("dsh-gate: 枚举现有 agent 失败 — " + String((error && error.message) || error)); } catch { /* 忽略 */ }
  }

  safe("agent/created 订阅", () => ctx.on("agent/created", ({ agent }) => { attachAgent(agent); }));
  safe("agent/disposed 订阅", () => ctx.on("agent/disposed", ({ agent }) => { void gate.release(agent); }));

  // 工具表变了（插件热插拔）就重算一次，否则会留下过期限制。
  // 防自激：restrict() 自己也会发 tools/change，所以①应用期间直接跳过；②用一次宏任务合并连发事件。
  let reapplyQueued = false;
  safe("tools/change 订阅", () => ctx.on("internal/dispatch", (_type, eventName) => {
    if (eventName !== "tools/change") return;
    if (reapplyQueued) return;
    reapplyQueued = true;
    // 旧实现在 isApplying() 时直接 return，把事件丢了：正好在应用限制那一瞬间注册的工具
    // 就永远漏闸（要等下一次 tools/change 才补）。现在改成延后重试，最多 20 次。
    const run = (attempt) => {
      setTimeout(() => {
        if (gate.isApplying() && attempt < 20) { run(attempt + 1); return; }
        reapplyQueued = false;
        for (const agent of [...gate.entries.keys()]) {
          try { gate.reapply(agent); } catch { /* 忽略 */ }
        }
      }, attempt === 0 ? 0 : 5);
    };
    run(0);
  }, { prepend: true, global: true }));

  // 把插件行 config 一起交给 server：保存策略后重新解析时要保住行上的自定义项（policyFile/overrides/protected）。
  safe("UI/HTTP 页", () => mountServer({ ctx, gate, policy, logger, config: config || {} }));

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch { /* 忽略 */ }
    }
    void gate.releaseAll();
  };
}
