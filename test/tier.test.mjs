/**
 * 归层单出口（票 04）用例。
 *
 * 规则以前有两份实现：planFor 的 if 链决定限制谁，tierMap 又写一遍决定面板显示谁。
 * 现在两处都走 resolveTier；本文件穷举候选名字，断言「快照给出的桶」与「快照给出的层」
 * 不可能再各说一套。
 *
 * 票 06 之后这两样都只从 gate.snapshot() 读：测试不再摸 planFor / tierMap 这类内部件，
 * 内部怎么重构都只影响它自己。
 *
 * 宿主来自共享 seam（test/host.mjs）。跑法：node test/tier.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGate } from "../lib/gate.js";
import { resolvePolicy, resolveTier, TIER_OFF, TIER_ONDEMAND, TIER_RESIDENT } from "../lib/policy.js";
import { makeHost } from "./host.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-tier-"));

const GLOBAL_NAMES = [
  "read", "write", "edit", "grep", "glob", "pwsh", "web_search", "web_fetch", "skill",
  "univer_sheet", "univer_doc", "ssh_exec", "mnemon_recall", "todo_write",
];
// preset 平面：只挂在 agent 祖先层，全局视图看不到。
const PRESET_NAMES = ["office_docx", "video_search"];
// 关层：overrides 里点名 0。
const OFF_NAMES = ["terminal_open", "schedule_create"];

const policy = resolvePolicy(
  {
    tools: {
      defaultTier: 1,
      overrides: {
        read: 1, write: 1, edit: 1, grep: 1, glob: 1, pwsh: 1, web_search: 1, web_fetch: 1, skill: 1,
        // 点名的 preset 工具 → 受管，落按需。
        video_search: 2,
        // 关层。
        terminal_open: 0,
        schedule_create: 0,
        // 按需。
        univer_sheet: 2, univer_doc: 2, ssh_exec: 2, mnemon_recall: 2,
      },
    },
    sections: { defaultTier: 1 },
  },
  { logger: undefined, dshHome: policyDir },
);

const host = makeHost({ names: [...GLOBAL_NAMES, ...PRESET_NAMES, ...OFF_NAMES], preset: PRESET_NAMES, id: "tier-agent" });
const agent = host.agent;
const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
await gate.attach(agent);
await gate.load(agent, ["todo_write"]);
gate.reapply(agent);

const state = gate.snapshot(agent);
const tiers = state.tiers;

/**
 * 计划落进哪个桶 —— 只从快照的公开清单反推，不读内部规则。
 * 顺序有意义：一个名字可能同时算「常驻」与「preset」，标签以更具体的身份优先。
 */
const bucketOf = (name) => {
  if (state.ownNames.includes(name)) return "own";
  if (state.presetNames.includes(name)) return "preset";
  if (state.residentNames.includes(name)) return "resident";
  if (state.onDemandNames.includes(name)) return "ondemand";
  if (state.offNames.includes(name)) return "off";
  return undefined;
};

const BUCKET_TIER = { own: TIER_RESIDENT, preset: TIER_RESIDENT, resident: TIER_RESIDENT, ondemand: TIER_ONDEMAND, off: TIER_OFF };

const results = [];
const check = (label, fn) => {
  try { fn(); results.push({ ok: true, label }); }
  catch (error) { results.push({ ok: false, label, error: String((error && error.message) || error) }); }
};

check("对每个候选名字，面板给的层与快照落进的桶一致（穷举）", () => {
  const names = Object.keys(tiers);
  assert.ok(names.length > 0, "候选集不能为空");
  for (const name of names) {
    const bucket = bucketOf(name);
    assert.ok(bucket !== undefined, name + " 没落进任何桶（桶清单与归层表对不上）");
    assert.equal(tiers[name], BUCKET_TIER[bucket], name + " 桶=" + bucket + " 面板层=" + tiers[name]);
    // 桶与层必须双向一致：桶是 own/preset/resident 就一定常驻，反之亦然。
    assert.equal(BUCKET_TIER[bucket] === TIER_RESIDENT, bucket !== "ondemand" && bucket !== "off", name + " 的桶与层语义矛盾");
  }
});

check("桶清单互不重叠，且四个数字与名字清单长度一致", () => {
  const groups = [state.ownNames, state.presetNames, state.residentNames, state.onDemandNames, state.offNames];
  const seen = new Map();
  for (const group of groups) {
    for (const name of group) {
      // 常驻清单本身就会包含 own / preset 的名字（它们是常驻的子集），其余几组必须互斥。
      if (group === state.residentNames) continue;
      assert.equal(seen.has(name), false, name + " 同时出现在两个互斥清单里");
      seen.set(name, true);
    }
  }
  assert.equal(state.resident + state.onDemand + state.off, state.visible, "可见 = 常驻 + 按需 + 关闭");
  assert.equal(state.resident, state.residentNames.length);
  assert.equal(state.onDemand, state.onDemandNames.length);
  assert.equal(state.off, state.offNames.length);
});

check("preset 平面语义不变：全局不可见 且 未加载 且 无工具覆盖 → 归 preset / 常驻", () => {
  // office_docx 没被点名。
  assert.equal(bucketOf("office_docx"), "preset");
  assert.equal(tiers.office_docx, TIER_RESIDENT);
  // video_search 被点名成 2 ⇒ 受管，落按需并被藏掉。
  assert.equal(bucketOf("video_search"), "ondemand");
  assert.equal(tiers.video_search, TIER_ONDEMAND);
});

check("受保护名字恒常驻，覆盖任何层级设置", () => {
  const guarded = resolvePolicy(
    { tools: { defaultTier: 2, overrides: { gate_status: 0, run_code: 2 } }, sections: { defaultTier: 1 } },
    { logger: undefined, dshHome: policyDir },
  );
  for (const name of ["gate_status", "gate_search", "gate_load", "gate_call", "run_code"]) {
    const decided = resolveTier(guarded, name, { loaded: false, globallyVisible: true, own: false });
    assert.equal(decided.bucket, "resident", name + " 必须常驻，实际 " + decided.bucket);
  }
});

check("已加载名字恒常驻", () => {
  assert.equal(bucketOf("todo_write"), "resident", "gate_load 认领后必须落常驻");
  assert.equal(tiers.todo_write, TIER_RESIDENT);
});

check("own 层恒常驻（restrict 管不到，面板也不该猜成按需）", () => {
  assert.ok(state.ownNames.length > 0, "own 清单不能为空（run_code 属于这一类）");
  for (const name of state.ownNames) {
    assert.equal(bucketOf(name), "own");
    assert.equal(tiers[name], TIER_RESIDENT);
  }
});

check("关层名字进 off 桶，且真的被藏掉", () => {
  for (const name of OFF_NAMES) {
    // 缺席就整条跳过等于这条用例可以永远为真；点名的关层工具必须真出现在归层表里。
    assert.ok(name in tiers, name + " 必须在归层表里（缺席说明候选集把它漏了）");
    assert.equal(bucketOf(name), "off", name + " 应归 off");
    assert.equal(tiers[name], TIER_OFF);
    assert.equal(host.visibleOf(agent).has(name), false, name + " 应当真的从工具面消失");
  }
});

check("两处不再各写一遍归层规则", () => {
  const source = fs.readFileSync(path.join(here, "..", "lib", "gate.js"), "utf8");
  assert.ok(source.includes("resolveTier("), "gate.js 必须走 resolveTier");
  assert.equal(/tierForTool\(policy, name\)/.test(source), false, "gate.js 里不该再直接调 tierForTool 定层");
  // preset 平面的判据只该出现在 policy.js。
  assert.equal(source.includes("hasToolOverride"), false, "preset 判据不该再写在 gate.js 里");
  const policySource = fs.readFileSync(path.join(here, "..", "lib", "policy.js"), "utf8");
  assert.ok(policySource.includes("export function resolveTier"), "policy.js 必须导出 resolveTier");
});

check("gate 的公开面不再交出内部表与内部函数（票 06）", () => {
  for (const gone of ["entries", "visibleOf", "planFor", "tierMap", "status"]) {
    assert.equal(gate[gone], undefined, "gate." + gone + " 不该再是公开成员");
  }
  for (const kept of ["attach", "listAgents", "snapshot", "reapply", "isApplying", "load", "callThrough", "catalogFor", "rememberSkills", "recordSections", "planSections", "release", "releaseAll", "restrictionState"]) {
    assert.equal(typeof gate[kept], "function", "gate." + kept + " 必须还在");
  }
});

await gate.release(agent);

const failed = results.filter((row) => !row.ok);
for (const row of results) console.log((row.ok ? "  ok    " : "  FAIL  ") + row.label + (row.ok ? "" : "  →  " + row.error));
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exitCode = failed.length === 0 ? 0 : 1;
