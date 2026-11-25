/**
 * 控制面核心（0.6.0 工单 #06）—— 领域投影与写盘，**不含任何 HTTP 概念**。
 *
 * 从 0.5.7 的 lib/server.js 整段搬出（语义逐行保留），只做两处结构性改动：
 *   1. `snapshotOf` 由调用方注入（server.js 里那一行 `gate.snapshot(agent)` 留在 server.js，
 *      test/snapshot.test.mjs 的源码守卫仍然成立）；
 *   2. 新增计数器与有界审计环（F75 / 诊断 runtime 组用），不改任何既有返回形状。
 *
 * 依赖方向（工单边界）：本文件只碰 policy/migrate/capabilities/mcp/storage/skills，绝不 import http。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePolicy, defaultDshHome, emptyPolicyTemplate, isPlainObject, mergePolicyFile, validatePolicyInput } from "../policy.js";
import { isV2SkillsShape, isV3Policy, migrateV2ToV3, normalizeSkillsConfig, normalizeV3Policy } from "../migrate.js";
import { normalizeServerConfig } from "../mcp.js";
import { prescanHostSkills } from "../skills.js";
import { STORAGE_CODES, createFilePolicyStore, isCorruptRead } from "../storage-seam.js";
import { resolveService } from "../services.js";
import { isTier } from "./errors.js";

const PRESCAN_TTL_MS = 10 * 1000;
const PRESCAN_INCOMPLETE_TTL_MS = 2 * 1000;
/** 审计环上限（F75：每次策略写入一条，只留最近若干条；有界是硬要求）。 */
export const AUDIT_LIMIT = 20;

/**
 * @param {{ctx:object, gate:object, policy:object, logger:object, config:object,
 *          snapshotOf:(agent:object)=>object}} options
 */
export function createCore(options) {
  const opts = options || {};
  const ctx = opts.ctx;
  const gate = opts.gate;
  const policy = opts.policy;
  const logger = opts.logger;
  const rawConfig = isPlainObject(opts.config) ? opts.config : {};
  const snapshotOf = typeof opts.snapshotOf === "function" ? opts.snapshotOf : (agent) => gate.snapshot(agent);

  /** 控制面自身的运行计数（诊断 runtime 组；只增不减、全整数）。 */
  const stats = {
    startedAt: Date.now(),
    policyWrites: 0,
    policyWriteFailures: 0,
    policyUnchanged: 0,
    reapplyPasses: 0,
    prescans: 0,
    prescanFailures: 0,
    prescanCacheHits: 0,
    batchOps: 0,
    mcpOps: 0,
    migrates: 0,
  };
  /** 写审计环（F75）：{at, source, action, changedKeys, revision, previousRevision, migrated, applied, failedIndex}。 */
  const audit = [];
  const noteAudit = (entry) => {
    audit.push(entry);
    while (audit.length > AUDIT_LIMIT) audit.shift();
  };
  const auditView = () => audit.map((row) => Object.assign({}, row));

  /**
   * 取一个“闸门真正挂上了”的 agent 来做快照。
   * 不能只信 ctx.agents.roots()：插件根 ctx 上它可能为空（真事故：状态页全 0，看着像没生效）。
   */
  const currentAgent = (want) => {
    try {
      const rows = gate.listAgents();
      const wanted = typeof want === "string" && want.length > 0 ? want : undefined;
      if (wanted !== undefined) {
        const hit = rows.find((row) => row.id === wanted);
        return hit === undefined ? undefined : hit.agent;
      }
      if (rows.length > 0) return rows[0].agent;
    } catch { /* 忽略 */ }
    try {
      const roots = ctx.agents?.roots?.() || [];
      return roots[0];
    } catch { return undefined; }
  };

  /** 已知会话 id 清单（AGENT_NOT_FOUND 的 details.agents）。 */
  const knownAgentIds = () => {
    try {
      return gate.listAgents().map((row) => row.id).sort();
    } catch { return []; }
  };

  const defaultsOf = () => ({
    toolsDefaultTier: policy.defaults.capability,
    sectionsDefaultTier: policy.defaults.section,
    skillsTier: policy.defaults.skillpack,
    toolOverrides: {},
    sectionOverrides: {},
    capabilityDefaultTier: policy.defaults.capability,
    sectionDefaultTier: policy.defaults.section,
    skillpackDefaultTier: policy.defaults.skillpack,
  });

  /** 面板状态 = gate.snapshot() 换两个字段名（own / preset）+ 补一份 UI 默认值。 */
  const snapshot = (want) => {
    const agent = currentAgent(want);
    const state = snapshotOf(agent);
    return Object.assign({}, state, {
      own: state.ownNames,
      preset: state.presetNames,
      defaults: defaultsOf(),
    });
  };

  const knownNamesOf = (agent) => {
    try {
      if (typeof gate.knownNames !== "function") return undefined;
      const names = gate.knownNames(agent);
      return names instanceof Set ? names : undefined;
    } catch { return undefined; }
  };

  const currentKnownNames = () => knownNamesOf(currentAgent(undefined));

  /* ── 策略存储 ─────────────────────────────────────────────────────────── */
  let storeCache;
  const policyStoreFor = (file) => {
    if (typeof file !== "string" || file.length === 0) return undefined;
    if (storeCache !== undefined && storeCache.file === file) return storeCache.store;
    const store = createFilePolicyStore({ file, logger });
    storeCache = { file, store };
    return store;
  };

  const readPolicyState = () => {
    const file = policy.policyFile;
    if (typeof file !== "string" || file.length === 0) {
      return {
        ok: false,
        exists: false,
        document: undefined,
        revision: undefined,
        status: "absent",
        diagnostic: { status: "absent", reason: "no-policy-file", path: undefined, ok: true, exists: false, hadBom: false },
        text: undefined,
      };
    }
    const store = policyStoreFor(file);
    const read = store.readSync();
    const diagnostic = store.readDiagnostic();
    const corrupt = isCorruptRead(read);
    const status = corrupt === true && read.status === "ok" ? "shape" : read.status;
    return {
      ok: corrupt !== true && read.ok === true,
      corrupt,
      exists: read.exists === true,
      document: corrupt === true ? undefined : read.value,
      revision: read.revision,
      status,
      diagnostic: corrupt === true && read.status === "ok" ? Object.assign({}, diagnostic, { status: "shape", reason: "root-not-object" }) : diagnostic,
      text: read.text,
      error: read.error,
      store,
    };
  };

  const readPolicyFileRaw = () => {
    const state = readPolicyState();
    if (state.ok === true && isPlainObject(state.document)) return state.document;
    return emptyPolicyTemplate();
  };

  const builtinTemplate = () => normalizeV3Policy(emptyPolicyTemplate()).policy;

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
    const state = readPolicyState();
    const raw = state.ok === true && isPlainObject(state.document) ? state.document : emptyPolicyTemplate();
    const skills = skillsConfigOf(raw);
    const withSkills = (content) => (skills === undefined ? content : Object.assign({}, content, { skills }));
    const basis = {
      file: typeof file === "string" ? file : "",
      version: 3,
      template: builtinTemplate(),
      revision: state.revision,
      fileState: state.status,
      readDiagnostic: state.diagnostic,
      degraded: state.corrupt === true || state.status === "io",
      writable: state.corrupt !== true && state.status !== "absent" ? true : state.corrupt !== true,
    };
    if (isV3Policy(raw)) {
      return Object.assign(basis, {
        content: withSkills(normalizeV3Policy(raw).policy),
        migrated: false,
        warnings: [],
      }, policyFileStamp());
    }
    const migrated = migrateV2ToV3(raw, { knownNames: currentKnownNames() });
    return Object.assign(basis, {
      content: withSkills(migrated.policy),
      fromVersion: migrated.fromVersion,
      migrated: true,
      warnings: migrated.warnings,
    }, policyFileStamp());
  };

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

  /* ── 技能接管配置 ─────────────────────────────────────────────────────── */
  const skillsConfigOf = (rawPolicy) => {
    const value = isPlainObject(rawPolicy) ? rawPolicy.skills : undefined;
    if (!isPlainObject(value) || isV2SkillsShape(value)) return undefined;
    return normalizeSkillsConfig(value);
  };

  const currentSkillsConfig = () => {
    const runtime = skillsConfigOf(policy);
    if (runtime !== undefined) return runtime;
    const file = skillsConfigOf(readPolicyFileRaw());
    if (file !== undefined) return file;
    return { takeover: false, activationRelay: true, activationPromote: true, off: [], imports: [] };
  };

  const policyBaseDir = () => {
    const file = policy.policyFile;
    return typeof file === "string" && file.length > 0 ? path.dirname(file) : process.cwd();
  };

  /**
   * 导入路径安全闸（F77）：UNC 与设备路径一律拒。
   * 设备名要按**每一段**判（`skills/CON` 在 Windows 上同样是设备），只判整串会漏。
   */
  const unsafeImportReason = (text) => {
    const normal = String(text).replace(/\//g, "\\");
    if (normal.startsWith("\\\\?\\") || normal.startsWith("\\\\.\\")) return "device-path";
    if (normal.startsWith("\\\\")) return "unc-path";
    for (const segment of normal.split("\\")) {
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(segment)) return "device-path";
    }
    return undefined;
  };

  /** 归一为绝对路径；不安全路径返回 undefined（调用方按 IMPORT_PATH_UNSAFE 报 400）。 */
  const resolveImportPath = (importPath, baseDir) => {
    let text = typeof importPath === "string" ? importPath.trim() : "";
    if (text.length === 0) return undefined;
    if (text === "~") text = os.homedir();
    else if (text.startsWith("~/") || text.startsWith("~\\")) text = path.join(os.homedir(), text.slice(2));
    if (unsafeImportReason(text) !== undefined) return undefined;
    return path.isAbsolute(text) ? path.normalize(text) : path.normalize(path.join(baseDir, text));
  };

  /** 带原因的检查版本（skills imports / batch 用；不含 fs 访问）。 */
  const checkImportPath = (importPath, baseDir) => {
    const text = typeof importPath === "string" ? importPath.trim() : "";
    if (text.length === 0) return { ok: false, code: "IMPORT_PATH_MISSING", message: "缺少 path" };
    const unsafe = unsafeImportReason(text);
    if (unsafe !== undefined) return { ok: false, code: "IMPORT_PATH_UNSAFE", message: "不安全的导入路径（" + unsafe + "）：" + text };
    const resolved = resolveImportPath(text, baseDir);
    if (resolved === undefined) return { ok: false, code: "IMPORT_PATH_MISSING", message: "无法归一为绝对路径：" + text };
    return { ok: true, path: text, resolved };
  };

  const hasSkillFile = (dir) => {
    try { return fs.statSync(path.join(dir, "SKILL.md")).isFile(); } catch { return false; }
  };

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

  const readCurrentPolicy = () => {
    const raw = readPolicyFileRaw();
    const current = isV3Policy(raw) ? raw : migrateV2ToV3(raw, { knownNames: currentKnownNames() }).policy;
    return { normalized: normalizeV3Policy(current).policy, skills: skillsConfigOf(current) };
  };

  /* ── 唯一写入口 ───────────────────────────────────────────────────────── */
  const persistPolicy = async (final, writeOptions) => {
    const file = policy.policyFile;
    if (typeof file !== "string" || file.length === 0) return { ok: false, message: "策略文件路径未配置（config.policyFile 为空）" };
    const options = writeOptions || {};
    const store = policyStoreFor(file);
    let receipt;
    try {
      receipt = await store.write(final, {
        expectedRevision: options.expectedRevision,
        replaceCorrupt: options.replaceCorrupt === true,
        changedKeys: options.changedKeys,
        warnings: options.warnings,
      });
    } catch (error) {
      stats.policyWriteFailures += 1;
      if (error && error.code === STORAGE_CODES.REVISION_CONFLICT) {
        return {
          ok: false,
          status: 409,
          code: STORAGE_CODES.REVISION_CONFLICT,
          message: "策略已被其他页面/进程改过（revision 冲突），请刷新后重试",
          expectedRevision: error.detail && error.detail.expectedRevision,
          currentRevision: error.detail && error.detail.currentRevision,
          changedKeys: options.changedKeys || [],
        };
      }
      if (error && error.code === STORAGE_CODES.UNREADABLE) {
        return { ok: false, status: 409, code: STORAGE_CODES.UNREADABLE, message: "策略文件不可读，已拒绝覆盖（需显式整份替换）" };
      }
      return { ok: false, status: 500, code: error && error.code, message: "写入失败: " + String((error && error.message) || error) };
    }
    stats.policyWrites += 1;
    if (receipt.changed === false) stats.policyUnchanged += 1;
    // 重新解析时必须带插件行 config，否则行上自定义的 policyFile/overrides/protected 会被清空。
    const next = resolvePolicy(rawConfig, { logger, dshHome: defaultDshHome(), knownNames: currentKnownNames() });
    // 目标文件护栏：config 没给 policyFile 时，绝不让一次写盘把后续读写"漂移"到默认 gate.json
    // （0.5.7 里这是真事故面：写完之后 policy.policyFile 变成 ~/.dsh/gate.json，下一次改写的是另一份文件）。
    if ((typeof next.policyFile !== "string" || next.policyFile.length === 0) && typeof file === "string" && file.length > 0) {
      next.policyFile = file;
    }
    if (typeof next.policyFile === "string" && next.policyFile !== file) {
      try { logger?.warn?.("dsh-gate: 策略目标文件被 config 改为 " + next.policyFile + "（原 " + file + "）"); } catch { /* 忽略 */ }
    }
    Object.assign(policy, next);
    const agents = gate.listAgents();
    stats.reapplyPasses += 1;
    for (const row of agents) {
      try { gate.reapply(row.agent); } catch { /* 忽略 */ }
    }
    if (typeof gate.refreshSkills === "function") {
      for (const row of agents) {
        try { await gate.refreshSkills(row.agent); } catch { /* 忽略 */ }
      }
    }
    return {
      ok: true,
      changed: receipt.changed !== false,
      revision: receipt.revision,
      previousRevision: receipt.previousRevision,
      changedKeys: receipt.changedKeys || [],
      warnings: receipt.warnings || [],
      bytes: receipt.bytes,
    };
  };

  const persistDraft = async (draft, skills, writeOptions) => {
    const final = normalizeV3Policy(Object.assign({}, draft, { version: 3 })).policy;
    if (skills !== undefined) final.skills = normalizeSkillsConfig(skills);
    return persistPolicy(final, writeOptions);
  };

  /**
   * POST /policy 的保存语义（0.5.7 逐行保留）。
   * P1-1 之外的变更：整份替换等保护性写入要求显式确认（acknowledge），否则 409 CONFIRMATION_REQUIRED，
   * 并在 details 里回传“将发生什么”（会被删掉的能力键、被清空的接管配置…）。
   */
  const savePolicyFile = async (body) => {
    const file = policy.policyFile;
    if (typeof file !== "string" || file.length === 0) return { ok: false, status: 400, code: "INVALID_BODY", message: "策略文件路径未配置（config.policyFile 为空）" };
    if (!isPlainObject(body)) return { ok: false, status: 400, code: "INVALID_BODY", message: "策略必须是 JSON 对象" };
    const replace = body.replace === true;
    const acknowledged = body.acknowledge === true;
    const forceOverwrite = body.forceOverwriteCorrupt === true || body.replaceCorrupt === true || (replace && acknowledged);
    const submitted = Object.assign({}, body);
    delete submitted.replace;
    delete submitted.acknowledge;
    delete submitted.forceOverwriteCorrupt;
    delete submitted.replaceCorrupt;
    delete submitted.expectedRevision;
    delete submitted.ifRevision;
    const expectedRevision = body.expectedRevision !== undefined ? body.expectedRevision : body.ifRevision;
    const v2Submit = isPlainObject(submitted.tools) || isPlainObject(submitted.sections) || isV2SkillsShape(submitted.skills);
    const validationTarget = v2Submit ? migrateV2ToV3(submitted, { knownNames: currentKnownNames() }).policy : submitted;
    const strict = validatePolicyInput(validationTarget, { allowExtensions: replace });
    if (strict.ok !== true) {
      return {
        ok: false,
        status: 400,
        code: "INVALID_POLICY",
        message: "策略字段校验失败（" + strict.errors.length + " 处）：" +
          strict.errors.slice(0, 3).map((row) => row.path + " " + row.code).join("；"),
        errors: strict.errors,
      };
    }
    const state = readPolicyState();
    if (state.corrupt === true && forceOverwrite !== true) {
      return {
        ok: false,
        status: 409,
        code: STORAGE_CODES.UNREADABLE,
        message: "策略文件不可读（" + String(state.status) + "），已拒绝保存；请显式整份替换并确认（forceOverwriteCorrupt）",
        fileState: state.status,
        readDiagnostic: state.diagnostic,
        writable: false,
      };
    }
    const rawCurrent = state.corrupt === true ? emptyPolicyTemplate() : (isPlainObject(state.document) ? state.document : emptyPolicyTemplate());
    const current = isV3Policy(rawCurrent) ? rawCurrent : migrateV2ToV3(rawCurrent, { knownNames: currentKnownNames() }).policy;
    // F73 / 保护性写入：整份替换（replace）会删键，必须先拿到显式确认，并回传将发生的变化摘要。
    if (replace === true && acknowledged !== true) {
      const dropped = Object.keys(isPlainObject(current.capabilities) ? current.capabilities : {})
        .filter((key) => !(isPlainObject(submitted.capabilities) && submitted.capabilities[key] !== undefined));
      const skillsDropped = isPlainObject(current.skills) && isPlainObject(submitted.skills) === false;
      return {
        ok: false,
        status: 409,
        code: "CONFIRMATION_REQUIRED",
        message: "整份替换会删除现有条目，必须带 acknowledge: true 确认后重试",
        willDelete: {
          capabilities: dropped.slice(0, 40),
          capabilityCount: dropped.length,
          skillsConfig: skillsDropped,
        },
        fileState: state.status,
        currentRevision: state.revision,
      };
    }
    let merged;
    if (replace) {
      merged = isV3Policy(submitted) ? submitted : migrateV2ToV3(submitted, { knownNames: currentKnownNames() }).policy;
    } else {
      merged = mergePolicyFile(current, submitted);
      merged = withV2Compat(merged, submitted);
    }
    merged.version = 3;
    const skills = skillsConfigOf(merged) !== undefined ? skillsConfigOf(merged) : skillsConfigOf(rawCurrent);
    const written = await persistDraft(merged, skills, {
      expectedRevision,
      replaceCorrupt: forceOverwrite,
      changedKeys: merged.changedKeys,
      warnings: merged.warnings,
    });
    if (!written.ok) return Object.assign({ fileState: state.status }, written);
    noteAudit({
      at: new Date().toISOString(),
      source: "policy",
      action: replace ? "replace" : "merge",
      changed: written.changed,
      changedKeys: written.changedKeys,
      revision: written.revision,
      previousRevision: written.previousRevision,
      migrated: v2Submit === true,
      fileState: state.status,
    });
    return Object.assign({}, written, { state: snapshot(), fileState: "ok" });
  };

  /* ── 冷启动预扫描 ─────────────────────────────────────────────────────── */
  let prescanCache;
  try {
    if (ctx !== null && ctx !== undefined && typeof ctx.on === "function") {
      ctx.on("skills/change", () => { prescanCache = undefined; });
    }
  } catch { /* 老宿主 / 假 ctx 没有事件：退回 TTL */ }

  const defaultPresetId = () => {
    const presets = resolveService(ctx, "agentPresets");
    if (presets === undefined) return undefined;
    try {
      const id = presets.defaultId;
      return typeof id === "string" && id.length > 0 ? id : undefined;
    } catch { return undefined; }
  };

  const prescanCwd = () => {
    const workingDirectory = resolveService(ctx, "workingDirectory");
    if (workingDirectory === undefined) return undefined;
    try {
      const dir = workingDirectory.defaultDirectory;
      return typeof dir === "string" && dir.length > 0 && fs.existsSync(dir) ? dir : undefined;
    } catch { return undefined; }
  };

  const prescanFor = async (want) => {
    const agent = currentAgent(want);
    if (agent !== undefined && agent !== null) {
      let rows = 0;
      try {
        const state = snapshotOf(agent);
        rows = (Array.isArray(state.skillEntries) ? state.skillEntries.length : 0)
          + (Array.isArray(state.skills) ? state.skills.length : 0);
      } catch { rows = 0; }
      if (rows > 0) return { ok: false, reason: "agent-live" };
    }
    const preset = defaultPresetId();
    const key = String(want === undefined ? "" : want) + "|" + String(preset === undefined ? "" : preset);
    const now = Date.now();
    if (prescanCache !== undefined && prescanCache.key === key && now - prescanCache.at < prescanCache.ttl) {
      stats.prescanCacheHits += 1;
      return prescanCache.value;
    }
    let scanned;
    stats.prescans += 1;
    try {
      scanned = await prescanHostSkills(ctx, { preset, cwd: prescanCwd() });
    } catch (error) {
      stats.prescanFailures += 1;
      scanned = { ok: false, reason: String((error && error.message) || error) };
    }
    const value = scanned.ok === true ? Object.assign({}, scanned, { at: Date.now() }) : scanned;
    if (scanned.ok === true) {
      prescanCache = { key, at: now, ttl: scanned.complete === false ? PRESCAN_INCOMPLETE_TTL_MS : PRESCAN_TTL_MS, value };
    } else {
      stats.prescanFailures += 1;
      prescanCache = undefined;
    }
    return value;
  };

  const prescanStatus = () => (prescanCache === undefined
    ? { cached: false }
    : { cached: true, at: prescanCache.at, ttl: prescanCache.ttl, ageMs: Date.now() - prescanCache.at, key: prescanCache.key });

  /* ── 技能表投影 ───────────────────────────────────────────────────────── */
  const skillsPayload = (want, prescan) => {
    const agent = currentAgent(want);
    const state = snapshotOf(agent);
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
          prescan: false,
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
      if (isTier(item.tier)) row.tier = item.tier;
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
    for (const name of Array.isArray(state.skills) ? state.skills : []) {
      if (typeof name === "string" && name.length > 0) ensure(name);
    }
    const prescanActive = prescan !== undefined && prescan !== null && prescan.ok === true && rows.size === 0;
    if (prescanActive) {
      for (const item of Array.isArray(prescan.skills) ? prescan.skills : []) {
        if (!item || typeof item.name !== "string" || item.name.length === 0) continue;
        const row = ensure(item.name);
        if (typeof item.provider === "string" && item.provider.length > 0) row.provider = item.provider;
        if (item.origin === "import" || item.origin === "host") row.origin = item.origin;
        if (typeof item.path === "string" && item.path.length > 0) row.path = item.path;
        if (typeof item.description === "string" && item.description.length > 0) row.description = item.description;
        row.prescan = true;
      }
    }
    const defaults = isPlainObject(view.defaults) ? view.defaults : {};
    const fallbackTier = (isTier(defaults.skillpack) ? defaults.skillpack : undefined)
      ?? (isTier(policy.defaults && policy.defaults.skillpack) ? policy.defaults.skillpack : undefined)
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
      const safe = resolved !== undefined && typeof resolved === "string";
      return Object.assign({}, item, {
        exists: safe && fs.existsSync(resolved),
        hasSkills: safe && hasSkillFiles(resolved),
      });
    });
    return {
      agent: state.agent,
      skills,
      imports,
      off: config.off,
      takeover: config.takeover,
      // 技能激活开关（policy-schema 的 SKILLS_DEFAULTS 默认 true）：前端技能页直接读这两个顶层布尔，
      // 缺字段会恒显 false（票：/skills 返回补齐 activationRelay / activationPromote）。
      activationRelay: config.activationRelay !== false,
      activationPromote: config.activationPromote !== false,
      defaults: { skillpack: fallbackTier },
      warnings: Array.isArray(state.warnings) ? state.warnings : [],
      prescan: {
        active: prescanActive,
        scoped: prescanActive && prescan.scoped === true,
        preset: prescanActive && typeof prescan.preset === "string" ? prescan.preset : null,
        cwd: prescanActive && typeof prescan.cwd === "string" ? prescan.cwd : null,
        complete: prescanActive ? prescan.complete !== false : false,
        at: prescanActive && Number.isFinite(prescan.at) ? prescan.at : null,
        reason: prescan !== undefined && prescan !== null && prescan.ok !== true
          ? String(prescan.reason || "unavailable")
          : null,
      },
    };
  };

  /** 单技能条目的继承档（skillpack:<provider> 组条目 → defaults.skillpack）。 */
  const inheritedSkillTier = (normalized, skill) => {
    const capabilities = isPlainObject(normalized.capabilities) ? normalized.capabilities : {};
    const groupId = skill && typeof skill.capability === "string" && skill.capability.length > 0 ? skill.capability : "skillpack:unknown";
    const group = isPlainObject(capabilities[groupId]) ? capabilities[groupId] : undefined;
    if (group !== undefined && isTier(group.tier)) return group.tier;
    const defaults = isPlainObject(normalized.defaults) ? normalized.defaults : {};
    return isTier(defaults.skillpack) ? defaults.skillpack : 2;
  };

  const writeSkillsConfig = async (next) => {
    const current = readCurrentPolicy();
    const draft = Object.assign({}, current.normalized, { skills: normalizeSkillsConfig(next) });
    return persistDraft(draft, normalizeSkillsConfig(next));
  };

  /* ── MCP ─────────────────────────────────────────────────────────────── */
  const declaredMcpServers = () => {
    const mcp = policy.mcp;
    return isPlainObject(mcp) && isPlainObject(mcp.servers) ? mcp.servers : {};
  };

  const mcpTargetOf = (config) => {
    const source = isPlainObject(config) ? config : {};
    return source.transport === "streamable-http" ? String(source.url || "") : String(source.command || "");
  };

  const mcpWarnings = () => {
    const rows = Array.isArray(policy.warnings) ? policy.warnings : [];
    return rows
      .filter((row) => row && typeof row.code === "string" && row.code.startsWith("invalid-mcp"))
      .map((row) => String(row.message || row.code));
  };

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

  const mcpConfigOf = (body) => (isPlainObject(body.server) ? body.server : body.config);

  /** 诊断 read 组需要的读取投影（只读；不改任何状态）。 */
  const readDiagnostic = () => {
    const state = readPolicyState();
    const stamp = policyFileStamp();
    return {
      file: typeof policy.policyFile === "string" ? policy.policyFile : "",
      source: typeof policy.policyFile === "string" && policy.policyFile.length > 0 ? "file" : "builtin",
      status: state.status,
      exists: state.exists === true,
      ok: state.ok === true,
      corrupt: state.corrupt === true,
      writable: state.corrupt !== true,
      revision: state.revision,
      formatVersion: isPlainObject(state.document) && Number.isFinite(state.document.version) ? state.document.version : undefined,
      targetVersion: 3,
      migrated: isPlainObject(state.document) && state.document.version !== 3,
      fromVersion: isPlainObject(state.document) && Number.isFinite(state.document.version) ? state.document.version : undefined,
      contractVersion: 3,
      mtime: Number.isFinite(stamp.mtime) ? new Date(stamp.mtime).toISOString() : undefined,
      bytes: Number.isFinite(stamp.size) ? stamp.size : undefined,
      layers: {
        defaults: isPlainObject(policy.defaults) ? policy.defaults : undefined,
        capabilities: isPlainObject(policy.capabilities) ? Object.keys(policy.capabilities).length : 0,
        sections: isPlainObject(policy.sections) ? Object.keys(policy.sections).length : 0,
        mcpServers: Object.keys(declaredMcpServers()).length,
        skills: (() => { const config = currentSkillsConfig(); return { takeover: config.takeover, off: config.off.length, imports: config.imports.length }; })(),
      },
      warnings: Array.isArray(policy.warnings) ? policy.warnings.slice(0, 20) : [],
      diagnostic: state.diagnostic,
      writes: auditView(),
    };
  };

  return {
    ctx, gate, policy, logger, rawConfig,
    stats, auditView,
    currentAgent, knownAgentIds, snapshot, defaultsOf, snapshotOf,
    knownNamesOf, currentKnownNames,
    policyStoreFor, readPolicyState, readPolicyFileRaw, builtinTemplate, policyFileStamp, readPolicyFile,
    withV2Compat, skillsConfigOf, currentSkillsConfig, policyBaseDir, resolveImportPath, checkImportPath, hasSkillFiles,
    readCurrentPolicy, persistPolicy, persistDraft, savePolicyFile,
    prescanFor, prescanStatus,
    skillsPayload, inheritedSkillTier, writeSkillsConfig,
    declaredMcpServers, mcpTargetOf, mcpWarnings, mcpServers, mcpConfigOf,
    readDiagnostic, noteAudit,
  };
}
