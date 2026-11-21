/**
 * 测试套件注册表（0.6.0 · 工单 #08 / D22 / G90）—— **扫描式 runner 的唯一真源**。
 *
 * 纪律：
 *   1. 必过集 = 磁盘扫描结果，不再手写清单：test/*.test.mjs + test/seams/*.test.mjs
 *      按文件名排序，一个都不许漏；新加文件自动进链。
 *   2. 只有探测类（需要真宿主/真 profile）和明确的非套件辅助文件可以排除，
 *      且必须写在 PROBE / NON_SUITE 里并带原因。
 *   3. 跳过必须带原因；运行器把「无原因的跳过」当失败。
 *   4. 预算：整轮 < 12s，单文件 < 2s（个别接缝在 OVERRIDES 里显式放宽）。
 *
 * 0.5.7 的 `npm test` 是 32 段 && 长链，链外有两个 .test.mjs 从未执行
 * （catalog-d17 / runtime-d04）—— 这正是 D22 要修的「测试注册表与真实文件集漂移」。
 * 现在注册表由扫描生成，check-spec G90.5 再与磁盘双向比对，改名/新增都不会静默漏跑。
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** 0.7.0 的版本基线：package.json / CHANGELOG / 注册表三处必须一致。 */
export const BASELINE_VERSION = "0.7.0";

/** 整轮预算（毫秒）。CI 与本机默认一致，超了直接红。 */
export const TOTAL_BUDGET_MS = 12000;

/** 单文件默认预算（毫秒）。条目可覆盖。 */
export const FILE_BUDGET_MS = 2000;

/** 测试运行器统一入口：所有套件都通过 test/stub-loader.mjs 解析宿主。 */
export const LOADER_ARGS = ["--import", "./test/stub-loader.mjs"];

/** 不在 *.test.mjs 命名里、但历史上属于必过链的遗留入口。 */
const LEGACY = [
  { file: "test/selftest.mjs", id: "legacy-selftest", kind: "suite", budgetMs: 4000 },
  {
    file: "test/loadtest.mjs",
    id: "legacy-loadtest",
    kind: "suite",
    budgetMs: 3000,
    skip: {
      when: "env:DSH_GATE_LOADTEST",
      reason: "长跑压力套件，默认不进 12s 必过门；需要时设 DSH_GATE_LOADTEST=1 单独跑",
    },
  },
];

/** 按文件覆盖：稳定 id、预算、跳过原因（键必须真实存在，否则 runner 与 check-spec 报 FAIL）。 */
export const OVERRIDES = new Map([
  ["test/resource-bounds.test.mjs", { budgetMs: 4000 }],
  ["test/seams/s1-host-contract.test.mjs", { id: "seam-s1", budgetMs: 4000 }],
  ["test/seams/s2-policy-store.test.mjs", { id: "seam-s2-policy-store", budgetMs: 4000 }],
  ["test/seams/s2-storage-contract.test.mjs", { id: "seam-s2-storage", budgetMs: 4000 }],
  ["test/seams/s3-http-contract.test.mjs", { id: "seam-s3-http", budgetMs: 4000 }],
  ["test/seams/s4-frontend-contract.test.mjs", { id: "seam-s4-frontend", budgetMs: 4000 }],
  ["test/seams/s4-frontend-v2.test.mjs", { id: "seam-s4-frontend-v2", budgetMs: 7000 }],
  [
    "test/seams/s5-deploy-contract.test.mjs",
    {
      id: "seam-s5",
      // 26+ 个用例各自真跑 PowerShell（用例级并发 8），实测 ~6.5–7.5s；单文件预算放宽到 18s 防 4 并发下偶发抖动误杀，
      // 整轮仍受 TOTAL_BUDGET_MS=12000 的总闸约束（LJF 调度让 S5 第一个起跑）。
      budgetMs: 18000,
      skip: {
        when: "non-win32",
        reason: "S5 部署契约需要 Windows PowerShell 5.1 与 .cmd shim；非 Windows 上打印原因后跳过（CI 的 Ubuntu 矩阵覆盖其余接缝）",
      },
    },
  ],
]);

/** 探测套件：需要真宿主 / 真 profile，绝不进必过门（CI 不跑，本机按需）。 */
export const PROBE = [
  {
    file: "test/seams/s1b-real-host-probe.mjs",
    id: "probe-s1b",
    reason: "需要真实宿主安装与真实 profile，无法在沙箱中复现",
  },
];

/** 允许出现在 test/ 下但不执行的辅助文件（非套件）。 */
export const NON_SUITE = new Set([
  "test/host.mjs",
  "test/stub-loader.mjs",
  "test/stub-resolver.mjs",
  "test/seams/defect-registry.mjs",
  "test/seams/mutation.mjs",
  "test/seams/s1-message-adapter.mjs",
  "test/seams/s3-control-plane-seam.mjs",
  "test/seams/s4-frontend-harness.mjs",
  "test/seams/s5-deploy-seam.mjs",
]);

function listTests(relDir) {
  const abs = path.join(ROOT, relDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => relDir + "/" + name);
}

function entryFor(file) {
  const override = OVERRIDES.get(file) || {};
  const base = path.basename(file, ".test.mjs");
  const isSeam = file.startsWith("test/seams/");
  const id = override.id || (isSeam ? "seam-" + base : base);
  return {
    file,
    id,
    kind: override.kind || (isSeam ? "node-test" : "suite"),
    budgetMs: override.budgetMs,
    skip: override.skip,
  };
}

/** 必过套件：磁盘扫描 + 遗留入口，按文件名稳定排序；排除 PROBE 与重复文件。 */
const seen = new Set();
function unique(entry) {
  if (seen.has(entry.file)) return false;
  seen.add(entry.file);
  return true;
}

export const MUST_RUN = [
  ...LEGACY,
  ...listTests("test").map(entryFor),
  ...listTests("test/seams").map(entryFor),
]
  .filter((entry) => !PROBE.some((probe) => probe.file === entry.file))
  .filter(unique)
  .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

/** 一份扁平化清单（runner / check-spec 共用）。 */
export function allSuites() {
  return MUST_RUN.slice();
}

/** 按文件名稳定排序（runner 的执行顺序）。 */
export function sortedSuites(list) {
  return list.slice().sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** 跳过判定：返回原因字符串；不跳过返回 undefined。 */
export function skipReasonFor(entry, env) {
  const skip = entry.skip;
  if (skip === undefined || skip === null) return undefined;
  if (skip.when === "non-win32") {
    return process.platform === "win32" ? undefined : skip.reason;
  }
  if (typeof skip.when === "string" && skip.when.startsWith("env:")) {
    const name = skip.when.slice(4);
    const value = env[name];
    return value === undefined || value === "" ? skip.reason : undefined;
  }
  return skip.reason;
}
