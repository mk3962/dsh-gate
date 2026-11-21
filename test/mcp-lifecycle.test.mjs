/**
 * D16：MCP 生命周期。锁六件事：预检一份错误码、同名单飞、loader 同名冲突与接管、
 * 更新事务回滚、断连相位、Set-like 注册名读取。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MCP_PHASES,
  createMcpManager,
  preflightServerConfig,
} from "../lib/mcp.js";

const results = [];
const check = async (label, fn) => {
  try { await fn(); results.push({ ok: true, label }); }
  catch (error) { results.push({ ok: false, label, error }); }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gate-mcp-"));
const logs = () => {
  const lines = [];
  return { lines, warn: (text) => lines.push(String(text)), info: (text) => lines.push(String(text)) };
};

/** 假宿主：一个可变的 knownNames 集合 + 可编程的 loader/plugin。 */
function fakeHost(options) {
  const opts = options || {};
  const known = opts.known || new Set();
  const clearPrefix = (prefix) => { for (const name of [...known]) if (name.startsWith(prefix)) known.delete(name); };
  const disposed = [];
  const mounted = [];
  const host = {
    known,
    disposed,
    mounted,
    ctx: {
      tools: {
        view: (scope) => (opts.view ? opts.view(scope, known) : { knownNames: known, visible: new Map([...known].map((name) => [name, {}])) }),
      },
      loader: {
        entries: () => (opts.loaderRows ? opts.loaderRows() : []),
        import: async () => ({
          apply(config) { return () => undefined; },
        }),
      },
      plugin(plugin, config) {
        mounted.push(config);
        if (config.command === "boom") {
          return {
            then(_resolve, reject) { setTimeout(() => reject(new Error("启动炸了")), 5); },
            dispose() { clearPrefix("mcp__" + config.serverName + "__"); disposed.push(config.command); },
          };
        }
        return {
          then(resolve) {
            setTimeout(() => {
              const prefix = "mcp__" + config.serverName + "__";
              const dispose = () => {
                for (const name of [...known]) if (name.startsWith(prefix)) known.delete(name);
                disposed.push(config.command);
              };
              const teardown = plugin.apply(config);
              known.add(prefix + "echo");
              resolve();
              host.teardown = teardown || dispose;
            }, 5);
          },
          dispose() { clearPrefix("mcp__" + config.serverName + "__"); disposed.push(config.command); },
        };
      },
    },
  };
  return host;
}
const stdio = (command) => ({ transport: "stdio", command: command || "node", args: ["server.js"] });

await check("预检一份错误码：URL 协议 / 空 command / cwd 不可读 / env 非字符串表", () => {
  assert.equal(preflightServerConfig("srv", { transport: "streamable-http", url: "ftp://x" }).code, "invalid-url");
  assert.equal(preflightServerConfig("srv", { transport: "streamable-http", url: "https://x/sse" }).ok, true);
  assert.equal(preflightServerConfig("srv", { transport: "stdio", command: "   " }).code, "missing-command");
  const missing = path.join(tmp(), "nope");
  assert.equal(preflightServerConfig("srv", { transport: "stdio", command: "node", cwd: missing }).code, "cwd-unreadable");
  assert.equal(preflightServerConfig("srv", { transport: "stdio", command: "node", cwd: tmp() }).ok, true);
  assert.equal(preflightServerConfig("srv", { transport: "stdio", command: "node", env: { A: 1 } }).code, "invalid-env");
  assert.equal(preflightServerConfig("bad name!", stdio()).code, "invalid-server-name");
});

await check("同名单飞：第一个还在挂载时第二个立刻撞 conflict/mounting", async () => {
  const host = fakeHost();
  const manager = createMcpManager({ ctx: host.ctx, logger: logs() });
  const first = manager.mount("srv", stdio());
  const second = await manager.mount("srv", stdio());
  assert.equal(second.ok, false);
  assert.equal(second.reason, "conflict");
  assert.equal(second.detail, "mounting");
  const done = await first;
  assert.equal(done.ok, true);
  assert.equal(done.state, "owned");
  assert.equal(manager.phase("srv"), MCP_PHASES.RUNNING);
});

await check("loader 同名：启用 → 拒绝（detail loader）；禁用 → 接管并告警一次", async () => {
  const loaderRow = (disabled) => ({
    options: { name: "@deepseek-ai/dsh-mcp-client", disabled, config: { transport: "stdio", serverName: "srv", command: "node" } },
  });
  const enabledHost = fakeHost({ loaderRows: () => [loaderRow(false)] });
  const enabled = createMcpManager({ ctx: enabledHost.ctx, logger: logs() });
  const refused = await enabled.mount("srv", stdio());
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "conflict");
  assert.equal(refused.detail, "loader");

  const log = logs();
  const disabledHost = fakeHost({ loaderRows: () => [loaderRow(true)] });
  const takeover = createMcpManager({ ctx: disabledHost.ctx, logger: log });
  const mounted = await takeover.mount("srv", stdio());
  assert.equal(mounted.ok, true, "loader 行已禁用时 gate 接管");
  assert.ok(log.lines.some((line) => line.includes("loader-row-disabled")), "接管必须留一条告警");
  assert.equal(disabledHost.mounted.length, 1);
});

await check("更新失败按旧配置回滚：旧实例仍在，回执标 rolledBack", async () => {
  const host = fakeHost();
  const manager = createMcpManager({ ctx: host.ctx, logger: logs() });
  const first = await manager.mount("srv", stdio("ok-1"));
  assert.equal(first.ok, true);
  const updated = await manager.update("srv", stdio("boom"));
  assert.equal(updated.ok, false);
  assert.equal(updated.reason, "startup");
  assert.equal(updated.rolledBack, true);
  assert.deepEqual(manager.list().map((row) => row.target), ["ok-1"], "旧配置的 command 仍在岗");
  assert.equal(host.mounted.at(-1).command, "ok-1", "回滚用的就是之前保存的旧配置");
  assert.equal(manager.state("srv"), "owned", "回滚后旧实例继续在岗");
  assert.equal(host.known.has("mcp__srv__echo"), true);
});

await check("更新非法配置：旧实例一动不动（不卸载、不重挂）", async () => {
  const host = fakeHost();
  const manager = createMcpManager({ ctx: host.ctx, logger: logs() });
  await manager.mount("srv", stdio("ok"));
  const before = host.mounted.length;
  const updated = await manager.update("srv", { transport: "stdio", command: "" });
  assert.equal(updated.ok, false);
  assert.equal(updated.reason, "invalid");
  assert.equal(updated.code, "missing-command");
  assert.equal(host.mounted.length, before, "非法配置不触发任何挂载");
  assert.equal(manager.state("srv"), "owned");
});

await check("断连：运行中工具归零 → 相位 disconnected，恢复后清旧告警", async () => {
  const host = fakeHost();
  const manager = createMcpManager({ ctx: host.ctx, logger: logs() });
  await manager.mount("srv", stdio("ok"));
  host.known.delete("mcp__srv__echo");
  assert.equal(manager.list()[0].toolCount, 0);
  assert.equal(manager.phase("srv"), MCP_PHASES.DISCONNECTED);
  host.known.add("mcp__srv__echo");
  assert.equal(manager.list()[0].toolCount, 1);
  assert.equal(manager.phase("srv"), MCP_PHASES.RUNNING);
  assert.equal(manager.lifecycle("srv").detail.includes("tools="), true);
});

await check("Set-like 注册名：有 has + 迭代器但不是原生 Set 也能计数", async () => {
  const known = new Set();
  const setLike = {
    has: (name) => known.has(name),
    [Symbol.iterator]: () => known.values(),
  };
  const host = fakeHost({ known, view: () => ({ knownNames: setLike, visible: new Map() }) });
  const log = logs();
  const manager = createMcpManager({ ctx: host.ctx, logger: log });
  const mounted = await manager.mount("srv", stdio("ok"));
  assert.equal(mounted.toolCount, 1, "Set-like 注册名被认出来");
  assert.ok(log.lines.every((line) => !line.includes("knownNames")), "不应退化到可见名告警");
});

await check("相位生命周期：未挂 idle → 挂载失败 failed → 卸载后 idle", async () => {
  const host = fakeHost();
  const manager = createMcpManager({ ctx: host.ctx, logger: logs() });
  assert.equal(manager.phase("srv"), MCP_PHASES.IDLE);
  const failed = await manager.mount("srv", { transport: "stdio", command: "" });
  assert.equal(failed.ok, false);
  assert.equal(manager.phase("srv"), MCP_PHASES.FAILED);
  const ok = await manager.mount("ok", stdio());
  assert.equal(ok.ok, true);
  const removed = await manager.unmount("ok");
  assert.equal(removed.ok, true);
  assert.equal(manager.phase("ok"), MCP_PHASES.IDLE);
  assert.equal(manager.list().length, 0);
});

console.log("");
for (const row of results) {
  if (row.ok) console.log("  ok    " + row.label);
  else { console.log("  FAIL  " + row.label + "  →  " + (row.error && row.error.message ? row.error.message : row.error)); process.exitCode = 1; }
}
const failed = results.filter((row) => row.ok === false).length;
console.log("");
console.log((results.length - failed) + "/" + results.length + " passed");
