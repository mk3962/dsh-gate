/**
 * 工单 #04 的运行时回归（D8 租约 / D9 转发 / D10 规范化 / C35 回执 / D13 段落淘汰）。
 *
 * 锁「0.5.7 真出过事、0.6.0 必须逐条可验证」的口径：
 *  - C31：删除二十次五毫秒轮询；调度只有闸门里一个防抖定时器（可清、有上限）
 *  - C32 / P2-5：闸门工具族一律不可转发（code = gate-tool-not-forwardable）
 *  - C33 / C34 / P1-8：文本块单换行拼接；image / audio / resource 原样保留（不 stringify）
 *  - C35：load 回执逐技能聚合（receipts），一次加载多个技能不再只回最后一条
 *  - C36：卸载后限制撤销、条目释放、不再安排定时器
 *  - C37：热挂载时活跃 agent（含子代理）都建限制
 *  - C43 / C48：段落库存淘汰只淘汰孤儿、报 evicted；淘汰进被吞异常计数
 *  - C47：已取消的调用绝不执行、批量失败也不重试
 *  - C40：转发工具族不进护栏计数；内层已计入的结果外层不重复记账
 *
 * 宿主来自共享 seam（test/host.mjs）。跑法：
 *   node --import ./test/stub-loader.mjs test/runtime-d04.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGate } from "../lib/gate.js";
import { resolvePolicy, TIER_ONDEMAND } from "../lib/policy.js";
import { registerGateTools } from "../lib/proxy.js";
import { COUNTED_MARK, normalizeToolResult } from "../lib/normalize.js";
import { mountRepeatGuard, repeatGuardDiagnostics, resetRepeatGuardDiagnostics } from "../lib/guardrail.js";
import { failBatchTimes } from "./vendor/dsh-tools/pipeline.js";
import { makeHost, makePtcExecutor } from "./host.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gate-runtime-d04-"));

const results = [];
const check = async (label, fn) => {
  try { await fn(); results.push({ ok: true, label }); }
  catch (error) { results.push({ ok: false, label, error: String((error && error.message) || error) }); }
};

const NAMES = ["read", "write", "pwsh", "ssh_exec", "media_tool", "side_effect_tool", "alpha_tool", "beta_tool"];

/** 最小 rig：宿主 + PTC 执行器（工具表冻结形态）+ 策略（默认按需）+ 闸门工具。 */
const makeRig = (raw = {}, gateOptions = {}) => {
  const host = makeHost({ names: NAMES });
  host.setExecutor(host.agent, makePtcExecutor());
  const policy = resolvePolicy({
    defaults: { capability: 2, section: 2, skillpack: 2 },
    capabilities: { "native:read": { tier: 1 }, "native:pwsh": { tier: 1 } },
    ...raw,
  }, { logger: host.logger, dshHome: tmp() });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy, ...gateOptions });
  registerGateTools({ ctx: host.rootCtx, gate, policy });
  return { host, gate, policy, agent: host.agent };
};

/** 注册一个返回任意 content 的工具（整合测试用；不碰 host.mjs 的默认形状）。 */
const registerTool = (host, name, execute, parameters) => {
  host.rootCtx.tools.register({ name, description: name + " 测试工具。", parameters, execute });
};

const sourceOf = (rel) => fs.readFileSync(path.join(here, "..", "lib", rel), "utf8");

// ── 1. C31：没有轮询；调度只有防抖定时器且有上限 ──────────────────────────────
await check("C31：index.js 不再有轮询猜窗口（没有 setTimeout / 20 次重试）", () => {
  const source = sourceOf("index.js");
  assert.equal(/setTimeout/.test(source), false, "index.js 里不该再有任何定时器");
  assert.equal(/attempt\s*<\s*20/.test(source), false, "二十次轮询必须删掉");
  assert.match(source, /gate\.reapplyAll\(\)/, "tools/change 直接重算（窗口由租约状态机吸收）");
});
await check("C31：restriction.js 没有定时器（窗口只发信号）", () => {
  const source = sourceOf("restriction.js");
  assert.equal(/setTimeout|setInterval/.test(source), false, "限制对象内不许出现定时器");
});
await check("C31：gate.js 的单次防抖调度有句柄、合并与并发上限（C36 可清理）", () => {
  const source = sourceOf("gate.js");
  assert.match(source, /SETTLE_TIMER_CAP/);
  assert.match(source, /const scheduleSettle = \(agent\) =>/);
  assert.match(source, /entry\.settleTimer !== undefined\) return false/, "同名请求必须合并成一次");
  assert.match(source, /if \(disposed\) return false/, "卸载后不再安排");
});

// ── 2. C32 / P2-5：闸门工具族一律不可转发 ────────────────────────────────────
await check("C32：gate_call / gate_invoke 转发闸门工具族一律拒绝（code=gate-tool-not-forwardable）", async () => {
  const { host, gate, agent } = makeRig();
  await gate.attach(agent);
  for (const name of ["gate_invoke", "gate_call", "gate_load", "gate_search", "gate_status"]) {
    for (const tool of ["gate_call", "gate_invoke"]) {
      const args = tool === "gate_call" ? { name } : { tool: name };
      await assert.rejects(
        () => host.tool(tool).execute({ ...args, arguments: {} }, { agent, signal: undefined }),
        (error) => {
          assert.equal(error.code, "gate-tool-not-forwardable", tool + " -> " + name + " 必须带可区分错误码");
          assert.match(error.message, /不能自调|不能作为转发目标/);
          return true;
        },
        tool + " 必须拒绝转发 " + name,
      );
    }
  }
  await gate.release(agent);
});

// ── 3. C33 / C34 / P1-8：多模态转发与文本拼接 ───────────────────────────────
const imageBlock = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" };
const audioBlock = { type: "audio", mimeType: "audio/wav", data: "UklGRg==" };
const resourceBlock = { type: "resource", resource: { uri: "file:///tmp/x.txt", mimeType: "text/plain", text: "RES" } };

await check("C34 / P1-8：规范化器文本块按单个换行拼接，图片/音频/资源块原样保留", () => {
  const normalized = normalizeToolResult({
    content: [
      { type: "text", text: "line one" },
      imageBlock,
      { type: "text", text: "line two" },
      audioBlock,
      resourceBlock,
    ],
  });
  assert.equal(normalized.text, "line one\nline two", "文本块只用一个 \n 拼");
  assert.equal(normalized.contentBlocks.length, 3, "三个结构化块一个都不能丢（P1-8）");
  assert.deepEqual(normalized.contentBlocks[0], imageBlock, "image 必须原样保留（不是 base64 文本）");
  assert.deepEqual(normalized.contentBlocks[1], audioBlock);
  assert.deepEqual(normalized.contentBlocks[2], resourceBlock);
  assert.equal(normalized.truncated, false);
  assert.equal(normalized.dropped.length, 0);
});

await check("C33：超限降级为结构化占位（type/mimeType/estimatedBytes/truncated），正文不搬", () => {
  const big = { type: "image", mimeType: "image/png", data: "A".repeat(400) };
  const normalized = normalizeToolResult({ content: [big] }, { maxBlockBytes: 100 });
  assert.equal(normalized.truncated, true);
  assert.equal(normalized.contentBlocks.length, 1);
  assert.equal(normalized.contentBlocks[0].type, "image");
  assert.equal(normalized.contentBlocks[0].truncated, true);
  assert.ok(normalized.contentBlocks[0].estimatedBytes > 100);
  assert.equal(normalized.contentBlocks[0].data, undefined, "占位里不许留正文/载荷");
  assert.match(normalized.text, /omitted image/);
});

await check("C33：未知块保留浅层元数据并标记省略（不猜它是文本）", () => {
  const normalized = normalizeToolResult({ content: [{ type: "blob", bytes: 7, data: "ZGF0YQ==", hidden: { x: 1 } }] });
  assert.equal(normalized.truncated, true);
  assert.equal(normalized.contentBlocks.length, 0);
  assert.equal(normalized.dropped[0].reason, "unknown-type");
  assert.equal(normalized.dropped[0].meta.type, "blob");
  assert.equal(normalized.dropped[0].meta.data, undefined, "载荷不进上下文");
  assert.match(normalized.text, /unknown-type/);
});

await check("C33 / P1-8：gate_call 端到端转发多模态工具，blocks 保真、text 只有文本", async () => {
  const { host, gate, agent } = makeRig();
  registerTool(host, "media_tool", async () => ({ content: [{ type: "text", text: "A" }, imageBlock, { type: "text", text: "B" }] }));
  await gate.attach(agent);
  const forwarded = await host.tool("gate_call").execute({ name: "media_tool", arguments: {} }, { agent, signal: undefined });
  assert.equal(forwarded.isError, false, forwarded.text);
  assert.equal(forwarded.text, "A\nB", "文本视图只有文本块、单换行拼接");
  assert.equal(forwarded.blocks.length, 1, "图片块必须作为结构化块回来");
  assert.deepEqual(forwarded.blocks[0], imageBlock);
  await gate.release(agent);
});

// ── 4. C35 / C46：load 回执逐技能聚合 ────────────────────────────────────────
await check("C35：一次 gate_load 两个技能 —— receipts 逐条、promoted 聚合去重", async () => {
  // 与 activation.test.mjs 同形：族内工具是 conditional 的按需工具（默认层 = 第二层）。
  const host = makeHost({
    names: ["pwsh", "skill", "univer_status", "univer_api", "office_render", "web_search"],
    conditional: ["univer_status", "univer_api", "office_render"],
  });
  const defs = {
    univer: { name: "univer", provider: "pkg-u", description: "Univer。", content: "UNIVER BODY" },
    office: { name: "office", provider: "pkg-o", description: "Office。", content: "OFFICE BODY" },
  };
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
  const policy = resolvePolicy(
    { version: 3, defaults: { capability: TIER_ONDEMAND, section: 2, skillpack: TIER_ONDEMAND }, skills: { takeover: true } },
    { logger: host.logger, dshHome: tmp() },
  );
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  registerGateTools({ ctx: host.rootCtx, gate, policy });
  await gate.attach(host.agent);
  const out = await host.tool("gate_load").execute({ names: ["skill:univer", "skill:office"] }, { agent: host.agent, signal: undefined });
  assert.deepEqual(out.loaded.filter((n) => n.startsWith("skill:")).sort(), ["skill:office", "skill:univer"]);
  assert.equal(out.receipts.length, 2, "两个技能必须各有回执（旧实现只留最后一条）");
  assert.deepEqual(out.receipts.map((row) => row.skill), ["univer", "office"], "顺序与请求一致");
  assert.equal(out.activation.skill, "office", "activation 兼容视图 = 最后一条");
  assert.ok(out.promoted.includes("univer_status") && out.promoted.includes("univer_api"), "聚合 promoted 必须含第一族：" + JSON.stringify(out.promoted));
  assert.ok(out.promoted.includes("office_render"), "聚合 promoted 必须含第二族：" + JSON.stringify(out.promoted));
  assert.equal(new Set(out.promoted).size, out.promoted.length, "promoted 必须去重");
  assert.equal(out.promotedTotal, 3, "promotedTotal 是聚合后的总数");
  // C46：每次激活派发的伪事件 id 必须不同（技能名 + 递增序号）；relay 回执只带派发统计，
  // id 从宿主实际收到的 tools/result 上看。
  const relayed = host.emitted.filter((row) => row.event === "tools/result" && row.args[0] && row.args[0].name === "skill");
  assert.equal(relayed.length, 2, "两个技能各派发一次激活事件");
  assert.notEqual(relayed[0].args[0].callId, relayed[1].args[0].callId, "两条激活事件 id 必须不同（C46）");
  assert.notEqual(relayed[0].args[0].callId, "gate-load-skill-univer", "id 必须带递增序号，不能是固定值");
  assert.match(relayed[0].args[0].callId, /-\d+$/);
  assert.match(out.skillText, /UNIVER BODY/);
  assert.match(out.skillText, /OFFICE BODY/);
  await gate.release(host.agent);
});

// ── 4b. P1-9：并发转发共享同一个窗口（先结束的不重设限制） ────────────────────
await check("P1-9：两个并发转发共享窗口，先结束的不把限制重设成全量 deny（慢工具全程不被 deny）", async () => {
  const { host, gate, agent } = makeRig();
  const pending = [];
  registerTool(host, "slow_tool", () => new Promise((resolve) => {
    pending.push(() => resolve({ content: [{ type: "text", text: "SLOW DONE" }] }));
  }), { delay: { type: "number" } });
  await gate.attach(agent);
  const restrictCalls = () => host.calls.filter((call) => call.kind === "restrict").length;
  const liftCalls = () => host.calls.filter((call) => call.kind === "lift").length;
  assert.equal(gate.restrictionState(agent).mode, "limited", "挂载后先限制住");
  const before = { restrict: restrictCalls(), lift: liftCalls() };
  const first = gate.callThrough(agent, "slow_tool", { delay: 1 });
  const second = gate.callThrough(agent, "slow_tool", { delay: 2 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pending.length, 2, "两个调用都必须真的在执行");
  assert.equal(gate.restrictionState(agent).mode, "none", "窗口内不限制（否则慢工具会被 deny）");
  assert.equal(host.visibleOf(agent).has("ssh_exec"), true, "窗口内隐藏工具也可见");
  // 先结束第一个：还有一个活跃租约，绝不允许把限制装回去。
  pending[0]();
  const firstValue = await first;
  assert.notEqual(firstValue.isError, true, "第一个调用正常完成");
  assert.match(firstValue.content[0].text, /SLOW DONE/);
  assert.equal(gate.restrictionState(agent).mode, "none", "先结束者不得重设限制（P1-9）");
  assert.equal(restrictCalls(), before.restrict, "窗口内不该有新 restrict");
  pending[1]();
  const secondValue = await second;
  assert.notEqual(secondValue.isError, true, "第二个调用正常完成");
  assert.equal(gate.restrictionState(agent).mode, "limited", "最后一个结束才恢复限制");
  assert.equal(restrictCalls(), before.restrict + 1, "只真施加一次（不是每个调用各一次）");
  assert.equal(liftCalls(), before.lift + 1, "只撤销一次");
  await gate.release(agent);
});

// ── 5. C36 / C37：卸载清理与热挂载 ──────────────────────────────────────────
await check("C36：释放 agent 后限制撤销、条目释放、重算不再安排任何东西", async () => {
  const { host, gate, agent } = makeRig();
  await gate.attach(agent);
  const before = host.calls.filter((call) => call.kind === "lift").length;
  await gate.release(agent);
  const after = host.calls.filter((call) => call.kind === "lift").length;
  assert.equal(after > before, true, "释放时必须真的撤销限制（不留悬空 deny）");
  assert.equal(gate.restrictionState(agent).mode, "none", "释放后状态回到 none");
  assert.equal(gate.reapplyAll(), 0, "条目已释放：重算一个都不碰");
  await gate.releaseAll();
});

await check("C37：热挂载时活跃 agent（含子代理）都建限制", async () => {
  // narrowPassThrough=0：关闭「窄子代理放行」豁免，只看挂载本身（豁免语义另有既有用例锁）。
  const { host, gate } = makeRig({ narrowPassThrough: 0 });
  // 宽工具面的子代理：窄子代理按既有策略走 passthrough（那是 0.5.x 的收窄豁免，不改）。
  const child = host.addAgent({ id: "agent-1-child", origin: "subagent", names: NAMES });
  await gate.attach(host.agent);
  await gate.attach(child);
  gate.reapplyAll();
  assert.equal(gate.restrictionState(host.agent).mode, "limited");
  assert.equal(gate.restrictionState(child).mode, "limited", "子代理也必须被挂上限制");
  assert.equal(gate.listAgents().length, 2);
  await gate.releaseAll();
});

// ── 6. C43 / C48：段落库存淘汰 ──────────────────────────────────────────────
await check("C43：段落库存超限只淘汰孤儿，被淘汰的名字报 evicted（不是 unknown），并进吞错计数", async () => {
  const { gate, agent } = makeRig({}, { sectionsLimit: 3 });
  await gate.attach(agent);
  const inventory = [50, 40, 30, 20, 10].map((chars, index) => ({
    name: "section-" + (index + 1),
    chars,
    tokens: chars,
    text: "TEXT " + (index + 1),
  }));
  gate.recordSections(agent, inventory);
  const evicted = await gate.load(agent, ["section:section-4", "section:section-5"]);
  assert.deepEqual(evicted.evicted.sort(), ["section:section-4", "section:section-5"], "被淘汰的名字必须报 evicted");
  assert.deepEqual(evicted.unknown, [], "名字是对的，不能报 unknown");
  const kept = await gate.load(agent, ["section:section-1"]);
  assert.deepEqual(kept.loaded, ["section:section-1"], "保留的段落照常可加载");
  const diagnostics = gate.snapshot(agent).diagnostics;
  assert.equal(diagnostics.swallowed.count >= 1, true, "淘汰必须进被吞异常计数（C48）");
  assert.equal(diagnostics.swallowed.samples.some((row) => row.where === "section-evicted"), true, "样本要标来源");
  await gate.release(agent);
});

// ── 7. C47：取消 ────────────────────────────────────────────────────────────
await check("C47：已取消的调用绝不执行（错误结果说明「未被执行」）", async () => {
  const { host, gate, agent } = makeRig();
  let ran = 0;
  registerTool(host, "side_effect_tool", async () => { ran += 1; return { content: [{ type: "text", text: "RAN" }] }; });
  await gate.attach(agent);
  const result = await gate.callThrough(agent, "side_effect_tool", {}, AbortSignal.abort());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /调用已取消/);
  assert.equal(ran, 0, "取消后一次都不许执行");
  await gate.release(agent);
});

await check("C47：批量失败后若已取消，绝不重试一次", async () => {
  const { host, gate, agent } = makeRig();
  await gate.attach(agent);
  failBatchTimes(1);
  let reads = 0;
  const signal = { get aborted() { reads += 1; return reads > 1; } };
  const result = await gate.callThrough(agent, "ssh_exec", {}, signal);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /调用已取消/);
  assert.match(result.content[0].text, /未重试|批量失败/);
  failBatchTimes(0);
  await gate.release(agent);
});

// ── 8. C40：一次转发只计一次 ────────────────────────────────────────────────
await check("C40 / P2-5：闸门工具族不进护栏计数；内层已计入的结果外层跳过", async () => {
  const { host, gate, policy, agent } = makeRig({ repeatGuard: { enabled: true } });
  policy.repeatGuard = { ...policy.repeatGuard, enabled: true };
  const dispose = mountRepeatGuard({ ctx: host.rootCtx, policy, logger: host.logger, managePreStep: false });
  resetRepeatGuardDiagnostics();
  await gate.attach(agent);

  // 外层：gate_call 本身是转发口，不计数。
  await host.postExecute(
    { callId: "c1", name: "gate_call", arguments: { name: "ssh_exec" }, agent },
    { isError: false, content: [{ type: "text", text: "ok" }] },
  );
  assert.equal(repeatGuardDiagnostics().counted, 0, "转发口本身不算一次重复劳动");
  assert.equal(repeatGuardDiagnostics().skippedFamily, 1);

  // 内层已计入（COUNTED_MARK）⇒ 外层不再记账、不推进时钟。
  const marked = { isError: false, content: [{ type: "text", text: "ok" }] };
  Object.defineProperty(marked, COUNTED_MARK, { value: true, enumerable: false });
  await host.postExecute({ callId: "c2", name: "ssh_exec", arguments: {}, agent }, marked);
  assert.equal(repeatGuardDiagnostics().counted, 0, "内层已计入的结果必须跳过");
  assert.equal(repeatGuardDiagnostics().skippedInner, 1);

  // 真正的内层执行只计一次。
  await host.postExecute({ callId: "c3", name: "ssh_exec", arguments: {}, agent }, { isError: false, content: [{ type: "text", text: "ok" }] });
  assert.equal(repeatGuardDiagnostics().counted, 1);
  dispose();
  await gate.release(agent);
});

const failed = results.filter((entry) => !entry.ok);
for (const entry of results) console.log((entry.ok ? "  ok    " : "  FAIL  ") + entry.label + (entry.ok ? "" : "  →  " + entry.error));
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exitCode = failed.length === 0 ? 0 : 1;
