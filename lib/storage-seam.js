/**
 * S2 策略存储接缝（票 01 · gate:D1 / 缺陷 P0-1、P0-2 的落点）
 *
 * 唯一落盘边界：策略文件的读、写、备份、原子性、BOM 与并发全部藏在这一个接口后。
 * 文件系统以适配器注入（内存 / 磁盘两种），测试不再直接摸文件。
 *
 * 纪律（票 02 接入时按此实现，本文件即契约）：
 *   1. 读绝不产生「可写回的空模板」：解析失败 ⇒ 未读态（poisoned），此后默认拒绝写；
 *   2. 坏文件不得被覆盖：只有显式 replaceCorrupt 才能整份替换，且写前强制备份原文；
 *   3. 写入无 BOM；读取剥 BOM（宿主会 JSON.parse 这个文件）；
 *   4. 原子落盘：先写临时文件再 rename；rename 失败保留原文件、清临时文件、报错；
 *   5. 并发写串行：后写者一定看得见前写者；备份链按写入顺序推进；
 *   6. 任意 JSON 输入都不崩：非对象/坏 JSON 只影响「可写性」，不影响「能否读取判定」。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const POLICY_FILE = "gate.json";
export const BACKUP_FILE = "gate.json.bak";
export const TEMP_FILE = "gate.json.tmp";

export class StorageError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.name = "StorageError";
    this.code = code;
    if (extra !== undefined) this.detail = extra;
  }
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha1 = (text) => createHash("sha1").update(text, "utf8").digest("hex");

/** 剥 UTF-8 BOM（读的一侧唯一允许的宽容）。 */
export function stripBom(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const encodeBytes = (text) => ({ bytes: Buffer.byteLength(text, "utf8"), digest: sha1(text) });

/** 适配器公共快照口径：按路径排序的字节摘要，用于「装与卸往返后逐字节不变」类断言。 */
function snapshotOf(entries) {
  return Object.keys(entries).sort().map((rel) => ({ path: rel, bytes: entries[rel].bytes, digest: entries[rel].digest }));
}

function normalizeFaults(faults) {
  const spec = faults || {};
  return {
    bom: spec.bom === true,
    corruptText: typeof spec.corruptText === "string" ? spec.corruptText : undefined,
    renameError: spec.renameError === true,
    writeDelayMs: Number.isFinite(spec.writeDelayMs) ? Math.max(0, spec.writeDelayMs) : 0,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 内存适配器：同一组契约断言在内存上先跑通（不碰文件系统、零随机）。
 * @param {{files?: Record<string,string>, faults?: object}} [options]
 */
export function createMemoryStorageAdapter(options) {
  const opts = options || {};
  const files = new Map();
  const faults = normalizeFaults(opts.faults);
  const snapshot = new Map();
  for (const [rel, text] of Object.entries(opts.files || {})) {
    files.set(rel, text);
    snapshot.set(rel, encodeBytes(text));
  }

  const adapter = {
    kind: "memory",
    faults,
    exists(rel) { return files.has(rel); },
    async readText(rel) {
      if (!files.has(rel)) throw new StorageError("ENOENT", "no such file: " + rel);
      return files.get(rel);
    },
    async writeText(rel, text) {
      if (faults.writeDelayMs > 0) await sleep(faults.writeDelayMs);
      let payload = String(text);
      if (faults.corruptText !== undefined) payload = faults.corruptText;
      if (faults.bom) payload = "\uFEFF" + payload;
      files.set(rel, payload);
      snapshot.set(rel, encodeBytes(payload));
    },
    async rename(from, to) {
      if (faults.renameError) throw new StorageError("RENAME_FAILED", "injected rename failure: " + from + " -> " + to);
      if (!files.has(from)) throw new StorageError("ENOENT", "no such file: " + from);
      files.set(to, files.get(from));
      files.delete(from);
      snapshot.delete(from);
      snapshot.set(to, encodeBytes(files.get(to)));
    },
    async remove(rel) { files.delete(rel); snapshot.delete(rel); },
    files() { return new Map(files); },
    text(rel) { return files.get(rel); },
    snapshot() { return snapshotOf(Object.fromEntries(snapshot)); },
  };
  return adapter;
}

/**
 * 磁盘适配器：真实临时目录（测试自己 umask 出来），只认 root 内的相对路径。
 * @param {{root: string, faults?: object}} options
 */
export function createDiskStorageAdapter(options) {
  const opts = options || {};
  if (typeof opts.root !== "string" || opts.root.length === 0) throw new StorageError("EROOT", "disk adapter requires a root");
  const root = path.resolve(opts.root);
  const faults = normalizeFaults(opts.faults);
  const locate = (rel) => {
    if (typeof rel !== "string" || rel.length === 0) throw new StorageError("EPATH", "path must be a non-empty string");
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) throw new StorageError("EPATH", "path escapes root: " + rel);
    return target;
  };
  const adapter = {
    kind: "disk",
    root,
    faults,
    exists(rel) { return fs.existsSync(locate(rel)); },
    async readText(rel) {
      const target = locate(rel);
      try { return fs.readFileSync(target, "utf8"); }
      catch (error) {
        if (error && error.code === "ENOENT") throw new StorageError("ENOENT", "no such file: " + rel);
        throw new StorageError("EIO", String((error && error.message) || error));
      }
    },
    async writeText(rel, text) {
      if (faults.writeDelayMs > 0) await sleep(faults.writeDelayMs);
      let payload = String(text);
      if (faults.corruptText !== undefined) payload = faults.corruptText;
      if (faults.bom) payload = "\uFEFF" + payload;
      const target = locate(rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // 按字节写，绝不带 BOM（除了显式故障注入）。
      fs.writeFileSync(target, Buffer.from(payload, "utf8"));
    },
    async rename(from, to) {
      if (faults.renameError) throw new StorageError("RENAME_FAILED", "injected rename failure: " + from + " -> " + to);
      const source = locate(from);
      const target = locate(to);
      if (!fs.existsSync(source)) throw new StorageError("ENOENT", "no such file: " + from);
      fs.renameSync(source, target);
    },
    async remove(rel) {
      const target = locate(rel);
      try { fs.unlinkSync(target); } catch (error) { if (!error || error.code !== "ENOENT") throw error; }
    },
    async list(dirRel) {
      const dir = locate(dirRel || ".");
      try { return fs.readdirSync(dir).sort(); } catch { return []; }
    },
    snapshot() {
      const out = {};
      const walk = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix === "" ? entry.name : prefix + "/" + entry.name;
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) { walk(abs, rel); continue; }
          const buffer = fs.readFileSync(abs);
          out[rel] = { bytes: buffer.length, digest: createHash("sha1").update(buffer).digest("hex") };
        }
      };
      if (fs.existsSync(root)) walk(root, "");
      return snapshotOf(out);
    },
  };
  return adapter;
}

/**
 * 策略存储：读写事务都在这里。
 * @param {{adapter: object, logger?: object}} options
 */
export function createPolicyStore(options) {
  const opts = options || {};
  const adapter = opts.adapter;
  if (adapter === undefined) throw new StorageError("EADAPTER", "createPolicyStore requires an adapter");

  let lastRead;
  let poisoned; // { code, message } —— 读到坏文件后进入未读态，默认拒绝写
  let chain = Promise.resolve();
  const serialize = (task) => {
    const run = chain.then(task, task);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  const read = async () => {
    let text;
    try {
      text = await adapter.readText(POLICY_FILE);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        poisoned = undefined;
        lastRead = { ok: true, exists: false, value: undefined, bytes: 0 };
        return lastRead;
      }
      poisoned = { code: "POLICY_UNREADABLE", message: String((error && error.message) || error) };
      lastRead = { ok: false, exists: true, code: poisoned.code, error: poisoned.message };
      return lastRead;
    }
    const stripped = stripBom(text);
    const bomStripped = stripped.length !== text.length;
    const bytes = Buffer.byteLength(stripped, "utf8");
    let value;
    try {
      value = JSON.parse(stripped);
    } catch (error) {
      poisoned = { code: "POLICY_UNREADABLE", message: String((error && error.message) || error) };
      lastRead = { ok: false, exists: true, code: poisoned.code, error: poisoned.message, bomStripped, bytes, text };
      opts.logger?.warn?.("dsh-gate: 策略文件解析失败，保持未读态（不会写回空模板）: " + poisoned.message);
      return lastRead;
    }
    const shape = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value;
    if (shape !== "object") {
      // 合法 JSON 但不是对象：能读出来，但不可写（绝不静默归一成空模板）。
      poisoned = { code: "POLICY_NOT_OBJECT", message: "policy document must be a JSON object, got " + shape };
    } else {
      poisoned = undefined;
    }
    lastRead = { ok: true, exists: true, value, shape, bomStripped, bytes, text };
    return lastRead;
  };

  const status = () => ({
    text: "unread",
    writable: poisoned === undefined,
    poisoned: poisoned === undefined ? undefined : { ...poisoned },
    lastRead: lastRead === undefined ? undefined : { ok: lastRead.ok, exists: lastRead.exists, shape: lastRead.shape },
  });

  const readBackup = async () => {
    let text;
    try { text = await adapter.readText(BACKUP_FILE); }
    catch (error) { return { ok: false, exists: false, code: (error && error.code) || "ENOENT" }; }
    try { return { ok: true, exists: true, value: JSON.parse(stripBom(text)), bytes: Buffer.byteLength(text, "utf8") }; }
    catch (error) { return { ok: false, exists: true, code: "BACKUP_UNREADABLE", error: String((error && error.message) || error) }; }
  };

  const write = (value, writeOptions) => serialize(async () => {
    const spec = writeOptions || {};
    if (!isPlainObject(value)) throw new StorageError("POLICY_NOT_OBJECT", "refusing to write a non-object policy document");
    if (poisoned !== undefined && spec.replaceCorrupt !== true) {
      throw new StorageError(poisoned.code, "policy file is not readable; refusing to overwrite it (" + poisoned.code + ")", { cause: poisoned.message });
    }
    const current = await read();
    if (spec.replaceCorrupt === true && current.ok === false) {
      // 坏文件只能整份替换，且替换前必须把**原文**备份下来（回滚依据）。
      await adapter.writeText(BACKUP_FILE, current.text === undefined ? "" : current.text);
    } else if (current.exists === true && current.ok === true) {
      const previous = JSON.stringify(current.value, null, 2) + "\n";
      const source = current.text === undefined ? previous : current.text;
      await adapter.writeText(BACKUP_FILE, source);
    }
    const text = JSON.stringify(value, null, 2) + "\n";
    if (text.charCodeAt(0) === 0xfeff) throw new StorageError("BOM_LEAK", "policy text must never start with a BOM");
    await adapter.writeText(TEMP_FILE, text);
    try {
      await adapter.rename(TEMP_FILE, POLICY_FILE);
    } catch (error) {
      await adapter.remove(TEMP_FILE);
      throw new StorageError("RENAME_FAILED", "atomic rename failed; original policy kept intact", { cause: String((error && error.message) || error) });
    }
    poisoned = undefined;
    lastRead = { ok: true, exists: true, value, shape: "object", bomStripped: false, bytes: Buffer.byteLength(text, "utf8"), text };
    return { written: true, bytes: Buffer.byteLength(text, "utf8"), digest: sha1(text), text };
  });

  return {
    adapter,
    read,
    write,
    status,
    readBackup,
    snapshot: () => adapter.snapshot(),
    /** 测试/诊断口径：读一次再报状态（不在内部缓存）。 */
    async inspect() { const result = await read(); return { result, status: status() }; },
  };
}
