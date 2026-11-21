/**
 * 只读诊断端点（0.6.0 工单 #06 · GET /api/dsh-gate/diagnostics）
 *
 * 回答四个问题，固定四组键（形状稳定，#07 直接消费）：
 *   read       —— 这次策略读到了什么（来源、读取分类、revision、时间戳、各层贡献、格式版本、
 *                 迁移来源与目标、告警、最近写入审计）
 *   decisions  —— 每个名字为什么是这个层值（轴、命中键、层值、桶、原因、是否被过滤、被谁过滤）
 *   runtime    —— 控制面自己的运行态（访问统计、重算/预扫描计数、MCP 状态计数、守卫运行态）
 *   errors     —— 各吞错桶计数与最近样本（有界；含宿主能力缺失与鉴权回退）
 *
 * 三条硬边界：
 *   1. **只读**：只调 core/gate 的只读投影，不落盘、不 reapply、不 mount。
 *   2. **不改 gate_status 的键集与顺序**（新指标绝不进那 18 键）。
 *   3. 不写任何提示词字节（A-12 部分放开的前提）；本路由只回 JSON。
 */
const MAX_DECISION_ROWS = 300;
const MAX_LIST = 40;

const isObject = (value) => value !== null && typeof value === "object" && Array.isArray(value) === false;
const num = (value) => (Number.isFinite(value) ? value : 0);

/** 安全调用：任何投影失败都落成 {available:false, reason}，绝不让诊断端点 500。 */
function safe(fn, fallback) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch (error) {
    return Object.assign({ available: false, reason: String((error && error.message) || error) }, fallback || {});
  }
}

/** 能力视图行 → 决策链行（字段名按 03 的决策对象优先，缺失时才退回旧名）。 */
function decisionOf(kind, row, index) {
  const source = isObject(row) ? row : {};
  const name = typeof source.name === "string" ? source.name : typeof source.id === "string" ? source.id : "";
  const via = isObject(source.via) ? source.via : {};
  const exception = isObject(source.exception) ? source.exception : undefined;
  const bucket = typeof source.bucket === "string" ? source.bucket : undefined;
  const filtered = bucket === "off" || source.shadowed === true || source.denied === true || source.filtered === true;
  const by = typeof source.filteredBy === "string" ? source.filteredBy
    : typeof source.by === "string" ? source.by
      : typeof source.rule === "string" ? source.rule
        : via.key !== undefined ? "capability:" + String(via.key) : undefined;
  return {
    index,
    kind,
    name,
    axis: typeof source.axis === "string" ? source.axis : kind,
    hitKey: source.hitKey !== undefined ? source.hitKey
      : via.key !== undefined ? via.key
        : typeof source.capability === "string" ? source.capability : undefined,
    tier: Number.isFinite(source.tier) ? source.tier : undefined,
    bucket,
    reason: typeof source.reason === "string" ? source.reason : undefined,
    filtered,
    by,
    deviation: source.deviation !== undefined ? source.deviation : undefined,
    exception: exception === undefined ? undefined : { id: exception.id, tier: exception.tier, until: exception.until },
  };
}

/**
 * @param {{core:object, env:object, metrics:object, ledger:object, gate:object}} deps
 */
export function createDiagnosticsService(deps) {
  const core = deps.core;
  const metrics = deps.metrics;
  const ledger = deps.ledger;
  const env = deps.env;
  const gate = deps.gate;

  const readGroup = () => {
    const read = safe(() => core.readDiagnostic(), { available: false });
    return isObject(read) ? read : { available: false };
  };

  const decisionsGroup = (agent) => {
    if (agent === undefined || agent === null) {
      return { available: false, reason: "no-agent", decisions: [], totals: { capabilities: 0, sections: 0, skills: 0, filtered: 0 } };
    }
    const view = safe(() => (typeof gate.capabilityView === "function" ? gate.capabilityView(agent) : undefined), {});
    if (!isObject(view) || Object.keys(view).length === 0) {
      return { available: false, reason: "capability-view-unavailable", decisions: [], totals: { capabilities: 0, sections: 0, skills: 0, filtered: 0 } };
    }
    const rows = [];
    const totals = { capabilities: 0, sections: 0, skills: 0, filtered: 0 };
    const push = (kind, list) => {
      if (!Array.isArray(list)) return;
      totals[kind === "capability" ? "capabilities" : kind === "section" ? "sections" : "skills"] = list.length;
      for (const row of list) {
        if (rows.length >= MAX_DECISION_ROWS) return;
        const decision = decisionOf(kind, row, rows.length);
        if (decision.filtered) totals.filtered += 1;
        rows.push(decision);
      }
    };
    push("capability", view.capabilities);
    push("section", view.sections);
    push("skill", view.skills);
    return {
      available: true,
      agent: String(agent.id || ""),
      defaults: isObject(view.defaults) ? view.defaults : undefined,
      decisions: rows,
      totals: Object.assign(totals, { returned: rows.length, truncated: rows.length >= MAX_DECISION_ROWS }),
    };
  };

  /** MCP 各状态计数（有界：只数 state，不列行）。 */
  const mcpCounts = () => {
    const snapshot = safe(() => core.mcpServers(), { servers: [], warnings: [] });
    const byState = {};
    for (const row of Array.isArray(snapshot.servers) ? snapshot.servers : []) {
      const state = row && typeof row.state === "string" ? row.state : "unknown";
      byState[state] = (byState[state] || 0) + 1;
    }
    return {
      total: Array.isArray(snapshot.servers) ? snapshot.servers.length : 0,
      byState,
      warnings: Array.isArray(snapshot.warnings) ? snapshot.warnings.slice(0, MAX_LIST) : [],
      writable: core.policy.enabled !== false && gate.mcpManager !== undefined,
    };
  };

  /** 守卫（#04）运行态：只取计数与窗口，不取全量名单（有界）。 */
  const restriction = (agent) => {
    if (typeof gate.restrictionState !== "function") return { available: false, reason: "unsupported" };
    return safe(() => {
      const state = gate.restrictionState(agent);
      if (!isObject(state)) return { available: false, reason: "empty" };
      return {
        available: true,
        mode: state.mode,
        count: num(state.count),
        pending: Array.isArray(state.pending) ? state.pending.length : num(state.pending),
        revoked: Array.isArray(state.revoked) ? state.revoked.length : num(state.revoked),
        windowOpen: state.windowOpen === true,
        leases: Array.isArray(state.leases) ? state.leases.length : num(state.leases),
        deny: Array.isArray(state.deny) ? state.deny.length : num(state.deny),
        key: typeof state.key === "string" ? state.key : undefined,
      };
    }, { available: false });
  };

  const runtimeGroup = (agent) => {
    const stats = core.stats;
    return {
      control: safe(() => metrics.snapshot(), {}),
      uptimeMs: Date.now() - num(stats.startedAt),
      counters: {
        policyWrites: num(stats.policyWrites),
        policyWriteFailures: num(stats.policyWriteFailures),
        policyUnchanged: num(stats.policyUnchanged),
        reapplyPasses: num(stats.reapplyPasses),
        prescans: num(stats.prescans),
        prescanFailures: num(stats.prescanFailures),
        prescanCacheHits: num(stats.prescanCacheHits),
        batchOps: num(stats.batchOps),
        mcpOps: num(stats.mcpOps),
      },
      prescan: safe(() => core.prescanStatus(), { cached: false }),
      agents: safe(() => ({ count: core.knownAgentIds().length, ids: core.knownAgentIds().slice(0, MAX_LIST) }), { count: 0, ids: [] }),
      mcp: mcpCounts(),
      restriction: restriction(agent),
      auth: safe(() => env.snapshot(), {}),
      skills: safe(() => {
        const config = core.currentSkillsConfig();
        return { takeover: config.takeover, off: config.off.length, imports: config.imports.length };
      }, {}),
    };
  };

  const errorsGroup = () => {
    const snapshot = safe(() => ledger.snapshot(), { buckets: [], total: 0 });
    return isObject(snapshot) ? snapshot : { buckets: [], total: 0 };
  };

  return {
    async get(rc) {
      const want = rc && rc.want;
      const agent = core.currentAgent(want);
      const id = agent !== undefined && agent !== null ? String(agent.id || "") : null;
      return {
        status: 200,
        body: {
          ok: true,
          agent: id,
          generatedAt: new Date().toISOString(),
          read: readGroup(),
          decisions: decisionsGroup(agent),
          runtime: runtimeGroup(agent),
          errors: errorsGroup(),
        },
      };
    },
  };
}
