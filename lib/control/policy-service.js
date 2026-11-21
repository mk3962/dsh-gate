/**
 * 策略服务（0.6.0 工单 #06 · 路由 /policy 的领域面）
 *
 * GET 读回 v3 形状；POST 走 core.savePolicyFile（表驱动合并 + 无 BOM 落盘 + 重解析 + 重算）。
 * 所有状态码来自 fromLegacy 的唯一映射：**保存失败绝不会 200**（F70）。
 */
import { fromLegacy } from "./result.js";

export function createPolicyService(core) {
  return {
    get() {
      return { status: 200, body: core.readPolicyFile() };
    },
    async post(rc) {
      const result = await core.savePolicyFile(rc && rc.body);
      return fromLegacy(result);
    },
  };
}
