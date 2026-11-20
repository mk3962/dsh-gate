/**
 * @deepseek-ai/dsh-llm 的离线替身（票 01 · FG-5 的「模块存在」一态）。
 *
 * 只模拟 gate 用到的那一件事：createUserMessage({ content, source }) 返回一条带确定性 id 的
 * user 消息，并把 content 里的**结构化块原样保留**（多模态 / 段落注入都靠这一条）。
 *
 * id 必须确定性：lib/messages.js 的退化分支用正文哈希，宿主分支同样不能带随机数，
 * 否则「同一份正文重放两次」的字节不变量（尾块 / 前缀缓存）在宿主分支上就断了。
 * 真机宿主是否也这样由 S1b 探针另行观测；这里只保证契约夹具能对两态用同一组断言。
 */
import { createHash } from "node:crypto";

const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
};

const deepFreeze = (value) => {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
};

export const createUserMessage = (input) => {
  const spec = input || {};
  const content = spec.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new TypeError("createUserMessage({ content }) requires a non-empty content array");
  }
  for (const block of content) {
    if (block === null || typeof block !== "object" || typeof block.type !== "string") {
      throw new TypeError("createUserMessage() content blocks must be { type: string, ... }");
    }
  }
  const seed = canonical({ content, source: spec.source === undefined ? null : spec.source });
  const id = "msg-" + createHash("sha1").update(seed).digest("hex").slice(0, 16);
  return deepFreeze({ id, role: "user", content: content.map((block) => ({ ...block })), source: spec.source });
};

export default { createUserMessage };
