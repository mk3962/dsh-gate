/**
 * S4 · 前端数据无头垫片（#01 / gate:D4）
 *
 * 0.5.7 的前端是单个 client/index.js：window.__ModuleLoader__.load({ id, factory })，
 * factory(require) 里 require 只允许 10 个 PLATFORM_MODULES。它没有构建、没有外部依赖，
 * 所以测试也不需要 jsdom：用 Node vm 提供最小 window + require 白名单 + 迷你 React，
 * 就能在 Node 里跑真 bundle，拿到 exports / 槽位注册 / 渲染树 / 默认策略模板。
 *
 * 本垫片是 #07 的落点：__DSH_GATE_TEST_HOOK__ 出现前，L1–L4 纯数据命名空间只能由
 * 静态抽取 + 迷你 React 观测；出现后同一套 API 改从 hook 取，断言不变（source 翻转）。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { emptyPolicyTemplate } from "../../lib/policy.js";
import { normalizeV3Policy } from "../../lib/migrate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../..");
export const CLIENT_PATH = path.join(REPO_ROOT, "client/index.js");

/** 宿主注入给前端 bundle 的模块白名单（I-6 / ADR A-5：不许 require 第四个）。 */
export const PLATFORM_MODULES = Object.freeze([
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-web-react",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-attachment",
  "@deepseek-ai/dsh-client-schema-form",
]);

/** 默认生产态导出对象的键（严格相等，反向契约）。 */
export const PRODUCTION_EXPORT_KEYS = Object.freeze(["apply", "inject"]);

export class FrontendHarnessError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = "FrontendHarnessError";
    this.code = code;
    this.extra = extra;
  }
}

const cloneJson = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/* ── 迷你 React：createElement + 钩子 + 渲染记录 ─────────────────────────── */

export function createReact() {
  const react = { Fragment: Symbol.for("react.fragment") };
  let runtime = null;

  const currentPath = (name) => {
    if (!runtime) throw new FrontendHarnessError("HOOKS_OUTSIDE_RENDER", name + "() called outside render");
    const index = runtime.cursors[name] === undefined ? 0 : runtime.cursors[name];
    runtime.cursors[name] = index + 1;
    return runtime.path + "#" + name + index;
  };
  const slot = (name, init) => {
    const key = currentPath(name);
    if (!runtime.slots.has(key)) runtime.slots.set(key, init());
    return runtime.slots.get(key);
  };

  react.createElement = (type, props, ...children) => {
    const merged = Object.assign({}, props || {});
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { __element: true, type, props: merged, key: merged.key === undefined ? null : merged.key };
  };
  react.useState = (initial) => {
    const state = slot("useState", () => {
      // setter 会在渲染之后（异步回调里）执行，所以 owner 必须在渲染期就固定下来。
      const owner = runtime.state;
      const entry = { value: typeof initial === "function" ? initial() : initial };
      entry.set = (next) => {
        const value = typeof next === "function" ? next(entry.value) : next;
        if (Object.is(value, entry.value)) return;
        entry.value = value;
        owner.dirty = true;
      };
      return entry;
    });
    return [state.value, state.set];
  };
  react.useReducer = (reducer, initial) => {
    const state = slot("useReducer", () => {
      const owner = runtime.state;
      const entry = { value: typeof initial === "function" ? initial(initial) : initial };
      entry.dispatch = (action) => {
        const value = reducer(entry.value, action);
        if (Object.is(value, entry.value)) return;
        entry.value = value;
        owner.dirty = true;
      };
      return entry;
    });
    return [state.value, state.dispatch];
  };
  react.useCallback = (fn) => slot("useCallback", () => fn);
  react.useMemo = (fn) => slot("useMemo", () => fn());
  react.useRef = (initial) => slot("useRef", () => ({ current: initial }));
  react.useContext = () => undefined;
  react.useId = () => slot("useId", () => "id-" + runtime.path.replace(/[^a-z0-9]+/gi, "-"));
  react.memo = (component) => component;
  react.forwardRef = (render) => render;
  react.useEffect = (fn, deps) => {
    const key = currentPath("useEffect");
    runtime.effects.push({ key, fn, deps: deps === undefined ? undefined : Array.from(deps) });
  };

  const depsChanged = (previous, next) => {
    if (next === undefined) return true;
    if (!previous) return true;
    if (previous.length !== next.length) return true;
    return previous.some((value, index) => !Object.is(value, next[index]));
  };

  const isElement = (value) => Boolean(value && value.__element === true);

  const normalizePropValue = (value) => {
    if (typeof value === "function") return "[fn:" + (value.name || "anonymous") + "]";
    if (value === null || typeof value !== "object") return value;
    if (isElement(value)) return { __element: true, type: typeName(value) };
    // Array.from：vm 里造出来的数组 map 会继承 vm realm 的 Array，deepStrictEqual 会因原型不同判不等。
    if (Array.isArray(value)) return Array.from(value, normalizePropValue);
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = normalizePropValue(value[key]);
    return out;
  };

  const typeName = (element) => (typeof element.type === "string" ? element.type : (element.type && element.type.name) || "anonymous");

  /**
   * 挂载一棵前端元素树：函数组件递归求值，类 DOM 节点只做结构化记录（不碰 DOM）。
   * 记录 = { type, key, props, children }，可直接深比较判断确定性。
   */
  const createRenderer = () => {
    const slots = new Map();
    const effectState = new Map();
    const state = { dirty: false, mounted: false, tree: null, effects: [], renders: 0, paths: 0, root: null, text: "" };

    const renderElement = (element, componentPath) => {
      if (element === null || element === undefined || element === false || element === true) return null;
      if (typeof element === "string" || typeof element === "number") return { type: "#text", text: String(element), key: null, props: {}, children: [] };
      if (Array.isArray(element)) {
        return { type: "#array", key: null, props: {}, children: element.map((item, index) => renderElement(item, componentPath + "/" + index)).filter(Boolean) };
      }
      if (!isElement(element)) {
        return { type: "#opaque", key: null, props: { value: normalizePropValue(element) }, children: [] };
      }
      const name = typeName(element);
      const key = element.key === null || element.key === undefined ? componentPath : String(element.key);
      if (typeof element.type === "string") {
        const children = [];
        const raw = element.props.children;
        const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
        list.forEach((child, index) => {
          const rendered = renderElement(child, componentPath + "/" + index);
          if (rendered) children.push(rendered);
        });
        return { type: element.type, key, props: normalizeProps(element.props), children };
      }
      // 函数组件：推进路径 + 光标，跑一遍 body。
      const previous = runtime;
      runtime = { path: componentPath + "<" + name + ">", cursors: {}, slots, state, effects: state.effects };
      state.paths += 1;
      let output;
      try {
        output = element.type(element.props);
      } finally {
        runtime = previous;
      }
      return renderElement(output, componentPath + "/" + name + "/out");
    };

    const normalizeProps = (props) => {
      const out = {};
      for (const key of Object.keys(props || {}).sort()) {
        if (key === "children") continue;
        out[key] = normalizePropValue(props[key]);
      }
      return out;
    };

    const joinText = (node) => {
      if (!node) return "";
      if (node.type === "#text") return node.text;
      return (node.children || []).map(joinText).join("");
    };

    const runEffects = () => {
      const pending = state.effects;
      state.effects = [];
      for (const effect of pending) {
        const previous = effectState.get(effect.key);
        if (!depsChanged(previous && previous.deps, effect.deps)) continue;
        if (previous && typeof previous.cleanup === "function") previous.cleanup();
        const cleanup = effect.fn();
        effectState.set(effect.key, { deps: effect.deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      }
    };

    const render = (element) => {
      state.root = element;
      state.effects = [];
      const tree = renderElement(element, "root");
      state.tree = tree;
      state.text = joinText(tree);
      state.renders += 1;
      return tree;
    };

    const mount = (element) => {
      state.mounted = true;
      const tree = render(element);
      return {
        get tree() { return state.tree; },
        get text() { return state.text; },
        get renders() { return state.renders; },
        get paths() { return state.paths; },
        rerender: () => { state.dirty = false; return { tree: render(state.root), text: state.text }; },
        /** 反复跑 effect / 重渲染，直到没有新的 setState（或超时）。 */
        settle: async (options) => {
          // 连续 3 个宏任务都没有新的 setState / effect 才算稳定：reload 是 async 的，
          // 只等一个 tick 会把「还差一次渲染」的中间态当成稳定态（曾导致两次挂载结果不等）。
          const maxRounds = (options && options.maxRounds) || 60;
          const quietTarget = (options && options.quietTurns) || 3;
          let quiet = 0;
          for (let round = 0; round < maxRounds; round += 1) {
            runEffects();
            if (state.dirty) { state.dirty = false; render(state.root); quiet = 0; continue; }
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (!state.dirty && state.effects.length === 0) {
              quiet += 1;
              if (quiet >= quietTarget) return { rounds: round + 1, quiet: quiet, tree: state.tree };
              continue;
            }
            quiet = 0;
          }
          throw new FrontendHarnessError("SETTLE_TIMEOUT", "组件在 " + maxRounds + " 轮内没有稳定（疑似无限 setState）");
        },
        unmount: () => {
          state.mounted = false;
          for (const entry of effectState.values()) if (typeof entry.cleanup === "function") entry.cleanup();
          effectState.clear();
        },
      };
    };

    return { mount, render, get tree() { return state.tree; }, get renders() { return state.renders; } };
  };

  return { react, createRenderer };
}

/* ── vm 沙箱 + 模块白名单 ────────────────────────────────────────────── */

const makeReactModule = (react) => react;

/**
 * 建一个只含 window + require 白名单的沙箱。默认没有 document（生产 bundle 必须能在
 * 无 DOM 环境加载：ensureStyle 有 typeof document 守卫）。
 */
export function createSandbox(options = {}) {
  const loads = [];
  const required = [];
  const unknown = [];
  const react = options.react || createReact().react;
  const stubs = new Map(PLATFORM_MODULES.map((name) => [name, name === "react" ? makeReactModule(react) : { __platformModule: name }]));
  if (options.modules) for (const [name, value] of Object.entries(options.modules)) stubs.set(name, value);

  const windowObject = { __ModuleLoader__: { load(spec) { loads.push(spec); } } };
  if (options.hook) windowObject.__DSH_GATE_TEST_HOOK__ = options.hookValue === undefined ? {} : options.hookValue;

  const requireFn = (name) => {
    required.push(name);
    if (!PLATFORM_MODULES.includes(name)) {
      unknown.push(name);
      throw new FrontendHarnessError("MODULE_NOT_ALLOWED", "require(\"" + name + "\") 不在 10 个 PLATFORM_MODULES 白名单内（I-6 / ADR A-5）", { name });
    }
    return stubs.get(name);
  };

  const defaultFetch = async () => ({ ok: false, status: 0, text: async () => "", json: async () => null });
  const context = vm.createContext({
    window: windowObject,
    require: requireFn,
    fetch: options.fetch || defaultFetch,
    TextEncoder,
    URL,
    URLSearchParams,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    Map,
    Set,
    Promise,
    Symbol,
    console: options.console || { log() {}, warn() {}, error() {}, info() {} },
    setTimeout,
    clearTimeout,
    queueMicrotask,
  });
  return { context, window: windowObject, loads, required, unknown, require: requireFn, react };
}

/**
 * 在沙箱里执行真 client/index.js，返回被捕获的 load() 规格与 exports。
 * source 可覆盖（mutation 用）：同一套契约对改坏的副本必须判红。
 */
export function loadClient(options = {}) {
  const source = options.source === undefined ? fs.readFileSync(CLIENT_PATH, "utf8") : options.source;
  const sandbox = options.sandbox || createSandbox(options);
  vm.runInContext(source, sandbox.context, { filename: options.filename || CLIENT_PATH, displayErrors: true });
  if (sandbox.loads.length !== 1) {
    throw new FrontendHarnessError("LOADER_CALLS", "client 必须恰好调用一次 window.__ModuleLoader__.load()，实际 " + sandbox.loads.length + " 次");
  }
  const spec = sandbox.loads[0];
  if (!spec || typeof spec.factory !== "function") {
    throw new FrontendHarnessError("LOADER_SHAPE", "load() 规格必须是 { id, factory(require) }");
  }
  const exported = spec.factory(sandbox.require);
  return {
    id: spec.id,
    factory: spec.factory,
    exports: exported,
    required: sandbox.required.slice(),
    loads: sandbox.loads.slice(),
    sandbox,
    window: sandbox.window,
    source,
    hook: readHook(sandbox.window),
  };
}

/** 生产态反向契约：导出键严格 ['apply','inject']，require 全部在白名单内。 */
export function inspectProductionSurface(loaded) {
  const keys = Object.keys(loaded.exports || {}).sort();
  const problems = [];
  if (JSON.stringify(keys) !== JSON.stringify(PRODUCTION_EXPORT_KEYS)) {
    problems.push({ code: "EXPORT_KEYS", expected: PRODUCTION_EXPORT_KEYS, actual: keys });
  }
  if (typeof loaded.exports.inject !== "object" || !Array.isArray(loaded.exports.inject)) problems.push({ code: "INJECT_SHAPE" });
  if (typeof loaded.exports.apply !== "function") problems.push({ code: "APPLY_SHAPE" });
  const bad = loaded.required.filter((name) => !PLATFORM_MODULES.includes(name));
  if (bad.length > 0) problems.push({ code: "REQUIRE_OUTSIDE_WHITELIST", names: bad });
  return { ok: problems.length === 0, keys, required: loaded.required.slice(), hook: loaded.hook, problems };
}

export function readHook(windowObject) {
  const value = windowObject && windowObject.__DSH_GATE_TEST_HOOK__;
  if (!value) return { present: false, source: "absent" };
  return { present: true, source: "client", value };
}

/* ── 槽位宿主（apply 的目标） ─────────────────────────────────────────── */

export function createSlotHost() {
  const calls = [];
  let registered = null;
  const slots = {
    inject(name, run) {
      calls.push({ kind: "inject", name });
      const result = typeof run === "function" ? run() : undefined;
      return result;
    },
    register(meta, component) {
      calls.push({ kind: "register", name: meta && meta.name, key: meta && meta.key });
      registered = { meta, component };
      return () => calls.push({ kind: "unregister", key: meta && meta.key });
    },
  };
  return {
    calls,
    slots,
    get component() { return registered && registered.component; },
    get meta() { return registered && registered.meta; },
    apply: (exports) => exports.apply({ slots }),
  };
}

/* ── 假传输：6 类失败 + 成功，语义与 client 内 request() 完全一致 ───────── */

export const TRANSPORT_FAILURES = Object.freeze(["timeout", "aborted", "network", "http", "protocol", "auth"]);

const failureOf = (kind, detail) => {
  if (kind === "timeout") {
    const error = new Error("请求超时（timeout " + (detail || 1000) + "ms）");
    error.name = "TimeoutError";
    error.code = "ETIMEDOUT";
    return error;
  }
  if (kind === "aborted") {
    const error = new Error("流被中断（stream aborted）");
    error.name = "AbortError";
    error.code = "ECONNRESET";
    return error;
  }
  const error = new TypeError("Failed to fetch");
  error.code = "ENETWORK";
  return error;
};

/**
 * 假传输。routes: { "/api/dsh-gate/state": {body} | {status,body} | {failure:"timeout"} | fn }。
 * request() 复制 client 的容错语义（网络错→{ok:false,status:0}；非 2xx→body.message||body.error；
 * 非 JSON→body:null）。
 */
export function createFakeTransport(routes = {}) {
  const calls = [];
  const table = new Map(Object.entries(routes));
  const resolveRoute = (requestPath) => {
    if (table.has(requestPath)) return table.get(requestPath);
    for (const [pattern, value] of table) {
      if (pattern.endsWith("*") && requestPath.startsWith(pattern.slice(0, -1))) return value;
    }
    return { status: 404, bodyText: JSON.stringify({ error: "not found: " + requestPath }) };
  };
  const toResponse = (entry) => {
    const spec = typeof entry === "function" ? entry() : entry;
    if (spec && spec.failure) throw failureOf(spec.failure, spec.detail);
    const status = spec && typeof spec.status === "number" ? spec.status : 200;
    const bodyText = spec && typeof spec.bodyText === "string" ? spec.bodyText : JSON.stringify(spec && spec.body === undefined ? null : spec.body);
    return { ok: status >= 200 && status < 300, status, text: async () => bodyText, json: async () => JSON.parse(bodyText) };
  };
  const doFetch = async (requestPath, options) => {
    calls.push({ path: requestPath, options: cloneJson(options || {}) });
    return toResponse(resolveRoute(requestPath));
  };
  const request = async (requestPath, options) => {
    let response;
    try {
      response = await doFetch(requestPath, options);
    } catch (failure) {
      return { ok: false, status: 0, body: null, error: String((failure && failure.message) || failure) };
    }
    const text = await response.text();
    let body = null;
    if (text.length > 0) {
      try { body = JSON.parse(text); } catch { body = null; }
    }
    if (!response.ok) {
      const detail = body && (body.message || body.error) ? (body.message || body.error) : "HTTP " + response.status;
      return { ok: false, status: response.status, body, error: String(detail) };
    }
    return { ok: true, status: response.status, body, error: "" };
  };
  return { fetch: doFetch, request, calls, paths: () => calls.map((call) => call.path), route: (requestPath, entry) => table.set(requestPath, entry) };
}

/** S4 面板 fixture：五个接口的最小合法响应（形状按 client 的 isObject/listOf 防御写）。 */
export function panelFixtures() {
  const policyContent = {
    version: 3,
    enabled: true,
    freezePtcToolset: true,
    defaults: { capability: 2, section: 1, skillpack: 2 },
    capabilities: { "native:read": { tier: 1 }, "native:write": { tier: 1 } },
    sources: {},
    legacy: { unknownOverrides: {} },
    catalog: { groupByPlugin: true, maxDescriptionLength: 64, skillGroups: false, signatureSummary: { enabled: true, tools: [] } },
    narrowPassThrough: 12,
    protected: [],
    skills: { takeover: true, off: [], imports: [] },
    mcp: { servers: {} },
  };
  const capabilityRows = [
    { id: "native:read", kind: "native", label: "读取", tier: 1, via: "native", confidence: "high", sourceKind: "host", origin: "host", tags: [], reasons: ["native"], upstreamHidden: false, skills: [], deviations: [] },
    { id: "native:write", kind: "native", label: "写入", tier: 1, via: "native", confidence: "high", sourceKind: "host", origin: "host", tags: [], reasons: ["native"], upstreamHidden: false, skills: [], deviations: [] },
    { id: "mcp:fs", kind: "mcp", label: "文件服务", tier: 2, via: "sources", confidence: "medium", sourceKind: "mcp", origin: "host", tags: [], reasons: ["capability"], upstreamHidden: false, skills: [], deviations: [] },
  ];
  return {
    state: {
      agent: "main",
      enabled: true,
      passthrough: false,
      frozen: false,
      executor: { kind: "run_code" },
      tiers: { capability: 2, section: 1, skillpack: 2 },
      counts: { tools: 2, sections: 0, skills: 0 },
      loaded: [],
      residentNames: ["read", "write"],
      onDemandNames: [],
      offNames: [],
      visible: 2,
      sections: [],
      skills: [],
      warnings: [],
      policyVersion: 3,
    },
    view: {
      version: 3,
      defaults: { capability: 2, section: 1, skillpack: 2 },
      capabilities: capabilityRows,
      tools: [],
      sections: [],
      skills: [],
      deviations: [],
      upstreamHidden: [],
      warnings: [],
      legacy: { unknownOverrides: {} },
      sources: {},
    },
    policy: { file: "gate.json", version: 3, migrated: false, warnings: [], content: policyContent },
    skills: { skills: [{ name: "matlab-use-package-manager", provider: "host", tier: 2, off: false, description: "MATLAB 包管理", source: "host" }], skillpacks: [], imports: [] },
    // 默认 fixture 用 owned 行：S4G-12 要验证「编辑保存」真实链路；
    // external（宿主托管只读）由 S4G-16 用专用 fixture 覆盖。
    mcp: { servers: [{ name: "fs", transport: "stdio", enabled: true, state: "owned", tools: ["mcp__fs__read"] }] },
  };
}

export function panelRoutes(fixtures) {
  const f = fixtures || panelFixtures();
  return {
    "/api/dsh-gate/state": { body: f.state },
    "/api/dsh-gate/capabilities": { body: f.view },
    "/api/dsh-gate/policy": { body: f.policy },
    "/api/dsh-gate/skills": { body: f.skills },
    "/api/dsh-gate/mcp": { body: f.mcp },
  };
}

/* ── 渲染记录：根子键 / 深比较 ────────────────────────────────────────── */

export function rootKeys(tree) {
  if (!tree) return [];
  const children = tree.children || [];
  return Array.from(children, (child) => (child.key === null || child.key === undefined ? child.type : child.type + ":" + child.key));
}

export function stableTree(tree) {
  const walk = (node) => {
    if (!node) return null;
    return {
      type: node.type,
      key: node.key === undefined ? null : node.key,
      text: node.text === undefined ? null : node.text,
      props: cloneJson(node.props || {}),
      children: Array.from(node.children || [], walk),
    };
  };
  return walk(tree);
}

export function treeEqual(a, b) {
  return JSON.stringify(stableTree(a)) === JSON.stringify(stableTree(b));
}

/* ── 草稿仓库：跨页签共享同一 storage，不丢未提交内容 ─────────────────── */

export function createDraftStorage(initial) {
  const cells = new Map(initial ? Object.entries(cloneJson(initial)) : []);
  return {
    get(key) { return cells.has(key) ? cells.get(key) : undefined; },
    set(key, value) { cells.set(key, value); },
    delete(key) { cells.delete(key); },
    keys() { return Array.from(cells.keys()).sort(); },
    snapshot() { return Object.fromEntries(Array.from(cells.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))); },
  };
}

export function createDraftRepo(options = {}) {
  const storage = options.storage || createDraftStorage();
  const key = options.key || "dsh-gate:draft";
  const read = () => {
    const raw = storage.get(key);
    if (typeof raw !== "string") return null;
    try { return JSON.parse(raw); } catch { return null; }
  };
  const write = (draft) => {
    if (draft === null || draft === undefined) { storage.delete(key); return null; }
    const text = JSON.stringify(draft);
    storage.set(key, text);
    return draft;
  };
  return { key, storage, read, write, clear: () => write(null), snapshot: () => storage.snapshot() };
}

/* ── 默认策略模板：跨端一致性钩子（FG-7 的判据） ───────────────────────── */

/** 服务端的权威空模板（lib/policy.emptyPolicyTemplate + normalizeV3Policy，和 GET /policy.template 同源）。 */
export function serverDefaultTemplate() {
  return normalizeV3Policy(emptyPolicyTemplate()).policy;
}

/**
 * 从 client 源码静态抽取 fallbackTemplate：hook 出现前（#07）这是唯一读取途径。
 * 抽取失败必须抛错——静默返回空对象会让 FG-7 永远绿。
 */
export function extractClientDefaultTemplate(source) {
  const marker = "const fallbackTemplate = () => (";
  const start = source.indexOf(marker);
  if (start < 0) throw new FrontendHarnessError("TEMPLATE_NOT_FOUND", "client 里找不到 fallbackTemplate 箭头函数");
  let depth = 0;
  let open = -1;
  let end = -1;
  for (let index = start + marker.length - 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") { depth += 1; if (depth === 1) open = index; continue; }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) { end = index; break; }
    }
  }
  if (open < 0 || end < 0) throw new FrontendHarnessError("TEMPLATE_UNBALANCED", "fallbackTemplate 的括号不配对");
  const text = source.slice(open + 1, end);
  const sandbox = { TIER_OFF: 0, TIER_RESIDENT: 1, TIER_ONDEMAND: 2 };
  // vm 里造出来的对象原型属于另一个 realm，必须过一遍 JSON 才能用 deepStrictEqual 比较。
  const template = JSON.parse(JSON.stringify(vm.runInNewContext("(" + text + ")", vm.createContext(sandbox), { timeout: 1000 })));
  return { template, span: [start, end + 2] };
}

export function readClientDefaultTemplate(options = {}) {
  if (options.hook && options.hook.present) {
    const hook = options.hook.value || {};
    if (typeof hook.template === "function") return { source: "hook", template: hook.template() };
    if (hook.template && typeof hook.template === "object") return { source: "hook", template: hook.template };
  }
  const source = options.source === undefined ? fs.readFileSync(CLIENT_PATH, "utf8") : options.source;
  const extracted = extractClientDefaultTemplate(source);
  return { source: "static-extract", template: extracted.template, span: extracted.span };
}

/** 深比较两个 JSON 值，返回按路径排序的差异表。 */
export function deepDiff(left, right, options = {}) {
  const differences = [];
  const limit = options.limit || 200;
  const walk = (a, b, at) => {
    if (differences.length >= limit) return;
    const aType = a === null ? "null" : Array.isArray(a) ? "array" : typeof a;
    const bType = b === null ? "null" : Array.isArray(b) ? "array" : typeof b;
    if (aType !== bType) { differences.push({ path: at || "$", kind: "type", left: a, right: b }); return; }
    if (aType === "array") {
      if (a.length !== b.length) { differences.push({ path: at || "$", kind: "length", left: a.length, right: b.length }); }
      const max = Math.max(a.length, b.length);
      for (let index = 0; index < max; index += 1) walk(a[index], b[index], (at || "") + "[" + index + "]");
      return;
    }
    if (aType === "object") {
      const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
      for (const key of keys) walk(a[key], b[key], at ? at + "." + key : key);
      return;
    }
    if (!Object.is(a, b)) differences.push({ path: at || "$", kind: "value", left: a, right: b });
  };
  walk(left, right, "");
  return differences;
}

export function compareTemplates(clientTemplate, serverTemplate) {
  const differences = deepDiff(serverTemplate, clientTemplate);
  return { equal: differences.length === 0, differences, count: differences.length };
}

export function summarizeDifferences(differences) {
  return differences.map((item) => item.path + ": server=" + JSON.stringify(item.left) + " client=" + JSON.stringify(item.right));
}