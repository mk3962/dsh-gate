#!/usr/bin/env node
/**
 * 扫描式测试运行器（0.6.0 · 工单 #08 / D22 / G90）。
 *
 * 与 0.5.7 的 32 段 && 长链的区别：
 *   1. 执行清单来自 test-suites.mjs（与磁盘扫描结果双向比对），不是手写长链；
 *   2. 未登记 / 登记但不存在 / 重复登记 一律失败，不再"漏了也没人知道"；
 *   3. 跳过必须带原因，静默跳过（测试自己 print "skip" 却不说为什么）视为失败；
 *   4. 双重报告：逐文件（状态 / 断言数 / 跳过数 / 用时）+ 汇总（文件数 / 断言总数 / 跳过数 / 总用时 / 预算）；
 *   5. 总耗时超预算直接失败（默认 12s），单文件超预算也失败；
 *   6. 每个测试文件恰好执行一次；探测套件不进必过门。
 *
 * 用法：
 *   node scripts/run-tests.mjs [--root <仓库根>] [--filter <子串>] [--skip <id>]
 *                              [--json <文件>] [--budget <ms>] [--file-budget <ms>]
 *                              [--verbose] [--list] [--no-budget] [--concurrency <n>]
 *
 * 退出码：0 全绿；1 有失败（测试 / 注册表 / 静默跳过 / 预算）。
 */
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..");

function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT, filter: undefined, skip: new Set(), json: undefined, budget: undefined, fileBudget: undefined, verbose: false, list: false, noBudget: false, concurrency: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") out.root = path.resolve(argv[++i]);
    else if (arg === "--filter") out.filter = argv[++i];
    else if (arg === "--skip") out.skip.add(argv[++i]);
    else if (arg === "--json") out.json = path.resolve(argv[++i]);
    else if (arg === "--budget") out.budget = Number(argv[++i]);
    else if (arg === "--file-budget") out.fileBudget = Number(argv[++i]);
    else if (arg === "--verbose" || arg === "-v") out.verbose = true;
    else if (arg === "--list") out.list = true;
    else if (arg === "--no-budget") out.noBudget = true;
    else if (arg === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      console.log("用法: node scripts/run-tests.mjs [--root <dir>] [--filter <s>] [--skip <id>] [--json <file>] [--budget <ms>] [--file-budget <ms>] [--verbose] [--list] [--no-budget]");
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
const REGISTRY_URL = pathToFileURL(path.join(HERE, "test-suites.mjs")).href;

function listDir(rel, suffix) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((name) => name.endsWith(suffix))
    .map((name) => rel.replace(/\\/g, "/") + "/" + name);
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return "?";
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(2) + "s";
}

function killTree(child) {
  try { child.kill("SIGKILL"); } catch { /* 已经退出 */ }
  if (process.platform === "win32" && Number.isFinite(child.pid)) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch { /* 进程已退出 */ }
  }
}

/** 从测试输出里数断言：兼容自研 check、node:test 与常见汇总行。 */
export function countAssertions(output) {
  const patterns = [
    /# pass (\d+)/g,
    /全部通过 \((\d+)\)/g,
    /(\d+)\s+passed/gi,
    /通过[:：]\s*(\d+)/g,
    /^(?:\s*)(?:✓|✔)/gm,
    /^\s*ok\s+\S/gm,
  ];
  let max = 0;
  for (const pattern of patterns) {
    const found = [...output.matchAll(pattern)];
    if (pattern.source.startsWith("^")) {
      // 逐行标记型（✓）——取出现次数
      if (found.length > max) max = found.length;
      continue;
    }
    for (const match of found) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > max) max = value;
    }
  }
  return max;
}

/** 静默跳过：输出里出现 skip/跳过 行，必须同时给出原因。 */
export function silentSkips(output) {
  const bad = [];
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    if (!/^\s*(?:[-*·]\s*)?(?:SKIP(?:PED)?|skip(?:ped)?|跳过)\b/.test(line)) continue;
    const hasReason = /(?:SKIP(?:PED)?|skip(?:ped)?|跳过)\s*[:：]\s*\S{4,}/i.test(line);
    if (!hasReason) bad.push(line.trim());
  }
  return bad;
}

function runOne(entry, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", "./test/stub-loader.mjs", entry.file], {
      cwd: ROOT,
      env: { ...process.env, DSH_GATE_TEST: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: "error", ms: Date.now() - started, assertions: 0, skips: 0, exitCode: null, tail: String(error && error.message), reason: "spawn-failed" });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const output = stdout + "\n" + stderr;
      const skips = silentSkips(output);
      let status = code === 0 && !timedOut ? "pass" : "fail";
      let reason;
      if (timedOut) { status = "fail"; reason = "超时 " + fmtMs(timeoutMs) + "（预算 " + fmtMs(timeoutMs) + "）"; }
      else if (code !== 0) reason = "退出码 " + code + (signal ? " / " + signal : "");
      else if (skips.length > 0) { status = "fail"; reason = "静默跳过（无原因）: " + skips[0]; }
      resolve({
        status,
        ms: Date.now() - started,
        assertions: countAssertions(output),
        skips: skips.length,
        exitCode: code,
        reason,
        output: args.verbose ? output : undefined,
        tail: output.trim().split(/\r?\n/).slice(-4).join("\n"),
      });
    });
  });
}

function printEntry(entry, result) {
  const mark = result.status === "pass" ? "PASS" : result.status === "skip" ? "SKIP" : "FAIL";
  const parts = [mark.padEnd(4), entry.file.padEnd(46), fmtMs(result.ms).padStart(7), "断言 " + String(result.assertions).padStart(3)];
  if (result.status === "skip") parts.push("跳过原因: " + result.reason);
  else if (result.reason) parts.push(result.reason);
  console.log(parts.join("  "));
  if (result.reason && result.status === "fail" && result.tail) console.log("       " + result.tail.replace(/\n/g, "\n       "));
}

async function main() {
  if (!existsSync(path.join(ROOT, "package.json"))) {
    console.error("不是仓库根（缺少 package.json）: " + ROOT);
    process.exit(1);
  }
  const registry = await import(REGISTRY_URL + "?t=" + Date.now());
  const must = registry.MUST_RUN;
  const probe = registry.PROBE;
  const nonSuite = registry.NON_SUITE;
  const budget = args.noBudget ? Number.POSITIVE_INFINITY : (Number.isFinite(args.budget) ? args.budget : registry.TOTAL_BUDGET_MS);
  const fileBudget = Number.isFinite(args.fileBudget) ? args.fileBudget : registry.FILE_BUDGET_MS;

  // —— 注册表 × 磁盘 双向核对（与 check-spec 同源，runner 自己也要能独立发现漂移）——
  const scanned = [
    ...listDir("test", ".mjs").filter((file) => file.endsWith(".test.mjs")),
    ...listDir("test/seams", ".test.mjs"),
  ];
  const registered = new Map();
  const problems = [];
  for (const entry of must) {
    if (registered.has(entry.file)) problems.push("重复登记: " + entry.file);
    registered.set(entry.file, entry);
    if (!existsSync(path.join(ROOT, entry.file))) problems.push("登记但文件不存在: " + entry.file);
  }
  for (const entry of probe) {
    if (!existsSync(path.join(ROOT, entry.file))) problems.push("探测套件不存在: " + entry.file);
    if (registered.has(entry.file)) problems.push("探测套件被误登记进必过门: " + entry.file);
  }
  for (const file of scanned) {
    if (registered.has(file)) continue;
    if (probe.some((entry) => entry.file === file)) continue;
    problems.push("扫描到未登记套件: " + file);
  }
  // 反向检查只针对「test/ 下的 .test.mjs」：遗留入口（selftest / loadtest）登记但不在扫描集合里是合法的。
  for (const entry of must) {
    if (entry.file.includes(".test.mjs") && entry.file.startsWith("test/") && !scanned.includes(entry.file)) {
      problems.push("登记了扫描集合之外的 .test.mjs: " + entry.file);
    }
  }
  if (registry.OVERRIDES instanceof Map) {
    for (const file of registry.OVERRIDES.keys()) {
      if (!existsSync(path.join(ROOT, file))) problems.push("OVERRIDES 含悬空键（文件不存在）: " + file);
      else if (!registered.has(file)) problems.push("OVERRIDES 含未登记套件: " + file);
    }
  }

  if (args.list) {
    for (const entry of registry.sortedSuites(must)) console.log(entry.file + "\t" + entry.id + "\t" + entry.kind);
    for (const entry of probe) console.log(entry.file + "\t" + entry.id + "\t探测（不执行）: " + entry.reason);
    if (problems.length > 0) {
      console.error("\n注册表问题:");
      for (const problem of problems) console.error("  - " + problem);
      process.exit(1);
    }
    process.exit(0);
  }

  if (problems.length > 0) {
    console.error("测试注册表与磁盘不一致（扫描式 runner 拒绝执行）:");
    for (const problem of problems) console.error("  - " + problem);
    process.exit(1);
  }

  const plan = [];
  for (const entry of registry.sortedSuites(must)) {
    if (args.skip.has(entry.id)) { plan.push({ entry, skip: "命令行 --skip " + entry.id }); continue; }
    if (args.filter !== undefined && !entry.file.includes(args.filter) && !entry.id.includes(args.filter)) continue;
    const skip = registry.skipReasonFor(entry, process.env);
    plan.push({ entry, skip });
  }

  console.log("dsh-gate 0.6.0 · 扫描式测试运行器");
  console.log("仓库: " + ROOT);
  console.log("套件: " + plan.length + "（必过注册 " + must.length + "，探测排除 " + probe.length + "）  预算: 总 " + (Number.isFinite(budget) ? fmtMs(budget) : "不限") + " / 单文件 " + fmtMs(fileBudget));
  console.log("");

  const concurrency = Number.isFinite(args.concurrency) && args.concurrency > 0
    ? Math.min(Math.floor(args.concurrency), Math.max(plan.length, 1))
    : Math.max(1, Math.min(4, typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length));
  console.log("并发: " + concurrency + "（每个文件仍是独立 node 进程；测试各自用临时目录，不共享端口）");
  console.log("");

  const startedAll = Date.now();
  const results = new Array(plan.length);
  // 最长作业优先（LJF）：单文件预算就是"这活儿大概多重"的现成估计。慢套件先起跑，
  // 尾部就不会被一个 6-8s 的 S5 拖成整轮墙钟（结果仍按注册表顺序打印）。
  const estimateOf = (entry) => (Number.isFinite(entry.budgetMs) ? entry.budgetMs : fileBudget);
  const order = plan
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const weightA = a.item.skip === undefined ? estimateOf(a.item.entry) : -1;
      const weightB = b.item.skip === undefined ? estimateOf(b.item.entry) : -1;
      if (weightA !== weightB) return weightB - weightA;
      return a.index - b.index;
    })
    .map((row) => row.index);
  let cursor = 0;
  async function worker() {
    for (;;) {
      if (cursor >= order.length) return;
      const index = order[cursor];
      cursor += 1;
      const item = plan[index];
      if (item.skip !== undefined) {
        results[index] = { entry: item.entry, result: { status: "skip", ms: 0, assertions: 0, skips: 0, exitCode: 0, reason: item.skip } };
        continue;
      }
      const limit = args.noBudget ? Number.POSITIVE_INFINITY : (item.entry.budgetMs || fileBudget);
      results[index] = { entry: item.entry, result: await runOne(item.entry, limit) };
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const totalMs = Date.now() - startedAll;
  for (const row of results) {
    printEntry(row.entry, row.result);
    if (args.verbose && row.result.output) console.log(row.result.output);
  }

  const failed = results.filter((row) => row.result.status === "fail" || row.result.status === "error");
  const skipped = results.filter((row) => row.result.status === "skip");
  const passed = results.filter((row) => row.result.status === "pass");
  const assertions = results.reduce((sum, row) => sum + (row.result.assertions || 0), 0);
  const overBudget = Number.isFinite(budget) && totalMs > budget;

  console.log("");
  console.log("── 汇总 ─────────────────────────────────────────────");
  console.log("文件: 执行 " + (passed.length + failed.length) + " / 通过 " + passed.length + " / 失败 " + failed.length + " / 跳过 " + skipped.length);
  console.log("断言: " + assertions + "（只打印，不写文档）");
  console.log("用时: " + fmtMs(totalMs) + " / 预算 " + (Number.isFinite(budget) ? fmtMs(budget) : "不限") + (overBudget ? "  ← 超预算" : ""));
  if (skipped.length > 0) {
    console.log("跳过明细:");
    for (const row of skipped) console.log("  - " + row.entry.file + ": " + row.result.reason);
  }
  if (failed.length > 0) {
    console.log("失败明细:");
    for (const row of failed) console.log("  - " + row.entry.file + ": " + (row.result.reason || "失败"));
  }

  if (args.json !== undefined) {
    const report = {
      schema: 1,
      root: ROOT,
      version: registry.BASELINE_VERSION,
      totalMs,
      budgetMs: Number.isFinite(budget) ? budget : null,
      fileBudgetMs: fileBudget,
      concurrency,
      summary: {
        files: passed.length + failed.length,
        passed: passed.length,
        failed: failed.length,
        skipped: skipped.length,
        assertions,
        overBudget,
      },
      files: results.map((row) => ({
        file: row.entry.file,
        id: row.entry.id,
        kind: row.entry.kind,
        status: row.result.status,
        ms: row.result.ms,
        assertions: row.result.assertions,
        skips: row.result.skips,
        exitCode: row.result.exitCode,
        reason: row.result.reason,
      })),
    };
    writeFileSync(args.json, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log("JSON 报告: " + args.json);
  }

  const ok = failed.length === 0 && !overBudget;
  console.log(ok ? "\n结果: 全绿" : "\n结果: 失败");
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error("运行器崩溃: " + (error && error.stack ? error.stack : error));
  process.exit(1);
});
