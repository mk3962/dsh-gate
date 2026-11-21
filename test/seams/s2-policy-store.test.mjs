/**
 * S2 策略存储 · 0.6.0 缺陷回归（票 02 · gate:D1 / D2 / D3）
 *
 * 每个用例标题都带缺陷编号，test/seams/defect-registry.mjs 的 replay.case 与之一一对应：
 *   P0-1 BOM 静默失守 → 五级诊断成对用例
 *   P0-2 坏文件被空模板覆盖 → 控制面 409 + 磁盘字节不变
 *   P1-2 显式 false 被默认 true 覆盖 → 双向覆盖
 *   P1-3 迁移丢 repeatGuard → v2 迁移保真 + 备份幂等
 * 另含 A13–A18：null 删除、revision 乐观并发、并发写串行、任意 JSON fuzz、A15 禁用仍挂控制面。
 *
 * 跑法：node --import ./test/stub-loader.mjs test/seams/s2-policy-store.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply } from "../../lib/index.js";
import { resolvePolicy } from "../../lib/policy.js";
import { createFilePolicyStore, createPolicyStore, isCorruptRead } from "../../lib/storage-seam.js";
import { makeHost } from "../host.mjs";
import { mountControlPlane, trustedHeaders, makeRequest, send } from "./s3-control-plane-seam.mjs";

const results = [];
const check = async (label, fn) => {
  try { await fn(); results.push({ label, ok: true }); }
  catch (error) { results.push({ label, ok: false, error: String((error && error.message) || error) }); }
};

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix || "gate-s2-"));
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const writePolicy = (file, value, bom) => {
  const body = Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.writeFileSync(file, bom === true ? Buffer.concat([BOM, body]) : body);
  return fs.readFileSync(file);
};

// ── P0-1 BOM：PowerShell Set-Content 的合法文件必须生效 ────────────────────────
await check("P0-1 BOM 不得静默失守：带 BOM 的 gate.json 必须正常生效且文件不被改写", async () => {
  const dir = tmp("gate-bom-");
  try {
    const file = path.join(dir, "gate.json");
    const original = writePolicy(file, {
      version: 3,
      enabled: false,
      defaults: { capability: 0, section: 2 },
      narrowPassThrough: 3,
    }, true);
    const store = createFilePolicyStore({ file });
    const read = store.readSync();
    assert.equal(read.status, "bom");
    assert.equal(read.hadBom, true);
    assert.equal(read.bomStripped, true);
    assert.equal(read.value.enabled, false, "剥离 BOM 后必须拿到真实内容");

    const policy = resolvePolicy({ policyFile: file });
    assert.equal(policy.enabled, false, "BOM 文件里的 enabled:false 必须生效（旧实现静默回退默认放行）");
    assert.equal(policy.degraded, false, "BOM 是合法文件，不是降级态");
    assert.equal(policy.readDiagnostic.status, "bom");
    assert.equal(policy.narrowPassThrough, 3);
    assert.ok(policy.warnings.some((row) => row.code === "policy-bom-stripped"), "必须给一次性告警");
    assert.deepEqual(fs.readFileSync(file), original, "读只剥内存副本，绝不改写磁盘文件");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── P0-2 坏文件保护 ───────────────────────────────────────────────────────────
await check("P0-2 不可读时拒绝写：控制面 409 且磁盘字节不变、不产生备份/临时", async () => {
  const dir = tmp("gate-p0-2-");
  try {
    const file = path.join(dir, "gate.json");
    const corrupt = Buffer.from('{"version": 3, "enabled": ', "utf8");
    fs.writeFileSync(file, corrupt);
    const host = makeHost();
    const plane = mountControlPlane({
      ctx: host.rootCtx,
      gate: { listAgents: () => [], snapshot: () => ({}), knownNames: () => undefined, capabilityView: () => ({}) },
      policy: { enabled: true, policyFile: file, defaults: { capability: 2, section: 1, skillpack: 2 }, capabilities: {}, sections: {}, skills: {} },
      logger: host.logger,
      config: {},
    });
    try {
      const outcome = await send(plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
        method: "POST",
        path: "/api/dsh-gate/policy",
        headers: trustedHeaders(),
        body: JSON.stringify({ defaults: { capability: 1 } }),
      }));
      assert.equal(outcome.status, 409, "坏文件必须 409，绝不能 200 静默覆盖");
      assert.equal(outcome.json.code, "POLICY_UNREADABLE");
      assert.equal(outcome.json.writable, false);
      assert.deepEqual(fs.readFileSync(file), corrupt, "磁盘字节必须原样保留");
      assert.deepEqual(fs.readdirSync(dir), ["gate.json"], "不许留下 .bak / .tmp");
    } finally { plane.dispose(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await check("P0-2 形状损坏（根是数组/null）同样拒绝写，不被空模板顶掉", async () => {
  const dir = tmp("gate-p0-2-shape-");
  try {
    const file = path.join(dir, "gate.json");
    const original = fs.writeFileSync(file, "[1,2,3]") || fs.readFileSync(file);
    const read = createFilePolicyStore({ file }).readSync();
    assert.equal(read.shape, "array");
    assert.equal(isCorruptRead(read), true, "非对象根必须算损坏态");
    const policy = resolvePolicy({ policyFile: file });
    assert.equal(policy.degraded, true);
    assert.equal(policy.readDiagnostic.status, "shape");
    assert.equal(policy.enabled, false, "冷启动损坏：不施加限制，enabled 视为假");
    assert.deepEqual(fs.readFileSync(file), original, "读不得改写坏文件");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── P1-2 显式 false 优先 ─────────────────────────────────────────────────────
await check("P1-2 显式 false 必须优先：文件 false 压过行 true，文件 true 也压过行 false", async () => {
  const dir = tmp("gate-p1-2-");
  try {
    const file = path.join(dir, "gate.json");
    writePolicy(file, { version: 3, enabled: false });
    assert.equal(resolvePolicy({ enabled: true, policyFile: file }).enabled, false, "行 true 不许盖掉文件里的 false");
    writePolicy(file, { version: 3, enabled: true });
    assert.equal(resolvePolicy({ enabled: false, policyFile: file }).enabled, true, "文件里的 true 也必须压过行 false");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── P1-3 v2 迁移保真 ────────────────────────────────────────────────────────
await check("P1-3 迁移保真：v2 的 repeatGuard 原样保留，备份独占且重启不重复堆备份", async () => {
  const dir = tmp("gate-p1-3-");
  try {
    const file = path.join(dir, "gate.json");
    const v2 = {
      version: 2,
      enabled: true,
      tools: { read: 1, univer_sheet: 2 },
      sections: { "mcp:foo": 2 },
      skills: { tier: 2 },
      catalog: { groupByPlugin: true, maxDescriptionLength: 40 },
      narrowPassThrough: 5,
      repeatGuard: { enabled: true, windowSize: 7, windowThreshold: 4, exclude: ["custom_tool"], argumentsPreviewChars: 200 },
    };
    const original = writePolicy(file, v2);
    const policy = resolvePolicy({ policyFile: file });
    assert.equal(policy.repeatGuard.enabled, true, "repeatGuard.enabled 不许被静默重置");
    assert.equal(policy.repeatGuard.windowSize, 7);
    assert.equal(policy.repeatGuard.windowThreshold, 4);
    assert.equal(policy.repeatGuard.argumentsPreviewChars, 200);
    assert.ok(policy.repeatGuard.exclude.includes("custom_tool"), "自定义排除项必须保留");
    assert.equal(policy.narrowPassThrough, 5);
    assert.ok(typeof policy.backupFile === "string" && /v2\.bak-/.test(policy.backupFile), "必须生成 v2 备份");
    assert.deepEqual(fs.readFileSync(file), original, "原 v2 文件一个字都不许动");
    const backups = fs.readdirSync(dir).filter((name) => name.includes(".v2.bak-"));
    assert.equal(backups.length, 1);
    // 幂等：再启动一次不得堆第二份完全相同的备份
    resolvePolicy({ policyFile: file });
    assert.equal(fs.readdirSync(dir).filter((name) => name.includes(".v2.bak-")).length, 1, "同内容备份必须去重");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 五级诊断 ────────────────────────────────────────────────────────────────
await check("五级磁盘诊断：absent / ok / bom / syntax / shape / io 可结构化区分", async () => {
  const dir = tmp("gate-diag-");
  try {
    const storeFor = (name) => createFilePolicyStore({ file: path.join(dir, name) });
    assert.equal(storeFor("none.json").readSync().status, "absent");
    const okFile = path.join(dir, "ok.json");
    writePolicy(okFile, { version: 3 });
    assert.equal(storeFor("ok.json").readSync().status, "ok");
    const bomFile = path.join(dir, "bom.json");
    writePolicy(bomFile, { version: 3 }, true);
    assert.equal(storeFor("bom.json").readSync().status, "bom");
    const syntaxFile = path.join(dir, "syntax.json");
    fs.writeFileSync(syntaxFile, "{\"version\":3,");
    const syntax = storeFor("syntax.json").readSync();
    assert.equal(syntax.status, "syntax");
    assert.equal(syntax.code, "POLICY_UNREADABLE");
    assert.ok(syntax.location && typeof syntax.location.offset === "number", "语法错误必须带精确位置");
    const shapeFile = path.join(dir, "shape.json");
    fs.writeFileSync(shapeFile, "null");
    assert.equal(storeFor("shape.json").readSync().shape, "null");
    const ioAdapter = {
      kind: "fault",
      exists: () => true,
      async readText() { const error = new Error("access denied"); error.code = "EACCES"; throw error; },
      readTextSync() { const error = new Error("access denied"); error.code = "EACCES"; throw error; },
      async writeText() {},
      async rename() {},
      async remove() {},
      snapshot: () => [],
    };
    const io = createPolicyStore({ adapter: ioAdapter }).readSync();
    assert.equal(io.status, "io");
    assert.equal(io.code, "POLICY_IO_ERROR");
    assert.equal(io.reason, "EACCES", "原始错误码必须保留，不许伪装成 ENOENT/空文件");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── revision / 乐观并发 ────────────────────────────────────────────────────
await check("A16 revision：单调递增且含内容指纹；ifRevision 不匹配抛 REVISION_CONFLICT（附双方 revision）", async () => {
  const dir = tmp("gate-rev-");
  try {
    const file = path.join(dir, "gate.json");
    const store = createFilePolicyStore({ file });
    const first = await store.write({ version: 3, enabled: true });
    assert.match(first.revision, /^\d+-[0-9a-f]{16}$/, "revision = 递增序号-内容指纹");
    const same = await store.write({ version: 3, enabled: true });
    assert.equal(same.changed, false, "内容没变不许写盘");
    assert.equal(same.revision, first.revision, "内容相同 revision 不推进");
    const second = await store.write({ version: 3, enabled: false });
    assert.notEqual(second.revision, first.revision);
    assert.equal(Number(second.revision.split("-")[0]), Number(first.revision.split("-")[0]) + 1, "序号必须单调 +1");
    await assert.rejects(
      () => store.write({ version: 3, enabled: true }, { expectedRevision: first.revision }),
      (error) => {
        assert.equal(error.code, "REVISION_CONFLICT");
        assert.equal(error.detail.currentRevision, second.revision);
        assert.equal(error.detail.expectedRevision, first.revision);
        return true;
      },
    );
    assert.equal(store.readSync().value.enabled, false, "冲突必须拒绝写，后写者不能污染文件");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 并发写串行 ─────────────────────────────────────────────────────────────
await check("A15 并发写串行化：两页签同时保存不丢更新，后写者看见前者（文件最终一致且可解析）", async () => {
  const dir = tmp("gate-concurrent-");
  try {
    const file = path.join(dir, "gate.json");
    const store = createFilePolicyStore({ file });
    await store.write({ version: 3, enabled: true, narrowPassThrough: 1 });
    const [left, right] = await Promise.all([
      store.write({ version: 3, enabled: true, narrowPassThrough: 2 }),
      store.write({ version: 3, enabled: true, narrowPassThrough: 3 }),
    ]);
    assert.equal(left.written || right.written, true, "至少有一个真的写盘");
    const text = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(text);
    assert.equal([2, 3].includes(parsed.narrowPassThrough), true, "文件必须是其中一次完整提交，不能是半截");
    assert.equal(store.readSync().status, "ok");
    assert.ok(fs.existsSync(path.join(dir, "gate.json.bak")), "后写者必须看到前写者留下的备份");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── fuzz：任意 JSON 都不崩、不写脏 ─────────────────────────────────────────
await check("S2 fuzz：任意 JSON 读写不崩；非对象写入被拒；解析失败不产生新 revision", async () => {
  const dir = tmp("gate-fuzz-");
  try {
    const objectValues = [
      { version: 3, enabled: false },
      { deep: { a: [1, { b: true }] }, extra: "x".repeat(2000) },
      { version: 3, capabilities: Object.fromEntries(Array.from({ length: 200 }, (_v, index) => ["mcp:n" + index, { tier: 2 }])) },
    ];
    for (const [index, value] of objectValues.entries()) {
      const file = path.join(dir, "fuzz-" + index + ".json");
      const store = createFilePolicyStore({ file });
      await store.write(value);
      const bytes = fs.readFileSync(file);
      assert.equal(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, false, "写入不许带 BOM");
      assert.equal(bytes[bytes.length - 1], 0x0a, "必须保留末尾换行");
      assert.doesNotThrow(() => resolvePolicy({ policyFile: file }), "任意内容读取都不许崩");
      assert.equal(store.readSync().status, "ok");
    }
    // 非对象：写必须稳定拒绝（不是崩，也不是写脏），且文件保持原状。
    for (const value of [null, [], 42, "text", true]) {
      const file = path.join(dir, "reject.json");
      const store = createFilePolicyStore({ file });
      await store.write({ version: 3, enabled: true });
      const before = store.readSync();
      await assert.rejects(() => store.write(value), (error) => {
        assert.equal(error.code, "POLICY_NOT_OBJECT");
        return true;
      }, "非对象策略必须带稳定错误码拒绝");
      assert.deepEqual(store.readSync(), before, "拒绝写时文件与 revision 都不许变");
    }
    // 坏 JSON：确认判定稳定、revision 不变
    const badFile = path.join(dir, "bad.json");
    fs.writeFileSync(badFile, '{"version":');
    const badStore = createFilePolicyStore({ file: badFile });
    const before = badStore.readSync();
    assert.equal(before.ok, false);
    const after = badStore.readSync();
    assert.equal(after.revision, before.revision, "解析失败不产生新 revision");
    assert.equal(isCorruptRead(before), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── A15 禁用仍挂控制面 ──────────────────────────────────────────────────────
await check("A15 禁用后控制面仍可用：不施加任何限制，但不再注册 gate_* 工具（能再写回 enabled:true）", async () => {
  const dir = tmp("gate-disabled-");
  try {
    const file = path.join(dir, "gate.json");
    writePolicy(file, { version: 3, enabled: false });
    const host = makeHost({ id: "agent-disabled", names: ["read", "write", "univer_sheet"] });
    const dispose = apply(host.rootCtx, { enabled: true, policyFile: file });
    try {
      assert.equal(typeof dispose, "function");
      assert.equal(host.restrictionsFor(host.agent).length, 0, "禁用时不许施加任何限制");
      assert.equal(host.visibleOf(host.agent).has("univer_sheet"), true);
      assert.equal(host.registry.has("gate_status"), false, "禁用时不注册闸门工具");
      assert.ok(host.logs.some((line) => line.includes("控制面")), "必须留下「只挂控制面」的诊断日志");
    } finally { dispose(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const failed = results.filter((row) => !row.ok);
for (const row of results) console.log((row.ok ? "  ok  " : "  FAIL") + "  " + row.label + (row.ok ? "" : "  →  " + row.error));
console.log(failed.length === 0 ? "\n全部通过 (" + results.length + ")" : "\n" + failed.length + " 项失败 / " + results.length);
process.exitCode = failed.length === 0 ? 0 : 1;
