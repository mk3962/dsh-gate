/**
 * S1 契约夹具的子进程侧（FG-5 的两态适配器观测）。
 *
 * 单独开进程是因为模块级缓存：同进程里只能看到第一态。父进程按 DSH_GATE_STUB_LLM=present|absent
 * 起两次，把 JSON 打回来做对拍；两种模式必须满足同一组不变量（确定性 id、正文、source、块保真）。
 */
import { createGateUserMessage, messageConstructionState } from "../../lib/messages.js";

const source = { kind: "gate-tail", via: "s1-adapter" };
const text = "S1 尾块正文：同一份正文重放两次必须得到同一个标识。";
const image = { type: "image", source: { mediaType: "image/png", data: "iVBORw0KGgo=" } };

const first = await createGateUserMessage({ source, text, idPrefix: "gate-tail" });
const again = await createGateUserMessage({ source, text, idPrefix: "gate-tail" });
const withBlocks = await createGateUserMessage({ source, text: "", idPrefix: "gate-tail", blocks: [image, { type: "text", text }] });

const payload = {
  requested: process.env.DSH_GATE_STUB_LLM || "absent",
  state: messageConstructionState(),
  id: first.id,
  deterministic: first.id === again.id,
  text: first.content.filter((block) => block.type === "text").map((block) => block.text).join(""),
  sourceKind: first.source && first.source.kind,
  role: first.role,
  frozen: Object.isFrozen(first),
  blocksPreserved: JSON.stringify(withBlocks.content) === JSON.stringify([image, { type: "text", text }]),
};
console.log(JSON.stringify(payload));
