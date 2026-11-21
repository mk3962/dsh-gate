/**
 * MCP 服务（0.6.0 工单 #06 · 路由 /mcp 的领域面）
 *
 * 从 0.5.7 的 handleMcpPost 逐分支搬出，只把 "writeJson(res, s, body)" 改成 "return {status:s, body}"。
 * 状态码与文案保持原样；错误码换成稳定的业务码（MCP_CONFLICT / MCP_NOT_FOUND / …），
 * 只有 normalizeServerConfig 抛出的业务码（invalid-server-name 等）原样透传 —— 那是 MCP 领域码。
 */
import { ControlPlaneError, ERROR_CODES, SERVICE_CODES } from "./errors.js";
import { fromLegacy } from "./result.js";
import { normalizeServerConfig } from "../mcp.js";

const isPlainObject = (value) => value !== null && typeof value === "object" && Array.isArray(value) === false;

export function createMcpService(core) {
  const bad = (message, details) => new ControlPlaneError(ERROR_CODES.INVALID_BODY, message, details);

  const list = () => {
    const body = core.mcpServers(core.currentAgent(undefined));
    // UI 靠这个字段决定是否给出写操作（add/update/remove/enable/disable）。
    return { status: 200, body: Object.assign({ writable: core.policy.enabled !== false && core.gate.mcpManager !== undefined }, body) };
  };

  const post = async (rc) => {
    const body = rc && rc.body;
    const action = body.action;
    if (!["add", "update", "remove", "enable", "disable"].includes(action)) {
      throw bad("action 只能是 add / update / remove / enable / disable", { action });
    }
    if (core.policy.enabled === false) {
      throw new ControlPlaneError(SERVICE_CODES.GATE_DISABLED, "闸门未启用（enabled=false），不接管 MCP");
    }
    const manager = core.gate.mcpManager;
    if (!manager) throw new ControlPlaneError(SERVICE_CODES.MCP_UNAVAILABLE, "MCP 接管不可用（manager 不存在）");
    const name = body.name;
    if (typeof name !== "string" || name.length === 0) throw bad("name 必须是非空字符串");
    core.stats.mcpOps += 1;

    const servers = Object.assign({}, core.declaredMcpServers());
    const mounted = new Set();
    try {
      if (typeof manager.list === "function") {
        for (const row of manager.list() || []) if (row && row.owned === true) mounted.add(row.name);
      }
    } catch { /* 读不到就当未挂，下一步 mount 会给出准确冲突 */ }
    const isMounted = mounted.has(name) || (typeof manager.state === "function" && manager.state(name) !== undefined);

    const finish = (extra) => {
      const latest = core.mcpServers();
      return {
        status: 200,
        body: Object.assign({ ok: true, action, name, servers: latest.servers, warnings: latest.warnings }, extra || {}),
      };
    };

    if (action === "add" || action === "update") {
      if (action === "add" && (servers[name] !== undefined || isMounted)) {
        throw new ControlPlaneError(SERVICE_CODES.MCP_CONFLICT, "MCP server \"" + name + "\" 已存在（改用 update）");
      }
      if (action === "update" && servers[name] === undefined && !isMounted) {
        throw new ControlPlaneError(SERVICE_CODES.MCP_NOT_FOUND, "MCP server \"" + name + "\" 不存在");
      }
      let normalized;
      try {
        normalized = normalizeServerConfig(name, core.mcpConfigOf(body));
      } catch (error) {
        // MCP 领域码原样透传（400）；面板按 code 显示具体原因，不挤进 INVALID_BODY。
        throw new ControlPlaneError((error && error.code) || ERROR_CODES.INVALID_BODY, String((error && error.message) || error), undefined, 400);
      }
      const { name: _ignored, ...stored } = normalized;
      servers[name] = stored;
      const saved = await core.savePolicyFile({ mcp: { servers } });
      if (!saved.ok) return fromLegacy(saved);
      let result;
      try {
        result = action === "update" && isMounted ? await manager.update(name, stored) : await manager.mount(name, stored);
      } catch (error) {
        result = { ok: false, name, reason: "exception", message: String((error && error.message) || error) };
      }
      try { core.gate.reapplyAll?.(); } catch { /* 忽略 */ }
      return finish({ result });
    }

    if (action === "remove") {
      if (servers[name] === undefined && !isMounted) {
        throw new ControlPlaneError(SERVICE_CODES.MCP_NOT_FOUND, "MCP server \"" + name + "\" 不存在");
      }
      delete servers[name];
      const saved = await core.savePolicyFile({ mcp: { servers } });
      if (!saved.ok) return fromLegacy(saved);
      let result;
      try {
        result = await manager.unmount(name);
        if (!result.ok) result = { ok: true, name, state: "stopped", note: result.reason };
      } catch (error) {
        result = { ok: false, name, reason: "exception", message: String((error && error.message) || error) };
      }
      try { core.gate.reapplyAll?.(); } catch { /* 忽略 */ }
      return finish({ result });
    }

    // enable / disable
    if (servers[name] === undefined) {
      throw new ControlPlaneError(SERVICE_CODES.MCP_NOT_FOUND, "MCP server \"" + name + "\" 未声明（先 add）");
    }
    const enabled = action === "enable";
    servers[name] = Object.assign({}, servers[name], { enabled });
    const saved = await core.savePolicyFile({ mcp: { servers } });
    if (!saved.ok) return fromLegacy(saved);
    let result;
    try {
      if (enabled) {
        result = isMounted
          ? { ok: true, name, state: "owned", note: "already-mounted" }
          : await manager.mount(name, servers[name]);
      } else {
        const unmounted = await manager.unmount(name);
        result = unmounted.ok ? unmounted : { ok: true, name, state: "stopped", note: unmounted.reason };
      }
    } catch (error) {
      result = { ok: false, name, reason: "exception", message: String((error && error.message) || error) };
    }
    try { core.gate.reapplyAll?.(); } catch { /* 忽略 */ }
    return finish({ result });
  };

  return { get: list, post };
}
