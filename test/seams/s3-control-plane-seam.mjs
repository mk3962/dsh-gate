/**
 * S3 控制面接缝（票 01 · 升级既有真挂载 + 假 webServer）
 *
 * 真：lib/server.js 的 mountServer 原样挂载，路由表、鉴权、请求体解析全走真实实现。
 * 假：宿主 webServer 换成可观测的假对象；req/res 换成可注入故障的夹具。
 *
 * 可注入的故障与形态：
 *   - aborted      客户端中途断连（迭代器抛 ECONNRESET）
 *   - slow         慢速流（分块之间延迟）
 *   - oversized    body 超过 MAX_BODY_BYTES
 *   - headers      Host / Origin / Sec-Fetch-Site / Content-Type / cookie 任意组合
 *   - socket       remoteAddress（回环 / 非回环）
 * 观测：状态码、响应头、响应信封、是否真的写过响应、handler 是否抛错。
 */
import { Readable } from "node:stream";
import { mountServer } from "../../lib/server.js";

export const MAX_BODY_BYTES = 512 * 1024;

/** 假 webServer：与宿主同形（register(route) → disposer）。 */
export function createFakeWebServer() {
  const routes = [];
  const disposers = [];
  let disposed = 0;
  const server = {
    routes,
    register(route) {
      if (route === null || typeof route !== "object") throw new Error("register() requires a route object");
      routes.push(route);
      const dispose = () => { disposed += 1; route.disposed = true; };
      disposers.push(dispose);
      return dispose;
    },
    disposeAll() { while (disposers.length > 0) disposers.pop()(); },
    mountedPaths() { return routes.map((route) => route.path); },
    find(pathname) { return routes.find((route) => route.path === pathname); },
    get disposedCount() { return disposed; },
  };
  return server;
}

/**
 * 假请求：Node IncomingMessage 的最小投影。
 * @param {{method?: string, path?: string, headers?: object, chunks?: (string|Buffer)[], socketAddress?: string,
 *          streamMode?: "normal"|"slow"|"aborted", delayMs?: number, body?: string|Buffer|null}} [spec]
 */
export function makeRequest(spec) {
  const options = spec || {};
  const headers = {};
  for (const [key, value] of Object.entries(options.headers || {})) headers[key.toLowerCase()] = value;
  if (headers.host === undefined) headers.host = "127.0.0.1:49438";
  let payloads;
  if (Array.isArray(options.chunks)) payloads = options.chunks.map((chunk) => Buffer.from(String(chunk)));
  else if (options.body !== undefined && options.body !== null) payloads = [Buffer.from(String(options.body))];
  else payloads = [];

  const chunksFor = () => {
    if (options.streamMode === "oversized") {
      const block = Buffer.alloc(64 * 1024, 0x61);
      return Array.from({ length: Math.ceil((MAX_BODY_BYTES + 1024) / block.length) }, () => block);
    }
    return payloads;
  };

  const request = {
    method: (options.method || "GET").toUpperCase(),
    url: options.path || "/",
    headers,
    socket: { remoteAddress: options.socketAddress || "127.0.0.1" },
    complete: options.streamMode !== "aborted",
  };
  request[Symbol.asyncIterator] = async function* iterate() {
    if (options.streamMode === "aborted") {
      yield Buffer.from("{\"partial\":");
      const error = new Error("aborted");
      error.code = "ECONNRESET";
      throw error;
    }
    for (const chunk of chunksFor()) {
      if (options.streamMode === "slow" && options.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      yield chunk;
    }
  };
  return request;
}

/** 假响应：记录状态码 / 响应头 / 正文 / 是否 end 过。 */
export function makeResponse() {
  const response = {
    statusCode: undefined,
    headers: {},
    chunks: [],
    ended: false,
    writeHead(status, headers) {
      response.statusCode = status;
      Object.assign(response.headers, headers || {});
      return response;
    },
    setHeader(name, value) { response.headers[String(name).toLowerCase()] = value; },
    end(payload) {
      response.ended = true;
      if (payload !== undefined) response.chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)));
      return response;
    },
    get body() { return Buffer.concat(response.chunks).toString("utf8"); },
    get json() {
      try { return JSON.parse(response.body); } catch { return undefined; }
    },
  };
  return response;
}

/** 跑一次 handler，把「有没有回应 / 有没有抛错」都收成可断言的形状。 */
export async function send(handler, request) {
  const response = makeResponse();
  const startedAt = Date.now();
  let error;
  try {
    await handler(request, response);
  } catch (thrown) {
    error = thrown;
  }
  return {
    request,
    response,
    error,
    status: response.statusCode,
    body: response.body,
    json: response.json,
    ended: response.ended,
    durationMs: Date.now() - startedAt,
  };
}

/** 挂载控制面：真的走 mountServer + ctx.inject，只是 webServer 是假的。 */
export function mountControlPlane(options) {
  const opts = options || {};
  const ctx = opts.ctx;
  const server = opts.server || createFakeWebServer();
  ctx.webServer = server;
  const mountDisposer = mountServer({
    ctx,
    gate: opts.gate,
    policy: opts.policy,
    logger: opts.logger,
    config: opts.config,
  });
  return {
    server,
    routes: server.routes.slice(),
    paths: server.mountedPaths(),
    handlerOf(pathname) {
      const route = server.find(pathname);
      if (route === undefined) throw new Error("route not mounted: " + pathname);
      return route.handler;
    },
    dispose() {
      try { mountDisposer(); } catch { /* 忽略 */ }
      server.disposeAll();
    },
  };
}

/** 受信请求头（回环 + 同源），供正例使用。 */
export function trustedHeaders(extra) {
  return Object.assign({
    host: "127.0.0.1:49438",
    origin: "http://127.0.0.1:49438",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  }, extra || {});
}

/**
 * 路由表遍历：每条路由都必须自己鉴权。
 * 任何新增路由只要漏写鉴权，这里就会红（返回非 401/403）。
 */
export async function sweepAuthorization(plane, spec) {
  const options = spec || {};
  const probes = [
    { label: "跨站 origin", headers: trustedHeaders({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }) },
    { label: "非回环来源", socketAddress: "10.0.0.8" },
    { label: "DNS rebinding host", headers: trustedHeaders({ host: "evil.example", origin: "http://evil.example" }) },
  ];
  const results = [];
  const routes = plane.server === undefined ? plane.routes : plane.server.routes;
  for (const route of routes) {
    const handler = route.handler;
    for (const probe of probes) {
      const request = makeRequest({
        method: options.method || "GET",
        path: route.path,
        headers: probe.headers || trustedHeaders(),
        socketAddress: probe.socketAddress,
        body: options.body,
      });
      const outcome = await send(handler, request);
      results.push({ path: route.path, probe: probe.label, status: outcome.status, ended: outcome.ended, error: outcome.error === undefined ? undefined : String(outcome.error.message) });
    }
  }
  return results;
}