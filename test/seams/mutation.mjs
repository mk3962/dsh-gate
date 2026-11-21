/**
 * 定点变异（票 01 · 规格 §805「删分支必须红」）
 *
 * 不引变异测试框架：把待验的源文件读出来、做**一处定点改写**、落到临时副本再动态导入。
 * 副本里的相对 import 一律改写成绝对 file URL（副本换了目录，相对路径会指错）。
 *
 * 唯一用途是自验证：契约测试断言的真实分支被删掉时，对应断言必须变红。
 * 副本全部落在 test/seams/.mut/<pid>/，测试结束由 cleanupMutations() 清掉。
 * 按进程分桶：`node --test` 会并行跑多个接缝文件，共用同一个 .mut 会被彼此的清理擦掉（ENOENT lstat）。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const MUTATION_PARENT = path.join(HERE, ".mut");
export const MUTATION_DIR = path.join(MUTATION_PARENT, String(process.pid));

/** 把 mutations 依次作用到源码上；find 必须真的命中，否则直接报错（变异过期必须显性失败）。 */
export function applyMutations(source, mutations) {
  let text = source;
  const applied = [];
  for (const mutation of mutations) {
    const label = mutation.label || "mutation";
    const hits = countOccurrences(text, mutation.find);
    if (hits === 0) throw new Error("mutation target missing: " + label + " :: " + String(mutation.find).slice(0, 80));
    text = text.split(mutation.find).join(mutation.replace === undefined ? "" : mutation.replace);
    applied.push({ label, hits });
  }
  return { text, applied };
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = text.indexOf(needle);
  while (index >= 0) { count += 1; index = text.indexOf(needle, index + needle.length); }
  return count;
}

/** 相对说明符改成绝对 file URL：副本可以落在任何目录。 */
export function rewriteSpecifiers(source, fromFile) {
  const base = pathToFileURL(fromFile);
  return source.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.\.?\/[^"']+)\2/g, (_all, lead, quote, specifier) => (
    lead + quote + new URL(specifier, base).href + quote
  ));
}

/**
 * 生成并导入一个变异副本。
 * 返回 { namespace, file, applied, cleanup }；文件内容哈希进文件名，同一变异跨次运行可复用。
 */
export async function loadMutated(relFile, mutations, options = {}) {
  const sourceFile = path.resolve(REPO_ROOT, relFile);
  const source = fs.readFileSync(sourceFile, "utf8");
  const { text, applied } = applyMutations(source, mutations);
  const rewritten = rewriteSpecifiers(text, sourceFile);
  const digest = createHash("sha1").update(relFile + "\u0000" + rewritten).digest("hex").slice(0, 10);
  const bucket = path.join(MUTATION_DIR, String(options.name || "mut"));
  fs.mkdirSync(bucket, { recursive: true });
  const base = path.basename(relFile).replace(/\.(m)?js$/, "");
  const target = path.join(bucket, base + "." + digest + ".mjs");
  fs.writeFileSync(target, rewritten);
  const namespace = await import(pathToFileURL(target).href);
  return {
    namespace,
    file: target,
    applied,
    cleanup() { fs.rmSync(target, { force: true }); },
  };
}

/** 判红辅助：把「抛错」当作预期结果，返回可断言的形状而不是让用例直接炸。 */
export async function expectRed(label, fn) {
  try {
    const value = await fn();
    return { label, red: false, value };
  } catch (error) {
    return { label, red: true, error, message: String((error && error.message) || error) };
  }
}

/** 期望抛错（正例用法）：返回错误对象，没抛就抛断言用的 Error。 */
export async function expectThrows(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw, but it resolved");
}

export function cleanupMutations() {
  fs.rmSync(MUTATION_DIR, { recursive: true, force: true });
  // 只在自己这个桶空了之后收掉外层目录；别的进程还在用就留着。
  try { fs.rmdirSync(MUTATION_PARENT); } catch { /* ENOTEMPTY / ENOENT：兄弟进程仍在跑 */ }
}
