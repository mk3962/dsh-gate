/**
 * 技能服务（0.6.0 工单 #06 · 路由 /skills 的领域面）
 *
 * 五件事：列表、tier、off、imports、takeover，外加 **batch 原子批量**。
 *
 * 单动作与批量走**同一条**路径（runOps）：一次归一、一次落盘、一次预扫描。
 * 单动作就是"只有一条操作的批量"，所以两边不可能漂移；batch 的原子性也是结构性保证 ——
 * 所有操作先在同一份内存草稿上应用，全部成功才落一次盘，任何一条失败就整批拒绝（不产生部分落盘）。
 *
 * P1-10 修法：档位只走 errors.parseTier（严格 0/1/2），不再 Number() 强转 null → 0。
 */
import fs from "node:fs";
import { ControlPlaneError, ERROR_CODES, SERVICE_CODES, errorEnvelope, parseTier, statusOf } from "./errors.js";
import { fromLegacy, writeReceipt } from "./result.js";
import { normalizeSkillsConfig } from "../migrate.js";

/** 一次批量最多多少条（有界：请求体 512 KiB 已够，但仍要有个明确上限）。 */
export const MAX_BATCH_OPERATIONS = 50;

const isPlainObject = (value) => value !== null && typeof value === "object" && Array.isArray(value) === false;

const describe = (value) => {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const text = typeof value === "string" ? JSON.stringify(value) : String(value);
  return text.length > 40 ? text.slice(0, 40) + "…" : text;
};

const TIER_MESSAGE = "tier 必须是 0（关闭）/ 1（常驻）/ 2（按需）";

export function createSkillsService(core) {
  const invalid = (message, details) => new ControlPlaneError(ERROR_CODES.INVALID_BODY, message, details);

  /** 第 1 遍：只校验形状，不碰磁盘（批量在任何落盘之前就要全过）。 */
  const validateOp = (op) => {
    if (!isPlainObject(op)) throw invalid("operations 里每一项都必须是对象", { received: Array.isArray(op) ? "array" : typeof op });
    const action = typeof op.action === "string" ? op.action.trim() : "";
    if (action === "tier") {
      const name = typeof op.name === "string" ? op.name.trim() : "";
      if (name.length === 0 || name.length > 200) throw invalid("name 必须是非空技能名", { name: describe(op.name) });
      const tier = parseTier(op.tier);
      if (tier === undefined) {
        throw new ControlPlaneError(ERROR_CODES.INVALID_TIER, TIER_MESSAGE + "，收到 " + describe(op.tier), {
          received: op.tier === undefined ? "undefined" : op.tier === null ? "null" : typeof op.tier,
          tier: op.tier === null ? null : undefined,
        });
      }
      return { action, name, tier };
    }
    if (action === "off") {
      if (!Array.isArray(op.off)) throw invalid("off 必须是技能名字符串数组");
      for (const name of op.off) if (typeof name !== "string") throw invalid("off 里每一项都必须是字符串");
      return { action, off: op.off.slice() };
    }
    if (action === "imports") {
      if (!Array.isArray(op.imports)) throw invalid("imports 必须是数组（路径字符串或 {id?, path}）");
      const rows = [];
      for (const item of op.imports) {
        const entry = typeof item === "string" ? { path: item } : isPlainObject(item) ? item : undefined;
        if (entry === undefined) throw invalid("imports 的每一项必须是路径字符串或 {id?, path}");
        const text = typeof entry.path === "string" ? entry.path.trim() : "";
        if (text.length === 0) throw invalid("imports 里有一项缺少 path");
        const id = typeof entry.id === "string" ? entry.id.trim() : "";
        rows.push(id.length > 0 ? { id, path: text } : { path: text });
      }
      return { action, imports: rows };
    }
    if (action === "takeover") {
      if (typeof op.value !== "boolean") throw invalid("value 必须是布尔值（true=gate 接管技能，false=退回宿主）");
      return { action, value: op.value };
    }
    throw invalid("action 必须是 tier / off / imports / takeover" + (action === "batch" ? "（batch 内部不能再嵌套 batch）" : ""), { action: action.length > 0 ? action : undefined });
  };

  /**
   * 第 2 遍：在内存草稿上应用已校验的操作。
   * @returns {{draft:object, skills:object, applied:object[], warnings:object[]}}
   */
  const applyOps = (ops, base, rows) => {
    const draft = Object.assign({}, base.normalized, {
      capabilities: Object.assign({}, isPlainObject(base.normalized.capabilities) ? base.normalized.capabilities : {}),
    });
    let skills = normalizeSkillsConfig(Object.assign({ takeover: false, off: [], imports: [] }, base.skills || {}));
    const applied = [];
    const warnings = [];
    const baseDir = core.policyBaseDir();

    ops.forEach((op, index) => {
      if (op.action === "tier") {
        const row = rows.find((item) => item.name === op.name);
        const inherited = core.inheritedSkillTier(draft, row);
        const id = "skill:" + op.name;
        if (op.tier === inherited) {
          delete draft.capabilities[id];
        } else {
          draft.capabilities[id] = Object.assign({}, isPlainObject(draft.capabilities[id]) ? draft.capabilities[id] : {}, { tier: op.tier });
        }
        applied.push({ index, action: "tier", name: op.name, tier: op.tier, inherited, persisted: op.tier !== inherited });
        return;
      }
      if (op.action === "off") {
        skills = normalizeSkillsConfig(Object.assign({}, skills, { off: op.off }));
        applied.push({ index, action: "off", count: skills.off.length, off: skills.off.slice(0, 20) });
        return;
      }
      if (op.action === "imports") {
        const missing = [];
        const empty = [];
        const entries = [];
        for (const entry of op.imports) {
          const checked = core.checkImportPath(entry.path, baseDir);
          if (checked.ok !== true) {
            throw new ControlPlaneError(
              checked.code === "IMPORT_PATH_UNSAFE" ? SERVICE_CODES.IMPORT_PATH_UNSAFE : SERVICE_CODES.IMPORT_PATH_MISSING,
              checked.code === "IMPORT_PATH_UNSAFE" ? checked.message : "导入目录不存在（相对路径以策略文件所在目录为基准）：" + entry.path,
              { path: entry.path, reason: checked.code },
            );
          }
          if (!fs.existsSync(checked.resolved)) missing.push(entry.path);
          else if (!core.hasSkillFiles(checked.resolved)) empty.push(entry.path);
          entries.push(entry.id === undefined ? { path: entry.path } : { id: entry.id, path: entry.path });
        }
        if (missing.length > 0) {
          throw new ControlPlaneError(SERVICE_CODES.IMPORT_PATH_MISSING, "导入目录不存在（相对路径以策略文件所在目录为基准）：" + missing.join("、"), {
            paths: missing.slice(0, 20),
          });
        }
        skills = normalizeSkillsConfig(Object.assign({}, skills, { imports: entries }));
        if (empty.length > 0) {
          warnings.push({ code: "import-empty", message: "目录里没有 SKILL.md 或 *.md，gate 扫描时不会产出技能：" + empty.join("、") });
        }
        applied.push({ index, action: "imports", count: entries.length, empty: empty.length });
        return;
      }
      // takeover
      skills = normalizeSkillsConfig(Object.assign({}, skills, { takeover: op.value }));
      applied.push({ index, action: "takeover", value: op.value });
    });

    return { draft, skills, applied, warnings };
  };

  /**
   * 一次落盘 + 一次预扫描 + 统一回执。
   * @param {object} state applyOps 的结果（草稿已应用完毕）
   * @param {object[]} ops 已校验的操作
   * @param {string|undefined} want ?agent=
   * @param {{batch:boolean}} mode 批量才返回 applied（规格：applied 只在批量动作返回）
   */
  const persistAndRespond = async (state, ops, want, mode) => {
    const written = await core.persistDraft(state.draft, state.skills);
    if (!written.ok) return fromLegacy(written);
    core.noteAudit({
      at: new Date().toISOString(),
      source: "skills",
      action: mode !== null && mode !== undefined && mode.batch === true ? "batch" : ops[0].action,
      changed: written.changed,
      changedKeys: written.changedKeys,
      revision: written.revision,
      previousRevision: written.previousRevision,
      operations: ops.length,
    });
    const prescan = await core.prescanFor(want);
    const body = writeReceipt(written, {
      state: core.snapshot(want),
      skills: core.skillsPayload(want, prescan),
    });
    if (state.warnings.length > 0) body.warnings = body.warnings.concat(state.warnings);
    if (mode !== null && mode !== undefined && mode.batch === true) body.applied = state.applied;
    return { status: 200, body };
  };

  const gateEnabled = () => {
    if (core.policy.enabled === false) {
      throw new ControlPlaneError(SERVICE_CODES.GATE_DISABLED, "闸门已禁用（enabled=false）：先启用闸门再改技能配置");
    }
  };

  /** 单动作路径（= 只有一条操作的批量；一次归一、一次落盘、一次预扫描）。 */
  const runOps = async (ops, want) => {
    gateEnabled();
    const base = core.readCurrentPolicy();
    const prescan = await core.prescanFor(want);
    const rows = core.skillsPayload(want, prescan).skills;
    const state = applyOps(ops, base, rows);
    return persistAndRespond(state, ops, want, { batch: false });
  };

  /** batch：一次归一、一次落盘、一次预扫描；单条非法整批拒绝，不产生部分落盘。 */
  const runBatch = async (body, want) => {
    gateEnabled();
    const operations = Array.isArray(body.operations) ? body.operations : Array.isArray(body.ops) ? body.ops : undefined;
    if (operations === undefined) throw invalid("batch 需要 operations 数组", { received: body.operations === undefined ? "missing" : typeof body.operations });
    if (operations.length === 0) throw invalid("operations 不能为空");
    if (operations.length > MAX_BATCH_OPERATIONS) {
      throw new ControlPlaneError(ERROR_CODES.PAYLOAD_TOO_LARGE, "batch 最多 " + MAX_BATCH_OPERATIONS + " 条操作", {
        operations: operations.length,
        limit: MAX_BATCH_OPERATIONS,
      });
    }

    /** 整批拒绝的统一出口：带失败位置与"什么都没写"的 applied。 */
    const reject = (code, message, detail) => {
      const envelope = errorEnvelope(code, message, Object.assign({ applied: [] }, detail || {}));
      envelope.applied = [];
      if (detail !== undefined && detail.failedIndex !== undefined) envelope.failedIndex = detail.failedIndex;
      return { status: statusOf(code, 400), body: envelope };
    };

    // 第 1 遍：形状校验（任何一条不过 → 整批拒绝，磁盘一个字节都没动）。
    const ops = [];
    for (let index = 0; index < operations.length; index += 1) {
      const op = operations[index];
      let checked;
      try {
        checked = validateOp(op);
      } catch (error) {
        const code = error instanceof ControlPlaneError ? error.code : ERROR_CODES.INTERNAL;
        return reject(code, "batch 第 " + index + " 条失败（整批拒绝，未落盘）：" + String((error && error.message) || error), {
          failedIndex: index,
          action: isPlainObject(op) && typeof op.action === "string" ? op.action : undefined,
          reason: String((error && error.message) || error),
        });
      }
      ops.push({ index, op: checked });
    }

    const base = core.readCurrentPolicy();
    const prescan = await core.prescanFor(want);
    const rows = core.skillsPayload(want, prescan).skills;
    const checkedOps = ops.map((row) => row.op);
    let state;
    try {
      state = applyOps(checkedOps, base, rows);
    } catch (error) {
      const code = error instanceof ControlPlaneError ? error.code : ERROR_CODES.INTERNAL;
      return reject(code, "batch 校验失败（整批拒绝，未落盘）：" + String((error && error.message) || error), {
        reason: String((error && error.message) || error),
      });
    }
    core.stats.batchOps += checkedOps.length;
    return persistAndRespond(state, checkedOps, want, { batch: true });
  };

  return {
    /** GET：技能表（冷启动兜底预扫描）。 */
    async get(rc) {
      const want = rc && rc.want;
      const prescan = await core.prescanFor(want);
      return { status: 200, body: core.skillsPayload(want, prescan) };
    },
    /** POST：单动作或 batch。 */
    async post(rc) {
      const body = (rc && rc.body) || {};
      const action = typeof body.action === "string" ? body.action.trim() : "";
      if (action === "batch") return runBatch(body, rc.want);
      const checked = validateOp(body);
      return runOps([checked], rc.want);
    },
  };
}
