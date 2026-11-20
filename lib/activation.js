/**
 * 技能激活族（0.5.4 · 上游票 B2 的执行面补丁）。
 *
 * 背景：univer_* / office_* 这批工具的注册带 `when`（conditional registration）。宿主的
 * 三条事实决定它们「不声明就不可执行」，缺任何一条都修不好：
 *   1) `view(agent).visible` 仍然包含 conditional 注册（restriction 只按 layer.admits 过滤）；
 *   2) 每一步的 admission 由 `tools.resolve()` 求值 `when`，只有 admitted 的才进 `toolSet`；
 *   3) `executable(name, scope, toolSet)` 在 `toolSet === undefined` 时对 conditional 一律返回
 *      undefined（dsh-tools/lib/index.js:531-535）—— 于是 step 之外的转发必然 UNKNOWN_TOOL。
 *
 * 所以闸门要做两件事：
 *   A) 技能加载成功后把该族 conditional 工具从 deny 里放出来（gate.js 的 promoted 集合），
 *      下一步它才会被声明、才会进 admission；
 *   B) 转发（gate_invoke / gate_call）发生在 step 之外，必须把**当前这一步的 toolSet** 带进
 *      executeToolBatch —— 否则 A 放出来了也照样 UNKNOWN_TOOL。
 *
 * 本文件只放纯判断（不碰宿主对象），好让族切分与「谁能被放」有唯一实现、可单测。
 */

/** 族前缀必须是标识符形状：技能名里出现别的字符就当没有族（宁可不放，也不误放）。 */
const FAMILY_RE = /^[a-z][a-z0-9]*$/i;

/**
 * 技能名 → 工具族前缀。
 *
 * `univer-sheet` → `univer`、`office-docx` → `office`、`browser-skill` → `browser`。
 * 只取第一段：插件的激活门本来就是按插件族给的（univer 的 activationSkills 里
 * `univer` 与 `univer-sheet` 同一份 when）。
 *
 * @param {string} skillName 技能名（允许带 `skill:` 前缀，函数自己剥）
 * @returns {string} 族前缀；切不出来时返回空串
 */
export function skillFamilyOf(skillName) {
  const name = typeof skillName === "string" ? skillName.replace(/^skill:/, "") : "";
  const family = name.split("-")[0];
  return FAMILY_RE.test(family) ? family : "";
}

/**
 * 该技能族对应的工具名。
 *
 * 判据只有两条：名字就是族本身，或以 `<族>_` 开头。不做模糊匹配 —— 误放会把
 * 用户明确藏起来的工具塞回工具表（那是 0.5.3 之前最贵的一次前缀失效）。
 *
 * @param {string} skillName 技能名
 * @param {Iterable<string>} names 候选工具名
 * @returns {string[]} 命中的工具名（排序后）
 */
export function familyToolNames(skillName, names) {
  const family = skillFamilyOf(skillName);
  if (family.length === 0) return [];
  const prefix = family + "_";
  const out = [];
  for (const name of names) {
    if (typeof name !== "string" || name.length === 0) continue;
    if (name === family || name.startsWith(prefix)) out.push(name);
  }
  return out.sort();
}

/**
 * 决定这一批里哪些名字可以被技能激活「放出」。
 *
 * 四条纪律（改这里之前先读）：
 *  1) **族内全放**（0.5.6）：不再要求「我们认出了它的 `when`」。0.5.4 用 conditional 集合
 *     做闸，实测只认得出 univer、认不出 office（两家写法相同），结果是 office 永远放不出来。
 *     判据换成「注册在案 + 族内 + 没被 explicit off + 还没常驻」—— 族外一个都不碰，
 *     族内让宿主自己去判能不能执行：plain 工具放出来照样能跑，conditional 工具放出来
 *     下一步才有机会进 toolSet（这是它唯一的执行入口）。
 *  2) **explicit off 绝不放**：`off` 是用户/策略明确关掉的档位，技能加载不能绕过它；
 *  3) 已经常驻的不必放（幂等：第二次加载同一个技能返回空数组）；
 *  4) 结果排序，保证同一策略下的动作可复现。
 *
 * @param {{skillName: string, names: Iterable<string>, off?: Set<string>, resident?: Set<string>}} input
 * @returns {string[]} 本次新放出的工具名
 */
export function pickPromotable(input) {
  const { skillName, names } = input || {};
  const off = input.off instanceof Set ? input.off : new Set();
  const resident = input.resident instanceof Set ? input.resident : new Set();
  const out = [];
  for (const name of familyToolNames(skillName, names || [])) {
    if (off.has(name) || resident.has(name)) continue;
    out.push(name);
  }
  return out.sort();
}
