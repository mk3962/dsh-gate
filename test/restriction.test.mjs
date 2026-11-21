/**
 * 限制所有权（票 02）用例。
 *
 * 核心回归：重算是幂等的 —— 目标形状没变就一次都不该动限制；
 * 收窄豁免分支以前只写键不写句柄，导致短路恒假、每次都重进 applying，
 * tools/change 被自己吞掉、白算一轮。
 *
 * 宿主来自共享 seam（test/host.mjs）。跑法：node test/restriction.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGate } from "../lib/gate.js";
import { resolvePolicy } from "../lib/policy.js";
import { createRestriction, MODE_LIMITED, MODE_NONE, MODE_PASSTHROUGH } from "../lib/restriction.js";
import { makeHost } from "./host.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-restriction-"));

const BASICS = ["read", "write", "edit", "grep", "glob", "pwsh"];
// 10 个按需工具：宽 agent 的授予数（16）要稳稳超过豁免阈值 12，窄 agent 的（2~3）要稳稳低于。
const ONDEMAND = [
  "mnemon_status", "mnemon_recall", "mnemon_remember", "univer_new", "univer_status",
  "ppt_create", "word_create", "excel_create", "office_docx", "video_search",
];
const ALL = [...BASICS, ...ONDEMAND];

const policyOf = (raw = {}) =>
  resolvePolicy(
    {
      tools: {
        defaultTier: 2,
        overrides: { read: 1, write: 1, edit: 1, grep: 1, glob: 1, pwsh: 1 },
      },
      sections: { defaultTier: 1 },
      ...raw,
    },
    { logger: undefined, dshHome: policyDir },
  );

/** 建 gate 并挂一个 agent，等它就绪（ready 里已经跑过一次 reapply）。 */
async function setup(spec, raw) {
  const host = makeHost({ names: ALL, id: spec.id });
  const agent = Object.assign(host.agent, { names: spec.names || ALL, own: spec.own || [] });
  if (spec.origin !== undefined) agent.session = { header: { origin: spec.origin } };
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy: policyOf(raw) });
  await gate.attach(agent);
  const counts = () => ({
    restrict: host.calls.filter((call) => call.kind === "restrict").length,
    lift: host.calls.filter((call) => call.kind === "lift").length,
  });
  // 限制状态只从公开面读：gate.restrictionState()，不摸内部条目。
  const state = () => gate.restrictionState(agent);
  return { host, agent, gate, state, counts };
}

const results = [];
const check = async (label, fn) => {
  try { await fn(); results.push({ ok: true, label }); }
  catch (error) { results.push({ ok: false, label, error: String((error && error.message) || error) }); }
};

await check("主会话初次挂载后处于 limited，且只真限制了一次", async () => {
  const { state, counts, gate, agent } = await setup({ id: "s1" });
  assert.equal(state().mode, MODE_LIMITED);
  assert.equal(state().count > 0, true);
  assert.deepEqual(counts(), { restrict: 1, lift: 0 });
  await gate.release(agent);
});

await check("同一目标连续重算三次：第二次起不产生新的 restrict / lift 调用", async () => {
  const { state, counts, gate, agent } = await setup({ id: "s2" });
  const first = counts();
  gate.reapply(agent);
  const second = counts();
  gate.reapply(agent);
  gate.reapply(agent);
  const fourth = counts();
  assert.deepEqual(second, first, "第二次重算不该动限制");
  assert.deepEqual(fourth, first, "第三次、第四次也不该动限制");
  assert.equal(state().mode, MODE_LIMITED);
  await gate.release(agent);
});

await check("isApplying 在静止时为 false（不会因重算而抖动）", async () => {
  const { gate, agent } = await setup({ id: "s3" });
  gate.reapply(agent);
  assert.equal(gate.isApplying(), false);
  await gate.release(agent);
});

await check("收窄豁免模式下重复重算：不进入 applying，不重复 restrict", async () => {
  // 白名单只有几个 mnemon 工具的子代理 —— 事故形态。
  const { state, counts, gate, agent } = await setup({
    id: "child-narrow",
    origin: "subagent",
    names: ["mnemon_status", "mnemon_recall", "mnemon_remember"],
    own: ["subagent"],
  });
  assert.equal(state().mode, MODE_PASSTHROUGH);
  assert.deepEqual(counts(), { restrict: 0, lift: 0 }, "豁免就是一次都不该 restrict");
  gate.reapply(agent);
  gate.reapply(agent);
  gate.reapply(agent);
  assert.deepEqual(counts(), { restrict: 0, lift: 0 }, "重算不该触发 restrict");
  assert.equal(gate.isApplying(), false, "重算不该把自己标成 applying");
  await gate.release(agent);
});

await check("目标从「已限制」变「空」时，撤销恰好发生一次", async () => {
  const { state, counts, gate, agent, host } = await setup({ id: "s4" });
  assert.deepEqual(counts(), { restrict: 1, lift: 0 });
  // 把工具面缩到只剩常驻工具 ⇒ deny 变空 ⇒ 该撤销。
  agent.names = ["read", "write"];
  Object.assign(agent, { own: [] });
  gate.reapply(agent);
  assert.equal(state().mode, MODE_NONE);
  assert.equal(state().key, undefined, "空目标不该留下键");
  assert.deepEqual(counts(), { restrict: 1, lift: 1 });
  gate.reapply(agent);
  gate.reapply(agent);
  assert.deepEqual(counts(), { restrict: 1, lift: 1 }, "撤销过就不该再撤一次");
  assert.equal(host.restrictionsFor(agent).length, 0, "限制列表必须真的空了");
  await gate.release(agent);
});

await check("切换到豁免模式时旧的撤销句柄与键都被清空，不留残影", async () => {
  const { state, counts, gate, agent, host } = await setup({
    id: "child-wide",
    origin: "subagent",
    names: ALL,
    own: ["subagent"],
  });
  assert.equal(state().mode, MODE_LIMITED);
  assert.equal(host.restrictionsFor(agent).length, 1);
  // 工具面收窄到白名单形态 ⇒ 下一轮变成豁免 ⇒ 必须先把旧限制撤掉。
  agent.names = ["mnemon_status", "mnemon_recall"];
  gate.reapply(agent);
  const after = state();
  assert.equal(after.mode, MODE_PASSTHROUGH);
  assert.equal(after.key, undefined, "豁免态不该留键");
  assert.equal(after.count, 0);
  assert.deepEqual(counts(), { restrict: 1, lift: 1 }, "旧的限制必须被撤销一次");
  assert.equal(host.restrictionsFor(agent).length, 0, "宿主侧限制必须真的撤掉");
  gate.reapply(agent);
  assert.deepEqual(counts(), { restrict: 1, lift: 1 }, "再重算不该重复动作");
  await gate.release(agent);
});

await check("撤销语义不变：先真的缩小限制，再清句柄", async () => {
  const { state, gate, agent, host } = await setup({ id: "s5" });
  const before = state();
  assert.equal(before.count > 0, true);
  // 撤销是 release 的一部分：agent 释放后不该有残留限制。
  await gate.release(agent);
  assert.equal(state().mode, MODE_NONE);
  assert.equal(host.restrictionsFor(agent).length, 0, "释放后宿主侧限制必须真的撤掉");
});

await check("gate 主体不再直接比较键与句柄", () => {
  const source = fs.readFileSync(path.join(here, "..", "lib", "gate.js"), "utf8");
  for (const field of ["entry.denyKey", "entry.lift", "entry.denyCount", "entry.applying", "entry.passthrough"]) {
    assert.equal(source.includes(field), false, "gate.js 里还残留直接操作 " + field);
  }
});

await check("豁免阈值不变：narrowPassThrough=0 时窄子代理照旧受限", async () => {
  const { state, counts, gate, agent } = await setup(
    { id: "child-narrow-2", origin: "subagent", names: ["mnemon_status", "mnemon_recall"], own: [] },
    { narrowPassThrough: 0 },
  );
  assert.equal(state().mode, MODE_LIMITED);
  assert.equal(counts().restrict, 1);
  await gate.release(agent);
});

await check("宽工具面子代理仍受限（豁免不白送）", async () => {
  const { state, gate, agent } = await setup({ id: "child-wide-2", origin: "subagent", names: ALL, own: ["subagent"] });
  assert.equal(state().mode, MODE_LIMITED);
  await gate.release(agent);
});

await check("建立限制失败时退回未限制，而不是留下一个假的 limited 态（否则会被幂等短路永久挡住）", async () => {
  // 直接打限制对象这个 seam：真实里 restrict() 会因 scoped tools 未就绪 / 点名被拒而抛。
  let attempts = 0;
  const restriction = createRestriction({
    restrict() { attempts += 1; throw new Error("host refused restrict"); },
    logger: undefined,
  });
  restriction.apply({ mode: MODE_LIMITED, deny: ["univer_sheet"] });
  const after = restriction.state();
  assert.equal(after.mode, MODE_NONE, "restrict 抛错后必须退回未限制，而不是假装限制着");
  assert.equal(after.count, 0);
  assert.equal(after.key, undefined);
  // 关键后果：下一次同样的目标必须**再试一次**，不能被幂等短路吃掉。
  restriction.apply({ mode: MODE_LIMITED, deny: ["univer_sheet"] });
  assert.equal(attempts, 2, "同样的目标在失败后必须重试，而不是永久跳过");
  assert.equal(restriction.isApplying(), false, "失败路径也必须把 applying 复位");
});

await check("没有施加手段时不假装限制着（否则同样被幂等短路挡住）", async () => {
  const restriction = createRestriction({ logger: undefined });
  restriction.apply({ mode: MODE_LIMITED, deny: ["univer_doc"] });
  assert.equal(restriction.state().mode, MODE_NONE, "没有 restrict 回调就不能报成 limited");
  assert.equal(restriction.state().count, 0);
});

// ── C30（D8）：租约状态机 —— 引用计数 / 待生效目标 / 幂等释放令牌 ──────────────
/** 直接打限制对象这个 seam 的假宿主：记下真正施加了哪些 deny 集。 */
const makeLeaseHost = () => {
  const applied = [];
  const state = { current: undefined };
  const restriction = createRestriction({
    restrict(filter) {
      applied.push(filter.deny.slice());
      state.current = filter.deny.slice();
      return () => { state.current = undefined; };
    },
    logger: undefined,
  });
  return { restriction, applied, current: () => state.current };
};

await check("C30：两个并发租约 —— 第一个结束不落地，最后一个结束才施加最新目标", async () => {
  const { restriction, applied } = makeLeaseHost();
  restriction.apply({ mode: MODE_LIMITED, deny: ["read"] });
  assert.deepEqual(applied, [["read"]], "无租约时立刻施加");
  const first = restriction.acquireLease();
  const second = restriction.acquireLease();
  assert.equal(restriction.leases(), 2, "引用计数 = 2");
  // 窗口内重算：只登记，不施加（正在跑的慢工具不会被 deny 掉）。
  restriction.apply({ mode: MODE_LIMITED, deny: ["read", "write"] });
  restriction.apply({ mode: MODE_LIMITED, deny: ["pwsh"] });
  assert.equal(applied.length, 1, "窗口内一次都不许施加（C30/C31）");
  assert.equal(restriction.leases(), 2);
  first();
  assert.equal(restriction.leases(), 1, "先结束的只减计数");
  assert.equal(applied.length, 1, "不是最后一个就不落地");
  second();
  assert.equal(restriction.leases(), 0);
  assert.deepEqual(applied, [["read"], ["pwsh"]], "最后一个释放时才落地**最新**目标");
  // 幂等：重复释放同一个令牌不再减计数，也不会再次施加。
  first();
  second();
  assert.equal(restriction.leases(), 0);
  assert.equal(applied.length, 2, "重复释放不重复施加");
});

await check("C30：0→1 撤销当前限制并记住被撤销目标，1→0 恢复它", async () => {
  const { restriction, applied, current } = makeLeaseHost();
  restriction.apply({ mode: MODE_LIMITED, deny: ["read", "write"] });
  assert.deepEqual(current(), ["read", "write"]);
  const token = restriction.acquireLease();
  assert.equal(current(), undefined, "进入窗口先撤销当前限制（慢工具不被 deny）");
  assert.equal(restriction.state().mode, MODE_NONE);
  assert.deepEqual(restriction.state().revoked.deny, ["read", "write"], "被撤销目标要记住");
  token();
  assert.deepEqual(applied, [["read", "write"], ["read", "write"]], "没有 pending 时恢复被撤销目标");
  assert.equal(restriction.state().windowOpen, false);
});

await check("C30：非撤销句柄不记账、退回 none 并记诊断，同样目标必须能重试", async () => {
  let calls = 0;
  const restriction = createRestriction({ restrict() { calls += 1; return undefined; }, logger: undefined });
  restriction.apply({ mode: MODE_LIMITED, deny: ["univer_sheet"] });
  assert.equal(restriction.state().mode, MODE_NONE, "非撤销句柄不能报成 limited");
  assert.equal(restriction.state().count, 0);
  assert.ok(restriction.diagnostics().some((row) => row.code === "restrict-no-handle"), "必须记 restrict-no-handle");
  restriction.apply({ mode: MODE_LIMITED, deny: ["univer_sheet"] });
  assert.equal(calls, 2, "同样的目标在没句柄后必须再试一次（不能被幂等短路）");
});

await check("C30：受保护名永不进 deny（也不会被撤销）", async () => {
  const applied = [];
  const restriction = createRestriction({
    restrict(filter) { applied.push(filter.deny.slice()); return () => {}; },
    protectedNames: ["tools:sdk"],
    logger: undefined,
  });
  restriction.apply({ mode: MODE_LIMITED, deny: ["read", "tools:sdk", "write"] });
  assert.deepEqual(applied, [["read", "write"]], "受保护名必须被剔除");
  assert.deepEqual(restriction.state().deny, ["read", "write"]);
});

await check("C30：窗口开/关信号每次只发一次，卸载 destroy 清租约", async () => {
  const { restriction } = makeLeaseHost();
  let opens = 0;
  let closes = 0;
  restriction.onWindowOpen(() => { opens += 1; });
  restriction.onWindowClose(() => { closes += 1; });
  const a = restriction.acquireLease();
  restriction.acquireLease();
  assert.equal(opens, 1, "0→1 才发开信号");
  a();
  restriction.release === undefined; // 公开面没有裸 release：令牌才是释放口
  assert.equal(closes, 0, "不是最后一个不发关信号");
  restriction.destroy();
  assert.equal(restriction.leases(), 0, "destroy 清租约");
  assert.equal(restriction.state().windowOpen, false);
});

await check("P0 重入回归：acquireLease 撤销句柄同步重入 apply 时不重挂限制、不泄漏句柄", async () => {
  // 模拟真实宿主（DSH 0.2.2-rc.1）：disposer 与 restrict() 同步派发 tools/change → 重入 apply()。
  let activeHandles = 0;
  let reentryCount = 0;
  let applyingDuringLift = false;
  let leasesDuringLift = -1;
  let windowOpenDuringLift = false;
  let restriction;
  restriction = createRestriction({
    restrict(filter) {
      activeHandles += 1;
      let released = false;
      const snapshotDeny = filter.deny.slice();
      // restrict() 同步触发 tools/change 重入
      reentryCount += 1;
      restriction.apply({ mode: MODE_LIMITED, deny: snapshotDeny });
      return () => {
        if (released) return;
        released = true;
        activeHandles -= 1;
        applyingDuringLift = restriction.isApplying();
        leasesDuringLift = restriction.leases();
        windowOpenDuringLift = restriction.isWindowOpen();
        // disposer 同步触发 tools/change 重入（即使外部没有 isApplying 守卫）
        reentryCount += 1;
        restriction.apply({ mode: MODE_LIMITED, deny: snapshotDeny });
      };
    },
    logger: undefined,
  });

  restriction.apply({ mode: MODE_LIMITED, deny: ["ssh_exec", "univer_sheet"] });
  assert.equal(activeHandles, 1, "初次限制后宿主侧恰有 1 个活句柄");
  assert.equal(restriction.state().mode, MODE_LIMITED);

  // 连续两次 suspend：窗口内不得有活句柄，释放后恢复为 1 个活句柄。
  for (let round = 0; round < 2; round += 1) {
    await restriction.suspend(async () => {
      assert.equal(applyingDuringLift, true, "撤旧句柄期间 isApplying() 必须为 true");
      assert.equal(leasesDuringLift, 1, "撤旧句柄前 leases 必须先递增为 1");
      assert.equal(windowOpenDuringLift, true, "撤旧句柄前 windowOpen 必须已打开");
      assert.equal(activeHandles, 0, "转发窗口内宿主侧不得残留或重挂 restriction 句柄");
      assert.equal(restriction.state().mode, MODE_NONE);
    });
    assert.equal(activeHandles, 1, "第 " + (round + 1) + " 次窗口关闭后必须恢复且仅恢复 1 个句柄");
    assert.equal(restriction.state().mode, MODE_LIMITED);
    assert.deepEqual(restriction.state().deny, ["ssh_exec", "univer_sheet"]);
    assert.equal(restriction.isApplying(), false);
  }
  assert.equal(reentryCount > 0, true, "必须真的触发过同步重入");

  restriction.destroy();
  assert.equal(activeHandles, 0, "destroy 后不得残留活句柄");
  assert.equal(restriction.isApplying(), false);
});

await check("P0 重入回归：applyNow / destroy 中 disposer 或 restrict 同步重入均无句柄泄漏", async () => {
  let activeHandles = 0;
  let hijackOnce = true;
  let restriction;
  restriction = createRestriction({
    restrict(filter) {
      activeHandles += 1;
      let released = false;
      const dispose = () => {
        if (released) return;
        released = true;
        activeHandles -= 1;
      };
      // 模拟在 restrict() 返回前同步重入 acquireLease：刚建的句柄已过时，必须立即释放。
      if (hijackOnce && filter.deny.includes("univer_doc")) {
        hijackOnce = false;
        const lease = restriction.acquireLease();
        assert.equal(restriction.leases(), 1);
        // 租约保持打开直到外层 applyNow 返回后手动释放
        restriction._hijackLease = lease;
      }
      return dispose;
    },
    logger: undefined,
  });

  restriction.apply({ mode: MODE_LIMITED, deny: ["ssh_exec"] });
  assert.equal(activeHandles, 1);

  // 切换目标时 restrict() 内部打开了租约：外层拿到的过时句柄必须被立即撤销，不能泄漏。
  restriction.apply({ mode: MODE_LIMITED, deny: ["univer_doc"] });
  assert.equal(activeHandles, 0, "restrict() 期间被同步重入开租约时，过时句柄必须立即释放");
  assert.equal(restriction.leases(), 1);
  assert.equal(restriction.isApplying(), false);

  // 释放租约后恢复，再 destroy：活句柄归零。
  restriction._hijackLease();
  assert.equal(restriction.leases(), 0);
  restriction.destroy();
  assert.equal(activeHandles, 0, "destroy 后活句柄必须归零");
  assert.equal(restriction.isApplying(), false);
});

const failed = results.filter((entry) => !entry.ok);
for (const entry of results) console.log((entry.ok ? "  ok    " : "  FAIL  ") + entry.label + (entry.ok ? "" : "  →  " + entry.error));
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exitCode = failed.length === 0 ? 0 : 1;