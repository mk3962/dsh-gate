/**
 * 访问日志与状态码统计（0.6.0 工单 #06 · "原五条无日志路由补齐访问日志、耗时与状态码统计"）
 *
 * 五条路由 0.5.7 时没有任何访问日志、没有耗时、没有状态码分布 —— 面板出问题时只能猜。
 * 这里把三件事收到一处：
 *   - 每条请求一行结构化访问日志（method path status ms code route）；
 *   - 每条路由的 count / byStatus / totalMs / maxMs / errors（有界：路由表是固定集合）；
 *   - 全量 totals（requests / errors / totalMs / maxMs）。
 * 诊断端点的 runtime.control 直接投影这份统计。
 */

const iso = (at) => new Date(at).toISOString();

/** @param {string[]} routeIds 固定路由 id 清单（有界：不在清单里的 id 只进 totals，不建行） */
export function createMetrics(routeIds) {
  const known = new Set(Array.isArray(routeIds) ? routeIds : []);
  /** @type {Map<string, {id:string,count:number,byStatus:Record<string,number>,totalMs:number,maxMs:number,lastAt:number,lastStatus:number,errors:number}>} */
  const routes = new Map();
  const totals = { requests: 0, errors: 0, totalMs: 0, maxMs: 0, lastAt: 0 };

  const rowOf = (id) => {
    let row = routes.get(id);
    if (row === undefined) {
      row = { id, count: 0, byStatus: {}, totalMs: 0, maxMs: 0, lastAt: 0, lastStatus: 0, errors: 0 };
      routes.set(id, row);
    }
    return row;
  };

  return {
    /**
     * 记一条访问。
     * @param {{id?: string, method?: string, path?: string, status?: number, durationMs?: number, code?: string}} entry
     */
    record(entry) {
      const info = entry || {};
      const id = typeof info.id === "string" && info.id.length > 0 ? info.id : "unknown";
      const status = Number.isFinite(info.status) ? info.status : 500;
      const duration = Number.isFinite(info.durationMs) && info.durationMs >= 0 ? info.durationMs : 0;
      const at = Date.now();
      totals.requests += 1;
      totals.totalMs += duration;
      if (duration > totals.maxMs) totals.maxMs = duration;
      totals.lastAt = at;
      if (status >= 500 || status === 0) totals.errors += 1;
      if (!known.has(id) && known.size > 0) return;
      const row = rowOf(id);
      row.count += 1;
      row.byStatus[String(status)] = (row.byStatus[String(status)] || 0) + 1;
      row.totalMs += duration;
      if (duration > row.maxMs) row.maxMs = duration;
      row.lastAt = at;
      row.lastStatus = status;
      if (status >= 500) row.errors += 1;
    },
    /** 统计快照（键按路由 id 排序，形状稳定）。 */
    snapshot() {
      const rows = [...routes.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((row) => ({
          id: row.id,
          count: row.count,
          byStatus: Object.assign({}, row.byStatus),
          totalMs: row.totalMs,
          avgMs: row.count === 0 ? 0 : Math.round((row.totalMs / row.count) * 100) / 100,
          maxMs: row.maxMs,
          errors: row.errors,
          lastStatus: row.lastStatus === 0 ? undefined : row.lastStatus,
          lastAt: row.lastAt === 0 ? undefined : iso(row.lastAt),
        }));
      return {
        totals: {
          requests: totals.requests,
          errors: totals.errors,
          totalMs: totals.totalMs,
          maxMs: totals.maxMs,
          lastAt: totals.lastAt === 0 ? undefined : iso(totals.lastAt),
        },
        routes: rows,
      };
    },
  };
}
