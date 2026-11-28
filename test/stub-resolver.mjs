/**
 * Node ESM 解析钩子（票 01 升级为两态适配器）。
 *
 * 态一 · 工具包映射（既有）：把裸包名 "@deepseek-ai/dsh-tools" 与子路径 /pipeline 指到
 *   test/vendor 下的离线替身。真实宿主里这些由 app.asar 提供，仓库里不 vendor 真实现，
 *   也不靠 node_modules（那样要么提交依赖树，要么要求先 npm install）。
 *
 * 态二 · 消息构造两态（FG-5）：@deepseek-ai/dsh-llm 由 DSH_GATE_STUB_LLM 决定 ——
 *   "present" → test/vendor/dsh-llm/index.js（真实形状构造器 + 确定性 id，结构化块保留）
 *   其它/未设  → test/vendor/dsh-llm/absent.js（模块求值即抛 ⇒ 走 fail-open 退化分支）
 *   两态都 shortCircuit，机器上恰好装了真包也不会让「缺失态」变得不可复现。
 *
 * 另：DSH_GATE_STUB_LLM_PATH 可把 present 态指到别的实现 —— 只给「删分支必须红」的
 *   定点破坏用（把 id 改成随机数，确定性断言必须变红）。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const STUB = new URL("./vendor/dsh-tools/index.js", import.meta.url).href;
// 0.2.x 的批量执行入口（gate_invoke 的转发管线，工单 07）。
// 子路径必须单独映射：上面的精确匹配不会把 "@deepseek-ai/dsh-tools/pipeline" 一起带走。
const PIPELINE_STUB = new URL("./vendor/dsh-tools/pipeline.js", import.meta.url).href;

const LLM_PRESENT = (() => {
  const override = process.env.DSH_GATE_STUB_LLM_PATH;
  if (override === undefined || override === "") return new URL("./vendor/dsh-llm/index.js", import.meta.url).href;
  return path.isAbsolute(override) ? pathToFileURL(override).href : new URL(override, import.meta.url).href;
})();
const LLM_ABSENT = new URL("./vendor/dsh-llm/absent.js", import.meta.url).href;
export const llmMode = () => ((process.env.DSH_GATE_STUB_LLM || "absent").toLowerCase() === "present" ? "present" : "absent");

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@deepseek-ai/dsh-tools") {
    return { url: STUB, format: "module", shortCircuit: true };
  }
  if (specifier === "@deepseek-ai/dsh-tools/pipeline") {
    return { url: PIPELINE_STUB, format: "module", shortCircuit: true };
  }
  if (specifier === "@deepseek-ai/dsh-llm") {
    return { url: llmMode() === "present" ? LLM_PRESENT : LLM_ABSENT, format: "module", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
