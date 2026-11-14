/**
 * 仅用于离线测试的替身：@deepseek-ai/dsh-tools/pipeline 的两个导出。
 * 真实宿主里它们跑完整执行管线（参数校验 → pre-execute 守卫 → 工具 execute → 输出校验）；
 * 这里只保留本仓需要断言的那部分语义：
 *   - arguments 是 JSON 字符串，解析失败 ⇒ 该条 isError 结果；
 *   - 目标工具不在（暂停限制后的）视图里 ⇒ 该条 isError（真实宿主是 UNKNOWN_TOOL）；
 *   - 目标工具的参数不合 schema ⇒ 该条 isError（真实宿主把 ToolArgsError 变成结果，不抛）；
 *   - 工具 execute 抛错 ⇒ 该条 isError。
 * guards / 输出 schema 校验没有本仓可断言的行为，不模拟。
 */

export class ToolExecutionPipeline {
  constructor(ctx, options) {
    this.ctx = ctx;
    this.options = options || {};
  }
}

const fail = (text) => ({ content: [{ type: "text", text: "Error: " + text }], isError: true });

const typeNameOf = (value) => (Array.isArray(value) ? "array" : value === null ? "null" : typeof value);

/** 极简参数校验：只覆盖测试里用得到的 required / type。 */
export function invalidArguments(parameters, args) {
  if (!parameters || typeof parameters !== "object") return undefined;
  const required = Array.isArray(parameters.required) ? parameters.required : [];
  const properties = parameters.properties && typeof parameters.properties === "object" ? parameters.properties : {};
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(args || {}, key)) return 'missing required property "' + key + '"';
  }
  for (const [key, schema] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(args || {}, key)) continue;
    if (!schema || typeof schema.type !== "string") continue;
    if (typeNameOf(args[key]) !== schema.type) {
      return '"' + key + '" should be ' + schema.type + ", got " + typeNameOf(args[key]);
    }
  }
  return undefined;
}

/**
 * 测试钩子：让接下来 N 次 executeToolBatch 直接抛宿主的批量委派失败。
 *
 * 生产体检（2026-11-14）实测这条报错在 gate_call / gate_load(skill) / gate_invoke 上共出现
 * 95 次，且重试一次就能成 —— gate 侧加「只在文案命中时重试一次」的补偿，这里提供可复现的注入点。
 */
let failNextBatch = 0;
export function failBatchTimes(times) {
  failNextBatch = Number(times) || 0;
}

export async function executeToolBatch(input, pipeline, limit) {
  if (failNextBatch > 0) {
    failNextBatch -= 1;
    throw new Error("Tool batch execution failed");
  }
  const calls = input && Array.isArray(input.calls) ? input.calls : [];
  const tools = pipeline && pipeline.ctx && pipeline.ctx.tools;
  const results = [];
  for (const call of calls) {
    let args;
    try { args = JSON.parse(call.arguments === undefined ? "{}" : call.arguments); }
    catch { results.push({ id: call.id, result: fail("invalid arguments: 不是合法 JSON") }); continue; }
    let definition;
    try {
      const view = tools && typeof tools.view === "function" ? tools.view(input.agent) : undefined;
      definition = view && view.visible ? view.visible.get(call.name) : undefined;
    } catch { definition = undefined; }
    if (definition === undefined) {
      results.push({ id: call.id, result: fail('UNKNOWN_TOOL: ' + call.name) });
      continue;
    }
    const invalid = invalidArguments(definition.parameters, args);
    if (invalid !== undefined) {
      results.push({ id: call.id, result: fail("invalid arguments: " + invalid) });
      continue;
    }
    try {
      const value = await definition.execute(args, { ...input, name: call.name, id: call.id });
      results.push({ id: call.id, result: value });
    } catch (error) {
      results.push({ id: call.id, result: fail(String((error && error.message) || error)) });
    }
  }
  return { results };
}
