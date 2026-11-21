/**
 * S2 策略存储接缝（票 01 契约 · 票 02 落地 gate:D1 / D2 / 缺陷 P0-1、P0-2）
 *
 * 唯一落盘边界：策略文件的读、写、备份、原子性、BOM、revision 与并发全部藏在这一个接口后。
 * 文件系统以适配器注入（内存 / 磁盘两种），测试不再直接摸文件。
 *
 * 纪律（本文件即契约）：
 *   1. 读绝不产生「可写回的空模板」：解析失败 / 形状非法 ⇒ 未读态（poisoned），此后默认拒绝写；
 *   2. 坏文件不得被覆盖：只有显式 replaceCorrupt（forceOverwriteCorrupt）才能整份替换，且写前强制备份原文；
 *   3. 写入无 BOM；读取剥 BOM（宿主会 JSON.parse 这个文件）；保留末尾换行；
 *   4. 原子落盘：先写临时文件再 rename；rename 失败保留原文件、清临时文件、报错；
 *   5. 并发写串行：后写者一定看得见前写者；备份链按写入顺序推进；
 *   6. 任意 JSON 输入都不崩：非对象/坏 JSON 只影响「可写性」，不影响「能否读取判定」；
 *   7. 五级读取诊断（absent / ok / bom / syntax / shape / io）+ revision（递增序号 + 内容指纹）
 *      由这里统一给出，policy.js / server.js 不再各自 fs.readFileSync + JSON.parse。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export const POLICY_FILE = "gate.json";
export const BACKUP_FILE = "gate.json.bak";
export const TEMP_FILE = "gate.json.tmp";
/** 读后影子副本（只有 createFilePolicyStore 默认开启；S2 契约测试的工装不带它）。 */
export const SHADOW_FILE = "gate.json.last-good.json";

/** 稳定错误码（控制面据此出 HTTP 状态码，不解析 message）。 */
export const STORAGE_CODES = Object.freeze({
  UNREADABLE: "POLICY_UNREADABLE",
  NOT_OBJECT: "POLICY_NOT_OBJECT",
  IO: "POLICY_IO_ERROR",
  REVISION_CONFLICT: "REVISION_CONFLICT",
  RENAME_FAILED: "RENAME_FAILED",
  NOT_OBJECT_WRITE: "POLICY_NOT_OBJECT",
});

/**
 * 读结果是否属于「不可采用」的损坏态：syntax / shape / io，以及根不是普通对象
 * （S2 为兼容可写性判定把非对象根报成 ok + shape:<非 object>，调用方必须一视同仁）。
 * @param {object|undefined} read createPolicyStore().read()/readSync() 的返回值
 */
export function isCorruptRead(read) {
  if (read === null || typeof read !== "object") return true;
  if (read.status === "syntax" || read.status === "shape" || read.status === "io") return true;
  return read.ok === true && read.shape !== undefined && read.shape !== "object";
}

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
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

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
    readTextSync(rel) {
      if (!files.has(rel)) throw new StorageError("ENOENT", "no such file: " + rel);
      return files.get(rel);
    },
    async readText(rel) { return adapter.readTextSync(rel); },
    writeTextSync(rel, text) {
      let payload = String(text);
      if (faults.corruptText !== undefined) payload = faults.corruptText;
      if (faults.bom) payload = "\uFEFF" + payload;
      files.set(rel, payload);
      snapshot.set(rel, encodeBytes(payload));
    },
    async writeText(rel, text) {
      if (faults.writeDelayMs > 0) await sleep(faults.writeDelayMs);
      adapter.writeTextSync(rel, text);
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
    readTextSync(rel) {
      const target = locate(rel);
      try { return fs.readFileSync(target, "utf8"); }
      catch (error) {
        if (error && error.code === "ENOENT") throw new StorageError("ENOENT", "no such file: " + rel);
        // 权限等 I/O 异常必须保留原始错误码（EACCES / EPERM / EISDIR），不许伪装成文件不存在。
        throw new StorageError(error && error.code ? error.code : "EIO", String((error && error.message) || error), { errno: error && error.errno });
      }
    },
    async readText(rel) { return adapter.readTextSync(rel); },
    writeTextSync(rel, text) {
      let payload = String(text);
      if (faults.corruptText !== undefined) payload = faults.corruptText;
      if (faults.bom) payload = "\uFEFF" + payload;
      const target = locate(rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // 按字节写，绝不带 BOM（除了显式故障注入）。
      fs.writeFileSync(target, Buffer.from(payload, "utf8"));
    },
    async writeText(rel, text) {
      if (faults.writeDelayMs > 0) await sleep(faults.writeDelayMs);
      adapter.writeTextSync(rel, text);
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

/** 由内容算 revision：递增序号 + SHA-256 短指纹（同内容同指纹，跨进程可复现）。 */
export function revisionOf(digest, seq) {
  const number = Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 1;
  return number + "-" + String(digest).slice(0, 16);
}

export function splitRevision(revision) {
  const text = typeof revision === "string" ? revision : "";
  const index = text.indexOf("-");
  if (index <= 0) return undefined;
  const seq = Number(text.slice(0, index));
  if (!Number.isFinite(seq) || seq <= 0) return undefined;
  return { seq, fingerprint: text.slice(index + 1) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 进程级写链：同一绝对路径（磁盘适配器）/ 同一适配器（内存）的写入与「读-改-写」
// 事务必须严格串行。实例级队列不够用 —— 面板每次保存都会新建 store，两个页签并发
// 保存时各自读到旧 revision 再各写一次，后写者会把前写者的键盖回去（A10 / A15 的丢更新）。
// AsyncLocalStorage 让「事务里再调 write」直接内联执行，不会自己等自己而死锁。
// ─────────────────────────────────────────────────────────────────────────────
const diskWriteChains = new Map();
const adapterWriteChains = new WeakMap();

function createWriteChain() {
  const context = new AsyncLocalStorage();
  const chain = {
    // 这条路径上见过的最大 revision 序号：进程内新 store 实例也必须接着往前编。
    seq: 0,
    /** 已在同一条链里执行时直接内联（避免事务里调用 write 造成自锁）。 */
    serialize(task) {
      if (context.getStore() === chain) return task();
      const run = tail.then(() => context.run(chain, task), () => context.run(chain, task));
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
  let tail = Promise.resolve();
  return chain;
}

function writeChainFor(adapter, policyFile) {
  if (adapter && adapter.kind === "disk" && typeof adapter.root === "string") {
    const key = path.resolve(adapter.root, policyFile);
    let chain = diskWriteChains.get(key);
    if (chain === undefined) { chain = createWriteChain(); diskWriteChains.set(key, chain); }
    return chain;
  }
  let perAdapter = adapterWriteChains.get(adapter);
  if (perAdapter === undefined) { perAdapter = new Map(); adapterWriteChains.set(adapter, perAdapter); }
  let chain = perAdapter.get(policyFile);
  if (chain === undefined) { chain = createWriteChain(); perAdapter.set(policyFile, chain); }
  return chain;
}

/**
 * 策略存储：读写事务都在这里。
 *
 * @param {{
 *   adapter: object,
 *   logger?: object,
 *   policyFile?: string,
 *   uniqueTemp?: boolean,
 *   skipUnchanged?: boolean,
 *   shadow?: boolean,
 * }} options
 */
export function createPolicyStore(options) {
  const opts = options || {};
  const adapter = opts.adapter;
  if (adapter === undefined) throw new StorageError("EADAPTER", "createPolicyStore requires an adapter");
  const policyFile = typeof opts.policyFile === "string" && opts.policyFile.length > 0 ? opts.policyFile : POLICY_FILE;
  const backupFile = policyFile === POLICY_FILE ? BACKUP_FILE : policyFile + ".bak";
  const tempBase = policyFile === POLICY_FILE ? TEMP_FILE : policyFile + ".tmp";
  const shadowFile = policyFile === POLICY_FILE ? SHADOW_FILE : policyFile + ".last-good.json";
  const uniqueTemp = opts.uniqueTemp === true;
  const skipUnchanged = opts.skipUnchanged === true;
  const shadowEnabled = opts.shadow === true;
  let tempSeq = 0;

  let lastRead;
  let poisoned; // { code, message, status, reason } —— 读到坏文件后进入未读态，默认拒绝写
  let lastRevision; // { revision, seq, digest }
  // 写链按路径进程级共享（见 writeChainFor）：并发 savePolicy 也严格串行，后写者看得见前者。
  const writeChain = writeChainFor(adapter, policyFile);
  const serialize = (task) => writeChain.serialize(task);

  const readShadowSync = () => {
    try {
      const text = adapter.readTextSync(shadowFile);
      const parsed = JSON.parse(stripBom(text));
      if (!isPlainObject(parsed)) return { ok: false, code: "SHADOW_INVALID" };
      const seq = Number.isFinite(parsed.seq) ? Math.floor(parsed.seq) : 0;
      return {
        ok: true,
        revision: typeof parsed.revision === "string" ? parsed.revision : undefined,
        seq,
        digest: typeof parsed.digest === "string" ? parsed.digest : undefined,
        policy: isPlainObject(parsed.policy) ? parsed.policy : undefined,
      };
    } catch { return { ok: false, code: "SHADOW_ABSENT" }; }
  };

  const seedRevision = () => {
    const shadow = readShadowSync();
    if (shadow.ok === true && typeof shadow.revision === "string" && Number.isFinite(shadow.seq)) {
      lastRevision = { revision: shadow.revision, seq: shadow.seq, digest: shadow.digest };
    }
  };
  seedRevision();

  /** 读一次并做五级分类（同步内核：resolvePolicy 是同步调用）。 */
  const readSync = () => {
    // 新实例第一次读：先用影子副本对齐 revision 序号，否则「磁盘上已有 N 号版本」会被
    // 算成 1 号，两个实例并发写就会各自从同一个序号往前编（见 write 的 chain.seq 兜底）。
    if (lastRevision === undefined) {
      const shadow = readShadowSync();
      if (shadow.ok === true && Number.isFinite(shadow.seq) && shadow.seq > 0) {
        lastRevision = { revision: shadow.revision, seq: shadow.seq, digest: shadow.digest };
      }
    }
    let text;
    try {
      text = adapter.readTextSync(policyFile);
    } catch (error) {
      const code = error && error.code ? String(error.code) : "EIO";
      if (code === "ENOENT") {
        poisoned = undefined;
        lastRead = { ok: true, exists: false, value: undefined, bytes: 0, status: "absent", reason: "file-absent" };
        return lastRead;
      }
      // I/O 异常（EACCES / EPERM / EISDIR…）：精确区分，不伪装成「文件不存在」。
      poisoned = { code: STORAGE_CODES.IO, message: String((error && error.message) || error), status: "io", reason: code, errorCode: code };
      lastRead = {
        ok: false,
        exists: true,
        code: poisoned.code,
        error: poisoned.message,
        status: "io",
        reason: code,
        ioCode: code,
      };
      opts.logger?.warn?.("dsh-gate: 策略文件 I/O 失败（" + code + "），保持未读态: " + poisoned.message);
      return lastRead;
    }
    const stripped = stripBom(text);
    const bomStripped = stripped.length !== text.length;
    const bytes = Buffer.byteLength(stripped, "utf8");
    let value;
    try {
      value = JSON.parse(stripped);
    } catch (error) {
      const detail = String((error && error.message) || error);
      // 语法错误保留精确位置（JSON.parse 的 message 自带 position，Node 24 起带 line/column）。
      const position = /position\s+(\d+)/i.exec(detail);
      const location = error && Number.isFinite(error.lineNumber)
        ? { line: error.lineNumber, column: error.columnNumber }
        : position
          ? { offset: Number(position[1]) }
          : undefined;
      poisoned = { code: STORAGE_CODES.UNREADABLE, message: detail, status: "syntax", reason: "syntax-error", location };
      lastRead = {
        ok: false,
        exists: true,
        code: poisoned.code,
        error: detail,
        status: "syntax",
        reason: "syntax-error",
        location,
        bomStripped,
        bytes,
        text,
      };
      opts.logger?.warn?.("dsh-gate: 策略文件解析失败，保持未读态（不会写回空模板）: " + detail);
      return lastRead;
    }
    const shape = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value;
    const digest = sha256(stripped);
    let revision;
    if (lastRevision !== undefined && lastRevision.digest === digest) {
      revision = lastRevision.revision;
    } else {
      revision = revisionOf(digest, lastRevision === undefined ? 1 : lastRevision.seq + 1);
    }
    if (shape !== "object") {
      // 合法 JSON 但不是对象：能读出来，但不可写（绝不静默归一成空模板）。
      poisoned = { code: STORAGE_CODES.NOT_OBJECT, message: "policy document must be a JSON object, got " + shape, status: "shape", reason: "root-not-object" };
    } else {
      poisoned = undefined;
    }
    lastRead = {
      ok: true,
      exists: true,
      value,
      shape,
      bomStripped,
      bytes,
      text,
      digest,
      revision,
      status: bomStripped ? "bom" : "ok",
      reason: bomStripped ? "utf8-bom-stripped" : "ok",
      hadBom: bomStripped,
    };
    return lastRead;
  };

  const read = async () => readSync();

  const status = () => ({
    text: "unread",
    writable: poisoned === undefined,
    poisoned: poisoned === undefined ? undefined : { ...poisoned },
    diagnostic: readDiagnostic(),
    revision: lastRead === undefined ? undefined : lastRead.revision,
    lastRead: lastRead === undefined ? undefined : { ok: lastRead.ok, exists: lastRead.exists, shape: lastRead.shape },
  });

  /** 五级读取诊断（absent / ok / bom / syntax / shape / io），供 GET /policy 与 gate_status 使用。 */
  const readDiagnostic = () => {
    if (lastRead === undefined) return { status: "unknown", reason: "not-read", path: policyFile, ok: undefined, hadBom: false };
    return {
      status: lastRead.status || (lastRead.ok === false ? "syntax" : "ok"),
      reason: lastRead.reason || (lastRead.ok === false ? "syntax-error" : "ok"),
      path: policyFile,
      ok: lastRead.ok,
      exists: lastRead.exists,
      hadBom: lastRead.hadBom === true || lastRead.bomStripped === true,
      code: lastRead.code,
      location: lastRead.location,
      ioCode: lastRead.ioCode,
    };
  };

  const readBackup = async () => {
    let text;
    try { text = await adapter.readText(backupFile); }
    catch (error) { return { ok: false, exists: false, code: (error && error.code) || "ENOENT" }; }
    try { return { ok: true, exists: true, value: JSON.parse(stripBom(text)), bytes: Buffer.byteLength(text, "utf8") }; }
    catch (error) { return { ok: false, exists: true, code: "BACKUP_UNREADABLE", error: String((error && error.message) || error) }; }
  };

  const writeShadowSync = (policy, revision) => {
    if (shadowEnabled !== true) return { written: false };
    if (!isPlainObject(policy)) return { written: false };
    const digest = sha256(JSON.stringify(policy, null, 2) + "\n");
    const info = revision !== undefined && typeof revision === "object" ? revision : lastRevision;
    const seq = info && Number.isFinite(info.seq) && info.seq > 0 ? info.seq : 1;
    const record = {
      revision: info && typeof info.revision === "string" ? info.revision : revisionOf(digest, seq),
      seq,
      digest,
      policy,
    };
    const text = JSON.stringify(record, null, 2) + "\n";
    const existing = (() => {
      try { return adapter.readTextSync(shadowFile); } catch { return undefined; }
    })();
    if (existing === text) return { written: false, revision: record.revision };
    const temp = shadowFile + ".tmp";
    adapter.writeTextSync(temp, text);
    // 影子副本的 rename 是同步的（resolvePolicy 是同步调用）；
    // 磁盘适配器的 rename/remove 只有异步版，所以这里直接走 fs（内存适配器则保持内存语义）。
    if (adapter.kind === "disk" && typeof adapter.root === "string") {
      fs.renameSync(path.resolve(adapter.root, temp), path.resolve(adapter.root, shadowFile));
    } else {
      if (typeof adapter.renameSync === "function") adapter.renameSync(temp, shadowFile);
      else {
        adapter.writeTextSync(shadowFile, text);
        try { adapter.removeSync ? adapter.removeSync(temp) : undefined; } catch { /* 忽略 */ }
      }
    }
    return { written: true, revision: record.revision };
  };

  const write = (value, writeOptions) => serialize(async () => {
    const spec = writeOptions || {};
    if (!isPlainObject(value)) throw new StorageError(STORAGE_CODES.NOT_OBJECT_WRITE, "refusing to write a non-object policy document");
    if (poisoned !== undefined && spec.replaceCorrupt !== true) {
      throw new StorageError(poisoned.code, "policy file is not readable; refusing to overwrite it (" + poisoned.code + ")", { cause: poisoned.message });
    }
    const current = await readSync();
    const expected = spec.expectedRevision !== undefined ? spec.expectedRevision : spec.ifMatch;
    if (expected !== undefined && expected !== null && current.revision !== expected) {
      throw new StorageError(STORAGE_CODES.REVISION_CONFLICT, "policy revision conflict: expected " + expected + ", actual " + current.revision, {
        expectedRevision: expected,
        currentRevision: current.revision,
        // A17：409 回执要带「这次想改的键」，让面板能提示刷新后差异在哪。
        changedKeys: Array.isArray(spec.changedKeys) ? spec.changedKeys : [],
      });
    }
    const previous = current.ok === true && current.value !== undefined
      ? JSON.stringify(current.value, null, 2) + "\n"
      : undefined;
    const text = JSON.stringify(value, null, 2) + "\n";
    if (text.charCodeAt(0) === 0xfeff) throw new StorageError("BOM_LEAK", "policy text must never start with a BOM");
    // 内容没变就不写盘、不产生新 revision、不再堆备份（S2 回执 changed=false）。
    if (skipUnchanged === true && current.exists === true && current.ok === true && stripBom(current.text) === text) {
      const currentSeq = splitRevision(current.revision)?.seq || 1;
      writeChain.seq = Math.max(writeChain.seq || 0, currentSeq);
      lastRevision = { revision: current.revision, seq: currentSeq, digest: current.digest };
      const receipt = {
        written: false,
        changed: false,
        bytes: Buffer.byteLength(text, "utf8"),
        digest: sha1(text),
        text,
        revision: current.revision,
        previousRevision: current.revision,
        changedKeys: [],
        warnings: Array.isArray(spec.warnings) ? spec.warnings : [],
      };
      lastRead = Object.assign({}, current, { revision: current.revision });
      return receipt;
    }
    if (spec.replaceCorrupt === true && current.ok === false) {
      // 坏文件只能整份替换，且替换前必须把**原文**备份下来（回滚依据）。
      await adapter.writeText(backupFile, current.text === undefined ? "" : current.text);
    } else if (current.exists === true && current.ok === true) {
      const source = current.text === undefined ? previous : current.text;
      if (policyFile === POLICY_FILE) {
        await adapter.writeText(BACKUP_FILE, source);
      } else {
        await adapter.writeText(backupFile, source);
      }
    }
    const tempName = uniqueTemp === true ? tempBase + "." + process.pid + "." + (++tempSeq) : tempBase;
    await adapter.writeText(tempName, text);
    try {
      await adapter.rename(tempName, policyFile);
    } catch (error) {
      await adapter.remove(tempName);
      throw new StorageError("RENAME_FAILED", "atomic rename failed; original policy kept intact", { cause: String((error && error.message) || error) });
    }
    poisoned = undefined;
    const digest = sha256(text);
    // 序号取「内存里见过的最大序号」与「磁盘当前 revision 的序号」的较大者 +1：
    // 新 store 实例刚 seed 过影子副本，也不能让两个实例各自从同一个 seq 往前写。
    const diskSeq = splitRevision(current.revision)?.seq || 0;
    const chainSeq = Number.isFinite(writeChain.seq) ? writeChain.seq : 0;
    const seq = Math.max(lastRevision === undefined ? 0 : lastRevision.seq, diskSeq, chainSeq) + 1;
    writeChain.seq = seq;
    const revision = revisionOf(digest, seq);
    lastRevision = { revision, seq, digest };
    lastRead = {
      ok: true,
      exists: true,
      value,
      shape: "object",
      bomStripped: false,
      bytes: Buffer.byteLength(text, "utf8"),
      text,
      digest,
      revision,
      status: "ok",
      reason: "ok",
      hadBom: false,
    };
    if (shadowEnabled === true) writeShadowSync(value, lastRevision);
    return {
      written: true,
      changed: true,
      bytes: Buffer.byteLength(text, "utf8"),
      digest: sha1(text),
      text,
      revision,
      previousRevision: current.revision,
      changedKeys: Array.isArray(spec.changedKeys) ? spec.changedKeys : [],
      warnings: Array.isArray(spec.warnings) ? spec.warnings : [],
    };
  });

  return {
    adapter,
    policyFile,
    backupFile,
    shadowFile,
    read,
    readSync,
    readDiagnostic,
    write,
    /** 串行事务入口：同路径的读-改-写整体排队（savePolicy 用）。 */
    exclusive: serialize,
    status,
    readBackup,
    readShadowSync,
    writeShadowSync,
    revision: () => (lastRevision === undefined ? undefined : lastRevision.revision),
    snapshot: () => adapter.snapshot(),
    /** 测试/诊断口径：读一次再报状态（不在内部缓存）。 */
    async inspect() { const result = await read(); return { result, status: status() }; },
  };
}

/**
 * 文件级策略存储（policy.js / server.js 的默认装配）：磁盘适配器 + 唯一临时文件 +
 * 无变化不写盘 + 读后影子副本。路径可以是自定义文件名（插件行 config.policyFile）。
 *
 * @param {{file: string, logger?: object, shadow?: boolean, extraFile?: string}} options
 */
export function createFilePolicyStore(options) {
  const opts = options || {};
  if (typeof opts.file !== "string" || opts.file.trim().length === 0) throw new StorageError("EFAULT", "createFilePolicyStore requires a file path");
  const file = path.resolve(opts.file.trim());
  const adapter = createDiskStorageAdapter({ root: path.dirname(file) });
  return createPolicyStore({
    adapter,
    logger: opts.logger,
    policyFile: path.basename(file),
    uniqueTemp: true,
    skipUnchanged: true,
    shadow: opts.shadow !== false,
  });
}

/** 备份保留上限：按文件名前缀挑出最旧的若干份删掉（v2 迁移备份用，默认 20）。 */
export function pruneBackups(dir, prefix, limit) {
  if (typeof dir !== "string" || typeof prefix !== "string") return [];
  const max = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : 20;
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => name.startsWith(prefix)).sort(); } catch { return []; }
  const removed = [];
  while (names.length > max) {
    const victim = names.shift();
    try { fs.unlinkSync(path.join(dir, victim)); removed.push(victim); } catch { /* 单个删不掉不影响主流程 */ }
  }
  return removed;
}
