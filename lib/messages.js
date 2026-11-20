/**
 * gate 注入消息的统一构造入口（0.5.3）。
 *
 * 底座从来只有一条纪律：**优先用宿主的 createUserMessage（带 id 与深冻结），拿不到才退化成同形状对象**。
 * 退化 id 必须是确定性的（正文哈希）而不是随机数 —— 同一份正文重放时逐字节一致，否则每步 id
 * 都变，前缀缓存就从这条消息处断掉（一次 gate_load 约 170 token 的重复成本）。
 *
 * 0.5.3 起「重复调用护栏」（lib/guardrail.js）也要发消息，构造逻辑就该只有一份；
 * 另一条路是让护栏自己去 import dsh-llm 并复制一遍退化分支 —— 两处 id 文法一旦走偏，
 * 排查成本远高于多一个 60 行的模块。
 */

import { createHash } from "node:crypto";

/**
 * 宿主 createUserMessage 的模块级缓存：
 *   undefined = 还没探过 · null = 探过但没有（宿主包不在本 profile 可解析范围） · function = 拿到了。
 */
let createUserMessageImpl;

/**
 * 构造两态的观测状态（票 01 · FG-5 的「缺失态必须记录原因」）。
 * 只增不改：不参与任何判定，纯粹给契约夹具 / 诊断读「这次走的是哪一态、为什么」。
 *   mode: "host"（宿主编译器）| "fallback"（退化对象）| "unknown"（还没探过）
 *   reason: "resolved" | "no-export" | "module-missing" | "constructor-threw" | "not-probed"
 */
let construction = { mode: "unknown", reason: "not-probed" };

export const messageConstructionState = () => ({ ...construction });

const loadCreateUserMessage = async () => {
  try {
    const llm = await import("@deepseek-ai/dsh-llm");
    if (typeof llm.createUserMessage === "function") {
      createUserMessageImpl = llm.createUserMessage;
      construction = { mode: "host", reason: "resolved" };
    } else {
      createUserMessageImpl = null;
      construction = { mode: "fallback", reason: "no-export" };
    }
  } catch (error) {
    createUserMessageImpl = null;
    construction = { mode: "fallback", reason: "module-missing", error: String((error && error.message) || error) };
  }
  return createUserMessageImpl;
};

/**
 * 建一条 gate 注入的 user 消息。
 *
 * @param {object} spec
 * @param {object} spec.source  消息来源标记（`kind` 必填：它是宿主/其它插件认出「这条是谁发的」的唯一凭据）
 * @param {string} spec.text    正文（单段 text content）
 * @param {string} spec.idPrefix 退化 id 的前缀（宿主实现可用时不用它）
 * @param {string} [spec.idSeed] 退化 id 的哈希种子，默认取正文
 * @returns {Promise<object>} UserMessage
 */
export const createGateUserMessage = async (spec) => {
  const source = spec.source;
  const text = spec.text;
  // 两条路共用同一份 content：只给 text 就是单段文本；给 blocks 就原样带上（多模态 /
  // 结构化块保真，FG-5 / P1-8 的夹具入口）——两种模式都不许把非 text 块 stringify。
  const content = Array.isArray(spec.blocks) && spec.blocks.length > 0 ? spec.blocks : [{ type: "text", text }];
  const input = { content, source };
  if (createUserMessageImpl === undefined) await loadCreateUserMessage();
  if (createUserMessageImpl !== null) {
    try { return createUserMessageImpl(input); }
    catch (error) {
      construction = { mode: "fallback", reason: "constructor-threw", error: String((error && error.message) || error) };
      /* 退化成同形状对象 */
    }
  }
  const seed = spec.idSeed === undefined ? text : spec.idSeed;
  const digest = createHash("sha1").update(seed).digest("hex").slice(0, 12);
  return Object.assign({ role: "user" }, input, { id: spec.idPrefix + "-" + digest });
};

/** 测试用：清掉已缓存的宿主实现（要断言退化分支时必须先清）。 */
export const resetCreateUserMessageCache = () => {
  createUserMessageImpl = undefined;
  construction = { mode: "unknown", reason: "not-probed" };
};
