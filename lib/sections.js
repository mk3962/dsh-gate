/**
 * 段落闸门：在 system-prompt/assemble 里摘掉按需段落，并把第二层目录插进去。
 * context.scope 就是 agent（dsh-ops 生产代码同样用法）。
 */
import { estimateTokens } from "./catalog.js";
import { isGateSkillSection } from "./skills.js";

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
    // 首步兜底（P1-2）：宿主先 assemble 后 pre-step，第一轮装配前技能表还是空的。
    // 这里先刷一次，保证第一轮就有正确的目录/常驻正文，第二轮不会因此改字节。
    try { await gate.ensureSkills(agent); } catch { /* 忽略 */ }

    // 先记录真实段落清单（摘之前），UI 靠它列出可选项。
    const inventory = [];
    for (const section of result.sections) {
      if (!section || typeof section.name !== "string") continue;
      // gate 自己注入的常驻技能段落不记账：它不是宿主段落、没有档位可配，出现在
      // 面板段落清单里只会诱导用户去摘一段他摘不动的文本。
      if (isGateSkillSection(section.name)) continue;
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
    // 常驻技能正文（工单 14）：独立段落追加在末尾，不进 gate-catalog 的行里。
    // 同策略 + 同一份技能正文 ⇒ 逐字节稳定（段落内容只由 gate.skillSections 决定，不带时间戳）。
    let resident = [];
    // 宿主技能正文要回查 ctx.skills.get，所以这里是异步的（导入技能已经带正文）。
    // P2-7：把 turn 的 signal 传进去，装配期回查正文才可随 abort 取消（宿主 get 只在有 signal 时 waitWithAbort）。
    try { resident = await gate.skillSections(agent, context && context.signal) || []; } catch { resident = []; }
    for (const section of resident) {
      if (!section || typeof section.name !== "string") continue;
      const index = sections.findIndex((row) => row && row.name === section.name);
      if (index >= 0) sections[index] = section;
      else sections.push(section);
    }
    return { ...result, sections };
  });
}
