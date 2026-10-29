/** 仅用于离线加载测试的替身：真实宿主里由 app.asar 提供。 */
export function defineTool(definition) {
  if (!definition || typeof definition.name !== "string") throw new TypeError("defineTool: name required");
  if (typeof definition.execute !== "function") throw new TypeError("defineTool: execute required");
  if (!definition.output || typeof definition.output.render !== "function") throw new TypeError("defineTool: output.render required");
  return { ...definition };
}
