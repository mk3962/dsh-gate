/**
 * 段落闸门：在 system-prompt/assemble 里摘掉按需段落，并把第二层目录插进去。
 * context.scope 就是 agent（dsh-ops 生产代码同样用法）。
 *
 * 0.6.0（D13 / 票 #04）把这一段拆成**两个深接口**，钩子只做薄适配：
 *   1) prepareAssembly —— 装配准备：挂载校验、技能准备、重算（并返回本轮装配输入）。
 *      这三件事必须在 next() **之前**做完：宿主是在 next() 内部按「当时可见的工具」渲染
 *      tools:sdk 段落的，限制晚一步落下，那一步就必然渲染成全量工具声明。
 *      2026-11-14 热重载事故：147 个工具 / 162,551 字符（正常 31 个 / 45,245），
 *      该步 cacheRead 199,552 → 2,048，下一步 6,144。顺序写错的代价是前缀缓存整段作废。
 *   2) applyAssembly —— 装配应用：记录段落清单（含淘汰）、规划、渲染目录与常驻段落。
 * 七步时序封在闸门内部，外层钩子只剩「调用 + 转发」，写错顺序不会再复现缓存雪崩（C42）。
 */
import { estimateTokens } from "./catalog.js";
import { isGateSkillSection } from "./skills.js";

export const CATALOG_SECTION = "gate-catalog";
/** 每轮交给闸门记账的段落条数上限（与 gate 的库存容量独立：这里是「本轮看得见多少」）。 */
const INVENTORY_CAP = 80;

/**
 * 装配准备（必须在 next() 之前调用）。
 * @returns {Promise<object|undefined>} 闸门计划（拿不到 agent/策略关闭时 undefined）
 */
export async function prepareAssembly(options) {
  const gate = options.gate;
  const policy = options.policy;
  const agent = options.agent;
  if (!agent || policy.enabled === false) return undefined;
  // 挂载是异步的：attach 交给我们的就是「就绪」这件事本身。
  try { await gate.attach(agent); } catch { /* 忽略 */ }
  // 首步兜底（P1-2）：宿主先 assemble 后 pre-step，第一轮装配前技能表还是空的。
  try { await gate.ensureSkills(agent); } catch { /* 忽略 */ }
  // reload 后 entry 可能刚建好、scoped 还没就绪：渲染前显式再推一次目标形状，
  // 让 deny 一定先于 tools:sdk 生效。
  try { return gate.reapply(agent); } catch { return undefined; }
}

/**
 * 装配应用：记录清单 → 规划 → 摘除按需段落 → 追加目录与常驻技能正文。
 * @returns {Promise<object>} 新的 assembly（原对象在无需改动时原样返回）
 */
export async function applyAssembly(options) {
  const gate = options.gate;
  const logger = options.logger;
  const agent = options.agent;
  const assembly = options.assembly;
  const context = options.context;
  if (!agent || !assembly || !Array.isArray(assembly.sections)) return assembly;
  if (options.policy && options.policy.enabled === false) return assembly;

  // 先记录真实段落清单（摘之前），UI 靠它列出可选项。
  // 正文一起交给闸门：库存淘汰（C43）要按「被策略引用 / 在目录 / 已加载」挑孤儿，
  // 正文与清单必须同批进出（否则淘汰了名单、正文残留，下次装配又变成占位）。
  const inventory = [];
  for (const section of assembly.sections) {
    if (!section || typeof section.name !== "string") continue;
    // gate 自己注入的常驻技能段落不记账：它不是宿主段落、没有档位可配。
    if (isGateSkillSection(section.name)) continue;
    const text = typeof section.text === "string" ? section.text : "";
    inventory.push({ name: section.name, chars: text.length, tokens: estimateTokens(text), text });
  }
  inventory.sort((a, b) => b.chars - a.chars);
  gate.recordSections(agent, inventory.slice(0, INVENTORY_CAP));

  const plan = gate.planSections(agent);
  const dropped = [];
  const kept = assembly.sections.filter((section) => {
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
  // P2-7：把 turn 的 signal 传进去，装配期回查正文才可随 abort 取消。
  try { resident = await gate.skillSections(agent, context && context.signal) || []; } catch { resident = []; }
  for (const section of resident) {
    if (!section || typeof section.name !== "string") continue;
    const index = sections.findIndex((row) => row && row.name === section.name);
    if (index >= 0) sections[index] = section;
    else sections.push(section);
  }
  return { ...assembly, sections };
}

/** 薄适配器：宿主钩子只做「准备 → 委派 → 应用」三件事。 */
export function mountSectionGate(options) {
  const ctx = options.ctx;
  return ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    const agent = context && context.scope;
    await prepareAssembly({ gate: options.gate, policy: options.policy, agent });
    const result = await next();
    return applyAssembly({
      gate: options.gate,
      logger: options.logger,
      policy: options.policy,
      agent,
      assembly: result,
      context,
    });
  });
}
