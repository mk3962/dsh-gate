/**
 * 策略服务（0.6.0 工单 #06 · 路由 /policy 的领域面）
 *
 * GET 读回 v3 形状；POST 走 core.savePolicyFile（表驱动合并 + 无 BOM 落盘 + 重解析 + 重算）。
 * 所有状态码来自 fromLegacy 的唯一映射：**保存失败绝不会 200**（F70）。
 *
 * 票（控制面契约）：/policy 写入前补一道 skills.imports 路径闸，与 /skills 的 skills-service 对齐：
 *   - 结构（policy-schema.validateSkillsImports）：空路径、.. 路径穿越、等价重复路径；
 *   - 安全（core.checkImportPath）：设备名 / UNC（与 /skills 同一个判定函数）；
 *   - **只校验新增或变更的条目**：历史配置里已有的路径原样回传必须放行，
 *     否则老 gate.json 一保存就被锁死。
 */
import { fromLegacy } from "./result.js";
import { importPathKey, validateSkillsImports } from "../policy-schema.js";

const isPlainObject = (value) => value !== null && typeof value === "object" && Array.isArray(value) === false;

const pathOfImport = (row) => (typeof row === "string"
  ? row
  : isPlainObject(row) && typeof row.path === "string"
    ? row.path
    : "");

export function createPolicyService(core) {
  /**
   * 只挑「本次新增或变更」的 imports 下标：与当前生效配置等价键相同的历史条目跳过。
   *
   * 历史免检按**出现次数**扣减，不能按「键存在」判：历史里 `skills/a` 只有一条，
   * 提交 `["skills/a", "skills/a/"]` 时两条的等价键都命中历史集合，整份列表会被误判成
   * 「全是历史原样回传」⇒ 待检集合为空 ⇒ 重复路径校验被整体短路 ⇒ 等价重复直接落盘。
   * 计数表让第一条吃掉历史配额、第二条按新增进入校验，重复项才拦得住 400。
   * @returns {{index:number,row:unknown}[]}
   */
  const freshImports = (imports) => {
    const current = typeof core.currentSkillsConfig === "function" ? core.currentSkillsConfig() : undefined;
    const quota = new Map();
    for (const row of Array.isArray(current && current.imports) ? current.imports : []) {
      const key = importPathKey(row);
      if (key.length === 0) continue;
      quota.set(key, (quota.get(key) || 0) + 1);
    }
    const fresh = [];
    imports.forEach((row, index) => {
      const text = pathOfImport(row).trim();
      if (text.length > 0) {
        const key = importPathKey(text);
        const left = quota.get(key) || 0;
        if (left > 0) {
          quota.set(key, left - 1);
          return;
        }
      }
      fresh.push({ index, row });
    });
    return fresh;
  };

  /** 返回旧式失败对象（交给 fromLegacy 落成 400 INVALID_BODY 信封）；合法时返回 undefined。 */
  const checkImports = (body) => {
    const skills = isPlainObject(body) ? body.skills : undefined;
    if (!isPlainObject(skills) || !Array.isArray(skills.imports)) return undefined;
    const fresh = freshImports(skills.imports);
    if (fresh.length === 0) return undefined;
    const freshIndexes = new Set(fresh.map((item) => item.index));
    const errors = [];

    // 结构问题：索引按「整份 imports」算，便于前端直接定位；只报新增/变更的那几条。
    const structural = validateSkillsImports(skills.imports);
    for (const row of structural.errors) {
      if (freshIndexes.has(row.index)) errors.push(Object.assign({}, row));
    }

    // 安全闸：与 skills-service 共用 core.checkImportPath（设备名 / UNC / 无法归一）。
    const baseDir = typeof core.policyBaseDir === "function" ? core.policyBaseDir() : undefined;
    for (const item of fresh) {
      const text = pathOfImport(item.row).trim();
      if (text.length === 0) continue; // 结构校验已经报过
      if (errors.some((row) => row.index === item.index)) continue; // 不重复报同一位置
      const checked = core.checkImportPath(text, baseDir);
      if (checked.ok === true) continue;
      errors.push({
        index: item.index,
        path: text,
        code: checked.code === "IMPORT_PATH_UNSAFE" ? "IMPORT_PATH_UNSAFE" : "IMPORT_PATH_MISSING",
        message: checked.message,
      });
    }

    if (errors.length === 0) return undefined;
    errors.sort((left, right) => left.index - right.index);
    return {
      ok: false,
      status: 400,
      code: "INVALID_BODY",
      message: "skills.imports 路径校验失败（" + errors.length + " 处）：" + errors[0].message,
      errors,
    };
  };

  return {
    get() {
      return { status: 200, body: core.readPolicyFile() };
    },
    async post(rc) {
      const body = rc && rc.body;
      const invalid = checkImports(body);
      if (invalid !== undefined) return fromLegacy(invalid);
      const result = await core.savePolicyFile(body);
      return fromLegacy(result);
    },
  };
}
