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
export const SKILL_INVOCATION_KIND = "skill-invocation";

export function isSkillCatalogMessage(message) {
  const source = message && message.source;
  if (!source || typeof source !== "object") return false;
  if (source.kind !== SKILL_CATALOG_KIND) return false;
  return source.form === undefined || source.form === "catalog";
}

/**
 * 「是不是宿主的技能目录消息」—— 只看 source.kind，不看 form/entries（工单 14）。
 * 接管后必须**无条件**摘掉全部 skill-catalog：宿主在 skill 工具不可见时仍会补发一条
 * entries=[] 的 replacement（"No skills are currently available…"，TS:956-964），
 * 只按「按需档」摘会把它漏过去，模型就会以为这一会话没有任何技能。
 */
export function isSkillCatalogLike(message) {
  const source = message && message.source;
  return Boolean(source && typeof source === "object" && source.kind === SKILL_CATALOG_KIND);
}

/**
 * 用户显式调用技能（/name）时宿主注入的正文消息（TS:913-924）。接管后正文改由 gate_load 出，
 * 这条应当摘掉，否则同一份正文会出现两次（宿主那条还不受 gate 的 off 控制）。
 */
export function isSkillInvocationMessage(message) {
  const source = message && message.source;
  return Boolean(source && typeof source === "object" && source.kind === SKILL_INVOCATION_KIND);
}

/** 这条 /name 正文是不是 gate 自己注入的（重复注入要能被自己认出来）。 */
export function isGateSkillInvocation(message) {
  const source = message && message.source;
  return Boolean(source && typeof source === "object" && source.kind === SKILL_INVOCATION_KIND && source.gate === "dsh-gate");
}

/** 用户手打 /name 的名字文法（与宿主一致：小写字母数字 + 连字符）。 */
const SLASH_NAME = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/**
 * 从本轮 claimed 的用户消息里认出「整条正文就是一个 /name」。
 * 只认整条（不是包含），避免把正文里出现的 /xxx 误当调用；gate 自己造的消息一律跳过。
 * 返回去重保序的名字数组；是否存在、叫什么档位由调用方（gate 技能表）判定。
 */
export function collectSlashInvocations(messages) {
  const names = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role !== "user") continue;
    if (isSkillCatalogLike(message) || isSkillInvocationMessage(message) || isTailMessage(message)) continue;
    const text = messageTextOf(message).trim();
    const match = SLASH_NAME.exec(text);
    if (match === null) continue;
    const name = match[1];
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** 一条技能正文消息（与宿主同形；source.gate 是我们的标记，用来做到幂等）。 */
const makeSkillInvocationMessage = async (name, text) => {
  const input = {
    content: [{ type: "text", text }],
    source: { kind: SKILL_INVOCATION_KIND, name, form: "instructions", gate: "dsh-gate" },
  };
  if (createUserMessageImpl === undefined) await loadCreateUserMessage();
  if (createUserMessageImpl !== null) {
    try { return createUserMessageImpl(input); } catch { /* 退化成同形状对象 */ }
  }
  return Object.assign({ role: "user" }, input, {
    id: "gate-skill-invocation-" + createHash("sha1").update(name + "\u0000" + text).digest("hex").slice(0, 12),
  });
};

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

/**
 * 技能闸门（0.3.0 工单 14 接管版）：
 *
 *   takeover=true（默认）—— gate 是技能注入的唯一入口：
 *     · 名单自己维护（ctx.skills.list + gate.json 的 skills.imports 扫描，见 gate.refreshSkills）；
 *     · 宿主的两条消息**按 source.kind 无条件摘掉**：skill-catalog（含 entries=[] 的 replacement）
 *       与 skill-invocation（用户 /name 显式调用时宿主注入的正文）；
 *     · 目录进 gate-catalog、常驻正文进系统提示词独立段落、正文走 gate_load("skill:x")。
 *
 *   takeover=false —— 完整退回 0.1.8：只按档位摘目录（常驻时不摘），名单从目录消息里读，
 *     正文由宿主 skill 工具负责（gate_load 仍转发）。
 *
 * 摘除是幂等的：同一份历史每一步都按 kind 过滤，不依赖上一次是否摘过（durable 历史里
 * 早期版本的目录消息也照摘）。
 */
export function mountSkillGate(options) {
  const ctx = options.ctx;
  const gate = options.gate;
  const policy = options.policy;

  return ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (!decision || decision.kind !== "enter" || !Array.isArray(decision.messages)) return decision;
    if (policy.enabled === false) return decision;
    const agent = payload && payload.agent;
    const signal = payload && payload.signal;
    const takeover = !(policy.skills && policy.skills.takeover === false);
    const collected = collectSkillEntries(decision.messages);
    if (takeover) {
      // 名单自己维护；宿主服务缺失时 refreshSkills 会用本轮目录消息里的 entries 兜底。
      try { await gate.refreshSkills(agent, signal, collected); } catch { /* 刷新失败不影响摘除：下一步还会再试 */ }
    } else {
      const skills = await withSkillProviders(ctx, agent, collected, signal);
      // 先记账：常驻、按需两种档位都要能在 UI 里看到并切换。
      if (agent !== undefined && skills.length > 0) gate.rememberSkills(agent, skills);
    }
    // 技能轴真源是 defaults.skillpack；skills.tier 只是 0.1.8 的只读别名。
    const skillTier = policy.skills && policy.skills.tier !== undefined ? policy.skills.tier : defaultsOf(policy).skillpack;
    // 层值是 policy.js 的常量，别在这里写裸 1（改了常量这一处会静默跟丢）。
    const stripAll = takeover || skillTier !== TIER_RESIDENT;
    if (!stripAll) return decision;
    // 用户 /name 显式调用：宿主注入的正文与 skill 工具是否可见无关，必须自己接过来。
    // 收集本轮所有 invocation 消息里的名字（宿主原文 + 上一步我们自己注入的都算），
    // 去重保序；然后按 gate 的技能表判档，off/shadowed 不注入，其余用 gate 渲染的正文各注入一条。
    // 幂等：每步都先全摘再按同一份名字表重注入 ⇒ 同一步重复跑、decision 已含我们的消息，都只留一条。
    const invoked = [];
    const priorGate = new Map();
    if (takeover) {
      for (const message of decision.messages) {
        if (!isSkillInvocationMessage(message)) continue;
        const name = message.source && message.source.name;
        if (typeof name !== "string" || name.length === 0) continue;
        if (!invoked.includes(name)) invoked.push(name);
        // 上一步我们自己注入的同名消息：正文没变就复用同一个对象（id 也不换），
        // 否则每步都生成新 id，前缀缓存会从这条消息处断掉。
        if (isGateSkillInvocation(message)) priorGate.set(name, message);
      }
      // P2-12（复核 2026-11-14）：导入技能宿主不认识，用户打 /导入技能名 时宿主当普通文本，
      // 于是「/name 只对宿主技能有效」——这与「接管后技能统一由 gate 管」矛盾。
      // 这里按**严格词法**兜底：本轮 claimed 的用户消息正文整体就是 /<技能名> 时，
      // 若该名字属于 gate 技能表，按同一份正文注入（渲染/判档/reason 全部复用 resolveSkill）。
      for (const name of collectSlashInvocations(decision.messages)) {
        if (!invoked.includes(name)) invoked.push(name);
      }
    }
    let removed = 0;
    const kept = [];
    for (const message of decision.messages) {
      const drop = takeover
        ? isSkillCatalogLike(message) || isSkillInvocationMessage(message)
        : isSkillCatalogMessage(message);
      if (drop) { removed += 1; continue; }
      kept.push(message);
    }
    let added = 0;
    if (takeover && invoked.length > 0) {
      for (const name of invoked) {
        let rendered;
        try { rendered = await gate.renderSkill(agent, name, signal); } catch { rendered = { ok: false }; }
        if (!rendered || rendered.ok !== true) continue;
        const prior = priorGate.get(name);
        if (prior !== undefined && messageTextOf(prior) === rendered.text) {
          kept.push(prior);
          added += 1;
          continue;
        }
        kept.push(await makeSkillInvocationMessage(rendered.name, rendered.text));
        added += 1;
      }
    }
    // 什么都没摘、也没注入（例如本轮没有任何技能消息）：原样返回，不制造一份新数组。
    if (removed === 0 && added === 0) return decision;
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
 * 每个 agent 上一次**确实追加过**的声明正文。
 *
 * 为什么必须记：宿主的 `agent/pre-step` 交给监听者的 `decision.messages` 是本轮
 * `inbox.claim()` 出来的**新增消息**（见 dsh-agent-loop/src/agent.ts 的 preStep），
 * 历史里的尾部块永远不会出现在里面；而监听者返回的数组只会被 `append` 进会话表面，
 * 摘除历史消息这条路不存在。所以「内容没变就复用同一条消息」在这里做不到 ——
 * 唯一能防住累积的是**自己记住上次发了什么、没变就别再发**。
 */
const lastEmitted = new WeakMap();

const rememberTail = (agent, text) => {
  if (agent !== null && typeof agent === "object") lastEmitted.set(agent, text);
};

/**
 * 从会话表面读回「仍在上下文里的那条声明」的正文。
 *
 * 宿主给了 `agent.session`（Session 表面 API）时以它为准：声明被压缩/替换掉之后
 * 读回来是空串，下一步就会重新补一条（自愈）；读不到就用内存里的 lastEmitted 兜底。
 * 会话 API 的形状在宿主版本间变过，这里全部特性探测 + try/catch，拿不到返回 undefined。
 */
const retainedTailText = (agent) => {
  try {
    const session = agent && agent.session;
    const surface = session && session.surface;
    const nodes = surface && surface.nodes;
    if (!nodes || typeof session.eventAt !== "function") return undefined;
    const list = Array.from(nodes);
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const event = session.eventAt(list[i]);
      if (!event || event.type !== "user/message") continue;
      const data = event.data;
      const message = data && data.message !== undefined ? data.message : data;
      if (isTailMessage(message)) return messageTextOf(message);
    }
    return "";
  } catch { return undefined; }
};

/**
 * 建一条 user 消息。优先用宿主的 createUserMessage（带 id 与深冻结）；
 * 拿不到就退化成同形状对象。退化 id 用正文哈希而不是随机数：同一份声明重放时**逐字节一致**，
 * 否则每一步都会因为 id 变了而让前缀缓存从这条消息处断掉。
 */
let createUserMessageImpl;
const loadCreateUserMessage = async () => {
  try {
    const llm = await import("@deepseek-ai/dsh-llm");
    createUserMessageImpl = typeof llm.createUserMessage === "function" ? llm.createUserMessage : null;
  } catch { createUserMessageImpl = null; }
  return createUserMessageImpl;
};
const makeTailMessage = async (text) => {
  if (createUserMessageImpl === undefined) await loadCreateUserMessage();
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
 * 纪律（0.3.1 按宿主真实契约改写）：
 *  - 宿主交给 pre-step 的 decision.messages **只是本轮新 claim 的消息**（dsh-agent-loop/src/agent.ts
 *    的 preStep 里 claimed = inbox.claim(...)），历史里的尾部块不会出现在这里；返回的数组只会被
 *    append 进会话表面，摘除历史消息没有通道。所以这里**不能**指望「复用同一条消息对象」，
 *    只能靠「上下文里已经有同一份声明就别再发」来防止一步一条的累积。
 *  - 追加时机只有三种：上下文里没有这份声明、声明正文变了、或者清空（native / 未加载）。
 *  - 已有消息一个都不改、不重排；只摘掉本轮携带的尾部块。
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
      // 没有要声明的（native / 还没加载）：把本轮携带的残留尾部块摘掉，其它消息不动。
      rememberTail(agent, "");
      if (existing.length === 0) return decision;
      return { ...decision, messages: decision.messages.filter((message) => !isTailMessage(message)) };
    }
    // 少数宿主/版本会把历史回灌进 decision.messages：已经在末尾且正文一致就一条都不动。
    const last = decision.messages[decision.messages.length - 1];
    if (existing.length === 1 && existing[0] === last && messageTextOf(existing[0]) === text) {
      rememberTail(agent, text);
      return decision;
    }
    const kept = decision.messages.filter((message) => !isTailMessage(message));
    if (existing.length === 1 && messageTextOf(existing[0]) === text) {
      // 清单没变、只是不在末尾：搬同一条消息对象（id 与字节都不变），别新建。
      kept.push(existing[0]);
      rememberTail(agent, text);
      return { ...decision, messages: kept };
    }
    // 上下文里已经有同一份声明（表面读得到 / 上次发过的就是它）：不再重复追加。
    // 这是必须防住的累积路径 —— 每步追加一条 = 一条约 170 token 的声明在历史里越堆越多。
    const retained = retainedTailText(agent);
    const known = retained === undefined ? lastEmitted.get(agent) : retained;
    if (known === text) {
      rememberTail(agent, text);
      return existing.length === 0 ? decision : { ...decision, messages: kept };
    }
    // 本轮宿主一条新消息都没交（纯 continuation）：别只塞一条声明把空步撑起来。
    if (decision.messages.length === 0) return decision;
    kept.push(await makeTailMessage(text));
    rememberTail(agent, text);
    return { ...decision, messages: kept };
  }, { prepend: true });
}
