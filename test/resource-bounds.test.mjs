/**
 * D20：后台资源必须有界。条目表、告警去重集合、技能激活回执都不能随会话数/步数无限长。
 * 这里把上限调小来验证回收行为，生产值只断言常量。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGENT_ENTRY_LIMIT,
  AGENT_ENTRY_TTL_MS,
  RELAY_RECEIPT_LIMIT,
  WARNED_LIMIT,
  createGate,
} from "../lib/gate.js";
import { TIER_ONDEMAND, resolvePolicy } from "../lib/policy.js";
import { makeHost } from "./host.mjs";

const results = [];
const check = async (label, fn) => {
  try { await fn(); results.push({ ok: true, label }); }
  catch (error) { results.push({ ok: false, label, error }); }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gate-bounds-"));
const policyOf = (host, raw) => resolvePolicy(
  Object.assign({ version: 3, defaults: { capability: TIER_ONDEMAND, section: TIER_ONDEMAND, skillpack: TIER_ONDEMAND }, skills: { takeover: true } }, raw || {}),
  { logger: host.logger, dshHome: tmp() },
);
const rig = (names, extra) => {
  const host = makeHost({ names });
  const policy = policyOf(host, extra && extra.policy);
  const gate = createGate(Object.assign({ ctx: host.rootCtx, logger: host.logger, policy }, (extra && extra.gate) || {}));
  return { host, gate, policy };
};

await check("生产上限常量：条目 64 / 空闲 30 分钟 / 告警 200 / 回执 32", () => {
  assert.equal(AGENT_ENTRY_LIMIT, 64);
  assert.equal(AGENT_ENTRY_TTL_MS, 30 * 60 * 1000);
  assert.equal(WARNED_LIMIT, 200);
  assert.equal(RELAY_RECEIPT_LIMIT, 32);
});

await check("条目表满：淘汰最久没动过的那个，新 agent 一定留下", async () => {
  const { host, gate } = rig(["read", "pwsh"], { gate: { entryLimit: 2 } });
  const first = host.addAgent({ id: "agent-a" });
  const second = host.addAgent({ id: "agent-b" });
  const third = host.addAgent({ id: "agent-c" });
  await gate.attach(first);
  await gate.attach(second);
  await gate.attach(third);
  const ids = gate.listAgents().map((row) => row.id).sort();
  assert.deepEqual(ids, ["agent-b", "agent-c"], "最久没动的 agent-a 被回收，最新的一定在");
  assert.equal(gate.listAgents().length, 2, "条目表不超过上限");
});

await check("空闲 TTL：超过 TTL 的条目在下次建条目时被扫掉（含孤儿）", async () => {
  const { host, gate } = rig(["read"], { gate: { entryTtlMs: 5 } });
  const stale = host.addAgent({ id: "agent-stale" });
  await gate.attach(stale);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const fresh = host.addAgent({ id: "agent-fresh" });
  await gate.attach(fresh);
  assert.deepEqual(gate.listAgents().map((row) => row.id), ["agent-fresh"], "空闲条目被清掉");
  stale.ctx = undefined;
  await new Promise((resolve) => setTimeout(resolve, 25));
  await gate.attach(host.addAgent({ id: "agent-last" }));
  assert.ok(gate.listAgents().every((row) => row.agent.ctx !== undefined), "孤儿条目同样清掉");
});

await check("技能激活回执单次上限 32，截断时标出总数", async () => {
  const names = ["read", "pwsh", ...Array.from({ length: 40 }, (_item, index) => "fam_t" + String(index).padStart(2, "0"))];
  const { host, gate } = rig(names, { policy: { capabilities: { "glob:fam_*": { tier: TIER_ONDEMAND } } } });
  await gate.attach(host.agent);
  gate.rememberSkills(host.agent, [{ name: "fam", provider: "pkg-fam", origin: "import", description: "族技能。", content: "FAM BODY" }]);
  const loaded = await gate.loadSkill(host.agent, "fam");
  assert.equal(loaded.ok, true);
  assert.equal(loaded.promoted.length, RELAY_RECEIPT_LIMIT, "回执最多 32 条");
  assert.equal(loaded.activation.promotedTotal, 40, "总数另给，别让调用方以为只有 32 个");
  assert.equal(loaded.activation.truncated, true);
  assert.equal(loaded.activation.promoted.length, loaded.promoted.length, "回执两处同源");
  assert.ok(loaded.promoted.every((name) => name.startsWith("fam_")));
});

await check("未截断时不谎报：小回执 truncated=false 且总数一致", async () => {
  const { host, gate } = rig(["read", "univer_status", "univer_api"], {});
  await gate.attach(host.agent);
  gate.rememberSkills(host.agent, [{ name: "univer", provider: "pkg-u", origin: "import", description: "Univer。", content: "UNIVER" }]);
  const loaded = await gate.loadSkill(host.agent, "univer");
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.promoted, ["univer_api", "univer_status"]);
  assert.equal(loaded.activation.promotedTotal, 2);
  assert.equal(loaded.activation.truncated, false);
});

console.log("");
for (const row of results) {
  if (row.ok) console.log("  ok    " + row.label);
  else { console.log("  FAIL  " + row.label + "  →  " + (row.error && row.error.message ? row.error.message : row.error)); process.exitCode = 1; }
}
const failed = results.filter((row) => row.ok === false).length;
console.log("");
console.log((results.length - failed) + "/" + results.length + " passed");
