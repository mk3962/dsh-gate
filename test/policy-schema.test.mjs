/**
 * 策略字段规格表单源（ADR A-2 / be:D1 / A6–A12）
 *
 * 断言的是「一份真源」这件事本身：
 *   字段表 → POLICY_KEYS（兼容旧形状）→ 空模板 / 归一 / 合并 / 严格校验 / 示例
 * 任何一处手抄第二份键表（或漏同步示例）都会在这里变红。
 *
 * 跑法：node --import ./test/stub-loader.mjs test/policy-schema.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  POLICY_FIELDS,
  POLICY_KEY_NAMES,
  describePolicySchema,
  emptyPolicyTemplate,
  mergePolicyLayer,
  validatePolicyInput,
} from "../lib/policy-schema.js";
import { POLICY_KEYS, DEFAULT_POLICY } from "../lib/policy.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const check = (label, fn) => {
  try { fn(); results.push({ label, ok: true }); }
  catch (error) { results.push({ label, ok: false, error: String((error && error.message) || error) }); }
};

// 0.5.7 基线锁死的 13 个顶层键（顺序 = 落盘顺序 = 模板顺序）。
const EXPECTED_KEYS = [
  "version",
  "enabled",
  "freezePtcToolset",
  "defaults",
  "capabilities",
  "sources",
  "legacy",
  "catalog",
  "protected",
  "narrowPassThrough",
  "skills",
  "mcp",
  "repeatGuard",
];

// ── 1. 字段表是唯一真源 ───────────────────────────────────────────────────────
check("字段表 → POLICY_KEYS → 空模板 / 内省 是同一条链（键集与顺序一致）", () => {
  assert.deepEqual(POLICY_FIELDS.map((field) => field.key), EXPECTED_KEYS, "字段表键序就是落盘键序");
  assert.deepEqual(POLICY_KEY_NAMES, EXPECTED_KEYS, "POLICY_KEY_NAMES 必须直接派生自字段表");
  assert.deepEqual(POLICY_KEYS.map((row) => row.key), EXPECTED_KEYS, "兼容投影 POLICY_KEYS 必须与字段表同序");
  const template = emptyPolicyTemplate();
  assert.deepEqual(Object.keys(template), EXPECTED_KEYS, "空模板键序必须等于字段表键序");
  assert.deepEqual(Object.keys(DEFAULT_POLICY), EXPECTED_KEYS, "DEFAULT_POLICY 也必须同源");
  const described = describePolicySchema();
  assert.deepEqual(described.keys, EXPECTED_KEYS, "describePolicySchema().keys 供 #07/#08 交叉校验");
  assert.equal(described.fields.length, EXPECTED_KEYS.length);
});

check("每个字段都声明了类型语义（kind/type/必填默认值），前端与校验器不必再猜", () => {
  for (const field of POLICY_FIELDS) {
    assert.equal(typeof field.key, "string");
    assert.ok(typeof field.kind === "string" && field.kind.length > 0, field.key + " 缺 kind（合并语义）");
    assert.ok(typeof field.type === "string" && field.type.length > 0, field.key + " 缺 type（严格校验语义）");
    assert.notEqual(field.fallback, undefined, field.key + " 缺默认值（空模板与读取兜底都必须来自这里）");
  }
  // 嵌套对象也要能被内省到：catalog / skills / mcp / repeatGuard / defaults
  const childrenOf = (key) => POLICY_FIELDS.find((field) => field.key === key).children.map((child) => child.key);
  assert.deepEqual(childrenOf("defaults"), ["capability", "section", "skillpack"]);
  assert.deepEqual(childrenOf("catalog"), ["groupByPlugin", "maxDescriptionLength", "skillGroups", "signatureSummary"]);
  assert.deepEqual(childrenOf("skills"), ["takeover", "activationRelay", "activationPromote", "off", "imports"]);
  assert.deepEqual(childrenOf("repeatGuard"), ["enabled", "windowSize", "windowThreshold", "maxRemindersPerEpisode", "exclude", "argumentsPreviewChars"]);
});

check("空模板每次都是新副本（调用方改了模板也污染不到下一次读取）", () => {
  const first = emptyPolicyTemplate();
  first.catalog.maxDescriptionLength = 1;
  first.capabilities["native:read"].tier = 0;
  const second = emptyPolicyTemplate();
  assert.equal(second.catalog.maxDescriptionLength, 64);
  assert.equal(second.capabilities["native:read"].tier, 1);
});

check("gate.example.json 与字段表同源（顶层 / defaults / catalog / skills / mcp / repeatGuard 键集完全一致）", () => {
  const file = path.join(ROOT, "gate.example.json");
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, false, "示例文件不许带 BOM");
  const example = JSON.parse(bytes.toString("utf8"));
  const template = emptyPolicyTemplate();
  assert.deepEqual(Object.keys(example).sort(), Object.keys(template).sort(), "示例顶层键集必须等于空模板键集");
  for (const group of ["defaults", "catalog", "skills", "mcp", "repeatGuard"]) {
    assert.deepEqual(
      Object.keys(example[group]).sort(),
      Object.keys(template[group]).sort(),
      "示例 " + group + " 的子键集必须等于字段表",
    );
  }
  assert.deepEqual(
    Object.keys(example.catalog.signatureSummary).sort(),
    Object.keys(template.catalog.signatureSummary).sort(),
    "signatureSummary 的嵌套子键也必须同源",
  );
});

// ── 2. 严格校验：path / code / message 精确可分支 ─────────────────────────────
check("严格校验：未知键 / 非法类型 / 非法枚举 / 越界数值 立即拒绝，并给出精确路径与原因码", () => {
  const cases = [
    [{ bogusKey: 1 }, "bogusKey", "unknown-key"],
    [{ capabilities: { "mcp:a": { bogusChild: 1 } } }, 'capabilities["mcp:a"].bogusChild', "unknown-key"],
    [{ repeatGuard: { bogusChild: 1 } }, "repeatGuard.bogusChild", "unknown-key"],
    [{ catalog: { groupByPlugin: "yes" } }, "catalog.groupByPlugin", "invalid-type"],
    [{ skills: { takeover: 1 } }, "skills.takeover", "invalid-type"],
    [{ mcp: { servers: { a: { transport: "sse" } } } }, 'mcp.servers["a"].transport', "invalid-enum"],
    [{ capabilities: { "mcp:a": { tier: 9 } } }, 'capabilities["mcp:a"].tier', "invalid-enum"],
    [{ version: 0 }, "version", "out-of-range"],
    [{ catalog: { maxDescriptionLength: 4097 } }, "catalog.maxDescriptionLength", "out-of-range"],
    [{ repeatGuard: { windowSize: 1 } }, "repeatGuard.windowSize", "out-of-range"],
    [{ narrowPassThrough: 1001 }, "narrowPassThrough", "out-of-range"],
  ];
  for (const [input, expectedPath, expectedCode] of cases) {
    const result = validatePolicyInput(input);
    assert.equal(result.ok, false, JSON.stringify(input) + " 必须被拒绝");
    const hit = result.errors.find((row) => row.path === expectedPath);
    assert.ok(hit, "缺少路径 " + expectedPath + " 的错误；实际 " + JSON.stringify(result.errors));
    assert.equal(hit.code, expectedCode, expectedPath + " 的原因码不对");
    assert.ok(typeof hit.message === "string" && hit.message.length > 0, "必须带可读消息");
  }
});

check("严格校验：合法文档通过并返回归一策略；allowExtensions 只给整份替换开口", () => {
  const ok = validatePolicyInput({ version: 3, enabled: false, catalog: { maxDescriptionLength: 40 }, repeatGuard: { enabled: true } });
  assert.equal(ok.ok, true);
  assert.equal(ok.policy.version, 3);
  assert.equal(ok.policy.enabled, false);
  assert.equal(ok.policy.catalog.maxDescriptionLength, 40);
  assert.equal(ok.policy.repeatGuard.enabled, true);
  assert.equal(ok.policy.repeatGuard.windowSize, 20, "未提交的子键取默认值");
  const extended = validatePolicyInput({ version: 3, customKey: 1 }, { allowExtensions: true });
  assert.equal(extended.ok, true, "老文件里的表外扩展键在整份替换时必须能写回");
  assert.equal(extended.policy.customKey, 1);
});

// ── 3. 六类键合并（表驱动） ───────────────────────────────────────────────────
check("标量布尔双向覆盖：true → false 与 false → true 都生效", () => {
  const base = Object.assign(emptyPolicyTemplate(), { enabled: false, freezePtcToolset: false });
  const on = mergePolicyLayer(base, { enabled: true, freezePtcToolset: true });
  assert.equal(on.policy.enabled, true);
  assert.equal(on.policy.freezePtcToolset, true);
  const off = mergePolicyLayer(on.policy, { enabled: false, freezePtcToolset: false });
  assert.equal(off.policy.enabled, false, "P1-2：显式 false 必须压得下 true");
  assert.equal(off.policy.freezePtcToolset, false);
});

check("数值越界不落盘：告警并保持原值（绝不静默夹紧成另一个值）", () => {
  const result = mergePolicyLayer(emptyPolicyTemplate(), {
    narrowPassThrough: 9999,
    catalog: { maxDescriptionLength: 99999 },
    repeatGuard: { windowSize: 1 },
    defaults: { capability: 7 },
  });
  assert.equal(result.policy.narrowPassThrough, 12);
  assert.equal(result.policy.catalog.maxDescriptionLength, 64);
  assert.equal(result.policy.repeatGuard.windowSize, 20);
  assert.equal(result.policy.defaults.capability, 2);
  const codes = result.warnings.map((warning) => warning.code).sort();
  assert.deepEqual(codes, ["invalid-enum", "out-of-range", "out-of-range", "out-of-range"]);
  for (const warning of result.warnings) assert.ok(warning.path, "告警必须带被忽略的字段路径");
});

check("名称集只增不减：protected 提交里缺的名字保留，并产生 protected-subtract-ignored 告警", () => {
  const result = mergePolicyLayer({ protected: ["alpha", "beta"] }, { protected: ["alpha"] });
  assert.deepEqual(result.policy.protected, ["alpha", "beta"]);
  const warning = result.warnings.find((row) => row.code === "protected-subtract-ignored");
  assert.ok(warning, "必须告警，而不是静默忽略");
  assert.ok(warning.message.includes("beta"), "告警里要指名被忽略的名字");
});

check("映射表逐键覆盖、null 精确删除（capabilities / sources / mcp.servers）", () => {
  const base = {
    capabilities: { "mcp:a": { tier: 2, sectionExceptions: { "x:1": 1 } }, "mcp:b": { tier: 1 } },
    sources: { "mcp:a": { tools: ["one", "two"] } },
    mcp: { servers: { a: { transport: "stdio", command: "x" }, b: { transport: "stdio", command: "y" } } },
  };
  const merged = mergePolicyLayer(base, {
    capabilities: { "mcp:a": { tier: 1 }, "mcp:b": null },
    sources: { "mcp:a": null },
    mcp: { servers: { a: { transport: "stdio", command: "x" }, b: null } },
  });
  assert.deepEqual(merged.policy.capabilities["mcp:a"], { tier: 1, sectionExceptions: { "x:1": 1 } }, "同级子键必须保留");
  assert.equal("mcp:b" in merged.policy.capabilities, false, "null 必须表现为键不存在（无墓碑）");
  assert.equal("mcp:a" in merged.policy.sources, false);
  assert.deepEqual(Object.keys(merged.policy.mcp.servers), ["a"]);
  assert.equal(JSON.stringify(merged.policy).includes("null"), false, "落盘结果里不许残留 null 删除标记");
});

check("深对象逐子键合并：只提交 signatureSummary.enabled 不得抹掉 tools", () => {
  const base = emptyPolicyTemplate();
  base.catalog.signatureSummary.tools = ["read", "grep"];
  const merged = mergePolicyLayer(base, { catalog: { signatureSummary: { enabled: false } } });
  assert.equal(merged.policy.catalog.signatureSummary.enabled, false);
  assert.deepEqual(merged.policy.catalog.signatureSummary.tools, ["read", "grep"], "未提交的兄弟子键必须保持不变");
  assert.equal(merged.policy.catalog.groupByPlugin, true);
  assert.deepEqual(merged.changedKeys, ["catalog"]);
});

check("有序表整表替换：skills.off / skills.imports / protected 都不是并集", () => {
  const merged = mergePolicyLayer(
    { skills: { off: ["a", "b"], imports: ["/one"] }, protected: ["keep"] },
    { skills: { off: ["c"], imports: ["/two"] } },
  );
  assert.deepEqual(merged.policy.skills.off, ["c"]);
  assert.deepEqual(merged.policy.skills.imports, [{ path: "/two" }], "imports 归一成 { path } 且整表替换");
  assert.deepEqual(merged.policy.protected, ["keep"], "protected 不在提交里 ⇒ 保持原样");
});

check("合并回执带 changedKeys；无实际变化时为空", () => {
  const noop = mergePolicyLayer(emptyPolicyTemplate(), { version: 3, enabled: true });
  assert.deepEqual(noop.changedKeys, []);
  const changed = mergePolicyLayer(emptyPolicyTemplate(), { enabled: false });
  assert.deepEqual(changed.changedKeys, ["enabled"]);
});

// ── 输出 ─────────────────────────────────────────────────────────────────────
const failed = results.filter((row) => !row.ok);
for (const row of results) console.log((row.ok ? "  ok  " : "  FAIL") + "  " + row.label + (row.ok ? "" : "  →  " + row.error));
console.log(failed.length === 0 ? "\n全部通过 (" + results.length + ")" : "\n" + failed.length + " 项失败 / " + results.length);
process.exitCode = failed.length === 0 ? 0 : 1;
