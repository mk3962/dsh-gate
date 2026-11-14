/**
 * 热重载泄漏（2026-11-14 unlag 刷新事故）回归用例。
 *
 * 事故形态：unlag 按钮触发插件热重载，正在运行的会话被装配出一次「全量工具声明」的
 * 系统提示词 —— tools:sdk 段从 31 个工具 / 45,245 字符涨到 147 个 / 162,551 字符，
 * 该步 cacheRead 199,552 → 2,048（命中 0.9%），下一步 6,144（3.1%）。
 *
 * 两个已定案的成因，各一条用例：
 *   1) lib/sections.js：`await next()` 在前、attach/ensureSkills 在后 —— 宿主是在 next()
 *      内部按「当时可见的工具」渲染 tools:sdk 的，限制晚一步落下就必然全量渲染；
 *   2) lib/gate.js reapply：scoped tools 未就绪时主动 restriction.drop() —— 撤销等于把
 *      全部工具放出来一次，代价（一次全量声明 + 两跳前缀缓存断裂）远大于「暂时留着
 *      一条撤得掉的 deny」。
 *
 * 宿主来自共享 seam（test/host.mjs）。跑法：node test/reload-leak.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGate } from "../lib/gate.js";
import { resolvePolicy } from "../lib/policy.js";
import { mountSectionGate } from "../lib/sections.js";
import { makeHost } from "./host.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gate-reload-"));

/** 常驻口径：只有 read / pwsh / todo_write（其余全部按需）+ agent 自有层的 run_code。 */
const policyFor = (extra) => resolvePolicy({
  defaults: { capability: 2, section: 2, skillpack: 2 },
  capabilities: {
    "native:read": { tier: 1 },
    "native:pwsh": { tier: 1 },
    "native:todo_write": { tier: 1 },
  },
  ...(extra || {}),
}, { dshHome: tmp() });

const results = [];
const check = async (label, fn) => {
  try { await fn(); results.push({ ok: true, label }); }
  catch (error) { results.push({ ok: false, label, error: String((error && error.message) || error) }); }
};

/**
 * 假宿主的 tools:sdk 渲染：真实宿主是在 system-prompt/assemble 的 **inner** 一侧按
 * 「此刻可见的工具」生成这一段的。这里用同样口径的渲染函数替身 —— 它看到多少个工具名，
 * 那一步的系统提示词就有多少条声明。装配钩子若在调用它之前没把 deny 落下，这里就会看到全量。
 */
const installRenderer = (host, seen) => host.rootCtx.on("system-prompt/assemble", (_assembly, context) => {
  const agent = context && context.scope;
  const names = [...host.visibleOf(agent).keys()].sort();
  seen.push(names);
  return {
    sections: [
      { name: "HARNESS_IDENTITY", text: "you are dsh" },
      { name: "tools:sdk", text: "## Writing code for run_code\n" + names.join("\n") },
    ],
    contexts: [],
    tools: [],
    variables: {},
  };
});

const toolsOf = (result) => {
  const section = result.sections.find((row) => row && row.name === "tools:sdk");
  return section.text.split("\n").slice(1).filter((line) => line.length > 0);
};

// ── 1. 装配顺序：deny 必须在宿主渲染 tools:sdk 之前落下 ────────────────────────
await check("装配顺序：首次装配就只渲染常驻工具，不是全量声明（deny 先于 next() 生效）", async () => {
  const host = makeHost({ id: "reload-1" });
  const policy = policyFor();
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  mountSectionGate({ ctx: host.rootCtx, gate, logger: host.logger, policy });
  const seen = [];
  installRenderer(host, seen);

  // 一次 attach 都不跑：这正是热重载后「entry 还没就绪就来了一次装配」的形态。
  const result = await host.assemble({ sections: [], contexts: [], tools: [], variables: {} }, host.agent);
  const rendered = toolsOf(result);
  const resident = [...gate.snapshot(host.agent).residentNames].sort();
  assert.equal(seen.length, 1, "next() 只能调用一次（渲染只发生一次）");
  assert.deepEqual(rendered, resident, "tools:sdk 渲染的必须是常驻口径，不是全量：" + JSON.stringify(rendered));
  assert.equal(rendered.length, resident.length);
  assert.ok(rendered.length < host.registry.size, "常驻口径必须小于注册表全量（否则这条用例什么也没验证）");
  assert.equal(rendered.includes("univer_sheet"), false, "按需工具不许漏进这一步的工具表");
  assert.equal(rendered.includes("run_code"), true, "自有层的 run_code 永远常驻（restrict 管不到）");
  await gate.release(host.agent);
});

await check("装配顺序：连续两次装配的工具表逐字节一致（不掉进「先全量后收窄」的抖动）", async () => {
  const host = makeHost({ id: "reload-1b" });
  const policy = policyFor();
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  mountSectionGate({ ctx: host.rootCtx, gate, logger: host.logger, policy });
  const seen = [];
  installRenderer(host, seen);
  const first = toolsOf(await host.assemble({ sections: [], contexts: [], tools: [], variables: {} }, host.agent));
  const second = toolsOf(await host.assemble({ sections: [], contexts: [], tools: [], variables: {} }, host.agent));
  assert.deepEqual(second, first, "第二次装配不许改工具表（改字节 = 断前缀缓存）");
  await gate.release(host.agent);
});

// ── 2. scoped 未就绪：绝不撤销已有限制 ───────────────────────────────────────
await check("scoped 未就绪时 reapply 不 drop（撤销 = 放全表一次，代价远大于留着一条 deny）", async () => {
  const host = makeHost({ id: "reload-2" });
  const agent = host.addAgent({ id: "reload-2" });
  // 把宿主 scoped ctx 抓在手里：热重载窗口里 entry.scoped.tools 可能还没就绪。
  let scoped;
  const plugin = agent.ctx.plugin;
  agent.ctx.plugin = (descriptor) => plugin({
    inject: descriptor.inject,
    apply(ctx) { scoped = ctx; descriptor.apply(ctx); },
  });
  const policy = policyFor();
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  await gate.attach(agent);
  const limited = gate.restrictionState(agent);
  assert.equal(limited.mode, "limited", "前提：先正常限制住");
  const before = { restrict: host.restrictCalls(agent).filter((row) => row.kind === "restrict").length,
    lift: host.restrictCalls(agent).filter((row) => row.kind === "lift").length };
  assert.equal(before.lift, 0);

  // 模拟 reload 窗口：scoped tools 拿不到，但宿主侧那条 deny 还挂着。
  const tools = scoped.tools;
  delete scoped.tools;
  gate.reapply(agent);

  const after = gate.restrictionState(agent);
  assert.equal(after.mode, "limited", "scoped 未就绪时不许把已有限制撤掉");
  assert.equal(after.count, limited.count, "deny 集原样保留");
  assert.equal(host.restrictionsFor(agent).length, 1, "宿主侧的限制必须还在（没被 lift）");
  assert.equal(host.restrictCalls(agent).filter((row) => row.kind === "lift").length, 0, "一次 lift 都不许发生");

  // 恢复路径：scoped 一就绪就照常重算 —— 现有 deny 不会被永久卡住。
  scoped.tools = tools;
  gate.reapply(agent);
  assert.equal(gate.restrictionState(agent).mode, "limited");
  assert.deepEqual(
    host.restrictCalls(agent).filter((row) => row.kind === "restrict").map((row) => row.deny).length,
    before.restrict,
    "目标形状没变，恢复后不该再 restrict（幂等）",
  );
  await gate.release(agent);
});

await check("从没限制过（MODE_NONE）时 scoped 未就绪：什么都不做，不留限制", async () => {
  // 工具面只有两个名字、且没有宿主 skill 工具（接管会无条件 deny 它）⇒ deny 恒空 ⇒ none。
  const host = makeHost({ id: "reload-3", names: ["read", "pwsh"] });
  const policy = policyFor({ capabilities: {}, defaults: { capability: 1, section: 2, skillpack: 2 } });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  await gate.attach(host.agent);
  // 全常驻 ⇒ deny 为空 ⇒ 本来是 none。
  assert.equal(gate.restrictionState(host.agent).mode, "none", "前提：这个 agent 本来就没被限制");
  assert.equal(host.restrictCalls(host.agent).length, 0, "全常驻不该产生任何 restrict");
  gate.reapply(host.agent);
  assert.equal(gate.restrictionState(host.agent).mode, "none");
  assert.equal(host.restrictionsFor(host.agent).length, 0);
  await gate.release(host.agent);
});

// ── 3. 保留原有短路：policy.enabled=false 时不挂限制、不碰工具面 ──────────────
await check("policy.enabled=false：装配钩子不 attach 也不限制（原有短路不变）", async () => {
  const host = makeHost({ id: "reload-4" });
  const policy = policyFor({ enabled: false });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  mountSectionGate({ ctx: host.rootCtx, gate, logger: host.logger, policy });
  const seen = [];
  installRenderer(host, seen);
  const result = await host.assemble({ sections: [], contexts: [], tools: [], variables: {} }, host.agent);
  assert.equal(toolsOf(result).length, host.visibleOf(host.agent).size, "关闭闸门时工具面保持全量");
  assert.equal(host.restrictCalls(host.agent).length, 0, "关闭时一次 restrict 都不许调");
  await gate.release(host.agent);
});

const failed = results.filter((row) => !row.ok);
for (const row of results) console.log((row.ok ? "  ok    " : "  FAIL  ") + row.label + (row.ok ? "" : "  →  " + row.error));
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exitCode = failed.length === 0 ? 0 : 1;
