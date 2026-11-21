/**
 * 状态服务（0.6.0 工单 #06 · 路由 /state 的领域面）
 * 只挑 agent 并补 UI 视图字段；形状与口径全部来自 core.snapshot（= gate.snapshot 的投影）。
 */
export function createStateService(core) {
  return {
    /** @returns {{status:number, body:object}} */
    get(rc) {
      return { status: 200, body: core.snapshot(rc && rc.want) };
    },
  };
}
