/**
 * 能力视图服务（0.6.0 工单 #06 · 路由 /capabilities 的领域面）
 * 0.5.7 的三分支原样保留：无 agent / 宿主没有 capabilityView / 正常视图。
 */
import { capabilityState } from "../capabilities.js";

export function createCapabilitiesService(core) {
  return {
    get(rc) {
      const agent = core.currentAgent(rc && rc.want);
      if (agent === undefined || agent === null) {
        return { status: 200, body: Object.assign({ agent: null }, capabilityState(core.policy, {})) };
      }
      const id = String(agent.id || "");
      if (typeof core.gate.capabilityView !== "function") {
        return { status: 200, body: Object.assign({ agent: id }, capabilityState(core.policy, {})) };
      }
      return { status: 200, body: Object.assign({ agent: id }, core.gate.capabilityView(agent)) };
    },
  };
}
