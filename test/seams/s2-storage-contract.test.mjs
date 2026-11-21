/**
 * S2 策略存储接缝契约（票 01 · 四域五缝 S2）
 *
 * 锁死三件事：读绝不产生可写回空模板、坏文件绝不被覆盖、落盘是原子的且串行的。
 * 另含 P0-1（BOM 静默失守）与 P0-2（坏文件被空模板覆盖）在 0.5.7 上必红的回放位。
 *
 * 跑法：node --import ./test/stub-loader.mjs test/seams/s2-storage-contract.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BACKUP_FILE,
  POLICY_FILE,
  TEMP_FILE,
  createDiskStorageAdapter,
  createFilePolicyStore,
  createMemoryStorageAdapter,
  createPolicyStore,
  pruneBackups,
  stripBom,
} from "../../lib/storage-seam.js";
import { expectRed, loadMutated, cleanupMutations } from "./mutation.mjs";

const results = [];
const check = async (label, fn) => {
  try { await fn(); results.push({ label, ok: true }); }
  catch (error) { results.push({ label, ok: false, error: String((error && error.message) || error) }); }
};
const L = (lines) => lines.join("\n");

const DEEP = (() => {
  let node = { leaf: true };
  for (let index = 0; index < 200; index += 1) node = { nested: node };
  return node;
})();
const LONG = "x".repeat(200 * 1024);
const CORRUPT = "{ this is not json";

// ─────────────────────────────────────────────────────────────────────────────
// 契约审计（正例与变异共用）
// ─────────────────────────────────────────────────────────────────────────────

/** P0-1：BOM 必须剥掉，写回必须无 BOM。 */
async function auditBom({ createPolicyStore: storeOf, createMemoryStorageAdapter: adapterOf }) {
  const adapter = adapterOf({ files: { [POLICY_FILE]: "\uFEFF{\"version\":3,\"tools\":{\"read\":0}}" } });
  const store = storeOf({ adapter });
  const read = await store.read();
  assert.equal(read.ok, true, "带 BOM 的策略文件必须可读");
  assert.equal(read.bomStripped, true);
  assert.equal(read.value.version, 3);
  assert.equal(store.status().writable, true);
  await store.write({ version: 3, tools: { read: 0 } });
  const text = adapter.text(POLICY_FILE);
  assert.equal(text.charCodeAt(0) === 0xfeff, false, "写回的策略文件不得带 BOM");
  assert.equal(text, JSON.stringify({ version: 3, tools: { read: 0 } }, null, 2) + "\n");
  assert.equal(stripBom("\uFEFF{}"), "{}");
  assert.equal(stripBom("{}"), "{}");
}

/** P0-2：坏文件不得被空模板覆盖；读取失败后默认拒绝写。 */
async function auditCorruptRefuse({ createPolicyStore: storeOf, createMemoryStorageAdapter: adapterOf }) {
  const adapter = adapterOf({ files: { [POLICY_FILE]: CORRUPT } });
  const store = storeOf({ adapter });
  const read = await store.read();
  assert.equal(read.ok, false);
  assert.equal(read.code, "POLICY_UNREADABLE");
  assert.equal(store.status().writable, false);
  const before = adapter.snapshot().find((row) => row.path === POLICY_FILE);

  const refused = await expectRed("write-on-corrupt", () => store.write({ version: 3 }));
  assert.equal(refused.red, true, "读到坏文件后写必须被拒");
  assert.equal(refused.error.code, "POLICY_UNREADABLE");
  const after = adapter.snapshot().find((row) => row.path === POLICY_FILE);
  assert.deepEqual(after, before, "拒绝写时原文件必须一个字节都不变");
  assert.equal(adapter.exists(TEMP_FILE), false);
  assert.equal(adapter.exists(BACKUP_FILE), false, "拒绝写时不得产生备份");
}

/** P0-2 的显式替换路径：备份原文才允许整份替换。 */
async function auditReplaceCorrupt({ createPolicyStore: storeOf, createMemoryStorageAdapter: adapterOf }) {
  const adapter = adapterOf({ files: { [POLICY_FILE]: CORRUPT } });
  const store = storeOf({ adapter });
  await store.read();
  const written = await store.write({ version: 3, tools: {} }, { replaceCorrupt: true });
  assert.equal(written.written, true);
  assert.equal(adapter.text(BACKUP_FILE), CORRUPT, "整份替换前必须备份原文（字节级）");
  assert.equal(JSON.parse(adapter.text(POLICY_FILE)).version, 3);
  const backup = await store.readBackup();
  assert.equal(backup.exists, true);
  assert.equal(backup.ok, false);
  assert.equal(backup.code, "BACKUP_UNREADABLE", "坏文件备份必须原样保留，而不是被清洗成合法 JSON");
  const status = await store.inspect();
  assert.equal(status.status.writable, true, "显式替换后回到可写态");
}

/** 原子性：rename 失败必须保留原文件、清临时文件、备份仍完整。 */
async function auditAtomicRename({ createPolicyStore: storeOf, createMemoryStorageAdapter: adapterOf }) {
  const original = JSON.stringify({ version: 3, tools: { read: 2 } }, null, 2) + "\n";
  const adapter = adapterOf({ files: { [POLICY_FILE]: original }, faults: { renameError: true } });
  const store = storeOf({ adapter });
  await store.read();
  const before = adapter.snapshot().find((row) => row.path === POLICY_FILE);
  const failed = await expectRed("rename", () => store.write({ version: 3, tools: { read: 0 } }));
  assert.equal(failed.red, true);
  assert.equal(failed.error.code, "RENAME_FAILED");
  assert.deepEqual(adapter.snapshot().find((row) => row.path === POLICY_FILE), before, "rename 失败不得改动原文件");
  assert.equal(adapter.exists(TEMP_FILE), false, "失败必须清掉临时文件");
  assert.equal(adapter.text(BACKUP_FILE), original, "备份必须仍是写前原文");
}

/** 并发写串行 + 备份链按写入顺序推进。 */
async function auditSerializedWrites({ createPolicyStore: storeOf, createMemoryStorageAdapter: adapterOf }) {
  const adapter = adapterOf({ faults: { writeDelayMs: 12 } });
  const store = storeOf({ adapter });
  const first = store.write({ n: 1 });
  const second = store.write({ n: 2 });
  await Promise.all([first, second]);
  assert.equal(JSON.parse(adapter.text(POLICY_FILE)).n, 2, "后写者必须赢");
  assert.equal(JSON.parse(adapter.text(BACKUP_FILE)).n, 1, "第二次写的备份必须是第一次写后的内容");
  await store.write({ n: 3 });
  assert.equal(JSON.parse(adapter.text(BACKUP_FILE)).n, 2);
  assert.equal(JSON.parse(adapter.text(POLICY_FILE)).n, 3);
}

/** 任意 JSON 输入都不崩、不静默归一、不写脏。 */
async function auditArbitraryJson({ createPolicyStore: storeOf, createMemoryStorageAdapter: adapterOf }) {
  const cases = [
    { label: "null", text: "null", ok: true, shape: "null", writable: false },
    { label: "array", text: "[1,2,3]", ok: true, shape: "array", writable: false },
    { label: "number", text: "42", ok: true, shape: "number", writable: false },
    { label: "string", text: "\"text\"", ok: true, shape: "string", writable: false },
    { label: "deep", text: JSON.stringify(DEEP), ok: true, shape: "object", writable: true },
    { label: "long", text: JSON.stringify({ blob: LONG }), ok: true, shape: "object", writable: true },
    { label: "unknown-keys", text: JSON.stringify({ version: 3, mystery: { deep: [1, { x: true }] } }), ok: true, shape: "object", writable: true },
    { label: "truncated", text: "{\"version\":3", ok: false, shape: undefined, writable: false },
  ];
  for (const entry of cases) {
    const adapter = adapterOf({ files: { [POLICY_FILE]: entry.text } });
    const store = storeOf({ adapter });
    const read = await store.read();
    assert.equal(read.ok, entry.ok, entry.label + " 的读取判定错误");
    if (entry.shape !== undefined) assert.equal(read.shape, entry.shape, entry.label + " 的形状判定错误");
    assert.equal(store.status().writable, entry.writable, entry.label + " 的可写性判定错误");
    if (!entry.writable) {
      const refused = await expectRed(entry.label + "-write", () => store.write({ version: 3 }));
      assert.equal(refused.red, true, entry.label + " 不可写时必须拒绝写");
      assert.equal(adapter.text(POLICY_FILE), entry.text, entry.label + " 拒绝写后原文必须不变");
    }
  }
}

/** 未知键与 v3 键集保真：读一次、写一次、再读一次，内容深相等。 */
async function auditRoundtripFidelity({ createPolicyStore: storeOf, createMemoryStorageAdapter: adapterOf }) {
  const document = {
    version: 3,
    tools: { read: 1, write: 0 },
    sections: { "repeat-guard": 2 },
    mcp: { allow: ["x"] },
    mystery: { deep: [1, { x: true }] },
  };
  const adapter = adapterOf();
  const store = storeOf({ adapter });
  await store.write(document);
  const firstRead = await store.read();
  assert.deepEqual(firstRead.value, document);
  await store.write(firstRead.value);
  const secondRead = await store.read();
  assert.deepEqual(secondRead.value, document, "读一次写一次再读，键集与值必须逐键保真");
  const snapshot = adapter.snapshot();
  assert.equal(snapshot.length, 2, "gate.json + 备份");
  assert.equal(snapshot.find((row) => row.path === POLICY_FILE).digest.length, 40);
  assert.equal(adapter.exists(TEMP_FILE), false, "正常写不得留下临时文件");
}

// ─────────────────────────────────────────────────────────────────────────────
// 正例
// ─────────────────────────────────────────────────────────────────────────────

const lib = { createPolicyStore, createMemoryStorageAdapter };

await check("P0-1 · BOM 静默失守（内存）", () => auditBom(lib));
await check("P0-2 · 坏文件被空模板覆盖（内存）", () => auditCorruptRefuse(lib));
await check("P0-2 · 显式整份替换必须备份原文", () => auditReplaceCorrupt(lib));
await check("原子 rename 失败：原文件保留、临时文件清理", () => auditAtomicRename(lib));
await check("并发写串行：后写者赢、备份链按序", () => auditSerializedWrites(lib));
await check("任意 JSON 输入：不崩、不静默归一、不写脏", () => auditArbitraryJson(lib));
await check("未知键保真：读一次写一次再读深相等", () => auditRoundtripFidelity(lib));

await check("磁盘适配器 · 同一组契约（真正的临时目录）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-storage-"));
  try {
    const adapter = createDiskStorageAdapter({ root });
    const store = createPolicyStore({ adapter });
    fs.writeFileSync(path.join(root, POLICY_FILE), "\uFEFF{\"version\":3,\"tools\":{}}", "utf8");
    const read = await store.read();
    assert.equal(read.ok, true);
    assert.equal(read.bomStripped, true);
    await store.write({ version: 3, tools: { read: 1 }, extra: { keep: true } });
    const onDisk = fs.readFileSync(path.join(root, POLICY_FILE));
    assert.equal(onDisk[0], 0x7b, "落盘必须是 { 而不是 BOM 的 0xEF");
    assert.deepEqual(JSON.parse(onDisk.toString("utf8")).extra, { keep: true });
    const backup = await store.readBackup();
    assert.equal(backup.ok, true);
    assert.equal(backup.value.version, 3);
    assert.equal(fs.existsSync(path.join(root, TEMP_FILE)), false);
    const snapshot = adapter.snapshot();
    assert.deepEqual(snapshot.map((row) => row.path), [BACKUP_FILE, POLICY_FILE].sort());
    await assert.rejects(() => adapter.readText("../escape.json"), /escapes root/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("磁盘适配器 · 注入 BOM 故障也能被读侧剥掉", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-storage-bom-"));
  try {
    const adapter = createDiskStorageAdapter({ root, faults: { bom: true } });
    const store = createPolicyStore({ adapter });
    await store.write({ version: 3, tools: {} });
    const raw = fs.readFileSync(path.join(root, POLICY_FILE), "utf8");
    assert.equal(raw.charCodeAt(0) === 0xfeff, true, "故障注入确实写入了 BOM");
    const read = await store.read();
    assert.equal(read.ok, true, "带 BOM 的磁盘文件必须仍可读（P0-1）");
    assert.equal(read.bomStripped, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// 进程级写链与 revision（#02：两个页签并发保存不丢更新）
// ─────────────────────────────────────────────────────────────────────────────

await check("进程级写链：两个独立 store 实例共用同一条队列，revision 严格递增", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-lock-"));
  try {
    const file = path.join(root, "gate.json");
    const first = createFilePolicyStore({ file });
    const second = createFilePolicyStore({ file });
    const [left, right] = await Promise.all([
      first.write({ version: 3, marker: "left" }),
      second.write({ version: 3, marker: "right" }),
    ]);
    // 实例级锁会让两个 store 各自读到 seq 0 再各写一个 1 号 revision（互相覆盖）。
    const leftSeq = Number(left.revision.split("-")[0]);
    const rightSeq = Number(right.revision.split("-")[0]);
    assert.deepEqual([leftSeq, rightSeq].sort((a, b) => a - b), [1, 2], "两个实例必须排同一条队，序号不能撞车");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).marker, "right", "后写者必须赢且看到前写者（串行，不是竞态）");
    assert.equal(right.previousRevision, left.revision, "后写者的 previousRevision 必须是前写者的 revision");
    assert.equal(fs.existsSync(path.join(root, TEMP_FILE)), false, "唯一临时文件不许残留");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

await check("进程级写链：内存适配器上两个 store 也互斥（同一适配器 = 同一资源）", async () => {
  const adapter = createMemoryStorageAdapter({ faults: { writeDelayMs: 5 } });
  const first = createPolicyStore({ adapter, uniqueTemp: true });
  const second = createPolicyStore({ adapter, uniqueTemp: true });
  const [left, right] = await Promise.all([first.write({ n: 1 }), second.write({ n: 2 })]);
  assert.equal(Number(right.revision.split("-")[0]), Number(left.revision.split("-")[0]) + 1, "同一适配器的写必须串行推进 revision");
  assert.equal(JSON.parse(adapter.text(POLICY_FILE)).n, 2);
});

await check("revision 冲突回执带 changedKeys 差异（A17）", async () => {
  const adapter = createMemoryStorageAdapter();
  const store = createPolicyStore({ adapter });
  await store.write({ version: 3, a: 1 });
  const stale = store.revision();
  await store.write({ version: 3, a: 2 });
  const red = await expectRed("conflict-diff", () => store.write({ version: 3, a: 3 }, {
    expectedRevision: stale,
    changedKeys: ["a", "b"],
  }));
  assert.equal(red.red, true);
  assert.equal(red.error.code, "REVISION_CONFLICT");
  assert.deepEqual(red.error.detail.changedKeys, ["a", "b"], "409 必须带这次想改的键（面板据此提示差异）");
  assert.equal(adapter.text(POLICY_FILE).includes('"a": 2'), true, "冲突写入不得落盘");
});

await check("脏输入不产生新 revision：语法/形状损坏读多次 revision 不变", async () => {
  for (const text of ["{broken", "[1,2,3]", "null", "42"]) {
    const adapter = createMemoryStorageAdapter({ files: { [POLICY_FILE]: text } });
    const store = createPolicyStore({ adapter });
    const before = store.readSync();
    const revision = before.revision;
    for (let index = 0; index < 3; index += 1) {
      const again = store.readSync();
      assert.equal(again.revision, revision, "重复读损坏文件不得推进 revision: " + text);
    }
    const red = await expectRed("dirty-write", () => store.write({ version: 3 }));
    assert.equal(red.red, true, "可读但不可写的文档必须拒绝写: " + text);
    assert.equal(store.readSync().revision, revision, "拒绝写之后 revision 仍不得变: " + text);
  }
});

await check("备份保留上限可配：pruneBackups 只留最新 N 份", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-prune-"));
  try {
    const prefix = "gate.json.v2.bak-";
    for (const stamp of ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]) {
      fs.writeFileSync(path.join(root, prefix + stamp), stamp);
    }
    const removed = pruneBackups(root, prefix, 2);
    assert.equal(removed.length, 2);
    assert.deepEqual(fs.readdirSync(root).sort(), [prefix + "2026-01-03", prefix + "2026-01-04"], "只留最新两份");
    assert.deepEqual(pruneBackups(root, "no-such-prefix", 0), [], "没有匹配文件时安全返回空");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 删分支必须红（P0-1 / P0-2 / 原子性 / 备份）
// ─────────────────────────────────────────────────────────────────────────────

const mutations = [
  {
    label: "读侧不剥 BOM（P0-1 回放）",
    audit: "bom",
    find: "  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;",
  },
  {
    label: "读到坏文件仍允许写（P0-2 回放）",
    audit: "corrupt",
    find: L([
      "    if (poisoned !== undefined && spec.replaceCorrupt !== true) {",
      "      throw new StorageError(poisoned.code, \"policy file is not readable; refusing to overwrite it (\" + poisoned.code + \")\", { cause: poisoned.message });",
      "    }",
    ]),
  },
  {
    label: "写前不备份（回滚依据丢失）",
    audit: "serialized",
    find: "      await adapter.writeText(BACKUP_FILE, source);",
  },
  {
    label: "rename 失败不清临时文件",
    audit: "rename",
    find: "      await adapter.remove(tempName);",
  },
];

const audits = {
  bom: (module) => auditBom(module),
  corrupt: (module) => auditCorruptRefuse(module),
  serialized: (module) => auditSerializedWrites(module),
  rename: (module) => auditAtomicRename(module),
};

for (const entry of mutations) {
  await check("删分支必红 · 正例先绿：" + entry.label, () => audits[entry.audit](lib));
  await check("删分支必红 · " + entry.label, async () => {
    const mutated = await loadMutated("lib/storage-seam.js", [{ label: entry.audit, find: entry.find }], { name: "storage" });
    try {
      assert.equal(mutated.applied.length, 1);
      const mutatedLib = {
        createPolicyStore: mutated.namespace.createPolicyStore,
        createMemoryStorageAdapter: mutated.namespace.createMemoryStorageAdapter,
      };
      const red = await expectRed(entry.audit, () => audits[entry.audit](mutatedLib));
      assert.equal(red.red, true, "删掉被测分支后契约必须变红，实际仍全绿（假绿）");
    } finally {
      mutated.cleanup();
    }
  });
}

await check("擦除临时变异副本", () => {
  cleanupMutations();
  assert.equal(fs.existsSync(path.join(process.cwd(), "test", "seams", ".mut", String(process.pid))), false);
});

const failed = results.filter((entry) => !entry.ok);
for (const entry of results) {
  console.log((entry.ok ? "  ok    " : "  FAIL  ") + entry.label + (entry.ok ? "" : "  →  " + entry.error));
}
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exitCode = failed.length === 0 ? 0 : 1;
