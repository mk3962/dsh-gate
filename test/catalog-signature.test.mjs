/**
 * 目录签名摘要（0.5.1 票 01）用例。
 *
 * 票面要求：模型写 run_code 程序时，不必先 gate_load 就能从目录里看到高频按需工具的
 * 必填参数，从而一次把 gate_invoke 的 arguments 写对。
 *
 * 这里锁住六条口径（改实现前先读）：
 *  1) 出现 / 不出现：只在「PTC 冻结 + 策略点名 + 有 required」三条同时成立时才有一行。
 *  2) 参数顺序：required 在前、其余按 schema 声明顺序，可选带 ?；单个工具最多 6 个参数。
 *  3) 预算截断：目录增量 ≤ +2k tok ⇒ 7,500 字符；满预算就停，不截半行。
 *  4) 字节稳定：同一策略 + 同一工具集重复渲染逐字节一致；配置里换顺序也一样（按名字排序）。
 *  5) native 不变：无 PTC 冻结时目录与不开摘要时逐字节相同（gate 级也验一遍）。
 *  6) 策略默认：catalog.signatureSummary 默认开 + 空名单（空名单时零输出，不改任何人的字节）。
 *
 * 跑法：node --import ./test/stub-loader.mjs test/catalog-signature.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SIGNATURE_BUDGET_CHARS,
  SIGNATURE_MAX_PARAMS,
  normalizeSignatureSummary,
  renderCatalog,
  renderSignatureLines,
  signatureLineOf,
} from "../lib/catalog.js";
import { createGate } from "../lib/gate.js";
import { mergePolicyFile, resolvePolicy } from "../lib/policy.js";
import { makeHost, makeNativeExecutor, makePtcExecutor } from "./host.mjs";

let passed = 0;
const ok = (label) => { passed += 1; console.log("  ok    " + label); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gate-signature-"));

/** 一个带 parameters 的目录条目（独立渲染用；gate 级走 plan.definitions）。 */
const toolOf = (name, required, optional) => ({
  name,
  parameters: {
    type: "object",
    properties: Object.fromEntries([...required, ...(optional || [])].map((key) => [key, { type: "string" }])),
    required: required.slice(),
  },
});

// ── 1. 出现 / 不出现 ──────────────────────────────────────────────────────────
{
  const plan = {
    frozen: true,
    tools: [toolOf("univer_doc", ["doc"], ["sheet"]), toolOf("web_fetch", ["url"]), toolOf("noop_tool", [])],
  };
  // 配置里 b 在前，渲染必须按名字字典序：univer_doc < web_fetch。
  const catalog = renderCatalog(plan, { signatureSummary: { enabled: true, tools: ["web_fetch", "univer_doc", "noop_tool"] } });
  assert.ok(catalog.includes("[签名]"), "PTC 冻结 + 点名 + 有 required 时必须有签名段：" + catalog);
  assert.ok(catalog.includes("- univer_doc(doc, sheet?)"), "签名行格式：名字(必填, 可选?)：" + catalog);
  assert.ok(catalog.includes("- web_fetch(url)"), catalog);
  assert.ok(catalog.indexOf("- univer_doc") < catalog.indexOf("- web_fetch"), "必须按名字字典序，不按配置书写顺序");
  assert.equal(catalog.includes("noop_tool("), false, "无 required 参数的工具不出签名行");

  // 名单外 / 关闭 / native 三种「不出现」。
  const notListed = renderCatalog(plan, { signatureSummary: { enabled: true, tools: ["web_fetch"] } });
  assert.equal(notListed.includes("univer_doc("), false, "没点名的工具不出摘要");
  const disabled = renderCatalog(plan, { signatureSummary: { enabled: false, tools: ["univer_doc"] } });
  assert.equal(disabled.includes("[签名]"), false, "enabled:false 时整段消失");
  const empty = renderCatalog(plan, { signatureSummary: { enabled: true, tools: [] } });
  assert.equal(empty.includes("[签名]"), false, "空名单 = 零输出（默认配置不改字节）");
  ok("出现/不出现：PTC 冻结 + 点名 + 有 required 才出现；名单外/关闭/空名单都不出现");
}

// ── 2. 参数顺序与个数上限 ─────────────────────────────────────────────────────
{
  // properties 里可选参数写在前面，签名仍必须是「必填在前」。
  const line = signatureLineOf("read", {
    parameters: {
      properties: { limit: { type: "number" }, file_path: { type: "string" }, offset: { type: "number" } },
      required: ["file_path"],
    },
  });
  assert.equal(line, "read(file_path, limit?, offset?)", "必填在前、其余按声明顺序，可选带 ?：" + line);

  // required 在 properties 里没有也要照样给出（宿主的 required 是权威）。
  assert.equal(signatureLineOf("x", { parameters: { properties: {}, required: ["a"] } }), "x(a)");

  // 个数上限：required 5 + 可选 5 ⇒ 只到 6 个。
  const many = signatureLineOf("wide", {
    parameters: {
      properties: Object.fromEntries(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((key) => [key, { type: "string" }])),
      required: ["a", "b", "c", "d", "e"],
    },
  });
  assert.equal(many, "wide(a, b, c, d, e, f?)", "参数上限 " + SIGNATURE_MAX_PARAMS + " 个：" + many);

  assert.equal(signatureLineOf("none", { parameters: { properties: { x: { type: "string" } } } }), "", "无 required ⇒ 空");
  assert.equal(signatureLineOf("nodata", undefined), "", "没有 parameters ⇒ 空");
  ok("参数顺序：required 在前、其余按声明顺序、可选带 ?；上限 " + SIGNATURE_MAX_PARAMS + " 个");
}

// ── 3. 预算截断（≤ 2k tok ≈ 7,500 字符） ─────────────────────────────────────
{
  const tools = [];
  for (let index = 0; index < 300; index += 1) {
    tools.push(toolOf("zz_long_tool_name_" + String(index).padStart(3, "0"), ["alpha01", "alpha02", "alpha03"], ["beta01", "beta02", "beta03"]));
  }
  const options = { signatureSummary: { enabled: true, tools: tools.map((tool) => tool.name) } };
  const lines = renderSignatureLines(tools, Object.assign({ ptcFrozen: true }, options));
  const used = lines.reduce((sum, line) => sum + line.length + 1, 0);
  assert.ok(lines.length > 0, "预算内必须出一些行");
  assert.ok(lines.length < tools.length, "300 个长签名必须被预算截断（实际 " + lines.length + "）");
  assert.ok(used <= SIGNATURE_BUDGET_CHARS, "签名段总长必须 ≤ " + SIGNATURE_BUDGET_CHARS + " 字符（实际 " + used + "）");
  // 「满预算就停」：下一条再加就超了。
  const nextCost = lines.length < tools.length ? renderSignatureLines(tools.slice(lines.length), Object.assign({ ptcFrozen: true }, options)) : [];
  const firstSkipped = nextCost.length > 0 ? nextCost[0].length + 1 : 0;
  assert.ok(used + firstSkipped > SIGNATURE_BUDGET_CHARS, "停下的位置必须是「再加一条就超预算」");
  ok("预算截断：总长 ≤ " + SIGNATURE_BUDGET_CHARS + " 字符，满预算即停（不截半行）");
}

// ── 4. 字节稳定 ───────────────────────────────────────────────────────────────
{
  const tools = [toolOf("beta_tool", ["b"], ["b2"]), toolOf("alpha_tool", ["a"]), toolOf("gamma_tool", ["c"])];
  const first = renderCatalog({ frozen: true, tools }, { signatureSummary: { enabled: true, tools: ["gamma_tool", "beta_tool", "alpha_tool"] } });
  const second = renderCatalog({ frozen: true, tools }, { signatureSummary: { enabled: true, tools: ["beta_tool", "alpha_tool", "gamma_tool"] } });
  assert.equal(first, second, "同一策略 + 同一工具集：配置书写顺序不同也必须逐字节一致");
  assert.equal(first, renderCatalog({ frozen: true, tools }, { signatureSummary: { enabled: true, tools: ["gamma_tool", "beta_tool", "alpha_tool"] } }), "重复渲染逐字节一致");
  ok("字节稳定：重复渲染、配置换序都逐字节相同（按名字字典序，不是频率）");
}

// ── 5. native 不变（渲染层） ─────────────────────────────────────────────────
{
  const tools = [toolOf("univer_doc", ["doc"], ["sheet"]), toolOf("web_fetch", ["url"])];
  const plan = { frozen: false, tools };
  const withConfig = renderCatalog(plan, { signatureSummary: { enabled: true, tools: ["univer_doc", "web_fetch"] } });
  const without = renderCatalog(plan);
  assert.equal(withConfig, without, "native（未冻结）下目录必须与不开摘要逐字节相同");
  assert.equal(withConfig.includes("[签名]"), false, "native 目录里不许出现签名段");
  ok("native 不变：未冻结时目录与不开摘要逐字节相同");
}

// ── 6. 配置归一（布尔简写 / 去重 / 坏值） ────────────────────────────────────
{
  assert.deepEqual(normalizeSignatureSummary(undefined), { enabled: true, tools: [] }, "缺省 = 开 + 空名单");
  assert.deepEqual(normalizeSignatureSummary(true), { enabled: true, tools: [] });
  assert.deepEqual(normalizeSignatureSummary(false), { enabled: false, tools: [] });
  assert.deepEqual(normalizeSignatureSummary({ tools: ["a", " a ", "b", 3] }), { enabled: true, tools: ["a", "b"] }, "去重、去空白、丢非字符串");
  assert.deepEqual(normalizeSignatureSummary("nonsense"), { enabled: true, tools: [] }, "坏值按默认，不让渲染崩");
  ok("配置归一：布尔简写 / 去重 / 坏值退回默认");
}

// ── 7. 策略默认与读入（catalog.signatureSummary） ────────────────────────────
{
  const plain = resolvePolicy({}, { dshHome: tmp() });
  assert.deepEqual(plain.catalog.signatureSummary, { enabled: true, tools: [] }, "默认开 + 空名单（默认不改任何目录字节）");
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "gate.json"), JSON.stringify({
    version: 3,
    catalog: { signatureSummary: { enabled: false, tools: ["univer_doc", "univer_doc", "web_fetch"] } },
  }, null, 2));
  const loaded = resolvePolicy({}, { dshHome: dir });
  assert.deepEqual(loaded.catalog.signatureSummary, { enabled: false, tools: ["univer_doc", "web_fetch"] }, "文件里的键要读进来并归一");
  assert.equal(loaded.catalog.groupByPlugin, true, "同一个 catalog 里的其它键不受影响");

  // 面板的保存只提交 catalog.signatureSummary（合并保存）：catalog 的其它键必须活下来。
  const merged = mergePolicyFile(
    { version: 3, catalog: { groupByPlugin: false, maxDescriptionLength: 32 } },
    { catalog: { signatureSummary: { enabled: true, tools: ["univer_doc"] } } },
  );
  assert.equal(merged.catalog.groupByPlugin, false, "保存签名摘要不能丢掉 groupByPlugin");
  assert.equal(merged.catalog.maxDescriptionLength, 32, "保存签名摘要不能丢掉 maxDescriptionLength");
  assert.deepEqual(merged.catalog.signatureSummary, { enabled: true, tools: ["univer_doc"] }, "提交的 signatureSummary 整条替换");
  ok("策略：catalog.signatureSummary 默认开 + 空名单；文件值读入并归一；合并保存不丢 catalog 的其它键");
}

// ── 8. gate 级：PTC 冻结渲染 / native 逐字节不变 ─────────────────────────────
const registerTools = (host) => {
  host.tools.register({
    name: "univer_doc",
    description: "编辑文档。第二句不该出现。",
    parameters: { type: "object", properties: { doc: { type: "string" }, sheet: { type: "string" } }, required: ["doc"] },
    execute: async () => ({ content: [] }),
  });
  host.tools.register({
    name: "web_fetch",
    description: "抓一个 URL。",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    execute: async () => ({ content: [] }),
  });
};
const rigPolicy = (signatureSummary) => {
  const raw = { defaults: { capability: 2, section: 2, skillpack: 2 } };
  if (signatureSummary !== undefined) raw.catalog = { signatureSummary };
  return resolvePolicy(raw, { dshHome: tmp() });
};
const rigOf = (executor, signatureSummary) => {
  const host = makeHost();
  registerTools(host);
  host.setExecutor(host.agent, executor);
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy: rigPolicy(signatureSummary) });
  return { host, gate, agent: host.agent };
};

let ptcCatalog = "";
{
  const a = rigOf(makePtcExecutor(), { enabled: true, tools: ["web_fetch", "univer_doc"] });
  await a.gate.attach(a.agent);
  ptcCatalog = await a.gate.catalogFor(a.agent);
  assert.ok(ptcCatalog.includes("- univer_doc(doc, sheet?)"), "PTC 冻结下目录要带签名：" + ptcCatalog.split(String.fromCharCode(10)).slice(0, 8).join(" | "));
  assert.ok(ptcCatalog.includes("- web_fetch(url)"), ptcCatalog);
  assert.equal(ptcCatalog.includes("[签名]"), true);
  // 同一策略 + 同一工具集再挂一套：逐字节一致。
  const b = rigOf(makePtcExecutor(), { enabled: true, tools: ["univer_doc", "web_fetch"] });
  await b.gate.attach(b.agent);
  assert.equal(await b.gate.catalogFor(b.agent), ptcCatalog, "同一策略 + 同一工具集重复渲染必须逐字节一致");
  await a.gate.release(a.agent);
  await b.gate.release(b.agent);
  ok("gate 级：PTC 冻结下目录带签名段，且两套同策略渲染逐字节一致");
}

{
  const native = rigOf(makeNativeExecutor(), { enabled: true, tools: ["univer_doc", "web_fetch"] });
  await native.gate.attach(native.agent);
  const nativeCatalog = await native.gate.catalogFor(native.agent);
  const baseline = rigOf(makeNativeExecutor(), undefined);
  await baseline.gate.attach(baseline.agent);
  const baselineCatalog = await baseline.gate.catalogFor(baseline.agent);
  assert.equal(nativeCatalog.includes("[签名]"), false, "native 目录里不许有签名段");
  assert.equal(nativeCatalog, baselineCatalog, "native 目录必须与「不开摘要」逐字节相同");
  assert.notEqual(nativeCatalog, ptcCatalog, "native 与 PTC 的目录本来就不同（不是把两边都冻住）");
  await native.gate.release(native.agent);
  await baseline.gate.release(baseline.agent);
  ok("gate 级：native 不渲染摘要，目录与不开摘要逐字节相同");
}

console.log("\n全部通过 (" + passed + ")");
