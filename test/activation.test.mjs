/**
 * 技能激活族（0.5.4 · 上游票 B2 执行面）用例。
 *
 * 锁住四条口径（改 lib/activation.js 前先读）：
 *  1) 族切分问 naming.js 的单一事实源 toolPrefixesForSkill：univer-sheet → univer、office-docx → office、
 *     **browser-skill → bsk**（显式别名表：插件的工具全叫 bsk_*，首段 browser 一个都不存在）；
 *     切不出标识符形状（空串、数字开头、中文）时返回空串 —— 宁可不放，也不误放。
 *  2) 族内判据只有「名字就是族」与「族_ 前缀」两条：univerx 不算 univer 族。
 *  3) pickPromotable 放「族内 + 在案」的名字，不再要求 ==我们认出它的 when==（0.5.6）：
 *     0.5.4 用 conditional 集合做闸，真机只认得出 univer、认不出 office（写法相同），
 *     结果 office 族永远放不出来；族内让宿主自己判能不能执行。
 *  4) explicit off / 已常驻 绝不放；结果排序，同一输入两次结果一致。
 *
 * 跑法：node --import ./test/stub-loader.mjs test/activation.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { register } from "node:module";
import os from "node:os";
import path from "node:path";
import { familyToolNames, pickPromotable, skillFamiliesOf, skillFamilyOf } from "../lib/activation.js";
import { createGate } from "../lib/gate.js";
import { resolvePolicy, TIER_ONDEMAND, TIER_RESIDENT } from "../lib/policy.js";
import { makeHost } from "./host.mjs";

register("./stub-resolver.mjs", import.meta.url);
const { registerGateTools } = await import("../lib/proxy.js");

let passed = 0;
const ok = (label) => { passed += 1; console.log("  ok    " + label); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gate-activation-"));

// ---- 1) 族切分 ----
assert.equal(skillFamilyOf("univer"), "univer");
assert.equal(skillFamilyOf("univer-sheet"), "univer");
assert.equal(skillFamilyOf("office-docx"), "office");
assert.equal(skillFamilyOf("browser-skill"), "bsk",
  "显式别名（0.7.2 票 01）：插件工具前缀是 bsk_*，首段 browser 一个工具都不存在");
assert.deepEqual(skillFamiliesOf("browser-skill"), ["bsk"], "族集合 = 显式前缀表");
assert.deepEqual(skillFamiliesOf("univer-sheet"), ["univer"], "未命中显式表 ⇒ 回退首段");
assert.deepEqual(skillFamiliesOf(""), [], "空名字 ⇒ 空集合");
assert.equal(skillFamilyOf("skill:univer"), "univer", "允许带 skill: 前缀（防御性：调用方已经剥过）");
assert.equal(skillFamilyOf(""), "", "空名字没有族");
assert.equal(skillFamilyOf("-leading"), "", "第一段为空 ⇒ 没有族");
assert.equal(skillFamilyOf("9lives"), "", "族必须是标识符（字母开头）");
assert.equal(skillFamilyOf("中文技能"), "", "非标识符字符 ⇒ 没有族");
assert.equal(skillFamilyOf(undefined), "", "非字符串 ⇒ 没有族");
ok("族切分：第一段 + 标识符校验");

// ---- 2) 族内判据 ----
const names = ["univer_status", "univer_api", "univerx_probe", "univer", "office_render", "univer-sheet"];
assert.deepEqual(familyToolNames("univer", names), ["univer", "univer_api", "univer_status"],
  "只认 univer 与 univer_ 前缀；univerx_probe / 别的族不算");
assert.deepEqual(familyToolNames("univer-sheet", names), ["univer", "univer_api", "univer_status"],
  "带后缀的技能名用同一族");
assert.deepEqual(familyToolNames("office", names), ["office_render"]);
assert.deepEqual(familyToolNames("", names), [], "没有族 ⇒ 一个都不匹配");
ok("族内判据：精确名字 or 族_ 前缀");

// 0.7.2：显式别名族的成员判据（browser-skill 放出的是 bsk_*，不是 browser_*）
const bskNames = ["bsk_session", "bsk_page", "bsk", "bskx_probe", "browser_open", "session"];
assert.deepEqual(familyToolNames("browser-skill", bskNames), ["bsk", "bsk_page", "bsk_session"],
  "browser-skill 的族是 bsk：命中 bsk/bsk_ 前缀，不误放 bskx_probe / browser_open");
assert.deepEqual(familyToolNames("browser", bskNames), ["browser_open"],
  "技能名 browser（没有显式别名）仍按首段走，别把别名算进来");
ok("显式别名族：browser-skill → bsk 的成员判据");

// ---- 3) 族内全放（0.5.6）：不再要求「我们认出了它的 when」 ----
const conditional = new Set(["univer_status", "univer_api", "office_render"]);
let picked = pickPromotable({ skillName: "univer", names });
assert.deepEqual(picked, ["univer", "univer_api", "univer_status"],
  "族内全放（名字=族 或 族_ 前缀）；univerx_probe 不是本族；结果排序");
picked = pickPromotable({ skillName: "univer", names, conditional: new Set() });
assert.deepEqual(picked, ["univer", "univer_api", "univer_status"],
  "认不出 conditional（真机 office 就是这样）也必须放：族内让宿主自己判能不能执行");
picked = pickPromotable({ skillName: "office", names });
assert.deepEqual(picked, ["office_render"], "换族只出本族");
ok("族内全放：不靠 conditional 认门，plain 工具也放出");

// ---- 4) off / 已常驻 不放 ----
picked = pickPromotable({
  skillName: "univer",
  names,
  off: new Set(["univer_status"]),
});
assert.deepEqual(picked, ["univer", "univer_api"], "explicit off 绝不放（关掉必须真的关）");
const firstPick = pickPromotable({
  skillName: "univer",
  names,
  resident: new Set(["univer_api"]),
});
assert.deepEqual(firstPick, ["univer", "univer_status"], "已经常驻的不必再放（幂等）");
const again = pickPromotable({
  skillName: "univer",
  names,
  resident: new Set(["univer_api", ...firstPick]),
});
assert.deepEqual(again, [], "第二次加载同一技能：一个都不放");
ok("off / 常驻：都不放，且幂等");

// ---- 5) 端到端：加载技能 ⇒ 该族 conditional 工具进常驻面（并从 deny 消失） ----
{
  const defs = { univer: { name: "univer", provider: "pkg-u", description: "Univer。", content: "UNIVER BODY" } };
  const makeRig = (skills) => {
    const host = makeHost({
      names: ["pwsh", "skill", "univer_status", "univer_api", "office_render", "web_search"],
      conditional: ["univer_status", "univer_api", "office_render"],
    });
    host.rootCtx.get = (name) => {
      if (name === "skills") {
        return {
          async list() { return [{ ...defs.univer, content: undefined }]; },
          async get(key) { return defs[key] ? { ...defs[key] } : undefined; },
          async snapshot() { return { skills: await this.list(), complete: true }; },
        };
      }
      if (name === "workingDirectory") return { ensure: async () => tmp() };
      return undefined;
    };
    const policy = resolvePolicy(
      { version: 3, defaults: { capability: TIER_ONDEMAND, section: TIER_RESIDENT, skillpack: TIER_ONDEMAND }, skills },
      { logger: host.logger, dshHome: tmp() },
    );
    const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
    return { host, gate };
  };

  const rig = makeRig({ takeover: true });
  await rig.gate.attach(rig.host.agent);
  const before = rig.gate.snapshot(rig.host.agent).tiers;
  assert.equal(before.univer_status, TIER_ONDEMAND, "技能没加载前：conditional 工具在第二层");

  const loaded = await rig.gate.loadSkill(rig.host.agent, "univer");
  assert.equal(loaded.ok, true, "univer 技能应能加载");
  assert.deepEqual(loaded.promoted, ["univer_api", "univer_status"],
    "放本族全部工具（这个宿主的工具表里没有名为 univer 的工具；office_render 不属于本族）");
  assert.deepEqual(loaded.activation.promoted, loaded.promoted,
    "0.5.7：回执本身要带 promoted（否则 proxy 只透出 activation，模型永远看不到这次放出了什么）");

  const after = rig.gate.snapshot(rig.host.agent).tiers;
  assert.equal(after.univer_status, TIER_RESIDENT, "放出的工具按常驻处理（下一步被声明、进 admission）");
  assert.equal(after.univer_api, TIER_RESIDENT);
  assert.equal(after.office_render, TIER_ONDEMAND, "别的族不受影响");
  const denies = rig.host.restrictionsFor(rig.host.agent).map((set) => [...set]);
  assert.ok(denies.every((set) => !set.includes("univer_status")), "放出的名字必须从 deny 里消失");
  assert.ok(denies.some((set) => set.includes("office_render")), "没放出的族仍留在 deny 里");

  const again = await rig.gate.loadSkill(rig.host.agent, "univer");
  assert.deepEqual(again.promoted, [], "第二次加载同一个技能：一个都不再放（幂等）");
  ok("端到端：加载技能把该族工具放进常驻面并从 deny 移除");

  // 真机 office 的样子：注册者写的 when 我们认不出来（conditionalNamesOf 为空），族内仍须放行。
  {
    const blind = makeHost({ names: ["pwsh", "skill", "office_render", "web_search"], conditional: [] });
    blind.rootCtx.get = (name) => {
      if (name === "skills") {
        return {
          async list() { return [{ name: "office", provider: "pkg-o", description: "Office。", content: undefined }]; },
          async get(key) { return key === "office" ? { name: "office", provider: "pkg-o", description: "Office。", content: "OFFICE BODY" } : undefined; },
          async snapshot() { return { skills: await this.list(), complete: true }; },
        };
      }
      if (name === "workingDirectory") return { ensure: async () => tmp() };
      return undefined;
    };
    const blindPolicy = resolvePolicy(
      { version: 3, defaults: { capability: TIER_ONDEMAND, section: TIER_RESIDENT, skillpack: TIER_ONDEMAND }, skills: { takeover: true } },
      { logger: blind.logger, dshHome: tmp() },
    );
    const blindGate = createGate({ ctx: blind.rootCtx, logger: blind.logger, policy: blindPolicy });
    await blindGate.attach(blind.agent);
    const blindLoaded = await blindGate.loadSkill(blind.agent, "office");
    assert.equal(blindLoaded.ok, true);
    assert.deepEqual(blindLoaded.promoted, ["office_render"], "认不出 when 也必须放（真机 office 的坑）");
    assert.deepEqual(blindLoaded.activation.promoted, ["office_render"], "回执同源");
    assert.equal(blindGate.snapshot(blind.agent).tiers.office_render, TIER_RESIDENT);
    ok("端到端：conditionalNamesOf 认不出 when 时，族内工具仍然放行（0.5.6 回归点）");
  }

  // 关掉开关 ⇒ 完整退回 0.5.3 行为（只发信号，不动工具面）
  const offRig = makeRig({ takeover: true, activationPromote: false });
  await offRig.gate.attach(offRig.host.agent);
  const offLoaded = await offRig.gate.loadSkill(offRig.host.agent, "univer");
  assert.equal(offLoaded.ok, true);
  assert.deepEqual(offLoaded.promoted, [], "activationPromote=false 时不放");
  assert.equal(offRig.gate.snapshot(offRig.host.agent).tiers.univer_status, TIER_ONDEMAND,
    "关掉后工具面保持 0.5.3 行为");
  ok("activationPromote=false：可一键退回 0.5.3（工具面不动）");
}

// ---- 6) 激活信号逐个派发：前面监听者抛错，不能吃掉后面那家的信号 ----
{
  const defs = { univer: { name: "univer", provider: "pkg-u", description: "Univer。", content: "UNIVER BODY" } };
  const host = makeHost({
    names: ["pwsh", "skill", "univer_status", "web_search"],
    conditional: ["univer_status"],
    isolatedEvents: true,
  });
  host.rootCtx.get = (name) => {
    if (name === "skills") {
      return {
        async list() { return [{ ...defs.univer, content: undefined }]; },
        async get(key) { return defs[key] ? { ...defs[key] } : undefined; },
        async snapshot() { return { skills: await this.list(), complete: true }; },
      };
    }
    if (name === "workingDirectory") return { ensure: async () => tmp() };
    return undefined;
  };
  // 第一位监听者模拟 dsh-agent-instructions 那类「读 exec.signal / 缺字段就抛」的监听者。
  const seen = [];
  host.rootCtx.on("tools/result", () => { throw new TypeError("boom"); });
  // 第二位才是真正要收信号的（univer / office 的技能激活门）。
  host.rootCtx.on("tools/result", (exec) => { seen.push(exec); });

  const policy = resolvePolicy(
    { version: 3, defaults: { capability: TIER_ONDEMAND, section: TIER_RESIDENT, skillpack: TIER_ONDEMAND }, skills: { takeover: true } },
    { logger: host.logger, dshHome: tmp() },
  );
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  await gate.attach(host.agent);
  const loaded = await gate.loadSkill(host.agent, "univer");
  assert.equal(loaded.ok, true);
  const relay = loaded.activation.relay;
  assert.equal(relay.mode, "isolated", "有 events.dispatch 时走逐个派发");
  // 0.7.2 A1 兼发：两条通道各自记账，顶层是汇总。
  assert.equal(relay.emit.listeners, 2, "tools/result 的两个监听者都要被枚举到");
  assert.equal(relay.emit.delivered, 1, "抛错的那位不算送达，后面那位仍然送达");
  assert.deepEqual(relay.emit.failed, ["boom"], "通道内失败原因原样保留");
  assert.equal(relay.waterfall.listeners, 0, "本用例没挂 post-execute 监听者");
  assert.equal(relay.listeners, 2, "顶层汇总 = 两通道相加（兼容既有调用方）");
  assert.equal(relay.delivered, 1);
  assert.deepEqual(relay.failed, ["result: boom"], "顶层失败带通道前缀，排障一眼分清双通道");
  assert.equal(seen.length, 1, "后面的监听者必须真的收到 exec");
  assert.equal(seen[0].name, "skill");
  assert.deepEqual(seen[0].arguments, { name: "univer" });
  assert.ok(seen[0].signal && typeof seen[0].signal.aborted === "boolean", "exec.signal 不能省（0.5.3 复审 B1）");
  ok("激活信号逐个派发：前排抛错不吃后排，失败原因可回读");
}

// ---- 7) 端到端（0.7.2 票 01 根治）：懒加载插件只监听 tools/post-execute ----
// 真机形状：@wxg-prc-cpg/browser-skill-dsh-plugin 的 armLazyTools 以 prepend 挂在 waterfall 上，
// 先 await next()，再判 exec.name==='skill' && 技能名 === 'browser-skill'，然后注册 bsk_*。
// 0.7.1 只发 tools/result ⇒ 这条监听者永远收不到信号 ⇒ 「加载成功、promoted 空、bsk_* 不可见」。
// 同一宿主里再挂一条只认 tools/result 的（univer/office 语义），锁住「兼发」而不是「替换」。
{
  const defs = { "browser-skill": { name: "browser-skill", provider: "pkg-bsk", description: "浏览器。", content: "BSK BODY" } };
  const host = makeHost({
    names: ["pwsh", "skill", "web_search", "bsk_session"],
    // bsk_session 已在注册表里（插件 ensureSuite 的效果），但带 when = 未激活时不可执行。
    conditional: ["bsk_session"],
    isolatedEvents: true,
  });
  host.rootCtx.get = (name) => {
    if (name === "skills") {
      return {
        async list() { return [{ ...defs["browser-skill"], content: undefined }]; },
        async get(key) { return defs[key] ? { ...defs[key] } : undefined; },
        async snapshot() { return { skills: await this.list(), complete: true }; },
      };
    }
    if (name === "workingDirectory") return { ensure: async () => tmp() };
    return undefined;
  };

  // ① 懒加载插件：做在它之后（prepend 的语义是「排在更靠外」）——
  //    真机 prepend 让它成为洋葱最外层：先委派 next()，回来再补注册自己的工具。
  let bskRegistered = 0;
  host.rootCtx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    if (exec.name !== "skill") return decision;
    if (!exec.arguments || exec.arguments.name !== "browser-skill") return decision;
    // 真实的 ensureSuite() 就发生在这一刻：激活之后才把工具注册面点亮。
    bskRegistered += 1;
    if (!host.hasTool("bsk_page")) host.rootCtx.tools.register({ name: "bsk_page", description: "翻页。", execute: async () => ({ content: [] }) });
    return decision;
  }, { prepend: true });

  // ② 存量插件（univer / office / mnemon / deck 语义）：只认 tools/result，必须照收。
  const resultSeen = [];
  host.rootCtx.on("tools/result", (exec) => resultSeen.push(exec && exec.name));

  const policy = resolvePolicy(
    { version: 3, defaults: { capability: TIER_ONDEMAND, section: TIER_RESIDENT, skillpack: TIER_ONDEMAND }, skills: { takeover: true } },
    { logger: host.logger, dshHome: tmp() },
  );
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  await gate.attach(host.agent);

  const loaded = await gate.loadSkill(host.agent, "browser-skill");
  assert.equal(loaded.ok, true, "browser-skill 应能加载");
  assert.deepEqual(loaded.promoted, ["bsk_page", "bsk_session"],
    "显式别名 bsk 族：本次放出 bsk_ 前缀的工具（0.7.1 这里是空数组，因为族被切成 browser）");
  assert.deepEqual(loaded.activation.promoted, loaded.promoted, "回执同源");
  assert.ok(loaded.activation.promoted.length > 0, "activation.promoted 必须非空（真机排障只看这一条）");

  const relay = loaded.activation.relay;
  assert.equal(relay.waterfall.listeners, 1, "post-execute 通道被枚举到 1 位监听者");
  assert.equal(relay.waterfall.delivered, 1, "懒加载插件的监听者收到并跑完了");
  assert.equal(relay.emit.listeners, 1, "tools/result 通道也发了一次（兼发，不是替换）");
  assert.equal(relay.emit.delivered, 1);
  assert.deepEqual(relay.emit.failed, []);
  assert.deepEqual(relay.waterfall.failed, []);
  assert.equal(relay.listeners, 2, "顶层汇总 = 两通道相加");
  assert.match(relay.mode, /^(isolated|emit)$/);
  assert.equal(bskRegistered, 1, "懒加载插件在 await next() 之后真的走到注册那一步");
  assert.deepEqual(resultSeen, ["skill"], "tools/result 监听者（univer 语义）仍正常收到");

  // bsk_* 可见 / 可调：工具面真的打开了。
  assert.equal(host.visibleOf(host.agent).has("bsk_session"), true, "bsk_session 必须进可见面");
  const tiers = gate.snapshot(host.agent).tiers;
  assert.equal(tiers.bsk_session, TIER_RESIDENT, "激活后按常驻处理");
  assert.equal(tiers.bsk_page, TIER_RESIDENT, "激活期间新注册的 bsk_page 也进常驻面（knownNames 指纹进键）");
  assert.deepEqual(gate.canInvoke(host.agent, "bsk_session"), { ok: true }, "可调（canInvoke 认得它）");
  const denied = host.restrictionsFor(host.agent).map((set) => [...set]);
  assert.ok(denied.every((set) => !set.includes("bsk_session")), "放出的名字必须从 deny 消失");
  ok("端到端：懒加载插件（tools/post-execute）激活 → promoted 非空、bsk_* 可见可调，且 tools/result 仍收到");
}

// ---- 8) 缓存指纹（0.7.2）：同规模换成员必须重投影 ----
{
  const host = makeHost({ names: ["pwsh", "skill", "alpha_one", "beta_two", "web_search"], conditional: [] });
  const policy = resolvePolicy(
    { version: 3, defaults: { capability: TIER_ONDEMAND, section: TIER_RESIDENT, skillpack: TIER_ONDEMAND }, skills: { takeover: true } },
    { logger: host.logger, dshHome: tmp() },
  );
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  const agent = host.addAgent({ id: "fingerprint" });
  await gate.attach(agent);
  const first = gate.snapshot(agent);
  assert.ok("alpha_one" in first.tiers, "初始可见 alpha_one");
  assert.equal("beta_two" in first.tiers, true);

  // 同规模换成员：插件卸载 alpha_one、注册 gamma_three（knownNames 的大小不变）。
  host.registry.delete("alpha_one");
  host.rootCtx.tools.register({ name: "gamma_three", description: "新工具。", execute: async () => ({ content: [] }) });
  gate.reapply(agent);
  const second = gate.snapshot(agent);
  assert.equal("alpha_one" in second.tiers, false, "被卸载的工具必须从计划里消失（规模没变，靠成员指纹发现）");
  assert.equal("gamma_three" in second.tiers, true, "新注册的工具必须进计划");
  ok("缓存指纹：knownNames 同规模换成员时重投影（0.7.1 会命中旧计划）");
}

// ---- 9) 空放行诊断（0.7.2）：族前缀与注册面完全不匹配时要给出可执行提示 ----
{
  const host = makeHost({ names: ["pwsh", "skill", "alpha_one", "web_search"], conditional: [] });
  host.rootCtx.get = (name) => {
    if (name === "skills") {
      return {
        async list() { return [{ name: "gamma-skill", provider: "pkg-g", description: "G。", content: undefined }]; },
        async get(key) { return key === "gamma-skill" ? { name: "gamma-skill", provider: "pkg-g", description: "G。", content: "GAMMA BODY" } : undefined; },
        async snapshot() { return { skills: await this.list(), complete: true }; },
      };
    }
    if (name === "workingDirectory") return { ensure: async () => tmp() };
    return undefined;
  };
  const policy = resolvePolicy(
    { version: 3, defaults: { capability: TIER_ONDEMAND, section: TIER_RESIDENT, skillpack: TIER_ONDEMAND }, skills: { takeover: true } },
    { logger: host.logger, dshHome: tmp() },
  );
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  await gate.attach(host.agent);
  const loaded = await gate.loadSkill(host.agent, "gamma-skill");
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.promoted, [], "gamma 族（= 首段）在注册面一个工具都没有");
  assert.equal(typeof loaded.diagnostic, "string", "空放行必须带诊断（真机排障唯一抓手）");
  assert.match(loaded.diagnostic, /SKILL_TOOL_PREFIXES/, "诊断要点名登记处，别让人再去 activation.js 找");
  assert.match(loaded.diagnostic, /gamma/);
  assert.ok(host.logs.some((line) => line.includes("SKILL_TOOL_PREFIXES")), "同时进日志（宿主 logger 才看得见）");
  ok("空放行诊断：族前缀与注册面不匹配时给出可执行提示");

  // 反过来：族内有工具、只是已常驻 ⇒ 正常幂等，不该有诊断噪音。
  const host2 = makeHost({ names: ["pwsh", "skill", "alpha_one", "web_search"], conditional: [] });
  host2.rootCtx.get = (name) => {
    if (name === "skills") {
      return {
        async list() { return [{ name: "alpha-skill", provider: "pkg-a", description: "A。", content: undefined }]; },
        async get(key) { return key === "alpha-skill" ? { name: "alpha-skill", provider: "pkg-a", description: "A。", content: "ALPHA BODY" } : undefined; },
        async snapshot() { return { skills: await this.list(), complete: true }; },
      };
    }
    if (name === "workingDirectory") return { ensure: async () => tmp() };
    return undefined;
  };
  const policy2 = resolvePolicy(
    {
      version: 3,
      defaults: { capability: TIER_ONDEMAND, section: TIER_RESIDENT, skillpack: TIER_ONDEMAND },
      // alpha_one 没有已知前缀 ⇒ 引擎按「未知按常驻」兜底；这里显式压回第二层，用例才有东西可放。
      capabilities: { "tool:alpha_one": { tier: TIER_ONDEMAND } },
      skills: { takeover: true },
    },
    { logger: host2.logger, dshHome: tmp() },
  );
  const gate2 = createGate({ ctx: host2.rootCtx, logger: host2.logger, policy: policy2 });
  await gate2.attach(host2.agent);
  const first = await gate2.loadSkill(host2.agent, "alpha-skill");
  assert.deepEqual(first.promoted, ["alpha_one"], "首轮放出本族工具");
  assert.equal(first.diagnostic, undefined, "有放行就不该有诊断");
  const second = await gate2.loadSkill(host2.agent, "alpha-skill");
  assert.deepEqual(second.promoted, [], "第二轮幂等");
  assert.equal(second.diagnostic, undefined, "族内确实有工具、只是已常驻 ⇒ 不是缺陷，不给噪音诊断");
  ok("空放行诊断：已常驻的幂等空放行不误报");
}

// ---- 10) strict outputSchema 递归校验回归（0.7.2：防真实宿主 additionalProperties:false 拒收） ----
{
  const matchesType = (value, typeName) => {
    if (typeName === "null") return value === null;
    if (typeName === "array") return Array.isArray(value);
    if (typeName === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (typeName === "integer") return typeof value === "number" && Number.isInteger(value);
    if (typeName === "number") return typeof value === "number" && Number.isFinite(value);
    return typeof value === typeName;
  };

  const assertStrictSchema = (value, schema, at = "$") => {
    assert.ok(schema && typeof schema === "object", at + ": 缺少 schema");
    if (schema.enum !== undefined) {
      const hit = schema.enum.some((item) => Object.is(item, value) || JSON.stringify(item) === JSON.stringify(value));
      assert.ok(hit, at + ": 值 " + JSON.stringify(value) + " 不在 enum " + JSON.stringify(schema.enum) + " 中");
    }
    if (schema.type !== undefined) {
      const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
      assert.ok(
        allowed.some((t) => matchesType(value, t)),
        at + ": 类型不匹配，期望 " + allowed.join("|") + "，实际为 " + (value === null ? "null" : Array.isArray(value) ? "array" : typeof value),
      );
    }
    if (Array.isArray(value)) {
      if (schema.items && typeof schema.items === "object") {
        for (let i = 0; i < value.length; i += 1) {
          assertStrictSchema(value[i], schema.items, at + "[" + i + "]");
        }
      }
      return;
    }
    if (value !== null && typeof value === "object") {
      const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
      if (Array.isArray(schema.required)) {
        for (const reqKey of schema.required) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(value, reqKey) && value[reqKey] !== undefined,
            at + ": 缺少必填字段 " + reqKey,
          );
        }
      }
      for (const key of Object.keys(value)) {
        const val = value[key];
        if (Object.prototype.hasOwnProperty.call(props, key)) {
          assert.notEqual(val, undefined, at + "." + key + ": 声明字段值不得为 undefined（宿主 strict 校验会拒收）");
          assertStrictSchema(val, props[key], at + "." + key);
        } else if (schema.additionalProperties === false) {
          assert.fail(at + ": 出现未声明的额外字段 " + key + "（additionalProperties: false）");
        } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
          assertStrictSchema(val, schema.additionalProperties, at + "." + key);
        }
      }
    }
  };

  const defs = {
    "browser-skill": { name: "browser-skill", provider: "pkg-bsk", description: "浏览器。", content: "BSK BODY" },
    "gamma-skill": { name: "gamma-skill", provider: "pkg-g", description: "G。", content: "GAMMA BODY" },
  };
  const host = makeHost({
    names: ["pwsh", "skill", "web_search", "bsk_session"],
    conditional: ["bsk_session"],
    isolatedEvents: true,
  });
  host.rootCtx.get = (name) => {
    if (name === "skills") {
      return {
        async list() { return Object.values(defs).map((row) => ({ ...row, content: undefined })); },
        async get(key) { return defs[key] ? { ...defs[key] } : undefined; },
        async snapshot() { return { skills: await this.list(), complete: true }; },
      };
    }
    if (name === "workingDirectory") return { ensure: async () => tmp() };
    return undefined;
  };
  host.rootCtx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    if (exec.name === "skill" && exec.arguments && exec.arguments.name === "browser-skill") {
      if (!host.hasTool("bsk_page")) {
        host.rootCtx.tools.register({ name: "bsk_page", description: "翻页。", execute: async () => ({ content: [] }) });
      }
    }
    return decision;
  }, { prepend: true });
  host.rootCtx.on("tools/result", () => {});

  const policy = resolvePolicy(
    { version: 3, defaults: { capability: TIER_ONDEMAND, section: TIER_RESIDENT, skillpack: TIER_ONDEMAND }, skills: { takeover: true } },
    { logger: host.logger, dshHome: tmp() },
  );
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  registerGateTools({ ctx: host.rootCtx, gate, policy });
  await gate.attach(host.agent);

  const loadTool = host.tool("gate_load");
  const loadSchema = loadTool.output.schema;

  // ① 双通道 relay.waterfall + relay.emit 成功放行
  const singleOut = await loadTool.execute({ names: ["skill:browser-skill"] }, { agent: host.agent, signal: undefined });
  assertStrictSchema(singleOut, loadSchema);
  assert.equal(singleOut.activation.relay.waterfall.listeners, 1);
  assert.equal(singleOut.activation.relay.emit.listeners, 1);
  assert.equal(singleOut.activation.diagnostic, undefined);

  // ② 空放行带 diagnostic 字段
  const diagOut = await loadTool.execute({ names: ["skill:gamma-skill"] }, { agent: host.agent, signal: undefined });
  assertStrictSchema(diagOut, loadSchema);
  assert.equal(typeof diagOut.activation.diagnostic, "string");
  assert.match(diagOut.activation.diagnostic, /SKILL_TOOL_PREFIXES/);
  assert.equal(diagOut.receipts[0].diagnostic, diagOut.activation.diagnostic);

  // ③ 多技能 receipts[] + 非技能工具加载（无 activation）
  const multiOut = await loadTool.execute({ names: ["skill:gamma-skill", "skill:browser-skill"] }, { agent: host.agent, signal: undefined });
  assertStrictSchema(multiOut, loadSchema);
  assert.equal(multiOut.receipts.length, 2);
  assert.equal(typeof multiOut.receipts[0].diagnostic, "string");
  assert.equal(multiOut.receipts[1].diagnostic, undefined);
  const toolOnlyOut = await loadTool.execute({ names: ["web_search"] }, { agent: host.agent, signal: undefined });
  assertStrictSchema(toolOnlyOut, loadSchema);
  assert.equal(toolOnlyOut.activation, undefined);

  // 其余 3 个 gate_* 工具也一并过 strict outputSchema（gate_call 已移除）
  assert.equal(host.tool("gate_call"), undefined, "gate_call 不得再注册");
  assertStrictSchema(await host.tool("gate_status").execute({}, { agent: host.agent }), host.tool("gate_status").output.schema);
  assertStrictSchema(await host.tool("gate_search").execute({ query: "web" }, { agent: host.agent }), host.tool("gate_search").output.schema);
  assertStrictSchema(await host.tool("gate_invoke").execute({ tool: "web_search", arguments: {} }, { agent: host.agent }), host.tool("gate_invoke").output.schema);

  // 负面反证：任何未声明字段必红
  assert.throws(() => assertStrictSchema({ ...diagOut, undeclaredTop: 1 }, loadSchema), /undeclaredTop/);
  assert.throws(() => assertStrictSchema({ ...diagOut, activation: { ...diagOut.activation, undeclaredAct: 1 } }, loadSchema), /undeclaredAct/);
  assert.throws(() => assertStrictSchema({
    ...diagOut,
    activation: { ...diagOut.activation, relay: { ...diagOut.activation.relay, undeclaredRelay: 1 } },
  }, loadSchema), /undeclaredRelay/);
  assert.throws(() => assertStrictSchema({
    ...diagOut,
    activation: {
      ...diagOut.activation,
      relay: {
        ...diagOut.activation.relay,
        waterfall: { ...diagOut.activation.relay.waterfall, undeclaredChannel: 1 },
      },
    },
  }, loadSchema), /undeclaredChannel/);
  assert.throws(() => assertStrictSchema({ mode: "bad" }, {
    type: "object",
    required: ["mode", "count"],
    properties: { mode: { type: "string", enum: ["off", "emit"] }, count: { type: "number" } },
  }), /enum|缺少必填字段/);
  ok("strict outputSchema 回归：双通道 relay、空放行 diagnostic、多技能 receipts 与全门工具 100% 校验通过（新增未声明字段必红）");
}

console.log("\n  通过 " + passed + " 组");
