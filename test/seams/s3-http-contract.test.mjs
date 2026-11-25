/**
 * S3 控制面 HTTP 契约（票 01 的接缝升级 · 工单 #06 的落地验收）
 *
 * 真挂载 + 假 webServer：路由表、装饰器八步、鉴权、读体、错误信封全走 lib/ 的真实实现，
 * 只把宿主 webServer 与 req/res 换成可观测、可注入故障的夹具。
 *
 * 这个文件**取代** 0.5.7 的 s3-control-plane-contract.test.mjs：
 *   - 路由数从 5 变 6（新增只读诊断），且从"手写清单"升级为"与 CONTROL_PLANE_ROUTES 逐条对齐"；
 *   - 超限从 400 翻成 413 PAYLOAD_TOO_LARGE；
 *   - 客户端断连从"没有响应"翻成 500 INTERNAL 信封（P1-1 的修法在这里回放）；
 *   - tier 被 Number() 强转 0（P1-10）在这里回放；
 *   - 新增：八步顺序、Allow 头、声明长度预检不读体、2xx+ok=false、访问统计、诊断四组、技能原子批量。
 *
 * 跑法：node --import ./test/stub-loader.mjs --test test/seams/s3-http-contract.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeHost } from "../host.mjs";
import {
  MAX_BODY_BYTES,
  makeRequest,
  makeResponse,
  mountControlPlane,
  send,
  sweepAuthorization,
  trustedHeaders,
} from "./s3-control-plane-seam.mjs";
import { defects } from "./defect-registry.mjs";
import { CONTROL_PLANE_ROUTES, routeDocTable } from "../../lib/control/routes.js";
import { PIPELINE_STEPS, createControlHandler } from "../../lib/control/decorator.js";
import { AUTH_CODES, CANONICAL_CODES, CODE_STATUS, ERROR_CODES, ERROR_STATUS, SERVICE_CODES, parseTier } from "../../lib/control/errors.js";
import { REPLAY_CASES } from "./s3-replay-cases.mjs";

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

const blankSnapshot = () => ({
  enabled: true, policyFile: "", agent: null, visible: 0, resident: 0, onDemand: 0, off: 0,
  gated: 0, passthrough: false, loaded: [], catalogChars: 0, catalogTokens: 0,
  residentNames: [], onDemandNames: [], offNames: [], ownNames: [], presetNames: [],
  sections: [], skills: [], skillEntries: [], tiers: {},
});

const stubGate = (over) => Object.assign({
  listAgents: () => [],
  snapshot: () => blankSnapshot(),
  knownNames: () => undefined,
  capabilityView: () => ({ capabilities: [], sections: [], skills: [] }),
  reapply: () => undefined,
  refreshSkills: () => undefined,
}, over || {});

/** 造一次「真挂载」。返回挂载结果与临时策略文件目录（用完即删）。 */
function setup(options) {
  const spec = options || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-http-"));
  const policyFile = path.join(root, "gate.json");
  fs.writeFileSync(policyFile, JSON.stringify(spec.policyDoc || POLICY_DOC, null, 2) + "\n", "utf8");
  const host = makeHost();
  const gate = spec.gate || stubGate();
  const policy = Object.assign({
    enabled: true,
    policyFile,
    defaults: { capability: 1, section: 1, skillpack: 2 },
    capabilities: {},
    sections: {},
  }, spec.policy || {});
  // config.policyFile 必须与临时文件一致：persistPolicy 会用 resolvePolicy 重解析插件行 config，
  // 不给文件路径就会漂到默认 gate.json（0.5.7 的真实事故面，core.persistPolicy 已加护栏）。
  const plane = mountControlPlane({ ctx: spec.ctx || host.rootCtx, gate, policy, logger: host.logger, config: Object.assign({ policyFile }, spec.config || {}) });
  return { host, gate, policy, plane, root, policyFile };
}

const cleanup = (env) => fs.rmSync(env.root, { recursive: true, force: true });

/** 宿主鉴权可控的 ctx（401/403 映射与回退诊断用）。 */
const ctxWithConnection = (connection) => {
  const routes = [];
  const ctx = {
    get(name) { return name === "connection" ? connection : undefined; },
    reflect: { get() { return undefined; } },
    inject(_names, callback) {
      callback({ webServer: { register(route) { routes.push(route); return () => undefined; } } });
    },
  };
  ctx.routes = routes;
  return ctx;
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. 路由表与装饰器装配
// ─────────────────────────────────────────────────────────────────────────────
await check("路由表：六条精确路由全部注册，且与 CONTROL_PLANE_ROUTES 逐条一致", async () => {
  const env = setup();
  try {
    assert.equal(env.plane.routes.length, 6, "0.5.7 是 5 条，诊断端点让它变 6");
    assert.deepEqual(env.plane.paths.sort(), CONTROL_PLANE_ROUTES.map((route) => route.path).sort());
    for (const route of env.plane.routes) {
      assert.equal(route.kind, "exact");
      const declared = CONTROL_PLANE_ROUTES.find((row) => row.path === route.path);
      assert.ok(declared, "路由表里没有这一条: " + route.path);
      assert.deepEqual(route.methods, declared.methods, route.path + " 方法清单必须来自路由表");
      assert.equal(route.body, declared.body, route.path + " 是否需要体必须来自路由表");
    }
    env.plane.dispose();
    assert.equal(env.plane.server.disposedCount, 6);
    for (const route of env.plane.routes) assert.equal(route.disposed, true);
  } finally { cleanup(env); }
});

await check("文档端点表由路由表生成（#08 断言一致用，不手写第二份）", async () => {
  const table = routeDocTable();
  assert.equal(table.length, CONTROL_PLANE_ROUTES.length);
  for (const row of table) {
    assert.equal(typeof row.methods, "string");
    assert.equal(typeof row.summary, "string");
    assert.ok(row.summary.length > 0, row.id + " 摘要不能为空");
    assert.equal(typeof row.body, "boolean");
    assert.ok(["agent", "none"].includes(row.scope), row.id + " 作用域只能是 agent / none");
  }
});

await check("装饰器八步顺序是契约（PIPELINE_STEPS 与注释一致）", async () => {
  assert.deepEqual(PIPELINE_STEPS, [
    "method", "content-type", "content-length", "read-body", "json", "auth", "scope", "handler",
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 八步逐条
// ─────────────────────────────────────────────────────────────────────────────
await check("八步·1 方法：PUT /state → 405 + Allow 头 + METHOD_NOT_ALLOWED", async () => {
  const env = setup();
  try {
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/state"), makeRequest({
      method: "PUT",
      path: "/api/dsh-gate/state",
      headers: trustedHeaders(),
    }));
    assert.equal(outcome.status, 405, "method=" + outcome.body);
    assert.equal(outcome.json.code, "METHOD_NOT_ALLOWED");
    assert.equal(outcome.json.ok, false);
    assert.equal(outcome.response.headers.allow, "GET", "必须带 Allow 头");
    assert.equal(outcome.ended, true);
  } finally { cleanup(env); }
});

await check("八步·2 内容类型：POST /policy text/plain → 415 UNSUPPORTED_MEDIA_TYPE", async () => {
  const env = setup();
  try {
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
      method: "POST",
      path: "/api/dsh-gate/policy",
      headers: trustedHeaders({ "content-type": "text/plain" }),
      body: "{}",
    }));
    assert.equal(outcome.status, 415);
    assert.equal(outcome.json.code, "UNSUPPORTED_MEDIA_TYPE");
    assert.match(outcome.json.message, /application\/json/);
  } finally { cleanup(env); }
});

await check("八步·3 声明长度：Content-Length 超限 → 413 且**一个字节都不读**", async () => {
  const env = setup();
  try {
    // 故意让流一读就抛 ECONNRESET：如果装饰器先读体，就会落到 500 body-aborted；
    // 拿到 413 就证明预检在流之前（F71 的修法）。
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
      method: "POST",
      path: "/api/dsh-gate/policy",
      headers: trustedHeaders({ "content-length": String(MAX_BODY_BYTES + 1) }),
      streamMode: "aborted",
    }));
    assert.equal(outcome.status, 413, "body=" + outcome.body);
    assert.equal(outcome.json.code, "PAYLOAD_TOO_LARGE");
    assert.equal(outcome.json.details.read, false, "声明长度预检必须标注没读体");
    assert.equal(outcome.json.details.declared, MAX_BODY_BYTES + 1);
  } finally { cleanup(env); }
});

await check("八步·4 读体：慢速分块流跨 chunk 的 JSON 完整解析并 200", async () => {
  const env = setup();
  try {
    const body = JSON.stringify({ defaults: { capability: 2 } });
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
      method: "POST",
      path: "/api/dsh-gate/policy",
      headers: trustedHeaders(),
      chunks: [body.slice(0, 8), body.slice(8)],
      streamMode: "slow",
      delayMs: 2,
    }));
    assert.equal(outcome.status, 200, "body=" + outcome.body);
    assert.equal(outcome.json.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(env.policyFile, "utf8")).defaults.capability, 2);
  } finally { cleanup(env); }
});

await check("八步·4 读体：流超限 → 413 PAYLOAD_TOO_LARGE 且不落盘", async () => {
  const env = setup();
  try {
    const before = fs.readFileSync(env.policyFile, "utf8");
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
      method: "POST",
      path: "/api/dsh-gate/policy",
      headers: trustedHeaders(),
      streamMode: "oversized",
    }));
    assert.equal(outcome.status, 413, "body=" + outcome.body);
    assert.equal(outcome.json.code, "PAYLOAD_TOO_LARGE");
    assert.equal(fs.readFileSync(env.policyFile, "utf8"), before, "超限请求不得改动策略文件");
  } finally { cleanup(env); }
});

await check("八步·4 读体：客户端中途断连 → 500 INTERNAL 结构化信封并真的写了响应（P1-1）", async () => {
  const env = setup();
  try {
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
      method: "POST",
      path: "/api/dsh-gate/policy",
      headers: trustedHeaders(),
      streamMode: "aborted",
    }));
    // 0.5.7：readJsonBody 直接抛，handler 无 try/catch ⇒ 永不写响应（P1-1）。
    // #06：装饰器把流错误收成 body-aborted，**仍然写出**结构化 500，连接不留悬挂。
    assert.equal(outcome.error, undefined, "装饰器不许把异常逃给宿主: " + (outcome.error && outcome.error.message));
    assert.equal(outcome.ended, true, "断连下也必须写出响应");
    assert.equal(outcome.status, 500);
    assert.equal(outcome.json.code, "INTERNAL");
    assert.equal(outcome.json.details.reason, "body-aborted");
  } finally { cleanup(env); }
});

await check("八步·5 JSON：坏 JSON → 400 INVALID_BODY（不再落到 400 的泛化消息）", async () => {
  const env = setup();
  try {
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
      method: "POST",
      path: "/api/dsh-gate/policy",
      headers: trustedHeaders(),
      body: "{not json",
    }));
    assert.equal(outcome.status, 400);
    assert.equal(outcome.json.code, "INVALID_BODY");
    assert.match(outcome.json.message, /JSON 解析失败/);
  } finally { cleanup(env); }
});

await check("八步·5 JSON：空请求体 → 400 INVALID_BODY（顺序证据：体先于鉴权）", async () => {
  const env = setup();
  try {
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
      method: "POST",
      path: "/api/dsh-gate/policy",
      headers: trustedHeaders(),
    }));
    assert.equal(outcome.status, 400);
    assert.equal(outcome.json.code, "INVALID_BODY");
    // 这一条是 test/selftest.mjs 的 "POST /policy 宿主判 403" 需要补 body 的原因：
    // 规格把读体放在鉴权之前，所以空体会先被判 400 —— 见 README-integration.md §4。
  } finally { cleanup(env); }
});

await check("八步·6 鉴权：三类不可信请求 × 六条路由 → 401/403 且真的写了响应", async () => {
  const env = setup();
  try {
    const reports = await sweepAuthorization(env.plane);
    assert.equal(reports.length, env.plane.routes.length * 3);
    for (const report of reports) {
      assert.ok([401, 403].includes(report.status), report.path + " / " + report.probe + " 未被拦下：status=" + report.status);
      assert.equal(report.ended, true, report.path + " 鉴权失败必须写响应");
      assert.equal(report.error, undefined);
    }
  } finally { cleanup(env); }
});

await check("八步·6 鉴权：宿主判 401 → UNAUTHORIZED，判 403 → FORBIDDEN（码与状态一一对应）", async () => {
  const host = makeHost();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-http-auth-"));
  const policyFile = path.join(root, "gate.json");
  fs.writeFileSync(policyFile, JSON.stringify(POLICY_DOC, null, 2), "utf8");
  try {
    for (const [rejection, status, code] of [[401, 401, AUTH_CODES.UNAUTHORIZED], [403, 403, AUTH_CODES.FORBIDDEN]]) {
      const ctx = ctxWithConnection({ requestRejection: () => rejection });
      const policy = { enabled: true, policyFile, defaults: POLICY_DOC.defaults, capabilities: {}, sections: {} };
      const { mountServer } = await import("../../lib/server.js");
      mountServer({ ctx, gate: stubGate(), policy, logger: host.logger, config: { policyFile } });
      const route = ctx.routes.find((row) => row.path === "/api/dsh-gate/state");
      const outcome = await send(route.handler, makeRequest({ path: "/api/dsh-gate/state", headers: trustedHeaders() }));
      assert.equal(outcome.status, status);
      assert.equal(outcome.json.code, code);
      assert.equal(outcome.json.ok, false);
      assert.equal(outcome.ended, true);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

await check("八步·6 鉴权：宿主无 connection 服务 → 回退四道门而不是全量 401，状态可诊断", async () => {
  const env = setup();
  try {
    const allowed = await send(env.plane.handlerOf("/api/dsh-gate/state"), makeRequest({
      path: "/api/dsh-gate/state",
      headers: trustedHeaders(),
    }));
    assert.equal(allowed.status, 200, "回退门必须放行同源本机请求: " + allowed.body);
    const diag = await send(env.plane.handlerOf("/api/dsh-gate/diagnostics"), makeRequest({
      path: "/api/dsh-gate/diagnostics",
      headers: trustedHeaders(),
    }));
    assert.equal(diag.status, 200);
    assert.equal(diag.json.runtime.auth.fallback, true, "回退状态必须进诊断");
    assert.equal(diag.json.runtime.auth.token, "not-configured", "令牌未配置要说清楚（#07 下发后变 required）");
  } finally { cleanup(env); }
});

await check("八步·7 会话：?agent= 不存在 → 404 AGENT_NOT_FOUND + 已知会话清单（旧字段同时保留）", async () => {
  const gate = stubGate({
    listAgents: () => [{ id: "session-live", agent: { id: "session-live" } }, { id: "session-old", agent: { id: "session-old" } }],
    snapshot: (agent) => Object.assign(blankSnapshot(), { agent: agent === undefined ? null : String(agent.id || "") }),
  });
  const env = setup({ gate });
  try {
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/state"), makeRequest({
      path: "/api/dsh-gate/state?agent=session-nope",
      headers: trustedHeaders(),
    }));
    assert.equal(outcome.status, 404);
    assert.equal(outcome.json.code, "AGENT_NOT_FOUND");
    assert.equal(outcome.json.error, "agent not found", "旧面板读顶层 error（selftest 同口径）");
    assert.deepEqual(outcome.json.agents.sort(), ["session-live", "session-old"]);
    assert.deepEqual(outcome.json.details.agents.sort(), ["session-live", "session-old"]);
    assert.equal(outcome.json.details.requested, "session-nope");
  } finally { cleanup(env); }
});

await check("八步·8 处理函数：任何抛出 → 500 INTERNAL + 栈摘要，连接不挂死", async () => {
  const gate = stubGate({
    snapshot: () => { throw new Error("boom-from-gate"); },
  });
  const env = setup({ gate });
  try {
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/state"), makeRequest({
      path: "/api/dsh-gate/state",
      headers: trustedHeaders(),
    }));
    assert.equal(outcome.error, undefined, "异常不许逃到宿主");
    assert.equal(outcome.status, 500);
    assert.equal(outcome.json.code, "INTERNAL");
    assert.equal(outcome.ended, true);
    assert.equal(outcome.json.details.reason, "exception");
    // 结构化记录：诊断 errors 组必须留下 internal 桶
    const diag = await send(env.plane.handlerOf("/api/dsh-gate/diagnostics"), makeRequest({
      path: "/api/dsh-gate/diagnostics",
      headers: trustedHeaders(),
    }));
    assert.equal(diag.status, 200);
    const codes = (diag.json.errors.buckets || []).map((row) => row.code);
    assert.ok(codes.includes("internal"), "吞错账本缺 internal 桶: " + JSON.stringify(codes));
  } finally { cleanup(env); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 错误信封闭合表
// ─────────────────────────────────────────────────────────────────────────────
await check("错误信封：12 个规格码与状态码一一对应（客户端可分支）", async () => {
  assert.deepEqual([...CANONICAL_CODES].sort(), Object.keys(ERROR_STATUS).sort());
  assert.equal(CANONICAL_CODES.length, 12, "规格码表是闭合清单");
  const expected = {
    REVISION_CONFLICT: 409, POLICY_UNREADABLE: 409, CONFIRMATION_REQUIRED: 409, INVALID_TIER: 400,
    INVALID_POLICY: 400, INVALID_BODY: 400, AGENT_NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405,
    UNSUPPORTED_MEDIA_TYPE: 415, PAYLOAD_TOO_LARGE: 413, GATE_TOOL_NOT_FORWARDABLE: 400, INTERNAL: 500,
  };
  assert.deepEqual(ERROR_STATUS, expected);
  for (const code of CANONICAL_CODES) assert.equal(ERROR_CODES[code], code);
  // 业务扩展码不得占用规格码的位置
  for (const code of Object.keys(SERVICE_CODES)) assert.equal(ERROR_CODES[code], undefined, code + " 挤进了规格码表");
});

await check("错误信封：2xx 但 ok=false 视为失败（装饰器记账 contract-violation，不篡改状态码）", async () => {
  const recorded = [];
  const handler = createControlHandler(
    {
      id: "fake",
      path: "/api/dsh-gate/fake",
      methods: ["GET"],
      body: false,
      scope: "none",
      handler: async () => ({ status: 200, body: { ok: false, code: "INTERNAL", message: "我说失败" } }),
    },
    {
      authenticate: () => ({ ok: true }),
      resolveScope: () => ({ known: [] }),
      metrics: { record: () => undefined },
      ledger: { record: (code, info) => recorded.push({ code, info }) },
      logger: { info: () => undefined, warn: () => undefined },
    },
  );
  const outcome = await send(handler, makeRequest({ path: "/api/dsh-gate/fake", headers: trustedHeaders() }));
  assert.equal(outcome.status, 200, "装饰器不改写服务层给的状态码");
  assert.ok(recorded.some((row) => row.code === "contract-violation"), "2xx+ok=false 必须记账: " + JSON.stringify(recorded.map((r) => r.code)));
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. 访问日志 / 统计 / 诊断端点
// ─────────────────────────────────────────────────────────────────────────────
await check("访问统计：每条路由的 count / byStatus / 耗时进诊断 runtime.control", async () => {
  const env = setup();
  try {
    const state = env.plane.handlerOf("/api/dsh-gate/state");
    await send(state, makeRequest({ path: "/api/dsh-gate/state", headers: trustedHeaders() }));
    await send(state, makeRequest({ path: "/api/dsh-gate/state", headers: trustedHeaders({ origin: "null" }) }));
    const diag = await send(env.plane.handlerOf("/api/dsh-gate/diagnostics"), makeRequest({
      path: "/api/dsh-gate/diagnostics",
      headers: trustedHeaders(),
    }));
    assert.equal(diag.status, 200);
    const control = diag.json.runtime.control;
    const row = (control.routes || []).find((item) => item.id === "state");
    assert.ok(row, "state 路由必须有统计行: " + JSON.stringify(control));
    assert.ok(row.count >= 2, "count=" + row.count);
    assert.ok(row.byStatus["200"] >= 1 && row.byStatus["403"] >= 1, "byStatus=" + JSON.stringify(row.byStatus));
    assert.ok(typeof row.avgMs === "number" && typeof control.totals.requests === "number");
  } finally { cleanup(env); }
});

await check("诊断端点：固定四组键、只读、支持 ?agent=，且不写盘", async () => {
  const gate = stubGate({
    listAgents: () => [{ id: "session-live", agent: { id: "session-live" } }],
    snapshot: (agent) => Object.assign(blankSnapshot(), { agent: agent === undefined ? null : String(agent.id || "") }),
  });
  const env = setup({ gate });
  try {
    const before = fs.statSync(env.policyFile).mtimeMs;
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/diagnostics"), makeRequest({
      path: "/api/dsh-gate/diagnostics?agent=session-live",
      headers: trustedHeaders(),
    }));
    assert.equal(outcome.status, 200);
    assert.deepEqual(Object.keys(outcome.json).sort(), ["agent", "decisions", "errors", "generatedAt", "ok", "read", "runtime"]);
    assert.equal(outcome.json.agent, "session-live");
    for (const group of ["read", "decisions", "runtime", "errors"]) {
      assert.equal(typeof outcome.json[group], "object", group + " 必须是对象");
      assert.notEqual(outcome.json[group], null, group + " 不能是 null");
    }
    assert.equal(outcome.json.read.file, env.policyFile);
    assert.ok(Number.isFinite(outcome.json.read.layers.capabilities), "read.layers 必须给各层贡献");
    assert.ok(Array.isArray(outcome.json.errors.buckets), "errors 组必须是账本快照");
    assert.ok(
      outcome.json.errors.buckets.map((row) => row.code).includes("auth-fallback"),
      "鉴权回退必须出现在 errors 组（F76/F79）: " + JSON.stringify(outcome.json.errors.buckets.map((row) => row.code)),
    );
    assert.equal(fs.statSync(env.policyFile).mtimeMs, before, "诊断端点不许写文件");
  } finally { cleanup(env); }
});

await check("诊断端点：?agent= 不存在 → 404 AGENT_NOT_FOUND（作用域与列表一致）", async () => {
  const env = setup();
  try {
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/diagnostics"), makeRequest({
      path: "/api/dsh-gate/diagnostics?agent=ghost",
      headers: trustedHeaders(),
    }));
    assert.equal(outcome.status, 404);
    assert.equal(outcome.json.code, "AGENT_NOT_FOUND");
  } finally { cleanup(env); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 技能原子批量（与单动作同一条归一/落盘路径）
// ─────────────────────────────────────────────────────────────────────────────
await check("P1-10：tier: null 不再被 Number() 强转成 0（400 INVALID_TIER，文件不动）", async () => {
  const env = setup();
  try {
    const before = fs.readFileSync(env.policyFile, "utf8");
    for (const tier of [null, "", true, [], 3, 1.5]) {
      const outcome = await send(env.plane.handlerOf("/api/dsh-gate/skills"), makeRequest({
        method: "POST",
        path: "/api/dsh-gate/skills",
        headers: trustedHeaders(),
        body: JSON.stringify({ action: "tier", name: "alpha-skill", tier }),
      }));
      assert.equal(outcome.status, 400, "tier=" + JSON.stringify(tier) + " body=" + outcome.body);
      assert.equal(outcome.json.code, "INVALID_TIER", "tier=" + JSON.stringify(tier));
    }
    assert.equal(fs.readFileSync(env.policyFile, "utf8"), before, "非法层值一个字节都不许落盘");
    // 唯一归一化函数本身也必须是严格的
    assert.equal(parseTier(null), undefined);
    assert.equal(parseTier(""), undefined);
    assert.equal(parseTier("0"), 0);
    assert.equal(parseTier(2), 2);
  } finally { cleanup(env); }
});

await check("batch：一次归一、一次落盘、一次预扫描；逐条 applied + revision", async () => {
  const env = setup();
  try {
    const before = JSON.parse(fs.readFileSync(env.policyFile, "utf8"));
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/skills"), makeRequest({
      method: "POST",
      path: "/api/dsh-gate/skills",
      headers: trustedHeaders(),
      body: JSON.stringify({
        action: "batch",
        operations: [
          { action: "tier", name: "alpha-skill", tier: 0 },
          { action: "tier", name: "beta-skill", tier: 1 },
          { action: "takeover", value: false },
        ],
      }),
    }));
    assert.equal(outcome.status, 200, "body=" + outcome.body);
    assert.equal(outcome.json.ok, true);
    assert.equal(outcome.json.changed, true);
    assert.ok(Array.isArray(outcome.json.applied) && outcome.json.applied.length === 3, "applied 必须逐条: " + JSON.stringify(outcome.json.applied));
    assert.deepEqual(outcome.json.applied.map((row) => row.index), [0, 1, 2]);
    assert.deepEqual(outcome.json.applied.map((row) => row.action), ["tier", "tier", "takeover"]);
    // revision 是内容指纹（"<n>-<hash>" 字符串），不是数字：只断言"变了且有值"。
    assert.equal(typeof outcome.json.revision, "string", "回执必须带 revision");
    assert.ok(outcome.json.revision.length > 0);
    assert.notEqual(outcome.json.revision, before.revision, "revision 必须前进");
    const saved = JSON.parse(fs.readFileSync(env.policyFile, "utf8"));
    assert.equal(saved.capabilities["skill:alpha-skill"].tier, 0);
    assert.equal(saved.capabilities["skill:beta-skill"].tier, 1);
    assert.equal(saved.skills.takeover, false);
  } finally { cleanup(env); }
});

await check("batch：单条非法 → 整批拒绝、失败位置明确、零部分落盘", async () => {
  const env = setup();
  try {
    const before = fs.readFileSync(env.policyFile, "utf8");
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/skills"), makeRequest({
      method: "POST",
      path: "/api/dsh-gate/skills",
      headers: trustedHeaders(),
      body: JSON.stringify({
        action: "batch",
        operations: [
          { action: "tier", name: "good-skill", tier: 0 },
          { action: "tier", name: "bad-skill", tier: null },
          { action: "takeover", value: true },
        ],
      }),
    }));
    assert.equal(outcome.status, 400, "body=" + outcome.body);
    assert.equal(outcome.json.code, "INVALID_TIER");
    assert.equal(outcome.json.failedIndex, 1);
    assert.deepEqual(outcome.json.applied, [], "整批拒绝时 applied 必须为空（没有部分落盘）");
    assert.equal(outcome.json.details.failedIndex, 1);
    assert.equal(fs.readFileSync(env.policyFile, "utf8"), before, "整批拒绝不许改文件");
  } finally { cleanup(env); }
});

await check("写回执：changed=false 表示未写入（同样的 batch 第二次跑不变更文件）", async () => {
  const env = setup();
  try {
    const payload = JSON.stringify({ action: "batch", operations: [{ action: "tier", name: "gamma-skill", tier: 0 }] });
    const first = await send(env.plane.handlerOf("/api/dsh-gate/skills"), makeRequest({
      method: "POST", path: "/api/dsh-gate/skills", headers: trustedHeaders(), body: payload,
    }));
    assert.equal(first.status, 200, "body=" + first.body);
    assert.equal(first.json.changed, true);
    const text1 = fs.readFileSync(env.policyFile, "utf8");
    const second = await send(env.plane.handlerOf("/api/dsh-gate/skills"), makeRequest({
      method: "POST", path: "/api/dsh-gate/skills", headers: trustedHeaders(), body: payload,
    }));
    assert.equal(second.status, 200, "body=" + second.body);
    assert.equal(second.json.changed, false, "内容相同时必须 changed=false");
    assert.equal(fs.readFileSync(env.policyFile, "utf8"), text1, "changed=false 不许改文件");
  } finally { cleanup(env); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5b. /policy 写入前的 skills.imports 路径闸（与 /skills 的路径安全闸对齐）
// ─────────────────────────────────────────────────────────────────────────────
await check("POST /policy：新增的 skills.imports 含 .. → 400 INVALID_BODY，文件一个字节不动", async () => {
  const env = setup();
  try {
    const before = fs.readFileSync(env.policyFile, "utf8");
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
      method: "POST",
      path: "/api/dsh-gate/policy",
      headers: trustedHeaders(),
      body: JSON.stringify({ skills: { imports: ["../outside-skills"] } }),
    }));
    assert.equal(outcome.status, 400, "body=" + outcome.body);
    assert.equal(outcome.json.code, "INVALID_BODY");
    assert.equal(outcome.json.ok, false);
    const hit = (outcome.json.errors || []).find((row) => row.code === "IMPORT_PATH_UNSAFE");
    assert.ok(hit, "必须给 IMPORT_PATH_UNSAFE 原因: " + JSON.stringify(outcome.json.errors));
    assert.match(outcome.json.message, /skills\.imports/);
    assert.equal(fs.readFileSync(env.policyFile, "utf8"), before, "非法导入路径不许落盘");
  } finally { cleanup(env); }
});

await check("POST /policy：设备名 / UNC 路径 → 400（与 skills-service 的 unsafe 判定同口径）", async () => {
  const env = setup();
  try {
    const before = fs.readFileSync(env.policyFile, "utf8");
    for (const badPath of ["CON", "\\\\server\\\\share\\\\skills"]) {
      const outcome = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
        method: "POST",
        path: "/api/dsh-gate/policy",
        headers: trustedHeaders(),
        body: JSON.stringify({ skills: { imports: [badPath] } }),
      }));
      assert.equal(outcome.status, 400, "path=" + badPath + " body=" + outcome.body);
      assert.equal(outcome.json.code, "INVALID_BODY", "path=" + badPath);
      assert.ok((outcome.json.errors || []).some((row) => row.code === "IMPORT_PATH_UNSAFE"), "path=" + badPath + " errors=" + JSON.stringify(outcome.json.errors));
    }
    assert.equal(fs.readFileSync(env.policyFile, "utf8"), before, "非法导入路径不许落盘");
  } finally { cleanup(env); }
});

await check("POST /policy：重复导入路径（分隔符/尾斜杠等价）→ 400，不静默合并", async () => {
  const env = setup();
  try {
    const before = fs.readFileSync(env.policyFile, "utf8");
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
      method: "POST",
      path: "/api/dsh-gate/policy",
      headers: trustedHeaders(),
      body: JSON.stringify({ skills: { imports: ["skills/dup", "skills//dup/"] } }),
    }));
    assert.equal(outcome.status, 400, "body=" + outcome.body);
    assert.equal(outcome.json.code, "INVALID_BODY");
    assert.ok((outcome.json.errors || []).some((row) => row.code === "IMPORT_PATH_DUPLICATE"), "errors=" + JSON.stringify(outcome.json.errors));
    assert.equal(fs.readFileSync(env.policyFile, "utf8"), before, "重复路径不许落盘");
  } finally { cleanup(env); }
});

await check("POST /policy：历史一条 + 本次再塞等价重复（尾斜杠 / ./ 前缀）→ 400，不按历史免检放行", async () => {
  // 回归（0.7.2 复核 must-fix #1）：历史免检原先按「等价键存在」判定，
  // 同一条历史路径提交两次时两次都被当成历史命中 ⇒ 待检集合为空 ⇒ 重复校验被整体短路 ⇒ 落盘。
  const legacyDoc = Object.assign({}, POLICY_DOC, {
    skills: { takeover: true, activationRelay: true, activationPromote: true, off: [], imports: [{ path: "skills/a" }] },
  });
  for (const imports of [["skills/a", "skills/a/"], ["skills/a", "./skills/a"]]) {
    const env = setup({ policyDoc: legacyDoc });
    try {
      const before = fs.readFileSync(env.policyFile, "utf8");
      const outcome = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
        method: "POST",
        path: "/api/dsh-gate/policy",
        headers: trustedHeaders(),
        body: JSON.stringify({ skills: { imports } }),
      }));
      assert.equal(outcome.status, 400, "imports=" + JSON.stringify(imports) + " body=" + outcome.body);
      assert.equal(outcome.json.code, "INVALID_BODY", "imports=" + JSON.stringify(imports));
      const hit = (outcome.json.errors || []).find((row) => row.code === "IMPORT_PATH_DUPLICATE");
      assert.ok(hit, "imports=" + JSON.stringify(imports) + " errors=" + JSON.stringify(outcome.json.errors));
      assert.equal(hit.index, 1, "重复项定位到第二条（索引按整份 imports 算）");
      assert.equal(fs.readFileSync(env.policyFile, "utf8"), before, "重复路径不许落盘");
    } finally { cleanup(env); }
  }
});

await check("POST /policy：历史一条 + 新增一条不同路径 → 200（计数免检不误伤正常追加）", async () => {
  const legacyDoc = Object.assign({}, POLICY_DOC, {
    skills: { takeover: true, activationRelay: true, activationPromote: true, off: [], imports: [{ path: "skills/a" }] },
  });
  const env = setup({ policyDoc: legacyDoc });
  try {
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
      method: "POST",
      path: "/api/dsh-gate/policy",
      headers: trustedHeaders(),
      body: JSON.stringify({ skills: { imports: ["skills/a", "skills/b"] } }),
    }));
    assert.equal(outcome.status, 200, "body=" + outcome.body);
    assert.equal(outcome.json.ok, true);
    const saved = JSON.parse(fs.readFileSync(env.policyFile, "utf8"));
    assert.deepEqual(saved.skills.imports.map((row) => row.path), ["skills/a", "skills/b"], "历史条目与新增条目都按原样落盘");
  } finally { cleanup(env); }
});

await check("POST /policy：合法新增导入路径落盘（不要求目录存在），且 skills 默认值补齐", async () => {
  const env = setup();
  try {
    const outcome = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
      method: "POST",
      path: "/api/dsh-gate/policy",
      headers: trustedHeaders(),
      body: JSON.stringify({ skills: { imports: [{ id: "shared", path: "./skills/shared" }] } }),
    }));
    assert.equal(outcome.status, 200, "body=" + outcome.body);
    assert.equal(outcome.json.ok, true);
    const saved = JSON.parse(fs.readFileSync(env.policyFile, "utf8"));
    assert.deepEqual(saved.skills.imports, [{ id: "shared", path: "./skills/shared" }], "路径原样落盘（不解析成绝对路径）");
    assert.equal(saved.skills.activationRelay, true, "未提交的 skills 开关按默认值补齐");
    assert.equal(saved.skills.activationPromote, true);
  } finally { cleanup(env); }
});

await check("POST /policy：历史配置里已有的 .. 路径原样回传不拦（只拦新增/变更）", async () => {
  const legacyDoc = Object.assign({}, POLICY_DOC, {
    skills: { takeover: true, activationRelay: true, activationPromote: true, off: [], imports: [{ path: "../legacy-skills" }] },
  });
  const env = setup({ policyDoc: legacyDoc });
  try {
    // 1) 原样回传历史路径：放行（否则老文件一旦保存就锁死）。
    const kept = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
      method: "POST",
      path: "/api/dsh-gate/policy",
      headers: trustedHeaders(),
      body: JSON.stringify({ skills: { imports: [{ path: "../legacy-skills" }] } }),
    }));
    assert.equal(kept.status, 200, "body=" + kept.body);
    assert.deepEqual(JSON.parse(fs.readFileSync(env.policyFile, "utf8")).skills.imports, [{ path: "../legacy-skills" }]);

    // 2) 同一份列表里混入一条新的越界路径：整次写入拒绝，历史条目保持原样。
    const before = fs.readFileSync(env.policyFile, "utf8");
    const rejected = await send(env.plane.handlerOf("/api/dsh-gate/policy"), makeRequest({
      method: "POST",
      path: "/api/dsh-gate/policy",
      headers: trustedHeaders(),
      body: JSON.stringify({ skills: { imports: [{ path: "../legacy-skills" }, { path: "../new-escape" }] } }),
    }));
    assert.equal(rejected.status, 400, "body=" + rejected.body);
    assert.equal(rejected.json.code, "INVALID_BODY");
    assert.ok((rejected.json.errors || []).some((row) => row.code === "IMPORT_PATH_UNSAFE"), "errors=" + JSON.stringify(rejected.json.errors));
    assert.equal(fs.readFileSync(env.policyFile, "utf8"), before, "拒绝时文件不许变");
  } finally { cleanup(env); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. 回放表与闭合表一致（数据表不能出现"表里写了、实现没有"的码）
// ─────────────────────────────────────────────────────────────────────────────
await check("回放表：每个 after.code 都在闭合 code 表里，且状态码与 ERROR_STATUS 一致", async () => {
  assert.ok(REPLAY_CASES.length >= 14, "回放表条目过少：" + REPLAY_CASES.length);
  for (const row of REPLAY_CASES) {
    assert.ok(typeof row.probe === "string" && row.probe.length > 0, row.id + " 缺 probe 描述");
    if (row.after.code) {
      assert.ok(Object.prototype.hasOwnProperty.call(CODE_STATUS, row.after.code), row.id + " 的 after.code 不在闭合表：" + row.after.code);
      if (Object.prototype.hasOwnProperty.call(ERROR_STATUS, row.after.code)) {
        assert.equal(row.after.status, ERROR_STATUS[row.after.code], row.id + " 的 after.status 与 ERROR_STATUS 不一致");
      }
    }
  }
});

await check("回放表：P1-1 与 P1-10 各有一条（缺陷登记 ↔ 回放表必须对得上）", async () => {
  for (const id of ["P1-1", "P1-10"]) {
    const rows = REPLAY_CASES.filter((row) => row.defect === id);
    assert.equal(rows.length, 1, id + " 在回放表里应有且仅有一条，实际 " + rows.length);
    assert.ok(defects.some((row) => row.id === id), id + " 必须仍在 defect-registry 里（清零由收口人删）");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. 回放位登记
// ─────────────────────────────────────────────────────────────────────────────
await check("P1-1 / P1-10 回放位登记在案（均归 #06 / S3）", async () => {
  const p11 = defects.find((row) => row.id === "P1-1");
  const p110 = defects.find((row) => row.id === "P1-10");
  assert.equal(p11.seam, "S3");
  assert.equal(p11.ticket, "#06");
  assert.match(p11.symptom, /结构化错误信封/);
  assert.equal(p110.seam, "S3");
  assert.equal(p110.ticket, "#06");
  assert.match(p110.symptom, /tier/i);
});

const failed = results.filter((entry) => !entry.ok);
for (const entry of results) {
  console.log((entry.ok ? "  ok    " : "  FAIL  ") + entry.label + (entry.ok ? "" : "  →  " + entry.error));
}
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exitCode = failed.length === 0 ? 0 : 1;
