/**
 * Node ESM 解析钩子：把裸包名 "@deepseek-ai/dsh-tools" 指到 test/vendor 下的离线替身。
 * 真实宿主里这个包由 app.asar 提供，仓库里不 vendor 真实实现，
 * 也不靠 node_modules（那样要么提交依赖树，要么要求先 npm install）。
 */
const STUB = new URL("./vendor/dsh-tools/index.js", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@deepseek-ai/dsh-tools") {
    return { url: STUB, format: "module", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
