/**
 * 「@deepseek-ai/dsh-llm 不存在」一态（票 01 · FG-5 的模块缺失分支）。
 *
 * 由 test/stub-resolver.mjs 在 DSH_GATE_STUB_LLM=absent（默认）时把裸包名指到这里：
 * 模块求值即抛，lib/messages.js 的 dynamic import 于是 reject —— 走的正是真机上
 * 「profile 里没装 dsh-llm」时的退化路径。显式指过来（而不是让 Node 自己找不到）
 * 是为了让两态在有无 node_modules 的机器上都稳定可复现。
 */
const error = new Error("ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-llm (stub absent mode)");
error.code = "ERR_MODULE_NOT_FOUND";
throw error;
export const createUserMessage = undefined;
