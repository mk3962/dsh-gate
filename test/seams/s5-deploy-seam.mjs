/**
 * S5 · 部署脚本假 HOME 基座（#01 / gate:D5）
 *
 * 目标：让 install.ps1 / uninstall.ps1 能在**完全不碰真实 ~/.dsh** 的前提下被真实执行。
 *  - createFakeHome()：临时根 + 最小 profile / cordis.patch.yml / node_modules / plugins 树；
 *  - 字节快照：snapshot + diff，用来证明 -DryRun 零写入、插入/摘除往返字节不变量；
 *  - 真跑脚本：node:child_process 调 Windows PowerShell（-DryRun），结构化拿 exit/stdout；
 *  - 静态不变量：无 BOM 写盘、DryRun 在第一次写之前、patch 行插入与摘除的形状对称。
 *
 * 已实证的真缺陷（本票只登记、#08 修）：install 写的是缩进的 "    - id: surface-gate"，
 * 而 uninstall 的 $hasPatchRow / 摘除循环 / 回读校验都用 ^-\s*id:（只认顶层）→ 卸不掉。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../..");
export const SCRIPTS = Object.freeze({
  install: path.join(REPO_ROOT, "scripts/install.ps1"),
  uninstall: path.join(REPO_ROOT, "scripts/uninstall.ps1"),
});

/** install.ps1 第 137/278/298 行用的形状（缩进行也算）。 */
export const INSTALL_PATCH_PATTERN = /^\s*-\s*id:\s*surface-gate\s*$/m;
/** uninstall.ps1 第 70/183/204 行用的形状（只认顶层，缩进行不匹配 = 真缺陷）。 */
export const UNINSTALL_PATCH_PATTERN = /^-\s*id:\s*surface-gate\s*$/m;
/** 修复后的形状（#08 的目标）：缩进/顶层都认。 */
export const FIXED_PATCH_PATTERN = /^\s*-\s*id:\s*surface-gate\s*$/m;

export const PATCH_ROW = Object.freeze({
  text: ["- insert:", "    - id: surface-gate", "      name: dsh-gate", "      disabled: false"].join("\n"),
});

export class DeploySeamError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = "DeploySeamError";
    this.code = code;
    this.extra = extra;
  }
}

const sha1 = (buffer) => crypto.createHash("sha1").update(buffer).digest("hex");
const hasBom = (buffer) => buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;

const isInside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** 绝对不许把夹具根指向真实 DSH 用户目录。 */
export function assertIsolatedRoot(root) {
  const realHome = path.join(os.homedir(), ".dsh");
  const resolved = path.resolve(root);
  if (isInside(realHome, resolved) || isInside(resolved, realHome)) {
    throw new DeploySeamError("REAL_HOME_FORBIDDEN", "拒绝把夹具根指向真实 ~/.dsh：" + resolved);
  }
  if (!isInside(os.tmpdir(), resolved)) {
    throw new DeploySeamError("ROOT_OUTSIDE_TMP", "假 HOME 必须落在系统临时目录内：" + resolved);
  }
  return resolved;
}

/** 所有夹具写操作只能落在根内，防手滑改到真实 profile。 */
export function assertInsideRoot(root, target) {
  assertIsolatedRoot(root);
  if (!isInside(root, target)) {
    throw new DeploySeamError("TARGET_OUTSIDE_ROOT", "目标不在假 HOME 内：" + target);
  }
  return path.resolve(target);
}

const DEFAULT_PROFILE_PACKAGE = {
  name: "desktop",
  version: "0.0.0",
  dsh: { profile: { bundles: ["dsh-core"] } },
  dependencies: {},
};

/**
 * 建隔离假 HOME：
 *   <root>/.dsh/profiles/desktop/{package.json, cordis.patch.yml, node_modules/, plugins/}
 *   <root>/.dsh/{gate.json?}
 */
export function createFakeHome(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), (options.prefix || "dsh-gate-home-")));
  assertIsolatedRoot(root);
  const dshHome = path.join(root, ".dsh");
  const profileDir = path.join(dshHome, "profiles", options.profileName || "desktop");
  const nodeModules = path.join(profileDir, "node_modules");
  const pluginsDir = path.join(profileDir, "plugins");
  for (const dir of [profileDir, nodeModules, pluginsDir]) fs.mkdirSync(dir, { recursive: true });

  const manifest = options.manifest || DEFAULT_PROFILE_PACKAGE;
  writeTextNoBom(profileDir, "package.json", JSON.stringify(manifest, null, 2) + "\n");
  const patchText = options.patchText === undefined ? "[]\n" : options.patchText;
  writeTextNoBom(profileDir, "cordis.patch.yml", patchText);
  // 最小插件目录：宿主解析插件时至少要看得到这些名字。
  fs.writeFileSync(path.join(pluginsDir, "dsh-core"), "");
  if (options.gateJson !== undefined) writeTextNoBom(dshHome, "gate.json", options.gateJson);

  const home = {
    root,
    dshHome,
    profileDir,
    nodeModules,
    pluginsDir,
    manifestPath: path.join(profileDir, "package.json"),
    patchPath: path.join(profileDir, "cordis.patch.yml"),
    gateJsonPath: path.join(dshHome, "gate.json"),
    path: (relative) => assertInsideRoot(root, path.join(root, relative)),
    read(relative) { return fs.readFileSync(path.join(root, relative), "utf8"); },
    readBytes(relative) { return fs.readFileSync(path.join(root, relative)); },
    exists(relative) { return fs.existsSync(path.join(root, relative)); },
    snapshot: () => snapshotTree(root),
    cleanup() {
      assertIsolatedRoot(root);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  return home;
}

export function writeTextNoBom(root, relative, text) {
  const target = assertInsideRoot(root, path.join(root, relative));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, { encoding: "utf8", flag: "w" });
  return assertInsideRoot(root, target);
}

export function writeTextWithBom(root, relative, text) {
  const target = assertInsideRoot(root, path.join(root, relative));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]));
  return assertInsideRoot(root, target);
}

/** 字节级快照：文件名排序 + sha1 + 是否 BOM，供「零写入」「往返一致」判定。 */
export function snapshotTree(root) {
  assertIsolatedRoot(root);
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const buffer = fs.readFileSync(full);
      files.push({
        path: path.relative(root, full).split(path.sep).join("/"),
        bytes: buffer.length,
        sha1: sha1(buffer),
        bom: hasBom(buffer),
        mtimeMs: Math.round(fs.statSync(full).mtimeMs),
      });
    }
  };
  walk(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root: path.resolve(root), files };
}

/** 只比内容（不算 mtime）：-DryRun 的判据是字节不变。 */
export function snapshotDigest(snapshot) {
  return sha1(Buffer.from(JSON.stringify(snapshot.files.map((file) => [file.path, file.sha1, file.bytes, file.bom]))));
}

export function diffSnapshots(before, after) {
  const mapBefore = new Map(before.files.map((file) => [file.path, file]));
  const mapAfter = new Map(after.files.map((file) => [file.path, file]));
  const paths = Array.from(new Set([...mapBefore.keys(), ...mapAfter.keys()])).sort();
  const changes = [];
  for (const filePath of paths) {
    const a = mapBefore.get(filePath);
    const b = mapAfter.get(filePath);
    if (!a && b) { changes.push({ path: filePath, change: "added", after: b }); continue; }
    if (a && !b) { changes.push({ path: filePath, change: "removed", before: a }); continue; }
    if (a.sha1 !== b.sha1 || a.bytes !== b.bytes || a.bom !== b.bom) changes.push({ path: filePath, change: "modified", before: a, after: b });
  }
  return changes;
}

export function snapshotsEqual(before, after) {
  return diffSnapshots(before, after).length === 0;
}

/* ── 真跑 PowerShell ─────────────────────────────────────────────────── */

let cachedShell = null;
function resolvePowerShell() {
  if (cachedShell) return cachedShell;
  for (const candidate of ["powershell.exe", "pwsh.exe", "powershell", "pwsh"]) {
    const probe = spawnSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8", timeout: 20000 });
    if (!probe.error && probe.status === 0) { cachedShell = candidate; return candidate; }
  }
  throw new DeploySeamError("NO_POWERSHELL", "找不到可用的 Windows PowerShell（powershell.exe / pwsh）");
}

export function powershellVersion() {
  const shell = resolvePowerShell();
  const probe = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", timeout: 20000 });
  return { shell, version: (probe.stdout || "").trim() };
}

/** 先按 UTF-8 解；出现替换字符说明原输出是 GBK（PowerShell 5.1 默认控制台代码页）。 */
export function decodeOutput(buffer) {
  if (!buffer || buffer.length === 0) return "";
  const utf8 = Buffer.from(buffer).toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try { return new TextDecoder("gbk").decode(Buffer.from(buffer)); } catch { return utf8; }
}

/**
 * 真跑仓库里的脚本。参数数组直传，避免手拼命令行把带空格的路径拆坏。
 * 返回结构化的 exit/stdout/stderr，并默认记录假 HOME 的前后字节快照。
 */
export function runPowerShellScript(script, args, options = {}) {
  const shell = resolvePowerShell();
  const file = typeof script === "string" && SCRIPTS[script] ? SCRIPTS[script] : script;
  if (!fs.existsSync(file)) throw new DeploySeamError("SCRIPT_MISSING", "脚本不存在：" + file);
  const command = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file].concat(args || []);
  const home = options.home || null;
  const before = home ? snapshotTree(home.root) : null;
  const startedAt = Date.now();
  const child = spawnSync(shell, command, {
    cwd: options.cwd || REPO_ROOT,
    env: Object.assign({}, process.env, options.env || {}),
    // Windows PowerShell 5.1 重定向输出走控制台代码页（中文机器是 GBK），不能盲按 UTF-8 解。
    encoding: "buffer",
    timeout: options.timeoutMs || 180000,
    windowsHide: true,
  });
  const durationMs = Date.now() - startedAt;
  const after = home ? snapshotTree(home.root) : null;
  return {
    shell,
    command: [shell].concat(command),
    status: child.status,
    stdout: decodeOutput(child.stdout),
    stderr: decodeOutput(child.stderr),
    error: child.error ? String(child.error.message || child.error) : "",
    durationMs,
    before,
    after,
    changes: before && after ? diffSnapshots(before, after) : [],
  };
}

/** -DryRun 的标准调用：只读预览，必须 exit 0 且字节零变化。 */
export function runDryRun(home, kind, extraArgs = []) {
  const args = ["-Profile", home.profileDir, "-GateHome", home.dshHome, "-DryRun"].concat(extraArgs);
  return runPowerShellScript(kind, args, { home });
}

/* ── patch 行解析与插入/摘除模拟 ──────────────────────────────────────── */

/** 粗解析 cordis.patch.yml 里的行：认 "- id: xxx"（任意缩进）及其后续同块键。 */
export function parsePatchRows(text) {
  const rows = [];
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^(\s*)-\s*id:\s*(\S+)\s*$/.exec(line);
    if (!match) continue;
    const indent = match[1].length;
    const row = { id: match[2], indent, line: index + 1, topLevel: indent === 0, fields: {} };
    for (let next = index + 1; next < lines.length; next += 1) {
      const inner = lines[next];
      if (!inner.trim()) continue;
      const innerIndent = inner.length - inner.trimStart().length;
      if (innerIndent <= indent) break;
      const kv = /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(inner);
      if (kv) row.fields[kv[1]] = kv[2];
    }
    rows.push(row);
  }
  return rows;
}

export function patchRowMatches(text, pattern) {
  return pattern.test(String(text));
}

export function findSurfaceGateRows(text) {
  return parsePatchRows(text).filter((row) => row.id === "surface-gate");
}

/** 模拟 install 的追加语义（幂等：已有行就不再追加）。 */
export function applyPatchInsertion(text, rowText = PATCH_ROW.text) {
  const current = String(text);
  const trimmed = current.trim();
  if (INSTALL_PATCH_PATTERN.test(current)) return { text: current, inserted: false, reason: "already-present" };
  if (trimmed === "[]" || trimmed === "") return { text: rowText + "\n", inserted: true, reason: "empty-array" };
  const nl = current.endsWith("\n") ? "" : "\n";
  return { text: current + nl + rowText + "\n", inserted: true, reason: "appended" };
}

/**
 * 模拟 uninstall 的「摘掉自己写的块」：
 *  - pattern 决定能不能认出目标行（默认用脚本里的破正则）；
 *  - pruneEmptyInsert 模拟正确实现：整块只剩 "- insert:" 时把空块一起摘掉，
 *    否则哪怕行删了，孤立的 - insert: 也会让宿主解析炸（这是现有脚本的第二层缺陷）。
 */
export function removeSurfaceGateRows(text, options = {}) {
  const pattern = options.pattern || UNINSTALL_PATCH_PATTERN;
  const pruneEmptyInsert = options.pruneEmptyInsert !== false;
  const lines = String(text).split("\n");
  const kept = [];
  let skipping = false;
  let removed = 0;
  for (const line of lines) {
    if (pattern.test(line)) { skipping = true; removed += 1; continue; }
    if (skipping) {
      if (/^\s+\S/.test(line)) continue;
      skipping = false;
    }
    kept.push(line);
  }
  let pruned = 0;
  if (pruneEmptyInsert && removed > 0) {
    const out = [];
    for (let index = 0; index < kept.length; index += 1) {
      const line = kept[index];
      if (!/^- insert:\s*$/.test(line)) { out.push(line); continue; }
      // 看这一块后面还有没有缩进子行：没有就是空块，整块删掉。
      let hasChild = false;
      for (let next = index + 1; next < kept.length; next += 1) {
        const probe = kept[next];
        if (!probe.trim()) continue;
        if (/^\s+\S/.test(probe)) { hasChild = true; }
        break;
      }
      if (hasChild) { out.push(line); continue; }
      pruned += 1;
    }
    kept.length = 0;
    kept.push.apply(kept, out);
  }
  let result = kept.join("\n").replace(/\n+$/, "");
  if (result.trim() === "") result = "[]";
  return { text: result + "\n", removed, pruned, patternSource: String(pattern) };
}

export function readScript(file) {
  const target = SCRIPTS[file] || file;
  return fs.readFileSync(target, "utf8");
}

/** 第一次「写盘 cmdlet」的位置：DryRun 必须在它之前 exit。 */
export function firstWriteIndex(source) {
  const patterns = [/\bNew-Item\b/, /\bCopy-Item\b/, /\bMove-Item\b/, /\bSet-Content\b/, /\bAdd-Content\b/, /\bOut-File\b/, /\[System\.IO\.File\]::WriteAllText/];
  let first = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match && (first < 0 || match.index < first)) first = match.index;
  }
  return first;
}

export function dryRunGuardIndex(source) {
  return source.indexOf("if ($DryRun)");
}

/** 真实 ~/.dsh 的只读指纹：只用于「真跑脚本没碰它」的旁证，不存在就返回 null。 */
export function realHomeFingerprint() {
  const realHome = path.join(os.homedir(), ".dsh");
  const profile = path.join(realHome, "profiles", "desktop");
  const targets = [path.join(profile, "package.json"), path.join(profile, "cordis.patch.yml"), path.join(realHome, "gate.json")];
  const entries = [];
  for (const target of targets) {
    if (!fs.existsSync(target)) { entries.push({ path: target, exists: false }); continue; }
    const buffer = fs.readFileSync(target);
    entries.push({ path: target, exists: true, bytes: buffer.length, sha1: sha1(buffer) });
  }
  return entries;
}