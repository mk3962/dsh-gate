/**
 * 技能接管（0.3.0 工单 14）用例。
 *
 * 覆盖六件事，每件都直接对着「模型真正看到的东西」断言（消息 / 段落 / 工具结果），
 * 不去摸 gate 的内部表：
 *   1) 接管：宿主目录（含 entries=[] 的 replacement）与 /name 正文按 source.kind 摘掉；
 *   2) /name 手势：gate 按自己的技能表重注入正文，off 不注入、同一步不重复；
 *   3) 常驻正文：进系统提示词独立段落、逐字节稳定，且不会被段落档位误摘；
 *   4) 加载：gate_load("skill:x") 返回正文并记账，off / 不存在分别是 denied / unknown；
 *   5) 导入：目录含 SKILL.md 算一个、多子目录各一个、单文件也支持；同名宿主优先并标 shadowed；
 *   6) 档位解析：skill:<name> > skillpack:<provider> > defaults.skillpack；
 *   7) 逃生门：takeover=false 完整退回 0.1.8（不摘目录、gate_load 转发宿主 skill 工具）。
 *
 * 宿主来自共享 seam（test/host.mjs），技能服务用假实现按真实形状返回：
 *   list() → 摘要数组；get(name) → {name, provider, content}；snapshot() → {skills, complete}。
 * 跑法：node --import ./test/stub-loader.mjs test/skills.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGate } from "../lib/gate.js";
import {
  MAX_SKILL_FILE_BYTES,
  parseFrontmatter,
  readSkillFile,
  scanImport,
} from "../lib/skills.js";
import { resolvePolicy, TIER_OFF, TIER_ONDEMAND, TIER_RESIDENT } from "../lib/policy.js";
import { mountSkillGate } from "../lib/prestep.js";
import { mountSectionGate, CATALOG_SECTION } from "../lib/sections.js";
import { registerGateTools } from "../lib/proxy.js";
import { makeHost, makePtcExecutor } from "./host.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gate-skills-"));
let tmpSeq = 0;
const tmpDir = (name) => {
  tmpSeq += 1;
  const dir = path.join(tmpRoot, (name || "d") + "-" + tmpSeq);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const writeFile = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
};

/** 假宿主技能服务：正文与摘要分开，形状照 ctx.skills.list / get（TS:869-885）。 */
function makeSkillService(defs) {
  const items = Object.values(defs);
  return {
    async list() { return items.map(({ content, ...summary }) => ({ ...summary })); },
    async get(name) { const item = defs[name]; return item ? { ...item } : undefined; },
    async snapshot() { return { skills: await this.list(), complete: true }; },
  };
}

const HOST_DEFS = {
  alpha: { name: "alpha", provider: "pkg-a", description: "Alpha 技能。第二句不该出现。", content: "ALPHA BODY\nline 2" },
  beta: { name: "beta", provider: "pkg-b", description: "Beta 技能。", content: "BETA BODY" },
  gamma: { name: "gamma", provider: "pkg-b", description: "Gamma 技能。", content: "GAMMA BODY" },
  offskill: { name: "offskill", provider: "pkg-a", description: "Off 技能。", content: "OFF BODY" },
};

const messageText = (message) => {
  const content = message && message.content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block && typeof block.text === "string" ? block.text : "")).join("");
};

/** 装配一台闸门：host + 假 skills 服务 + 策略 + 技能钩子。 */
function makeRig(input, options) {
  const opts = options || {};
  const host = makeHost({ names: opts.names });
  const service = makeSkillService(opts.defs || HOST_DEFS);
  host.rootCtx.get = (name) => {
    if (name === "skills") return service;
    if (name === "workingDirectory") return { ensure: async () => tmpRoot };
    return undefined;
  };
  const policy = resolvePolicy(input, { logger: host.logger, dshHome: tmpDir("policy") });
  const gate = createGate({ ctx: host.rootCtx, logger: host.logger, policy });
  const disposers = [];
  disposers.push(mountSkillGate({ ctx: host.rootCtx, gate, logger: host.logger, policy }));
  if (opts.sections) disposers.push(mountSectionGate({ ctx: host.rootCtx, gate, logger: host.logger, policy }));
  return {
    host, gate, policy, service,
    async attach() { await gate.attach(host.agent); return host.agent; },
    async dispose() { for (const dispose of disposers) dispose(); await gate.releaseAll(); },
    assemble(assembly) { return host.assemble(assembly, host.agent); },
  };
}

const results = [];
const check = (label, fn) => {
  try { fn(); results.push({ ok: true, label }); }
  catch (error) { results.push({ ok: false, label, error: String((error && error.message) || error) }); }
};
const checkAsync = async (label, fn) => {
  try { await fn(); results.push({ ok: true, label }); }
  catch (error) { results.push({ ok: false, label, error: String((error && error.message) || error) }); }
};

const BASE = {
  version: 3,
  defaults: { capability: 2, section: 1, skillpack: TIER_ONDEMAND },
  capabilities: {
    "skill:alpha": { tier: TIER_RESIDENT },
    "skill:offskill": { tier: TIER_OFF },
  },
};

const catalogMessage = (entries, update) => ({
  role: "user",
  source: { kind: "skill-catalog", form: "catalog", entries, ...(update ? { update: true } : {}) },
});
const invocationMessage = (name, text) => ({
  role: "user",
  source: { kind: "skill-invocation", name, form: "instructions" },
  content: [{ type: "text", text: text || "HOST RENDERED " + name }],
});

// ── 1. 接管：摘目录（含空 replacement）与宿主 /name 正文，再按自己的表重注入 ──
await checkAsync("接管：摘掉所有 skill-catalog（含 entries=[] 的 replacement）与宿主 /name 正文", async () => {
  const rig = makeRig(BASE);
  await rig.attach();
  const decision = {
    kind: "enter",
    messages: [
      { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "帮我用 beta" }] },
      catalogMessage([{ name: "alpha", description: "Alpha 技能。第二句不该出现。" }]),
      catalogMessage([], true),
      invocationMessage("beta"),
    ],
  };
  const out = await rig.host.preStep(decision, rig.host.agent);
  assert.equal(out.messages.filter((m) => m.source && m.source.kind === "skill-catalog").length, 0, "目录消息必须一条不剩");
  const invocations = out.messages.filter((m) => m.source && m.source.kind === "skill-invocation");
  assert.equal(invocations.length, 1, "beta 是按需：应重注入恰好一条正文，实际 " + invocations.length);
  assert.equal(invocations[0].source.gate, "dsh-gate", "重注入的消息要有 gate 标记");
  assert.equal(invocations[0].source.name, "beta");
  assert.ok(messageText(invocations[0]).includes("BETA BODY"), "正文必须是 gate 渲染的宿主正文：" + messageText(invocations[0]));
  assert.equal(messageText(invocations[0]).includes("HOST RENDERED"), false, "宿主原文不能被留下");
  assert.deepEqual(rig.gate.snapshot(rig.host.agent).skills, ["alpha", "beta", "gamma"], "off 不进可见名单");
  await rig.dispose();
});

// ── 2. /name 手势：off 不注入；同一步重复跑不重复注入、id 不变 ──
await checkAsync("/name：命中 off/未知不注入；命中常驻/按需各注入一次，重复跑同一步不叠加", async () => {
  const rig = makeRig(BASE);
  await rig.attach();
  const offDecision = { kind: "enter", messages: [invocationMessage("offskill"), invocationMessage("no-such-skill")] };
  const offOut = await rig.host.preStep(offDecision, rig.host.agent);
  assert.equal(offOut.messages.filter((m) => m.source && m.source.kind === "skill-invocation").length, 0, "off/未知不该注入正文");

  const decision = { kind: "enter", messages: [invocationMessage("alpha"), invocationMessage("beta"), invocationMessage("beta")] };
  const first = await rig.host.preStep(decision, rig.host.agent);
  const firstInv = first.messages.filter((m) => m.source && m.source.kind === "skill-invocation");
  assert.deepEqual(firstInv.map((m) => m.source.name), ["alpha", "beta"], "同名只注入一次，顺序按首次出现");
  assert.ok(messageText(firstInv[0]).includes("ALPHA BODY"));
  // 把上一步的结果原样再跑一次：名字（含我们自己的标记消息）同样能收集到，但不许多出一条。
  const again = await rig.host.preStep(first, rig.host.agent);
  const againInv = again.messages.filter((m) => m.source && m.source.kind === "skill-invocation");
  assert.deepEqual(againInv.map((m) => m.source.name), ["alpha", "beta"]);
  assert.deepEqual(againInv.map((m) => m.id), firstInv.map((m) => m.id), "同一步的正文消息要复用同一条（id 不换，前缀缓存不断）");
  assert.deepEqual(againInv.map(messageText), firstInv.map(messageText));
  await rig.dispose();
});

// ── 3. 常驻正文：独立段落、逐字节稳定、不被段落档位误摘 ──
await checkAsync("常驻技能正文进系统提示词独立段落，两次装配逐字节一致", async () => {
  const rig = makeRig(BASE, { sections: true });
  await rig.attach();
  await rig.host.preStep({ kind: "enter", messages: [] }, rig.host.agent);
  const assembly = { sections: [{ name: "custom", text: "自定义段落" }] };
  const first = await rig.assemble(assembly);
  const second = await rig.assemble(assembly);
  assert.deepEqual(first, second, "同输入两次装配必须逐字节一致");
  const section = first.sections.find((s) => s.name === "gate-skill:alpha");
  assert.ok(section, "常驻技能应有独立段落：" + JSON.stringify(first.sections.map((s) => s.name)));
  assert.equal(section.interpolate, false);
  assert.ok(section.text.startsWith('<skill_content name="alpha">'), "正文要带统一包装：" + section.text.slice(0, 60));
  assert.ok(section.text.includes("ALPHA BODY"));
  // 常驻技能不列进按需目录（正文已经在系统提示词里，再列一遍是重复入口）。
  const catalog = first.sections.find((s) => s.name === CATALOG_SECTION);
  assert.equal(catalog === undefined ? "" : catalog.text.includes("alpha —"), false, "常驻技能不该进 gate-catalog 行");
  assert.equal(rig.gate.snapshot(rig.host.agent).sections.some((row) => row.name === "gate-skill:alpha"), false, "gate 自己的段落不记进 UI 段落清单");
  await rig.dispose();
});

await checkAsync("段落全关（sections.defaultTier=0）时 gate-skill 段仍不被摘", async () => {
  // v3 里段落档位真源是 defaults.section（顶层 sections 是 v2 形状，会被当成老文件迁移）。
  const rig = makeRig({ ...BASE, defaults: { ...BASE.defaults, section: TIER_OFF } }, { sections: true });
  await rig.attach();
  await rig.host.preStep({ kind: "enter", messages: [] }, rig.host.agent);
  const out = await rig.assemble({ sections: [{ name: "custom", text: "自定义段落" }] });
  const names = out.sections.map((s) => s.name);
  assert.equal(names.includes("custom"), false, "普通段落按档位被摘（证明档位真的生效）");
  assert.ok(names.includes("gate-skill:alpha"), "常驻技能正文不能被误摘：" + JSON.stringify(names));
  await rig.dispose();
});

// ── 4. 加载：返回正文并记账；off / 未知分别是 denied / unknown ──
await checkAsync("gate_load：常驻/按需都能取到正文并记账，off 与未知分得清", async () => {
  const rig = makeRig(BASE);
  const agent = await rig.attach();
  const alpha = await rig.gate.loadSkill(agent, "alpha");
  assert.equal(alpha.ok, true, JSON.stringify(alpha));
  assert.ok(alpha.text.includes("ALPHA BODY") && alpha.text.includes('<skill_content name="alpha">'));
  assert.ok(rig.gate.snapshot(agent).loaded.includes("skill:alpha"), "加载后要进 loaded 清单");
  assert.equal((await rig.gate.loadSkill(agent, "beta")).ok, true, "按需技能也能加载");
  assert.equal((await rig.gate.loadSkill(agent, "offskill")).reason, "off", "off 的技能拒载");
  assert.equal((await rig.gate.loadSkill(agent, "nope")).reason, "unknown", "不存在的技能是 unknown");
  await rig.dispose();
});

// ── 4b. skills.off：按名字直接关（优先于能力解析链），目录/加载/快照三处一致 ──
await checkAsync("skills.off：名单里的技能不列目录、拒载、快照不可见，能力视图 tier=0", async () => {
  const rig = makeRig({ ...BASE, skills: { takeover: true, off: ["beta"] } });
  const agent = await rig.attach();
  await rig.gate.refreshSkills(agent);
  assert.equal(rig.gate.snapshot(agent).skills.includes("beta"), false, "快照不能列出被 off 的技能");
  assert.equal((await rig.gate.loadSkill(agent, "beta")).reason, "off", "off 名单里的技能拒载");
  const row = rig.gate.capabilityView(agent).skills.find((item) => item.name === "beta");
  assert.equal(row.tier, TIER_OFF, "能力视图要显示 0 档");
  assert.equal(row.reason, "skills.off", "要能解释是 skills.off 关的");
  assert.ok(!rig.gate.catalogFor(agent).includes("[技能] beta"), "目录不列 off 技能");
  await rig.dispose();
});

// ── 5. 导入：目录/多子目录/单文件三种形态；同名宿主优先并告警 ──
await checkAsync("导入扫描：三种目录形态都能发现；同名宿主优先，导入标 shadowed 并告警", async () => {
  const singleRoot = tmpDir("import-single");
  writeFile(path.join(singleRoot, "SKILL.md"), "---\nname: solo-dir\ndescription: 目录形态\n---\nSOLO BODY");
  const multiRoot = tmpDir("import-multi");
  writeFile(path.join(multiRoot, "one", "SKILL.md"), "---\nname: multi-one\ndescription: 子目录一\n---\nONE BODY");
  writeFile(path.join(multiRoot, "two", "SKILL.md"), "---\nname: beta\ndescription: 与宿主同名\n---\nSHADOWED BODY");
  const fileRoot = tmpDir("import-file");
  writeFile(path.join(fileRoot, "solo.md"), "---\nname: file-skill\ndescription: 单文件形态\n---\nFILE BODY");
  const rig = makeRig({
    ...BASE,
    skills: {
      takeover: true,
      off: [],
      imports: [
        { id: "local", path: singleRoot },
        { id: "multi", path: multiRoot },
        { id: "file", path: fileRoot },
      ],
    },
  });
  const agent = await rig.attach();
  await rig.gate.refreshSkills(agent);
  const rows = rig.gate.capabilityView(agent).skills;
  const byName = (name) => rows.find((row) => row.name === name);
  assert.ok(byName("solo-dir"), "目录含 SKILL.md 算一个技能");
  assert.ok(byName("multi-one"), "多子目录各算一个技能");
  assert.ok(byName("file-skill"), "单文件形态也要支持");
  assert.equal(byName("solo-dir").origin, "import");
  assert.equal(byName("solo-dir").path, path.join(singleRoot, "SKILL.md"));
  const betaRows = rows.filter((row) => row.name === "beta");
  assert.equal(betaRows.length, 2, "同名两条都留在表里（能力视图要能说明被谁遮了）");
  assert.equal(betaRows.filter((row) => row.shadowed).length, 1, "导入的那条标 shadowed");
  assert.ok(rig.host.logs.some((line) => line.includes("宿主优先")), "同名冲突要告警：" + JSON.stringify(rig.host.logs));
  assert.equal(rig.gate.snapshot(agent).skills.includes("beta"), true, "宿主那条仍然可见");
  await rig.dispose();
});

// ── 6. 档位解析优先级：单技能 > 技能包 > defaults ──
await checkAsync("档位优先级：skill:<name> 压过 skillpack:<provider>，都没有才落到 defaults.skillpack", async () => {
  const rig = makeRig({
    version: 3,
    defaults: { capability: 2, section: 1, skillpack: TIER_OFF },
    capabilities: {
      "skillpack:pkg-b": { tier: TIER_ONDEMAND },
      "skill:beta": { tier: TIER_RESIDENT },
    },
  });
  const agent = await rig.attach();
  await rig.gate.refreshSkills(agent);
  const view = rig.gate.capabilityView(agent);
  const rows = new Map(view.skills.map((row) => [row.name, row]));
  assert.equal(rows.get("alpha").tier, TIER_OFF, "pkg-a 没配、defaults=0 ⇒ 关");
  assert.equal(rows.get("beta").tier, TIER_RESIDENT, "skill:beta 最具体 ⇒ 常驻");
  assert.equal(rows.get("gamma").tier, TIER_ONDEMAND, "gamma 落到 skillpack:pkg-b ⇒ 按需");
  assert.equal(rows.get("beta").capabilityEntry, "skill:beta", "命中键要能看出来是单技能条目");
  assert.equal(rows.get("gamma").capabilityEntry, "skillpack:pkg-b");
  await rig.dispose();
});

// ── 6b. PTC 尾部声明：技能正文不进声明块（gate_load 的工具结果已经给过，别再重复） ──
await checkAsync("PTC 尾部声明不含技能正文（同一份正文只出现一次）", async () => {
  const rig = makeRig(BASE);
  const agent = await rig.attach();
  rig.host.setExecutor(agent, makePtcExecutor());
  rig.gate.reapply(agent);
  assert.equal(rig.gate.loadedTextFor(agent), "", "还没加载时声明块为空");
  assert.equal((await rig.gate.loadSkill(agent, "alpha")).ok, true);
  assert.equal(rig.gate.loadedTextFor(agent), "", "加载技能后声明块仍应为空（正文走工具结果）");
  await rig.dispose();
});

// ── 7. 逃生门：takeover=false 完整退回 0.1.8 ──
await checkAsync("takeover=false：不摘宿主目录，gate_load 照旧转发宿主 skill 工具", async () => {
  const rig = makeRig({
    version: 3,
    defaults: { capability: 2, section: 1, skillpack: TIER_RESIDENT },
    skills: { takeover: false },
  });
  const agent = await rig.attach();
  const decision = { kind: "enter", messages: [catalogMessage([{ name: "alpha", description: "Alpha 技能。第二句不该出现。" }])] };
  const out = await rig.host.preStep(decision, agent);
  assert.equal(out.messages.length, decision.messages.length, "常驻档 + 不接管：目录原样透传");
  assert.deepEqual(rig.gate.snapshot(agent).skills, ["alpha"], "名单仍从宿主目录消息里读");
  registerGateTools({ ctx: rig.host.rootCtx, gate: rig.gate, policy: rig.policy });
  const tool = rig.host.tool("gate_load");
  const result = await tool.execute({ names: ["skill:alpha"] }, { agent });
  assert.ok(String(result.skillText).includes("skill ok"), "应转发给宿主 skill 工具：" + result.skillText);
  assert.equal(result.loaded.includes("skill:alpha"), false, "转发路径不改加载清单（0.1.8 行为）");
  await rig.dispose();
});

// ── 8. 复核 P2 批修（2026-11-14）：不完整名单 / 正文变更 / 导入 /name / 健壮性 ──
await checkAsync("P2-6：宿主 snapshot.complete=false 时保留上一份名单，不让技能先消失再回来", async () => {
  const rig = makeRig(BASE);
  const agent = await rig.attach();
  await rig.gate.refreshSkills(agent);
  const before = rig.gate.snapshot(agent).skills.slice();
  assert.deepEqual(before, ["alpha", "beta", "gamma"], "第一次是完整名单");
  // 宿主发现超时：快照变成「只有 alpha」且 complete=false
  rig.service.snapshot = async () => ({ skills: [{ name: "alpha", provider: "pkg-a", description: "Alpha 技能。" }], complete: false });
  await rig.gate.refreshSkills(agent);
  assert.deepEqual(rig.gate.snapshot(agent).skills.slice(), before, "不完整名单不能覆盖 last-good");
  assert.ok(rig.host.logs.some((line) => line.includes("不完整")), "要留一次可读告警：" + JSON.stringify(rig.host.logs));
  // 恢复完整后照常接受新名单
  rig.service.snapshot = async () => ({ skills: [{ name: "alpha", provider: "pkg-a", description: "Alpha 技能。" }], complete: true });
  await rig.gate.refreshSkills(agent);
  assert.deepEqual(rig.gate.snapshot(agent).skills.slice(), ["alpha"], "完整名单照常生效");
  await rig.dispose();
});

await checkAsync("P1-4b：导入技能只改正文（名字/描述不变）也会立刻生效，且 gate_load 与段落同源", async () => {
  const root = tmpDir("body-change");
  const file = path.join(root, "SKILL.md");
  writeFile(file, "---\nname: changing\ndescription: 会改正文\n---\nFIRST BODY");
  const rig = makeRig({
    version: 3,
    defaults: { capability: 2, section: 1, skillpack: TIER_ONDEMAND },
    capabilities: { "skill:changing": { tier: TIER_RESIDENT } },
    skills: { takeover: true, off: [], imports: [{ id: "local", path: root }] },
  }, { sections: true });
  const agent = await rig.attach();
  await rig.host.preStep({ kind: "enter", messages: [] }, agent);
  const first = await rig.assemble({ sections: [] });
  assert.ok(first.sections.find((s) => s.name === "gate-skill:changing").text.includes("FIRST BODY"));
  // 改正文：mtime 变化 → scanImport 重读 → rememberSkills 的签名必须因 hash 不同而变化
  writeFile(file, "---\nname: changing\ndescription: 会改正文\n---\nSECOND BODY");
  await rig.host.preStep({ kind: "enter", messages: [] }, agent);
  const second = await rig.assemble({ sections: [] });
  assert.ok(second.sections.find((s) => s.name === "gate-skill:changing").text.includes("SECOND BODY"),
    "改正文后常驻段落必须跟着变：" + second.sections.find((s) => s.name === "gate-skill:changing").text);
  const loaded = await rig.gate.loadSkill(agent, "changing");
  assert.ok(loaded.text.includes("SECOND BODY"), "gate_load 也要拿到同一份新正文");
  await rig.dispose();
});

await checkAsync("P2-12：用户手打 /导入技能名 也会注入正文（宿主不认识导入技能）", async () => {
  const root = tmpDir("slash-import");
  writeFile(path.join(root, "SKILL.md"), "---\nname: slashy\ndescription: 导入技能\n---\nSLASH BODY");
  const rig = makeRig({
    version: 3,
    defaults: { capability: 2, section: 1, skillpack: TIER_ONDEMAND },
    capabilities: {},
    skills: { takeover: true, off: [], imports: [{ id: "local", path: root }] },
  });
  const agent = await rig.attach();
  await rig.gate.refreshSkills(agent);
  const decision = { kind: "enter", messages: [{ role: "user", content: [{ type: "text", text: "/slashy" }] }] };
  const out = await rig.host.preStep(decision, agent);
  const injected = out.messages.filter((m) => m.source && m.source.kind === "skill-invocation");
  assert.equal(injected.length, 1, "导入技能的 /name 要注入一条正文，实际 " + injected.length);
  assert.equal(injected[0].source.name, "slashy");
  assert.ok(messageText(injected[0]).includes("SLASH BODY"));
  // 正文里只是「提到」/xxx 不算调用（严格整条词法）
  const prose = { kind: "enter", messages: [{ role: "user", content: [{ type: "text", text: "请解释 /slashy 这个命令" }] }] };
  const proseOut = await rig.host.preStep(prose, agent);
  assert.equal(proseOut.messages.filter((m) => m.source && m.source.kind === "skill-invocation").length, 0, "包含式提到不触发注入");
  // off 的技能不注入
  const offRig = makeRig({
    version: 3,
    defaults: { capability: 2, section: 1, skillpack: TIER_ONDEMAND },
    capabilities: { "skill:slashy": { tier: TIER_OFF } },
    skills: { takeover: true, off: [], imports: [{ id: "local", path: root }] },
  });
  const offAgent = await offRig.attach();
  await offRig.gate.refreshSkills(offAgent);
  const offOut = await offRig.host.preStep(decision, offAgent);
  assert.equal(offOut.messages.filter((m) => m.source && m.source.kind === "skill-invocation").length, 0, "off 技能 /name 不注入");
  await rig.dispose();
  await offRig.dispose();
});

check("P2-13：frontmatter 支持 | / > 块标量（不再把 \">\" 当描述）", () => {
  const folded = parseFrontmatter("---\nname: f\ndescription: >\n  第一行\n  第二行\n---\nBODY");
  assert.equal(folded.data.description, "第一行 第二行", "> 折叠成一行");
  const literal = parseFrontmatter("---\nname: l\ndescription: |\n  第一行\n  第二行\n---\nBODY");
  assert.equal(literal.data.description, "第一行\n第二行", "| 保留换行");
  assert.equal(parseFrontmatter("---\nname: q\ndescription: \"引号里: 有冒号\"\n---\nB").data.description, "引号里: 有冒号");
});

check("P2-13：超大技能文件拒读并带 code（不静默截断正文）", () => {
  const dir = tmpDir("too-large");
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, "---\nname: big\n---\n" + "x".repeat(MAX_SKILL_FILE_BYTES + 10), "utf8");
  assert.throws(() => readSkillFile(file), (error) => error.code === "skill-too-large", "应抛 skill-too-large");
  const result = scanImport(dir, {});
  assert.equal(result.skills.length, 0, "超大文件不产出技能");
  assert.ok(result.warnings.some((w) => w.code === "import-unreadable" && w.message.includes("超过")), JSON.stringify(result.warnings));
});

check("P2-13：符号链接子目录里的 SKILL.md 也能扫到", () => {
  const real = tmpDir("real-skill");
  writeFile(path.join(real, "SKILL.md"), "---\nname: linked\ndescription: 链接技能\n---\nLINK BODY");
  const root = tmpDir("link-root");
  let linked = false;
  try {
    fs.symlinkSync(real, path.join(root, "child"), "dir");
    linked = true;
  } catch { /* Windows 无权限时跳过（不算失败） */ }
  if (!linked) { console.log("  skip  符号链接用例（本机不允许建 symlink）"); return; }
  const result = scanImport(root, {});
  assert.deepEqual(result.skills.map((s) => s.name), ["linked"], "symlink 子目录要能发现：" + JSON.stringify(result.warnings));
});

await checkAsync("P2-9：技能在名单里但正文取不到时，gate_load 不报 unknown", async () => {
  const rig = makeRig(BASE);
  const agent = await rig.attach();
  const original = rig.service.get;
  rig.service.get = async () => undefined; // 模拟宿主正文瞬态取不到
  registerGateTools({ ctx: rig.host.rootCtx, gate: rig.gate, policy: rig.policy });
  const tool = rig.host.tool("gate_load");
  const result = await tool.execute({ names: ["skill:beta"] }, { agent });
  assert.equal((result.unknown || []).includes("skill:beta"), false, "不能报「没找到」：" + JSON.stringify(result));
  assert.ok(String(result.skillText).includes("暂时取不到正文"), "要说清是暂时取不到：" + result.skillText);
  rig.service.get = original;
  await rig.dispose();
});

console.log("");
for (const row of results) {
  if (row.ok) console.log("  ok    " + row.label);
  else console.log("  FAIL  " + row.label + "  →  " + row.error);
}
const failed = results.filter((row) => !row.ok).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " passed");
if (failed > 0) process.exitCode = 1;
