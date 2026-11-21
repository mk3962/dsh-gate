/**
 * D15：技能发现与导入。锁 YAML 行式扫描七情形、混合目录、环/深度、实例级缓存与路径安全。
 * 这里不碰宿主：全部用临时目录 + 纯函数。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  IMPORT_PATH_MAX_CHARS,
  SKILL_SCAN_MAX_DEPTH,
  createSkillScanner,
  discoverSkillFiles,
  isUnsafeImportPath,
  parseFrontmatter,
  resolveImportPath,
  scanImport,
} from "../lib/skills.js";

const results = [];
const check = (label, fn) => {
  try { fn(); results.push({ ok: true, label }); }
  catch (error) { results.push({ ok: false, label, error }); }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gate-skillscan-"));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, "utf8"); return file; };

check("YAML 七情形 1/2/3：空头、尾随空格、三点结束符", () => {
  const empty = parseFrontmatter("---\n---\nbody");
  assert.deepEqual(empty.data, {});
  assert.equal(empty.body, "body");
  assert.equal(empty.hasFrontmatter, true);

  const spaced = parseFrontmatter("---   \nname:  x  \n---  \nbody");
  assert.equal(spaced.data.name, "x", "键值行与标记都允许行尾空白");
  assert.equal(spaced.body, "body");

  const dots = parseFrontmatter("---\nname: a\n...\nbody");
  assert.equal(dots.data.name, "a");
  assert.equal(dots.body, "body", "... 与 --- 等价");
});

check("YAML 七情形 4：正文水平线不再被当结束符", () => {
  const parsed = parseFrontmatter("---\nname: a\n---\n# 标题\n\n---\n正文后面还有");
  assert.equal(parsed.data.name, "a");
  assert.equal(parsed.body, "# 标题\n\n---\n正文后面还有", "只扫头部，正文 --- 原样保留");
});

check("YAML 七情形 5：引号标量（双引号转义、单引号 '' 转义）", () => {
  const parsed = parseFrontmatter("---\nname: \"a\\nb\\\"c\\\\d\"\ndescription: 'it''s fine'\n---\n正文");
  assert.equal(parsed.data.name, "a\nb\"c\\d");
  assert.equal(parsed.data.description, "it's fine");
});

check("YAML 七情形 6：块标量 | 保换行、> 折叠、chomping + 留一个换行", () => {
  const literal = parseFrontmatter("---\ndescription: |\n  第一行\n  第二行\n---\nbody");
  assert.equal(literal.data.description, "第一行\n第二行");
  const folded = parseFrontmatter("---\ndescription: >\n  第一行\n  第二行\n\n  第三段\n---\nbody");
  assert.equal(folded.data.description, "第一行 第二行 第三段");
  const keep = parseFrontmatter("---\ndescription: |+\n  一行\n\n---\nbody");
  assert.equal(keep.data.description, "一行\n", "chomping + 保留一个尾随换行");
  const strip = parseFrontmatter("---\ndescription: |-\n  一行\n---\nbody");
  assert.equal(strip.data.description, "一行");
});

check("YAML 七情形 7：无法解析不抛错，整段按正文保留 + frontmatter-invalid", () => {
  const noEnd = parseFrontmatter("---\nname: a\n还没有结束符");
  assert.deepEqual(noEnd.data, {});
  assert.equal(noEnd.body, "---\nname: a\n还没有结束符");
  assert.equal(noEnd.hasFrontmatter, false);
  assert.equal(noEnd.warnings[0].code, "frontmatter-invalid");

  const orphanIndent = parseFrontmatter("---\n  name: a\n---\nbody");
  assert.equal(orphanIndent.body, "---\n  name: a\n---\nbody", "缩进行无主 → 整段保留");

  const unquoted = parseFrontmatter("---\nname: \"没闭合\n---\nbody");
  assert.equal(unquoted.hasFrontmatter, false);
  assert.equal(unquoted.body.includes("没闭合"), true, "一个字都不丢");
});

check("混合目录：子目录技能与同级散装 md 同时收集；文件根原样返回", () => {
  const root = tmp();
  write(path.join(root, "alpha", "SKILL.md"), "---\nname: alpha\n---\nA");
  write(path.join(root, "loose.md"), "---\nname: loose\n---\nL");
  const found = discoverSkillFiles(root);
  const names = found.files.map((file) => path.basename(path.dirname(file)) === path.basename(root) ? path.basename(file) : path.basename(path.dirname(file)));
  assert.deepEqual(names.sort(), ["alpha", "loose.md"], "两种形态都收（0.5.7 会丢掉散装 md）");
  assert.equal(found.missing, false);

  const single = write(path.join(root, "one.md"), "# 单文件");
  assert.deepEqual(discoverSkillFiles(single).files, [single]);
  assert.equal(discoverSkillFiles(path.join(root, "nope")).missing, true);
});

check("符号链接环：告警 skill-scan-loop 并停下；深度上限告警 skill-scan-depth", () => {
  const root = tmp();
  write(path.join(root, "a", "SKILL.md"), "---\nname: a\n---\nA");
  fs.mkdirSync(path.join(root, "b"), { recursive: true });
  let linked = false;
  try {
    fs.symlinkSync(root, path.join(root, "b", "loop"), "junction");
    linked = true;
  } catch { /* 无符号链接权限的机器跳过这一半 */ }
  if (linked) {
    const found = discoverSkillFiles(root);
    assert.ok(found.warnings.some((warning) => warning.code === "skill-scan-loop"), "自指链接必须被环检测拦住");
    assert.deepEqual(found.files.map((file) => path.basename(path.dirname(file))), ["a"], "环不再产出重复文件");
  }
  const deep = tmp();
  write(path.join(deep, "x", "y", "SKILL.md"), "---\nname: deep\n---\nD");
  const limited = discoverSkillFiles(deep, { maxDepth: 1 });
  assert.ok(limited.warnings.some((warning) => warning.code === "skill-scan-depth"), "超过跳数上限要告警");
  assert.equal(SKILL_SCAN_MAX_DEPTH, 8);
});

check("实例级缓存：同目录第二次命中缓存，文件变了才重新扫", () => {
  const root = tmp();
  const file = path.join(root, "cachey", "SKILL.md");
  write(file, "---\nname: cachey\n---\n第一版");
  const scanner = createSkillScanner();
  const first = scanner.scanImport(root, { id: "pkg" });
  assert.equal(first.skills.length, 1);
  assert.equal(first.skills[0].content, "第一版");
  const second = scanner.scanImport(root, { id: "pkg" });
  assert.equal(second.skills[0].content, "第一版");
  assert.equal(scanner.size(), 1, "同一个根只占一个缓存槽");
  fs.writeFileSync(file, "---\nname: cachey\n---\n第二版更长一些", "utf8");
  const third = scanner.scanImport(root, { id: "pkg" });
  assert.equal(third.skills[0].content, "第二版更长一些", "指纹（mtime+size）变了要重扫");
  assert.equal(scanImport(root, { id: "pkg" }).skills[0].content, "第二版更长一些", "默认实例同样可用");
});

check("缓存键 Windows 大小写归一：同一目录两种大小写写法只占一个槽", () => {
  if (process.platform !== "win32") return;
  const root = tmp();
  write(path.join(root, "case", "SKILL.md"), "---\nname: case\n---\nC");
  const scanner = createSkillScanner();
  scanner.scanImport(root, { id: "pkg" });
  scanner.scanImport(root.toUpperCase(), { id: "pkg" });
  assert.equal(scanner.size(), 1, "大小写不同但真实路径相同 → 同一槽");
});

check("路径安全：UNC / 设备路径 / NUL / 超长都拒绝解析", () => {
  assert.equal(isUnsafeImportPath(""), "empty");
  assert.equal(isUnsafeImportPath("\\\\server\\share"), "unc");
  assert.equal(isUnsafeImportPath("\\\\?\\C:\\x"), "device");
  assert.equal(isUnsafeImportPath("a\u0000b"), "nul");
  assert.equal(isUnsafeImportPath("x".repeat(IMPORT_PATH_MAX_CHARS + 1)), "too-long");
  assert.equal(isUnsafeImportPath(path.join(tmp(), "ok")), undefined);
  assert.equal(resolveImportPath("\\\\server\\share", {}), undefined);
  assert.equal(resolveImportPath("  ", {}), undefined);
  const base = tmp();
  assert.equal(resolveImportPath("child", { baseDir: base }), path.join(base, "child"));
});

console.log("");
for (const row of results) {
  if (row.ok) console.log("  ok    " + row.label);
  else { console.log("  FAIL  " + row.label + "  →  " + (row.error && row.error.message ? row.error.message : row.error)); process.exitCode = 1; }
}
const failed = results.filter((row) => row.ok === false).length;
console.log("");
console.log((results.length - failed) + "/" + results.length + " passed");
