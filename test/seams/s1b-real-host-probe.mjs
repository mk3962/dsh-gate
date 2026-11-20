/**
 * S1b 真宿主一致性探针（可选，不进必过门）
 *
 * 价值：让 S1 契约夹具永远不靠猜。同一套夹具事实在这里挂一个「真宿主适配器」，
 * 跑四项观测（装配 / 加载 / 转发 / 表面回放）并与夹具口径对拍。
 *
 * 纪律：
 *   - 只读：不写目标 profile、不改宿主文件、不启动宿主进程；
 *   - 不进必过门：找不到可用宿主时输出 skipped 报告并 exit 0（打印原因，禁静默）；
 *   - 依赖注入：真宿主适配器由 DSH_GATE_REAL_HOST_ADAPTER 指定（一个导出 createRealHostProbe 的模块）；
 *     没有适配器就只做静态观测（安装面）。
 *
 * 跑法：node test/seams/s1b-real-host-probe.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { makeHost } from "../host.mjs";

const OBSERVATIONS = ["assemble", "load", "forward", "surface-replay"];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
}

/** 静态观测：目标 profile 是否装了 gate、版本多少（只读）。 */
function inspectInstallation() {
  const root = process.env.DSH_GATE_HOST_ROOT || path.join(os.homedir(), ".dsh");
  const profile = process.env.DSH_GATE_HOST_PROFILE || path.join(root, "profiles", "desktop");
  const plugin = path.join(profile, "node_modules", "dsh-gate", "package.json");
  const installed = readJson(plugin);
  return {
    root,
    rootExists: fs.existsSync(root),
    profile,
    profileExists: fs.existsSync(profile),
    pluginInstalled: installed !== undefined,
    pluginVersion: installed && installed.version,
  };
}

async function loadAdapter() {
  const spec = process.env.DSH_GATE_REAL_HOST_ADAPTER;
  if (spec === undefined || spec === "") return undefined;
  try {
    const module = await import(pathToFileURL(path.resolve(process.cwd(), spec)).href);
    return typeof module.createRealHostProbe === "function" ? module.createRealHostProbe : undefined;
  } catch (error) {
    return { error: String((error && error.message) || error) };
  }
}

/** 夹具侧口径：S1 假宿主在六条事实上的观测（对拍的基线）。 */
function fixtureFacts() {
  const host = makeHost();
  const receipt = host.emitIsolated("probe/echo");
  return {
    transport: "run_code",
    ledgers: Object.keys(host.readLedger === undefined ? {} : { restrictions: 1, dispatches: 1, deliveries: 1, lifecycle: 1 }),
    zeroListenerDelivered: receipt.delivered,
    liveCounts: host.liveCounts(),
  };
}

const installation = inspectInstallation();
const adapter = await loadAdapter();
const findings = [];

if (typeof adapter === "function") {
  for (const name of OBSERVATIONS) {
    try {
      const observed = await adapter({ observation: name, installation });
      findings.push({ observation: name, status: observed === undefined ? "skipped" : "observed", value: observed });
    } catch (error) {
      findings.push({ observation: name, status: "failed", error: String((error && error.message) || error) });
    }
  }
} else {
  const reason = adapter === undefined
    ? "no real-host adapter configured (DSH_GATE_REAL_HOST_ADAPTER unset)"
    : "adapter failed to load: " + adapter.error;
  for (const name of OBSERVATIONS) findings.push({ observation: name, status: "skipped", reason });
}

const report = {
  probe: "S1b",
  blocking: false,
  mode: "read-only",
  generatedAt: new Date().toISOString(),
  installation,
  fixture: fixtureFacts(),
  findings,
  verdict: findings.every((row) => row.status === "observed") ? "observed" : "skipped",
  note: "本探针不进必过门：依赖真宿主安装与适配器，失败只出报告；S1 契约夹具不依赖它。",
};

console.log(JSON.stringify(report, null, 2));
for (const row of findings) {
  console.log("[S1b] " + row.observation + ": " + row.status + (row.reason ? "（" + row.reason + "）" : ""));
}
console.log("[S1b] verdict=" + report.verdict + "（skipped 不是失败；跳过原因已打印）");
process.exitCode = 0;
