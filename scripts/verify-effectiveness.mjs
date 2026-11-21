#!/usr/bin/env node
/**
 * 定点破坏有效性自检（0.6.0 · 工单 #08 / D22 / G91）。
 *
 * 解决的问题：0.5.7 的门禁里存在恒真断言与「删掉分支测试也照样绿」的假绿
 * （defect-registry 的 FG-1..FG-7）。本脚本对每条宿主事实 / 不变量做**定点破坏**：
 *
 *   1. 在 os.tmpdir() 下建沙箱，复制 lib/ 与 scripts/（绝不写工作树，绝不碰真 profile）；
 *   2. 先跑未变异的基线探针 —— 基线必须绿，否则说明探针本身坏了（或不变式当前就是破的）；
 *   3. 复制一份沙箱，按用例把 anchor 替换成 replacement（anchor 必须恰好出现一次）；
 *   4. 在变异沙箱里再跑同一探针 —— **必须红**，否则这条事实/不变量没有守门（假绿）。
 *
 * 结论枚举：
 *   effective       基线绿 + 变异红（合格）
 *   ineffective     基线绿 + 变异仍绿（门禁有洞，退出码 1）
 *   baseline-red    基线红（探针坏或缺陷尚未修；pending 用例只告警）
 *   anchor-missing  变异锚点漂移（源码改了但用例没跟，退出码 1）
 *   blocked         依赖文件缺失（等其它工单集成；--strict 下算失败）
 *
 * 用法：
 *   node scripts/verify-effectiveness.mjs [--root <仓库根>] [--strict] [--only <id,id>]
 *                                         [--list] [--json <文件>] [--keep] [--timeout <ms>]
 *
 * 退出码：0 全部 effective（pending/blocked 仅告警）；1 存在 ineffective / anchor-missing / 基线红；
 *         --strict 下 pending 与 blocked 也算失败。
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..");
const PREFIX = "dsh-gate-verify-";

function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT, strict: false, only: undefined, list: false, json: undefined, keep: false, timeout: 15000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") out.root = path.resolve(argv[++i]);
    else if (arg === "--strict") out.strict = true;
    else if (arg === "--only") out.only = new Set(String(argv[++i]).split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg === "--list") out.list = true;
    else if (arg === "--json") out.json = path.resolve(argv[++i]);
    else if (arg === "--keep") out.keep = true;
    else if (arg === "--timeout") out.timeout = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      console.log("用法: node scripts/verify-effectiveness.mjs [--root <dir>] [--strict] [--only <id,id>] [--list] [--json <file>] [--keep] [--timeout <ms>]");
      process.exit(0);
    } else {
      console.error("未知参数: " + arg);
      process.exit(1);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function runProbe(dir, source, id) {
  const file = path.join(dir, "probe-" + id.toLowerCase() + ".mjs");
  writeFileSync(file, source + "\n", "utf8");
  const result = spawnSync(process.execPath, [file], {
    cwd: dir,
    timeout: args.timeout,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, DSH_GATE_VERIFY: "1" },
  });
  const output = String(result.stdout || "") + String(result.stderr || "");
  return {
    green: result.status === 0 && !result.error,
    status: result.status,
    output: output.trim(),
    timedOut: result.error !== undefined && result.error.code === "ETIMEDOUT",
  };
}

function copyBase(root, dest) {
  mkdirSync(dest, { recursive: true });
  for (const dir of ["lib", "scripts"]) {
    const from = path.join(root, dir);
    if (!existsSync(from)) continue;
    cpSync(from, path.join(dest, dir), { recursive: true });
  }
  writeFileSync(path.join(dest, "package.json"), JSON.stringify({ name: "dsh-gate-effectiveness-sandbox", private: true, type: "module" }, null, 2) + "\n", "utf8");
}

function applyMutation(root, dest, testCase) {
  const sourcePath = path.join(root, testCase.target);
  const originalText = readFileSync(sourcePath, "utf8");
  // 锚点一律用 LF 书写；源文件可能是 CRLF（Windows 侧编辑器），比对与替换前先归一，
  // 写回时恢复原文件的换行风格 —— 不然锚点会因 CR 字符而失效。
  const crlf = originalText.includes("\r\n");
  const text = crlf ? originalText.replace(/\r\n/g, "\n") : originalText;
  const occurrences = text.split(testCase.anchor).length - 1;
  if (occurrences === 0) return { ok: false, code: "anchor-missing", detail: "锚点不在 " + testCase.target + "（源码已漂移）" };
  if (occurrences > 1) return { ok: false, code: "anchor-ambiguous", detail: "锚点在 " + testCase.target + " 出现 " + occurrences + " 次（必须唯一）" };
  const mutated = text.replace(testCase.anchor, testCase.replacement);
  if (mutated === text) return { ok: false, code: "anchor-missing", detail: "替换后内容未变化" };
  const targetPath = path.join(dest, testCase.target);
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, crlf ? mutated.replace(/\n/g, "\r\n") : mutated, "utf8");
  return { ok: true };
}

function fmt(ms) { return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(2) + "s"; }

async function main() {
  const root = args.root;
  if (!existsSync(path.join(root, "package.json"))) {
    console.error("不是仓库根（缺少 package.json）: " + root);
    process.exit(1);
  }
  const casesUrl = pathToFileURL(path.join(HERE, "effectiveness-cases.mjs")).href + "?t=" + Date.now();
  const imported = await import(casesUrl);

  const all = imported.CASES;
  const selected = args.only === undefined ? all : all.filter((entry) => args.only.has(entry.id));
  if (args.list) {
    for (const entry of all) console.log(entry.id + "\t" + entry.kind + "\t" + entry.target + "\t" + entry.title);
    process.exit(0);
  }
  for (const id of args.only || []) {
    if (!all.some((entry) => entry.id === id)) { console.error("未知用例: " + id); process.exit(1); }
  }

  const base = mkdtempSync(path.join(os.tmpdir(), PREFIX));
  const cleanup = () => {
    if (args.keep) { console.log("沙箱保留: " + base); return; }
    const resolved = path.resolve(base);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) { console.error("拒绝删除非临时目录: " + resolved); return; }
    rmSync(resolved, { recursive: true, force: true });
  };

  console.log("dsh-gate 0.6.0 · 定点破坏有效性自检");
  console.log("仓库: " + root);
  console.log("沙箱: " + base + (args.keep ? "（保留）" : "（结束删除）"));
  console.log("用例: " + selected.length + " / " + all.length);
  console.log("");

  const rows = [];
  const started = Date.now();
  try {
    const baseDir = path.join(base, "base");
    copyBase(root, baseDir);

    for (const testCase of selected) {
      const startedCase = Date.now();
      const missing = (testCase.requires || []).filter((rel) => !existsSync(path.join(root, rel)));
      if (missing.length > 0) {
        rows.push({ case: testCase, status: testCase.pending === true ? "blocked" : "blocked", detail: "缺少依赖: " + missing.join(", ") + "（等对应工单集成）", ms: Date.now() - startedCase });
        console.log("BLOCK  " + testCase.id.padEnd(6) + testCase.title + " —— 缺少 " + missing.join(", "));
        continue;
      }

      const baseline = runProbe(baseDir, testCase.probe, testCase.id);
      if (!baseline.green) {
        const status = testCase.pending === true ? "blocked" : "baseline-red";
        rows.push({ case: testCase, status, detail: "基线探针未通过（探针坏或不变式当前被破坏）", output: baseline.output, ms: Date.now() - startedCase });
        console.log((status === "blocked" ? "BLOCK  " : "RED    ") + testCase.id.padEnd(6) + testCase.title + " —— 基线未通过");
        if (baseline.output) console.log("       " + baseline.output.split(/\r?\n/).slice(-6).join("\n       "));
        continue;
      }

      if (testCase.probeOnly === true) {
        rows.push({ case: testCase, status: "effective", detail: "契约探针绿（无定点破坏：接口由 #06 定义，锚点待其定型后补）", ms: Date.now() - startedCase });
        console.log("OK     " + testCase.id.padEnd(6) + testCase.title + "  (契约探针)");
        continue;
      }

      const caseDir = path.join(base, "case-" + testCase.id.toLowerCase());
      copyBase(root, caseDir);
      const mutation = applyMutation(root, caseDir, testCase);
      if (!mutation.ok) {
        rows.push({ case: testCase, status: "anchor-missing", detail: mutation.detail, ms: Date.now() - startedCase });
        console.log("FAIL   " + testCase.id.padEnd(6) + testCase.title + " —— " + mutation.detail);
        continue;
      }
      const mutated = runProbe(caseDir, testCase.probe, testCase.id);
      if (mutated.green) {
        rows.push({ case: testCase, status: "ineffective", detail: "变异后探针仍然通过（这条事实/不变量没有守门）", output: mutated.output, ms: Date.now() - startedCase });
        console.log("FAIL   " + testCase.id.padEnd(6) + testCase.title + " —— 变异未被发现");
      } else {
        rows.push({ case: testCase, status: "effective", detail: "基线绿 → 变异红", ms: Date.now() - startedCase });
        console.log("OK     " + testCase.id.padEnd(6) + testCase.title + "  (" + fmt(Date.now() - startedCase) + ")");
      }
    }
  } finally {
    cleanup();
  }
  const totalMs = Date.now() - started;
  const count = (status) => rows.filter((row) => row.status === status).length;
  const effective = count("effective");
  const bad = count("ineffective") + count("baseline-red") + count("anchor-missing");
  const blocked = count("blocked");

  console.log("");
  console.log("── 汇总 ─────────────────────────────────────────────");
  console.log("合格: " + effective + " / " + rows.length + "  失效: " + count("ineffective") + "  基线红: " + count("baseline-red") + "  锚点缺失: " + count("anchor-missing") + "  阻塞: " + blocked);
  console.log("用时: " + fmt(totalMs));

  if (args.json !== undefined) {
    writeFileSync(args.json, JSON.stringify({
      schema: 1,
      root,
      totalMs,
      summary: { total: rows.length, effective, ineffective: count("ineffective"), baselineRed: count("baseline-red"), anchorMissing: count("anchor-missing"), blocked },
      cases: rows.map((row) => ({ id: row.case.id, kind: row.case.kind, target: row.case.target, status: row.status, detail: row.detail, ms: row.ms })),
    }, null, 2) + "\n", "utf8");
    console.log("JSON 报告: " + args.json);
  }

  const strictFail = args.strict && blocked > 0;
  const ok = bad === 0 && !strictFail;
  console.log(ok ? "\n结果: 全部有效" : "\n结果: 失败");
  process.exit(ok ? 0 : 1);
}

await main().catch((error) => {
  console.error("自检崩溃: " + (error && error.stack ? error.stack : error));
  process.exit(1);
});
