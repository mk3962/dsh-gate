/**
 * 重复调用护栏（0.5.3 起源 · 0.6.0 票 #04 / D11 重写）。
 *
 * ## 为什么在 gate 里做
 * 上游 @deepseek-ai/dsh-repeat-tool-reminder 是 asar 里的宿主产物，判据只有一条：「**连续**同样调用」。
 * 实测（7dff3468，402 次 pwsh 调用）最长连续同签名 run 只有 2 —— 同一回合里 run_code（外层）
 * 与 PTC 内层 pwsh 交替落事件，每来一条别的调用就把链重置为 1。该会话里 107 处同命令重复，
 * 现行判据**一次都没触发**。判据升级只能落到源码层，而 gate 是自己的包 ⇒ R2 合并进 gate。
 *
 * ⚠️ 合并就要停用上游那一行（profile 的 cordis.patch.yml：`- id: repeat-tool-reminder / disabled: true`）：
 * 护栏状态是进程内 per-agent，两套监听器同时挂 = 每条提醒都发两次。
 *
 * ## 判据（三道，缺一不可）
 * 1) **身份仍是精确签名** (工具名, 深键序 JSON(args))。换参数 = 新签名 = 天然不触发。
 * 2) **相邻性换成窗口**：同一签名两次出现之间允许夹 ≤ windowSize 条被跟踪调用。
 * 3) **结果指纹**：len + sha1(前/中/后各 4KB) + isError。结果变了就是进展。
 *
 * ## 0.6.0 的四处修正（票 #04 · D11，改之前先读）
 * - **热生效（C38）**：配置每次事件现读（policy.repeatGuard 被 server 就地更新），
 *   编译后的排除模式按配置指纹缓存 —— 面板一保存，下一次调用就按新配置判定，不用重载插件。
 * - **单计数（C40 / P2-5）**：闸门工具族（gate_invoke / gate_call / gate_load / gate_search /
 *   gate_status）永远不进计数；转发结果带 COUNTED_MARK（内层执行已计入）时直接跳过 ——
 *   一次转发只推进一次时钟。
 * - **两个计数（C39）**：consecutiveSameCount 决定何时提醒、remindedCount 决定配额；
 *   结果指纹一变，两者**一起归零**（结果变了 = 有进展；之后再次重复，按同一阈值重新提醒）。
 * - **重置来源（C41 / C44）**：只认本轮决策结果的消息数组（decision.messages），
 *   用户消息用统一谓词（role === "user" 或 source.kind === "user"），**gate 自己造的消息不算**；
 *   入口为空时显式降级（本轮不重置）并计数，不再把「没消息」当成「用户插话」。
 */

import { createHash } from "node:crypto";
import { createGateUserMessage } from "./messages.js";
import { GATE_TOOL_FAMILY, COUNTED_MARK, textViewOf } from "./normalize.js";

/** 提醒消息的来源标记：客户端/其它插件靠它认出「这是我们发的」，不要改成上游的 kind。 */
export const REPEAT_GUARD_KIND = "gate-repeat-guard";

/** gate 自己注入的消息来源（这些 role 也是 user，但**不是**用户插话）。 */
const GATE_AUTHORED_KINDS = Object.freeze(["gate-tail", "gate-repeat-guard", "skill-catalog", "skill-invocation"]);

/**
 * 「合法用法就是同参数反复调、结果一样」的工具。exclude 语义是**透明**：
 * 不参与计数，也不重置别人的链（每条签名各自独立，所以「不重置」天然成立）。
 *   wait_agent  — 等消息，空结果即正常
 *   todo_write  — 每步重写同一份清单是约定动作
 *   list_agents / job_list / team_task_list — 轮询型只读清单
 */
export const DEFAULT_EXCLUDE = Object.freeze(["wait_agent", "todo_write", "list_agents", "job_list", "team_task_list"]);

/** 指纹采样：每段 4 KB，总计算量 ≈ 12 KB/次（1 MB 的 read 结果也不再全量哈希）。 */
const SAMPLE_BYTES = 4096;
/** 每 agent 的 episode 表上限：108 个签名 × 20 int 本来就可忽略，但不设上限会被长会话撑爆。 */
const EPISODE_CAP = 256;
/** 吞错样本上限（D20 / C48：进计数并保留最近样本，供诊断端点读）。 */
const SWALLOWED_CAP = 16;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** 取整并夹紧：写小了给下限、写大了给上限（静默退回默认值会把用户的意图藏起来）。 */
const intOr = (value, fallback, min, max) => {
  if (typeof value !== "number" && typeof value !== "string") return fallback;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(Math.max(number, min), max);
};

/**
 * 护栏配置归一（gate.json 的 `repeatGuard` 键）。
 *
 * **默认关闭**：它替的是宿主自带的那条护栏，默认开会和多数人的宿主插件双提醒。
 */
export function normalizeRepeatGuardConfig(raw) {
  const input = isPlainObject(raw) ? raw : {};
  /**
   * exclude = 默认五个 **恒在** + 用户追加项。
   * 曾经写成「用户写了 exclude 就整体替换」：用户只加一个 `gate_*`，轮询类（wait_agent / job_list）
   * 立刻恢复计数，第一次轮询就被当循环提醒 —— 正好违背「透明语义」这条契约。
   */
  const exclude = [...DEFAULT_EXCLUDE];
  for (const name of Array.isArray(input.exclude) ? input.exclude : []) {
    if (typeof name === "string" && name.length > 0 && !exclude.includes(name)) exclude.push(name);
  }
  return {
    enabled: input.enabled === true,
    windowSize: intOr(input.windowSize, 20, 2, 200),
    windowThreshold: intOr(input.windowThreshold, 3, 2, 50),
    maxRemindersPerEpisode: intOr(input.maxRemindersPerEpisode, 2, 1, 5),
    exclude,
    argumentsPreviewChars: intOr(input.argumentsPreviewChars, 500, 40, 4000),
  };
}

/** 深键序：只差属性顺序的两个 args 必须归一到同一个签名（与宿主同口径）。 */
function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (isPlainObject(value)) {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortJsonValue(value[key]);
    return sorted;
  }
  return value;
}

/** 精确签名：工具名 + 深键序 JSON(args)。换参数 = 新签名。 */
export function signatureOf(name, argumentsValue) {
  let canonical;
  try { canonical = JSON.stringify(sortJsonValue(argumentsValue === undefined ? null : argumentsValue)); } catch { canonical = String(argumentsValue); }
  return JSON.stringify([name, canonical]);
}

/** 通配符（只认 `*`）→ 锚定正则；其余元字符按字面量。 */
export function wildcardToRegExp(pattern) {
  const escaped = String(pattern).replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`);
  return new RegExp("^" + escaped.replaceAll("*", ".*") + "$");
}

/**
 * 结果正文 = 规范化器的**文本视图**（C34：拍平只有一份实现，护栏不再自己写一遍）。
 * 非 text 块由规范化器决定「降级/省略」，不会把 base64 灌进指纹。
 */
function resultTextOf(result) {
  return textViewOf(result);
}

/**
 * 策略拒绝的判定：被 deny/未知工具挡下的调用**不进指纹**（用固定哨兵代替）。
 * 理由：这类结果本来就是策略生成的错误文本，「结果一样」不代表进展，也不该被当成
 * 「结果变了」而重置 —— 模型对着一个 deny 反复硬撞，正是最该被看见的循环。
 */
const isDenialCode = (code) => typeof code === "string" && (code === "UNKNOWN_TOOL" || code.includes("DENIED") || code === "CANCELED");

/**
 * 结果指纹：len + sha1(前/中/后各 4KB) + isError。
 * 采样判别力足够（长度也进指纹）：整份 1 MB 结果全量哈希的代价换不来更准的「变没变」。
 */
export function fingerprintOf(result) {
  const isError = Boolean(result && result.isError === true);
  const code = isError && result && result.error && result.error.info ? result.error.info.code : undefined;
  if (isError && isDenialCode(code)) return "D:denied";
  const text = resultTextOf(result);
  const length = text.length;
  const head = text.slice(0, SAMPLE_BYTES);
  const middle = length > SAMPLE_BYTES * 2
    ? text.slice(Math.floor(length / 2) - SAMPLE_BYTES / 2, Math.floor(length / 2) + SAMPLE_BYTES / 2)
    : "";
  const tail = length > SAMPLE_BYTES ? text.slice(-SAMPLE_BYTES) : "";
  const digest = createHash("sha1").update(head).update("\u0000").update(middle).update("\u0000").update(tail).digest("hex");
  return (isError ? "E:" : "O:") + length + ":" + digest;
}

/** 参数预览：只截断**展示**，判据永远用完整签名（上游 src:44-49 已写对，别改）。 */
function previewArguments(canonical, cap) {
  if (canonical.length <= cap) return canonical;
  return canonical.slice(0, cap) + "… (+" + (canonical.length - cap) + " more chars)";
}

const OPTIONS = [
  "  (a) if you are waiting for a condition, run a background job and poll it with job_output({ job_id, wait: true });",
  "  (b) if the result is already what you need, continue with the next step instead of re-checking;",
  "  (c) if you expect the value to change, change the argument that selects what you read (path / offset / filter / limit).",
];

/** 第一次提醒：一句话 + 三个替代动作（不点名历史下标，避免噪音）。 */
function gentleText(name, canonical, copies, windowSize, cap) {
  return [
    "Repeated tool call detected (same arguments, same output):",
    "- tool: " + name,
    "- occurrences: " + copies + " within the last " + windowSize + " tracked calls",
    "- arguments: " + previewArguments(canonical, cap),
    "- output_unchanged: yes (identical across all " + copies + " calls)",
    "The repeats are not producing new information. Choose one:",
    ...OPTIONS,
  ].join("\n");
}

/** 第二次（本 episode 最后一次）提醒：补上出现位置，把「同一结论被重复确认了几次」摆明。 */
function detailedText(name, canonical, copies, positions, cap) {
  const shown = positions.slice(-6).join(", ");
  return [
    "Repeated tool call detected (same arguments, same output):",
    "- tool: " + name,
    "- occurrences: " + copies + " (at tracked call #" + shown + (positions.length > 6 ? ", …" : "") + ")",
    "- arguments: " + previewArguments(canonical, cap),
    "- output_unchanged: yes (identical across all " + copies + " calls)",
    "Nothing new has arrived since the first of these calls. Choose one:",
    ...OPTIONS,
  ].join("\n");
}

/** 每 agent 的护栏状态：一个单调序号（按被跟踪调用推进）+ 一张按签名分桶的 episode 表。 */
const states = new WeakMap();

/** 诊断计数（D20：被吞异常进计数并保留最近样本，供 #06 诊断端点消费）。 */
const diagnostics = {
  /** 入口消息为空 ⇒ 本轮显式降级为「不重置」的次数（C44）。 */
  emptyInput: 0,
  /** 用户插话重置次数（C41）。 */
  resets: 0,
  /** 被吞的异常（最近 SWALLOWED_CAP 条）。 */
  swallowed: [],
  /** 已计入的调用总数（C40 的单计数侧写）。 */
  counted: 0,
  /** 因「内层已计入」而跳过的调用数（C40）。 */
  skippedInner: 0,
  /** 因闸门工具族被排除而跳过的调用数（C40 / P2-5）。 */
  skippedFamily: 0,
};

const swallow = (where, error) => {
  const row = { where, at: Date.now(), message: String((error && error.message) || error) };
  diagnostics.swallowed.push(row);
  while (diagnostics.swallowed.length > SWALLOWED_CAP) diagnostics.swallowed.shift();
};

/** 护栏诊断快照（测试与诊断端点共用；不参与判定）。 */
export const repeatGuardDiagnostics = () => ({
  ...diagnostics,
  swallowed: diagnostics.swallowed.map((row) => ({ ...row })),
});

/** 测试用：清诊断计数（不触碰 agent 状态）。 */
export const resetRepeatGuardDiagnostics = () => {
  diagnostics.emptyInput = 0;
  diagnostics.resets = 0;
  diagnostics.swallowed = [];
  diagnostics.counted = 0;
  diagnostics.skippedInner = 0;
  diagnostics.skippedFamily = 0;
};

const stateOf = (agent) => {
  let state = states.get(agent);
  if (state === undefined) {
    state = { clock: 0, episodes: new Map(), reminders: 0 };
    states.set(agent, state);
  }
  return state;
};

/** episode 表有界：超限时丢最久未出现的那几条（不是丢最新的 —— 正在循环的那条必须留住）。 */
function boundEpisodes(state) {
  if (state.episodes.size <= EPISODE_CAP) return;
  const rows = [...state.episodes.entries()].sort((a, b) => a[1].lastPos - b[1].lastPos);
  const drop = rows.length - EPISODE_CAP;
  for (let index = 0; index < drop; index += 1) state.episodes.delete(rows[index][0]);
}

/** gate 自己注入的消息：role 也是 user，但不是用户插话（C41）。 */
export function isGateAuthoredMessage(message) {
  const source = message && message.source;
  return Boolean(source && typeof source.kind === "string" && GATE_AUTHORED_KINDS.includes(source.kind));
}

/**
 * 统一用户消息谓词（C41）：role 或 source 任一命中即算用户插话，gate 自己造的不算。
 * 只写一份：pre-step 重置与别的诊断都读它，避免两处判据漂移。
 */
export function isUserTurnMessage(message) {
  if (!message || typeof message !== "object") return false;
  if (isGateAuthoredMessage(message)) return false;
  if (message.role === "user") return true;
  const source = message.source;
  return Boolean(source && typeof source === "object" && (source.kind === "user" || source.role === "user"));
}

/** 本轮是否有用户插话（数组里任意一条命中）。 */
export const hasUserTurn = (messages) => Array.isArray(messages) && messages.some((message) => isUserTurnMessage(message));

/**
 * 重置一个 agent 的护栏状态（C41 / C44）。**唯一重置入口**：pre-step 组合器与独立挂载都调它。
 * 返回本次是否真的重置了（入口为空 ⇒ false，调用方记降级计数）。
 */
export function resetRepeatGuard(agent, messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    diagnostics.emptyInput += 1;
    return false;
  }
  if (!hasUserTurn(messages)) return false;
  states.delete(agent);
  diagnostics.resets += 1;
  return true;
}

/**
 * 挂载护栏。
 *
 * @param {object} options
 * @param {object} options.ctx     插件 ctx（监听器随插件卸载一起撤销）
 * @param {object} options.policy  已解析策略（**每次事件现读** repeatGuard；就地更新即可热生效）
 * @param {object} [options.logger]
 * @param {boolean} [options.managePreStep] false 时不自挂 pre-step 重置（由有序管线统一调 resetRepeatGuard）
 * @returns {() => void} 卸载函数
 */
export function mountRepeatGuard(options) {
  const ctx = options.ctx;
  const policy = options.policy;
  const managePreStep = options.managePreStep !== false;

  /** 配置缓存：键 = 原始配置的稳定 JSON（配置一变缓存立刻失效，C38）。 */
  let cachedConfigKey;
  let cachedConfig;
  let cachedExcludes;
  let cachedExcludeKey;

  const configNow = () => {
    const raw = policy && policy.repeatGuard;
    const key = (() => { try { return JSON.stringify(raw === undefined ? null : raw); } catch { return String(raw); } })();
    if (cachedConfig === undefined || cachedConfigKey !== key) {
      cachedConfig = normalizeRepeatGuardConfig(raw);
      cachedConfigKey = key;
      cachedExcludes = undefined;
    }
    return cachedConfig;
  };

  /** 编译后的排除模式按「排除表指纹」缓存（C38：配置指纹变了才重编译）。 */
  const excludePatternsNow = (config) => {
    const key = config.exclude.join("\u0000");
    if (cachedExcludes === undefined || cachedExcludeKey !== key) {
      cachedExcludes = config.exclude.map(wildcardToRegExp);
      cachedExcludeKey = key;
    }
    return cachedExcludes;
  };

  /**
   * 是否跟踪这个名字（C40）：闸门工具族永远排除（一次转发只记内层那一次执行）。
   * 排除表是透明的：不计数，也不推进时钟。
   */
  const tracked = (name, config) => {
    if (typeof name !== "string" || name.length === 0) return false;
    if (GATE_TOOL_FAMILY.includes(name)) { diagnostics.skippedFamily += 1; return false; }
    return !excludePatternsNow(config).some((pattern) => pattern.test(name));
  };

  /** 已计入的 exec（同一个 exec 被两个挂载点各观察一次时只记账一次）。 */
  const countedExecs = new WeakSet();

  /**
   * 观察一次调用，返回要给模型的提醒（没有就 undefined）。
   * 计数在 post-execute 做：denied 调用也走同一条瀑布，而「对着 deny 反复硬撞」正是最该被看见的循环。
   */
  const observe = async (exec, result) => {
    const config = configNow();
    if (config.enabled !== true) return undefined;       // C38：总开关关闭时不计数
    if (!exec || !exec.agent) return undefined;          // 没有模型可提醒
    if (exec instanceof Object && countedExecs.has(exec)) return undefined;
    // C40：内层执行已经计入过（转发结果带标记）⇒ 外层不再推进时钟。
    if (result !== null && typeof result === "object" && result[COUNTED_MARK] === true) {
      diagnostics.skippedInner += 1;
      return undefined;
    }
    if (!tracked(exec.name, config)) return undefined;
    const state = stateOf(exec.agent);
    const key = signatureOf(exec.name, exec.arguments);
    let canonical = "";
    try { canonical = JSON.stringify(sortJsonValue(exec.arguments === undefined ? null : exec.arguments)); } catch { canonical = ""; }
    const fingerprint = fingerprintOf(result);
    const now = state.clock + 1;
    state.clock = now;
    diagnostics.counted += 1;
    countedExecs.add(exec);

    const episode = state.episodes.get(key)
      || { consecutiveSameCount: 0, remindedCount: 0, lastFp: undefined, lastPos: 0, positions: [] };
    // windowSize 的语义是「允许夹在中间的**其它**被跟踪调用条数」：中间 20 条仍算同一条链。
    const gap = episode.lastPos === 0 ? Number.POSITIVE_INFINITY : now - episode.lastPos - 1;
    if (gap > config.windowSize) {
      episode.consecutiveSameCount = 1;      // 窗口外：新 episode
      episode.remindedCount = 0;
      episode.positions = [];
    } else if (fingerprint === episode.lastFp) {
      episode.consecutiveSameCount += 1;     // 参数一样、结果也一样：真重复
    } else {
      // C39：结果变了 = 有进展。两个计数**一起归零**（配额属于「同一份结果的重复」，
      // 不是属于这条签名）：结果稳定后再次重复，仍按同一阈值重新提醒。
      episode.consecutiveSameCount = 1;
      episode.remindedCount = 0;
      episode.positions = [];
    }
    episode.lastFp = fingerprint;
    episode.lastPos = now;
    episode.positions.push(now);
    if (episode.positions.length > config.windowSize) episode.positions = episode.positions.slice(-config.windowSize);
    state.episodes.set(key, episode);
    boundEpisodes(state);

    // 封顶语义：第 threshold、2×threshold、… 次各提醒一次，最多 maxRemindersPerEpisode 次。
    const due = config.windowThreshold * (episode.remindedCount + 1);
    if (episode.consecutiveSameCount < due || episode.remindedCount >= config.maxRemindersPerEpisode) return undefined;
    episode.remindedCount += 1;
    state.reminders += 1;
    const text = episode.remindedCount === 1
      ? gentleText(exec.name, canonical, episode.consecutiveSameCount, config.windowSize, config.argumentsPreviewChars)
      : detailedText(exec.name, canonical, episode.consecutiveSameCount, episode.positions, config.argumentsPreviewChars);
    return createGateUserMessage({
      source: { kind: REPEAT_GUARD_KIND, form: "notice", summary: exec.name + " × " + episode.consecutiveSameCount },
      text,
      idPrefix: "gate-repeat-guard",
      // id 必须能区分「同一条链的不同轮次」，否则第二次走到同一个 copies 会与上一轮的 id
      // 逐字节相同（会话存储/前端 key 都把它当唯一键）。链起点 + copies + 该 agent 的提醒序号。
      idSeed: key + "\u0000" + (episode.positions[0] === undefined ? now : episode.positions[0]) + "\u0000" + episode.consecutiveSameCount + "\u0000" + state.reminders,
    });
  };

  // 观察后**委派**：状态先推进（无论下游怎么处置），再把提醒折到下游决策上 ——
  // additionalContexts 两种决策变体都带，所以下游就算 block 了也照样能收到这条提示。
  const disposePost = ctx.on("tools/post-execute", async (exec, result, next) => {
    let reminder;
    try { reminder = await observe(exec, result); } catch (error) { swallow("observe", error); reminder = undefined; }
    const downstream = await next();
    if (reminder === undefined) return downstream;
    const prior = Array.isArray(downstream && downstream.additionalContexts) ? downstream.additionalContexts : [];
    return { ...downstream, additionalContexts: [reminder, ...prior] };
  });

  // C44：重置只认本轮**决策结果**的消息数组；入口为空时显式降级（不重置）并计数。
  const disposeReset = managePreStep
    ? ctx.on("agent/pre-step", async (payload, next) => {
      const decision = await next();
      try {
        const messages = decision && Array.isArray(decision.messages) ? decision.messages : undefined;
        resetRepeatGuard(payload && payload.agent, messages);
      } catch (error) { swallow("reset", error); }
      return decision;
    })
    : () => {};

  return () => {
    try { disposePost(); } catch { /* 忽略 */ }
    try { disposeReset(); } catch { /* 忽略 */ }
  };
}
