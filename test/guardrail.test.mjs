/**
 * 重复调用护栏（0.5.3 · 体检票 04 / R2 合并进 gate）用例。
 *
 * 锁住七条口径（改 lib/guardrail.js 前先读）：
 *  1) 默认关闭：策略里没有 repeatGuard 或 enabled 不是显式 true ⇒ 一个监听器都不挂。
 *  2) 身份是精确签名：只差属性顺序的 args 归一到同一签名；换参数 = 新签名 = 不触发。
 *  3) 结果指纹：正文变了就重置 episode（文件重读、job 出新输出）；deny 类结果用固定哨兵。
 *  4) 窗口：同一签名两次出现之间夹 ≤ windowSize 条被跟踪调用仍算同一条链；超了就重开。
 *  5) 触发是「3、6、9…」按倍数，最多 maxRemindersPerEpisode 条；reminder 折在 additionalContexts 前面，
 *     下游决策（含 block）原样保留。
 *  6) exclude 是透明语义：不计数、也不推进时钟（不打断别人的链）。
 *  7) 用户插话重置状态；技能激活转发（skills.activationRelay）只在加载成功时发一次、可一键关掉。
 *
 * 宿主来自共享 seam（test/host.mjs）；@deepseek-ai/dsh-llm 在本仓不可解析 ⇒ 消息走确定性退化 id，
 * 所以断言 id 前缀而不是宿主 id 格式。
 * 跑法：node --import ./test/stub-loader.mjs test/guardrail.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_EXCLUDE,
  REPEAT_GUARD_KIND,
  fingerprintOf,
  mountRepeatGuard,
  normalizeRepeatGuardConfig,
  signatureOf,
  wildcardToRegExp,
} from "../lib/guardrail.js";
import { createGate } from "../lib/gate.js";
import { resolvePolicy, TIER_ONDEMAND } from "../lib/policy.js";
import { makeHost } from "./host.mjs";

let passed = 0;
const ok = (label) => { passed += 1; console.log("  ok    " + label); };

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gate-guardrail-"));
const textOf = (message) => {
  const content = message && message.content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block && typeof block.text === "string" ? block.text : "")).join("");
};
const noticeOf = (decision) => {
  const list = Array.isArray(decision && decision.additionalContexts) ? decision.additionalContexts : [];
  return list.find((message) => message && message.source && message.source.kind === REPEAT_GUARD_KIND);
};
const resultOf = (text, isError) => (isError === true
  ? { isError: true, error: { message: text }, content: [{ type: "text", text }] }
  : { isError: false, value: undefined, content: [{ type: "text", text }] });
const execOf = (name, args, agent) => ({ callId: "call-" + name, rootCallId: "call-" + name, name, arguments: args, agent });

/** 挂一台护栏：策略里写 repeatGuard；返回跑一次 post-execute 的封装。 */
function makeRig(repeatGuard) {
  const host = makeHost({ names: ["pwsh", "read", "job_output", "wait_agent", "todo_write", "skill"] });
  const policy = resolvePolicy({ version: 3, repeatGuard }, { logger: host.logger, dshHome: tmp() });
  const dispose = mountRepeatGuard({ ctx: host.rootCtx, policy, logger: host.logger });
  return {
    host,
    policy,
    dispose,
    /** 跑一次 post-execute：name/args 一样、正文也一样 = 真重复。 */
    async run(name, args, text, isError) {
      const decision = await host.postExecute(execOf(name, args, host.agent), resultOf(text === undefined ? "SAME" : text, isError));
      return { decision, notice: noticeOf(decision) };
    },
  };
}

const ENABLED = { enabled: true };

// ── 1. 配置归一与默认关闭 ────────────────────────────────────────────────────
{
  const base = normalizeRepeatGuardConfig(undefined);
  assert.equal(base.enabled, false, "缺省必须关闭：替的是宿主自带那条，默认开会双提醒");
  assert.equal(base.windowSize, 20, "窗口默认 20（票 06 §2.2 实测值）");
  assert.equal(base.windowThreshold, 3, "阈值默认 3");
  assert.equal(base.maxRemindersPerEpisode, 2, "每个 episode 最多 2 条");
  assert.equal(base.argumentsPreviewChars, 500, "参数预览默认 500（与宿主 argumentsPreviewChars 同口径）");
  assert.deepEqual(base.exclude, [...DEFAULT_EXCLUDE], "默认 exclude 是那五个透明语义工具");

  assert.equal(normalizeRepeatGuardConfig({ enabled: "true" }).enabled, false, "只认显式 true，字符串不算开");
  assert.equal(normalizeRepeatGuardConfig({ enabled: 1 }).enabled, false, "数字 1 也不算开");
  const clamped = normalizeRepeatGuardConfig({ enabled: true, windowSize: 1, windowThreshold: 999, maxRemindersPerEpisode: 9, argumentsPreviewChars: 1 });
  assert.equal(clamped.windowSize, 2, "windowSize 下限 2（1 等于没有窗口）");
  assert.equal(clamped.windowThreshold, 50, "windowThreshold 上限 50");
  assert.equal(clamped.maxRemindersPerEpisode, 5, "maxRemindersPerEpisode 上限 5");
  assert.equal(clamped.argumentsPreviewChars, 40, "argumentsPreviewChars 下限 40");
  // 默认五个恒在，用户项追加（0.5.3 复审 M3：整体替换会让轮询类立刻被当循环）。
  const custom = normalizeRepeatGuardConfig({ exclude: ["wait_agent", 7, "", "gate_*"] });
  assert.deepEqual(custom.exclude, [...DEFAULT_EXCLUDE, "gate_*"], "exclude = 默认五项 + 追加项（去重、只留非空字符串）");

  // 默认关闭 = 零监听器（不是「挂上但不提醒」——挂上就会和宿主那条一起算）。
  const off = makeRig(undefined);
  assert.equal(off.host.hookCount("tools/post-execute"), 0, "默认关闭时不许挂 post-execute");
  assert.equal(off.host.hookCount("agent/pre-step"), 0, "默认关闭时不许挂 pre-step");
  const quiet = await off.run("pwsh", { command: "ls" }, "SAME");
  assert.equal(quiet.notice, undefined, "关闭时重复调用不产生提醒");
  off.dispose();
  ok("配置归一：默认关闭且零监听器；只认显式 true；越界值夹紧；exclude 只留非空字符串");
}

// ── 2. 精确签名与指纹 ────────────────────────────────────────────────────────
{
  assert.equal(signatureOf("read", { b: 1, a: [2, { d: 4, c: 3 }] }), signatureOf("read", { a: [2, { c: 3, d: 4 }], b: 1 }),
    "只差属性顺序的 args 必须归一到同一签名（深键序）");
  assert.notEqual(signatureOf("read", { path: "a" }), signatureOf("read", { path: "b" }), "换参数 = 新签名");
  assert.notEqual(signatureOf("read", { path: "a" }), signatureOf("write", { path: "a" }), "工具名进签名");
  assert.equal(signatureOf("x", undefined), signatureOf("x", null), "没有参数与 null 参数同签名");

  const same = resultOf("HELLO");
  assert.equal(fingerprintOf(same), fingerprintOf(resultOf("HELLO")), "同一正文 ⇒ 同一指纹");
  assert.notEqual(fingerprintOf(same), fingerprintOf(resultOf("HELLP")), "正文变一个字 ⇒ 指纹变");
  assert.equal(fingerprintOf(resultOf("HELLO", true)).startsWith("E:"), true, "isError 进指纹前缀");
  assert.notEqual(fingerprintOf(resultOf("HELLO", true)), fingerprintOf(resultOf("HELLO")), "错与不错必须分得开");

  // 只改尾部：采样也要看得见（长度进指纹 + 前后各 4KB）。
  const long = ("x".repeat(20000));
  assert.notEqual(fingerprintOf(resultOf(long + "A")), fingerprintOf(resultOf(long + "B")), "只改尾部也必须变");
  // deny/UNKNOWN_TOOL 走固定哨兵：结果一样不代表进展，也不该被当成「结果变了」而重置。
  assert.equal(fingerprintOf({ isError: true, error: { message: "no", info: { code: "UNKNOWN_TOOL" } }, content: [] }), "D:denied",
    "UNKNOWN_TOOL 用固定哨兵");
  assert.equal(fingerprintOf({ isError: true, error: { message: "no", info: { code: "POLICY_DENIED" } }, content: [] }), "D:denied",
    "含 DENIED 的码也用哨兵");

  assert.equal(wildcardToRegExp("gate_*").test("gate_load"), true, "通配符 * 生效");
  assert.equal(wildcardToRegExp("gate_*").test("xgate_load"), false, "通配符是锚定的");
  assert.equal(wildcardToRegExp("a.b").test("axb"), false, "非 * 的元字符按字面量");
  ok("签名与指纹：深键序归一、换参换名不同签名；正文/错误位进指纹；deny 固定哨兵；通配符锚定");
}

// ── 3. 触发节奏：3、6、…，封顶 2 条，折在 additionalContexts 前面 ─────────────
{
  const rig = makeRig(ENABLED);
  const args = { command: "git status" };
  assert.equal((await rig.run("pwsh", args)).notice, undefined, "第 1 次不提醒");
  assert.equal((await rig.run("pwsh", args)).notice, undefined, "第 2 次不提醒（阈值 3）");
  const third = await rig.run("pwsh", args);
  assert.ok(third.notice !== undefined, "第 3 次必须提醒");
  assert.equal(third.notice.source.kind, REPEAT_GUARD_KIND, "来源标记必须可识别");
  assert.equal(third.notice.role, "user", "提醒是一条 user 消息");
  assert.equal(third.notice.id.startsWith("gate-repeat-guard-"), true, "退化 id 用固定前缀（" + third.notice.id + "）");
  assert.equal(third.notice.id.length, "gate-repeat-guard-".length + 12, "退化 id = 前缀 + 12 位 sha1");
  const text = textOf(third.notice);
  for (const needle of ["output_unchanged: yes", "git status", "job_output({ job_id, wait: true })", "path / offset / filter / limit"]) {
    assert.ok(text.includes(needle), "文案缺少「" + needle + "」：" + text);
  }
  assert.equal(/Do not call/.test(text), false, "已被证伪的命令句必须删掉");
  assert.equal(third.decision.kind, "accept", "护栏只降级提示，绝不 block");

  assert.equal((await rig.run("pwsh", args)).notice, undefined, "第 4 次不提醒");
  assert.equal((await rig.run("pwsh", args)).notice, undefined, "第 5 次不提醒（下一次是 6）");
  const sixth = await rig.run("pwsh", args);
  assert.ok(sixth.notice !== undefined, "第 6 次必须再提醒一条");
  assert.ok(textOf(sixth.notice).includes("tracked call #"), "第二条带出现位置：" + textOf(sixth.notice));
  assert.notEqual(sixth.notice.id, third.notice.id, "两条提醒的 id 必须不同（否则会话存储/前端 key 会撞）");
  for (let index = 0; index < 6; index += 1) {
    assert.equal((await rig.run("pwsh", args)).notice, undefined, "封顶 2 条后必须静默（第 " + (7 + index) + " 次）");
  }
  rig.dispose();
  assert.equal(rig.host.hookCount("tools/post-execute"), 0, "卸载后监听器必须撤销");
  ok("触发节奏：第 3 / 6 次各提醒一条，封顶后静默；消息形状与文案锁住；accept 不 block；卸载可撤销");
}

// ── 4. 结果变了 = 有进展：episode 重置 ───────────────────────────────────────
{
  const rig = makeRig(ENABLED);
  const args = { path: "big.log" };
  await rig.run("read", args, "v1");
  await rig.run("read", args, "v2");
  const third = await rig.run("read", args, "v3");
  assert.equal(third.notice, undefined, "结果每次都变（文件在长）⇒ 不是重复，不提醒");
  // 结果稳定下来之后仍要能抓到循环：三条相同正文才提醒。
  await rig.run("read", args, "v3");
  assert.ok((await rig.run("read", args, "v3")).notice !== undefined, "结果停止变化后第 3 条相同结果必须提醒");
  rig.dispose();
  ok("结果指纹：结果变即重置 episode；结果稳定后重新计数");
}

// ── 5. 窗口：夹几条别的调用仍算同一条链；窗口外重开 ──────────────────────────
{
  // windowSize 的语义 = 允许夹在中间的**其它**被跟踪调用条数。
  const tight = makeRig({ enabled: true, windowSize: 2 });
  const args = { command: "ls" };
  await tight.run("pwsh", args);                 // pos1
  await tight.run("read", { path: "a" });        // 夹 1
  await tight.run("read", { path: "b" });        // 夹 2
  assert.equal((await tight.run("pwsh", args)).notice, undefined, "夹 2 条仍在窗口内（copies=2，未到阈值）");
  assert.ok((await tight.run("pwsh", args)).notice !== undefined, "窗口内第 3 次照常提醒");
  tight.dispose();

  const outside = makeRig({ enabled: true, windowSize: 2 });
  await outside.run("pwsh", args);
  await outside.run("read", { path: "a" });
  await outside.run("read", { path: "b" });
  await outside.run("read", { path: "c" });      // 夹 3 条 ⇒ 超窗
  await outside.run("pwsh", args);               // copies 重新从 1 起
  assert.equal((await outside.run("pwsh", args)).notice, undefined, "超窗后重新计数，第 2 次不该提醒");
  assert.ok((await outside.run("pwsh", args)).notice !== undefined, "新 episode 满 3 次仍要提醒");
  outside.dispose();

  const wide = makeRig({ enabled: true, windowSize: 20 });
  await wide.run("pwsh", args);
  await wide.run("read", { path: "a" });
  const second = await wide.run("pwsh", args);   // gap = 2 ≤ 20 ⇒ copies=2
  assert.equal(second.notice, undefined);
  assert.ok((await wide.run("pwsh", args)).notice !== undefined, "窗口内夹别的调用不该打断链（这正是宿主判据漏掉的那类）");
  wide.dispose();
  ok("窗口：windowSize 内夹别的调用算同一条链；超窗重开 episode");
}

// ── 6. exclude 透明：不计数、也不推进时钟 ────────────────────────────────────
{
  const rig = makeRig(ENABLED);
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await rig.run("wait_agent", { timeout_ms: 10000 }, "")).notice, undefined, "wait_agent 空结果反复总是正常用法");
    assert.equal((await rig.run("todo_write", { todos: [] }, "ok")).notice, undefined, "todo_write 每步重写是约定动作");
  }
  // 透明 = 不推进时钟：被排除的调用夹在中间不该把 gap 撑过窗口。
  const tight = makeRig({ enabled: true, windowSize: 2 });
  await tight.run("pwsh", { command: "ls" });
  await tight.run("wait_agent", { timeout_ms: 1 }, "");
  await tight.run("todo_write", { todos: [] }, "ok");
  await tight.run("pwsh", { command: "ls" });     // 若被排除的调用进了时钟，这里 gap 会是 3 ⇒ 重开
  assert.ok((await tight.run("pwsh", { command: "ls" })).notice !== undefined, "被排除的调用不得推进时钟／打断别人的链");
  tight.dispose();
  rig.dispose();
  ok("exclude：透明语义（不计数、不推进时钟）；自定义 exclude 支持通配符");
}

// ── 7. 用户插话重置 + 无 agent 的调用 ───────────────────────────────────────
{
  const rig = makeRig(ENABLED);
  const args = { command: "ps" };
  await rig.run("pwsh", args);
  await rig.run("pwsh", args);
  await rig.host.preStep({ kind: "continue" }, rig.host.agent, [{ role: "user", source: { kind: "user" }, content: [] }]);
  await rig.run("pwsh", args);   // 状态已清 ⇒ copies=1
  assert.equal((await rig.run("pwsh", args)).notice, undefined, "用户插话后重新计数，第 2 次不该提醒");
  assert.ok((await rig.run("pwsh", args)).notice !== undefined, "插话后的新 episode 满 3 次仍要提醒");

  // 直接 ctx.tools.execute() 的调用者没有 agent：无从提醒，也不能抛。
  const decision = await rig.host.postExecute({ name: "pwsh", arguments: { command: "ps" } }, resultOf("SAME"));
  assert.equal(decision.kind, "accept", "没有 agent 的调用必须安全降级");
  assert.equal(noticeOf(decision), undefined, "没有 agent 就不发提醒");
  rig.dispose();
  ok("用户插话重置状态；没有 agent 的调用安全降级");
}

// ── 8. 技能激活转发（B2）：加载成功发一次、可一键关掉、失败不发 ───────────────
{
  const defs = { alpha: { name: "alpha", provider: "pkg-a", description: "Alpha。", content: "ALPHA BODY" } };
  const makeRelay = (skills) => {
    const host = makeHost({ names: ["skill"] });
    host.rootCtx.get = (name) => {
      if (name === "skills") {
        return {
          async list() { return [{ ...defs.alpha, content: undefined }]; },
          async get(key) { return defs[key] ? { ...defs[key] } : undefined; },
          async snapshot() { return { skills: await this.list(), complete: true }; },
        };
      }
      if (name === "workingDirectory") return { ensure: async () => tmp() };
      return undefined;
    };
    const policy = resolvePolicy({ version: 3, defaults: { capability: 2, section: 1, skillpack: TIER_ONDEMAND }, skills }, { logger: host.logger, dshHome: tmp() });
    const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
    const relays = () => host.emitted.filter((row) => row.event === "tools/result" && row.args[0] && row.args[0].name === "skill");
    return { host, gate, relays };
  };

  const on = makeRelay({ takeover: true });
  // 两个按真实形状写的监听者（0.5.3 复审 B1）：
  //  1) 宿主 dsh-agent-instructions 的监听者会读 exec.signal.aborted —— 伪 exec 缺 signal 就 TypeError；
  //  2) 第三方激活门排在它后面：前者一抛，后面就收不到（真实 cordis 的 emit 没有 try/catch）。
  const seen = [];
  on.host.rootCtx.on("tools/result", (exec) => {
    if (exec === undefined || exec.agent === undefined) return;
    if (exec.signal.aborted) throw new Error("unexpected abort");
    seen.push("agent-instructions");
  });
  on.host.rootCtx.on("tools/result", (exec, result) => {
    if (exec !== undefined && exec.name === "skill" && result && result.isError === false) seen.push("activation-gate");
  });
  await on.gate.attach(on.host.agent);
  const loaded = await on.gate.loadSkill(on.host.agent, "alpha");
  assert.equal(loaded.ok, true, "alpha 应该能加载");
  assert.equal(on.relays().length, 1, "加载成功必须补发一次 tools/result（技能激活门只认这个）");
  const [row] = on.relays();
  assert.equal(row.args[0].callId, "gate-load-skill-alpha", "伪事件的 callId 必须可识别");
  assert.equal(row.args[0].rootCallId, "gate-load-skill-alpha", "rootCallId 与 callId 同源");
  assert.deepEqual(row.args[0].arguments, { name: "alpha" }, "arguments 照宿主 skill 工具的形状");
  assert.equal(row.args[1].isError, false, "转发的是成功结果");
  assert.ok(row.args[0].callId !== undefined && row.args[0].rootCallId !== undefined, "伪 exec 必须带 callId / rootCallId");
  assert.ok(row.args[0].signal !== undefined, "伪 exec 必须带 signal（监听者会读 .aborted）");
  assert.deepEqual(seen, ["agent-instructions", "activation-gate"], "按真实形状的监听者必须都收到，且顺序不变");
  assert.equal(on.host.emittedErrors.length, 0, "任何监听者都不该因为伪 exec 形状不全而抛错");
  assert.equal(await on.gate.loadSkill(on.host.agent, "nope").then((out) => out.ok), false, "未知技能加载失败");
  assert.equal(on.relays().length, 1, "加载失败不发信号（假激活比不激活更糟）");

  const off = makeRelay({ takeover: true, activationRelay: false });
  await off.gate.attach(off.host.agent);
  assert.equal((await off.gate.loadSkill(off.host.agent, "alpha")).ok, true);
  assert.equal(off.relays().length, 0, "activationRelay === false 时一条都不发");
  ok("技能激活转发：加载成功发一次（callId 可识别）、失败不发、activationRelay=false 可关");
}


// ── 9. 结果抖动不白拿提醒（复审 M1）：配额属于这条链，不是每次结果变化都重开 ─────
{
  const rig = makeRig({ enabled: true, windowThreshold: 3, maxRemindersPerEpisode: 2 });
  const args = { command: "npm run verify" };
  await rig.run("pwsh", args, "out");
  await rig.run("pwsh", args, "out");
  const first = (await rig.run("pwsh", args, "out")).notice;
  assert.ok(first !== undefined, "第 3 条相同结果必须提醒（对照组）");

  // 结果每两次抖一次（带时间戳/进度那种循环）：copies 重置，但 fired 不清。
  for (const [text, round] of [["out-1", 2], ["out-2", 3]]) {
    for (let index = 0; index < round; index += 1) {
      assert.equal((await rig.run("pwsh", args, text)).notice, undefined, "抖动阶段第 " + (index + 1) + " 次不该提醒");
    }
  }
  // 到这里 out-2 已连续 3 次（copies=3），但配额已用 1 条 ⇒ 下一次 due 是 6。
  assert.equal((await rig.run("pwsh", args, "out-2")).notice, undefined, "copies=4 < due 6，静默");
  assert.equal((await rig.run("pwsh", args, "out-2")).notice, undefined, "copies=5 < due 6，静默");
  const second = (await rig.run("pwsh", args, "out-2")).notice;
  assert.ok(second !== undefined, "copies=6 才发第二条（不是每轮抖动都发一条）");
  assert.notEqual(second.id, first.id, "第二条提醒的 id 必须与第一条不同");
  for (let index = 0; index < 6; index += 1) {
    assert.equal((await rig.run("pwsh", args, "out-2")).notice, undefined, "两条封顶后必须静默（第 " + (7 + index) + " 次）");
  }
  rig.dispose();
  ok("结果抖动：重置 copies 但不重置配额，仍只发 2 条（M1）");
}

// ── 10. 策略持久化：repeatGuard 走保存 / 规范化 / 解析全链不丢（复审 M4）───────
{
  const { mergePolicyFile, resolvePolicy, emptyPolicyTemplate } = await import("../lib/policy.js");
  const { normalizeV3Policy } = await import("../lib/migrate.js");
  const template = emptyPolicyTemplate();
  assert.deepEqual(template.repeatGuard.enabled, false, "空模板里护栏默认关");

  const merged = mergePolicyFile(template, { repeatGuard: { enabled: true, windowThreshold: 4 } });
  assert.equal(merged.repeatGuard.enabled, true, "保存 enabled 必须落地（M4：表外键会被静默丢掉）");
  assert.equal(merged.repeatGuard.windowThreshold, 4, "提交的阈值必须落地");
  assert.equal(merged.repeatGuard.windowSize, 20, "没提交的字段保留默认");
  assert.deepEqual(merged.repeatGuard.exclude, [...DEFAULT_EXCLUDE], "exclude 默认五项仍在");
  // 再保存一次（UI 只提交 enabled）：其它字段不能被打回默认以外的值，也不能消失。
  const again = mergePolicyFile(merged, { enabled: true });
  assert.equal(again.repeatGuard.enabled, true, "非 replace 的整份保存也必须保住 repeatGuard");
  assert.equal(again.repeatGuard.windowThreshold, 4, "阈值在第二次保存后仍是 4");

  const normalized = normalizeV3Policy({ repeatGuard: { enabled: true, windowThreshold: 5 } }).policy;
  assert.equal(normalized.repeatGuard.enabled, true, "normalizeV3Policy 必须认 repeatGuard");
  assert.equal(normalized.repeatGuard.windowThreshold, 5, "规范化不改用户值");
  assert.deepEqual(normalized.repeatGuard.exclude, [...DEFAULT_EXCLUDE], "规范化补上默认 exclude");

  const host = makeHost({ names: ["pwsh"] });
  const resolved = resolvePolicy({ version: 3, repeatGuard: { enabled: true, windowThreshold: 2 } }, { logger: host.logger, dshHome: tmp() });
  assert.equal(resolved.repeatGuard.enabled, true, "resolvePolicy 后 repeatGuard 仍在");
  assert.equal(resolved.repeatGuard.windowThreshold, 2, "resolvePolicy 保留用户阈值");
  // 走 mount 一次，确认解析出来的策略真能挂上（不是只存在于对象里）。
  const dispose = mountRepeatGuard({ ctx: host.rootCtx, policy: resolved, logger: host.logger });
  assert.equal(host.hookCount("tools/post-execute"), 1, "解析出的策略可以直接挂护栏");
  dispose();
  ok("持久化：mergePolicyFile / normalizeV3Policy / resolvePolicy 三处都保住 repeatGuard 并能挂载（M4）");
}

console.log("\n全部通过 (" + passed + ")");
