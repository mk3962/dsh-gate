/**
 * S5 · 部署脚本假 HOME 基座（#08 版，替换 dsh-gate-dev/test/seams/s5-deploy-seam.mjs 的旧版）
 *
 * 自足：所有路径从本文件位置推 REPO_ROOT，任何仓库（含 .scratch/prep-08-deploy）都能直接跑。
 *  - createFakeHome()：临时根 + 最小 profile / cordis.patch.yml / node_modules / plugins 树；
 *  - createPluginSource()：可安装的插件源码夹具（package.json files 白名单 + 必需文件）；
 *  - 字节快照：snapshotTree + diff，用来证明 -DryRun 零写入、装卸往返字节不变量；
 *  - 真跑脚本：node:child_process 异步调 Windows PowerShell，结构化拿 exit/stdout（spawnSync 会锁事件循环，改 spawn 后用例级并发才生效）；
 *  - 故障注入：DSH_GATE_TEST_FAIL_STEP / DSH_GATE_TEST_PROCESS_PROBE 走安装事务的回滚路径。
 *
 * 编码约定：PowerShell 5.1 重定向输出走控制台代码页（中文机器 GBK），统一用 decodeOutput 解。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../..");
export const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");
export const SCRIPTS = Object.freeze({
  install: path.join(SCRIPTS_DIR, "install.ps1"),
  uninstall: path.join(SCRIPTS_DIR, "uninstall.ps1"),
  module: path.join(SCRIPTS_DIR, "dsh-gate-deploy.psm1"),
  activate: path.join(SCRIPTS_DIR, "activate.cmd"),
  rollback: path.join(SCRIPTS_DIR, "rollback.cmd"),
});

/** 修复后的唯一形状（#08）：缩进/顶层都认；install、uninstall、回读校验共用同一个 \s*。 */
export const FIXED_PATCH_PATTERN = /^\s*-\s*id:\s*surface-gate\s*(?:#.*)?$/m;

/** install 写入的补丁块（4 空格缩进，宿主 cordis.patch 的既有风格）。 */
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

export const DEFAULT_PROFILE_PACKAGE = Object.freeze({
  name: "desktop",
  version: "0.0.0",
  dsh: { profile: { bundles: ["dsh-core"] } },
  dependencies: {},
});

/** 建隔离假 HOME：<root>/.dsh/profiles/<name>/{package.json,cordis.patch.yml,node_modules,plugins}。 */
export function createFakeHome(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix || "dsh-gate-home-"));
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
    junctionPath: path.join(nodeModules, "dsh-gate"),
    sourceDir: path.join(dshHome, "local-plugins", "dsh-gate"),
    backupRoot: path.join(root, "backups"),
    path: (relative) => assertInsideRoot(root, path.join(root, relative)),
    read(relative) { return fs.readFileSync(path.join(root, relative), "utf8"); },
    readBytes(relative) { return fs.readFileSync(path.join(root, relative)); },
    exists(relative) { return fs.existsSync(path.join(root, relative)); },
    snapshot: () => snapshotTree(root),
    profileSnapshot: () => snapshotTree(profileDir),
    cleanup() {
      assertIsolatedRoot(root);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  return home;
}

/** 可安装的插件源码夹具：与真实 dsh-gate 的 package.json files 白名单同形。 */
export function createPluginSource(home, options = {}) {
  const dir = path.join(home.root, options.name || "plugin-src");
  const pkg = {
    name: "dsh-gate",
    version: "0.6.0",
    type: "module",
    main: "lib/index.js",
    exports: { ".": "./lib/index.js", "./client": "./client/index.js" },
    files: ["lib/", "client/", "cordis.patch.yml", "gate.example.json", "README.md"],
    dsh: { bundle: { patch: "cordis.patch.yml" } },
    description: "S5 fixture",
    license: "MIT",
  };
  const files = options.files || pkg.files;
  if (options.packageJson) Object.assign(pkg, options.packageJson);
  const content = {
    "package.json": JSON.stringify(pkg, null, 2) + "\n",
    "lib/index.js": "export const name = 'dsh-gate';\nexport function apply() {}\n",
    "client/index.js": "window.__ModuleLoader__.load({ id: 'dsh-gate' });\n",
    "cordis.patch.yml": options.sourcePatch || "- insert:\n    - id: dsh-gate-source-row\n      name: dsh-gate\n      disabled: false\n",
    "gate.example.json": '{ "version": 3, "enabled": true, "defaults": { "resident": [] } }\n',
    "README.md": "# dsh-gate (fixture)\n",
    "LICENSE": "MIT\n",
  };
  for (const [relative, text] of Object.entries(content)) {
    if (relative !== "package.json" && !files.includes(relative) && !files.includes(relative.split("/")[0] + "/")) continue;
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), text, "utf8");
  }
  return { dir, packageJson: pkg, files };
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

/**
 * 字节级快照：路径排序 + sha1 + 是否 BOM。
 * junction / 符号链接只记录链接目标，绝不下钻（否则会读到链接另一侧的真实源码）。
 */
export function snapshotTree(root) {
  assertIsolatedRoot(root);
  const files = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(dir, entry.name);
      const relative = rel ? rel + "/" + entry.name : entry.name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        files.push({ path: relative, bytes: 0, sha1: "link:" + fs.readlinkSync(full), bom: false, link: true, mtimeMs: Math.round(stat.mtimeMs) });
        continue;
      }
      if (stat.isDirectory()) { walk(full, relative); continue; }
      const buffer = fs.readFileSync(full);
      files.push({ path: relative, bytes: buffer.length, sha1: sha1(buffer), bom: hasBom(buffer), mtimeMs: Math.round(stat.mtimeMs) });
    }
  };
  walk(root, "");
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
export function resolvePowerShell() {
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
 * 异步捕获一次子进程。
 * spawnSync 会锁死事件循环，25 个用例只能一个个排；这里改成 spawn + Promise，
 * 让 node:test 的用例级并发真正生效（脚本、模块、断言都不变，只是不再串行等进程）。
 */
function captureProcess(shell, args, options) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const chunks = { stdout: [], stderr: [] };
    let settled = false;
    let timer;
    const finish = (status, errorMessage) => {
      if (settled) return false;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        status: typeof status === "number" ? status : null,
        stdout: decodeOutput(Buffer.concat(chunks.stdout)),
        stderr: decodeOutput(Buffer.concat(chunks.stderr)),
        error: errorMessage || "",
        durationMs: Date.now() - startedAt,
      });
      return true;
    };
    const child = spawn(shell, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* 进程已退出 */ }
      finish(null, "ETIMEDOUT " + (options.timeoutMs || 180000) + "ms");
    }, options.timeoutMs || 180000);
    child.stdout.on("data", (chunk) => { chunks.stdout.push(chunk); });
    child.stderr.on("data", (chunk) => { chunks.stderr.push(chunk); });
    child.on("error", (error) => finish(null, String((error && error.message) || error)));
    child.on("close", (code) => finish(code, ""));
  });
}

/**
 * 子进程环境：剥掉宿主注入的 DSH_HOME（本机在 DSH 会话里跑 npm test 时它指向真实 ~/.dsh）。
 * 不剥的话 G87 的「profile 推导」会被真实 home 抢走，用例还会写真实用户目录。
 * 要测环境变量优先级时，用例自己传 options.env.DSH_HOME，这里原样保留。
 */
function childEnv(extra) {
  const env = Object.assign({}, process.env);
  for (const key of ["DSH_HOME", "DSH_PROFILE", "DSH_PROFILE_DIR"]) delete env[key];
  return Object.assign(env, extra || {});
}

/** 子进程 cwd 默认落在用例临时根：绝不让脚本把 %SystemDrive% 之类的东西写进仓库根。 */
function pickCwd(options, home) {
  if (typeof options.cwd === "string" && options.cwd.length > 0) return options.cwd;
  if (home) return home.root;
  return os.tmpdir();
}

/**
 * 真跑脚本（异步）。参数数组直传，避免手拼命令行把带空格的路径拆坏。
 * 返回结构化 exit/stdout/stderr，并默认记录假 HOME 的前后字节快照。
 */
export async function runPowerShellScriptAsync(script, args, options = {}) {
  const shell = resolvePowerShell();
  const file = typeof script === "string" && SCRIPTS[script] ? SCRIPTS[script] : script;
  if (!fs.existsSync(file)) throw new DeploySeamError("SCRIPT_MISSING", "脚本不存在：" + file);
  const command = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file].concat(args || []);
  const home = options.home || null;
  const before = home ? snapshotTree(home.root) : null;
  const child = await captureProcess(shell, command, {
    cwd: pickCwd(options, home),
    env: childEnv(options.env),
    timeoutMs: options.timeoutMs || 180000,
  });
  const after = home ? snapshotTree(home.root) : null;
  return {
    shell,
    command: [shell].concat(command),
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    error: child.error,
    durationMs: child.durationMs,
    before,
    after,
    changes: before && after ? diffSnapshots(before, after) : [],
  };
}

/** install / uninstall 的标准调用（显式 Profile + GateHome，参数数组直传）。 */
export async function runScriptAsync(kind, home, options = {}) {
  const args = ["-Profile", options.profile || home.profileDir];
  if (options.gateHome !== null) args.push("-GateHome", options.gateHome || home.dshHome);
  if (options.source) args.push("-Source", options.source);
  if (options.backupRoot) args.push("-BackupRoot", options.backupRoot);
  if (options.keepBackups !== undefined) args.push("-KeepBackups", String(options.keepBackups));
  for (const flag of options.flags || []) args.push(flag);
  args.push(...(options.extraArgs || []));
  return runPowerShellScriptAsync(kind, args, { home: options.noSnapshot ? null : home, env: options.env, timeoutMs: options.timeoutMs, cwd: options.cwd });
}

/** -DryRun 的标准调用：只读预览，必须 exit 0 且字节零变化。 */
export async function runDryRunAsync(home, kind, extraArgs = [], options = {}) {
  return runScriptAsync(kind, home, Object.assign({ flags: ["-DryRun"], extraArgs }, options));
}

/** 用 cmd.exe 跑批处理，拿真实 cmd 退出码（G86）。 */
export async function runBatchAsync(file, args, options = {}) {
  const home = options.home || null;
  const before = home ? snapshotTree(home.root) : null;
  const child = await captureProcess("cmd.exe", ["/d", "/c", file].concat(args || []), {
    cwd: pickCwd(options, home),
    env: Object.assign(childEnv(options.env), { DSH_GATE_NO_PAUSE: "1" }),
    timeoutMs: options.timeoutMs || 180000,
  });
  return {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    error: child.error,
    durationMs: child.durationMs,
    before,
    after: home ? snapshotTree(home.root) : null,
  };
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

/** 兼容旧调用：按正则判有没有目标行。 */
export function patchRowMatches(text, pattern = FIXED_PATCH_PATTERN) {
  return pattern.test(String(text));
}

export function findSurfaceGateRows(text) {
  return parsePatchRows(text).filter((row) => row.id === "surface-gate");
}

/** 模拟正确实现的插入（幂等 + 空数组/追加两种形状），用于静态对称性断言。 */
export function applyPatchInsertion(text, rowText = PATCH_ROW.text) {
  const current = String(text);
  const trimmed = current.trim();
  if (FIXED_PATCH_PATTERN.test(current)) return { text: current, inserted: false, reason: "already-present" };
  if (trimmed === "[]" || trimmed === "") return { text: rowText + "\n", inserted: true, reason: "empty-array" };
  const nl = current.endsWith("\n") ? "" : "\n";
  return { text: current + nl + rowText + "\n", inserted: true, reason: "appended" };
}

/** 读脚本源码（相对 scripts/ 或绝对路径）。 */
export function readScript(file) {
  const target = SCRIPTS[file] || path.join(SCRIPTS_DIR, file);
  return fs.readFileSync(target, "utf8");
}

export function readScriptBytes(file) {
  const target = SCRIPTS[file] || path.join(SCRIPTS_DIR, file);
  return fs.readFileSync(target);
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

/** 断言：写进 DSH 会解析的文件的字节流没有 BOM。 */
export function assertNoBom(buffer, label) {
  if (hasBom(buffer)) throw new DeploySeamError("BOM_FOUND", "文件带 BOM，DSH 会解析失败：" + label);
}

/** 断言：批处理必须是 CRLF，且不含裸 LF。 */
export function assertCrlf(buffer, label) {
  const text = buffer.toString("latin1");
  const lf = (text.match(/\n/g) || []).length;
  const crlf = (text.match(/\r\n/g) || []).length;
  if (lf !== crlf) throw new DeploySeamError("LF_FOUND", "批处理存在裸 LF 行尾（必须全 CRLF）：" + label);
  if (crlf === 0) throw new DeploySeamError("NO_CRLF", "批处理没有 CRLF 行尾：" + label);
  return crlf;
}
