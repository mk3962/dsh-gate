/**
 * 技能激活族（0.5.4 · 上游票 B2 执行面）用例。
 *
 * 锁住四条口径（改 lib/activation.js 前先读）：
 *  1) 族切分只取技能名第一段：univer-sheet → univer、office-docx → office、browser-skill → browser；
 *     切不出标识符形状（空串、数字开头、中文）时返回空串 —— 宁可不放，也不误放。
 *  2) 族内判据只有「名字就是族」与「族_ 前缀」两条：univerx 不算 univer 族。
 *  3) pickPromotable 只放 conditional（带 when）的注册；非 conditional 放它没有意义。
 *  4) explicit off / 已常驻 绝不放；结果排序，同一输入两次结果一致。
 *
 * 跑法：node --import ./test/stub-loader.mjs test/activation.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { familyToolNames, pickPromotable, skillFamilyOf } from "../lib/activation.js";
import { createGate } from "../lib/gate.js";
import { resolvePolicy, TIER_ONDEMAND, TIER_RESIDENT } from "../lib/policy.js";
import { makeHost } from "./host.mjs";

let passed = 0;
const ok = (label) => { passed += 1; console.log("  ok    " + label); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gate-activation-"));

// ---- 1) 族切分 ----
assert.equal(skillFamilyOf("univer"), "univer");
assert.equal(skillFamilyOf("univer-sheet"), "univer");
assert.equal(skillFamilyOf("office-docx"), "office");
assert.equal(skillFamilyOf("browser-skill"), "browser");
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

// ---- 3) 只放 conditional ----
const conditional = new Set(["univer_status", "univer_api", "office_render"]);
let picked = pickPromotable({ skillName: "univer", names, conditional });
assert.deepEqual(picked, ["univer_api", "univer_status"], "非 conditional 的 univer 不放；结果排序");
picked = pickPromotable({ skillName: "univer", names, conditional: new Set() });
assert.deepEqual(picked, [], "没有 conditional 注册 ⇒ 不放（等价 0.5.3 行为）");
picked = pickPromotable({ skillName: "univer", names, conditional: undefined });
assert.deepEqual(picked, [], "conditional 不是 Set ⇒ 不放（形状防御）");
ok("只放 conditional：没有 when 的工具不碰");

// ---- 4) off / 已常驻 不放 ----
picked = pickPromotable({
  skillName: "univer",
  names,
  conditional,
  off: new Set(["univer_status"]),
});
assert.deepEqual(picked, ["univer_api"], "explicit off 绝不放（关掉必须真的关）");
const firstPick = pickPromotable({
  skillName: "univer",
  names,
  conditional,
  resident: new Set(["univer_api"]),
});
assert.deepEqual(firstPick, ["univer_status"], "已经常驻的不必再放（幂等）");
const again = pickPromotable({
  skillName: "univer",
  names,
  conditional,
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
    "只放本族 conditional 工具（office_render 不属于 univer 族）");

  const after = rig.gate.snapshot(rig.host.agent).tiers;
  assert.equal(after.univer_status, TIER_RESIDENT, "放出的工具按常驻处理（下一步被声明、进 admission）");
  assert.equal(after.univer_api, TIER_RESIDENT);
  assert.equal(after.office_render, TIER_ONDEMAND, "别的族不受影响");
  const denies = rig.host.restrictionsFor(rig.host.agent).map((set) => [...set]);
  assert.ok(denies.every((set) => !set.includes("univer_status")), "放出的名字必须从 deny 里消失");
  assert.ok(denies.some((set) => set.includes("office_render")), "没放出的族仍留在 deny 里");

  const again = await rig.gate.loadSkill(rig.host.agent, "univer");
  assert.deepEqual(again.promoted, [], "第二次加载同一个技能：一个都不再放（幂等）");
  ok("端到端：加载技能把该族 conditional 工具放进常驻面并从 deny 移除");

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

console.log("\n  通过 " + passed + " 组");
