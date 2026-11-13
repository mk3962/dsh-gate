/**
 * 给 UI 用的本地 HTTP 接口。
 *  - GET  /api/dsh-gate/state   → 当前分层快照（UI 列表 + 预算）
 *  - GET  /api/dsh-gate/policy  → 策略文件原文
 *  - POST /api/dsh-gate/policy  → 写回策略并立刻重算（无 BOM，按字节写）
 *
 * 安全模型（2026-10-29 二审修）：
 * 这是插件自己注册在宿主 webServer 上的 **精确路由**，会先于宿主的 SPA/认证处理器命中，
 * 所以必须自己把门。两道：
 *  第一道（主门，2026-10-29 补）：借宿主的 connection 服务
 *    `connection.requestRejection(req)` —— 它内部是 isTrustedApiRequest（Host/Origin/sec-fetch-site 围栏）
 *    + browserAuth（launch token / dsh-auth-<sha256(authority)> 签名 cookie）的完整校验。
 *    本机任意进程（curl、脚本、其它 GUI 页面）没有这个签名 cookie 直接 401 —— 这是 R1 的修法。
 *  第二道（回退，宿主没提供 connection 服务时才走）：自家四道门
 *    ① 只允许回环来源（req.socket.remoteAddress，含 ::ffff:127.0.0.1）
 *    ② Host 头必须是回环名（防 DNS rebinding：rebind 后浏览器把 evil.com 解析到 127.0.0.1，
 *       socket 看着是本机，Host 头却写着 evil.com）
 *    ③ Origin / Sec-Fetch-Site 必须是同源（防跨站 text/plain 简单请求直接改策略）
 *    ④ POST 必须是 application/json（强制预检，简单请求伪造不进来）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePolicy, defaultDshHome, emptyPolicyTemplate, isPlainObject, mergePolicyFile } from "./policy.js";
import { normalizeTier } from "./tiers.js";
import { isV3Policy, migrateV2ToV3, normalizeV3Policy } from "./migrate.js";
import { capabilityState } from "./capabilities.js";
import { normalizeServerConfig } from "./mcp.js";

const MAX_BODY_BYTES = 512 * 1024;
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const writeJson = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
};

const isLoopback = (req) => {
  const address = req.socket && req.socket.remoteAddress;
  if (typeof address !== "string") return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
};

const hostNameOf = (host) => {
  if (typeof host !== "string") return "";
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const cut = trimmed.indexOf("]");
    return cut > 0 ? trimmed.slice(0, cut + 1) : trimmed;
  }
  const colon = trimmed.lastIndexOf(":");
  return colon > 0 ? trimmed.slice(0, colon) : trimmed;
};

export const isTrustedRequest = (req) => {
  if (!isLoopback(req)) return false;
  const headers = req.headers || {};
  const host = headers.host;
  if (typeof host === "string" && host.length > 0 && !LOOPBACK_NAMES.has(hostNameOf(host))) return false;
  const site = headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return false;
  const origin = headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    if (origin === "null") return false;
    let originHost = "";
    try { originHost = new URL(origin).host.toLowerCase(); } catch { return false; }
    if (!LOOPBACK_NAMES.has(hostNameOf(originHost))) return false;
    if (typeof host === "string" && host.length > 0 && originHost !== host.toLowerCase()) return false;
  }
  return true;
};

/**
 * 解析宿主的 connection 服务（dsh-client-connection 提供的 HostConnectionService）。
 * 官方面板走 `ctx.get(name)`，cordis 还提供 `ctx.reflect.get(name, false)` 的非抛错读法；
 * 两条都试，拿不到就退回自家四道门。
 */
export const resolveService = (ctx, name) => {
  try {
    if (ctx !== null && ctx !== undefined && typeof ctx.get === "function") {
      const found = ctx.get(name);
      if (found !== undefined && found !== null) return found;
    }
  } catch { /* 忽略 */ }
  try {
    if (ctx !== null && ctx !== undefined && ctx.reflect && typeof ctx.reflect.get === "function") {
      const found = ctx.reflect.get(name, false);
      if (found !== undefined && found !== null) return found;
    }
  } catch { /* 忽略 */ }
  return undefined;
};

/**
 * 宿主级鉴权：返回 { checked, rejection }。
 * checked=true 表示宿主 connection 服务给过结论（rejection 为 undefined 即放行）。
 * 服务抛错时按 fail-closed 处理（checked=true + 403），避免宿主接口变动时悄悄放行。
 */
export const hostAdmission = (ctx, req) => {
  const connection = resolveService(ctx, "connection");
  if (connection === undefined || typeof connection.requestRejection !== "function") return { checked: false };
  try {
    const rejection = connection.requestRejection(req);
    return { checked: true, rejection: rejection === undefined ? undefined : Number(rejection) };
  } catch {
    return { checked: true, rejection: 403 };
  }
};

const isJsonRequest = (req) => {
  const type = req.headers["content-type"];
  if (typeof type !== "string") return false;
  return type.split(";")[0].trim().toLowerCase() === "application/json";
};

const readJsonBody = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
};

export function mountServer(options) {
  const ctx = options.ctx;
  const gate = options.gate;
  const policy = options.policy;
  const logger = options.logger;
  const rawConfig = isPlainObject(options.config) ? options.config : {};

  /**
   * 取一个“闸门真正挂上了”的 agent 来做快照。
   * 不能只信 ctx.agents.roots()：插件根 ctx 上它可能为空（真事故：状态页全 0，看着像没生效）。
   * 以 gate.listAgents() 为准（那就是实际被限制的 agent，已按最近活过排序），再退回 roots()。
   */
  const currentAgent = (want) => {
    try {
      const rows = gate.listAgents();
      // 明确点名（?agent=session-xxx）优先，用于排查多会话进程。
      const wanted = typeof want === "string" && want.length > 0 ? want : undefined;
      if (wanted !== undefined) {
        const hit = rows.find((row) => row.id === wanted);
        return hit === undefined ? undefined : hit.agent;
      }
      // 不能取「第一个挂上的」——那会把别的会话的分层当成当前会话显示
      // （真事故：/state 报的是 22:05 那个恢复会话，活跃会话的 loaded 永远是 []）。
      if (rows.length > 0) return rows[0].agent;
    } catch { /* 忽略 */ }
    try {
      const roots = ctx.agents?.roots?.() || [];
      return roots[0];
    } catch { return undefined; }
  };

  /**
   * 面板状态 = gate.snapshot() 换两个字段名（own / preset）+ 补一份 UI 默认值。
   * 这里不拼任何计量字段 —— 形状与数字口径只在 gate.snapshot 里定义一次。
   */
  const snapshot = (want) => {
    const agent = currentAgent(want);
    const state = gate.snapshot(agent);
    return Object.assign({}, state, {
      // own 层（agent 自己注册、restrict 管不到的）与 preset 平面，UI 靠它分列/打标。
      own: state.ownNames,
      preset: state.presetNames,
      defaults: defaultsOf(),
    });
  };

  /** 当前工具面（迁移判定“悬空键”用）；gate 的公开面里没有就退回 undefined。 */
  const knownNamesOf = (agent) => {
    try {
      if (typeof gate.knownNames !== "function") return undefined;
      const names = gate.knownNames(agent);
      return names instanceof Set ? names : undefined;
    } catch { return undefined; }
  };

  const currentKnownNames = () => knownNamesOf(currentAgent(undefined));

  /**
   * UI 仍按 0.1.8 的字段名读默认层（client/ 是工单 05 的范围，这里不改它）：
   * 老键由 v3 的 defaults 映射出来，新键额外给出；UI 升级后可以只读新键。
   */
  const defaultsOf = () => ({
    toolsDefaultTier: policy.defaults.capability,
    sectionsDefaultTier: policy.defaults.section,
    skillsTier: policy.defaults.skillpack,
    // v2 的「逐工具覆盖」在 v3 里已由能力 + 例外派生，UI 拿不到一份等价表，给空表最诚实。
    toolOverrides: {},
    sectionOverrides: {},
    capabilityDefaultTier: policy.defaults.capability,
    sectionDefaultTier: policy.defaults.section,
    skillpackDefaultTier: policy.defaults.skillpack,
  });

  /** 策略文件的原始内容（不做迁移，保存路径要拿它跟新提交合并）。 */
  const readPolicyFileRaw = () => {
    const file = policy.policyFile;
    if (typeof file !== "string" || file.length === 0) return emptyPolicyTemplate();
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return isPlainObject(parsed) ? parsed : emptyPolicyTemplate();
    } catch {
      // 文件不存在/坏 JSON：给一份“全默认”模板当可编辑起点（坏文件的日志由 resolvePolicy 侧记）。
      return emptyPolicyTemplate();
    }
  };

  /**
   * GET /policy：读回**v3 形状**。
   * v2 文件在这里做一次只读迁移（不写盘、不备份；备份与首次落盘发生在保存/解析时），
   * UI 拿到的永远是 v3，点一次保存就把文件升到 v3。
   */
  /**
   * 内置空模板的规范化形状（UI 的「恢复默认」要一份可整份替换的 v3 内容）。
   * 与 resolvePolicy 的兜底同一份 POLICY_KEYS 生成，不在 UI 里手抄第二份默认值。
   */
  const builtinTemplate = () => normalizeV3Policy(emptyPolicyTemplate()).policy;

  /** 文件指纹（UI 顶栏的「最后保存时间」）：读不到就给空对象，不让面板因此报错。 */
  const policyFileStamp = () => {
    const file = policy.policyFile;
    if (typeof file !== "string" || file.length === 0) return {};
    try {
      const stat = fs.statSync(file);
      return { mtime: stat.mtimeMs, size: stat.size };
    } catch { return {}; }
  };

  const readPolicyFile = () => {
    const file = policy.policyFile;
    const raw = readPolicyFileRaw();
    const skills = skillsConfigOf(raw);
    const withSkills = (content) => (skills === undefined ? content : Object.assign({}, content, { skills }));
    if (isV3Policy(raw)) {
      return Object.assign({
        file: typeof file === "string" ? file : "",
        content: withSkills(normalizeV3Policy(raw).policy),
        version: 3,
        migrated: false,
        warnings: [],
        template: builtinTemplate(),
      }, policyFileStamp());
    }
    const migrated = migrateV2ToV3(raw, { knownNames: currentKnownNames() });
    return Object.assign({
      file: typeof file === "string" ? file : "",
      content: withSkills(migrated.policy),
      version: 3,
      fromVersion: migrated.fromVersion,
      migrated: true,
      warnings: migrated.warnings,
      template: builtinTemplate(),
    }, policyFileStamp());
  };

  /**
   * 0.1.8 的 UI 提交的是 v2 形状（tools/sections/skills）。在 UI 升到 v3 之前，
   * 把这份 v2 提交翻译成 v3 补丁：defaults 逐轴改写、overrides 按能力归并成 capabilities。
   * 只翻译**提交里出现过的**部分，不会用空表把已有能力抹掉。
   */
  const withV2Compat = (base, body) => {
    const hasV2 = isPlainObject(body.tools) || isPlainObject(body.sections) || isPlainObject(body.skills);
    if (!hasV2) return base;
    const patch = migrateV2ToV3({
      version: 2,
      tools: isPlainObject(body.tools) ? body.tools : undefined,
      sections: isPlainObject(body.sections) ? body.sections : undefined,
      skills: isPlainObject(body.skills) ? body.skills : undefined,
    }, { knownNames: currentKnownNames() });
    return mergePolicyFile(base, {
      defaults: patch.policy.defaults,
      capabilities: patch.policy.capabilities,
      legacy: patch.policy.legacy,
    });
  };

  /* ── 技能接管配置（0.3.0 工单 14）：skills.takeover / off / imports ──────────
   *
   * 0.2.0 基线的 lib/policy.js 还不认识 skills 这个键（工单 14 的 lib/skills.js 才加），
   * 而 U1 的写盘路径必须先能工作、合并后不能丢配置。所以这里自带一份最小的归一/合并，
   * 与工单 14 的 normalizeSkillsConfig 同语义（takeover 布尔、off 去重排序、imports 去重）：
   * 两边都跑一次是幂等的，谁先合都对。
   */

  /** 0.1.8 的 skills 只有 {tier}（只读别名 → defaults.skillpack），不是接管配置。 */
  const isV2SkillsAlias = (value) => isPlainObject(value)
    && value.takeover === undefined && value.off === undefined && value.imports === undefined
    && value.tier !== undefined;

  const normalizeSkillsConfig = (raw) => {
    const input = isPlainObject(raw) ? raw : {};
    const off = [...new Set((Array.isArray(input.off) ? input.off : [])
      .filter((name) => typeof name === "string" && name.trim().length > 0)
      .map((name) => name.trim()))].sort();
    const imports = [];
    const seen = new Set();
    for (const item of Array.isArray(input.imports) ? input.imports : []) {
      const entry = typeof item === "string" ? { path: item } : isPlainObject(item) ? item : undefined;
      if (entry === undefined) continue;
      const rawPath = typeof entry.path === "string" ? entry.path.trim() : "";
      if (rawPath.length === 0) continue;
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      const key = id + "\u0000" + rawPath;
      if (seen.has(key)) continue;
      seen.add(key);
      imports.push(id.length > 0 ? { id, path: rawPath } : { path: rawPath });
    }
    return { takeover: input.takeover !== false, off, imports };
  };

  /** 从一份策略（运行时对象或文件原文）里取接管配置；没有就是 undefined（不凭空造配置）。 */
  const skillsConfigOf = (rawPolicy) => {
    const value = isPlainObject(rawPolicy) ? rawPolicy.skills : undefined;
    if (!isPlainObject(value) || isV2SkillsAlias(value)) return undefined;
    return normalizeSkillsConfig(value);
  };

  /** 当前生效的接管配置：运行时优先（合并后由 resolvePolicy 归一），否则退回文件，再否则「未接管」。 */
  const currentSkillsConfig = () => {
    const runtime = skillsConfigOf(policy);
    if (runtime !== undefined) return runtime;
    const file = skillsConfigOf(readPolicyFileRaw());
    if (file !== undefined) return file;
    return { takeover: false, off: [], imports: [] };
  };

  /** 策略文件所在目录：导入目录的相对路径以它为基准（与工单 14 的 resolveImportPath 同口径）。 */
  const policyBaseDir = () => {
    const file = policy.policyFile;
    return typeof file === "string" && file.length > 0 ? path.dirname(file) : process.cwd();
  };

  const resolveImportPath = (importPath, baseDir) => {
    let text = typeof importPath === "string" ? importPath.trim() : "";
    if (text.length === 0) return undefined;
    if (text === "~") text = os.homedir();
    else if (text.startsWith("~/") || text.startsWith("~\\")) text = path.join(os.homedir(), text.slice(2));
    return path.isAbsolute(text) ? path.normalize(text) : path.normalize(path.join(baseDir, text));
  };

  const hasSkillFile = (dir) => {
    try { return fs.statSync(path.join(dir, "SKILL.md")).isFile(); } catch { return false; }
  };

  /**
   * 导入目录里能不能扫出技能（SKILL.md 目录 / 一层子目录 / 直接放的 *.md）。
   * 与工单 14 的 discoverSkillFiles 同口径，但只回答「有没有」——真正的扫描仍归 lib/skills.js。
   */
  const hasSkillFiles = (target) => {
    let stat;
    try { stat = fs.statSync(target); } catch { return false; }
    if (stat.isFile()) return /\.md$/i.test(target);
    if (!stat.isDirectory()) return false;
    if (hasSkillFile(target)) return true;
    let children = [];
    try { children = fs.readdirSync(target, { withFileTypes: true }); } catch { return false; }
    for (const child of children) {
      if (child.isDirectory() && hasSkillFile(path.join(target, child.name))) return true;
    }
    for (const child of children) if (child.isFile() && /\.md$/i.test(child.name)) return true;
    return false;
  };

  /** 现有策略（v3 形状，v2 文件先只读迁移）+ 它的接管配置。 */
  const readCurrentPolicy = () => {
    const raw = readPolicyFileRaw();
    const current = isV3Policy(raw) ? raw : migrateV2ToV3(raw, { knownNames: currentKnownNames() }).policy;
    return { normalized: normalizeV3Policy(current).policy, skills: skillsConfigOf(current) };
  };

  /**
   * 唯一写入口：无 BOM 按字节落盘 → 重解析策略 → 重算所有 agent → 刷新技能表。
   * 内容与现有文件逐字节相同时跳过写盘（幂等：面板点一下「跟随」不该改文件时间）。
   */
  const persistPolicy = async (final) => {
    const file = policy.policyFile;
    if (typeof file !== "string" || file.length === 0) return { ok: false, message: "策略文件路径未配置（config.policyFile 为空）" };
    const text = JSON.stringify(final, null, 2) + "\n";
    let currentText;
    try { currentText = fs.readFileSync(file, "utf8"); } catch { currentText = undefined; }
    let changed = true;
    if (currentText === text) {
      changed = false;
    } else {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // 按字节写无 BOM UTF-8（红线：BOM 会炸宿主 JSON 解析）。v3 规范化保证键序固定。
        fs.writeFileSync(file, Buffer.from(text, "utf8"));
      } catch (error) {
        return { ok: false, message: "写入失败: " + String((error && error.message) || error) };
      }
    }
    // 重新解析时必须带插件行 config，否则行上自定义的 policyFile/overrides/protected 会被清空。
    const next = resolvePolicy(rawConfig, { logger, dshHome: defaultDshHome(), knownNames: currentKnownNames() });
    Object.assign(policy, next);
    const agents = gate.listAgents();
    for (const row of agents) {
      try { gate.reapply(row.agent); } catch { /* 忽略 */ }
    }
    // 技能表刷新（工单 14 的 pre-step 同一条机制）：导入目录/档位变了要立刻反映到 /state 与 /skills。
    // 0.2.0 基线没有这个公开口，typeof 检查后退回「下一步 pre-step 再刷新」。
    if (typeof gate.refreshSkills === "function") {
      for (const row of agents) {
        try { await gate.refreshSkills(row.agent); } catch { /* 忽略 */ }
      }
    }
    return { ok: true, changed };
  };

  /** 把一份 draft 规范化后落盘；skills 显式给出时补回去（基线 normalize 会丢这个键）。 */
  const persistDraft = async (draft, skills) => {
    const final = normalizeV3Policy(Object.assign({}, draft, { version: 3 })).policy;
    if (skills !== undefined) final.skills = normalizeSkillsConfig(skills);
    return persistPolicy(final);
  };

  const savePolicyFile = async (body) => {
    const file = policy.policyFile;
    if (typeof file !== "string" || file.length === 0) return { ok: false, message: "策略文件路径未配置（config.policyFile 为空）" };
    if (!isPlainObject(body)) return { ok: false, message: "策略必须是 JSON 对象" };
    // 面板的原始 JSON 编辑器与「恢复默认」要能删掉能力/例外，而 mergeCapabilities 只增不减；
    // 因此允许提交方显式带 replace:true 表示「整份替换」（旧面板不传，仍然走安全合并）。
    const replace = body.replace === true;
    const submitted = Object.assign({}, body);
    delete submitted.replace;
    // 旧文件如果是 v2，先整体迁到 v3 再合并，否则保存一次会把老 overrides 整张丢掉。
    const rawCurrent = readPolicyFileRaw();
    const current = isV3Policy(rawCurrent) ? rawCurrent : migrateV2ToV3(rawCurrent, { knownNames: currentKnownNames() }).policy;
    let merged;
    if (replace) {
      // 提交的是 v2 形状时先翻译；v3 形状原样作为整份文件（normalize 会补默认键）。
      merged = isV3Policy(submitted) ? submitted : migrateV2ToV3(submitted, { knownNames: currentKnownNames() }).policy;
    } else {
      merged = mergePolicyFile(current, submitted);
      merged = withV2Compat(merged, submitted);
    }
    merged.version = 3;
    // 技能接管配置不是 0.2.0 基线认识的键：提交里带了就按提交的算，
    // 没带（整份替换 / 老 UI）就沿用现有文件里的那份 —— 否则一次能力保存会静默清空导入目录。
    const skills = skillsConfigOf(merged) !== undefined ? skillsConfigOf(merged) : skillsConfigOf(rawCurrent);
    const written = await persistDraft(merged, skills);
    return written.ok ? Object.assign({}, written, { state: snapshot() }) : written;
  };

  /* ── GET/POST /api/dsh-gate/skills（工单 16 的服务端面）──────────────────── */

  const TIER_OK = (value) => {
    const number = Number(value);
    return number === 0 || number === 1 || number === 2 ? number : undefined;
  };

  /** 技能表 = 能力视图的 skills（含 shadowed）+ 快照 skillEntries（补描述/来源/路径）。 */
  const skillsPayload = (want) => {
    const agent = currentAgent(want);
    const state = gate.snapshot(agent);
    let view = {};
    if (agent !== undefined && agent !== null && typeof gate.capabilityView === "function") {
      try { view = gate.capabilityView(agent) || {}; } catch { view = {}; }
    }
    const rows = new Map();
    const ensure = (name) => {
      if (!rows.has(name)) {
        rows.set(name, {
          name,
          provider: undefined,
          origin: "host",
          path: undefined,
          description: "",
          tier: undefined,
          shadowed: false,
          capability: undefined,
        });
      }
      return rows.get(name);
    };
    for (const item of Array.isArray(view.skills) ? view.skills : []) {
      if (!item || typeof item.name !== "string" || item.name.length === 0) continue;
      const row = ensure(item.name);
      if (typeof item.provider === "string" && item.provider.length > 0) row.provider = item.provider;
      if (item.origin === "import" || item.origin === "host") row.origin = item.origin;
      if (typeof item.path === "string" && item.path.length > 0) row.path = item.path;
      const tier = TIER_OK(item.tier);
      if (tier !== undefined) row.tier = tier;
      row.shadowed = item.shadowed === true;
      if (typeof item.capability === "string" && item.capability.length > 0) row.capability = item.capability;
    }
    for (const item of Array.isArray(state.skillEntries) ? state.skillEntries : []) {
      if (!item || typeof item.name !== "string" || item.name.length === 0) continue;
      const row = ensure(item.name);
      if (typeof item.provider === "string" && item.provider.length > 0) row.provider = item.provider;
      if (item.origin === "import" || item.origin === "host") row.origin = item.origin;
      if (typeof item.path === "string" && item.path.length > 0) row.path = item.path;
      if (typeof item.description === "string" && item.description.length > 0) row.description = item.description;
      if (item.shadowed === true) row.shadowed = true;
    }
    // 更老的宿主只有名字清单：仍然列出来（档位走 defaults.skillpack）。
    for (const name of Array.isArray(state.skills) ? state.skills : []) {
      if (typeof name === "string" && name.length > 0) ensure(name);
    }
    const defaults = isPlainObject(view.defaults) ? view.defaults : {};
    const fallbackTier = TIER_OK(defaults.skillpack)
      ?? TIER_OK(policy.defaults && policy.defaults.skillpack)
      ?? 2;
    const skills = [...rows.values()].map((row) => {
      const provider = typeof row.provider === "string" && row.provider.length > 0 ? row.provider : undefined;
      return Object.assign({}, row, {
        provider,
        origin: row.origin === "import" ? "import" : "host",
        tier: row.tier === undefined ? fallbackTier : row.tier,
        capability: row.capability || (provider === undefined ? "skillpack:unknown" : "skillpack:" + provider),
      });
    });
    skills.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    const config = currentSkillsConfig();
    const baseDir = policyBaseDir();
    const imports = config.imports.map((item) => {
      const resolved = resolveImportPath(item.path, baseDir);
      return Object.assign({}, item, {
        exists: resolved !== undefined && fs.existsSync(resolved),
        hasSkills: resolved !== undefined && hasSkillFiles(resolved),
      });
    });
    return {
      agent: state.agent,
      skills,
      imports,
      off: config.off,
      takeover: config.takeover,
      defaults: { skillpack: fallbackTier },
      // 与 /capabilities 的 skills 明细同口径：UI 用它解释「为什么这条不可用」。
      warnings: Array.isArray(state.warnings) ? state.warnings : [],
    };
  };

  /** 单技能条目的继承档（skillpack:<provider> 组条目 → defaults.skillpack），不含 skill:<name> 本身。 */
  const inheritedSkillTier = (normalized, skill) => {
    const capabilities = isPlainObject(normalized.capabilities) ? normalized.capabilities : {};
    const groupId = skill && typeof skill.capability === "string" && skill.capability.length > 0 ? skill.capability : "skillpack:unknown";
    const group = isPlainObject(capabilities[groupId]) ? capabilities[groupId] : undefined;
    const tier = group === undefined ? undefined : TIER_OK(group.tier);
    if (tier !== undefined) return tier;
    const defaults = isPlainObject(normalized.defaults) ? normalized.defaults : {};
    return TIER_OK(defaults.skillpack) ?? 2;
  };

  const badRequest = (message) => ({ status: 400, body: { ok: false, message } });

  /**
   * 技能配置的动作面。四种动作都落同一个 gate.json（无 BOM），写完立刻重算并刷新技能表。
   *  - tier      {name, tier}      写/删单技能能力条目 capabilities["skill:<name>"]
   *  - off       {off: string[]}   替换 skills.off（0.1.8 口径的关闭清单）
   *  - imports   {imports: []}     替换 skills.imports（校验目录存在；扫不出技能只告警不拦）
   *  - takeover  {value: boolean}  接管总开关
   */
  const skillsAction = async (body) => {
    if (policy.enabled === false) {
      return { status: 409, body: { ok: false, message: "闸门已禁用（enabled=false）：先启用闸门再改技能配置" } };
    }
    if (!isPlainObject(body)) return badRequest("请求体必须是 JSON 对象");
    const action = typeof body.action === "string" ? body.action.trim() : "";
    if (action === "tier") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length === 0 || name.length > 200) return badRequest("name 必须是非空技能名");
      const tier = TIER_OK(body.tier);
      if (tier === undefined) return badRequest("tier 必须是 0（关闭）/ 1（常驻）/ 2（按需）");
      const current = readCurrentPolicy();
      const row = skillsPayload(undefined).skills.find((item) => item.name === name);
      const inherited = inheritedSkillTier(current.normalized, row);
      const draft = Object.assign({}, current.normalized, {
        capabilities: Object.assign({}, isPlainObject(current.normalized.capabilities) ? current.normalized.capabilities : {}),
      });
      const id = "skill:" + name;
      if (tier === inherited) {
        // 与继承档一致 = 不写单技能条目（「跟随来源组」），已有条目顺手删掉。
        delete draft.capabilities[id];
      } else {
        draft.capabilities[id] = Object.assign({}, isPlainObject(draft.capabilities[id]) ? draft.capabilities[id] : {}, { tier });
      }
      const written = await persistDraft(draft, current.skills);
      if (!written.ok) return { status: 500, body: written };
      return { status: 200, body: Object.assign({ ok: true }, written, { state: snapshot(), skills: skillsPayload(undefined) }) };
    }
    if (action === "off") {
      if (!Array.isArray(body.off)) return badRequest("off 必须是技能名字符串数组");
      for (const name of body.off) {
        if (typeof name !== "string") return badRequest("off 里每一项都必须是字符串");
      }
      const current = currentSkillsConfig();
      const written = await writeSkillsConfig(Object.assign({}, current, { off: body.off }));
      if (!written.ok) return { status: 500, body: written };
      return { status: 200, body: Object.assign({ ok: true }, written, { state: snapshot(), skills: skillsPayload(undefined) }) };
    }
    if (action === "imports") {
      if (!Array.isArray(body.imports)) return badRequest("imports 必须是数组（路径字符串或 {id?, path}）");
      const baseDir = policyBaseDir();
      const missing = [];
      const empty = [];
      const imports = [];
      for (const item of body.imports) {
        const entry = typeof item === "string" ? { path: item } : isPlainObject(item) ? item : undefined;
        if (entry === undefined) return badRequest("imports 的每一项必须是路径字符串或 {id?, path}");
        const text = typeof entry.path === "string" ? entry.path.trim() : "";
        if (text.length === 0) return badRequest("imports 里有一项缺少 path");
        const id = typeof entry.id === "string" ? entry.id.trim() : "";
        const resolved = resolveImportPath(text, baseDir);
        if (resolved === undefined || !fs.existsSync(resolved)) missing.push(text);
        else if (!hasSkillFiles(resolved)) empty.push(text);
        imports.push(id.length > 0 ? { id, path: text } : { path: text });
      }
      if (missing.length > 0) {
        return badRequest("导入目录不存在（相对路径以策略文件所在目录为基准）：" + missing.join("、"));
      }
      const current = currentSkillsConfig();
      const written = await writeSkillsConfig(Object.assign({}, current, { imports }));
      if (!written.ok) return { status: 500, body: written };
      return {
        status: 200,
        body: Object.assign({ ok: true }, written, {
          state: snapshot(),
          skills: skillsPayload(undefined),
          // 扫不出技能的目录不拦（用户可能先建目录后放文件），但要把话说清楚。
          warnings: empty.length === 0 ? [] : [{ code: "import-empty", message: "目录里没有 SKILL.md 或 *.md，gate 扫描时不会产出技能：" + empty.join("、") }],
        }),
      };
    }
    if (action === "takeover") {
      if (typeof body.value !== "boolean") return badRequest("value 必须是布尔值（true=gate 接管技能，false=退回宿主）");
      const current = currentSkillsConfig();
      const written = await writeSkillsConfig(Object.assign({}, current, { takeover: body.value }));
      if (!written.ok) return { status: 500, body: written };
      return { status: 200, body: Object.assign({ ok: true }, written, { state: snapshot(), skills: skillsPayload(undefined) }) };
    }
    return badRequest("action 必须是 tier / off / imports / takeover");
  };

  /** 写接管配置：draft 从现有策略出发，只改 skills（其它键原样）。 */
  const writeSkillsConfig = async (next) => {
    const current = readCurrentPolicy();
    const draft = Object.assign({}, current.normalized, { skills: normalizeSkillsConfig(next) });
    return persistDraft(draft, normalizeSkillsConfig(next));
  };

  // ── MCP 接管（0.3.0 工单 15）：声明、自挂、外部只读，全部经 gate.mcpManager ──────────
  /** gate.json 里声明的 server（归一后的形状；没有就是空表）。 */
  const declaredMcpServers = () => {
    const mcp = policy.mcp;
    return isPlainObject(mcp) && isPlainObject(mcp.servers) ? mcp.servers : {};
  };

  /** 展示地址：stdio 用 command，streamable-http 用 url。 */
  const mcpTargetOf = (config) => {
    const source = isPlainObject(config) ? config : {};
    return source.transport === "streamable-http" ? String(source.url || "") : String(source.command || "");
  };

  /** 策略归一丢弃的 MCP 坏条目（resolvePolicy 已写日志，这里回给 UI 一份）。 */
  const mcpWarnings = () => {
    const rows = Array.isArray(policy.warnings) ? policy.warnings : [];
    return rows
      .filter((row) => row && typeof row.code === "string" && row.code.startsWith("invalid-mcp"))
      .map((row) => String(row.message || row.code));
  };

  /**
   * UI/GET 的服务器清单 = 运行时行（owned + external）+ 声明了但没挂上的（state:"stopped"）。
   * 只读：不 mount、不 dispose、不改 gate.json。
   */
  const mcpServers = (agent) => {
    const warnings = mcpWarnings();
    const rows = [];
    try {
      if (gate.mcpManager && typeof gate.mcpManager.list === "function") {
        for (const row of gate.mcpManager.list(agent) || []) rows.push(row);
      }
    } catch (error) {
      warnings.push("读取 MCP 运行时状态失败 — " + String((error && error.message) || error));
    }
    const seen = new Set(rows.map((row) => row && row.name));
    for (const [name, config] of Object.entries(declaredMcpServers())) {
      if (seen.has(name)) continue;
      seen.add(name);
      rows.push({
        name,
        transport: typeof config.transport === "string" ? config.transport : "stdio",
        target: mcpTargetOf(config),
        state: "stopped",
        enabled: config.enabled !== false,
        owned: false,
        toolCount: 0,
      });
    }
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return { servers: rows, warnings };
  };

  /** 提交里带的是 server 声明（add/update）还是纯动作参数。 */
  const mcpConfigOf = (body) => (isPlainObject(body.server) ? body.server : body.config);

  const handleMcpPost = async (req, res) => {
    if (!isJsonRequest(req)) return writeJson(res, 415, { ok: false, message: "content-type 必须是 application/json" });
    const body = await readJsonBody(req);
    if (!isPlainObject(body)) return writeJson(res, 400, { ok: false, message: "JSON 解析失败" });
    const action = body.action;
    if (!["add", "update", "remove", "enable", "disable"].includes(action)) {
      return writeJson(res, 400, { ok: false, message: "action 只能是 add / update / remove / enable / disable" });
    }
    if (policy.enabled === false) return writeJson(res, 409, { ok: false, message: "闸门未启用（enabled=false），不接管 MCP" });
    const manager = gate.mcpManager;
    if (!manager) return writeJson(res, 409, { ok: false, message: "MCP 接管不可用（manager 不存在）" });
    const name = body.name;
    if (typeof name !== "string" || name.length === 0) return writeJson(res, 400, { ok: false, message: "name 必须是非空字符串" });

    const servers = Object.assign({}, declaredMcpServers());
    const mounted = new Set();
    try {
      if (typeof manager.list === "function") {
        for (const row of manager.list() || []) if (row && row.owned === true) mounted.add(row.name);
      }
    } catch { /* 读不到就当未挂，下一步 mount 会给出准确冲突 */ }
    const isMounted = mounted.has(name) || (typeof manager.state === "function" && manager.state(name) !== undefined);

    const finish = (extra) => {
      const latest = mcpServers();
      return writeJson(res, 200, Object.assign({ ok: true, action, name, servers: latest.servers, warnings: latest.warnings }, extra));
    };

    if (action === "add" || action === "update") {
      if (action === "add" && (servers[name] !== undefined || isMounted)) {
        return writeJson(res, 409, { ok: false, message: "MCP server \"" + name + "\" 已存在（改用 update）" });
      }
      if (action === "update" && servers[name] === undefined && !isMounted) {
        return writeJson(res, 404, { ok: false, message: "MCP server \"" + name + "\" 不存在" });
      }
      let normalized;
      try {
        normalized = normalizeServerConfig(name, mcpConfigOf(body));
      } catch (error) {
        return writeJson(res, 400, { ok: false, code: error && error.code, message: String((error && error.message) || error) });
      }
      const { name: _ignored, ...stored } = normalized;
      servers[name] = stored;
      const saved = savePolicyFile({ mcp: { servers } });
      if (!saved.ok) return writeJson(res, 500, saved);
      let result;
      try {
        result = action === "update" && isMounted ? await manager.update(name, stored) : await manager.mount(name, stored);
      } catch (error) {
        result = { ok: false, name, reason: "exception", message: String((error && error.message) || error) };
      }
      try { gate.reapplyAll?.(); } catch { /* 忽略 */ }
      return finish({ result });
    }

    if (action === "remove") {
      if (servers[name] === undefined && !isMounted) {
        return writeJson(res, 404, { ok: false, message: "MCP server \"" + name + "\" 不存在" });
      }
      delete servers[name];
      const saved = savePolicyFile({ mcp: { servers } });
      if (!saved.ok) return writeJson(res, 500, saved);
      let result;
      try {
        result = await manager.unmount(name);
        if (!result.ok) result = { ok: true, name, state: "stopped", note: result.reason };
      } catch (error) {
        result = { ok: false, name, reason: "exception", message: String((error && error.message) || error) };
      }
      try { gate.reapplyAll?.(); } catch { /* 忽略 */ }
      return finish({ result });
    }

    // enable / disable
    if (servers[name] === undefined) {
      return writeJson(res, 404, { ok: false, message: "MCP server \"" + name + "\" 未声明（先 add）" });
    }
    const enabled = action === "enable";
    servers[name] = Object.assign({}, servers[name], { enabled });
    const saved = savePolicyFile({ mcp: { servers } });
    if (!saved.ok) return writeJson(res, 500, saved);
    let result;
    try {
      if (enabled) {
        result = isMounted
          ? { ok: true, name, state: "owned", note: "already-mounted" }
          : await manager.mount(name, servers[name]);
      } else {
        const unmounted = await manager.unmount(name);
        result = unmounted.ok ? unmounted : { ok: true, name, state: "stopped", note: unmounted.reason };
      }
    } catch (error) {
      result = { ok: false, name, reason: "exception", message: String((error && error.message) || error) };
    }
    try { gate.reapplyAll?.(); } catch { /* 忽略 */ }
    return finish({ result });
  };

  let warnedFallback = false;

  /** 宿主鉴权优先，宿主没装 connection 服务时回退自家四道门。 */
  const authorize = (req) => {
    const admission = hostAdmission(ctx, req);
    if (admission.checked) {
      if (admission.rejection === undefined) return { ok: true };
      if (admission.rejection === 403) return { ok: false, status: 403, error: "local trusted request only" };
      return { ok: false, status: 401, error: "browser session required (dsh web token/cookie)" };
    }
    if (!warnedFallback) {
      warnedFallback = true;
      try { logger?.warn?.("dsh-gate: 宿主 connection 服务不可用，/api/dsh-gate/* 退回本地四道门（不含浏览器会话认证）"); } catch { /* 忽略 */ }
    }
    if (!isTrustedRequest(req)) return { ok: false, status: 403, error: "local trusted request only" };
    return { ok: true };
  };

  const routes = [
    {
      kind: "exact",
      path: "/api/dsh-gate/state",
      handler: async (req, res) => {
        const gateResult = authorize(req);
        if (!gateResult.ok) return writeJson(res, gateResult.status, { error: gateResult.error });
        let want;
        try { want = new URL(req.url || "/", "http://localhost").searchParams.get("agent") || undefined; } catch { want = undefined; }
        const body = snapshot(want);
        if (want !== undefined && body.agent === null) {
          const known = gate.listAgents().map((row) => row.id).sort();
          return writeJson(res, 404, { error: "agent not found", requested: want, agents: known });
        }
        writeJson(res, 200, body);
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-gate/policy",
      handler: async (req, res) => {
        const gateResult = authorize(req);
        if (!gateResult.ok) return writeJson(res, gateResult.status, { error: gateResult.error });
        if (req.method === "POST") {
          if (!isJsonRequest(req)) return writeJson(res, 415, { ok: false, message: "content-type 必须是 application/json" });
          const body = await readJsonBody(req);
          if (body === undefined) return writeJson(res, 400, { ok: false, message: "JSON 解析失败" });
          return writeJson(res, 200, await savePolicyFile(body));
        }
        writeJson(res, 200, readPolicyFile());
      },
    },
    {
      // MCP 接管（0.3.0 工单 15）：GET 看清单，POST 做 add/update/remove/enable/disable。
      // 写路径复用 /policy 的保存逻辑（表驱动合并 + 无 BOM 落盘 + 重新解析策略）。
      kind: "exact",
      path: "/api/dsh-gate/mcp",
      handler: async (req, res) => {
        const gateResult = authorize(req);
        if (!gateResult.ok) return writeJson(res, gateResult.status, { error: gateResult.error });
        if (req.method === "POST") return handleMcpPost(req, res);
        const body = mcpServers(currentAgent(undefined));
        writeJson(res, 200, body);
      },
    },
    {
      // 能力视图（0.2.0）：单独一条查询，不挤进 /state 的固定形状。
      kind: "exact",
      path: "/api/dsh-gate/capabilities",
      handler: async (req, res) => {
        const gateResult = authorize(req);
        if (!gateResult.ok) return writeJson(res, gateResult.status, { error: gateResult.error });
        let want;
        try { want = new URL(req.url || "/", "http://localhost").searchParams.get("agent") || undefined; } catch { want = undefined; }
        const agent = currentAgent(want);
        if (agent === undefined || agent === null) {
          if (want !== undefined) {
            const known = gate.listAgents().map((row) => row.id).sort();
            return writeJson(res, 404, { error: "agent not found", requested: want, agents: known });
          }
          return writeJson(res, 200, Object.assign({ agent: null }, capabilityState(policy, {})));
        }
        const id = String(agent.id || "");
        if (typeof gate.capabilityView !== "function") return writeJson(res, 200, Object.assign({ agent: id }, capabilityState(policy, {})));
        writeJson(res, 200, Object.assign({ agent: id }, gate.capabilityView(agent)));
      },
    },
    {
      // 技能管理（0.3.0 工单 16）：列表/档位/导入目录/接管开关。写盘复用 /policy 的那条路。
      kind: "exact",
      path: "/api/dsh-gate/skills",
      handler: async (req, res) => {
        const gateResult = authorize(req);
        if (!gateResult.ok) return writeJson(res, gateResult.status, { error: gateResult.error });
        let want;
        try { want = new URL(req.url || "/", "http://localhost").searchParams.get("agent") || undefined; } catch { want = undefined; }
        if (req.method === "POST") {
          if (!isJsonRequest(req)) return writeJson(res, 415, { ok: false, message: "content-type 必须是 application/json" });
          const body = await readJsonBody(req);
          if (body === undefined) return writeJson(res, 400, { ok: false, message: "JSON 解析失败" });
          const result = await skillsAction(body);
          return writeJson(res, result.status, result.body);
        }
        const payload = skillsPayload(want);
        if (want !== undefined && payload.agent === null) {
          const known = gate.listAgents().map((row) => row.id).sort();
          return writeJson(res, 404, { error: "agent not found", requested: want, agents: known });
        }
        writeJson(res, 200, payload);
      },
    },
  ];

  ctx.inject(["webServer"], (sctx) => {
    const disposers = [];
    for (const route of routes) {
      try { disposers.push(sctx.webServer.register(route)); }
      catch (error) { try { logger?.warn?.("dsh-gate: 注册路由失败 " + route.path + " — " + String((error && error.message) || error)); } catch { /* 忽略 */ } }
    }
    return () => { for (const dispose of disposers) { try { dispose(); } catch { /* 忽略 */ } } };
  });

  return () => undefined;
}
