/**
 * 技能激活族（0.5.4 · 上游票 B2 的执行面补丁；0.7.2 起族前缀改由 naming.js 单一事实源解析）。
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
 *
 * 0.7.2（票 01 根治）：族前缀**不再自己切字符串**，一律问 lib/naming.js 的
 * toolPrefixesForSkill —— 名字怎么切只有一处实现（D6 的单一事实源），
 * 且显式别名（`browser-skill` → `bsk`）与插件前缀表 PLUGIN_PREFIXES 并列在同一张表里。
 */
import { isToolPrefix, toolPrefixesForSkill } from "./naming.js";

/** 族前缀形状校验用的是 naming.js 的同一条判据（这里只做转发，不另立一套）。 */
const FAMILY_RE = /^[a-z][a-z0-9]*$/i;

/**
 * 技能名 → 工具族前缀**集合**（0.7.2：一个技能可以放出多个前缀族）。
 *
 * `univer-sheet` → `["univer"]`、`office-docx` → `["office"]`、
 * `browser-skill` → `["bsk"]`（显式别名：插件的工具全叫 `bsk_*`，首段 `browser` 一个都不存在）。
 *
 * 为什么不再是「只取第一段」：族切分原本假设技能名首段 = 插件工具前缀，而
 * `@wxg-prc-cpg/browser-skill-dsh-plugin` 打破了这个假设 —— 信号送到了，族内却全量漏放。
 *
 * @param {string} skillName 技能名（允许带 `skill:` 前缀，函数自己剥）
 * @returns {string[]} 族前缀数组（去重、保序）；切不出来时返回空数组
 */
export function skillFamiliesOf(skillName) {
  const prefixes = toolPrefixesForSkill(skillName);
  const out = [];
  for (const prefix of Array.isArray(prefixes) ? prefixes : []) {
    if (!FAMILY_RE.test(prefix) || !isToolPrefix(prefix)) continue;
    if (!out.includes(prefix)) out.push(prefix);
  }
  return out;
}

/**
 * 技能名 → **第一个**工具族前缀（兼容口：旧调用方与单族技能）。
 *
 * 多前缀场景请用 {@link skillFamiliesOf}：只看第一个会漏放其余前缀族。
 *
 * @param {string} skillName 技能名（允许带 `skill:` 前缀，函数自己剥）
 * @returns {string} 族前缀；切不出来时返回空串
 */
export function skillFamilyOf(skillName) {
  const families = skillFamiliesOf(skillName);
  return families.length > 0 ? families[0] : "";
}

/** 名字是否属于某个前缀族（族本身，或 `<族>_` 前缀）。 */
export function inFamily(name, family) {
  if (typeof name !== "string" || name.length === 0) return false;
  if (typeof family !== "string" || family.length === 0) return false;
  return name === family || name.startsWith(family + "_");
}

/**
 * 该技能族对应的工具名。
 *
 * 判据只有两条：名字就是族本身，或以 `<族>_` 开头。不做模糊匹配 —— 误放会把
 * 用户明确藏起来的工具塞回工具表（那是 0.5.3 之前最贵的那次前缀失效）。
 * 0.7.2：族可能是多个前缀（`browser-skill` → `bsk`），逐个前缀用同一条判据。
 *
 * @param {string} skillName 技能名
 * @param {Iterable<string>} names 候选工具名
 * @returns {string[]} 命中的工具名（去重、排序后）
 */
export function familyToolNames(skillName, names) {
  const families = skillFamiliesOf(skillName);
  if (families.length === 0) return [];
  const out = new Set();
  for (const name of names) {
    for (const family of families) {
      if (inFamily(name, family)) { out.add(name); break; }
    }
  }
  return [...out].sort();
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

/**
 * 批量族切分（C46 / D12）：一次 gate_load 里可能带多个技能，放行集合必须**一次求出** ——
 * 0.5.7 是逐个技能查一遍宿主视图（每个技能一次 visibleNames → 一次全量集合拷贝），
 * 技能多了就是 O(技能数 × 工具数)。这里先把技能名折成族前缀集合，再对工具名单扫一遍。
 *
 * @param {Iterable<string>} skillNames
 * @returns {Set<string>} 族前缀集合（切不出族的名字直接丢）
 */
export function familiesOf(skillNames) {
  const families = new Set();
  for (const name of Array.isArray(skillNames) ? skillNames : []) {
    // 0.7.2：一个技能可能对应多个前缀族（显式别名），全部并进来 ——
    // 只取第一个会把 bsk 之外的映射漏放。
    for (const family of skillFamiliesOf(name)) families.add(family);
  }
  return families;
}

/** 名字是否属于给定族集合（族本身或 <族>_ 前缀；与 familyToolNames 同一条判据）。 */
export function inFamilies(name, families) {
  if (typeof name !== "string" || name.length === 0) return false;
  for (const family of families) {
    if (inFamily(name, family)) return true;
  }
  return false;
}

/**
 * 一次批量求出「这批技能能放出哪些工具」。
 * 纪律与 pickPromotable 完全一致（explicit off 绝不放、已常驻不放、排序稳定），
 * 只是族成员集合只解析一次。
 *
 * @param {{skillNames: string[], names: Iterable<string>, off?: Set<string>, resident?: Set<string>}} input
 * @returns {string[]}
 */
export function pickPromotableBatch(input) {
  const { skillNames } = input || {};
  const off = input.off instanceof Set ? input.off : new Set();
  const resident = input.resident instanceof Set ? input.resident : new Set();
  const families = familiesOf(skillNames);
  if (families.size === 0) return [];
  const out = [];
  for (const name of input.names || []) {
    if (typeof name !== "string" || name.length === 0) continue;
    if (!inFamilies(name, families)) continue;
    if (off.has(name) || resident.has(name)) continue;
    out.push(name);
  }
  return out.sort();
}
