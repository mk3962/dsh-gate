#!/usr/bin/env node
/**
 * DSH 插件规范自检（离线、零依赖）。
 *
 * 依据《DSH 插件开发规范》里会"违反必崩"的硬约束，逐条验证本仓库：
 *   1. package.json 元数据与入口文件真实存在（main/exports/files 指错 = 整个 profile 加载失败）
 *   2. 所有 DSH 会解析的 JSON / YAML 不含 BOM（BOM 炸宿主 JSON.parse）
 *   3. cordis.patch.yml 顶层是 insert 嵌套格式，行内有 id/name
 *   4. dsh.client.platform === "web"，inject 是字符串数组，exports["./client"] 存在
 *   5. client 产物是 window.__ModuleLoader__.load({id, factory}) 手接格式，id 与包名一致，
 *      require() 只落 PLATFORM_MODULES 里的 10 个模块
 *   6. host 入口导出 name / inject / apply
 *
 * 用法：node scripts/check-spec.mjs   （npm run check）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => path.relative(root, p).replace(/\\/g, "/");
const abs = (...parts) => path.join(root, ...parts);
const read = (p) => fs.readFileSync(p, "utf8");
const exists = (p) => fs.existsSync(p);

// dsh-client-web 冻结的 PLATFORM_MODULES：恰 10 个，插件 bundle 的 externals 必须对齐它。
const PLATFORM_MODULES = new Set([
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-web-react",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-attachment",
  "@deepseek-ai/dsh-client-schema-form"
]);

const results = [];
const ok = (label, detail) => results.push({ status: "ok", label, detail });
const bad = (label, detail) => results.push({ status: "fail", label, detail });
const check = async (label, fn) => {
  try {
    const detail = await fn();
    ok(label, detail);
  } catch (error) {
    bad(label, error instanceof Error ? error.message : String(error));
  }
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hasBom(file) {
  const bytes = fs.readFileSync(file);
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function walk(dir, filter, out = []) {
  if (!exists(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

// ---- 1) package.json 元数据 ----
const manifestPath = abs("package.json");
const manifest = JSON.parse(read(manifestPath));
const pkgName = manifest.name;

await check("package.json 可解析且 name/version 合法", () => {
  assert(/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(pkgName), "name 必须是合法的 npm 包名: " + pkgName);
  assert(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(manifest.version), "version 必须是 semver: " + manifest.version);
  return pkgName + "@" + manifest.version;
});

await check('type === "module"', () => {
  assert(manifest.type === "module", 'package.json 必须写 "type": "module"');
  return "ok";
});

await check("main / exports 指向的文件都存在", () => {
  const targets = new Map();
  if (manifest.main) targets.set("main", manifest.main);
  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    const target = typeof value === "string" ? value : value?.default ?? value?.import;
    if (typeof target === "string") targets.set("exports[" + JSON.stringify(key) + "]", target);
  }
  assert(targets.size > 0, "没有 main 也没有 exports");
  for (const [label, target] of targets) {
    if (target.includes("*")) continue;
    const file = path.join(root, target);
    assert(exists(file), label + " -> " + target + " 不存在（main/exports 指错会让整个 profile 加载失败）");
  }
  return [...targets.values()].join(", ");
});

await check('exports["./client"] 存在（缺失时 web 端直接 throw）', () => {
  assert(manifest.exports?.["./client"], '缺少 exports["./client"]');
  return String(typeof manifest.exports["./client"] === "string" ? manifest.exports["./client"] : JSON.stringify(manifest.exports["./client"]));
});

await check("files 列出的条目都存在", () => {
  assert(Array.isArray(manifest.files) && manifest.files.length > 0, "files 必须是非空数组（决定 npm 包内容）");
  for (const entry of manifest.files) {
    const file = path.join(root, entry);
    assert(exists(file), "files 里的 " + entry + " 不存在");
  }
  return manifest.files.join(", ");
});

await check('dsh.bundle.patch 存在且指向真实文件', () => {
  const patchRel = manifest.dsh?.bundle?.patch;
  assert(typeof patchRel === "string" && patchRel.length > 0, "缺少 dsh.bundle.patch");
  assert(exists(abs(patchRel)), "dsh.bundle.patch 指向的 " + patchRel + " 不存在");
  return patchRel;
});

await check('dsh.client.platform === "web" 且 inject 是字符串数组', () => {
  assert(manifest.dsh?.client?.platform === "web", 'dsh.client.platform 必须是 "web"');
  const inject = manifest.dsh?.client?.inject;
  assert(Array.isArray(inject) && inject.length > 0, "dsh.client.inject 必须是非空字符串数组");
  for (const item of inject) assert(typeof item === "string" && item.length > 0, "dsh.client.inject 里必须是包名字符串");
  return inject.join(", ");
});

await check("dsh.engines.dsh 声明了宿主版本范围", () => {
  const range = manifest.dsh?.engines?.dsh;
  assert(typeof range === "string" && range.length > 0, "缺少 dsh.engines.dsh");
  return range;
});

// ---- 2) BOM ----
await check("DSH 会解析的 JSON / YAML / JS 均无 BOM", () => {
  const files = walk(root, (file) => /\.(json|yml|yaml|js|mjs|cjs)$/.test(file) && !file.includes(path.sep + "vendor" + path.sep));
  const withBom = files.filter(hasBom).map(rel);
  assert(withBom.length === 0, "以下文件带 BOM: " + withBom.join(", "));
  return files.length + " 个文件";
});

// ---- 3) cordis.patch.yml ----
await check("cordis.patch.yml 顶层是 insert 嵌套格式", () => {
  const patchFile = abs(manifest.dsh.bundle.patch);
  const text = read(patchFile).replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  const topRows = lines.filter((line) => /^-/.test(line));
  assert(topRows.length > 0, "patch 里没有任何顶层行");
  for (const line of topRows) {
    assert(/^-\s*insert:\s*$/.test(line), '顶层行必须是 "- insert:"（裸 "- id:/name:" 是崩溃陷阱 #3）: ' + line);
  }
  const inserted = lines.filter((line) => /^\s+-\s*id:\s*\S+/.test(line));
  assert(inserted.length > 0, "insert 下没有任何 id 行");
  return inserted.length + " 行 insert";
});

await check("patch 里每行 insert 都有 name，且 disabled/config 类型正确", () => {
  const text = read(abs(manifest.dsh.bundle.patch)).replace(/^\uFEFF/, "").split(/\r?\n/);
  const ids = [];
  for (let i = 0; i < text.length; i += 1) {
    const match = /^\s+-\s*id:\s*(\S+)\s*$/.exec(text[i]);
    if (!match) continue;
    ids.push(match[1]);
    const block = [];
    for (let j = i + 1; j < text.length; j += 1) {
      if (/^\s*-\s*(id|name):/.test(text[j]) || /^-\s*insert:/.test(text[j])) break;
      block.push(text[j]);
    }
    const body = block.join("\n");
    assert(/^\s+name:\s*\S+/m.test(body), "insert 行 " + match[1] + " 缺少 name");
    const disabled = /^\s+disabled:\s*(\S+)\s*$/m.exec(body);
    if (disabled) assert(/^(true|false)$/i.test(disabled[1]), "insert 行 " + match[1] + " 的 disabled 必须是布尔");
  }
  assert(/^\s+config:\s*$/m.test(text.join("\n")) || ids.length > 0, "config 块格式不对");
  return ids.join(", ");
});

// ---- 4) client 产物格式 ----
const clientRel = typeof manifest.exports?.["./client"] === "string" ? manifest.exports["./client"] : manifest.exports?.["./client"]?.default;
await check("client 是 window.__ModuleLoader__.load({id, factory}) 手接格式", () => {
  assert(typeof clientRel === "string", "无法从 exports 里定位 client 产物");
  const text = read(abs(clientRel));
  assert(/^\s*window\.__ModuleLoader__\.load\(\{/.test(text), "client 必须以 window.__ModuleLoader__.load({ 开头（裸 ESM 会让 web 端崩溃）");
  const id = /\bid:\s*["']([^"']+)["']/.exec(text);
  assert(id, "client 缺少 id 字段");
  assert(id[1] === pkgName, "client id(" + id[1] + ") 必须与包名(" + pkgName + ") 一致，否则重复注册/取不到 bundle");
  assert(/\bfactory:\s*(function\s*)?\(?\s*require/.test(text), "client 缺少 factory: (require) => {}");
  assert(/\}\s*\)\s*;?\s*$/.test(text.trim()), "client 必须以 }); 结尾");
  return clientRel + "（id=" + id[1] + "）";
});

await check("client 的 require() 只取 PLATFORM_MODULES 里的模块", () => {
  const text = read(abs(clientRel));
  const specifiers = [...text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  const unknown = [...new Set(specifiers)].filter((name) => !PLATFORM_MODULES.has(name));
  assert(unknown.length === 0, "以下模块不在 PLATFORM_MODULES（10 个）里，运行时会抛 missed the module table: " + unknown.join(", "));
  return [...new Set(specifiers)].join(", ") || "（无 require）";
});

// ---- 5) host 入口导出 ----
await check("host 入口导出 name / inject / apply", async () => {
  register("./stub-resolver.mjs", pathToFileURL(abs("test", "stub-loader.mjs")).href);
  const entry = await import(pathToFileURL(abs(manifest.main)).href);
  assert(typeof entry.name === "string" && entry.name.length > 0, "host 入口没有导出 name");
  assert(Array.isArray(entry.inject), "host 入口没有导出 inject 数组");
  assert(typeof entry.apply === "function", "host 入口没有导出 apply");
  return "name=" + entry.name + ", inject=" + JSON.stringify(entry.inject);
});

// ---- 6) 策略示例 ----
await check("gate.example.json 是合法策略文件（无 BOM 且字段齐）", () => {
  const file = abs("gate.example.json");
  assert(exists(file), "缺少 gate.example.json");
  assert(!hasBom(file), "gate.example.json 带 BOM");
  const policy = JSON.parse(read(file));
  for (const key of ["version", "enabled", "tools", "sections", "skills"]) {
    assert(key in policy, "gate.example.json 缺少 " + key);
  }
  return "version=" + policy.version + ", enabled=" + policy.enabled;
});

// ---- 输出 ----
const failed = results.filter((row) => row.status === "fail");
for (const row of results) {
  if (row.status === "ok") console.log("  ok    " + row.label + (row.detail ? " — " + row.detail : ""));
  else console.log("  FAIL  " + row.label + " — " + row.detail);
}
console.log("");
console.log(failed.length === 0 ? "规范自检全部通过 (" + results.length + ")" : "规范自检失败 " + failed.length + " 项 / 共 " + results.length + " 项");
process.exitCode = failed.length === 0 ? 0 : 1;
