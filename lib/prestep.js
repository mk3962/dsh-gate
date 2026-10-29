/**
 * 技能闸门：skill 目录是 @deepseek-ai/dsh-tool-skill 在 pre-step 注入的一条 user message。
 *  - skill 工具本身被藏起来时，宿主自己就不注入目录（零成本）。
 *  - skill 工具常驻但策略要求技能按需时，这里把目录那条消息摘掉，名字交给 gate 目录列出。
 *  - 技能常驻（tier=1，默认）时也要**记录**名单：否则 UI 的技能列永远是空的，
 *    用户根本没机会把某个技能改成按需（真事故：默认设置下面板技能区一直空）。
 */

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

export function mountSkillGate(options) {
  const ctx = options.ctx;
  const gate = options.gate;
  const policy = options.policy;

  return ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (!decision || decision.kind !== "enter" || !Array.isArray(decision.messages)) return decision;
    if (policy.enabled === false) return decision;
    const agent = payload && payload.agent;
    const skills = collectSkillEntries(decision.messages);
    // 先记账：常驻、按需两种档位都要能在 UI 里看到并切换。
    if (agent !== undefined && skills.length > 0) gate.rememberSkills(agent, skills);
    if (policy.skills && policy.skills.tier === 1) return decision;
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
