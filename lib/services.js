/**
 * 宿主服务解析的唯一实现（D14/D49）。
 *
 * 为什么单独一个模块：领域层（技能发现、命名、归层决策）要用「拿一个宿主服务」这件小事，
 * 但领域层**不许** import HTTP 控制面模块（server.js 带 webServer 路由与鉴权）。
 * 把这两行的解析链抽到这里，领域层只依赖这个无副作用的适配原语。
 */

const isObjectLike = (value) => value !== null && typeof value === "object";

/**
 * 解析宿主服务：先走官方面板同一口径的 `ctx.get(name)`，再退回 cordis 的
 * `ctx.reflect.get(name, false)`（非抛错读法）。都拿不到返回 undefined。
 *
 * @param {object} ctx 插件 ctx（或任何带 get/reflect 的对象）
 * @param {string} name 服务名
 * @returns {any}
 */
export const resolveService = (ctx, name) => {
  try {
    if (ctx !== null && ctx !== undefined && typeof ctx.get === "function") {
      const found = ctx.get(name);
      if (found !== undefined && found !== null) return found;
    }
  } catch { /* 服务解析失败交给回退链 */ }
  try {
    if (isObjectLike(ctx) && ctx.reflect && typeof ctx.reflect.get === "function") {
      const found = ctx.reflect.get(name, false);
      if (found !== undefined && found !== null) return found;
    }
  } catch { /* 回退链读不到就算没有 */ }
  return undefined;
};

/** 服务是否有某个方法（能力探测；不做缓存，缓存由适配层负责）。 */
export const serviceHas = (ctx, name, method) => {
  const service = resolveService(ctx, name);
  if (service === undefined || service === null) return false;
  if (method === undefined) return true;
  return typeof service[method] === "function";
};
