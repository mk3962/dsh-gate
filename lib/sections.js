/**
 * 段落闸门：在 system-prompt/assemble 里摘掉按需段落，并把第二层目录插进去。
 * context.scope 就是 agent（dsh-ops 生产代码同样用法）。
 */
import { estimateTokens } from "./catalog.js";

export const CATALOG_SECTION = "gate-catalog";
const INVENTORY_CAP = 80;

export function mountSectionGate(options) {
  const ctx = options.ctx;
  const gate = options.gate;
  const logger = options.logger;
  const policy = options.policy;

  return ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    const result = await next();
    const agent = context && context.scope;
    if (!agent || !result || !Array.isArray(result.sections)) return result;
    if (policy.enabled === false) return result;
    // 挂载是异步的：attach 交给我们的就是「就绪」这件事本身。
    try { await gate.attach(agent); } catch { /* 忽略 */ }

    // 先记录真实段落清单（摘之前），UI 靠它列出可选项。
    const inventory = [];
    for (const section of result.sections) {
      if (!section || typeof section.name !== "string") continue;
      const text = typeof section.text === "string" ? section.text : "";
      // 正文一起交给 gate：PTC 冻结下段落被摘掉后，正文改由尾部声明补回（gate.sectionTexts）。
      inventory.push({ name: section.name, chars: text.length, tokens: estimateTokens(text), text });
    }
    inventory.sort((a, b) => b.chars - a.chars);
    gate.recordSections(agent, inventory.slice(0, INVENTORY_CAP));

    const plan = gate.planSections(agent);
    const dropped = [];
    const kept = result.sections.filter((section) => {
      if (section === undefined || section === null) return false;
      if (section.name === CATALOG_SECTION) return false;
      if (plan.shouldDrop(section.name)) { dropped.push(section.name); return false; }
      return true;
    });
    if (dropped.length > 0) {
      try { logger?.debug?.("dsh-gate: 已摘除段落 " + dropped.join(", ")); } catch { /* 忽略 */ }
    }

    const catalog = gate.catalogFor(agent);
    const sections = typeof catalog === "string" && catalog.length > 0
      ? [...kept, { name: CATALOG_SECTION, text: catalog, interpolate: false }]
      : kept;
    return { ...result, sections };
  });
}
