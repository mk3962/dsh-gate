/**
 * D14：所有「只有宿主知道」的读取都走这一层。
 * 本测试用假宿主锁定三件事：能力探测只一次、读不到不抛错、派发隔离且不吞监听者。
 */
import assert from "node:assert/strict";
import {
  NATIVE_EXECUTOR_CLASS,
  PTC_EXECUTOR_CLASS,
  RUN_CODE_TOOL_NAME,
  createHostAdapter,
} from "../lib/host-adapter.js";

const results = [];
const check = (label, fn) => {
  try { fn(); results.push({ ok: true, label }); }
  catch (error) { results.push({ ok: false, label, error }); }
};

function logger() {
  const lines = [];
  return { lines, warn: (text) => lines.push(String(text)) };
}

class PtcExecutor { constructor() { this.constructorTag = PTC_EXECUTOR_CLASS; } }
class NativeToolExecutor { constructor() { this.constructorTag = NATIVE_EXECUTOR_CLASS; } }
class MysteryExecutor {}

function fakeCtx(overrides) {
  return Object.assign({
    get: () => undefined,
    tools: undefined,
    loader: undefined,
    events: undefined,
  }, overrides || {});
}

check("能力探测只一次：成功与失败都缓存，缺能力告警一次", () => {
  let calls = 0;
  const ctx = fakeCtx({
    get: (name) => {
      calls += 1;
      return name === "tools" ? { view: () => ({ knownNames: new Set(["read"]) }) } : undefined;
    },
  });
  const log = logger();
  const adapter = createHostAdapter(ctx, { logger: log });
  assert.equal(adapter.has("tools"), true);
  assert.equal(adapter.has("tools"), true);
  assert.equal(adapter.has("tools"), true);
  assert.equal(calls, 1, "第二次起读缓存");
  assert.equal(adapter.has("agentPresets", "acquireScope"), false);
  assert.equal(adapter.has("agentPresets", "acquireScope"), false);
  assert.equal(adapter.probeSize(), 2);
  assert.equal(log.lines.length, 1, "缺能力只告警一次");
  assert.match(log.lines[0], /agentPresets\.acquireScope/);
});

check("工具视图两条读法：ctx.get('tools') 优先，ctx.tools 兜底", () => {
  const viaGet = createHostAdapter(fakeCtx({
    get: () => ({ view: () => ({ knownNames: new Set(["read", "pwsh"]), visible: new Map([["read", {}]]) }) }),
  }));
  assert.deepEqual([...viaGet.knownNames(undefined)].sort(), ["pwsh", "read"]);
  assert.deepEqual([...viaGet.visibleNames(undefined)], ["read"]);

  const viaCtx = createHostAdapter(fakeCtx({
    tools: { view: () => ({ knownNames: new Set(["todo_write"]), visible: new Set(["todo_write"]) }) },
  }));
  assert.deepEqual([...viaCtx.knownNames(undefined)], ["todo_write"]);
  assert.deepEqual([...viaCtx.visibleNames(undefined)], ["todo_write"], "可迭代集合也认");

  const broken = createHostAdapter(fakeCtx({ tools: { view: () => { throw new Error("宿主形状变了"); } } }));
  assert.equal(broken.toolView(undefined), undefined, "读不到返回 undefined，绝不抛错");
  assert.equal(broken.knownNames(undefined), undefined);
});

check("执行器三路：类名优先 → describe().schemas → 判不出就 unknown", () => {
  const make = (executor) => createHostAdapter(fakeCtx({
    tools: { selectExecutor: () => executor },
  }));
  assert.deepEqual(make(new PtcExecutor()).detectExecutor(undefined), { kind: "ptc", reason: "constructor" });
  assert.deepEqual(make(new NativeToolExecutor()).detectExecutor(undefined), { kind: "native", reason: "constructor" });

  const bySchemas = make({ describe: () => ({ schemas: [{ name: RUN_CODE_TOOL_NAME }] }) });
  assert.deepEqual(bySchemas.detectExecutor(undefined), { kind: "ptc", reason: "schemas" });
  const manySchemas = make({ describe: () => ({ schemas: [{ name: "read" }, { name: "write" }] }) });
  assert.deepEqual(manySchemas.detectExecutor(undefined), { kind: "native", reason: "schemas" });

  assert.deepEqual(make(undefined).detectExecutor(undefined), { kind: "unknown", reason: "no-executor" });
  assert.deepEqual(make(new MysteryExecutor()).detectExecutor(undefined), { kind: "unknown", reason: "unrecognized-executor" });
  const throwing = make({ describe: () => { throw new Error("describe 炸了"); } });
  assert.deepEqual(throwing.detectExecutor(undefined), { kind: "unknown", reason: "unrecognized-executor" });
});

check("隔离派发：一个监听者抛错不影响其余，回执计数准确", () => {
  const seen = [];
  const ctx = fakeCtx({
    events: {
      dispatch: (channel, args) => {
        assert.equal(channel, "emit");
        assert.deepEqual(args, ["tools/result", { ok: true }]);
        return [
          (payload) => seen.push("a:" + JSON.stringify(payload)),
          () => { throw new Error("监听者炸了"); },
          (payload) => seen.push("c:" + JSON.stringify(payload)),
        ];
      },
    },
  });
  const info = createHostAdapter(ctx).dispatchIsolated("tools/result", [{ ok: true }]);
  assert.equal(info.mode, "isolated");
  assert.equal(info.listeners, 3);
  assert.equal(info.delivered, 2);
  assert.equal(info.failed.length, 1);
  assert.match(info.failed[0], /监听者炸了/);
  assert.deepEqual(seen, ["a:{\"ok\":true}", "c:{\"ok\":true}"], "后面的监听者照常收到");
});

check("隔离派发兜底：没有 per-listener 通道时退回 ctx.emit，两条都没有就 none", () => {
  const emitted = [];
  const viaEmit = createHostAdapter(fakeCtx({ emit: (event, ...args) => emitted.push([event, ...args]) }));
  const info = viaEmit.dispatchIsolated("tools/result", ["r"]);
  assert.equal(info.mode, "emit");
  assert.equal(info.delivered, 1);
  assert.deepEqual(emitted, [["tools/result", "r"]]);

  const none = createHostAdapter(fakeCtx({})).dispatchIsolated("tools/result", []);
  assert.deepEqual(none, { mode: "none", listeners: 0, delivered: 0, failed: [] });
});

check("确定性用户消息与子代理判定", () => {
  const adapter = createHostAdapter(fakeCtx({}));
  const first = adapter.userMessage("请确认", "gate");
  const second = adapter.userMessage("请确认", "gate");
  assert.deepEqual(first, second, "同一份输入永远同一份消息");
  assert.deepEqual(first, { role: "user", content: [{ type: "text", text: "请确认" }], source: "gate" });
  assert.equal("id" in first, false);
  assert.equal("timestamp" in first, false);
  assert.deepEqual(adapter.userMessage(undefined), { role: "user", content: [{ type: "text", text: "" }] });

  assert.equal(adapter.isSubagent({ parent: {} }), true);
  assert.equal(adapter.isSubagent({}), false);
  assert.equal(adapter.isSubagent(undefined), false);
});

check("loader 条目：生成器/数组都认，缺服务当空表；preset 租约缺能力返回 undefined", async () => {
  const gen = createHostAdapter(fakeCtx({ loader: { entries: function* () { yield { name: "a" }; yield { name: "b" }; } } }));
  assert.deepEqual(gen.loaderEntries(), [{ name: "a" }, { name: "b" }]);
  const arr = createHostAdapter(fakeCtx({ loader: { entries: () => [{ name: "c" }] } }));
  assert.deepEqual(arr.loaderEntries(), [{ name: "c" }]);
  assert.deepEqual(createHostAdapter(fakeCtx({})).loaderEntries(), []);

  assert.equal(await createHostAdapter(fakeCtx({})).acquirePresetScope("default"), undefined);
  const scope = { preset: "default" };
  const withPreset = createHostAdapter(fakeCtx({
    get: (name) => (name === "agentPresets" ? { acquireScope: async () => scope } : undefined),
  }));
  assert.equal(await withPreset.acquirePresetScope("default"), scope);
});

console.log("");
for (const row of results) {
  if (row.ok) console.log("  ok    " + row.label);
  else { console.log("  FAIL  " + row.label + "  →  " + (row.error && row.error.message ? row.error.message : row.error)); process.exitCode = 1; }
}
const failed = results.filter((row) => row.ok === false).length;
console.log("");
console.log((results.length - failed) + "/" + results.length + " passed");
