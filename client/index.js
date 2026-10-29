window.__ModuleLoader__.load({
  id: "dsh-gate",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const react = require("react");
    const h = react.createElement;

    const CSS = [
      ".dshg-wrap{font-family:-apple-system,\"SF Pro Text\",\"PingFang SC\",\"Segoe UI\",system-ui,sans-serif;color:#1d1d1f;display:flex;flex-direction:column;gap:12px}",
      "@media (prefers-color-scheme: dark){.dshg-wrap{color:#f5f5f7}}",
      ".dshg-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".dshg-title{font-weight:600;font-size:15px}",
      ".dshg-sub{color:#6e6e73;font-size:12.5px}",
      "@media (prefers-color-scheme: dark){.dshg-sub{color:#a1a1a6}}",
      ".dshg-stats{display:flex;gap:8px;flex-wrap:wrap}",
      ".dshg-stat{border:1px solid rgba(0,0,0,.08);border-radius:10px;padding:8px 12px;min-width:96px}",
      "@media (prefers-color-scheme: dark){.dshg-stat{border-color:rgba(255,255,255,.12)}}",
      ".dshg-stat b{display:block;font-size:17px;line-height:1.2}",
      ".dshg-stat span{font-size:11.5px;color:#6e6e73}",
      ".dshg-cols{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}",
      ".dshg-col{border:1px solid rgba(0,0,0,.08);border-radius:12px;overflow:hidden;display:flex;flex-direction:column;min-height:120px}",
      "@media (prefers-color-scheme: dark){.dshg-col{border-color:rgba(255,255,255,.12)}}",
      ".dshg-colHead{padding:8px 10px;font-size:12px;font-weight:600;background:rgba(0,0,0,.03)}",
      "@media (prefers-color-scheme: dark){.dshg-colHead{background:rgba(255,255,255,.05)}}",
      ".dshg-list{overflow:auto;max-height:340px;padding:4px}",
      ".dshg-row{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:7px;font-size:12.5px}",
      ".dshg-row:hover{background:rgba(0,0,0,.04)}",
      "@media (prefers-color-scheme: dark){.dshg-row:hover{background:rgba(255,255,255,.06)}}",
      ".dshg-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,monospace;font-size:12px}",
      ".dshg-btn{border:1px solid rgba(0,0,0,.12);background:transparent;color:inherit;border-radius:6px;font-size:11px;padding:2px 6px;cursor:pointer}",
      ".dshg-btn:hover{background:rgba(0,0,0,.06)}",
      "@media (prefers-color-scheme: dark){.dshg-btn{border-color:rgba(255,255,255,.18)}.dshg-btn:hover{background:rgba(255,255,255,.1)}}",
      ".dshg-input{width:100%;box-sizing:border-box;border:1px solid rgba(0,0,0,.12);border-radius:8px;padding:6px 9px;font-size:12.5px;background:transparent;color:inherit}",
      ".dshg-foot{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".dshg-primary{background:#0a84ff;border-color:#0a84ff;color:#fff;padding:5px 12px;font-size:12.5px}",
      ".dshg-primary:hover{background:#0b76e0}",
      ".dshg-note{font-size:11.5px;color:#6e6e73}",
      "@media (prefers-color-scheme: dark){.dshg-note{color:#a1a1a6}}",
    ].join("\n");

    let styled = false;
    const ensureStyle = () => {
      if (styled || typeof document === "undefined") return;
      styled = true;
      const tag = document.createElement("style");
      tag.setAttribute("data-dsh-gate", "1");
      tag.textContent = CSS;
      document.head.appendChild(tag);
    };

    const TIER_RESIDENT = 1;
    const TIER_ONDEMAND = 2;
    const TIER_OFF = 0;

    // /api/dsh-gate/state 同时给数字口径（resident/onDemand/off，文档与 C2 验收依赖）
    // 和名字口径（residentNames/onDemandNames/offNames）。UI 一律读名字数组，
    // 并为旧版只返回数组的响应留兼容。
    const namesOf = (state, key) => {
      const names = state[String(key) + "Names"];
      if (Array.isArray(names)) return names;
      const fallback = state[key];
      return Array.isArray(fallback) ? fallback : [];
    };

    const api = async (path, options) => {
      const response = await fetch(path, Object.assign({ headers: { "content-type": "application/json" } }, options || {}));
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    };

    const useGateState = () => {
      const [state, setState] = react.useState(null);
      const [error, setError] = react.useState("");
      const reload = react.useCallback(async () => {
        try { setState(await api("/api/dsh-gate/state")); setError(""); }
        catch (e) { setError(String((e && e.message) || e)); }
      }, []);
      react.useEffect(() => { void reload(); }, [reload]);
      return { state, error, reload, setState };
    };

    function GatePanel() {
      ensureStyle();
      const { state, error, reload } = useGateState();
      const [draft, setDraft] = react.useState(null);
      const [sectionDraft, setSectionDraft] = react.useState(null);
      const [filter, setFilter] = react.useState("");
      const [saving, setSaving] = react.useState(false);
      const [message, setMessage] = react.useState("");

      react.useEffect(() => {
        if (state && state.defaults && draft === null) {
          setDraft(Object.assign({}, state.defaults.toolOverrides || {}));
        }
        if (state && state.defaults && sectionDraft === null) {
          setSectionDraft(Object.assign({}, state.defaults.sectionOverrides || {}));
        }
      }, [state, draft, sectionDraft]);

      if (error) return h("div", { className: "dshg-wrap" }, h("div", { className: "dshg-note" }, "读不到闸门状态: " + error));
      if (!state) return h("div", { className: "dshg-wrap" }, h("div", { className: "dshg-note" }, "载入中…"));

      const overrides = draft || {};
      const own = new Set(Array.isArray(state.own) ? state.own : []);
      const authority = state.tiers || {};
      const isOwn = (name) => own.has(name);
      // 归层以服务端权威表 state.tiers 为准。
      // 旧实现只查 overrides、查不到就落默认层：own 层工具（run_code、gate_*、团队工具…）
      // 根本没有 overrides 条目，于是 14 个常驻工具整列错位显示成“按需”。
      const tierOf = (name) => {
        if (isOwn(name)) return TIER_RESIDENT;
        if (Object.prototype.hasOwnProperty.call(overrides, name)) return Number(overrides[name]);
        if (Object.prototype.hasOwnProperty.call(authority, name)) return Number(authority[name]);
        return state.defaults.toolsDefaultTier;
      };
      const setTier = (name, tier) => {
        setDraft(Object.assign({}, overrides, { [name]: tier }));
        setMessage("");
      };

      const all = [];
      for (const name of namesOf(state, "resident")) all.push(name);
      for (const name of namesOf(state, "onDemand")) all.push(name);
      for (const name of namesOf(state, "off")) all.push(name);
      const seen = new Set();
      const unique = all.filter((name) => { if (seen.has(name)) return false; seen.add(name); return true; });
      const query = filter.trim().toLowerCase();
      const groups = [[], [], []];
      for (const name of unique) {
        if (query && !name.toLowerCase().includes(query)) continue;
        const tier = tierOf(name);
        if (tier === TIER_RESIDENT) groups[0].push(name);
        else if (tier === TIER_OFF) groups[2].push(name);
        else groups[1].push(name);
      }

      const row = (name, actions) => h("div", { className: "dshg-row", key: name },
        h("span", { className: "dshg-name", title: name }, name),
        ...(isOwn(name)
          // 自身层工具 restrict 管不到，给按钮就是骗人：点了也不会生效。
          ? [h("span", { className: "dshg-note", title: "agent 自己注册的工具，restrict 管不到，永远常驻" }, "自身层")]
          : actions.map(([label, tier]) => h("button", {
            key: label,
            className: "dshg-btn",
            onClick: () => setTier(name, tier),
            title: label,
          }, label))));

      const column = (title, names, actionsFor) => h("div", { className: "dshg-col" },
        h("div", { className: "dshg-colHead" }, title + " (" + names.length + ")"),
        h("div", { className: "dshg-list" }, ...names.map((name) => row(name, actionsFor))));

      const sectionBlock = () => {
        const list = Array.isArray(state.sections) ? state.sections : [];
        if (list.length === 0) {
          return h("div", { className: "dshg-note" }, "还没采集到段落清单（跑一轮对话后出现）。");
        }
        const overridesForSections = sectionDraft || {};
        const tierOfSection = (name) => {
          if (Object.prototype.hasOwnProperty.call(overridesForSections, name)) return overridesForSections[name];
          return state.defaults.sectionsDefaultTier;
        };
        const rows = list
          .filter((section) => !query || section.name.toLowerCase().includes(query))
          .map((section) => {
            const tier = tierOfSection(section.name);
            return h("div", { className: "dshg-row", key: section.name },
              h("span", { className: "dshg-name", title: section.name }, section.name),
              h("span", { className: "dshg-note" }, String(section.tokens) + " tok"),
              h("button", {
                className: "dshg-btn",
                onClick: () => {
                  setSectionDraft(Object.assign({}, overridesForSections, { [section.name]: tier === 1 ? 2 : 1 }));
                  setMessage("");
                },
              }, tier === 1 ? "摘除" : "恢复"));
          });
        return h("div", { className: "dshg-col", style: { marginTop: "4px" } },
          h("div", { className: "dshg-colHead" }, "系统提示词段落（" + list.length + "）"),
          h("div", { className: "dshg-list" }, ...rows));
      };

      const save = async () => {
        setSaving(true);
        setMessage("");
        try {
          // 先读回文件再合并：只提交 5 个键会把 catalog / protected 等字段整块抹掉（真事故）。
          const current = await api("/api/dsh-gate/policy");
          const base = current && current.content && typeof current.content === "object" ? current.content : {};
          const body = Object.assign({}, base, {
            version: base.version || 2,
            enabled: state.enabled !== false,
            tools: Object.assign({}, base.tools || {}, {
              defaultTier: state.defaults.toolsDefaultTier,
              overrides: overrides,
            }),
            sections: Object.assign({}, base.sections || {}, {
              defaultTier: state.defaults.sectionsDefaultTier,
              overrides: sectionDraft || {},
            }),
            skills: Object.assign({}, base.skills || {}, { tier: state.defaults.skillsTier }),
          });
          const result = await api("/api/dsh-gate/policy", { method: "POST", body: JSON.stringify(body) });
          if (result && result.ok) { setMessage("已保存并重算，下一步生效"); await reload(); }
          else setMessage("保存失败: " + ((result && result.message) || "未知原因"));
        } catch (e) {
          setMessage("保存失败: " + String((e && e.message) || e));
        } finally { setSaving(false); }
      };

      const stat = (value, label) => h("div", { className: "dshg-stat", key: label }, h("b", null, String(value)), h("span", null, label));

      return h("div", { className: "dshg-wrap" },
        h("div", { className: "dshg-head" },
          h("div", { className: "dshg-title" }, "工具闸门 · 两层"),
          h("div", { className: "dshg-sub" }, state.enabled ? "已启用" : "已禁用")),
        h("div", { className: "dshg-stats" },
          stat(state.visible, "可见工具"),
          stat(namesOf(state, "resident").length, "第一层 常驻"),
          stat(namesOf(state, "onDemand").length, "第二层 按需"),
          stat(namesOf(state, "off").length, "关闭"),
          stat(state.catalogTokens, "目录 tokens")),
        h("input", {
          className: "dshg-input",
          placeholder: "过滤名字…",
          value: filter,
          onChange: (event) => setFilter(event.target.value),
        }),
        h("div", { className: "dshg-cols" },
          column("第一层 · 常驻（写进工具表）", groups[0], [["→ 按需", TIER_ONDEMAND], ["关闭", TIER_OFF]]),
          column("第二层 · 按需（查目录再加载）", groups[1], [["→ 常驻", TIER_RESIDENT], ["关闭", TIER_OFF]]),
          column("关闭", groups[2], [["→ 常驻", TIER_RESIDENT], ["→ 按需", TIER_ONDEMAND]])),
        sectionBlock(),
        h("div", { className: "dshg-foot" },
          h("button", { className: "dshg-btn dshg-primary", onClick: save, disabled: saving }, saving ? "保存中…" : "保存策略"),
          h("button", { className: "dshg-btn", onClick: reload }, "重新读取"),
          h("span", { className: "dshg-note" }, state.policyFile || "（策略文件路径未配置）")),
        message ? h("div", { className: "dshg-note" }, message) : null,
        h("div", { className: "dshg-note" }, "改动保存后从下一轮开始生效；已加载的工具在会话内保持常驻。"),
      );
    }

    const summaryText = () => "两层工具闸门 · 常驻/按需/关闭";

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