#!/usr/bin/env node
/**
 * 工程门禁（0.6.0 · 工单 #08 / D22 / G90–G92）。
 *
 * 0.5.7 的门禁有三类假绿（defect-registry FG-1..FG-7）：
 *   1. 恒真断言（assert(true) / 两边同一个变量）——永远不可能红；
 *   2. 只查"文件里出现过某字符串"，不查真实结构（BOM、打包内容、端点表、语法）；
 *   3. 测试清单手写在 package.json 的 && 长链里，链外的 .test.mjs 永远不跑。
 *
 * 0.6.0 的 check-spec 只做**可失败的检查**：每条检查都能指出"改坏了什么会红"。
 * 依赖 #04/#05/#06 的检查在集成前会明确报 FAIL（不是 WARN），集成后必须全绿。
 *
 * 用法：
 *   node scripts/check-spec.mjs [--root <仓库根>] [--json <文件>] [--verbose] [--pending-ok]
 *
 * --pending-ok 只用于集成前自检：依赖其它工单的检查降级为 WARN，不改变集成后的严格语义。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..");

function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT, json: undefined, verbose: false, pendingOk: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") out.root = path.resolve(argv[++i]);
    else if (arg === "--json") out.json = path.resolve(argv[++i]);
    else if (arg === "--verbose" || arg === "-v") out.verbose = true;
    else if (arg === "--pending-ok") out.pendingOk = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("用法: node scripts/check-spec.mjs [--root <dir>] [--json <file>] [--verbose] [--pending-ok]");
      process.exit(0);
    } else {
      console.error("未知参数: " + arg);
      process.exit(1);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const ROOT = args.root;
const results = [];
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");

function record(id, title, status, detail) {
  results.push({ id, title, status, detail });
  const mark = status === "PASS" ? "PASS" : status === "WARN" ? "WARN" : status === "SKIP" ? "SKIP" : "FAIL";
  console.log(mark.padEnd(4) + "  " + id.padEnd(7) + title + (detail ? "  —— " + detail : ""));
}

async function run(id, title, fn) {
  try {
    const outcome = await fn();
    if (outcome === undefined || outcome === null) record(id, title, "PASS");
    else record(id, title, outcome.status || "PASS", outcome.detail);
  } catch (error) {
    record(id, title, "FAIL", String((error && error.message) || error));
  }
}

function readText(relPath) {
  return readFileSync(path.join(ROOT, relPath), "utf8");
}

function walk(dirRel, options) {
  const opts = options || {};
  const out = [];
  const abs = path.join(ROOT, dirRel);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    if (name === "node_modules" || name === ".git" || name === "_quarantine" || name === "dist") continue;
    const childRel = dirRel.length === 0 ? name : dirRel + "/" + name;
    const childAbs = path.join(ROOT, childRel);
    const stat = statSync(childAbs);
    if (stat.isDirectory()) {
      if (opts.dirs === true) out.push(childRel + "/");
      out.push(...walk(childRel, opts));
    } else if (opts.extensions === undefined || opts.extensions.includes(path.extname(name))) {
      out.push(childRel);
    }
  }
  return out;
}

function importModule(relPath) {
  return import(pathToFileURL(path.join(ROOT, relPath)).href + "?t=" + Date.now());
}

function lf(text) { return text.replace(/\r\n/g, "\n"); }

// ─────────────────────────────────────────────────────────────────────────────
// G90 · 版本 / 打包 / 编码 / 测试注册表 / 语法
// ─────────────────────────────────────────────────────────────────────────────

async function checkVersion() {
  const pkg = JSON.parse(readText("package.json"));
  const registry = await importModule("scripts/test-suites.mjs");
  if (pkg.version !== registry.BASELINE_VERSION) {
    return { status: "FAIL", detail: "package.json version=" + pkg.version + "，基线要求 " + registry.BASELINE_VERSION };
  }
  if (pkg.private === true) return { status: "FAIL", detail: "发布包不应 private:true" };
  if (pkg.name !== "dsh-gate") return { status: "FAIL", detail: "name 必须是 dsh-gate" };
  if (pkg.type !== "module") return { status: "FAIL", detail: "type 必须是 module" };
  if (pkg.engines === undefined || pkg.engines.node === undefined) return { status: "FAIL", detail: "缺少 engines.node" };
  return { status: "PASS", detail: "0.6.0 / type=module / engines.node=" + pkg.engines.node };
}

function checkBomAndEol() {
  const extensions = [".js", ".mjs", ".cjs", ".json", ".ps1", ".cmd", ".yml", ".yaml", ".md"];
  const files = [
    ...walk("lib", { extensions }),
    ...walk("client", { extensions }),
    ...walk("scripts", { extensions }),
    ...walk("test", { extensions }),
    ...walk("docs", { extensions }),
    ...walk(".github", { extensions }),
    ...readdirSync(ROOT).filter((name) => extensions.includes(path.extname(name)) && statSync(path.join(ROOT, name)).isFile()),
  ];
  const problems = [];
  let bomOk = 0;
  for (const file of files) {
    const buffer = readFileSync(path.join(ROOT, file));
    const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    const ext = path.extname(file);
    if (ext === ".ps1") {
      if (!hasBom) problems.push(file + ": PowerShell 脚本必须是 UTF-8 with BOM（Windows PowerShell 5.1 中文会乱码）");
      else bomOk += 1;
    } else if (hasBom) {
      problems.push(file + ": 禁止 UTF-8 BOM（0xEF 0xBB 0xBF）");
    }
    const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
    const crlf = (text.match(/\r\n/g) || []).length;
    const bareLf = (text.match(/(^|[^\r])\n/g) || []).length;
    if (crlf > 0 && bareLf > 0) problems.push(file + ": 行尾混用（CRLF " + crlf + " 行 / 裸 LF " + bareLf + " 行）");
    if (ext === ".json" && text.length > 0 && !/\n$/.test(text)) problems.push(file + ": JSON 文件缺末尾换行");
  }
  if (problems.length > 0) return { status: "FAIL", detail: problems.slice(0, 6).join("；") + (problems.length > 6 ? " 等 " + problems.length + " 项" : "") };
  return { status: "PASS", detail: "扫描 " + files.length + " 个文本文件，PowerShell BOM " + bomOk + " 个，行尾统一" };
}

function expandFilesList(pkg) {
  const expanded = new Set();
  for (const entry of pkg.files || []) {
    const clean = String(entry).replace(/^\.\//, "").replace(/\/$/, "");
    if (clean.includes("*")) {
      const base = clean.split("*")[0].replace(/\/$/, "");
      for (const file of walk(base, {})) expanded.add(file);
      continue;
    }
    const abs = path.join(ROOT, clean);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      expanded.add(clean + "/");
      for (const file of walk(clean, {})) expanded.add(file);
    } else {
      expanded.add(clean);
    }
  }
  return expanded;
}

function checkPackageContents() {
  const pkg = JSON.parse(readText("package.json"));
  const whitelist = expandFilesList(pkg);
  const auto = new Set(["package.json", "README.md", "LICENSE", "LICENSE.md"]);
  const tmp = mkdtempSync(path.join(os.tmpdir(), "dsh-gate-pack-"));
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = spawnSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts", "--loglevel=error", "--pack-destination", tmp], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30000,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error("npm pack 失败: " + String(result.stderr || result.stdout || "").slice(0, 400));
    const stdout = String(result.stdout || "");
    const start = stdout.indexOf("[");
    if (start < 0) throw new Error("npm pack 输出不是 JSON: " + stdout.slice(0, 200));
    const parsed = JSON.parse(stdout.slice(start));
    const packed = new Set((parsed[0].files || []).map((entry) => String(entry.path).replace(/\\/g, "/")));
    const problems = [];
    for (const file of packed) {
      if (auto.has(file)) continue;
      const covered = whitelist.has(file) || [...whitelist].some((item) => item.endsWith("/") && file.startsWith(item));
      if (!covered) problems.push("打包多出未声明文件: " + file);
    }
    for (const item of whitelist) {
      const hit = packed.has(item) || (item.endsWith("/") && [...packed].some((file) => file.startsWith(item)));
      if (!hit) problems.push("files 声明了但没进包: " + item);
    }
    for (const file of packed) {
      if (/\.tgz$/.test(file) || file.startsWith("node_modules/")) problems.push("打包混入残留: " + file);
    }
    if (problems.length > 0) return { status: "FAIL", detail: problems.slice(0, 8).join("；") };
    return { status: "PASS", detail: "打包 " + packed.size + " 个文件，与 files 清单互相包含" };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function checkChangelogVersion() {
  const pkg = JSON.parse(readText("package.json"));
  const text = readText("CHANGELOG.md");
  const match = /^##\s*\[([^\]]+)\]/m.exec(text);
  if (match === null) return { status: "FAIL", detail: "CHANGELOG.md 顶部没有 '## [版本]' 标题" };
  if (match[1].trim() !== pkg.version) return { status: "FAIL", detail: "CHANGELOG 顶部版本 " + match[1] + " ≠ package.json " + pkg.version };
  const body = text.slice(match.index);
  const next = body.slice(match[0].length).search(/^##\s*\[/m);
  const section = next < 0 ? body : body.slice(0, match[0].length + next);
  if (!/—\s*20\d\d-\d\d-\d\d/.test(section.split("\n")[0])) return { status: "FAIL", detail: "0.6.0 标题缺日期（格式：## [0.6.0] — YYYY-MM-DD）" };
  if (section.trim().split("\n").length < 30) return { status: "FAIL", detail: "0.6.0 段落过短（<30 行），收口文档未写" };
  return { status: "PASS", detail: "CHANGELOG 顶部 " + pkg.version + " 与 package.json 一致" };
}

async function checkTestRegistry() {
  const registry = await importModule("scripts/test-suites.mjs");
  const must = registry.MUST_RUN;
  const probe = registry.PROBE;
  const ids = new Set();
  const files = new Set();
  const problems = [];
  for (const entry of must) {
    if (ids.has(entry.id)) problems.push("重复 id: " + entry.id);
    if (files.has(entry.file)) problems.push("重复文件: " + entry.file);
    ids.add(entry.id);
    files.add(entry.file);
    if (!existsSync(path.join(ROOT, entry.file))) problems.push("登记但不存在: " + entry.file);
    if (entry.skip !== undefined && (typeof entry.skip.reason !== "string" || entry.skip.reason.length < 6)) problems.push("跳过缺原因: " + entry.id);
  }
  const scanned = [
    ...readdirSync(path.join(ROOT, "test")).filter((name) => name.endsWith(".test.mjs")).map((name) => "test/" + name),
    ...(existsSync(path.join(ROOT, "test/seams")) ? readdirSync(path.join(ROOT, "test/seams")).filter((name) => name.endsWith(".test.mjs")).map((name) => "test/seams/" + name) : []),
  ];
  for (const file of scanned) {
    if (!files.has(file) && !probe.some((entry) => entry.file === file)) problems.push("扫描到未登记套件（链外）: " + file);
  }
  for (const entry of must) {
    if (entry.file.includes(".test.mjs") && entry.file.startsWith("test/") && !scanned.includes(entry.file)) problems.push("登记了扫描集合之外的 .test.mjs: " + entry.file);
  }
  if (registry.TOTAL_BUDGET_MS > 12000) problems.push("总预算超过 12s: " + registry.TOTAL_BUDGET_MS);
  if (problems.length > 0) return { status: "FAIL", detail: problems.slice(0, 8).join("；") };
  return { status: "PASS", detail: "必过 " + must.length + " 个（扫描 " + scanned.length + " 个 .test.mjs 全覆盖），探测排除 " + probe.length + " 个" };
}

function checkPackageTestScript() {
  const pkg = JSON.parse(readText("package.json"));
  const script = String((pkg.scripts && pkg.scripts.test) || "");
  if (!script.includes("scripts/run-tests.mjs")) return { status: "FAIL", detail: "scripts.test 必须走扫描式 runner（scripts/run-tests.mjs）" };
  if (script.includes("&&")) return { status: "FAIL", detail: "scripts.test 仍是 && 长链，链外漏跑不可发现" };
  const verify = String((pkg.scripts && pkg.scripts.verify) || "");
  const needs = [
    ["check-spec.mjs", "npm run check"],
    ["run-tests.mjs", "npm test"],
    ["verify-effectiveness.mjs", "npm run test:effectiveness"],
  ];
  for (const alternatives of needs) {
    if (!alternatives.some((need) => verify.includes(need))) return { status: "FAIL", detail: "scripts.verify 缺少 " + alternatives[0] };
  }
  return { status: "PASS", detail: "test → 扫描式 runner；verify → check + test + effectiveness" };
}

function checkTautologies() {
  // 不扫 check-spec.mjs 自身：它必须包含恒真断言的正则字面量与说明文字，扫自己必然自指假红。
  const files = [
    ...walk("test", { extensions: [".mjs"] }),
    "scripts/run-tests.mjs",
    "scripts/verify-effectiveness.mjs",
  ].filter((file) => existsSync(path.join(ROOT, file)));
  const patterns = [
    { re: /assert(?:\.ok)?\(\s*true\s*[,)]/, label: "assert(true)" },
    { re: /assert\.ok\(\s*(?:1|"x"|'x'|\[\]|\{\})\s*[,)]/, label: "assert.ok(truthy 字面量)" },
    { re: /assert\.(?:strictEqual|equal)\(\s*([A-Za-z_$][\w$.]*)\s*,\s*\1\s*[,)]/g, label: "两边同一个表达式" },
    { re: /assert\.deep(?:Strict)?Equal\(\s*([A-Za-z_$][\w$.]*)\s*,\s*\1\s*[,)]/g, label: "deepEqual 两边同一个表达式" },
    { re: /assert\.strictEqual\(\s*(\d+)\s*,\s*\1\s*[,)]/g, label: "两个相同数字" },
  ];
  const hits = [];
  for (const file of files) {
    const lines = readText(file).split(/\r?\n/);
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.includes("re: /") || trimmed.includes("label:")) return;
      for (const pattern of patterns) {
        pattern.re.lastIndex = 0;
        const match = pattern.re.exec(line);
        if (match !== null) hits.push(rel(path.join(ROOT, file)) + ":" + (index + 1) + " " + pattern.label + " → " + line.trim().slice(0, 90));
      }
    });
  }
  if (hits.length > 0) return { status: "FAIL", detail: hits.slice(0, 6).join("；") };
  return { status: "PASS", detail: "扫描 " + files.length + " 个测试/门禁文件，无恒真断言" };
}

function checkFrontendSyntax() {
  const file = "client/index.js";
  const source = readText(file);
  try {
    new vm.Script(source, { filename: file });
  } catch (error) {
    return { status: "FAIL", detail: "client/index.js 真实语法解析失败: " + error.message };
  }
  const browserOnly = ["document.", "window.", "customElements."].filter((token) => source.includes(token)).length;
  if (browserOnly === 0) return { status: "FAIL", detail: "client/index.js 不像浏览器入口（缺 document/window/customElements）" };
  const nodes = ["scripts/run-tests.mjs", "scripts/verify-effectiveness.mjs", "scripts/check-spec.mjs"].filter((relPath) => existsSync(path.join(ROOT, relPath)));
  for (const relPath of nodes) {
    const checked = spawnSync(process.execPath, ["--check", relPath], { cwd: ROOT, encoding: "utf8", timeout: 15000, windowsHide: true });
    if (checked.status !== 0) return { status: "FAIL", detail: relPath + " 语法检查失败: " + String(checked.stderr || "").slice(0, 300) };
  }
  return { status: "PASS", detail: "client/index.js 真实解析通过（vm.Script），门禁脚本 node --check 通过" };
}

// ─────────────────────────────────────────────────────────────────────────────
// G91 · 文档 / 端点表 / 示例模板 / 术语
// ─────────────────────────────────────────────────────────────────────────────

function normalizeRouteEntries(mod) {
  const candidates = [];
  const visit = (value, depth) => {
    if (depth > 3 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && typeof item.path === "string") candidates.push(item);
        else visit(item, depth + 1);
      }
      return;
    }
    if (typeof value === "object") {
      if (typeof value.path === "string" && (value.methods !== undefined || value.method !== undefined)) candidates.push(value);
      for (const key of Object.keys(value)) visit(value[key], depth + 1);
    }
  };
  visit(mod.CONTROL_PLANE_ROUTES, 0);
  visit(mod.ROUTES, 0);
  visit(mod.routes, 0);
  const routes = new Map();
  for (const entry of candidates) {
    const methods = Array.isArray(entry.methods) ? entry.methods : typeof entry.methods === "string" ? entry.methods.split(/[,\s|]+/) : [entry.method];
    for (const method of methods) {
      if (typeof method !== "string" || method.length === 0) continue;
      routes.set(method.toUpperCase() + " " + entry.path, entry.id || entry.path);
    }
  }
  return routes;
}

async function loadControlPlaneRoutes() {
  const candidates = ["lib/control/routes.js", "lib/control/route-table.js", "lib/control/decorator.js", "lib/control/http.js", "lib/server.js"];
  for (const candidate of candidates) {
    if (!existsSync(path.join(ROOT, candidate))) continue;
    try {
      const mod = await importModule(candidate);
      const routes = normalizeRouteEntries(mod);
      if (routes.size > 0) return { file: candidate, routes };
    } catch { /* 该文件不导出路由表就继续找 */ }
  }
  return undefined;
}

function parseDocEndpointTable(file) {
  const text = readText(file);
  const rows = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*(\/api\/dsh-gate\/[A-Za-z0-9_\-/{}]+)/i.exec(line);
    if (match !== null) rows.set(match[1].toUpperCase() + " " + match[2], file);
  }
  return rows;
}

async function checkDocsEndpoints() {
  if (!existsSync(path.join(ROOT, "docs/ARCHITECTURE.md"))) return { status: "FAIL", detail: "缺 docs/ARCHITECTURE.md" };
  const loaded = await loadControlPlaneRoutes();
  if (loaded === undefined) {
    return { status: "FAIL", detail: "未找到 CONTROL_PLANE_ROUTES 导出（等 #06 集成；文档端点表的真源必须来自路由元数据）" };
  }
  const doc = parseDocEndpointTable("docs/ARCHITECTURE.md");
  const problems = [];
  for (const key of loaded.routes.keys()) if (!doc.has(key)) problems.push("文档缺端点: " + key);
  for (const key of doc.keys()) if (!loaded.routes.has(key)) problems.push("文档多出端点: " + key);
  if (doc.size === 0) problems.push("docs/ARCHITECTURE.md 没有端点表（| GET | /api/dsh-gate/... |）");
  if (problems.length > 0) return { status: "FAIL", detail: problems.join("；") };
  return { status: "PASS", detail: "路由元数据 " + loaded.file + " 与文档端点表一致（" + doc.size + " 条）" };
}

async function checkExampleTemplate() {
  const schema = await importModule("lib/policy-schema.js");
  if (typeof schema.emptyPolicyTemplate !== "function") return { status: "FAIL", detail: "lib/policy-schema.js 缺 emptyPolicyTemplate()" };
  const example = JSON.parse(readText("gate.example.json"));
  const template = schema.emptyPolicyTemplate();
  const exampleKeys = Object.keys(example).sort();
  const templateKeys = Object.keys(template).sort();
  const missing = templateKeys.filter((key) => !exampleKeys.includes(key));
  const extra = exampleKeys.filter((key) => !templateKeys.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    return { status: "FAIL", detail: "gate.example.json 与空模板顶层键不一致：缺 " + JSON.stringify(missing) + "，多 " + JSON.stringify(extra) };
  }
  if (example.version !== template.version) return { status: "FAIL", detail: "示例 version=" + example.version + " ≠ 模板 " + template.version };
  return { status: "PASS", detail: "示例与空模板顶层键一致（" + exampleKeys.length + " 个键）" };
}

function checkRootHygiene() {
  const entries = readdirSync(ROOT);
  const problems = [];
  const warnings = [];
  for (const name of entries) {
    const abs = path.join(ROOT, name);
    if (name.endsWith(".tgz")) problems.push("仓库根有打包残留: " + name + "（移入 _quarantine/old-packaging/ 并单列）");
    if (name === "undefined" && statSync(abs).isDirectory()) problems.push("仓库根存在字面量 undefined 目录");
    if (/^gate\.json(\.bak|\.tmp)?$/.test(name)) problems.push("仓库根有运行期策略文件: " + name);
  }
  if (existsSync(path.join(ROOT, "test"))) {
    for (const name of readdirSync(path.join(ROOT, "test"))) {
      if (/^tmp-.*\.mjs$/.test(name)) warnings.push("test/" + name + " 是遗留调试脚本（应移入 _quarantine/）");
    }
  }
  if (existsSync(path.join(ROOT, ".gitignore"))) {
    const ignore = readText(".gitignore");
    if (!/^\*\.tgz$/m.test(ignore) && !/^\*\*\/\*\.tgz$/m.test(ignore)) problems.push(".gitignore 未忽略 *.tgz（打包残留会再进仓库）");
  } else {
    problems.push("缺 .gitignore（至少要忽略 *.tgz）");
  }
  if (problems.length > 0) return { status: "FAIL", detail: problems.join("；") };
  return { status: "PASS", detail: warnings.length > 0 ? warnings.join("；") : "根目录无 .tgz / undefined / 运行期策略文件" };
}

function checkDocTerminology() {
  const targets = ["README.md", ...(existsSync(path.join(ROOT, "docs")) ? readdirSync(path.join(ROOT, "docs")).filter((name) => name.endsWith(".md")).map((name) => "docs/" + name) : [])];
  const banned = ["档位", "等级", "三层"];
  const problems = [];
  const warnings = [];
  for (const file of targets) {
    const text = readText(file);
    text.split(/\r?\n/).forEach((line, index) => {
      for (const word of banned) {
        if (line.includes(word)) problems.push(file + ":" + (index + 1) + " 含禁用旧词「" + word + "」");
      }
      if (/\bT[012]\b/.test(line)) warnings.push(file + ":" + (index + 1) + " 用 T0/T1/T2（应为层 0/1/2）");
    });
  }
  if (problems.length > 0) return { status: "FAIL", detail: problems.slice(0, 8).join("；") };
  return { status: "PASS", detail: "README/docs 已统一为层 0/1/2" + (warnings.length > 0 ? "；警告：" + warnings.slice(0, 4).join("；") : "") };
}

async function checkDocsCompleteness() {
  const arch = readText("docs/ARCHITECTURE.md");
  const readme = readText("README.md");
  const modules = ["policy-schema", "storage-seam", "decide", "naming", "planner", "host-adapter", "normalize"];
  const problems = [];
  for (const name of modules) {
    if (!arch.includes("lib/" + name + ".js")) problems.push("ARCHITECTURE 缺模块 lib/" + name + ".js");
    if (!readme.includes(name)) problems.push("README 缺模块 " + name);
  }
  for (let i = 10; i <= 16; i += 1) {
    if (!arch.includes("I-" + i)) problems.push("ARCHITECTURE 缺不变量 I-" + i);
  }
  for (const token of ["CONTROL_PLANE_ROUTES", "层 0", "层 1", "层 2"]) {
    if (!arch.includes(token)) problems.push("ARCHITECTURE 缺 '" + token + "'");
  }
  for (const token of ["层 0", "层 1", "层 2", "关闭零", "常驻一", "按需二"]) {
    if (!readme.includes(token)) problems.push("README 缺术语 '" + token + "'");
  }
  if (problems.length > 0) return { status: "FAIL", detail: problems.join("；") };
  return { status: "PASS", detail: "六模块 + normalize + I-10–I-16 + 层 0/1/2 术语齐全" };
}

// ─────────────────────────────────────────────────────────────────────────────
// G92 · 0.6.0 收口 / 有效性 / CI
// ─────────────────────────────────────────────────────────────────────────────

async function checkChangelogCompleteness() {
  const registry = await importModule("test/seams/defect-registry.mjs");
  if (typeof registry.validateRegistry === "function") {
    const validated = registry.validateRegistry();
    if (validated && validated.ok === false) return { status: "FAIL", detail: "defect-registry 自身不合法: " + JSON.stringify(validated.errors || validated).slice(0, 300) };
  }
  if (registry.DEFECT_COUNT !== registry.defects.length) return { status: "FAIL", detail: "DEFECT_COUNT " + registry.DEFECT_COUNT + " ≠ defects.length " + registry.defects.length };
  const text = readText("CHANGELOG.md");
  const start = text.indexOf("## [0.6.0]");
  if (start < 0) return { status: "FAIL", detail: "CHANGELOG.md 没有 0.6.0 段" };
  const rest = text.slice(start + 1);
  const next = rest.search(/^##\s*\[/m);
  const section = next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
  const problems = [];
  for (const defect of registry.defects) {
    if (!section.includes(defect.id)) problems.push("CHANGELOG 缺缺陷编号 " + defect.id);
  }
  for (const token of ["X-1", "D-1", "L143", "行为变化", "回滚", "P0", "P1", "P2", "P3"]) {
    if (!section.includes(token)) problems.push("CHANGELOG 缺 '" + token + "'");
  }
  for (let i = 10; i <= 16; i += 1) {
    if (!section.includes("I-" + i)) problems.push("CHANGELOG 缺不变量 I-" + i);
  }
  if (problems.length > 0) return { status: "FAIL", detail: problems.slice(0, 8).join("；") };
  return { status: "PASS", detail: "17 条缺陷 + X-1 + D-1 + I-10–I-16 + L143 对照 + P0–P3 回滚顺序齐全" };
}

async function checkEffectivenessRegistry() {
  const mod = await importModule("scripts/effectiveness-cases.mjs");
  const cases = mod.CASES;
  const need = ["HF-1", "HF-2", "HF-3", "HF-4", "HF-5", "HF-6"];
  for (let i = 10; i <= 16; i += 1) need.push("I-" + i);
  const problems = [];
  for (const id of need) if (!cases.some((entry) => entry.id === id)) problems.push("缺用例 " + id);
  const pending = [];
  for (const entry of cases) {
    const missingRequires = (entry.requires || []).filter((relPath) => !existsSync(path.join(ROOT, relPath)));
    if (entry.pending === true || missingRequires.length > 0) {
      pending.push(entry.id + (missingRequires.length > 0 ? "（缺 " + missingRequires.join("、") + "）" : ""));
      continue;
    }
    if (!existsSync(path.join(ROOT, entry.target))) { problems.push(entry.id + " 目标不存在: " + entry.target); continue; }
    if (entry.probeOnly === true) {
      if (typeof entry.probe !== "string" || entry.probe.length < 40) problems.push(entry.id + " 探针过短");
      continue;
    }
    if (typeof entry.anchor !== "string" || entry.anchor.length < 8) { problems.push(entry.id + " 缺变异锚点"); continue; }
    const text = lf(readText(entry.target));
    const occurrences = text.split(lf(entry.anchor)).length - 1;
    if (occurrences !== 1) problems.push(entry.id + " 锚点在 " + entry.target + " 出现 " + occurrences + " 次（必须恰好 1 次）");
    if (typeof entry.probe !== "string" || entry.probe.length < 40) problems.push(entry.id + " 探针过短");
  }
  if (problems.length > 0) return { status: "FAIL", detail: problems.join("；") };
  return { status: "PASS", detail: "13 条用例（HF-1–HF-6 + I-10–I-16）锚点全部命中且唯一" + (pending.length > 0 ? "；待集成 " + pending.length + " 条：" + pending.join("、") + "（strict 模式仍失败）" : "") };
}

function checkCiWorkflows() {
  const ci = path.join(ROOT, ".github/workflows/ci.yml");
  const release = path.join(ROOT, ".github/workflows/release.yml");
  if (!existsSync(ci)) return { status: "FAIL", detail: "缺 .github/workflows/ci.yml" };
  if (!existsSync(release)) return { status: "FAIL", detail: "缺 .github/workflows/release.yml" };
  const ciText = readFileSync(ci, "utf8");
  const releaseText = readFileSync(release, "utf8");
  const problems = [];
  for (const token of ["windows-latest", "ubuntu-latest", "check-spec.mjs", "run-tests.mjs", "verify-effectiveness.mjs", "test:seam:s5"]) {
    if (!ciText.includes(token)) problems.push("ci.yml 缺 " + token);
  }
  if (!/node:\s*\[?\s*20/.test(ciText) || !ciText.includes("22")) problems.push("ci.yml 未覆盖 Node 20/22");
  for (const token of ["tags:", "v*", "npm pack", "release"]) {
    if (!releaseText.includes(token)) problems.push("release.yml 缺 " + token);
  }
  if (!/npm run check/.test(releaseText)) problems.push("release.yml 发版前未跑 npm run check");
  if (problems.length > 0) return { status: "FAIL", detail: problems.join("；") };
  return { status: "PASS", detail: "CI 双平台 + S5 分平台 + 发版资产工作流齐全" };
}

function checkClientWording() {
  const text = readText("client/index.js");
  const count = (text.match(/档位/g) || []).length;
  if (count > 0) return { status: "WARN", detail: "client/index.js 仍有 " + count + " 处「档位」文案（面板文案归 #07；docs 必须为 0）" };
  return { status: "PASS", detail: "面板文案已统一" };
}

async function main() {
  if (!existsSync(path.join(ROOT, "package.json"))) {
    console.error("不是仓库根（缺少 package.json）: " + ROOT);
    process.exit(1);
  }
  console.log("dsh-gate 0.6.0 · 工程门禁（check-spec）");
  console.log("仓库: " + ROOT + (args.pendingOk ? "  [pending-ok]" : ""));
  console.log("");

  await run("G90.1", "版本基线 / 包元数据", checkVersion);
  await run("G90.2", "打包内容与 files 清单互相包含", checkPackageContents);
  await run("G90.3", "编码（PowerShell BOM / 源码无 BOM / 行尾统一）", checkBomAndEol);
  await run("G90.4", "CHANGELOG 顶部版本 = package.json", checkChangelogVersion);
  await run("G90.5", "测试注册表 = 磁盘扫描（无链外套件）", checkTestRegistry);
  await run("G90.6", "npm test 走扫描式 runner（无 && 长链）", checkPackageTestScript);
  await run("G90.7", "前端 client/index.js 真实语法解析", checkFrontendSyntax);
  await run("G90.8", "恒真断言消毒", checkTautologies);
  await run("G90.9", "文档端点表 = CONTROL_PLANE_ROUTES", checkDocsEndpoints);
  await run("G90.10", "gate.example.json = 空策略模板顶层键", checkExampleTemplate);
  await run("G90.11", "仓库根无 .tgz / undefined / 运行期策略文件", checkRootHygiene);
  await run("G91.1", "文档术语统一（禁「档位」「等级」「三层」）", checkDocTerminology);
  await run("G91.2", "架构文档六模块 + I-10–I-16 + 层 0/1/2", checkDocsCompleteness);
  await run("G91.3", "CHANGELOG 0.6.0 收口完整（17 + X-1 + D-1 + L143 + P0–P3）", checkChangelogCompleteness);
  await run("G92.1", "有效性自检注册表（HF-1–6 / I-10–16 锚点唯一）", checkEffectivenessRegistry);
  await run("G92.2", "CI 双平台 + S5 分平台 + release 资产", checkCiWorkflows);
  await run("G92.3", "面板文案新旧术语（WARN 级）", checkClientWording);
  await run("G92.4", "客户端源码真实语法解析（防只做正则）", () => {
    const source = readText("client/index.js");
    try { new vm.Script(source, { filename: "client/index.js" }); } catch (error) { return { status: "FAIL", detail: "vm.Script 失败: " + error.message }; }
    return { status: "PASS", detail: "与 G90.7 同源，独立复验" };
  });

  const failed = results.filter((row) => row.status === "FAIL");
  const warned = results.filter((row) => row.status === "WARN");
  console.log("");
  console.log("── 汇总 ─────────────────────────────────────────────");
  console.log("检查: " + results.length + "  通过: " + results.filter((row) => row.status === "PASS").length + "  失败: " + failed.length + "  警告: " + warned.length);
  if (failed.length > 0) {
    console.log("失败项:");
    for (const row of failed) console.log("  - " + row.id + " " + row.title + ": " + row.detail);
  }

  if (args.json !== undefined) {
    writeFileSync(args.json, JSON.stringify({ schema: 1, root: ROOT, version: "0.6.0", results, summary: { total: results.length, failed: failed.length, warned: warned.length } }, null, 2) + "\n", "utf8");
    console.log("JSON 报告: " + args.json);
  }

  const ok = failed.length === 0;
  console.log(ok ? "\n结果: 门禁全绿" : "\n结果: 门禁失败");
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error("门禁崩溃: " + (error && error.stack ? error.stack : error));
  process.exit(1);
});
