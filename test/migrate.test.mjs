/**
 * v2 → v3 迁移用例（0.2.0 工单 04）。
 *
 * 迁移最容易坏在四件事上，本文件逐条盯死：
 *  1) 原文件被改 / 备份重复 —— 迁移是只读的，备份按内容去重；
 *  2) 同能力档位冲突 —— 取最宽松，其余成员写成例外（fail-open，别把工具突然关掉）；
 *  3) 悬空键 —— ws_mcp_call 这类进 legacy.unknownOverrides 只告警，不参与解析；
 *  4) 幂等 —— 同一份 v2 迁两次必须逐字节一致（键序、数组序全定死）。
 *
 * 跑法：node test/migrate.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  POLICY_VERSION,
  isV3Policy,
  migrateV2ToV3,
  normalizeV3Policy,
} from "../lib/migrate.js";
import { resolvePolicy, tierForSection, tierForTool, TIER_OFF, TIER_ONDEMAND, TIER_RESIDENT } from "../lib/policy.js";
import { createGate } from "../lib/gate.js";
import { mountServer } from "../lib/server.js";
import { makeHost } from "./host.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const ok = (label) => { passed += 1; console.log("  ok    " + label); };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "gate-migrate-"));

/** 0.1.8 真实策略的缩小版：同一能力冲突、通配、悬空键、技能轴都在。 */
const V2 = {
  version: 2,
  enabled: true,
  tools: {
    defaultTier: 2,
    overrides: {
      read: 1,
      univer_sheet: 1,
      "univer_*": 0,
      "mcp__*": 0,
      ws_mcp_call: 1,
    },
  },
  sections: { defaultTier: 1, overrides: { "mcp:*": 2 } },
  skills: { tier: 1 },
  catalog: { groupByPlugin: true, maxDescriptionLength: 48 },
  narrowPassThrough: 9,
  protected: ["pwsh"],
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// ── 1. v3 判定 ────────────────────────────────────────────────────────────────
{
  assert.equal(isV3Policy({ version: 3 }), true);
  assert.equal(isV3Policy({ version: 2, tools: {} }), false);
  assert.equal(isV3Policy({ capabilities: {} }), true, "手写文件漏 version 也认（看 v3 独有键）");
  assert.equal(isV3Policy({ capabilities: {} }) && normalizeV3Policy({ capabilities: {} }).policy.version, POLICY_VERSION);
  assert.equal(isV3Policy({ enabled: true }), false, "只有标量键的 config 不算 v3 文件");
  ok("v3 判定：version 优先，漏写 version 时看 v3 独有键");
}

// ── 2. 归并与冲突：取最宽松 + 例外 ────────────────────────────────────────────
{
  const migrated = migrateV2ToV3(V2, {});
  const policy = migrated.policy;
  assert.equal(policy.version, 3);
  // v2 的 skills.tier=1 是「保留宿主目录」；0.3.0 接管后常驻=正文注入，迁移必须降为按需（P0-1）。
  assert.deepEqual(policy.defaults, { capability: 2, section: 1, skillpack: 2 }, "三轴默认分别来自 tools / sections / skills（skills 1 降为 2）");
  assert.equal(migrated.warnings.filter((row) => row.code === "skills-tier-remapped").length, 1, "降档必须留一条告警");
  // univer_*:0 与 univer_sheet:1 同能力冲突 → 能力档取最宽松 1，两条都写成例外保序。
  assert.equal(policy.capabilities["plugin:dsh-univer-office"].tier, TIER_RESIDENT);
  assert.deepEqual(policy.capabilities["plugin:dsh-univer-office"].toolExceptions, { "univer_*": 0, univer_sheet: 1 });
  // mcp__*:0 与 sections 的 mcp:*:2 跨轴冲突 → 能力档 2，工具轴整条写例外。
  assert.equal(policy.capabilities["mcp:*"].tier, TIER_ONDEMAND);
  assert.deepEqual(policy.capabilities["mcp:*"].toolExceptions, { "mcp__*": 0 });
  assert.equal(policy.capabilities["native:read"].tier, TIER_RESIDENT);
  assert.equal(migrated.warnings.filter((row) => row.code === "tier-conflict").length, 2, "两处冲突各一条告警");
  // 解析结果必须复刻 v2 语义：更具体的 univer_sheet 压过 univer_*。
  assert.equal(tierForTool(policy, "univer_sheet"), TIER_RESIDENT);
  assert.equal(tierForTool(policy, "univer_doc"), TIER_OFF, "univer_doc 只命中通配 univer_* → 关闭");
  assert.equal(tierForTool(policy, "mcp__wincu__x"), TIER_OFF, "mcp__* 的例外把 MCP 工具关掉");
  assert.equal(tierForSection(policy, "mcp:wincu"), TIER_ONDEMAND, "sections 的 mcp:*:2 迁成 mcp:* 能力档");
  assert.equal(policy.catalog.maxDescriptionLength, 48, "catalog 原样保留");
  assert.equal(policy.narrowPassThrough, 9, "narrowPassThrough 原样保留");
  assert.deepEqual(policy.protected, ["pwsh"], "protected 原样保留");
  ok("同能力冲突取最宽松、偏离成员写成例外；v2 的「更具体压过通配」在 v3 解析里仍成立");
}

// ── 3. 悬空键进 legacy 并告警 ─────────────────────────────────────────────────
{
  const migrated = migrateV2ToV3(V2, {});
  assert.equal(migrated.policy.capabilities["tool:ws_mcp_call"], undefined, "ws_mcp_call 不产生能力");
  assert.equal(migrated.policy.legacy.unknownOverrides.ws_mcp_call, TIER_RESIDENT, "ws_mcp_call 进 legacy");
  assert.ok(migrated.warnings.some((row) => row.code === "dangling-key" && row.name === "ws_mcp_call"), "悬空键要告警");

  // 退休名优先于当前工具面：ws_mcp_call 已从宿主退休，即使视图里还注册着同名工具，
  // 也不能迁成「永远不生效」的 tool:ws_mcp_call 能力，必须落 legacy + 告警。
  const alive = migrateV2ToV3(V2, { knownNames: new Set(["ws_mcp_call", "read"]) });
  assert.equal(alive.policy.capabilities["tool:ws_mcp_call"], undefined, "退休名不许迁成能力");
  assert.equal(alive.policy.legacy.unknownOverrides.ws_mcp_call, TIER_RESIDENT, "退休名仍进 legacy");
  assert.ok(alive.warnings.some((row) => row.code === "dangling-key" && row.name === "ws_mcp_call"), "退休名仍要告警");
  ok("悬空键 → legacy.unknownOverrides + 告警；退休名优先，当前工具面里有同名注册也不迁能力");
}

// ── 4. 幂等：同输入迁两次逐字节一致 ───────────────────────────────────────────
{
  const a = migrateV2ToV3(V2, {});
  const b = migrateV2ToV3(V2, {});
  assert.equal(JSON.stringify(a.policy, null, 2), JSON.stringify(b.policy, null, 2), "两次迁移必须逐字节一致");
  // 再迁一遍已经规范化的 v3，结果不变（v3 输入走 normalize，不再二次归并）。
  const again = normalizeV3Policy(a.policy).policy;
  assert.equal(JSON.stringify(again, null, 2), JSON.stringify(a.policy, null, 2), "v3 规范化必须是幂等的");
  ok("同一 v2 迁两次逐字节一致；已规范化的 v3 再规范化不变");
}

// ── 5. 读 v2 文件：自动迁移 + 备份一次，原文件不动 ────────────────────────────
{
  const dir = tmpDir();
  const file = path.join(dir, "gate.json");
  const text = JSON.stringify(V2, null, 2);
  fs.writeFileSync(file, text);

  const policy = resolvePolicy({}, { dshHome: dir });
  assert.equal(policy.migrated, true, "读 v2 文件必须标记已迁移");
  assert.equal(policy.version, 3);
  assert.equal(fs.readFileSync(file, "utf8"), text, "迁移只读：原 v2 文件一个字都不能动");
  const backups = fs.readdirSync(dir).filter((name) => name.startsWith("gate.json.v2.bak-"));
  assert.equal(backups.length, 1, "必须留一份 v2 备份，实际 " + JSON.stringify(fs.readdirSync(dir)));
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), text, "备份内容必须与原文件一致");
  assert.ok(fs.readdirSync(dir).every((name) => !name.includes("BOM")), "备份不写 BOM");

  // 第二次启动（同样内容）：不再堆备份，迁移结果稳定。
  const again = resolvePolicy({}, { dshHome: dir });
  assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith("gate.json.v2.bak-")).length, 1, "同内容只留一份备份");
  assert.equal(JSON.stringify(again.capabilities), JSON.stringify(policy.capabilities), "重复迁移结果必须一致");
  ok("读 v2 自动迁移并备份一次；原文件不动、重复启动不堆备份");
}

// ── 5b. 真实 v2 文件里的退休键：备份 + legacy + 告警，一次到位 ────────────────
{
  const dir = tmpDir();
  const file = path.join(dir, "gate.json");
  const text = JSON.stringify(V2, null, 2);
  fs.writeFileSync(file, text);
  const before = fs.readFileSync(file);

  const policy = resolvePolicy({}, { dshHome: dir, knownNames: new Set(["ws_mcp_call", "read"]) });
  assert.equal(policy.migrated, true);
  assert.equal(policy.legacy.unknownOverrides.ws_mcp_call, TIER_RESIDENT, "退休键必须落 legacy，不能静默丢");
  assert.ok(
    policy.warnings.some((row) => row.code === "dangling-key" && row.name === "ws_mcp_call" && row.layer === "file"),
    "必须给出 dangling-key 告警（带文件层标记）",
  );
  assert.equal(policy.capabilities["tool:ws_mcp_call"], undefined, "不许生成死能力");

  // 迁移只读：原文件逐字节不变，备份恰好一份且逐字节相同。
  assert.deepEqual(fs.readFileSync(file), before, "迁移不许改原文件一个字节");
  const backups = fs.readdirSync(dir).filter((name) => name.startsWith("gate.json.v2.bak-"));
  assert.equal(backups.length, 1, "必须恰好留一份备份，实际 " + JSON.stringify(fs.readdirSync(dir)));
  assert.deepEqual(fs.readFileSync(path.join(dir, backups[0])), before, "备份必须与原文件逐字节一致");

  // 幂等：同一份文件再读一次，结果字符串一致且不堆备份。
  const again = resolvePolicy({}, { dshHome: dir, knownNames: new Set(["ws_mcp_call", "read"]) });
  assert.equal(JSON.stringify(again.capabilities), JSON.stringify(policy.capabilities), "重复迁移结果一致");
  assert.equal(JSON.stringify(again.legacy), JSON.stringify(policy.legacy), "legacy 也必须一致");
  assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith("gate.json.v2.bak-")).length, 1, "重复启动不堆备份");
  ok("真实 v2 文件：退休键 → legacy + 告警；原文件逐字节不变、备份恰一份且逐字节相同、二次迁移一致");
}

// ── 6. 首次保存写 v3（旧 UI 提交的 v2 形状也要能升级） ────────────────────────
{
  const dir = tmpDir();
  const file = path.join(dir, "gate.json");
  fs.writeFileSync(file, JSON.stringify(V2, null, 2));

  const host = makeHost({ names: ["read", "write", "univer_sheet", "univer_doc", "mcp__wincu__x"], id: "migrate-agent" });
  const policy = resolvePolicy({ policyFile: file }, { logger: host.logger });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  await gate.attach(host.agent);

  const routes = [];
  const ctx = {
    get() { return undefined; },
    reflect: { get() { return undefined; } },
    inject(_names, callback) { callback({ webServer: { register(route) { routes.push(route); return () => undefined; } } }); },
  };
  mountServer({ ctx, gate, policy, logger: host.logger, config: { policyFile: file } });
  const route = routes.find((row) => row.path === "/api/dsh-gate/policy");
  assert.ok(route, "policy 路由没注册");

  const res = {
    code: 0, body: "",
    writeHead(code) { this.code = code; },
    end(body) { this.body = String(body === undefined ? "" : body); },
  };
  // 0.1.8 的面板保存：读回旧内容后原样拼一份 v2 提交（tools/sections/skills）。
  const body = {
    version: 2,
    enabled: true,
    tools: { defaultTier: 2, overrides: { read: 1, univer_sheet: 1, univer_doc: 0 } },
    sections: { defaultTier: 1, overrides: {} },
    skills: { tier: 2 },
  };
  await route.handler({
    method: "POST",
    url: "/api/dsh-gate/policy",
    headers: { host: "127.0.0.1:51235", "sec-fetch-site": "same-origin", "content-type": "application/json" },
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  }, res);
  assert.equal(res.code, 200, "保存失败: " + res.body);
  assert.equal(JSON.parse(res.body).ok, true, res.body);

  const saved = readJson(file);
  assert.equal(saved.version, 3, "首次保存必须写 v3");
  assert.equal(saved.tools, undefined, "保存后不许再有 v2 的 tools 表");
  assert.equal(saved.sections, undefined, "保存后不许再有 v2 的 sections 表");
  // 0.3.0：v2 的 skills 表被吸收（tier → defaults.skillpack），落盘的是 v3 接管配置的默认值。
  // 这里曾经断言 undefined，语义变更后改为断言「不再是 v2 形状、且带上默认的 takeover/off/imports」。
  assert.deepEqual(saved.skills, { takeover: true, off: [], imports: [] }, "v2 skills 表应迁成 v3 接管配置默认值");
  assert.equal(saved.skills.tier, undefined, "v3 的 skills 里不该再有 tier（只读别名只在运行时）");
  assert.equal(saved.capabilities["native:read"].tier, TIER_RESIDENT, "旧 UI 的 read:1 要翻译成 native:read 能力");
  assert.equal(saved.capabilities["plugin:dsh-univer-office"].tier, TIER_RESIDENT, "旧 UI 的 univer_sheet:1 要翻译成插件能力（最宽松 1）");
  const exceptions = saved.capabilities["plugin:dsh-univer-office"].toolExceptions;
  assert.equal(exceptions.univer_doc, TIER_OFF, "提交里偏离能力档的成员要落成例外");
  assert.equal(exceptions.univer_sheet, TIER_RESIDENT, "提交里更具体的成员也保留");
  assert.equal(exceptions["univer_*"], TIER_OFF, "原文件里既有的通配例外不能被一次保存抹掉");
  assert.equal(saved.legacy.unknownOverrides.ws_mcp_call, TIER_RESIDENT, "原文件里的悬空键要留在 legacy");
  assert.equal(fs.readFileSync(file, "utf8").includes("\r\n"), false, "按字节写，不引入 CRLF");
  await gate.release(host.agent);
  ok("首次保存写 v3：旧 UI 的 v2 提交被翻译成能力 + 例外，原有 legacy 保留");
}

console.log("\n全部通过 (" + passed + ")");
