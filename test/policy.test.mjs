/**
 * 策略键一张表（票 05）用例。
 *
 * 以前「策略有哪些顶层键」写在三个地方：resolvePolicy 的七段分支、server.js 保存时的
 * 手工白名单 if 链、以及一份手抄的空策略模板（还跟默认值互相矛盾）。三处一起漂的结果
 * 是：加一个键，UI 点一次「保存」就把它静默抹掉；空模板给出的 catalog 与真实默认不同。
 *
 * 现在唯一真源是 POLICY_KEYS。本文件断言表覆盖全部键、模板与默认一致、每个键在
 * 「UI 只提交它认识的部分」时都能往返存活，并盯死不再出现第二份表。
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
  POLICY_KEYS,
  emptyPolicyTemplate,
  mergePolicyFile,
  resolvePolicy,
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
  for (const spec of POLICY_KEYS) {
    assert.equal(typeof spec.kind, "string", spec.key + " 缺 kind");
    assert.equal(typeof spec.merge, "string", spec.key + " 缺 merge");
    assert.ok(spec.fallback !== undefined, spec.key + " 缺 fallback");
  }
  ok("POLICY_KEYS 恰好覆盖 DEFAULT_POLICY 的每个键，且每行都有 kind / merge / fallback");
}

// ── 2. 空模板 = 默认策略 ───────────────────────────────────────────────────────
{
  const template = emptyPolicyTemplate();
  assert.deepEqual(template, DEFAULT_POLICY, "emptyPolicyTemplate() 必须与 DEFAULT_POLICY 深度相等");
  assert.deepEqual(Object.keys(template), POLICY_KEYS.map((s) => s.key), "模板键序必须跟表一致");
  // 空模板每次都是新对象：调方改了它不能污染下一个调用者。
  template.catalog.groupByPlugin = false;
  assert.equal(DEFAULT_POLICY.catalog.groupByPlugin, true, "改模板不该改到 DEFAULT_POLICY");
  ok("空策略模板与 DEFAULT_POLICY 同值同序，且每次新副本");
}

// ── 3. 读：不写文件时的默认与模板同源 ──────────────────────────────────────────
{
  const resolved = resolvePolicy({}, { dshHome: tmpDir() });
  assert.equal(resolved.tools.defaultTier, TIER_ONDEMAND, "默认工具层是按需");
  assert.equal(resolved.sections.defaultTier, TIER_RESIDENT, "默认段落层是常驻");
  assert.equal(resolved.skills.tier, TIER_ONDEMAND, "默认技能层是按需");
  assert.deepEqual(resolved.catalog, DEFAULT_POLICY.catalog, "读出来的 catalog 必须等于表里的默认 catalog");
  assert.equal(resolved.narrowPassThrough, DEFAULT_POLICY.narrowPassThrough, "豁免阈值默认必须来自表");
  // 老实现里 skills.tier 在这里会和空模板打架（1 对 2）；现在只能是同一个数。
  assert.equal(emptyPolicyTemplate().skills.tier, resolved.skills.tier, "空模板 skills.tier 必须等于 resolvePolicy 的 skill 层");
  ok("resolvePolicy 的兜底与空策略模板取自同一份表（skills.tier / catalog / 阈值都不再各说一套）");
}

// ── 4. 读：文件里写什么就是什么（含坏值归一） ──────────────────────────────────
{
  const dir = tmpDir();
  const file = path.join(dir, "gate.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 2,
    enabled: true,
    tools: { defaultTier: 2, overrides: { read: 0, "mcp__*": 2 } },
    sections: { defaultTier: 1, overrides: { "nope": 0 } },
    skills: { tier: 1 },
    catalog: { groupByPlugin: false, maxDescriptionLength: 32 },
    protected: ["pwsh"],
    narrowPassThrough: 3,
  }, null, 2));

  const resolved = resolvePolicy({}, { dshHome: dir });
  assert.equal(resolved.tools.overrides.read, 0, "文件里的 override 要生效");
  assert.equal(resolved.tools.overrides["mcp__*"], TIER_ONDEMAND, "通配 override 要生效");
  assert.equal(resolved.skills.tier, TIER_RESIDENT, "文件里的技能层要生效");
  assert.equal(resolved.catalog.groupByPlugin, false, "文件里的 catalog 要生效");
  assert.equal(resolved.catalog.maxDescriptionLength, 32, "catalog 的截断长度要生效");
  assert.equal(resolved.narrowPassThrough, 3, "文件里的豁免阈值要生效");
  assert.ok(resolved.protectedNames.has("pwsh"), "protected 里的名字要进受保护集");
  assert.ok(resolved.protectedNames.has("gate_status"), "内置受保护名单不能被文件挤掉");

  // 坏值：非法层数回退默认，绝不静默变 0（0 = 关掉工具）。
  fs.writeFileSync(file, JSON.stringify({ skills: { tier: "banana" }, narrowPassThrough: -1 }, null, 2));
  const messy = resolvePolicy({}, { dshHome: dir });
  assert.equal(messy.skills.tier, DEFAULT_POLICY.skills.tier, "非法层数必须回退默认层，不能变 0");
  assert.equal(messy.narrowPassThrough, DEFAULT_POLICY.narrowPassThrough, "非法阈值必须回退默认，不能变 0");
  ok("读文件时每个顶层键都认表里的解释（层数归一、阈值归一、protected 只增不减）");
}

// ── 5. 写：UI 只提交它认识的键，其余必须活下来 ─────────────────────────────────
{
  const current = {
    version: 2,
    enabled: true,
    tools: { defaultTier: 2, overrides: { read: 1, "mcp__*": 2 } },
    sections: { defaultTier: 1, overrides: { "keep-me": 0 } },
    skills: { tier: 2 },
    catalog: { groupByPlugin: true, maxDescriptionLength: 64 },
    protected: ["pwsh"],
    narrowPassThrough: 7,
    // 表外的扩展键：用户手写的，不该因为点一次保存就消失。
    myOwnKey: "keep",
  };
  // UI 的保存只带五个它渲染得出来的键。
  const merged = mergePolicyFile(current, {
    version: 2,
    enabled: true,
    tools: { defaultTier: 1, overrides: { read: 1 } },
    sections: { defaultTier: 1, overrides: {} },
    skills: { tier: 1 },
  });
  assert.equal(merged.tools.defaultTier, 1, "UI 提交的键要写进去");
  assert.equal(merged.tools.overrides["mcp__*"], 2, "UI 没渲染的 override 不能被抹掉");
  assert.equal(merged.sections.overrides["keep-me"], 0, "UI 没渲染的段落 override 也不能被抹掉");
  assert.deepEqual(merged.catalog, current.catalog, "catalog 必须原样存活（真事故：保存一次就没了）");
  assert.deepEqual(merged.protected, ["pwsh"], "protected 必须原样存活");
  assert.equal(merged.narrowPassThrough, 7, "0.1.7 的豁免阈值必须原样存活");
  assert.equal(merged.myOwnKey, "keep", "表外扩展键必须原样存活");
  ok("保存时只覆盖 UI 认识的那几个键：catalog / protected / 豁免阈值 / 表外键全部存活");
}

// ── 6. 写：表里每个键都能往返 ──────────────────────────────────────────────────
{
  /**
   * 造一个「与默认值不同」的提交值。
   * 用 spec.fallback 当提交值是恒真的：提交值恰好等于现值，任何合并规则写错都测不出来。
   */
  const mutate = (spec) => {
    switch (spec.kind) {
      case "flag": return !spec.fallback;
      case "number":
      case "threshold": return spec.fallback + 1;
      case "tier": return { tier: spec.fallback.tier === TIER_OFF ? TIER_ONDEMAND : TIER_OFF };
      case "section": return {
        defaultTier: spec.fallback.defaultTier === TIER_RESIDENT ? TIER_ONDEMAND : TIER_RESIDENT,
        overrides: Object.assign({}, spec.fallback.overrides, { "mutated-pattern": TIER_OFF }),
      };
      case "object": return Object.assign({}, spec.fallback, { mutatedKey: true });
      case "names": return ["mutated-name"];
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
    // 提交值必须真的写进去，且与默认值不同 —— 否则这条用例恒真。
    assert.notDeepEqual(merged[spec.key], current[spec.key], spec.key + " 的提交值必须真的写进去");
    if (spec.merge === "replace") {
      assert.deepEqual(merged[spec.key], value, spec.key + " 是 replace，提交值必须原样落地");
    } else {
      // object：逐键合并，提交的键覆盖、没提交的键保留。
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
  const current = { enabled: true, tools: { defaultTier: 2, overrides: { read: 1 } } };
  const merged = mergePolicyFile(current, { enabled: "yes", tools: "nope", protected: "pwsh", narrowPassThrough: 3 });
  assert.equal(merged.enabled, true, "enabled 非布尔值不许写进去");
  assert.deepEqual(merged.tools, { defaultTier: 2, overrides: { read: 1 } }, "段落非对象不许写进去");
  assert.equal(merged.protected, undefined, "protected 非数组不许写进去");
  assert.equal(merged.narrowPassThrough, 3, "合法阈值要写进去");
  ok("保存路径按表拒绝类型不合法的输入，不会把坏值写进策略文件");
}

// ── 8. 死键与第二份表都不许回来 ────────────────────────────────────────────────
{
  const sources = [
    "lib/policy.js",
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

  const policySource = read("lib/policy.js");
  assert.ok(policySource.includes("export const POLICY_KEYS"), "表必须导出，供 UI / 测试 / 文档共用");
  assert.equal((policySource.match(/defaultTier: TIER_ONDEMAND,\s*\n\s*overrides: \{/g) || []).length, 1, "默认层只该在表里出现一次");
  ok("死键清干净、server.js 不再有第二份键表，保存与兜底都回到 POLICY_KEYS");
}

// ── 9. 每个键的优先级一致：文件 > 插件行 config > 内置默认 ────────────────────
{
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "gate.json"), JSON.stringify({
    catalog: { groupByPlugin: false, maxDescriptionLength: 30 },
    skills: { tier: 0 },
    narrowPassThrough: 5,
  }, null, 2));
  // 插件行 config 与文件对着写，文件必须赢（每个键都一样，不能某个键反着来）。
  const resolved = resolvePolicy(
    { catalog: { groupByPlugin: true, maxDescriptionLength: 90 }, skills: { tier: 2 }, narrowPassThrough: 9 },
    { dshHome: dir },
  );
  assert.equal(resolved.catalog.groupByPlugin, false, "catalog 必须文件优先（旧实现里这个键恰好反着来）");
  assert.equal(resolved.catalog.maxDescriptionLength, 30, "catalog 的截断长度也必须文件优先");
  assert.equal(resolved.skills.tier, TIER_OFF, "skills.tier 文件优先");
  assert.equal(resolved.narrowPassThrough, 5, "narrowPassThrough 文件优先");
  // 文件没写的键才回落到行 config。
  const partial = resolvePolicy({ tools: { defaultTier: 2, overrides: {} }, sections: { defaultTier: 2 } }, { dshHome: tmpDir() });
  assert.equal(partial.sections.defaultTier, 2, "文件不存在时行 config 生效");
  ok("所有顶层键的优先级一致：文件 > 插件行 config > 内置默认（catalog 不再反着来）");
}

console.log("\n全部通过 (" + passed + ")");
