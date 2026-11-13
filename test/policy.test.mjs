/**
 * 策略键一张表（票 05）+ v3 形状（0.2.0 工单 04）用例。
 *
 * v3 把「工具表 + 段落表」换成「能力 + 例外 + defaults」：本文件盯三件事——
 *  1) POLICY_KEYS 仍是顶层键的唯一真源（加一个键只加一行）；
 *  2) 空模板 / resolvePolicy 的兜底 / 落盘形状同一份值，别再各说一套；
 *  3) 保存时 UI 只提交它认识的部分，其余键（含表外扩展键）必须原样活下来。
 *
 * 跑法：node test/policy.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_POLICY,
  DEFAULT_RESIDENT_NATIVE,
  INTRINSIC_PROTECTED,
  POLICY_KEYS,
  emptyPolicyTemplate,
  mergePolicyFile,
  resolvePolicy,
  tierForTool,
  TIER_OFF,
  TIER_ONDEMAND,
  TIER_RESIDENT,
} from "../lib/policy.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");

let passed = 0;
const ok = (label) => { passed += 1; console.log("  ok    " + label); };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "gate-policy-"));

// ── 1. 表就是全部键 ────────────────────────────────────────────────────────────
{
  const tableKeys = POLICY_KEYS.map((spec) => spec.key);
  assert.deepEqual([...tableKeys].sort(), Object.keys(DEFAULT_POLICY).sort(), "表里的键必须与 DEFAULT_POLICY 完全一致");
  assert.equal(new Set(tableKeys).size, tableKeys.length, "表里不许有重复键");
  // v3 的键集是定稿的：v2 的 tools / sections / skills.tier 不再是独立真源。
  // 0.3.0 起 skills 回到顶层，但装的是接管配置（takeover/off/imports），档位真源仍是 defaults.skillpack；
  // v2 只写 { tier } 的老文件由 isV2SkillsShape 识别后迁移，不会当成 v3 配置。
  // 0.3.0 工单 15：mcp 成为顶层键（MCP 接管声明），键集断言同步加一项。
  assert.deepEqual([...tableKeys].sort(), ["capabilities", "catalog", "defaults", "enabled", "freezePtcToolset", "legacy", "mcp", "narrowPassThrough", "protected", "skills", "sources", "version"]);
  for (const spec of POLICY_KEYS) {
    assert.equal(typeof spec.kind, "string", spec.key + " 缺 kind");
    assert.equal(typeof spec.merge, "string", spec.key + " 缺 merge");
    assert.ok(spec.fallback !== undefined, spec.key + " 缺 fallback");
  }
  // 模板里的常驻只写「基础原生工具」：一个工具一个能力，别把 read/write/pwsh 绑在一起。
  for (const name of DEFAULT_RESIDENT_NATIVE) {
    assert.deepEqual(DEFAULT_POLICY.capabilities["native:" + name], { tier: TIER_RESIDENT }, name + " 的默认能力必须是常驻");
  }
  assert.equal(DEFAULT_POLICY.capabilities["tool:ws_mcp_call"], undefined, "ws_mcp_call 不能再出现在默认能力里");
  ok("POLICY_KEYS 恰好覆盖 DEFAULT_POLICY 的 v3 键集，且每行都有 kind / merge / fallback");
}

// ── 2. 空模板 = 默认策略 ───────────────────────────────────────────────────────
{
  const template = emptyPolicyTemplate();
  assert.deepEqual(template, DEFAULT_POLICY, "emptyPolicyTemplate() 必须与 DEFAULT_POLICY 深度相等");
  assert.deepEqual(Object.keys(template), POLICY_KEYS.map((s) => s.key), "模板键序必须跟表一致");
  assert.equal(template.version, 3, "空模板就是 v3");
  // 空模板每次都是新对象：调方改了它不能污染下一个调用者。
  template.catalog.groupByPlugin = false;
  template.capabilities["mcp:x"] = { tier: 0 };
  assert.equal(DEFAULT_POLICY.catalog.groupByPlugin, true, "改模板不该改到 DEFAULT_POLICY");
  assert.equal(DEFAULT_POLICY.capabilities["mcp:x"], undefined, "改模板不该给 DEFAULT_POLICY 加能力");
  ok("空策略模板与 DEFAULT_POLICY 同值同序，且每次新副本");
}

// ── 3. 读：不写文件时的默认与模板同源 ──────────────────────────────────────────
{
  const resolved = resolvePolicy({}, { dshHome: tmpDir() });
  assert.equal(resolved.version, 3);
  assert.deepEqual(resolved.defaults, DEFAULT_POLICY.defaults, "默认三轴必须来自表");
  assert.deepEqual(resolved.capabilities, DEFAULT_POLICY.capabilities, "默认能力（常驻九件套）必须来自表");
  assert.equal(tierForTool(resolved, "read"), TIER_RESIDENT, "read 默认常驻");
  assert.equal(tierForTool(resolved, "univer_sheet"), TIER_ONDEMAND, "没出现的能力走 defaults（按需）");
  assert.deepEqual(resolved.catalog, DEFAULT_POLICY.catalog, "读出来的 catalog 必须等于表里的默认 catalog");
  assert.equal(resolved.narrowPassThrough, DEFAULT_POLICY.narrowPassThrough, "豁免阈值默认必须来自表");
  assert.equal(resolved.skills.tier, resolved.defaults.skillpack, "skills.tier 只是 defaults.skillpack 的只读别名");
  for (const name of INTRINSIC_PROTECTED) assert.ok(resolved.protectedNames.has(name), name + " 必须内置受保护");
  assert.equal(resolved.tools, undefined, "v3 不再输出 tools 表");
  assert.equal(resolved.sections, undefined, "v3 不再输出 sections 表");
  ok("resolvePolicy 的兜底与空策略模板取自同一份表（defaults / 常驻能力 / catalog / 阈值都不再各说一套）");
}

// ── 4. 读：v3 文件里写什么就是什么（含坏值归一） ───────────────────────────────
{
  const dir = tmpDir();
  const file = path.join(dir, "gate.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 3,
    enabled: true,
    defaults: { capability: 0, section: 2, skillpack: 1 },
    capabilities: {
      "mcp:wincu": { tier: 2, toolExceptions: { "mcp__wincu__read": 1 }, sectionExceptions: { "mcp:wincu": 1 } },
      "native:read": { tier: 0 },
    },
    sources: { "plugin:custom": { tools: ["x_a", "x_*"], sections: ["x-prompt"] } },
    legacy: { unknownOverrides: { ws_mcp_call: 1 } },
    catalog: { groupByPlugin: false, maxDescriptionLength: 32 },
    protected: ["pwsh"],
    narrowPassThrough: 3,
    freezePtcToolset: false,
  }, null, 2));

  const resolved = resolvePolicy({}, { dshHome: dir });
  assert.equal(resolved.defaults.capability, TIER_OFF, "defaults.capability 要生效");
  assert.equal(resolved.defaults.section, TIER_ONDEMAND, "defaults.section 要生效");
  assert.equal(resolved.defaults.skillpack, TIER_RESIDENT, "defaults.skillpack 要生效");
  assert.equal(tierForTool(resolved, "mcp__wincu__read"), TIER_RESIDENT, "能力里的工具例外要生效");
  assert.equal(tierForTool(resolved, "mcp__wincu__write"), TIER_ONDEMAND, "能力档（按需）要生效");
  assert.equal(tierForTool(resolved, "read"), TIER_OFF, "显式能力档要压过 defaults");
  assert.equal(resolved.capabilities["native:read"].tier, TIER_OFF, "能力表要活下来");
  assert.deepEqual(resolved.sources["plugin:custom"], { tools: ["x_*", "x_a"], sections: ["x-prompt"] }, "sources 要生效（成员名排序）");
  assert.equal(resolved.legacy.unknownOverrides.ws_mcp_call, TIER_RESIDENT, "legacy 遗留键要读进来（只展示不解析）");
  assert.equal(resolved.catalog.groupByPlugin, false, "文件里的 catalog 要生效");
  assert.equal(resolved.catalog.maxDescriptionLength, 32, "catalog 的截断长度要生效");
  assert.equal(resolved.narrowPassThrough, 3, "文件里的豁免阈值要生效");
  assert.equal(resolved.freezePtcToolset, false, "PTC 冻结开关（工单 07）必须逐键读进来");
  assert.ok(resolved.protectedNames.has("pwsh"), "protected 里的名字要进受保护集");
  assert.ok(resolved.protectedNames.has("gate_status"), "内置受保护名单不能被文件挤掉");

  // 坏值：非法层数回退默认，绝不静默变 0（0 = 关掉工具）；非法能力条目直接丢弃。
  fs.writeFileSync(file, JSON.stringify({
    version: 3,
    defaults: { capability: "banana" },
    capabilities: { "mcp:bad": "nope", "mcp:ok": { tier: "banana", toolExceptions: { "mcp__ok__x": null } } },
    narrowPassThrough: -1,
    freezePtcToolset: "yes",
  }, null, 2));
  const messy = resolvePolicy({}, { dshHome: dir });
  assert.equal(messy.defaults.capability, DEFAULT_POLICY.defaults.capability, "非法层数必须回退默认层，不能变 0");
  assert.equal(messy.capabilities["mcp:bad"], undefined, "非对象能力条目必须丢弃");
  assert.deepEqual(messy.capabilities["mcp:ok"], {}, "非法例外值必须丢弃，不留下 {tier:undefined}");
  assert.equal(messy.narrowPassThrough, DEFAULT_POLICY.narrowPassThrough, "非法阈值必须回退默认，不能变 0");
  assert.equal(messy.freezePtcToolset, true, "布尔开关的坏值必须回退默认（true），不能静默当成 false");
  ok("读文件时每个顶层键都认 v3 的解释（层数归一、能力条目清洗、protected 只增不减）");
}

// ── 5. 写：UI 只提交它认识的键，其余必须活下来 ─────────────────────────────────
{
  const current = {
    version: 3,
    enabled: true,
    defaults: { capability: 2, section: 1, skillpack: 2 },
    capabilities: { "mcp:a": { tier: 0, toolExceptions: { "mcp__a__x": 1 } } },
    sources: { "plugin:keep": { tools: ["keep_a"] } },
    legacy: { unknownOverrides: { old_tool: 1 } },
    catalog: { groupByPlugin: true, maxDescriptionLength: 64 },
    protected: ["pwsh"],
    narrowPassThrough: 7,
    myOwnKey: "keep",
  };
  const merged = mergePolicyFile(current, {
    enabled: true,
    defaults: { capability: 1 },
    capabilities: { "mcp:b": { tier: 2, sectionExceptions: { "mcp:b": 1 } } },
  });
  assert.equal(merged.defaults.capability, 1, "UI 提交的 defaults 要写进去");
  assert.equal(merged.defaults.section, 1, "没提交的 defaults 轴必须保留");
  assert.deepEqual(merged.capabilities["mcp:a"], current.capabilities["mcp:a"], "UI 没渲染的能力不能被抹掉");
  assert.equal(merged.capabilities["mcp:b"].tier, 2, "提交的新能力要写进去");
  assert.deepEqual(merged.sources, current.sources, "sources 必须原样存活");
  assert.equal(merged.legacy.unknownOverrides.old_tool, 1, "legacy 必须原样存活");
  assert.deepEqual(merged.catalog, current.catalog, "catalog 必须原样存活（真事故：保存一次就没了）");
  assert.deepEqual(merged.protected, ["pwsh"], "protected 必须原样存活");
  assert.equal(merged.narrowPassThrough, 7, "豁免阈值必须原样存活");
  assert.equal(merged.myOwnKey, "keep", "表外扩展键必须原样存活");
  // 能力条目逐字段合并：只改 tier 不动例外。
  const partial = mergePolicyFile(current, { capabilities: { "mcp:a": { tier: 2 } } });
  assert.equal(partial.capabilities["mcp:a"].tier, 2);
  assert.deepEqual(partial.capabilities["mcp:a"].toolExceptions, { "mcp__a__x": 1 }, "只提交 tier 时例外必须保留");
  ok("保存时只覆盖提交了的键：能力逐字段合并，catalog / protected / 豁免阈值 / 表外键全部存活");
}

// ── 6. 写：表里每个键都能往返 ──────────────────────────────────────────────────
{
  /** 造一个「与默认值不同」的提交值（拿 fallback 当提交值等于恒真，测不出合并规则写错）。 */
  const mutate = (spec) => {
    switch (spec.kind) {
      case "flag": return !spec.fallback;
      case "number": return spec.fallback + 1;
      case "threshold": return spec.fallback + 1;
      case "defaults": return { capability: 0, section: 0, skillpack: 0 };
      case "capabilities": return { "native:mutated": { tier: 0 } };
      case "sources": return { "plugin:mutated": { tools: ["m_a"], sections: ["m-b"] } };
      case "legacy": return { unknownOverrides: { mutated_tool: 1 } };
      case "object": return Object.assign({}, spec.fallback, { mutatedKey: true });
      case "names": return ["mutated-name"];
      // 0.3.0 新增的 kind：技能接管配置（takeover 覆盖、off/imports 整条替换）。
      case "skills": return { takeover: false, off: ["mutated-skill"], imports: [{ id: "mut", path: "./skills/mut" }] };
      // 0.3.0 工单 15：MCP 声明 —— servers 整表替换（提交了就换，不逐项拼）。
      case "mcp": return { servers: { mutated: { transport: "stdio", command: "npx" } } };
      default: throw new Error("未知 kind: " + spec.kind);
    }
  };

  for (const spec of POLICY_KEYS) {
    const current = emptyPolicyTemplate();
    const value = mutate(spec);
    const merged = mergePolicyFile(current, { [spec.key]: value });
    for (const other of POLICY_KEYS) {
      if (other.key === spec.key) continue;
      assert.deepEqual(merged[other.key], current[other.key], "只提交 " + spec.key + " 时，" + other.key + " 不该变");
    }
    assert.notDeepEqual(merged[spec.key], current[spec.key], spec.key + " 的提交值必须真的写进去");
    if (spec.merge === "replace") {
      assert.deepEqual(merged[spec.key], value, spec.key + " 是 replace，提交值必须原样落地");
    } else {
      for (const [k, v] of Object.entries(value)) {
        assert.deepEqual(merged[spec.key][k], v, spec.key + "." + k + " 必须被提交值覆盖");
      }
      for (const k of Object.keys(current[spec.key])) {
        if (k in value) continue;
        assert.deepEqual(merged[spec.key][k], current[spec.key][k], spec.key + "." + k + " 没提交时必须保留");
      }
    }
  }
  ok("每一个顶层键单独往返都不动其它键，且提交值真的改掉了该键（表加了新键，这条自动覆盖）");
}

// ── 7. 写：类型不合法的输入不许污染文件 ───────────────────────────────────────
{
  const current = { version: 3, enabled: true, defaults: { capability: 2, section: 1, skillpack: 2 }, capabilities: { "mcp:a": { tier: 0 } } };
  const merged = mergePolicyFile(current, {
    enabled: "yes",
    version: "three",
    defaults: "nope",
    capabilities: "nope",
    sources: ["nope"],
    legacy: 3,
    protected: "pwsh",
    narrowPassThrough: 3,
  });
  assert.equal(merged.enabled, true, "enabled 非布尔值不许写进去");
  assert.equal(merged.version, 3, "version 非数字不许写进去");
  assert.deepEqual(merged.defaults, current.defaults, "defaults 非对象不许写进去");
  assert.deepEqual(merged.capabilities, current.capabilities, "capabilities 非对象不许写进去");
  assert.equal(merged.sources, undefined, "sources 非对象不许写进去");
  assert.equal(merged.legacy, undefined, "legacy 非对象不许写进去");
  assert.equal(merged.protected, undefined, "protected 非数组不许写进去");
  assert.equal(merged.narrowPassThrough, 3, "合法阈值要写进去");
  ok("保存路径按表拒绝类型不合法的输入，不会把坏值写进策略文件");
}

// ── 8. 死键与第二份表都不许回来 ────────────────────────────────────────────────
{
  const sources = [
    "lib/policy.js",
    "lib/migrate.js",
    "lib/capabilities.js",
    "lib/gate.js",
    "lib/catalog.js",
    "lib/server.js",
    "lib/index.js",
    "lib/sections.js",
    "lib/prestep.js",
    "lib/proxy.js",
    "lib/restriction.js",
    "client/index.js",
    "gate.example.json",
    "scripts/install.ps1",
  ];
  const haystack = sources.map((rel) => read(rel)).join("\n");

  // maxNameLength / hint 从来没有被任何代码读过：只在配置里占位，改它不会有任何效果。
  assert.ok(!haystack.includes("maxNameLength"), "maxNameLength 是死键（全仓零读取），必须删干净");
  assert.ok(!/\bhint\s*:/.test(haystack), "catalog.hint 是死键（全仓零读取），必须删干净");

  const server = read("lib/server.js");
  assert.ok(!server.includes("emptyPolicyFile"), "server.js 不许再手抄一份空策略模板");
  assert.ok(!/const mergePolicy\s*=/.test(server), "server.js 不许再手抄一份合并白名单");
  assert.ok(server.includes("mergePolicyFile"), "server.js 的保存必须走 policy.js 的表驱动合并");
  assert.ok(server.includes("emptyPolicyTemplate"), "server.js 的兜底模板必须取自 policy.js");
  assert.ok(server.includes("normalizeV3Policy"), "server.js 落盘前必须规范化 v3");

  const policySource = read("lib/policy.js");
  assert.ok(policySource.includes("export const POLICY_KEYS"), "表必须导出，供 UI / 测试 / 文档共用");
  assert.ok(policySource.includes("migrateV2ToV3"), "policy.js 必须走 v2 自动迁移");
  assert.ok(policySource.includes("backupV2PolicyFile"), "policy.js 必须在迁移时备份 v2 文件");
  assert.ok(!policySource.includes("defaultTier"), "policy.js 不许再出现 v2 的 defaultTier");
  const gateSource = read("lib/gate.js");
  assert.equal(gateSource.includes("hasToolOverride"), false, "preset 判据只在 capabilities.js，gate.js 不该再有");
  ok("死键清干净、server.js 不再有第二份键表，保存/兜底/迁移都回到表驱动");
}

// ── 9. 每个键的优先级一致：文件 > 插件行 config > 内置默认 ────────────────────
{
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "gate.json"), JSON.stringify({
    version: 3,
    defaults: { capability: 0, section: 2 },
    capabilities: { "mcp:a": { tier: 2 } },
    catalog: { groupByPlugin: false, maxDescriptionLength: 30 },
    narrowPassThrough: 5,
    freezePtcToolset: false,
  }, null, 2));
  const resolved = resolvePolicy(
    {
      defaults: { capability: 1, section: 1, skillpack: 1 },
      capabilities: { "mcp:a": { tier: 0 } },
      catalog: { groupByPlugin: true, maxDescriptionLength: 90 },
      narrowPassThrough: 9,
      freezePtcToolset: true,
    },
    { dshHome: dir },
  );
  assert.equal(resolved.defaults.capability, TIER_OFF, "defaults 必须文件优先");
  assert.equal(resolved.defaults.section, TIER_ONDEMAND, "defaults 每个轴都文件优先");
  assert.equal(resolved.defaults.skillpack, TIER_RESIDENT, "文件没写的轴才回落行 config");
  assert.equal(tierForTool(resolved, "mcp__a__x"), TIER_ONDEMAND, "能力档必须文件优先（工具按 mcp__a__* 归到 mcp:a）");
  assert.equal(resolved.catalog.groupByPlugin, false, "catalog 必须文件优先");
  assert.equal(resolved.catalog.maxDescriptionLength, 30, "catalog 的截断长度也必须文件优先");
  assert.equal(resolved.narrowPassThrough, 5, "narrowPassThrough 文件优先");
  assert.equal(resolved.freezePtcToolset, false, "freezePtcToolset 也必须文件优先");
  ok("所有顶层键的优先级一致：文件 > 插件行 config > 内置默认");
}

console.log("\n全部通过 (" + passed + ")");
