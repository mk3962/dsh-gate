/**
 * 中文 → 英文词根的别名索引 —— **薄 re-export 兼容层**（0.6.0 · 工单 #05 · 规格 D17）。
 *
 * 别名表本体已并入 lib/catalog.js 的检索实现里（票面要求「别名不再单独成模块」），
 * 这样别名与打分口径只有一处定义、不会漂。这个文件保留下来只为**不破坏外部引用**：
 * 老代码 import { cjkKeywordsOf } from "./search-alias.js" 仍然可用。
 *
 * 新代码请直接从 ./catalog.js 取（CJK_ALIASES / hasCjk / cjkKeywordsOf / cjkTermsOf / ALIAS_DOMAINS）。
 * 这里不定义任何别名，也不做任何加工 —— 单一来源在 catalog.js。
 */
export {
  ALIAS_DOMAINS,
  CJK_ALIASES,
  cjkKeywordsOf,
  cjkTermsOf,
  hasCjk,
} from "./catalog.js";
