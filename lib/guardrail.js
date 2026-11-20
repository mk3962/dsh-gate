/**
 * 重复调用护栏（0.5.3 · 体检票 04 / R2 合并版）。
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
 *    这是误伤免疫器：任何「家族/模糊/语义归一」都会把「换 filter 重试」的真进展判成重复
 *    （72bec2e2 的 41 次 npm run verify 就是这种合法变体）。
 * 2) **相邻性换成窗口**：同一签名两次出现之间允许夹 ≤ windowSize 条被跟踪调用。
 *    这一条同时修掉两个独立成因：「夹一条 run_code 就重置」与「换无关命令再回来」。
 * 3) **结果指纹**：len + sha1(前/中/后各 4KB) + isError。结果变了就是进展，episode 重置。
 *    把「重复」从语法问题（同样参数）变成语义问题（同样参数 + **同样结果** = 没有新信息），
 *    于是「文件改了重读」「job 有新输出」自动不触发，而「结果一字未变」是强低效证据。
 *
 * ## 触发后是降级提示，不硬拦
 * 护栏挂在 tools/post-execute，此刻调用已经发生（钱已花、token 已进上下文）；在这里 block 只能
 * 罚下一次。误拦一次 = 任务中断，误提示一次 ≈ 150 token —— 差三个数量级，所以只 advisory。
 * 文案改三处（票 06 §3.5）：把「结果未变」写成事实句、给三个具体替代动作、删掉已被证伪的
 * 「Do not call … again」命令句。
 *
 * ## 明确不做（别当成需求）
 * 不做模糊/语义匹配；不做跨代理合并（父/子各算各的）；不做业务词 heuristics；不做持久化
 * （跨 resume 的旧账不可解释）；不 block。
 */

import { createHash } from "node:crypto";
import { createGateUserMessage } from "./messages.js";

/** 提醒消息的来源标记：客户端/其它插件靠它认出「这是我们发的」，不要改成上游的 kind。 */
export const REPEAT_GUARD_KIND = "gate-repeat-guard";

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
 * 打开 = 自己承担「停用上游行」这一步，README / CHANGELOG 写明了。
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

/** 结果正文：text 块直接取，非 text 块降级成 JSON（只在没有正文时看 value）。 */
function resultTextOf(result) {
  const blocks = result && Array.isArray(result.content) ? result.content : [];
  const parts = [];
  for (const block of blocks) {
    if (block && typeof block.text === "string") parts.push(block.text);
    else if (block !== undefined) { try { parts.push(JSON.stringify(block)); } catch { /* 忽略不可序列化块 */ } }
  }
  let text = parts.join("\u0000");
  if (text.length === 0 && result && result.value !== undefined) {
    try { text = JSON.stringify(result.value); } catch { text = ""; }
  }
  return text;
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

/**
 * 挂载护栏。
 *
 * @param {object} options
 * @param {object} options.ctx     插件 ctx（监听器随插件卸载一起撤销）
 * @param {object} options.policy  已解析策略（读 `repeatGuard`；缺省 = 关闭）
 * @param {object} [options.logger]
 * @returns {() => void} 卸载函数
 */
export function mountRepeatGuard(options) {
  const ctx = options.ctx;
  const config = normalizeRepeatGuardConfig(options.policy && options.policy.repeatGuard);
  if (config.enabled !== true) return () => {};
  const excludePatterns = config.exclude.map(wildcardToRegExp);

  const tracked = (name) => typeof name === "string" && name.length > 0
    && !excludePatterns.some((pattern) => pattern.test(name));

  /**
   * 观察一次调用，返回要给模型的提醒（没有就 undefined）。
   * 计数在 post-execute 做：denied 调用也走同一条瀑布（ToolRuntime.execute 把 deny 路由成结果），
   * 而「模型对着一个 deny 反复硬撞」正是最该被打断的循环。
   */
  const observe = async (exec, result) => {
    if (!exec || !exec.agent) return undefined;      // 直接 ctx.tools.execute() 的调用者没有模型可提醒
    if (!tracked(exec.name)) return undefined;        // 透明：不计数，也不重置别人的链
    const state = stateOf(exec.agent);
    const key = signatureOf(exec.name, exec.arguments);
    let canonical = "";
    try { canonical = JSON.stringify(sortJsonValue(exec.arguments === undefined ? null : exec.arguments)); } catch { canonical = ""; }
    const fingerprint = fingerprintOf(result);
    const now = state.clock + 1;
    state.clock = now;

    const episode = state.episodes.get(key) || { copies: 0, fired: 0, lastFp: undefined, lastPos: 0, positions: [] };
    // windowSize 的语义是「允许夹在中间的**其它**被跟踪调用条数」：中间 20 条仍算同一条链。
    // 早先直接比 now - lastPos，等于少给一条（windowSize=20 实际只容 19 条），注释与实现不一致。
    const gap = episode.lastPos === 0 ? Number.POSITIVE_INFINITY : now - episode.lastPos - 1;
    if (gap > config.windowSize) {
      episode.copies = 1;                 // 窗口外：这是一次新 episode
      episode.fired = 0;
      episode.positions = [];
    } else if (fingerprint === episode.lastFp) {
      episode.copies += 1;                // 参数一样、结果也一样：真重复
    } else {
      // 结果变了 = 有进展（文件重读、job 出新输出）：重新计数，但**不清 fired** ——
      // 提醒配额属于这条链。否则「结果每次带个时间戳/进度」的循环会每个周期白拿一条，
      // maxRemindersPerEpisode 形同虚设（0.5.3 复审 M1）。
      episode.copies = 1;
      episode.positions = [];
    }
    episode.lastFp = fingerprint;
    episode.lastPos = now;
    episode.positions.push(now);
    if (episode.positions.length > config.windowSize) episode.positions = episode.positions.slice(-config.windowSize);
    state.episodes.set(key, episode);
    boundEpisodes(state);

    // 封顶语义：第 threshold、2×threshold、… 次各提醒一次，最多 maxRemindersPerEpisode 次。
    // 「按倍数」而不是「过了阈值就提醒」—— 后者会在 3 次和 4 次连发两条，等于制造噪音。
    const due = config.windowThreshold * (episode.fired + 1);
    if (episode.copies < due || episode.fired >= config.maxRemindersPerEpisode) return undefined;
    episode.fired += 1;
    state.reminders += 1;
    const text = episode.fired === 1
      ? gentleText(exec.name, canonical, episode.copies, config.windowSize, config.argumentsPreviewChars)
      : detailedText(exec.name, canonical, episode.copies, episode.positions, config.argumentsPreviewChars);
    return createGateUserMessage({
      source: { kind: REPEAT_GUARD_KIND, form: "notice", summary: exec.name + " × " + episode.copies },
      text,
      idPrefix: "gate-repeat-guard",
      // id 必须能区分「同一条链的不同轮次」，否则第二次走到同一个 copies 会与上一轮的 id
      // 逐字节相同（会话存储/前端 key 都把它当唯一键）。链起点 + copies + 该 agent 的提醒序号：
      // 同一段历史重放时三者完全一致（前缀缓存不断），不同轮次之间又不会撞 —— 上游同职责实现
      // 用的是 randomUUID，说明 id 被当成唯一键在用。
      idSeed: key + "\u0000" + (episode.positions[0] === undefined ? now : episode.positions[0]) + "\u0000" + episode.copies + "\u0000" + state.reminders,
    });
  };

  // 观察后**委派**：状态先推进（无论下游怎么处置），再把提醒折到下游决策上 ——
  // additionalContexts 两种决策变体都带，所以下游就算 block 了也照样能收到这条提示。
  const disposePost = ctx.on("tools/post-execute", async (exec, result, next) => {
    let reminder;
    try { reminder = await observe(exec, result); } catch { reminder = undefined; }
    const downstream = await next();
    if (reminder === undefined) return downstream;
    const prior = Array.isArray(downstream && downstream.additionalContexts) ? downstream.additionalContexts : [];
    return { ...downstream, additionalContexts: [reminder, ...prior] };
  });

  // 用户插话 = 上下文换了，跨插话的重复不是循环（与上游同一条纯重置钩子）。
  const disposeReset = ctx.on("agent/pre-step", ({ agent, messages }, next) => {
    if (Array.isArray(messages) && messages.some((message) => message && message.source && message.source.kind === "user")) {
      states.delete(agent);
    }
    return next();
  });

  return () => {
    try { disposePost(); } catch { /* 忽略 */ }
    try { disposeReset(); } catch { /* 忽略 */ }
  };
}
