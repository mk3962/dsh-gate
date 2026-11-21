#!/usr/bin/env node
/**
 * S4 · 前端第一性原理重构 · 防回退门禁（S4G-1 … S4G-12）
 *
 * 目标：把「宽松卡片 / 双主题 / 自解释交互 / 单保存」重构的 10 条不可回退契约钉成可执行门禁。
 * 待测客户端由 DSH_GATE_CLIENT_PATH 指定（缺省 client/index.js），因此同一套门禁既能验证新版，
 * 也能指向 git HEAD:client/index.js 导出的旧版 v0.6.0，证明这些契约在旧版上精准判红。
 *
 * 用法：
 *   node --test test/seams/s4-frontend-gate.test.mjs
 *   DSH_GATE_CLIENT_PATH="../tmp/old-client-0.6.0.js" node --test test/seams/s4-frontend-gate.test.mjs
 *
 * 只读：本文件不修改 client/index.js，也不改其它既有测试。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REPO_ROOT,
  createReact,
  createSandbox,
  loadClient,
  createFakeTransport,
  panelRoutes,
  createSlotHost,
} from "./s4-frontend-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLIENT = path.join(REPO_ROOT, "client", "index.js");
const CLIENT_PATH = process.env.DSH_GATE_CLIENT_PATH
  ? path.resolve(process.env.DSH_GATE_CLIENT_PATH)
  : DEFAULT_CLIENT;
const CLIENT_LABEL = process.env.DSH_GATE_CLIENT_PATH ? CLIENT_PATH : DEFAULT_CLIENT;

const DEPRECATED_TOKENS = [
  "--dsw-specific-input-major",
  "--dsw-alias-button-info-fill",
  "--dsw-alias-border-focus",
];

function readSource() {
  return fs.readFileSync(CLIENT_PATH, "utf8");
}

function loadWithHook(options = {}) {
  const { react } = createReact();
  const sandbox = createSandbox({ react, hook: true, fetch: options.fetch });
  const loaded = loadClient({ sandbox, source: readSource() });
  assert.equal(loaded.hook.present, true, "客户端未暴露 __DSH_GATE_TEST_HOOK__ 测试钩子：" + CLIENT_LABEL);
  return { loaded, sandbox, hook: loaded.hook.value, react };
}

function makeOrchestrator(hook, options = {}) {
  return hook.L4.create({
    transport: options.transport || hook.transport,
    draft: options.draft || hook.L2.create({}),
    setTimeout,
    clearTimeout,
  });
}

function policyContent(overrides = {}) {
  return Object.assign({
    version: 3,
    enabled: true,
    capabilities: {},
    defaults: { capability: 2, section: 1, skillpack: 2 },
    skills: { takeover: true, off: [], imports: [] },
    catalog: { groupByPlugin: true, maxDescriptionLength: 64 },
    repeatGuard: { enabled: true, windowSize: 10, threshold: 3, reminders: 1, previewChars: 400, exclusions: [] },
  }, overrides);
}

function makeDirtyDraft(hook) {
  const draft = hook.L2.create({});
  draft.setBaseline(policyContent(), {});
  assert.equal(draft.stage(draft.keys.skill("legacy-skill"), 3, "tier"), true, "脏草稿构造失败：stage 未产生脏单元");
  assert.equal(draft.dirtySummary().total > 0, true, "脏草稿构造失败：dirtySummary().total 必须 > 0");
  return draft;
}

function makeCleanDraft(hook) {
  const draft = hook.L2.create({});
  draft.setBaseline(policyContent(), {});
  return draft;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeout = 900) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    await delay(10);
  }
  return predicate();
}

/* ── 桩 document ──────────────────────────────────────────────────────── */

function makeFakeDocument() {
  const nodes = [];
  const listeners = [];
  function createElement(tagName) {
    return {
      tagName: String(tagName).toUpperCase(),
      attributes: {},
      textContent: "",
      children: [],
      setAttribute(name, value) { this.attributes[String(name)] = String(value); },
      getAttribute(name) {
        const key = String(name);
        return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null;
      },
      appendChild(child) { this.children.push(child); nodes.push(child); return child; },
    };
  }
  const head = createElement("head");
  const doc = {
    head,
    nodes,
    listeners,
    createElement,
    querySelector(selector) {
      const match = /^style\[([A-Za-z0-9_-]+)\]$/.exec(String(selector));
      if (!match) return null;
      const attr = match[1];
      return nodes.find((node) => node.tagName === "STYLE" && node.getAttribute(attr) !== null) || null;
    },
    addEventListener(type, handler) { listeners.push({ type, handler }); },
    removeEventListener(type, handler) {
      const index = listeners.findIndex((entry) => entry.type === type && entry.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  return doc;
}

function styleNodes(doc) {
  return doc.nodes.filter((node) => node.tagName === "STYLE" && node.getAttribute("data-dsh-gate") !== null);
}

/* ── 挂载整块面板 ──────────────────────────────────────────────────────── */

async function mountPanel(options = {}) {
  const { react, createRenderer } = createReact();
  const captured = [];
  const buttons = [];
  const inputs = [];
  if (options.captureSwitches === true) {
    const original = react.createElement;
    react.createElement = function patchedCreateElement(type, props, ...rest) {
      if (props && props.role === "switch") captured.push(props);
      return original.call(this, type, props, ...rest);
    };
  }
  if (options.captureControls === true) {
    // 捕获未 normalize 的按钮/输入框 props：渲染树里的函数会被换成 "[fn:...]"，交互只能从这里触发。
    const inner = react.createElement;
    react.createElement = function patchedControlElement(type, props, ...rest) {
      if (type === "button") buttons.push({ props: props || {}, label: rest.map((child) => String(child)).join("") });
      else if (type === "input") inputs.push({ props: props || {} });
      return inner.call(this, type, props, ...rest);
    };
  }
  const doc = options.document || makeFakeDocument();
  const transport = createFakeTransport(options.routes || panelRoutes());
  const sandbox = createSandbox({ react, fetch: transport.fetch, hook: true });
  sandbox.context.document = doc;
  const loaded = loadClient({ sandbox, source: readSource() });
  const host = createSlotHost();
  host.apply(loaded.exports);
  const renderer = createRenderer();
  const mounted = renderer.mount(host.component({}));
  await mounted.settle();
  return { loaded, hook: loaded.hook.value, host, transport, renderer, mounted, doc, react, captured, buttons, inputs };
}

/* ── 交互探针：捕获数组 + 当前渲染树 ──────────────────────────────────── */

function nodeText(node) {
  if (!node) return "";
  if (node.type === "#text") return node.text;
  return (node.children || []).map(nodeText).join("");
}

function walkTree(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of node.children || []) walkTree(child, visit);
}

function treeButtons(tree) {
  const out = [];
  walkTree(tree, (node) => {
    if (node.type === "button") out.push({ props: node.props, label: nodeText(node) });
  });
  return out;
}

function treeInputs(tree) {
  const out = [];
  walkTree(tree, (node) => {
    if (node.type === "input") out.push(node.props);
  });
  return out;
}

function findTreeButton(tree, label) {
  return treeButtons(tree).find((entry) => entry.label === label) || null;
}

function findTreeInput(tree, ariaLabel) {
  return treeInputs(tree).find((props) => props["aria-label"] === ariaLabel) || null;
}

function latestButton(ctx, label) {
  for (let index = ctx.buttons.length - 1; index >= 0; index -= 1) {
    if (ctx.buttons[index].label === label) return ctx.buttons[index];
  }
  return null;
}

function latestInput(ctx, ariaLabel) {
  for (let index = ctx.inputs.length - 1; index >= 0; index -= 1) {
    const props = ctx.inputs[index].props;
    if (props["aria-label"] === ariaLabel) return ctx.inputs[index];
  }
  return null;
}

function countPosts(transport, target) {
  return transport.calls.filter((entry) => entry.path === target &&
    entry.options && String(entry.options.method || "").toUpperCase() === "POST").length;
}

/* ── CSS 解析 ──────────────────────────────────────────────────────────── */

function selectorList(css) {
  let text = String(css).replace(/\/\*[\s\S]*?\*\//g, "");
  let guard = 0;
  while (guard < 200) {
    guard += 1;
    const at = text.search(/@(?:-\w+-)?keyframes\b/);
    if (at < 0) break;
    const open = text.indexOf("{", at);
    if (open < 0) { text = text.slice(0, at); break; }
    let depth = 0;
    let end = -1;
    for (let cursor = open; cursor < text.length; cursor += 1) {
      if (text[cursor] === "{") depth += 1;
      else if (text[cursor] === "}") {
        depth -= 1;
        if (depth === 0) { end = cursor; break; }
      }
    }
    text = end < 0 ? text.slice(0, at) : text.slice(0, at) + text.slice(end + 1);
  }
  text = text.replace(/@[^{};]+\{/g, "");
  const selectors = [];
  const rule = /([^{}]+)\{/g;
  let match = rule.exec(text);
  while (match !== null) {
    for (const part of match[1].split(",")) {
      const selector = part.trim();
      if (selector.length > 0) selectors.push(selector);
    }
    match = rule.exec(text);
  }
  return selectors;
}

function definedClassNames(css) {
  const out = new Set();
  const rule = /\.dshg-[A-Za-z0-9_-]+/g;
  let match = rule.exec(String(css));
  while (match !== null) {
    out.add(match[0].slice(1));
    match = rule.exec(String(css));
  }
  return out;
}

function usedClassNames(source) {
  const out = new Set();
  const rule = /className\s*:\s*"([^"]*)"/g;
  let match = rule.exec(String(source));
  while (match !== null) {
    for (const token of match[1].split(/\s+/)) {
      if (/^dshg-[A-Za-z0-9_-]+$/.test(token)) out.add(token);
    }
    match = rule.exec(String(source));
  }
  return out;
}

/** 取出所有条件命中 query 的 @media 块（含花括号内全部内容），用于窄屏规则定点断言。 */
function mediaBlocks(css, query) {
  const text = String(css);
  const out = [];
  const marker = /@media[^{]*\{/g;
  let match = marker.exec(text);
  while (match !== null) {
    const head = match[0];
    const start = match.index;
    if (query.test(head)) {
      let depth = 0;
      let end = -1;
      for (let cursor = start + head.length - 1; cursor < text.length; cursor += 1) {
        if (text[cursor] === "{") depth += 1;
        else if (text[cursor] === "}") {
          depth -= 1;
          if (depth === 0) { end = cursor; break; }
        }
      }
      out.push(text.slice(start, end < 0 ? text.length : end + 1));
    }
    match = marker.exec(text);
  }
  return out;
}

function topbarSwitchBlocks(source) {
  const blocks = [];
  const marker = /switchButton\(\{/g;
  let match = marker.exec(String(source));
  while (match !== null) {
    const start = match.index + match[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let cursor = start; cursor < source.length; cursor += 1) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") {
        depth -= 1;
        if (depth === 0) { end = cursor; break; }
      }
    }
    if (end > start) blocks.push(source.slice(start, end + 1));
    match = marker.exec(source);
  }
  return blocks.filter((block) => /key:\s*"enabled"/.test(block));
}

function summarizeCalls(calls) {
  return calls.map((call) => {
    const method = call.options && call.options.method ? String(call.options.method).toUpperCase() : "GET";
    return method + " " + call.path;
  }).join("、") || "（无请求）";
}

/* ═══════════════════════════════════════════════════════════════════════
 * S4G-1 · ensureStyle 真实 DOM 注入与幂等
 * ═══════════════════════════════════════════════════════════════════════ */

test("S4G-1 ensureStyle 真实注入 style[data-dsh-gate] 且幂等", async () => {
  const doc = makeFakeDocument();
  const ctx = await mountPanel({ document: doc });

  const nodes = styleNodes(doc);
  assert.equal(
    nodes.length,
    1,
    "挂载 PanelBody 后 document.head 内必须恰好有 1 个 style[data-dsh-gate]，实际 " + nodes.length + " 个（" + CLIENT_LABEL + "）",
  );
  const css = String(nodes[0].textContent || "");
  assert.ok(css.trim().length > 500, "注入的样式文本不能为空，实际长度 " + css.trim().length);
  assert.match(css, /\.dshg-wrap/, "注入的样式必须包含面板根作用域 .dshg-wrap");

  const hook = ctx.hook;
  assert.equal(typeof hook.shell.ensureStyle, "function", "shell.ensureStyle 必须导出");
  assert.equal(hook.shell.ensureStyle(doc), false, "已存在 style 节点时 ensureStyle(doc) 必须返回 false（幂等）");
  assert.equal(styleNodes(doc).length, 1, "二次调用 ensureStyle 不得插入第二个 style 节点");

  ctx.mounted.unmount();
  const again = ctx.renderer.mount(ctx.host.component({}));
  await again.settle();
  assert.equal(styleNodes(doc).length, 1, "卸载后重新挂载不得插入第二个 style 节点");
  again.unmount();
});

/* ═══════════════════════════════════════════════════════════════════════
 * S4G-2 · CSS 类名全集零偏差 + 作用域零泄漏
 * ═══════════════════════════════════════════════════════════════════════ */

test("S4G-2 CSS 类名零偏差、选择器不泄漏宿主、无弃用令牌", () => {
  const source = readSource();
  const { hook } = loadWithHook();

  assert.equal(typeof hook.style, "object", "测试钩子必须暴露 style 元信息");
  assert.equal(Array.isArray(hook.style.sections), true, "STYLE_SECTIONS 必须可枚举");
  const sectionsCss = hook.style.sections.map((section) => section[1]).join("");
  const fullCss = String(hook.style.text || sectionsCss);
  assert.ok(fullCss.trim().length > 0, "样式文本不能为空");

  const used = usedClassNames(source);
  const defined = definedClassNames(sectionsCss);
  const problems = [];

  const missing = [...used].filter((name) => !defined.has(name)).sort();
  if (missing.length > 0) problems.push("有 className 在 STYLE_SECTIONS 中无定义（漏类）：" + missing.join(", "));

  const dead = [...defined].filter((name) => !used.has(name)).sort();
  if (dead.length > 0) problems.push("STYLE_SECTIONS 定义了但源码从未引用（死类）：" + dead.join(", "));

  const selectors = selectorList(fullCss);
  if (selectors.length === 0) problems.push("未能从样式文本解析出任何选择器");
  const leaked = selectors.filter((selector) => !/^\.dshg-/.test(selector));
  if (leaked.length > 0) problems.push("选择器未限定在 .dshg-wrap 作用域内、会污染宿主：" + leaked.join(" | "));

  const combined = source + "\n" + fullCss;
  const deprecated = DEPRECATED_TOKENS.filter((token) => combined.indexOf(token) >= 0);
  if (deprecated.length > 0) problems.push("仍在使用弃用令牌：" + deprecated.join(", "));

  const misspelledLayer = [];
  const layerToken = /(^|[^\w-])--dsw-alias-layer-([123])(?![\w-])/g;
  let layerMatch = layerToken.exec(combined);
  while (layerMatch !== null) {
    misspelledLayer.push("--dsw-alias-layer-" + layerMatch[2]);
    layerMatch = layerToken.exec(combined);
  }
  if (misspelledLayer.length > 0) {
    problems.push("层底色令牌拼错（必须用 --dsw-alias-bg-layer-1/2/3，写错会退回硬编码色）：" + Array.from(new Set(misspelledLayer)).sort().join(", "));
  }

  const missingLayerTokens = ["--dsw-alias-bg-layer-1", "--dsw-alias-bg-layer-2", "--dsw-alias-bg-layer-3"]
    .filter((token) => combined.indexOf(token) < 0);
  if (missingLayerTokens.length > 0) {
    problems.push("缺层底色令牌（样式必须吃宿主主题，不能退回硬编码）：" + missingLayerTokens.join(", "));
  }

  let hiddenGuard = false;
  const hiddenRule = /([^{}]+)\{([^{}]*)\}/g;
  let hiddenMatch = hiddenRule.exec(fullCss);
  while (hiddenMatch !== null) {
    if (/\[hidden\]/.test(hiddenMatch[1]) && /display\s*:\s*none/.test(hiddenMatch[2])) { hiddenGuard = true; break; }
    hiddenMatch = hiddenRule.exec(fullCss);
  }
  if (!hiddenGuard) {
    problems.push("样式缺 [hidden]{display:none} 兜底（.dshg-panel{display:flex} 会打穿原生 hidden 属性，隐藏元素照常显示）");
  }

  const narrowBlocks = mediaBlocks(fullCss, /max-width\s*:\s*720px/);
  if (narrowBlocks.length === 0) {
    problems.push("缺少窄屏适配 @media (max-width:720px)");
  } else {
    const narrowCss = narrowBlocks.join("\n");
    let headWrapSeen = false;
    let headWrapWraps = false;
    const narrowRule = /([^{}]+)\{([^{}]*)\}/g;
    let ruleMatch = narrowRule.exec(narrowCss);
    while (ruleMatch !== null) {
      if (ruleMatch[1].indexOf(".dshg-groupHeadWrap") >= 0) {
        headWrapSeen = true;
        if (/flex-wrap\s*:\s*wrap/.test(ruleMatch[2])) headWrapWraps = true;
      }
      ruleMatch = narrowRule.exec(narrowCss);
    }
    if (!headWrapSeen) {
      problems.push("窄屏 @media (max-width:720px) 缺 .dshg-groupHeadWrap 规则（分组标题在 720px 下会被操作区挤成 0px）");
    } else if (!headWrapWraps) {
      problems.push("窄屏 @media (max-width:720px) 的 .dshg-groupHeadWrap 必须写 flex-wrap:wrap（否则分组标题被挤成 0px）");
    }
  }

  const offRule = /\.dshg-switch\[aria-checked=['"]false['"]\][^{]*\{([^}]*)\}/.exec(fullCss);
  if (offRule === null) problems.push("缺少开关关闭态样式 .dshg-switch[aria-checked='false']");
  else if (/--dshg-error/.test(offRule[1])) problems.push("开关关闭态误用 --dshg-error（关闭不是错误）：" + offRule[1]);

  assert.deepEqual(problems, [], "S4G-2 契约点失败（" + CLIENT_LABEL + "）：\n- " + problems.join("\n- "));
});

/* ═══════════════════════════════════════════════════════════════════════
 * S4G-3 · Toast 全级别可手动关闭 + 定时自动消失
 * ═══════════════════════════════════════════════════════════════════════ */

test("S4G-3 toast 四种级别都可手动关闭，且 lifetime>0 有自动清理定时器", () => {
  const source = readSource();
  const { hook } = loadWithHook();
  assert.equal(typeof hook.primitives.toastHost, "function", "primitives.toastHost 必须可用");

  const tones = ["ok", "info", "warn", "error"];
  const lifetimes = { ok: 4000, info: 6000, warn: 8000, error: 0 };
  const dismissed = [];
  const items = tones.map((tone, index) => ({
    key: tone + "-" + index,
    tone,
    text: "message-" + tone,
    count: 1,
    lifetime: lifetimes[tone],
  }));
  const tree = hook.primitives.toastHost({ items, onDismiss: (key) => dismissed.push(key) });
  assert.equal(tree && tree.type, "div", "toastHost 必须渲染容器节点");
  const toasts = (tree.props.children || []).filter(Boolean);
  assert.equal(toasts.length, 4, "四种级别必须各渲染 1 条 toast，实际 " + toasts.length);

  const problems = [];
  toasts.forEach((toast, index) => {
    const children = (toast.props.children || []).filter(Boolean);
    const close = children.find((child) => child && child.type === "button");
    if (!close) { problems.push(tones[index] + " 级别缺少关闭按钮"); return; }
    if (typeof close.props.onClick !== "function") { problems.push(tones[index] + " 级别关闭按钮不可点击"); return; }
    close.props.onClick();
    if (dismissed[dismissed.length - 1] !== items[index].key) problems.push(tones[index] + " 级别关闭按钮未回调 onDismiss(key)");
  });
  assert.deepEqual(problems, [], "toast 手动关闭契约被破坏：" + problems.join("；"));

  assert.match(source, /toastItems[\s\S]{0,800}setTimeout\(/, "PanelBody 必须为 lifetime>0 的 toast 安排自动清理定时器（" + CLIENT_LABEL + "）");
  assert.match(source, /(?:item\.expiresAt|item\.lifetime)[\s\S]{0,240}setTimeout\(|setTimeout\([\s\S]{0,400}(?:item\.lifetime|item\.expiresAt)/, "自动清理定时器必须以 toast.lifetime / expiresAt 为延迟");
  assert.match(source, /clearTimeout\(/, "卸载时必须清理自动清理定时器");
});

/* ═══════════════════════════════════════════════════════════════════════
 * S4G-4 · Ctrl+Z / Ctrl+Shift+Z 键盘撤销重做
 * ═══════════════════════════════════════════════════════════════════════ */

test("S4G-4 非输入控件内 Ctrl+Z / Ctrl+Shift+Z 触发撤销重做", async () => {
  const doc = makeFakeDocument();
  const ctx = await mountPanel({ document: doc });

  const listeners = doc.listeners.filter((entry) => entry.type === "keydown");
  assert.equal(listeners.length, 1, "PanelBody 必须注册恰好 1 个 keydown 监听，实际 " + listeners.length + "（" + CLIENT_LABEL + "）");

  const handler = listeners[0].handler;
  assert.equal(typeof handler, "function", "keydown 监听必须是可调用函数");

  function dispatch(overrides) {
    let prevented = false;
    handler(Object.assign({
      key: "z",
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      isComposing: false,
      target: { tagName: "DIV", isContentEditable: false },
      preventDefault() { prevented = true; },
    }, overrides));
    return prevented;
  }

  assert.equal(dispatch({}), true, "非输入控件内 Ctrl+Z 必须 preventDefault 并触发撤销");
  assert.equal(dispatch({ shiftKey: true }), true, "非输入控件内 Ctrl+Shift+Z 必须 preventDefault 并触发重做");
  assert.equal(dispatch({ key: "y", shiftKey: false }), true, "Ctrl+Y 必须 preventDefault 并触发重做");

  const guarded = [
    { tagName: "INPUT" },
    { tagName: "TEXTAREA" },
    { tagName: "SELECT" },
    { tagName: "DIV", isContentEditable: true },
  ];
  const problems = [];
  guarded.forEach((target) => {
    if (dispatch({ target }) === true) problems.push("输入目标 " + target.tagName + (target.isContentEditable ? "[contentEditable]" : "") + " 被拦截");
  });
  assert.deepEqual(problems, [], "撤销快捷键侵入输入控件：" + problems.join("；"));

  ctx.mounted.unmount();
  assert.equal(
    doc.listeners.filter((entry) => entry.type === "keydown").length,
    0,
    "卸载 PanelBody 后必须移除 keydown 监听",
  );
});

/* ═══════════════════════════════════════════════════════════════════════
 * S4G-5 · Preflight 9 动作 × 脏/净矩阵
 * ═══════════════════════════════════════════════════════════════════════ */

test("S4G-5 preflight 脏/净矩阵：保存类免确认、丢弃类才确认", () => {
  const { hook } = loadWithHook();
  const dirtyOrchestrator = makeOrchestrator(hook, { draft: makeDirtyDraft(hook) });
  const cleanOrchestrator = makeOrchestrator(hook, { draft: makeCleanDraft(hook) });

  const saveActions = ["save-policy", "save-all", "save-skills", "save-signature", "mcp", "toggle-enabled"];
  const discardActions = ["reload", "switch-session", "replace-json"];
  const problems = [];

  for (const action of saveActions) {
    const dirty = dirtyOrchestrator.preflight(action);
    if (dirty.needsConfirm !== false) problems.push(action + "（脏）needsConfirm=" + dirty.needsConfirm + "（应 false）");
  }
  for (const action of discardActions) {
    const dirty = dirtyOrchestrator.preflight(action);
    if (dirty.needsConfirm !== true) problems.push(action + "（脏）needsConfirm=" + dirty.needsConfirm + "（应 true）");
  }
  for (const action of [...saveActions, ...discardActions]) {
    const clean = cleanOrchestrator.preflight(action);
    if (clean.needsConfirm !== false) problems.push(action + "（净）needsConfirm=" + clean.needsConfirm + "（应 false）");
  }
  assert.deepEqual(problems, [], "preflight 脏/净矩阵不符合单保存语义：" + problems.join("；"));
});

/* ═══════════════════════════════════════════════════════════════════════
 * S4G-6 · 顶栏真启停
 * ═══════════════════════════════════════════════════════════════════════ */

test("S4G-6 顶栏启停走真写接口，不得复用 actions.reload()", async () => {
  const source = readSource();
  const blocks = topbarSwitchBlocks(source);
  assert.equal(blocks.length, 1, "源码中必须恰好存在 1 个 key:\"enabled\" 的 switchButton 调用，实际 " + blocks.length);
  const block = blocks[0];
  assert.equal(/actions\.toggleEnabled\(/.test(block), true, "顶栏 enabled 开关必须绑定 actions.toggleEnabled()，实际：" + block.slice(0, 260));
  assert.equal(/actions\.reload\(/.test(block), false, "顶栏 enabled 开关不得再绑定 actions.reload()");

  const transport = createFakeTransport(panelRoutes());
  const { hook } = loadWithHook({ fetch: transport.fetch });
  const orchestrator = makeOrchestrator(hook);
  assert.equal(typeof orchestrator.toggleEnabled, "function", "L4 必须提供 toggleEnabled(nextEnabled)（旧版缺失）");
  await orchestrator.toggleEnabled(false);

  const call = transport.calls.find((entry) => entry.path === "/api/dsh-gate/policy" && entry.options && String(entry.options.method || "").toUpperCase() === "POST");
  assert.ok(call, "toggleEnabled(false) 必须发出 POST /api/dsh-gate/policy，实际请求：" + summarizeCalls(transport.calls));
  const body = JSON.parse(call.options.body);
  assert.equal(body.enabled, false, "POST body 必须携带 enabled:false");

  const ctx = await mountPanel({ captureSwitches: true });
  const enabledSwitches = ctx.captured.filter((props) => props.key === "enabled");
  assert.ok(enabledSwitches.length > 0, "顶栏必须渲染 key=「enabled」的启停开关");
  const switchProps = enabledSwitches[enabledSwitches.length - 1];
  assert.equal(typeof switchProps.onClick, "function", "顶栏启停开关必须可切换（缺 onClick 处理器）");
  switchProps.onClick();
  const clicked = await waitFor(() => ctx.transport.calls.some((entry) => entry.path === "/api/dsh-gate/policy" &&
    entry.options && String(entry.options.method || "").toUpperCase() === "POST" &&
    String(entry.options.body || "").indexOf('"enabled":false') >= 0));
  assert.equal(clicked, true, "点击顶栏启停必须发出 enabled:false 的 POST /api/dsh-gate/policy，实际请求：" + summarizeCalls(ctx.transport.calls));
  ctx.mounted.unmount();
});

/* ═══════════════════════════════════════════════════════════════════════
 * S4G-7 · listSessions 读 runtime.agents.ids
 * ═══════════════════════════════════════════════════════════════════════ */

test("S4G-7 listSessions 读取 runtime.agents.ids 作为会话清单", async () => {
  const transport = createFakeTransport(panelRoutes());
  transport.route("/api/dsh-gate/diagnostics", {
    body: { ok: true, runtime: { agents: { count: 2, ids: ["lead", "worker-1"] } } },
  });
  const { hook } = loadWithHook({ fetch: transport.fetch });
  const orchestrator = makeOrchestrator(hook);
  assert.equal(typeof orchestrator.listSessions, "function", "L4 必须提供 listSessions()");

  const result = await orchestrator.listSessions();
  assert.equal(result && result.ok, true, "listSessions 必须成功返回，实际：" + JSON.stringify(result));
  assert.deepEqual(
    (result.sessions || []).map((session) => session.id),
    ["lead", "worker-1"],
    "listSessions 必须返回 runtime.agents.ids 的 2 条会话，实际：" + JSON.stringify(result.sessions),
  );
});

/* ═══════════════════════════════════════════════════════════════════════
 * S4G-8 · 技能关闭清单协议对齐
 * ═══════════════════════════════════════════════════════════════════════ */

test("S4G-8 关闭清单操作使用 action:\"off\" + 剩余数组，禁止 off-remove", () => {
  const { hook } = loadWithHook();
  const draft = hook.L2.create({});
  draft.setBaseline(policyContent({ skills: { takeover: true, off: ["legacy-skill", "other-skill"], imports: [] } }), {});
  assert.equal(draft.stageClose("legacy-skill"), true, "stageClose(\"legacy-skill\") 必须产生关闭草稿");

  const operations = draft.toSkillOperations();
  const offRemove = operations.filter((operation) => operation.action === "off-remove");
  assert.equal(offRemove.length, 0, "不得再产生 action:\"off-remove\"，实际：" + JSON.stringify(offRemove));
  const off = operations.filter((operation) => operation.action === "off");
  assert.equal(off.length, 1, "必须产生 1 条 action:\"off\" 操作，实际：" + JSON.stringify(operations.map((operation) => operation.action)));
  const remaining = Array.from(off[0].off || []);
  assert.equal(JSON.stringify(remaining), JSON.stringify(["other-skill"]), "action:\"off\" 必须带剩余关闭清单数组，实际：" + JSON.stringify(remaining));
  assert.equal(off[0].key, "close:legacy-skill", "关闭操作必须指向被移除项对应脏键");
});

/* ═══════════════════════════════════════════════════════════════════════
 * S4G-9 · 坏文件恢复强写协议
 * ═══════════════════════════════════════════════════════════════════════ */

test("S4G-9 recoverCorruptPolicy 携带整套强写标记", async () => {
  const transport = createFakeTransport(panelRoutes());
  const { hook } = loadWithHook({ fetch: transport.fetch });
  const orchestrator = makeOrchestrator(hook);
  assert.equal(typeof orchestrator.recoverCorruptPolicy, "function", "L4 必须提供 recoverCorruptPolicy(template)（旧版缺失）");

  await orchestrator.recoverCorruptPolicy({ version: 3, enabled: true, skills: { takeover: true, off: [], imports: [] } });
  const call = transport.calls.find((entry) => entry.path === "/api/dsh-gate/policy" && entry.options && String(entry.options.method || "").toUpperCase() === "POST");
  assert.ok(call, "recoverCorruptPolicy 必须发出 POST /api/dsh-gate/policy，实际请求：" + summarizeCalls(transport.calls));
  const body = JSON.parse(call.options.body);
  const required = ["replace", "acknowledge", "replaceCorrupt", "forceOverwriteCorrupt"];
  const missing = required.filter((field) => body[field] !== true);
  assert.deepEqual(missing, [], "强写协议缺字段或非 true：" + missing.join(", ") + "；实际 body=" + call.options.body);
});

/* ═══════════════════════════════════════════════════════════════════════
 * S4G-10 · MCP update 支持
 * ═══════════════════════════════════════════════════════════════════════ */

test("S4G-10 mcpMutate 支持 action:\"update\"", async () => {
  const transport = createFakeTransport(panelRoutes());
  const { hook } = loadWithHook({ fetch: transport.fetch });
  const orchestrator = makeOrchestrator(hook);
  assert.equal(typeof orchestrator.mcpMutate, "function", "L4 必须提供 mcpMutate(payload)");

  await orchestrator.mcpMutate({ action: "update", name: "demo", server: { command: "node", args: ["demo.mjs"] } });
  const call = transport.calls.find((entry) => entry.path === "/api/dsh-gate/mcp" && entry.options && String(entry.options.method || "").toUpperCase() === "POST");
  assert.ok(call, "mcpMutate 必须发出 POST /api/dsh-gate/mcp，实际请求：" + summarizeCalls(transport.calls));
  const body = JSON.parse(call.options.body);
  assert.equal(body.action, "update", "MCP 写请求必须携带 action:\"update\"");
  assert.equal(body.name, "demo", "MCP 写请求必须携带 name");
  assert.equal(body.server && body.server.command, "node", "MCP 写请求必须携带 server 配置");
});

/* ═══════════════════════════════════════════════════════════════════════
 * S4G-11 · 技能导入目录：按 path 渲染、移除真实生效
 *
 * 回归的缺陷：draft.imports 来自 L2.importsSnapshot()，元素是 { path, id, key } 对象；
 * 渲染层直接 String(item) ⇒ 界面显示 [object Object]；点「移除」把 "[object Object]"
 * 传给 draftStore.removeImport ⇒ 返回 false，但动作层照样弹成功提示（假绿 + 删不掉）。
 * ═══════════════════════════════════════════════════════════════════════ */

test("S4G-11 技能导入目录按 path 渲染，移除真实生效且不假报成功", async () => {
  const IMPORT = "/tmp/my-skills";
  const ctx = await mountPanel({ captureControls: true });
  assert.equal(ctx.mounted.text.indexOf("导入技能目录") >= 0, true, "技能页必须渲染「导入技能目录」卡片");
  assert.equal(ctx.mounted.text.indexOf("[object Object]"), -1, "初始渲染不得出现 [object Object]");

  const importInput = latestInput(ctx, "目录绝对路径");
  assert.ok(importInput && typeof importInput.props.onChange === "function", "导入目录输入框必须可编辑（缺 onChange）");
  importInput.props.onChange({ target: { value: IMPORT } });
  await ctx.mounted.settle();

  const addButton = latestButton(ctx, "加入草稿");
  assert.ok(addButton && typeof addButton.props.onClick === "function", "导入目录卡片必须提供可点击的「加入草稿」");
  addButton.props.onClick();
  await ctx.mounted.settle();

  assert.equal(ctx.mounted.text.indexOf(IMPORT) >= 0, true, "导入目录必须按 path 文本渲染，实际文本：" + ctx.mounted.text.slice(0, 300));
  assert.equal(ctx.mounted.text.indexOf("[object Object]"), -1, "草稿元素是 {path,id,key} 对象，渲染层不得 String(item) 强转");
  assert.equal(ctx.mounted.text.indexOf("已加入草稿") >= 0, true, "加入草稿必须弹成功提示");
  assert.equal(ctx.mounted.text.indexOf("待保存改动") >= 0, true, "加入草稿必须产生待保存改动");

  const removeButton = latestButton(ctx, "移除");
  assert.ok(removeButton && typeof removeButton.props.onClick === "function", "导入目录行必须提供「移除」按钮");
  removeButton.props.onClick();
  await ctx.mounted.settle();

  assert.equal(ctx.mounted.text.indexOf(IMPORT), -1, "移除后该目录不得再出现在面板里");
  assert.equal(ctx.mounted.text.indexOf("已从草稿移除") >= 0, true, "真实移除必须弹成功提示");
  assert.equal(ctx.mounted.text.indexOf("导入目录不在当前草稿里"), -1, "真实移除不得落到「不在当前草稿里」告警分支");
  assert.equal(ctx.mounted.text.indexOf("还没有待导入的目录") >= 0, true, "移除后导入清单必须回到空态");
  assert.equal(ctx.mounted.text.indexOf("没有改动") >= 0, true, "移除必须把草稿清空（保存栏回到「没有改动」）");
  assert.equal(ctx.mounted.text.indexOf("待保存改动"), -1, "移除后不得残留待保存改动");

  // 面板内部 draftStore 不可从外部取得，这里用同一个 L2 构造器复核「对象进快照、按 path 移除」契约。
  // L2 对外暴露的读取器叫 imports()（importsSnapshot 只是内部函数名），所以两个名字都认。
  const store = ctx.hook.L2.create({});
  const readImports = (target) => (typeof target.importsSnapshot === "function" ? target.importsSnapshot() : target.imports());
  assert.equal(store.stageImport(IMPORT), true, "stageImport 必须接受新目录");
  const rows = readImports(store);
  assert.equal(rows.length, 1, "导入快照必须返回 1 条，实际：" + JSON.stringify(rows));
  assert.equal(typeof rows[0], "object", "导入快照的元素必须是 {path,id,key} 对象");
  assert.equal(rows[0].path, IMPORT, "导入快照必须按 path 记录目录");
  assert.equal(store.removeImport(rows[0].path), true, "removeImport 必须对草稿里的目录返回 true");
  assert.equal(readImports(store).length, 0, "removeImport 后导入快照必须归零");
  assert.equal(store.removeImport(IMPORT), false, "重复移除必须返回 false（不能靠返回值猜成功）");

  ctx.mounted.unmount();
});

/* ═══════════════════════════════════════════════════════════════════════
 * S4G-12 · MCP 编辑保存：按回执状态决定是否重置表单
 *
 * 回归的缺陷：保存按钮 onClick 派发 update 之后立刻同步 resetMcpDraft() + setView()，
 * 请求 500 / 网络超时时用户编辑内容直接丢失（表单被关掉、草稿被清空）。
 * ═══════════════════════════════════════════════════════════════════════ */

test("S4G-12 MCP 编辑保存按回执守卫：失败保留表单，applied 才重置", async () => {
  const ctx = await mountPanel({ captureControls: true });

  const editButton = latestButton(ctx, "编辑");
  assert.ok(editButton && typeof editButton.props.onClick === "function", "MCP 服务器行必须提供「编辑」按钮");
  editButton.props.onClick();
  await ctx.mounted.settle();

  assert.equal(ctx.mounted.text.indexOf("编辑 MCP 服务器") >= 0, true, "进入编辑态后表单标题必须是「编辑 MCP 服务器」");
  const commandInput = latestInput(ctx, "命令");
  assert.ok(commandInput && typeof commandInput.props.onChange === "function", "编辑态必须渲染可编辑的「命令」输入框");
  commandInput.props.onChange({ target: { value: "node --template" } });
  await ctx.mounted.settle();

  // ① 服务端 500：保存失败不得重置表单
  ctx.transport.route("/api/dsh-gate/mcp", { status: 500, body: { error: "boom" } });
  const beforeFailed = countPosts(ctx.transport, "/api/dsh-gate/mcp");
  const saveFailed = latestButton(ctx, "保存修改");
  assert.ok(saveFailed && typeof saveFailed.props.onClick === "function", "编辑态必须提供「保存修改」按钮");
  saveFailed.props.onClick();
  const failedSent = await waitFor(() => countPosts(ctx.transport, "/api/dsh-gate/mcp") > beforeFailed);
  assert.equal(failedSent, true, "保存必须发出 POST /api/dsh-gate/mcp，实际请求：" + summarizeCalls(ctx.transport.calls));
  await ctx.mounted.settle();

  const failedCall = ctx.transport.calls.filter((entry) => entry.path === "/api/dsh-gate/mcp" &&
    entry.options && String(entry.options.method || "").toUpperCase() === "POST").pop();
  const failedBody = JSON.parse(failedCall.options.body);
  assert.equal(failedBody.action, "update", "保存必须携带 action=update，实际：" + failedCall.options.body);
  assert.equal(failedBody.name, "fs", "保存必须携带被编辑服务器名 fs");
  assert.equal(failedBody.server && failedBody.server.command, "node --template", "保存必须携带用户改过的 command");

  assert.equal(findTreeButton(ctx.mounted.tree, "保存修改") !== null, true, "保存失败后表单必须保持打开（仍有「保存修改」）");
  assert.equal(ctx.mounted.text.indexOf("编辑 MCP 服务器") >= 0, true, "保存失败后标题必须仍是编辑态");
  const keptCommand = findTreeInput(ctx.mounted.tree, "命令");
  assert.ok(keptCommand !== null, "保存失败后「命令」输入框不得消失");
  assert.equal(keptCommand.value, "node --template", "保存失败后用户编辑内容不得丢失");

  // ② applied 回执：才允许重置草稿并关闭表单
  ctx.transport.route("/api/dsh-gate/mcp", { body: { changed: true, servers: [{ name: "fs", transport: "stdio", enabled: true, state: "external", tools: ["mcp__fs__read"] }] } });
  const beforeApplied = countPosts(ctx.transport, "/api/dsh-gate/mcp");
  const saveApplied = latestButton(ctx, "保存修改");
  assert.ok(saveApplied && typeof saveApplied.props.onClick === "function", "失败后必须仍能再次点「保存修改」");
  saveApplied.props.onClick();
  const appliedSent = await waitFor(() => countPosts(ctx.transport, "/api/dsh-gate/mcp") > beforeApplied);
  assert.equal(appliedSent, true, "第二次保存必须再次发出 POST /api/dsh-gate/mcp");
  await ctx.mounted.settle();

  assert.equal(findTreeButton(ctx.mounted.tree, "保存修改"), null, "applied 后必须退出编辑态（不再有「保存修改」）");
  assert.equal(findTreeInput(ctx.mounted.tree, "命令"), null, "applied 后必须收起表单（「命令」输入框消失）");
  assert.equal(ctx.mounted.text.indexOf("编辑 MCP 服务器"), -1, "applied 后标题不得再是编辑态");
  assert.equal(ctx.mounted.text.indexOf("新增 MCP 服务器") >= 0, true, "applied 后表单标题必须回到新增态");
  assert.equal(ctx.mounted.text.indexOf("展开表单") >= 0, true, "applied 后表单必须收起（显示「展开表单」）");

  ctx.mounted.unmount();
});
