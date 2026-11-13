/**
 * 技能闸门：skill 目录是 @deepseek-ai/dsh-tool-skill 在 pre-step 注入的一条 user message。
 *  - skill 工具本身被藏起来时，宿主自己就不注入目录（零成本）。
 *  - skill 工具常驻但策略要求技能按需时，这里把目录那条消息摘掉，名字交给 gate 目录列出。
 *  - 技能常驻（tier=1，默认）时也要**记录**名单：否则 UI 的技能列永远是空的，
 *    用户根本没机会把某个技能改成按需（真事故：默认设置下面板技能区一直空）。
 */

import { createHash } from "node:crypto";
import { TIER_RESIDENT } from "./policy.js";
import { defaultsOf } from "./capabilities.js";
import { resolveService } from "./server.js";

export const SKILL_CATALOG_KIND = "skill-catalog";

export function isSkillCatalogMessage(message) {
  const source = message && message.source;
  if (!source || typeof source !== "object") return false;
  if (source.kind !== SKILL_CATALOG_KIND) return false;
  return source.form === undefined || source.form === "catalog";
}

/** 从 pre-step 的消息里取出技能清单（名字 + 描述）。 */
export function collectSkillEntries(messages) {
  const skills = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isSkillCatalogMessage(message)) continue;
    const entries = message.source && message.source.entries;
    if (!Array.isArray(entries)) continue;
    for (const item of entries) {
      if (item && typeof item.name === "string") skills.push({ name: item.name, description: item.description });
    }
  }
  return skills;
}

/**
 * 给技能清单补 provider（来源标注的唯一可信信号，docs 02 A7）。
 * 宿主只把 name/description 投影进目录消息（A8），provider 只能回查 ctx.skills.list；
 * 取不到就保持原样（来源标 unknown），绝不拿 description 猜归属。
 * 按 agent 缓存：名单没变时不重复查（每一步 pre-step 都会走到这里）。
 */
const skillProviderCache = new WeakMap();

async function withSkillProviders(ctx, agent, skills, signal) {
  if (!Array.isArray(skills) || skills.length === 0) return skills;
  const key = skills.map((item) => item.name).join("\u0000");
  if (agent !== null && typeof agent === "object") {
    const cached = skillProviderCache.get(agent);
    if (cached !== undefined && cached.key === key) {
      return cached.skills.map((item) => ({ ...item }));
    }
  }
  const service = resolveService(ctx, "skills");
  if (service === undefined || typeof service.list !== "function") return skills;
  try {
    const workingDirectory = resolveService(ctx, "workingDirectory");
    const cwd = workingDirectory && typeof workingDirectory.ensure === "function"
      ? await workingDirectory.ensure(agent, signal)
      : undefined;
    const list = await service.list({ cwd, signal, scope: agent });
    const providers = new Map();
    for (const item of Array.isArray(list) ? list : []) {
      if (item && typeof item.name === "string" && typeof item.provider === "string" && item.provider.length > 0) {
        providers.set(item.name, item.provider);
      }
    }
    if (providers.size === 0) return skills;
    const enriched = skills.map((item) => (providers.has(item.name) ? { ...item, provider: providers.get(item.name) } : item));
    if (agent !== null && typeof agent === "object") skillProviderCache.set(agent, { key, skills: enriched });
    return enriched.map((item) => ({ ...item }));
  } catch {
    return skills;
  }
}

export function mountSkillGate(options) {
  const ctx = options.ctx;
  const gate = options.gate;
  const policy = options.policy;

  return ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (!decision || decision.kind !== "enter" || !Array.isArray(decision.messages)) return decision;
    if (policy.enabled === false) return decision;
    const agent = payload && payload.agent;
    const collected = collectSkillEntries(decision.messages);
    const skills = await withSkillProviders(ctx, agent, collected, payload && payload.signal);
    // 先记账：常驻、按需两种档位都要能在 UI 里看到并切换。
    if (agent !== undefined && skills.length > 0) gate.rememberSkills(agent, skills);
    // 技能轴真源是 defaults.skillpack；skills.tier 只是 0.1.8 的只读别名。
    const skillTier = policy.skills && policy.skills.tier !== undefined ? policy.skills.tier : defaultsOf(policy).skillpack;
    // 层值是 policy.js 的常量，别在这里写裸 1（改了常量这一处会静默跟丢）。
    if (skillTier === TIER_RESIDENT) return decision;
    let removed = 0;
    const kept = [];
    for (const message of decision.messages) {
      if (isSkillCatalogMessage(message)) { removed += 1; continue; }
      kept.push(message);
    }
    if (removed === 0) return decision;
    return { ...decision, messages: kept };
  }, { prepend: true });
}
/** PTC 冻结下「已加载能力声明块」的来源标记（pre-step 追加的那条 user 消息）。 */
export const TAIL_KIND = "gate-tail";

export const isTailMessage = (message) => Boolean(
  message && message.source && typeof message.source === "object" && message.source.kind === TAIL_KIND,
);

export const messageTextOf = (message) => {
  const blocks = message && Array.isArray(message.content) ? message.content : [];
  const parts = [];
  for (const block of blocks) if (block && typeof block.text === "string") parts.push(block.text);
  return parts.join("\n");
};

/**
 * 建一条 user 消息。优先用宿主的 createUserMessage（带 id 与深冻结）；
 * 拿不到就退化成同形状对象。退化 id 用正文哈希而不是随机数：同一份声明重放时**逐字节一致**，
 * 否则每一步都会因为 id 变了而让前缀缓存从这条消息处断掉。
 */
let createUserMessageImpl;
const makeTailMessage = async (text) => {
  if (createUserMessageImpl === undefined) {
    try {
      const llm = await import("@deepseek-ai/dsh-llm");
      createUserMessageImpl = typeof llm.createUserMessage === "function" ? llm.createUserMessage : null;
    } catch { createUserMessageImpl = null; }
  }
  const input = { content: [{ type: "text", text }], source: { kind: TAIL_KIND } };
  if (createUserMessageImpl !== null) {
    try { return createUserMessageImpl(input); } catch { /* 退化成同形状对象 */ }
  }
  return Object.assign({ role: "user" }, input, {
    id: "gate-tail-" + createHash("sha1").update(text).digest("hex").slice(0, 12),
  });
};

/**
 * A 案（PTC 冻结）：把「已加载能力」的声明追加到本轮 messages 的**末尾**（工单 07）。
 *
 * 为什么不进系统提示词 / 工具声明：那两处一变，宿主前缀缓存就从那里断掉 ——
 * 原型实测每次 gate_load 后的未命中 2.7–3.0K token，搬到尾部后 0.3–0.4K（docs 03 §4）。
 *
 * 纪律：
 *  - 已有消息一个都不改、不重排；只摘掉上一步我们自己加的尾部块，再追加新块到末尾。
 *  - 声明清单没变就一条都不动（原地复用同一条消息，连 id 都不换）。
 *  - native 模式 gate.loadedTextFor() 恒为空 ⇒ 不追加、也不会残留旧块（清干净后原样返回）。
 */
export function mountTailGate(options) {
  const ctx = options.ctx;
  const gate = options.gate;
  const policy = options.policy;

  return ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (!decision || decision.kind !== "enter" || !Array.isArray(decision.messages)) return decision;
    if (policy.enabled === false) return decision;
    const agent = payload && payload.agent;
    let text = "";
    try { text = gate.loadedTextFor(agent) || ""; } catch { text = ""; }
    const existing = decision.messages.filter(isTailMessage);
    if (text === "") {
      // 没有要声明的（native / 还没加载）：把历史里残留的尾部块摘掉，其它消息不动。
      if (existing.length === 0) return decision;
      return { ...decision, messages: decision.messages.filter((message) => !isTailMessage(message)) };
    }
    const last = decision.messages[decision.messages.length - 1];
    if (existing.length === 1 && existing[0] === last && messageTextOf(existing[0]) === text) return decision;
    const kept = decision.messages.filter((message) => !isTailMessage(message));
    // 清单没变、只是不在末尾：搬同一条消息对象（id 与字节都不变），别新建。
    if (existing.length === 1 && messageTextOf(existing[0]) === text) {
      kept.push(existing[0]);
      return { ...decision, messages: kept };
    }
    kept.push(await makeTailMessage(text));
    return { ...decision, messages: kept };
  }, { prepend: true });
}
