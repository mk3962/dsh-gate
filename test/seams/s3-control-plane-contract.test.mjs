/**
 * S3 控制面接缝契约（票 01 · 四域五缝 S3）
 *
 * 真挂载 + 假 webServer：路由表、鉴权、请求体解析都跑 lib/server.js 的真实实现，
 * 只把宿主 webServer 与 req/res 换成可观测、可注入故障的夹具。
 * P1-1 / P1-10 的回放位在本文件；#06 接入后把「无响应」断言改成结构化错误信封。
 *
 * 跑法：node --import ./test/stub-loader.mjs test/seams/s3-control-plane-contract.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeHost } from "../host.mjs";
import {
  MAX_BODY_BYTES,
  createFakeWebServer,
  makeRequest,
  makeResponse,
  mountControlPlane,
  send,
  sweepAuthorization,
  trustedHeaders,
} from "./s3-control-plane-seam.mjs";
import { defects } from "./defect-registry.mjs";

const results = [];
const check = async (label, fn) => {
  try { await fn(); results.push({ label, ok: true }); }
  catch (error) { results.push({ label, ok: false, error: String((error && error.message) || error) }); }
};

const POLICY_DOC = {
  version: 3,
  defaults: { capability: 1, section: 1, skillpack: 2 },
  capabilities: {},
  sections: {},
  legacy: { unknownOverrides: {} },
};

/** 造一次「真挂载」。返回挂载结果与临时策略文件目录（用完即删）。 */
function setup(options) {
  const spec = options || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-control-"));
  const policyFile = path.join(root, "gate.json");
  fs.writeFileSync(policyFile, JSON.stringify(spec.policyDoc || POLICY_DOC, null, 2) + "\n", "utf8");
  const host = makeHost();
  const gate = spec.gate || {
    listAgents: () => [],
    snapshot: () => ({ agent: null, tiers: {}, counts: {}, loaded: [], known: [] }),
    knownNames: () => undefined,
    capabilityView: () => ({ capabilities: [], sections: [], skills: [] }),
  };
  const policy = Object.assign({
    enabled: true,
    policyFile,
    defaults: { capability: 1, section: 1, skillpack: 2 },
    capabilities: {},
    sections: {},
  }, spec.policy || {});
  const plane = mountControlPlane({ ctx: host.rootCtx, gate, policy, logger: host.logger, config: spec.config || {} });
  return { host, gate, policy, plane, root, policyFile };
}

const cleanup = (env) => fs.rmSync(env.root, { recursive: true, force: true });

// ─────────────────────────────────────────────────────────────────────────────
// 正例
// ─────────────────────────────────────────────────────────────────────────────

await check("真挂载 + 假 webServer：五条精确路由全部注册，dispose 全部撤销", async () => {
  const env = setup();
  try {
    assert.equal(env.plane.routes.length, 5);
    assert.deepEqual(env.plane.paths.sort(), [
      "/api/dsh-gate/capabilities",
      "/api/dsh-gate/mcp",
      "/api/dsh-gate/policy",
      "/api/dsh-gate/skills",
      "/api/dsh-gate/state",
    ]);
    for (const route of env.plane.routes) assert.equal(route.kind, "exact");
    assert.equal(env.server === undefined, true);
    env.plane.dispose();
    assert.equal(env.plane.server.disposedCount, 5);
    for (const route of env.plane.routes) assert.equal(route.disposed, true);
  } finally { cleanup(env); }
});

await check("鉴权遍历：每条路由对三类不可信请求都回 401/403 且真的写了响应", async () => {
  const env = setup();
  try {
    const reports = await sweepAuthorization(env.plane);
    assert.equal(reports.length, env.plane.routes.length * 3);
    for (const report of reports) {
      assert.ok([401, 403].includes(report.status), report.path + " / " + report.probe + " 未被鉴权拦下：status=" + report.status);
      assert.equal(report.ended, true, report.path + " 鉴权失败必须写响应");
      assert.equal(report.error, undefined);
    }
  } finally { cleanup(env); }
});

await check("新增一条未鉴权路由会被遍历自动判红", async () => {
  const env = setup();
  try {
    env.plane.server.register({
      kind: "exact",
      path: "/api/dsh-gate/rogue",
      handler: async (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{\"ok\":true}"); },
    });
    const reports = await sweepAuthorization(env.plane);
    const rogue = reports.filter((row) => row.path === "/api/dsh-gate/rogue");
    assert.equal(rogue.length, 3);
    assert.ok(rogue.every((row) => row.status === 200), "未鉴权路由必须被遍历抓到");
  } finally { cleanup(env); }
});

await check("受信 GET /state：200 + JSON 信封 + no-store", async () => {
  const env = setup();
  try {
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/state"), makeRequest({
      path: "/api/dsh-gate/state",
      headers: trustedHeaders(),
    }));
    assert.equal(outcome.status, 200);
    assert.equal(outcome.ended, true);
    assert.match(outcome.response.headers["content-type"], /application\/json/);
    assert.equal(outcome.response.headers["cache-control"], "no-store");
    for (const key of ["agent", "tiers", "loaded", "counts", "defaults"]) {
      assert.equal(key in outcome.json, true, "缺字段 " + key);
    }
    assert.equal(outcome.json.agent, null);
  } finally { cleanup(env); }
});

await check("受信 GET /policy：200 + v3 形状", async () => {
  const env = setup();
  try {
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
      path: "/api/dsh-gate/policy",
      headers: trustedHeaders(),
    }));
    assert.equal(outcome.status, 200);
    assert.equal(outcome.json.version, 3);
    assert.equal(outcome.json.migrated, false);
    assert.equal(typeof outcome.json.template, "object");
    assert.equal(outcome.json.file, env.policyFile);
  } finally { cleanup(env); }
});

await check("POST /policy 非 JSON 内容类型 → 415 信封", async () => {
  const env = setup();
  try {
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
      method: "POST",
      path: "/api/dsh-gate/policy",
      headers: trustedHeaders({ "content-type": "text/plain" }),
      body: "{}",
    }));
    assert.equal(outcome.status, 415);
    assert.equal(outcome.json.ok, false);
    assert.match(outcome.json.message, /application\/json/);
  } finally { cleanup(env); }
});

await check("POST /policy 坏 JSON → 400 信封", async () => {
  const env = setup();
  try {
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
      method: "POST",
      path: "/api/dsh-gate/policy",
      headers: trustedHeaders(),
      body: "{not json",
    }));
    assert.equal(outcome.status, 400);
    assert.equal(outcome.json.ok, false);
    assert.match(outcome.json.message, /JSON 解析失败/);
  } finally { cleanup(env); }
});

await check("POST /policy 超大 body（>" + MAX_BODY_BYTES + "）→ 400，不落盘", async () => {
  const env = setup();
  try {
    const before = fs.readFileSync(env.policyFile, "utf8");
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
      method: "POST",
      path: "/api/dsh-gate/policy",
      headers: trustedHeaders(),
      streamMode: "oversized",
    }));
    assert.equal(outcome.status, 400);
    assert.equal(outcome.json.ok, false);
    assert.equal(fs.readFileSync(env.policyFile, "utf8"), before, "超限请求不得改动策略文件");
  } finally { cleanup(env); }
});

await check("慢速分块流：跨 chunk 的 JSON 必须被完整解析并 200", async () => {
  const env = setup();
  try {
    const body = JSON.stringify({ defaults: { capability: 2 } });
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
      method: "POST",
      path: "/api/dsh-gate/policy",
      headers: trustedHeaders(),
      chunks: [body.slice(0, 8), body.slice(8)],
      streamMode: "slow",
      delayMs: 5,
    }));
    assert.equal(outcome.status, 200);
    assert.equal(outcome.json.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(env.policyFile, "utf8")).defaults.capability, 2);
  } finally { cleanup(env); }
});

await check("客户端中途断连（aborted）：handler 拒绝且不写响应（P1-1 回放位）", async () => {
  const env = setup();
  try {
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
      method: "POST",
      path: "/api/dsh-gate/policy",
      headers: trustedHeaders(),
      streamMode: "aborted",
    }));
    // 0.5.7 现状：readJsonBody 直接抛，handler 内无 try/catch ⇒ 永不写响应。
    // #06 接入统一装饰器后，这里的断言改为 500 + 结构化错误信封。
    assert.equal(outcome.error && outcome.error.code, "ECONNRESET", "断连必须把错误暴露给接缝");
    assert.equal(outcome.ended, false, "0.5.7 在断连下确实没有响应（P1-1 的观测基线）");
    assert.equal(outcome.status, undefined);
  } finally { cleanup(env); }
});

await check("自定义 headers / origin / token 组合：同源放行、跨站拒绝", async () => {
  const env = setup();
  try {
    const allowed = await send(env.plane.handlerOf("/api/dsh-gate/state"), makeRequest({
      path: "/api/dsh-gate/state",
      headers: trustedHeaders({ cookie: "dsh-auth-deadbeef", "x-custom": "1" }),
    }));
    assert.equal(allowed.status, 200);
    const rejected = await send(env.plane.handlerOf("/api/dsh-gate/state"), makeRequest({
      path: "/api/dsh-gate/state",
      headers: trustedHeaders({ origin: "null" }),
    }));
    assert.equal(rejected.status, 403);
    const noHost = await send(env.plane.handlerOf("/api/dsh-gate/state"), makeRequest({
      path: "/api/dsh-gate/state",
      headers: { "content-type": "application/json" },
    }));
    assert.equal(noHost.status, 200, "无 Host 头按四道门的既有口径放行（回环来源）");
  } finally { cleanup(env); }
});

await check("假响应夹具自身形状稳定（writeHead/end 幂等可观测）", async () => {
  const response = makeResponse();
  response.writeHead(200, { "content-type": "application/json" });
  response.end("{\"a\":1}");
  assert.equal(response.statusCode, 200);
  assert.equal(response.ended, true);
  assert.deepEqual(response.json, { a: 1 });
  assert.equal(response.headers["content-type"], "application/json");
});

await check("P1-1 回放位登记在案", async () => {
  const p11 = defects.find((row) => row.id === "P1-1");
  assert.equal(p11.seam, "S3");
  assert.equal(p11.ticket, "#06");
  assert.match(p11.symptom, /结构化错误信封/);
});

const failed = results.filter((entry) => !entry.ok);
for (const entry of results) {
  console.log((entry.ok ? "  ok    " : "  FAIL  ") + entry.label + (entry.ok ? "" : "  →  " + entry.error));
}
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exitCode = failed.length === 0 ? 0 : 1;