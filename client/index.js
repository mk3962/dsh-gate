window.__ModuleLoader__.load({
  id: "dsh-gate",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const react = require("react");
    const h = react.createElement;

    const CSS = [
      ".dshg-wrap{--dshg-border:var(--dsw-alias-border-l1,rgba(0,0,0,.1));--dshg-border2:var(--dsw-alias-border-l2,rgba(0,0,0,.18));--dshg-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));--dshg-layer:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));--dshg-label:var(--dsw-alias-label-primary,#1d1d1f);--dshg-sub:var(--dsw-alias-label-secondary,#6e6e73);--dshg-faint:var(--dsw-alias-label-tertiary,#8e8e93);--dshg-business:var(--dsw-alias-state-business-primary,#0a84ff);--dshg-success:var(--dsw-alias-state-success-primary,#34c759);--dshg-warn:var(--dsw-alias-state-warn-primary,#ff9f0a);--dshg-error:var(--dsw-alias-state-error-primary,#ff453a);color:var(--dshg-label);font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,Segoe UI,system-ui,sans-serif);display:flex;flex-direction:column;gap:12px;font-size:12.5px;line-height:1.5}",
      ".dshg-top{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap}",
      ".dshg-title{font-weight:650;font-size:15px;letter-spacing:.2px}",
      ".dshg-sub{color:var(--dshg-sub);font-size:11.5px;word-break:break-all}",
      ".dshg-grow{flex:1 1 240px;min-width:0}",
      ".dshg-card{border:1px solid var(--dshg-border);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-base,transparent)}",
      ".dshg-cardHead{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 12px;font-weight:600;font-size:12px;background:var(--dshg-layer);border-bottom:1px solid var(--dshg-border)}",
      ".dshg-cardBody{display:flex;flex-direction:column;gap:10px;padding:10px 12px}",
      ".dshg-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(102px,1fr));gap:8px}",
      ".dshg-stat{border:1px solid var(--dshg-border);border-radius:10px;padding:7px 10px;min-width:0}",
      ".dshg-stat b{display:block;font-size:17px;line-height:1.2;font-variant-numeric:tabular-nums}",
      ".dshg-stat span{display:block;color:var(--dshg-sub);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshg-stat.is-warn{border-color:var(--dshg-warn)}",
      ".dshg-stat.is-warn b{color:var(--dshg-warn)}",
      ".dshg-stat.is-error{border-color:var(--dshg-error)}",
      ".dshg-stat.is-error b{color:var(--dshg-error)}",
      ".dshg-filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".dshg-input{flex:1 1 230px;min-width:170px;box-sizing:border-box;border:1px solid var(--dshg-border2);border-radius:8px;padding:5px 9px;font-size:12.5px;background:var(--dsw-specific-input-major,transparent);color:inherit;font-family:inherit}",
      ".dshg-select{box-sizing:border-box;border:1px solid var(--dshg-border2);border-radius:8px;padding:4px 6px;font-size:12px;background:var(--dsw-specific-input-major,transparent);color:inherit;font-family:inherit}",
      ".dshg-selectSm{padding:1px 4px;font-size:11px;flex:0 0 auto}",
      ".dshg-btn{border:1px solid var(--dshg-border2);background:transparent;color:inherit;border-radius:7px;font-size:11.5px;padding:3px 8px;cursor:pointer;font-family:inherit;white-space:nowrap}",
      ".dshg-btn:hover:not(:disabled){background:var(--dshg-hover)}",
      ".dshg-btn:disabled{opacity:.45;cursor:default}",
      ".dshg-btn.is-primary{background:var(--dsw-alias-button-info-fill,var(--dshg-business));border-color:var(--dsw-alias-button-info-fill,var(--dshg-business));color:var(--dsw-alias-label-primary-foreground,#fff)}",
      ".dshg-btn.is-primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,var(--dshg-business))}",
      ".dshg-btn.is-danger{color:var(--dshg-error);border-color:var(--dshg-error)}",
      ".dshg-btn.is-on{background:var(--dshg-hover)}",
      ".dshg-list{display:flex;flex-direction:column}",
      ".dshg-cap{display:flex;flex-direction:column;gap:8px;padding:9px 12px;border-top:1px solid var(--dshg-border)}",
      ".dshg-cap:first-child{border-top:0}",
      ".dshg-capMain{display:flex;gap:9px;align-items:flex-start;flex-wrap:wrap}",
      ".dshg-capId{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;font-weight:600;word-break:break-all}",
      ".dshg-capMeta{display:flex;gap:7px;align-items:center;flex-wrap:wrap;color:var(--dshg-sub);font-size:11.5px;margin-top:2px}",
      ".dshg-seg{display:inline-flex;border:1px solid var(--dshg-border2);border-radius:8px;overflow:hidden;flex:0 0 auto}",
      ".dshg-seg button{border:0;background:transparent;color:var(--dshg-sub);padding:3px 9px;font-size:11.5px;cursor:pointer;font-family:inherit}",
      ".dshg-seg button+button{border-left:1px solid var(--dshg-border2)}",
      ".dshg-seg button:hover:not(.is-active){background:var(--dshg-hover)}",
      ".dshg-seg button.is-active{background:var(--dsw-alias-button-info-fill,var(--dshg-business));color:var(--dsw-alias-label-primary-foreground,#fff)}",
      ".dshg-badge{display:inline-flex;align-items:center;border:1px solid var(--dshg-border2);border-radius:999px;padding:1px 7px;font-size:10.5px;font-weight:600;line-height:1.5;flex:0 0 auto}",
      ".dshg-badge[data-kind=mcp]{color:var(--dshg-business);border-color:var(--dshg-business)}",
      ".dshg-badge[data-kind=plugin]{color:var(--dshg-success);border-color:var(--dshg-success)}",
      ".dshg-badge[data-kind=skill]{color:#8e5cd9;border-color:#8e5cd9}",
      ".dshg-badge[data-kind=native]{color:var(--dshg-business);border-color:var(--dshg-border2)}",
      ".dshg-badge[data-kind=section]{color:var(--dshg-sub);border-color:var(--dshg-border2)}",
      ".dshg-badge[data-kind=glob]{color:var(--dshg-faint);border-color:var(--dshg-border2)}",
      ".dshg-badge[data-kind=unknown]{color:var(--dshg-warn);border-color:var(--dshg-warn)}",
      ".dshg-tag{display:inline-flex;align-items:center;border:1px solid var(--dshg-border2);border-radius:5px;padding:0 5px;font-size:10.5px;line-height:1.6;white-space:nowrap}",
      ".dshg-tag.is-warn{color:var(--dshg-warn);border-color:var(--dshg-warn)}",
      ".dshg-tag.is-error{color:var(--dshg-error);border-color:var(--dshg-error)}",
      ".dshg-tag.is-business{color:var(--dshg-business);border-color:var(--dshg-business)}",
      ".dshg-tag.is-ok{color:var(--dshg-success);border-color:var(--dshg-success)}",
      ".dshg-chip{display:inline-flex;align-items:center;border:1px solid var(--dshg-border2);border-radius:5px;padding:0 5px;font-size:10.5px;line-height:1.6;white-space:nowrap}",
      ".dshg-chip[data-tier='1']{color:var(--dshg-success);border-color:var(--dshg-success)}",
      ".dshg-chip[data-tier='2']{color:var(--dshg-warn);border-color:var(--dshg-warn)}",
      ".dshg-chip[data-tier='0']{color:var(--dshg-error);border-color:var(--dshg-error)}",
      ".dshg-detail{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dshg-border);border-radius:10px;padding:8px 10px;background:var(--dshg-layer)}",
      ".dshg-chain{display:flex;gap:4px;align-items:center;flex-wrap:wrap}",
      ".dshg-step{border:1px solid var(--dshg-border);border-radius:5px;padding:0 5px;font-size:10.5px;color:var(--dshg-faint);white-space:nowrap}",
      ".dshg-step.is-hit{color:var(--dshg-business);border-color:var(--dshg-business);background:var(--dshg-hover);font-weight:600}",
      ".dshg-arrow{color:var(--dshg-faint);font-size:10.5px}",
      ".dshg-groupTitle{font-weight:600;font-size:11.5px;margin-top:2px}",
      ".dshg-members{display:flex;flex-direction:column;gap:2px}",
      ".dshg-member{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:3px 0;border-top:1px dashed var(--dshg-border)}",
      ".dshg-member:first-child{border-top:0}",
      ".dshg-memberName{flex:1 1 190px;min-width:110px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;word-break:break-all}",
      ".dshg-reason{color:var(--dshg-sub);font-size:11px}",
      ".dshg-conf{color:var(--dshg-faint);font-size:11px}",
      ".dshg-confirm{display:flex;gap:8px;align-items:center;flex-wrap:wrap;border:1px solid var(--dshg-warn);border-radius:9px;padding:8px 10px;background:var(--dshg-layer)}",
      ".dshg-alerts{display:flex;flex-direction:column;gap:6px}",
      ".dshg-alert{border:1px solid var(--dshg-border2);border-radius:8px;padding:6px 9px;font-size:11.5px;color:var(--dshg-sub)}",
      ".dshg-alert[data-tone=warn]{border-color:var(--dshg-warn);color:var(--dshg-warn)}",
      ".dshg-alert[data-tone=error]{border-color:var(--dshg-error);color:var(--dshg-error)}",
      ".dshg-alert[data-tone=ok]{border-color:var(--dshg-success);color:var(--dshg-success)}",
      ".dshg-preview{display:flex;flex-direction:column;gap:4px;font-size:11.5px}",
      ".dshg-previewRow{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;padding:2px 0;border-top:1px dashed var(--dshg-border)}",
      ".dshg-previewRow:first-child{border-top:0}",
      ".dshg-foot{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".dshg-note{color:var(--dshg-sub);font-size:11.5px}",
      ".dshg-hint{color:var(--dshg-faint);font-size:11px}",
      ".dshg-empty{padding:20px 12px;text-align:center;color:var(--dshg-sub)}",
      ".dshg-json{width:100%;box-sizing:border-box;min-height:280px;resize:vertical;border:1px solid var(--dshg-border2);border-radius:8px;padding:8px;background:var(--dsw-specific-input-major,transparent);color:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.5}",
      ".dshg-jsonMeta{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".dshg-workList{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px;color:var(--dshg-sub)}",
      ".dshg-workList b{color:var(--dshg-label)}",
      ".dshg-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;background:var(--dshg-layer);border-radius:4px;padding:0 4px}",
      ".dshg-spacer{height:2px}",
      "@media (max-width:720px){.dshg-seg button{padding:3px 7px}.dshg-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.dshg-input{flex-basis:100%}}",
    ].join("");

    let styled = false;
    const ensureStyle = () => {
      if (styled || typeof document === "undefined") return;
      styled = true;
      const tag = document.createElement("style");
      tag.setAttribute("data-dsh-gate", "1");
      tag.textContent = CSS;
      document.head.appendChild(tag);
    };

    const TIER_OFF = 0;
    const TIER_RESIDENT = 1;
    const TIER_ONDEMAND = 2;
    const TIER_LABEL = { 0: "关闭", 1: "常驻", 2: "按需" };
    const TIER_ORDER = [TIER_RESIDENT, TIER_ONDEMAND, TIER_OFF];
    const KIND_ORDER = { mcp: 0, plugin: 1, skill: 2, native: 3, unknown: 4, section: 5, glob: 6 };
    const KIND_LABEL = { mcp: "mcp", plugin: "plugin", skill: "skill", native: "native", unknown: "unknown", section: "section", glob: "glob" };
    const KIND_FILTERS = [
      { value: "all", label: "全部来源" },
      { value: "mcp", label: "MCP" },
      { value: "plugin", label: "插件" },
      { value: "skill", label: "技能包" },
      { value: "native", label: "原生" },
      { value: "unknown", label: "未知来源" },
      { value: "section", label: "段落" },
      { value: "glob", label: "通配" },
    ];
    const STATUS_FILTERS = [
      { value: "all", label: "全部档位" },
      { value: "1", label: "常驻" },
      { value: "2", label: "按需" },
      { value: "0", label: "关闭" },
      { value: "exception", label: "有例外/偏离" },
      { value: "pending", label: "有待保存改动" },
    ];
    const REASON_LABEL = {
      own: "own · 自身层（restrict 管不到）",
      preset: "preset · 预设层（未点名则常驻）",
      loaded: "loaded · 本会话已加载",
      protected: "protected · 保护名单",
      unknown: "来源未知 · 只标注不隐藏",
      exception: "例外 · 显式偏离",
      capability: "能力档",
      defaults: "defaults · 默认档",
      declared: "sources 声明，当前表面没有",
    };
    const VIA_LABEL = {
      sources: "显式 sources",
      naming: "命名约定",
      prefix: "包前缀推断",
      native: "原生清单",
      unknown: "推不出来源",
    };
    const CONF_LABEL = { high: "高", medium: "中", low: "低", unknown: "未知" };
    const CONF_RANK = { high: 0, medium: 1, low: 2, unknown: 3 };

    const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    const listOf = (value) => (Array.isArray(value) ? value : []);
    const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const stringify = (value) => JSON.stringify(value, null, 2);
    const bytesOf = (text) => {
      try { return new TextEncoder().encode(text).length; } catch { return text.length; }
    };
    const tierOf = (value, fallback) => {
      const number = Number(value);
      return number === 0 || number === 1 || number === 2 ? number : fallback;
    };
    const tierLabel = (tier) => TIER_LABEL[tierOf(tier, TIER_ONDEMAND)];
    const kindOf = (id) => {
      const text = String(id || "");
      if (text.startsWith("mcp:")) return "mcp";
      if (text.startsWith("skillpack:")) return "skill";
      if (text.startsWith("plugin:")) return "plugin";
      if (text.startsWith("native:")) return "native";
      if (text.startsWith("section:")) return "section";
      if (text.startsWith("glob:")) return "glob";
      return "unknown";
    };
    const warningText = (warning) => {
      if (typeof warning === "string") return warning;
      if (warning && typeof warning.message === "string") return warning.message;
      if (warning && typeof warning.code === "string") return warning.code;
      try { return JSON.stringify(warning); } catch { return String(warning); }
    };

    const api = async (path, options) => {
      const response = await fetch(path, Object.assign({ headers: { "content-type": "application/json" } }, options || {}));
      const text = await response.text();
      let body = null;
      if (text.length > 0) {
        try { body = JSON.parse(text); } catch { body = null; }
      }
      if (!response.ok) {
        const detail = body && (body.message || body.error) ? (body.message || body.error) : "HTTP " + response.status;
        throw new Error(String(detail));
      }
      return body;
    };

    const fallbackTemplate = () => ({
      version: 3,
      enabled: true,
      defaults: { capability: TIER_ONDEMAND, section: TIER_RESIDENT, skillpack: TIER_ONDEMAND },
      capabilities: {
        "native:read": { tier: TIER_RESIDENT },
        "native:write": { tier: TIER_RESIDENT },
        "native:edit": { tier: TIER_RESIDENT },
        "native:grep": { tier: TIER_RESIDENT },
        "native:glob": { tier: TIER_RESIDENT },
        "native:pwsh": { tier: TIER_RESIDENT },
        "native:web_search": { tier: TIER_RESIDENT },
        "native:web_fetch": { tier: TIER_RESIDENT },
        "native:skill": { tier: TIER_RESIDENT },
      },
      sources: {},
      legacy: { unknownOverrides: {} },
      catalog: { groupByPlugin: true, maxDescriptionLength: 64 },
      narrowPassThrough: 12,
      protected: [],
    });

    function GatePanel() {
      ensureStyle();
      const [data, setData] = react.useState(null);
      const [error, setError] = react.useState("");
      const [loading, setLoading] = react.useState(false);
      const [notice, setNotice] = react.useState(null);
      const [query, setQuery] = react.useState("");
      const [sourceFilter, setSourceFilter] = react.useState("all");
      const [statusFilter, setStatusFilter] = react.useState("all");
      const [expanded, setExpanded] = react.useState({});
      const [confirm, setConfirm] = react.useState(null);
      const [pendingCaps, setPendingCaps] = react.useState({});
      const [pendingSkillpack, setPendingSkillpack] = react.useState(undefined);
      const [pendingExceptions, setPendingExceptions] = react.useState({});
      const [reloadConfirm, setReloadConfirm] = react.useState(false);
      const [saving, setSaving] = react.useState(false);
      const [editorOpen, setEditorOpen] = react.useState(false);
      const [jsonText, setJsonText] = react.useState("");
      const [jsonDirty, setJsonDirty] = react.useState(false);
      const [jsonNotice, setJsonNotice] = react.useState(null);
      const [jsonConfirm, setJsonConfirm] = react.useState(null);
      const [workOpen, setWorkOpen] = react.useState(false);

      const reload = react.useCallback(async (message) => {
        setLoading(true);
        try {
          const results = await Promise.all([
            api("/api/dsh-gate/state"),
            api("/api/dsh-gate/capabilities"),
            api("/api/dsh-gate/policy"),
          ]);
          setData({ state: results[0] || {}, view: results[1] || {}, policy: results[2] || {} });
          setError("");
          setPendingCaps({});
          setPendingExceptions({});
          setPendingSkillpack(undefined);
          setConfirm(null);
          setReloadConfirm(false);
          setJsonDirty(false);
          setNotice(message ? { tone: "ok", text: message } : null);
        } catch (failure) {
          setError(String((failure && failure.message) || failure));
        } finally {
          setLoading(false);
        }
      }, []);

      react.useEffect(() => { void reload(""); }, [reload]);

      react.useEffect(() => {
        if (!data) return;
        if (jsonDirty) return;
        setJsonText(stringify(isObject(data.policy && data.policy.content) ? data.policy.content : {}));
      }, [data, jsonDirty]);

      if (error && !data) {
        return h("div", { className: "dshg-wrap" },
          h("div", { className: "dshg-alert", "data-tone": "error" }, "读不到闸门状态：" + error),
          h("div", { className: "dshg-foot" },
            h("button", { className: "dshg-btn", onClick: () => { void reload(""); } }, "重试")));
      }
      if (!data) {
        return h("div", { className: "dshg-wrap" }, h("div", { className: "dshg-note" }, "载入闸门状态…"));
      }

      const state = data.state || {};
      const view = data.view || {};
      const policy = data.policy || {};
      const defaults = isObject(view.defaults) ? view.defaults : (isObject(state.defaults) ? state.defaults : {});
      const defaultsCap = tierOf(defaults.capability, TIER_ONDEMAND);
      const defaultsSec = tierOf(defaults.section, TIER_RESIDENT);
      const defaultsSkill = tierOf(defaults.skillpack, TIER_ONDEMAND);
      const policyCaps = isObject(policy.content) && isObject(policy.content.capabilities) ? policy.content.capabilities : {};
      const toolDecisions = {};
      for (const item of listOf(view.tools)) {
        if (item && typeof item.name === "string") toolDecisions[item.name] = item;
      }
      const sectionDecisions = {};
      for (const item of listOf(view.sections)) {
        if (item && typeof item.name === "string") sectionDecisions[item.name] = item;
      }

      const makeMember = (name, kindKey) => {
        const decision = kindKey === "section" ? sectionDecisions[name] : toolDecisions[name];
        if (decision) return Object.assign({}, decision, { name: name, kind: kindKey });
        return {
          name: name,
          kind: kindKey,
          missing: true,
          tier: null,
          bucket: "declared",
          reason: "declared",
          confidence: "unknown",
          via: "sources",
          exception: undefined,
          deviation: false,
        };
      };

      const makeRow = (raw, phantom) => {
        const toolNames = listOf(raw.tools);
        const sectionNames = listOf(raw.sections);
        return {
          id: String(raw.id || ""),
          kind: kindOf(raw.id),
          configured: raw.configured === true,
          tier: raw.tier === null || raw.tier === undefined ? null : tierOf(raw.tier, null),
          toolExceptions: isObject(raw.toolExceptions) ? raw.toolExceptions : {},
          sectionExceptions: isObject(raw.sectionExceptions) ? raw.sectionExceptions : {},
          deviations: listOf(raw.deviations),
          tools: toolNames.map((name) => makeMember(name, "tool")),
          sections: sectionNames.map((name) => makeMember(name, "section")),
          phantom: phantom === true,
          synthetic: false,
          skills: [],
        };
      };

      const rows = [];
      const seenRows = {};
      for (const raw of listOf(view.capabilities)) {
        if (!raw || typeof raw.id !== "string" || raw.id.length === 0 || seenRows[raw.id]) continue;
        seenRows[raw.id] = true;
        rows.push(makeRow(raw, false));
      }
      for (const id of Object.keys(policyCaps)) {
        if (seenRows[id]) continue;
        seenRows[id] = true;
        const entry = isObject(policyCaps[id]) ? policyCaps[id] : {};
        rows.push(makeRow({
          id: id,
          configured: true,
          tier: entry.tier === undefined ? null : entry.tier,
          tools: [],
          sections: [],
          toolExceptions: entry.toolExceptions,
          sectionExceptions: entry.sectionExceptions,
          deviations: [],
        }, true));
      }

      const skillNames = listOf(state.skills).length > 0
        ? listOf(state.skills)
        : listOf(state.skillEntries).map((entry) => (entry && entry.name ? entry.name : "")).filter((name) => name.length > 0);
      const hasSkillProviderRows = rows.some((row) => row.kind === "skill");
      if (!hasSkillProviderRows && skillNames.length > 0) {
        rows.push({
          id: "skillpack:*",
          kind: "skill",
          configured: isObject(policy.content) && isObject(policy.content.defaults) && policy.content.defaults.skillpack !== undefined,
          tier: defaultsSkill,
          toolExceptions: {},
          sectionExceptions: {},
          deviations: [],
          tools: [],
          sections: [],
          phantom: false,
          synthetic: true,
          skills: skillNames,
        });
      }

      rows.sort((left, right) => {
        const leftKind = KIND_ORDER[left.kind] === undefined ? 9 : KIND_ORDER[left.kind];
        const rightKind = KIND_ORDER[right.kind] === undefined ? 9 : KIND_ORDER[right.kind];
        if (leftKind !== rightKind) return leftKind - rightKind;
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      });

      const rowsById = {};
      for (const row of rows) rowsById[row.id] = row;

      const rowBaseTier = (row) => {
        if (row.synthetic) return defaultsSkill;
        if (row.tier !== null) return row.tier;
        if (row.tools.length > 0) return defaultsCap;
        if (row.sections.length > 0) return defaultsSec;
        return defaultsCap;
      };
      const rowTargetTier = (row) => {
        if (row.synthetic) return pendingSkillpack === undefined ? defaultsSkill : pendingSkillpack;
        return hasOwn(pendingCaps, row.id) ? pendingCaps[row.id] : rowBaseTier(row);
      };
      const rowHasChanges = (row) => {
        if (row.synthetic) return pendingSkillpack !== undefined;
        if (hasOwn(pendingCaps, row.id)) return true;
        return pendingExceptions[row.id] !== undefined;
      };
      const memberDefaultTier = (row, kindKey) => {
        if (row.tier !== null) return row.tier;
        return kindKey === "section" ? defaultsSec : defaultsCap;
      };
      const exceptionFor = (row, kindKey, member) => {
        const staged = pendingExceptions[row.id] && pendingExceptions[row.id][kindKey];
        if (staged && hasOwn(staged, member.name)) {
          return { tier: staged[member.name], staged: true, pattern: member.name };
        }
        const map = kindKey === "section" ? row.sectionExceptions : row.toolExceptions;
        if (member.reason === "exception" && member.exception) {
          const pattern = member.exception.pattern || member.name;
          if (staged && hasOwn(staged, pattern)) {
            return { tier: staged[pattern], staged: true, pattern: pattern };
          }
          if (hasOwn(map, member.name)) {
            return { tier: tierOf(map[member.name], member.tier), staged: false, pattern: member.name };
          }
          return { tier: tierOf(member.exception.tier, member.tier), staged: false, pattern: pattern };
        }
        if (hasOwn(map, member.name)) {
          return { tier: tierOf(map[member.name], undefined), staged: false, pattern: member.name };
        }
        return undefined;
      };
      const projectedMemberTier = (row, kindKey, member, target) => {
        if (member.missing) return null;
        if (member.reason === "own" || member.reason === "protected" || member.reason === "loaded") {
          return tierOf(member.tier, target);
        }
        const exception = exceptionFor(row, kindKey, member);
        if (exception !== undefined && exception.tier !== null && exception.tier !== undefined) return exception.tier;
        return target;
      };
      const currentMemberTier = (row, kindKey, member) => {
        if (member.missing) return null;
        const exception = exceptionFor(row, kindKey, member);
        if (exception !== undefined && exception.tier !== null && exception.tier !== undefined) return exception.tier;
        if (hasOwn(pendingCaps, row.id)) return projectedMemberTier(row, kindKey, member, pendingCaps[row.id]);
        if (exception !== undefined && exception.tier === null) return memberDefaultTier(row, kindKey);
        return tierOf(member.tier, memberDefaultTier(row, kindKey));
      };
      const impactAgainstSaved = (row, target) => {
        const result = { tools: 0, sections: 0, locked: 0, exceptions: 0 };
        for (const member of row.tools) {
          if (member.missing) continue;
          if (member.reason === "own" || member.reason === "protected" || member.reason === "loaded") {
            result.locked += 1;
            continue;
          }
          if (member.reason === "exception") {
            result.exceptions += 1;
            continue;
          }
          if (tierOf(member.tier, memberDefaultTier(row, "tool")) !== target) result.tools += 1;
        }
        for (const member of row.sections) {
          if (member.missing) continue;
          if (member.reason === "exception") {
            result.exceptions += 1;
            continue;
          }
          if (tierOf(member.tier, memberDefaultTier(row, "section")) !== target) result.sections += 1;
        }
        return result;
      };
      const impactText = (impact) => {
        let text = "将影响 " + impact.tools + " 工具 + " + impact.sections + " 段落";
        const notes = [];
        if (impact.exceptions > 0) notes.push(impact.exceptions + " 个例外成员保持原档");
        if (impact.locked > 0) notes.push(impact.locked + " 个锁定成员不参与");
        if (notes.length > 0) text += "（" + notes.join("；") + "）";
        return text;
      };

      const pendingCapIds = Object.keys(pendingCaps);
      let pendingExceptionTotal = 0;
      for (const id of Object.keys(pendingExceptions)) {
        const group = pendingExceptions[id] || {};
        pendingExceptionTotal += Object.keys(group.tool || {}).length + Object.keys(group.section || {}).length;
      }
      const pendingTotal = pendingCapIds.length + pendingExceptionTotal + (pendingSkillpack === undefined ? 0 : 1);
      const hasChanges = pendingTotal > 0;

      const rowExceptionCount = (row) => {
        const baseTool = row.toolExceptions || {};
        const baseSection = row.sectionExceptions || {};
        let count = Object.keys(baseTool).length + Object.keys(baseSection).length;
        const staged = pendingExceptions[row.id];
        if (staged) {
          for (const name of Object.keys(staged.tool || {})) if (!hasOwn(baseTool, name)) count += 1;
          for (const name of Object.keys(staged.section || {})) if (!hasOwn(baseSection, name)) count += 1;
        }
        return count;
      };
      const rowConfidence = (row) => {
        let worst = -1;
        for (const member of row.tools.concat(row.sections)) {
          if (member.missing) continue;
          const rank = CONF_RANK[member.confidence] === undefined ? 3 : CONF_RANK[member.confidence];
          if (rank > worst) worst = rank;
        }
        if (worst < 2) return null;
        return worst === 3 ? "unknown" : "low";
      };
      const rowLoadedCount = (row) => row.tools.concat(row.sections).filter((member) => member.reason === "loaded").length;

      const queryText = query.trim().toLowerCase();
      const filteredRows = rows.filter((row) => {
        if (sourceFilter !== "all" && row.kind !== sourceFilter) return false;
        const tier = rowTargetTier(row);
        if (statusFilter === "exception") {
          if (rowExceptionCount(row) === 0 && row.deviations.length === 0) return false;
        } else if (statusFilter === "pending") {
          if (!rowHasChanges(row)) return false;
        } else if (statusFilter !== "all" && String(tier) !== statusFilter) {
          return false;
        }
        if (queryText.length === 0) return true;
        if (row.id.toLowerCase().indexOf(queryText) >= 0) return true;
        for (const skill of row.skills) if (String(skill).toLowerCase().indexOf(queryText) >= 0) return true;
        for (const member of row.tools) if (member.name.toLowerCase().indexOf(queryText) >= 0) return true;
        for (const member of row.sections) if (member.name.toLowerCase().indexOf(queryText) >= 0) return true;
        return false;
      });

      const matchedHint = (row) => {
        if (queryText.length === 0 || row.id.toLowerCase().indexOf(queryText) >= 0) return "";
        const hits = [];
        for (const skill of row.skills) if (String(skill).toLowerCase().indexOf(queryText) >= 0) hits.push(skill);
        for (const member of row.tools) if (member.name.toLowerCase().indexOf(queryText) >= 0) hits.push(member.name);
        for (const member of row.sections) if (member.name.toLowerCase().indexOf(queryText) >= 0) hits.push(member.name);
        if (hits.length === 0) return "";
        return "匹配成员：" + hits.slice(0, 4).join("、") + (hits.length > 4 ? "…" : "");
      };

      const requestTier = (row, tier) => {
        const current = rowTargetTier(row);
        if (tier === current) return;
        setConfirm({ id: row.id, tier: tier });
      };
      const commitTier = () => {
        if (!confirm) return;
        const row = rowsById[confirm.id];
        if (row && row.synthetic) {
          setPendingSkillpack(confirm.tier === defaultsSkill ? undefined : confirm.tier);
        } else if (row) {
          const base = rowBaseTier(row);
          setPendingCaps((previous) => {
            const next = Object.assign({}, previous);
            if (confirm.tier === base) delete next[row.id];
            else next[row.id] = confirm.tier;
            return next;
          });
        }
        setConfirm(null);
      };
      const stageException = (row, kindKey, name, tier) => {
        const member = (kindKey === "section" ? row.sections : row.tools).find((item) => item.name === name);
        const baseMap = kindKey === "section" ? row.sectionExceptions : row.toolExceptions;
        let baseKey = name;
        let baseTier = tierOf(baseMap[name], undefined);
        if (member && member.reason === "exception" && member.exception) {
          const pattern = member.exception.pattern || name;
          const patternTier = tierOf(member.exception.tier, undefined);
          if (patternTier !== undefined) {
            baseKey = pattern;
            baseTier = patternTier;
          }
        }
        setPendingExceptions((previous) => {
          const next = Object.assign({}, previous);
          const rowGroup = Object.assign({}, next[row.id] || {});
          const kindMap = Object.assign({}, rowGroup[kindKey] || {});
          if (tier === null) {
            if (baseTier === undefined) delete kindMap[name];
            else kindMap[baseKey] = null;
          } else if (baseTier === tier) {
            delete kindMap[baseKey];
          } else {
            kindMap[name] = tier;
          }
          if (Object.keys(kindMap).length === 0) delete rowGroup[kindKey];
          else rowGroup[kindKey] = kindMap;
          if (Object.keys(rowGroup).length === 0) delete next[row.id];
          else next[row.id] = rowGroup;
          return next;
        });
        setNotice(null);
      };
      const discardChanges = () => {
        setPendingCaps({});
        setPendingExceptions({});
        setPendingSkillpack(undefined);
        setConfirm(null);
        setNotice({ tone: "ok", text: "已放弃面板里未保存的改动" });
      };
      const requestReload = () => {
        if (hasChanges || jsonDirty) {
          setReloadConfirm(true);
          return;
        }
        void reload("已重新读取");
      };
      const commitReload = () => {
        setReloadConfirm(false);
        void reload("已重新读取（未保存改动已丢弃）");
      };

      const buildSaveContent = () => {
        const baseContent = isObject(policy.content) ? policy.content : (isObject(policy.template) ? policy.template : fallbackTemplate());
        const content = clone(baseContent);
        content.version = 3;
        if (!isObject(content.capabilities)) content.capabilities = {};
        for (const id of pendingCapIds) {
          const entry = isObject(content.capabilities[id]) ? content.capabilities[id] : {};
          content.capabilities[id] = Object.assign({}, entry, { tier: pendingCaps[id] });
        }
        for (const id of Object.keys(pendingExceptions)) {
          const entry = isObject(content.capabilities[id]) ? content.capabilities[id] : {};
          const existingRow = rowsById[id];
          if (entry.tier === undefined && existingRow) entry.tier = rowBaseTier(existingRow);
          const group = pendingExceptions[id] || {};
          for (const kindKey of ["tool", "section"]) {
            const staged = group[kindKey];
            if (!staged || Object.keys(staged).length === 0) continue;
            const key = kindKey === "section" ? "sectionExceptions" : "toolExceptions";
            const map = Object.assign({}, isObject(entry[key]) ? entry[key] : {});
            for (const name of Object.keys(staged)) {
              if (staged[name] === null) delete map[name];
              else map[name] = staged[name];
            }
            entry[key] = map;
          }
          content.capabilities[id] = entry;
        }
        if (pendingSkillpack !== undefined) {
          content.defaults = Object.assign({}, isObject(content.defaults) ? content.defaults : {}, { skillpack: pendingSkillpack });
        }
        return content;
      };
      const save = async () => {
        if (!hasChanges) {
          setNotice({ tone: "warn", text: "没有待保存改动" });
          return;
        }
        setSaving(true);
        setNotice(null);
        try {
          const body = buildSaveContent();
          body.replace = true;
          const result = await api("/api/dsh-gate/policy", { method: "POST", body: JSON.stringify(body) });
          if (result && result.ok) await reload("已保存并重算，下一轮生效");
          else setNotice({ tone: "error", text: "保存失败：" + ((result && result.message) || "未知原因") });
        } catch (failure) {
          setNotice({ tone: "error", text: "保存失败：" + String((failure && failure.message) || failure) });
        } finally {
          setSaving(false);
        }
      };

      const parseJsonText = () => {
        try {
          const value = JSON.parse(jsonText);
          if (!isObject(value)) return { ok: false, message: "顶层必须是 JSON 对象" };
          const version = Number(value.version);
          const looksV2 = (Number.isFinite(version) && version < 3) || (!Number.isFinite(version) && (isObject(value.tools) || isObject(value.sections) || isObject(value.skills)) && !isObject(value.capabilities));
          return { ok: true, value: value, warning: looksV2 ? "这是 v2 形状；服务端保存时会自动翻译成 v3" : "" };
        } catch (failure) {
          return { ok: false, message: String((failure && failure.message) || failure) };
        }
      };
      const validateJson = () => {
        const parsed = parseJsonText();
        if (!parsed.ok) setJsonNotice({ tone: "error", text: "JSON 解析失败：" + parsed.message });
        else if (parsed.warning) setJsonNotice({ tone: "warn", text: "校验通过；" + parsed.warning });
        else setJsonNotice({ tone: "ok", text: "校验通过（" + bytesOf(jsonText) + " 字节）" });
      };
      const formatJson = () => {
        const parsed = parseJsonText();
        if (!parsed.ok) {
          setJsonNotice({ tone: "error", text: "JSON 解析失败：" + parsed.message });
          return;
        }
        setJsonText(stringify(parsed.value));
        setJsonDirty(true);
        setJsonNotice({ tone: "ok", text: "已格式化；记得保存才会写盘" });
      };
      const requestJsonSave = () => {
        const parsed = parseJsonText();
        if (!parsed.ok) {
          setJsonNotice({ tone: "error", text: "JSON 解析失败：" + parsed.message });
          setJsonConfirm(null);
          return;
        }
        setJsonConfirm("save");
      };
      const commitJsonSave = async () => {
        const parsed = parseJsonText();
        if (!parsed.ok) {
          setJsonNotice({ tone: "error", text: "JSON 解析失败：" + parsed.message });
          setJsonConfirm(null);
          return;
        }
        setSaving(true);
        try {
          const body = Object.assign({}, parsed.value, { replace: true });
          const result = await api("/api/dsh-gate/policy", { method: "POST", body: JSON.stringify(body) });
          if (result && result.ok) {
            setJsonConfirm(null);
            setJsonDirty(false);
            await reload("已保存 JSON 策略（整份替换），下一轮生效");
          } else {
            setJsonNotice({ tone: "error", text: "保存失败：" + ((result && result.message) || "未知原因") });
          }
        } catch (failure) {
          setJsonNotice({ tone: "error", text: "保存失败：" + String((failure && failure.message) || failure) });
        } finally {
          setSaving(false);
        }
      };
      const commitRestoreDefault = () => {
        const template = isObject(policy.template) ? policy.template : fallbackTemplate();
        setJsonText(stringify(template));
        setJsonDirty(true);
        setJsonConfirm(null);
        setJsonNotice({ tone: "warn", text: "已载入内置默认（尚未保存）；点「保存 JSON」整份替换后生效，面板里未保存的改动会被丢弃。" });
      };

      const stat = (value, label, tone) => h("div", { className: "dshg-stat" + (tone ? " is-" + tone : "") },
        h("b", null, String(value)),
        h("span", null, label));
      const renderAlert = (text, tone, key) => h("div", { className: "dshg-alert", "data-tone": tone || undefined, key: key }, text);

      const renderChain = (row) => {
        const members = row.tools.concat(row.sections);
        const count = (predicate) => members.filter(predicate).length;
        const counts = {
          own: count((member) => member.reason === "own"),
          preset: count((member) => member.reason === "preset"),
          loaded: count((member) => member.reason === "loaded"),
          protected: count((member) => member.reason === "protected"),
          sources: count((member) => member.via === "sources"),
          infer: count((member) => member.via === "naming" || member.via === "prefix" || member.via === "native" || member.via === "unknown"),
          capability: count((member) => member.reason === "capability"),
          exception: count((member) => member.reason === "exception"),
          defaults: count((member) => member.reason === "defaults"),
        };
        const order = [
          ["own", "own"],
          ["preset", "preset"],
          ["loaded", "loaded"],
          ["protected", "protected"],
          ["sources", "sources"],
          ["infer", "推断"],
          ["capability", "能力档"],
          ["exception", "例外"],
          ["defaults", "defaults"],
        ];
        const nodes = [];
        for (let index = 0; index < order.length; index += 1) {
          const key = order[index][0];
          const label = order[index][1];
          if (index > 0) nodes.push(h("span", { key: "sep:" + key, className: "dshg-arrow" }, "→"));
          nodes.push(h("span", {
            key: key,
            className: "dshg-step" + (counts[key] > 0 ? " is-hit" : ""),
            title: "命中 " + counts[key] + " 个成员",
          }, label + (counts[key] > 0 ? " " + counts[key] : "")));
        }
        nodes.push(h("span", { key: "chainHint", className: "dshg-hint" }, "档位判定到 defaults 为止；sources / 推断是来源判定，单独计数"));
        return h("div", { className: "dshg-chain" }, nodes);
      };

      const renderMember = (row, kindKey, member) => {
        const exception = exceptionFor(row, kindKey, member);
        const current = currentMemberTier(row, kindKey, member);
        const target = rowTargetTier(row);
        const projected = projectedMemberTier(row, kindKey, member, target);
        const showProjected = !member.missing && projected !== null && current !== null && projected !== current && hasOwn(pendingCaps, row.id);
        const selectValue = exception !== undefined && exception.tier !== null && exception.tier !== undefined ? String(exception.tier) : "";
        const globPattern = exception && exception.pattern && exception.pattern !== member.name ? exception.pattern : "";
        return h("div", { className: "dshg-member", key: kindKey + ":" + member.name },
          h("span", { className: "dshg-memberName", title: member.name }, member.name),
          member.missing
            ? h("span", { className: "dshg-chip", key: "missing" }, "当前表面没有")
            : h("span", { className: "dshg-chip", key: "tier", "data-tier": String(current) }, tierLabel(current)),
          showProjected ? h("span", { className: "dshg-arrow", key: "arrow" }, "→") : null,
          showProjected ? h("span", { className: "dshg-chip", key: "proj", "data-tier": String(projected) }, tierLabel(projected)) : null,
          h("span", { className: "dshg-reason", key: "reason" }, REASON_LABEL[member.reason] || member.reason || "—"),
          member.missing ? null : h("span", { className: "dshg-conf", key: "conf" }, "置信 " + (CONF_LABEL[member.confidence] || "—")),
          member.missing ? null : h("select", {
            key: "exception",
            className: "dshg-select dshg-selectSm",
            disabled: member.reason === "own" || member.reason === "protected" || member.reason === "loaded",
            title: member.reason === "own" || member.reason === "protected" || member.reason === "loaded"
              ? "这个成员被 own / protected / loaded 锁定，例外不会改变它的实际档位"
              : "给这个成员设例外（toolExceptions / sectionExceptions）；切能力档不会动例外",
            value: selectValue,
            onChange: (event) => stageException(row, kindKey, member.name, event.target.value === "" ? null : Number(event.target.value)),
          },
            h("option", { key: "follow", value: "" }, "跟随能力档"),
            h("option", { key: "on", value: "1" }, "例外：常驻"),
            h("option", { key: "demand", value: "2" }, "例外：按需"),
            h("option", { key: "off", value: "0" }, "例外：关闭")),
          globPattern ? h("span", { className: "dshg-hint", key: "glob" }, "通配例外 " + globPattern + " = " + (exception.tier === null || exception.tier === undefined ? "跟随能力档" : tierLabel(exception.tier))) : null,
          exception && exception.staged ? h("span", { className: "dshg-tag is-warn", key: "staged" }, "待保存") : null);
      };

      const renderRow = (row) => {
        const tier = rowTargetTier(row);
        const base = rowBaseTier(row);
        const pending = rowHasChanges(row);
        const exceptions = rowExceptionCount(row);
        const confidence = rowConfidence(row);
        const loaded = rowLoadedCount(row);
        const markers = [];
        if (row.synthetic) markers.push({ text: "技能目录（聚合）", tone: "business" });
        if (!row.configured && !row.synthetic) markers.push({ text: "默认档", tone: "" });
        if (pending) markers.push({ text: "待保存", tone: "warn" });
        if (exceptions > 0) markers.push({ text: "例外 " + exceptions, tone: "warn" });
        if (row.deviations.length > 0) markers.push({ text: "偏离 " + row.deviations.length, tone: "error" });
        if (confidence === "low") markers.push({ text: "低置信", tone: "warn" });
        if (confidence === "unknown") markers.push({ text: "来源未知", tone: "warn" });
        if (loaded > 0) markers.push({ text: "已加载 " + loaded, tone: "ok" });
        const meta = [];
        if (row.synthetic) meta.push(listOf(row.skills).length + " 个技能");
        else meta.push(row.tools.length + " 工具 · " + row.sections.length + " 段落");
        meta.push(row.configured ? "策略已配置" : "走 defaults");
        if (row.phantom) meta.push("策略里有、当前表面没有成员");
        if (row.synthetic) meta.push("由 defaults.skillpack 统一控制");
        const hint = matchedHint(row);
        if (hint) meta.push(hint);
        const expandedNow = expanded[row.id] === true;
        const confirmNow = confirm && confirm.id === row.id;
        const detail = expandedNow ? h("div", { className: "dshg-detail" },
          renderChain(row),
          row.tools.length === 0 && row.sections.length === 0
            ? h("div", { className: "dshg-hint" }, row.synthetic
              ? "技能目录当前按 defaults.skillpack 统一控制；服务端还没有 provider 级 skillpack 成员表，所以没有按 provider 分组的行。"
              : "策略里有这个能力，但当前工具面/段落面没有成员（历史遗留键或 sources 还没匹配到）。")
            : null,
          row.tools.length > 0 ? h("div", { key: "toolGroup" },
            h("div", { className: "dshg-groupTitle" }, "工具（" + row.tools.length + "）"),
            h("div", { className: "dshg-members" }, ...row.tools.map((member) => renderMember(row, "tool", member)))) : null,
          row.sections.length > 0 ? h("div", { key: "sectionGroup" },
            h("div", { className: "dshg-groupTitle" }, "段落（" + row.sections.length + "）"),
            h("div", { className: "dshg-members" }, ...row.sections.map((member) => renderMember(row, "section", member)))) : null,
          h("div", { className: "dshg-hint" }, "成员上的下拉 = 显式例外（toolExceptions / sectionExceptions）；例外是唯一允许同能力不同档的地方。")
        ) : null;
        return h("div", { className: "dshg-cap", key: row.id },
          h("div", { className: "dshg-capMain" },
            h("span", { className: "dshg-badge", "data-kind": row.kind }, KIND_LABEL[row.kind]),
            h("div", { className: "dshg-grow" },
              h("div", { className: "dshg-capId", title: row.id }, row.id),
              h("div", { className: "dshg-capMeta" },
                markers.map((marker, index) => h("span", { key: "marker" + index, className: "dshg-tag" + (marker.tone ? " is-" + marker.tone : "") }, marker.text)),
                meta.map((text, index) => h("span", { key: "meta" + index, className: "dshg-hint" }, text)))),
            h("div", { className: "dshg-seg", role: "group", "aria-label": "切换能力档位" },
              TIER_ORDER.map((value) => h("button", {
                key: value,
                type: "button",
                "data-tier": String(value),
                className: value === tier ? "is-active" : "",
                title: "把 " + row.id + " 切到「" + tierLabel(value) + "」",
                onClick: () => requestTier(row, value),
              }, TIER_LABEL[value]))),
            h("button", {
              className: "dshg-btn",
              onClick: () => setExpanded((previous) => Object.assign({}, previous, { [row.id]: !previous[row.id] })),
              "aria-expanded": expandedNow,
            }, expandedNow ? "收起解析链" : "为什么在这一层")),
          confirmNow ? h("div", { className: "dshg-confirm" },
            h("div", { className: "dshg-grow" },
              h("div", null, "把 " + row.id + " 从「" + tierLabel(base) + "」切到「" + tierLabel(confirm.tier) + "」"),
              h("div", { className: "dshg-hint" }, row.synthetic
                ? "将影响 " + listOf(row.skills).length + " 个技能（工具与段落不受影响）；保存后下一轮生效。"
                : impactText(impactAgainstSaved(row, confirm.tier)) + "；保存后下一轮生效，本会话已加载的工具保持常驻。")),
            h("button", { className: "dshg-btn is-primary", onClick: commitTier }, "确认"),
            h("button", { className: "dshg-btn", onClick: () => setConfirm(null) }, "取消")) : null,
          detail);
      };

      const residentNames = listOf(state.residentNames);
      const onDemandNames = listOf(state.onDemandNames);
      const offNames = listOf(state.offNames);
      const visibleCount = typeof state.visible === "number" ? state.visible : residentNames.length + onDemandNames.length + offNames.length;
      const sectionRows = listOf(state.sections);
      const upstreamHidden = listOf(view.upstreamHidden).length > 0 ? listOf(view.upstreamHidden) : listOf(state.upstreamHidden);
      const deviations = listOf(view.deviations);
      const legacyOverrides = isObject(view.legacy) && isObject(view.legacy.unknownOverrides) ? view.legacy.unknownOverrides : {};
      const legacyKeys = Object.keys(legacyOverrides);
      const versionNumber = view.version || state.policyVersion || 3;
      const warningMessages = [];
      const seenWarnings = {};
      const warningSources = [listOf(state.warnings), listOf(view.warnings), listOf(policy.warnings)];
      for (const source of warningSources) {
        for (const warning of source) {
          const text = warningText(warning);
          if (!seenWarnings[text]) {
            seenWarnings[text] = true;
            warningMessages.push(text);
          }
        }
      }
      const lowConfidenceCount = rows.filter((row) => rowConfidence(row) !== null).length;

      const previewNodes = [];
      for (const id of pendingCapIds) {
        const row = rowsById[id];
        const target = pendingCaps[id];
        const from = row ? rowBaseTier(row) : defaultsCap;
        const impact = row ? impactAgainstSaved(row, target) : { tools: 0, sections: 0, locked: 0, exceptions: 0 };
        previewNodes.push(h("div", { className: "dshg-previewRow", key: "cap:" + id },
          h("span", { className: "dshg-code" }, id),
          h("span", null, tierLabel(from) + " → " + tierLabel(target)),
          h("span", { className: "dshg-hint" }, impactText(impact))));
      }
      if (pendingSkillpack !== undefined) {
        previewNodes.push(h("div", { className: "dshg-previewRow", key: "skillpack" },
          h("span", { className: "dshg-code" }, "skillpack:*"),
          h("span", null, tierLabel(defaultsSkill) + " → " + tierLabel(pendingSkillpack)),
          h("span", { className: "dshg-hint" }, "将影响 " + skillNames.length + " 个技能（不涉及工具/段落）")));
      }
      for (const id of Object.keys(pendingExceptions)) {
        const row = rowsById[id];
        for (const kindKey of ["tool", "section"]) {
          const staged = (pendingExceptions[id] || {})[kindKey];
          if (!staged) continue;
          for (const name of Object.keys(staged)) {
            const member = row ? (kindKey === "section" ? row.sections : row.tools).find((item) => item.name === name) : undefined;
            const baseMap = row ? (kindKey === "section" ? row.sectionExceptions : row.toolExceptions) : {};
            const exact = tierOf(baseMap[name], undefined);
            const from = member && member.reason === "exception" && member.exception && exact === undefined ? tierOf(member.exception.tier, undefined) : exact;
            const to = staged[name];
            previewNodes.push(h("div", { className: "dshg-previewRow", key: "ex:" + id + ":" + kindKey + ":" + name },
              h("span", { className: "dshg-code" }, id + " · " + (kindKey === "section" ? "段落" : "工具") + " " + name),
              h("span", null, (from === undefined ? "跟随能力档" : "例外 " + tierLabel(from)) + " → " + (to === null ? "跟随能力档" : "例外 " + tierLabel(to)))));
          }
        }
      }

      const alerts = [];
      if (notice) alerts.push(renderAlert(notice.text, notice.tone, "notice"));
      if (error) alerts.push(renderAlert("读取失败：" + error + "（下面显示的是上一次数据）", "error", "readError"));
      if (state.enabled === false) alerts.push(renderAlert("闸门已禁用（策略 enabled=false）：所有工具常驻，不摘段落。", "warn", "disabled"));
      if (state.passthrough) alerts.push(renderAlert("当前会话是收窄子代理（narrowPassThrough 豁免），闸门整体跳过；这里的档位对其它会话仍然生效。", "warn", "passthrough"));
      if (policy.migrated) alerts.push(renderAlert("策略文件是 v" + (policy.fromVersion || 2) + "，读取时已在内存中迁移为 v3；保存后落盘 v3（原文件旁会留 .v2.bak 备份）。", "warn", "migrated"));
      for (let index = 0; index < warningMessages.length && index < 6; index += 1) {
        alerts.push(renderAlert("策略告警：" + warningMessages[index], "warn", "warning" + index));
      }
      if (warningMessages.length > 6) alerts.push(renderAlert("还有 " + (warningMessages.length - 6) + " 条策略告警（见 /api/dsh-gate/policy 的 warnings）。", "warn", "warningMore"));
      if (legacyKeys.length > 0) alerts.push(renderAlert("legacy.unknownOverrides 有 " + legacyKeys.length + " 个 v2 悬空键（只告警、不参与解析）：" + legacyKeys.slice(0, 8).join("、"), "warn", "legacy"));
      if (deviations.length > 0) alerts.push(renderAlert("有 " + deviations.length + " 个成员偏离所属能力档（显式例外）：" + deviations.slice(0, 6).map((item) => item.name).join("、") + (deviations.length > 6 ? "…" : ""), "warn", "deviations"));
      if (upstreamHidden.length > 0) alerts.push(renderAlert("上游已隐藏 " + upstreamHidden.length + " 个工具（闸门只标注、不放出）：" + upstreamHidden.slice(0, 8).join("、") + (upstreamHidden.length > 8 ? "…" : ""), "warn", "upstreamHidden"));
      if (lowConfidenceCount > 0) alerts.push(renderAlert(lowConfidenceCount + " 个能力的来源靠包前缀推断或推不出来（低置信/未知）；可用 sources 显式映射纠正。", "warn", "lowConfidence"));
        const alertCount = alerts.filter((node) => node && node.props && (node.props["data-tone"] === "warn" || node.props["data-tone"] === "error")).length;

      const jsonLineCount = jsonText.length === 0 ? 0 : jsonText.split(String.fromCharCode(10)).length;
      const workItems = [
        ["一个能力 = 一个开关", "开关单位是来源实例：mcp:<server> / plugin:<包> / skillpack:<provider> / native:<tool> / tool:<name> / section:<name>。切一个能力档会同时改工具与段落两条限制，不会留下「有工具没段落」的半截状态。"],
        ["三层档位", "常驻写进工具表；按需进 gate-catalog，模型用 gate_load 提货后本会话常驻；关闭完全不声明。段落同源：按需/关闭的段落从系统提示词里摘掉。"],
        ["例外是同能力不同档的唯一入口", "toolExceptions / sectionExceptions 只能显式设置；切能力档不会动例外。例外与能力档不同时，读回会标「偏离」，面板也会提示。"],
        ["为什么在这一层", "解析顺序 own → preset → loaded → protected → sources → 命名推断 → 能力档 → 例外 → defaults；档位判定命中即停，来源判定单独计数。展开每一行可以看到成员各自停在哪一步，以及来源置信度。"],
        ["动不了的东西", "agent 自己注册的 own 层（run_code、gate_* 等）与 protected 名单永远常驻；上游已经隐藏的工具只标注、不放出，也不会被闸门重新声明。"],
        ["生效时机", "保存写入策略文件，下一轮 assemble 生效；本会话已经被 gate_load 认领的工具保持常驻。旧 v2 文件读取时只读迁移，首次保存落 v3。"],
        ["技能目录", "技能轴当前由 defaults.skillpack 统一控制（顶部有聚合行）。服务端还没有 provider 级 skillpack 成员表，策略里出现 skillpack:<provider> 时会按能力行显示。"],
        ["原始 JSON", "编辑器直接读写 /api/dsh-gate/policy；保存是整份替换（不是合并），会丢弃面板里未保存的改动。v2 形状提交会被服务端翻译成 v3。"],
      ];

      return h("div", { className: "dshg-wrap" },
        h("div", { className: "dshg-top" },
          h("div", { className: "dshg-grow" },
            h("div", { className: "dshg-title" }, "工具闸门 · 能力面板"),
            h("div", { className: "dshg-sub" },
              "策略 v" + versionNumber + " · " + (state.enabled === false ? "闸门已禁用" : "已启用") + " · " + (state.passthrough ? "子代理豁免中" : "会话 " + (state.agent || "无活跃 agent")) + (state.policyFile ? " · " + state.policyFile : ""))),
          h("div", { className: "dshg-foot" },
            h("button", { className: "dshg-btn", onClick: requestReload, disabled: loading || saving }, loading ? "读取中…" : "重新读取"),
            h("button", {
              className: "dshg-btn is-primary",
              onClick: save,
              disabled: saving || !hasChanges || jsonDirty,
              title: jsonDirty ? "JSON 编辑器有未保存修改，请先保存或撤销" : "把面板改动写入策略文件",
            }, saving ? "保存中…" : "保存改动" + (pendingTotal > 0 ? " (" + pendingTotal + ")" : "")))),
        h("div", { className: "dshg-stats" },
          stat(visibleCount, "可见工具"),
          stat(residentNames.length, "常驻"),
          stat(onDemandNames.length, "按需"),
          stat(offNames.length, "关闭"),
          stat(upstreamHidden.length, "上游隐藏", upstreamHidden.length > 0 ? "warn" : ""),
          stat(sectionRows.length, "段落"),
          stat(skillNames.length, "技能"),
          stat("v" + versionNumber, "策略版本"),
          stat(alertCount, "告警", alertCount > 0 ? "warn" : "")),
        alerts.length > 0 ? h("div", { className: "dshg-alerts" }, alerts) : null,
        h("div", { className: "dshg-card" },
          h("div", { className: "dshg-cardHead" },
            h("span", null, "能力（" + filteredRows.length + " / " + rows.length + "）"),
            h("span", { className: "dshg-note" }, "一个能力一个开关；点档位先看影响再确认")),
          h("div", { className: "dshg-cardBody" },
            h("div", { className: "dshg-filters" },
              h("input", {
                className: "dshg-input",
                placeholder: "搜索能力 id、工具名、段落名或技能名…",
                value: query,
                onChange: (event) => setQuery(event.target.value),
              }),
              h("select", { className: "dshg-select", value: sourceFilter, onChange: (event) => setSourceFilter(event.target.value) },
                KIND_FILTERS.map((option) => h("option", { key: option.value, value: option.value }, option.label))),
              h("select", { className: "dshg-select", value: statusFilter, onChange: (event) => setStatusFilter(event.target.value) },
                STATUS_FILTERS.map((option) => h("option", { key: option.value, value: option.value }, option.label))),
              h("button", {
                className: "dshg-btn",
                onClick: () => { setQuery(""); setSourceFilter("all"); setStatusFilter("all"); },
                disabled: query.length === 0 && sourceFilter === "all" && statusFilter === "all",
              }, "清除筛选"))),
          filteredRows.length > 0
            ? h("div", { className: "dshg-list" }, filteredRows.map(renderRow))
            : h("div", { className: "dshg-empty" }, "没有匹配的能力。换个关键词、来源或档位试试。")),
        h("div", { className: "dshg-card" },
          h("div", { className: "dshg-cardHead" },
            h("span", null, "待保存变更" + (pendingTotal > 0 ? "（" + pendingTotal + "）" : "（无）")),
            hasChanges ? h("button", { className: "dshg-btn", onClick: discardChanges }, "放弃改动") : null),
          h("div", { className: "dshg-cardBody" },
            hasChanges
              ? h("div", { className: "dshg-preview" }, previewNodes)
              : h("div", { className: "dshg-hint" }, "面板改动只改内存草稿；点「保存改动」后写入策略文件，下一轮生效。"),
            reloadConfirm ? h("div", { className: "dshg-confirm" },
              h("div", { className: "dshg-grow" }, "有未保存改动（或 JSON 编辑器有草稿），重新读取会丢弃它们。"),
              h("button", { className: "dshg-btn is-primary", onClick: commitReload }, "确认重新读取"),
              h("button", { className: "dshg-btn", onClick: () => setReloadConfirm(false) }, "取消")) : null,
            h("div", { className: "dshg-note" }, "保存按服务端 v3 规范化后落盘（UTF-8 无 BOM）；本会话已经加载的工具保持常驻。"))),
        h("div", { className: "dshg-card" },
          h("div", { className: "dshg-cardHead" },
            h("span", null, "原始策略 JSON（v3）"),
            h("span", { className: "dshg-note" }, jsonDirty ? "有未保存修改" : "与文件同步"),
            h("button", { className: "dshg-btn", onClick: () => setEditorOpen(!editorOpen) }, editorOpen ? "收起编辑" : "展开编辑")),
          editorOpen ? h("div", { className: "dshg-cardBody" },
            h("div", { className: "dshg-hint" }, "直接读写 /api/dsh-gate/policy。保存是整份替换（不是合并），会丢弃面板里未保存的改动；v2 形状提交由服务端自动翻译成 v3。"),
            pendingTotal > 0 ? h("div", { className: "dshg-alert", "data-tone": "warn" }, "面板里还有 " + pendingTotal + " 项未保存改动；保存 JSON 会丢弃它们。") : null,
            h("textarea", {
              className: "dshg-json",
              spellCheck: false,
              value: jsonText,
              onChange: (event) => { setJsonText(event.target.value); setJsonDirty(true); setJsonConfirm(null); },
            }),
            h("div", { className: "dshg-jsonMeta" },
              h("span", { className: "dshg-hint" }, bytesOf(jsonText) + " 字节 · " + jsonLineCount + " 行"),
              h("button", { className: "dshg-btn", onClick: validateJson }, "校验"),
              h("button", { className: "dshg-btn", onClick: formatJson }, "格式化"),
              h("button", { className: "dshg-btn is-danger", onClick: () => { setJsonConfirm("default"); setJsonNotice(null); } }, "恢复默认"),
              h("button", { className: "dshg-btn is-primary", onClick: requestJsonSave, disabled: saving }, "保存 JSON")),
            jsonNotice ? h("div", { className: "dshg-alert", "data-tone": jsonNotice.tone || undefined }, jsonNotice.text) : null,
            jsonConfirm === "save" ? h("div", { className: "dshg-confirm" },
              h("div", { className: "dshg-grow" }, "确认整份替换策略文件？这会按编辑器内容重写（不是合并），并丢弃面板里未保存的改动。"),
              h("button", { className: "dshg-btn is-primary", onClick: commitJsonSave, disabled: saving }, saving ? "保存中…" : "确认保存"),
              h("button", { className: "dshg-btn", onClick: () => setJsonConfirm(null) }, "取消")) : null,
            jsonConfirm === "default" ? h("div", { className: "dshg-confirm" },
              h("div", { className: "dshg-grow" }, "载入内置默认？会覆盖编辑器内容（尚未写盘）；面板里未保存的改动不会自动清掉，但保存 JSON 时会丢弃。"),
              h("button", { className: "dshg-btn is-primary", onClick: commitRestoreDefault }, "载入默认"),
              h("button", { className: "dshg-btn", onClick: () => setJsonConfirm(null) }, "取消")) : null) : null),
        h("div", { className: "dshg-card" },
          h("div", { className: "dshg-cardHead" },
            h("span", null, "工作原理 · 解析链与生效时机"),
            h("button", { className: "dshg-btn", onClick: () => setWorkOpen(!workOpen) }, workOpen ? "收起" : "展开")),
          workOpen ? h("div", { className: "dshg-cardBody" },
            h("ul", { className: "dshg-workList" },
              workItems.map((item, index) => h("li", { key: "work" + index },
                h("b", null, item[0] + "："),
                item[1])))) : null),
        h("div", { className: "dshg-foot" },
          h("span", { className: "dshg-note" }, policy.file ? "策略文件：" + policy.file : "策略文件：未配置（保存会失败）"),
          h("span", { className: "dshg-hint" }, "面板不发起任何外部请求；只读写本机 /api/dsh-gate/*。")));
    }

    const summaryText = () => "两层工具闸门 · 按能力开关";

    exports.inject = ["slots"];
    exports.apply = (ctx) => {
      ctx.slots.inject("plugins.row.config", () =>
        ctx.slots.register(
          { name: "plugins.row.config", key: "dsh-gate#surface-gate" },
          (slotProps) => (slotProps && slotProps.view === "summary" ? summaryText() : h(GatePanel, { page: true }))
        ));
    };

    return module.exports;
  },
});
