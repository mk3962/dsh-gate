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
      ".dshg-tabs{display:flex;gap:4px;flex-wrap:wrap;align-items:center;border-bottom:1px solid var(--dshg-border);padding-bottom:6px}",
      ".dshg-tabBody{display:flex;flex-direction:column;gap:12px}",
      ".dshg-sectionHead{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;font-weight:600;font-size:11.5px;margin-top:2px}",
      ".dshg-tab{border:1px solid transparent;background:transparent;color:var(--dshg-sub);border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}",
      ".dshg-tab:hover{background:var(--dshg-hover)}",
      ".dshg-tab.is-active{color:var(--dshg-label);border-color:var(--dshg-border2);background:var(--dshg-hover);font-weight:650}",
      ".dshg-tabCount{color:var(--dshg-faint);font-size:10.5px;margin-left:4px}",
      ".dshg-switch{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dshg-border2);border-radius:999px;padding:2px 9px 2px 7px;background:transparent;color:var(--dshg-sub);cursor:pointer;font-family:inherit;font-size:11.5px;white-space:nowrap}",
      ".dshg-switch i{width:9px;height:9px;border-radius:50%;background:var(--dshg-faint);display:block;flex:0 0 auto}",
      ".dshg-switch[data-on=true]{border-color:var(--dshg-success);color:var(--dshg-success)}",
      ".dshg-switch[data-on=true] i{background:var(--dshg-success)}",
      ".dshg-switch[data-on=false]{border-color:var(--dshg-error);color:var(--dshg-error)}",
      ".dshg-switch[data-on=false] i{background:var(--dshg-error)}",
      ".dshg-switch:hover:not(:disabled){background:var(--dshg-hover)}",
      ".dshg-switch:disabled{opacity:.5;cursor:default}",
      ".dshg-tableWrap{overflow:auto;max-height:560px;border:1px solid var(--dshg-border);border-radius:10px}",
      ".dshg-table{width:100%;border-collapse:collapse;font-size:11.5px}",
      ".dshg-table th{text-align:left;font-weight:600;color:var(--dshg-sub);padding:6px 8px;border-bottom:1px solid var(--dshg-border2);white-space:nowrap;position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-base,var(--dshg-layer))}",
      ".dshg-table td{padding:6px 8px;border-top:1px solid var(--dshg-border);vertical-align:top}",
      ".dshg-table tbody tr:hover{background:var(--dshg-hover)}",
      ".dshg-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;word-break:break-all}",
      ".dshg-cellDesc{color:var(--dshg-sub);font-size:11px;max-width:360px;word-break:break-word}",
      ".dshg-cellActions{display:flex;gap:4px;align-items:center;flex-wrap:wrap}",
      ".dshg-step.is-win{color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent;background:var(--dsw-alias-button-info-fill,var(--dshg-business));font-weight:700}",
      ".dshg-badge[data-kind=skillpack]{color:#8e5cd9;border-color:#8e5cd9}",
      ".dshg-badge[data-kind=skill]{color:#c05bd9;border-color:#c05bd9}",
      ".dshg-badge[data-state=owned]{color:var(--dshg-success);border-color:var(--dshg-success)}",
      ".dshg-badge[data-state=external]{color:var(--dshg-business);border-color:var(--dshg-business)}",
      ".dshg-badge[data-state=stopped]{color:var(--dshg-warn);border-color:var(--dshg-warn)}",
      ".dshg-badge[data-state=unavailable]{color:var(--dshg-error);border-color:var(--dshg-error)}",
      ".dshg-badge[data-origin=import]{color:#8e5cd9;border-color:#8e5cd9}",
      ".dshg-badge[data-origin=host]{color:var(--dshg-sub);border-color:var(--dshg-border2)}",
      ".dshg-importRow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:5px 0;border-top:1px dashed var(--dshg-border)}",
      ".dshg-importRow:first-child{border-top:0}",
      ".dshg-importPath{flex:1 1 260px;min-width:150px}",
      ".dshg-topRight{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}",
      ".dshg-stats2{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px}",
      "@media (max-width:720px){.dshg-seg button{padding:3px 7px}.dshg-stats,.dshg-stats2{grid-template-columns:repeat(2,minmax(0,1fr))}.dshg-input{flex-basis:100%}.dshg-hideSm{display:none}.dshg-tableWrap{max-height:none}.dshg-table th{position:static}.dshg-cellDesc{max-width:200px}.dshg-tabs{overflow-x:auto;flex-wrap:nowrap}}",
      "@media (max-width:720px){.dshg-topRight{justify-content:flex-start}}",
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
    const KIND_ORDER = { mcp: 0, plugin: 1, skillpack: 2, skill: 3, native: 4, section: 5, glob: 6, unknown: 7 };
    const KIND_LABEL = { mcp: "mcp", plugin: "plugin", skillpack: "技能包", skill: "技能", native: "原生", section: "段落", glob: "通配", unknown: "未知" };
    const KIND_FILTERS = [
      { value: "all", label: "全部来源" },
      { value: "mcp", label: "MCP" },
      { value: "plugin", label: "插件" },
      { value: "skillpack", label: "技能包（provider）" },
      { value: "skill", label: "单技能" },
      { value: "native", label: "原生" },
      { value: "section", label: "段落" },
      { value: "glob", label: "通配" },
      { value: "unknown", label: "未知来源" },
    ];
    const TABS = [
      { value: "caps", label: "能力" },
      { value: "skills", label: "技能" },
      { value: "mcp", label: "MCP" },
      { value: "json", label: "策略 JSON" },
    ];
    const ORIGIN_LABEL = { host: "宿主", import: "导入" };
    const MCP_STATE_LABEL = { owned: "gate 托管", external: "宿主托管", stopped: "已停止", unavailable: "不可用" };
    const SKILL_TIER_NOTE = "常驻=正文直接注入系统提示词；按需=只列进 gate-catalog，模型 gate_load(\"skill:名字\") 才取正文；关闭=不列目录且 gate_load 拒绝。";
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
      skill: "单技能档（skill:<名字>）",
      takeover: "takeover · 闸门接管（宿主 skill 工具被 deny）",
      defaults: "defaults · 默认档",
      declared: "sources 声明，当前表面没有",
    };
    const VIA_LABEL = {
      sources: "显式 sources",
      naming: "命名约定",
      prefix: "包前缀推断",
      native: "原生清单",
      provider: "provider 声明",
      name: "技能名",
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
      if (text.startsWith("skillpack:")) return "skillpack";
      // 单技能条目（0.3.0 工单 14）：skill:<名字>，比 provider 组更具体。
      if (text.startsWith("skill:") && text.length > "skill:".length) return "skill";
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

    /** 不抛错的请求：调用方自己决定哪个状态码算降级（/mcp 的 404 就是「还没接入」）。 */
    const request = async (path, options) => {
      let response;
      try {
        response = await fetch(path, Object.assign({ headers: { "content-type": "application/json" } }, options || {}));
      } catch (failure) {
        return { ok: false, status: 0, body: null, error: String((failure && failure.message) || failure) };
      }
      const text = await response.text();
      let body = null;
      if (text.length > 0) {
        try { body = JSON.parse(text); } catch { body = null; }
      }
      if (!response.ok) {
        const detail = body && (body.message || body.error) ? (body.message || body.error) : "HTTP " + response.status;
        return { ok: false, status: response.status, body: body, error: String(detail) };
      }
      return { ok: true, status: response.status, body: body, error: "" };
    };

    const api = async (path, options) => {
      const result = await request(path, options);
      if (!result.ok) throw new Error(result.error);
      return result.body;
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
      // 0.3.0 面板：四个 Tab（能力 / 技能 / MCP / 策略 JSON）
      const [tab, setTab] = react.useState("caps");
      const [skillsData, setSkillsData] = react.useState(null);
      const [skillsError, setSkillsError] = react.useState("");
      const [mcpData, setMcpData] = react.useState(null);
      const [mcpStatus, setMcpStatus] = react.useState("unknown");
      const [pendingSkills, setPendingSkills] = react.useState({});
      const [pendingImports, setPendingImports] = react.useState(null);
      const [pendingTakeover, setPendingTakeover] = react.useState(undefined);
      const [importDraft, setImportDraft] = react.useState("");
      const [importConfirm, setImportConfirm] = react.useState(null);
      const [skillQuery, setSkillQuery] = react.useState("");
      const [skillsNotice, setSkillsNotice] = react.useState(null);
      const [skillsSaving, setSkillsSaving] = react.useState(false);
      const [mcpNotice, setMcpNotice] = react.useState(null);
      const [mcpConfirm, setMcpConfirm] = react.useState(null);
      const [mcpDraft, setMcpDraft] = react.useState({ name: "", transport: "stdio", command: "", args: "", url: "" });
      const [enabledConfirm, setEnabledConfirm] = react.useState(false);

      const reload = react.useCallback(async (message) => {
        setLoading(true);
        try {
          // /mcp 在票 15 之前一定是 404：它是「还没接入」而不是「读失败」，不能把整块面板拖进错误态。
          const [stateResult, viewResult, policyResult, skillsResult, mcpResult] = await Promise.all([
            request("/api/dsh-gate/state"),
            request("/api/dsh-gate/capabilities"),
            request("/api/dsh-gate/policy"),
            request("/api/dsh-gate/skills"),
            request("/api/dsh-gate/mcp"),
          ]);
          if (!stateResult.ok) throw new Error(stateResult.error);
          if (!viewResult.ok) throw new Error(viewResult.error);
          if (!policyResult.ok) throw new Error(policyResult.error);
          setData({ state: stateResult.body || {}, view: viewResult.body || {}, policy: policyResult.body || {} });
          setSkillsData(skillsResult.ok ? (skillsResult.body || {}) : null);
          setSkillsError(skillsResult.ok ? "" : skillsResult.error);
          setMcpData(mcpResult.ok ? (mcpResult.body || {}) : null);
          setMcpStatus(mcpResult.ok ? "ok" : (mcpResult.status === 404 ? "missing" : "error"));
          setError("");
          setPendingCaps({});
          setPendingExceptions({});
          setPendingSkillpack(undefined);
          setPendingSkills({});
          setPendingImports(null);
          setPendingTakeover(undefined);
          setImportConfirm(null);
          setMcpConfirm(null);
          setConfirm(null);
          setReloadConfirm(false);
          setJsonDirty(false);
          setNotice(message ? { tone: "ok", text: message } : null);
          setSkillsNotice(null);
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
        if (decision) {
          // takenOver / forcedTier（0.3.0 工单 14）：宿主 skill 工具被闸门接管时，档位是强制的，
          // 策略怎么写都改不了 —— UI 必须能解释「为什么它显示关闭却不在工具表」。
          return Object.assign({}, decision, {
            name: name,
            kind: kindKey,
            takenOver: decision.takenOver === true,
            forcedTier: decision.forcedTier === undefined ? null : tierOf(decision.forcedTier, null),
          });
        }
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
          // 来源徽章（0.3.0 工单 08）：行级来源由能力 id 前缀决定，不拿成员投票。
          provenance: isObject(raw.provenance) ? raw.provenance : undefined,
          upstreamHidden: listOf(raw.upstreamHidden),
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
          provenance: { source: "skillpack", confidence: "high", via: "provider" },
          upstreamHidden: [],
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

      /** enabled 总开关：走 /policy 的合并保存（只提交 enabled，不动其它键）。 */
      const toggleEnabled = async () => {
        const target = state.enabled === false;
        setEnabledConfirm(false);
        setSaving(true);
        setNotice(null);
        try {
          const result = await api("/api/dsh-gate/policy", { method: "POST", body: JSON.stringify({ enabled: target }) });
          if (result && result.ok) await reload(target ? "闸门已启用，已重算" : "闸门已禁用：所有工具常驻、不摘段落");
          else setNotice({ tone: "error", text: "切换失败：" + ((result && result.message) || "未知原因") });
        } catch (failure) {
          setNotice({ tone: "error", text: "切换失败：" + String((failure && failure.message) || failure) });
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

      /* ── 技能 Tab（0.3.0 工单 16）：档位走 capabilities["skill:<名字>"] ────────── */

      const skillRowsRaw = listOf(skillsData && skillsData.skills);
      const skillImportsBase = listOf(skillsData && skillsData.imports)
        .map((item) => {
          if (!item || typeof item.path !== "string") return null;
          return typeof item.id === "string" && item.id.length > 0 ? { id: item.id, path: item.path } : { path: item.path };
        })
        .filter((item) => item !== null);
      const skillImports = pendingImports === null ? skillImportsBase : pendingImports;
      const takeoverBase = skillsData !== null && skillsData !== undefined && skillsData.takeover === true;
      const takeoverValue = pendingTakeover === undefined ? takeoverBase : pendingTakeover;
      const skillsDefaultTier = tierOf(skillsData && skillsData.defaults && skillsData.defaults.skillpack, defaultsSkill);
      const skillTierOf = (row) => (hasOwn(pendingSkills, row.name) ? pendingSkills[row.name] : tierOf(row.tier, skillsDefaultTier));
      const skillsDirty = pendingImports !== null || pendingTakeover !== undefined || Object.keys(pendingSkills).length > 0;
      const skillQueryText = skillQuery.trim().toLowerCase();
      const filteredSkills = skillRowsRaw.filter((row) => {
        if (skillQueryText.length === 0) return true;
        const haystack = [row.name, row.provider, row.path, row.description, row.capability].filter((value) => typeof value === "string").join(" ").toLowerCase();
        return haystack.indexOf(skillQueryText) >= 0;
      });
      const skillOffList = listOf(skillsData && skillsData.off);
      const stageSkillTier = (row, tier) => {
        const base = tierOf(row.tier, skillsDefaultTier);
        setPendingSkills((previous) => {
          const next = Object.assign({}, previous);
          if (tier === base) delete next[row.name];
          else next[row.name] = tier;
          return next;
        });
        setSkillsNotice(null);
      };
      const stageImportAdd = () => {
        const text = importDraft.trim();
        if (text.length === 0) {
          setSkillsNotice({ tone: "warn", text: "先在输入框里填一个技能目录（含 SKILL.md）" });
          return;
        }
        if (skillImports.some((item) => item.path === text)) {
          setSkillsNotice({ tone: "warn", text: "这个目录已经在导入清单里：" + text });
          return;
        }
        setPendingImports(skillImports.concat([{ path: text }]));
        setImportDraft("");
        setSkillsNotice({ tone: "ok", text: "已加入草稿（点「保存技能配置」才写盘；服务端会校验目录存在且有 SKILL.md/*.md）" });
      };
      const stageImportRemove = (index) => {
        setPendingImports(skillImports.filter((_item, position) => position !== index));
        setImportConfirm(null);
        setSkillsNotice({ tone: "ok", text: "已从草稿里移除（不会动原目录里的任何文件）" });
      };
      const discardSkills = () => {
        setPendingSkills({});
        setPendingImports(null);
        setPendingTakeover(undefined);
        setImportConfirm(null);
        setSkillsNotice({ tone: "ok", text: "已放弃技能页未保存的改动" });
      };
      const saveSkills = async () => {
        if (!skillsDirty) {
          setSkillsNotice({ tone: "warn", text: "没有待保存改动" });
          return;
        }
        setSkillsSaving(true);
        setSkillsNotice(null);
        try {
          const posts = [];
          if (pendingImports !== null) {
            posts.push({ action: "imports", imports: pendingImports.map((item) => (item.id ? { id: item.id, path: item.path } : { path: item.path })) });
          }
          if (pendingTakeover !== undefined) posts.push({ action: "takeover", value: pendingTakeover });
          for (const name of Object.keys(pendingSkills)) posts.push({ action: "tier", name: name, tier: pendingSkills[name] });
          let warnings = [];
          for (const body of posts) {
            const result = await api("/api/dsh-gate/skills", { method: "POST", body: JSON.stringify(body) });
            if (result && Array.isArray(result.warnings)) warnings = warnings.concat(result.warnings);
          }
          const extra = warnings.length > 0 ? "（服务端告警：" + warnings.map((row) => row.message || row.code).join("；") + "）" : "";
          await reload("技能配置已保存，已重拉 /state、/capabilities、/skills、/mcp" + extra);
        } catch (failure) {
          setSkillsNotice({ tone: "error", text: "保存失败：" + String((failure && failure.message) || failure) });
        } finally {
          setSkillsSaving(false);
        }
      };

      /* ── MCP Tab（票 15 之前 GET /mcp 恒 404）────────────────────────────── */

      const mcpServers = listOf(mcpData && (mcpData.servers || mcpData.mcp));
      const mcpWritable = mcpData !== null && mcpData !== undefined && mcpData.writable === true;
      const mcpOwnedCount = mcpServers.filter((row) => row && row.state === "owned").length;
      const mcpExternalCount = mcpServers.filter((row) => row && row.state === "external").length;
      const mcpTransportOf = (row) => (typeof row.transport === "string" ? row.transport : row.command ? "stdio" : row.url ? "http" : "—");
      const mcpTargetOf = (row) => {
        if (typeof row.target === "string" && row.target.length > 0) return row.target;
        if (typeof row.command === "string") return row.command + (Array.isArray(row.args) ? " " + row.args.join(" ") : "");
        if (typeof row.url === "string") return row.url;
        return "—";
      };
      const mcpToolCountOf = (row) => {
        if (typeof row.toolCount === "number") return row.toolCount;
        if (Array.isArray(row.tools)) return row.tools.length;
        return 0;
      };
      const mcpAction = async (action, name) => {
        setMcpNotice(null);
        try {
          const result = await api("/api/dsh-gate/mcp", { method: "POST", body: JSON.stringify({ action: action, name: name }) });
          if (result && result.ok === false) throw new Error(result.message || "操作失败");
          await reload("MCP " + action + " 已完成，已重拉状态");
        } catch (failure) {
          setMcpNotice({ tone: "error", text: "操作失败：" + String((failure && failure.message) || failure) });
        }
      };

      /** 新增 MCP server：表单只收最小必要字段（stdio: command/args；http: url）。 */
      const mcpAdd = async () => {
        setMcpNotice(null);
        const name = String(mcpDraft.name || "").trim();
        if (name.length === 0) { setMcpNotice({ tone: "error", text: "name 不能为空" }); return; }
        const server = mcpDraft.transport === "http"
          ? { transport: "streamable-http", url: String(mcpDraft.url || "").trim() }
          : {
              transport: "stdio",
              command: String(mcpDraft.command || "").trim(),
              args: String(mcpDraft.args || "").split(/\s+/).filter(Boolean),
            };
        try {
          const result = await api("/api/dsh-gate/mcp", { method: "POST", body: JSON.stringify({ action: "add", name: name, server: server }) });
          if (result && result.ok === false) throw new Error(result.message || "添加失败");
          setMcpDraft({ name: "", transport: "stdio", command: "", args: "", url: "" });
          await reload("MCP server 已添加，已重拉状态");
        } catch (failure) {
          setMcpNotice({ tone: "error", text: "添加失败：" + String((failure && failure.message) || failure) });
        }
      };
      const setMcpDraftField = (key, value) => setMcpDraft(Object.assign({}, mcpDraft, { [key]: value }));

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
        // 赢家 = 这条链上**第一个命中的规则**（顺序即优先级）。成员各自的 reason 已经写了它停在哪一步，
        // 这里再给整行一个总口径：为什么这一行会是现在这个档位。
        let winnerKey = "";
        for (const entry of order) if (counts[entry[0]] > 0) { winnerKey = entry[0]; break; }
        for (let index = 0; index < order.length; index += 1) {
          const key = order[index][0];
          const label = order[index][1];
          if (index > 0) nodes.push(h("span", { key: "sep:" + key, className: "dshg-arrow" }, "→"));
          const isWin = key === winnerKey;
          nodes.push(h("span", {
            key: key,
            className: "dshg-step" + (counts[key] > 0 ? " is-hit" : "") + (isWin ? " is-win" : ""),
            title: (isWin ? "赢家：" : "") + "命中 " + counts[key] + " 个成员",
          }, label + (counts[key] > 0 ? " " + counts[key] : "") + (isWin ? " · 赢家" : "")));
        }
        nodes.push(h("span", { key: "chainHint", className: "dshg-hint" }, winnerKey === ""
          ? "这一行没有成员命中任何规则：档位完全来自能力条目 / defaults。"
          : "档位判定到 defaults 为止；sources / 推断是来源判定，单独计数。"));
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
          member.takenOver ? h("span", { className: "dshg-tag is-business", key: "takenOver", title: "宿主 skill 工具被闸门 deny，技能目录/正文由 gate 自己出（takeover）" }, "闸门接管") : null,
          member.forcedTier !== null && member.forcedTier !== undefined
            ? h("span", { className: "dshg-tag is-warn", key: "forced", title: "强制档：策略改不了它（takenOver）" }, "强制 " + tierLabel(member.forcedTier))
            : null,
          showProjected ? h("span", { className: "dshg-arrow", key: "arrow" }, "→") : null,
          showProjected ? h("span", { className: "dshg-chip", key: "proj", "data-tier": String(projected) }, tierLabel(projected)) : null,
          h("span", { className: "dshg-reason", key: "reason" }, REASON_LABEL[member.reason] || member.reason || "—"),
          member.missing ? null : h("span", { className: "dshg-conf", key: "conf" }, "置信 " + (CONF_LABEL[member.confidence] || "—")),
          member.missing ? null : h("select", {
            key: "exception",
            className: "dshg-select dshg-selectSm",
            disabled: member.reason === "own" || member.reason === "protected" || member.reason === "loaded" || member.takenOver === true,
            title: member.reason === "own" || member.reason === "protected" || member.reason === "loaded"
              ? "这个成员被 own / protected / loaded 锁定，例外不会改变它的实际档位"
              : member.takenOver === true
                ? "这个工具被闸门接管（强制关闭），例外不会改变它的实际档位"
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
        // 来源徽章 / 上游隐藏 / 接管（0.2.0 来源标注 + 0.3.0 技能接管的行级信号）
        if (row.provenance && typeof row.provenance.source === "string" && row.provenance.source.length > 0) {
          const confidence = row.provenance.confidence === "high" ? "" : row.provenance.confidence === "medium" ? "warn" : "warn";
          markers.push({ text: "来源 " + row.provenance.source + (row.provenance.via && row.provenance.via !== "unknown" ? " · " + (VIA_LABEL[row.provenance.via] || row.provenance.via) : ""), tone: confidence === "" ? "business" : confidence });
        }
        if (row.upstreamHidden.length > 0) markers.push({ text: "上游隐藏 " + row.upstreamHidden.length, tone: "warn" });
        const takenOverMembers = row.tools.concat(row.sections).filter((member) => member.takenOver === true).length;
        if (takenOverMembers > 0) markers.push({ text: "接管 " + takenOverMembers, tone: "business" });
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
      const formatStamp = (ms) => {
        if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "—";
        try { return new Date(ms).toLocaleString(); } catch { return "—"; }
      };
      const savedAtText = formatStamp(policy.mtime);
      const enabledValue = state.enabled !== false;
      const executorKind = state.executor && typeof state.executor.kind === "string" ? state.executor.kind : "unknown";
      const frozen = state.frozen === true;
      const skillsDirtyCount = Object.keys(pendingSkills).length + (pendingImports === null ? 0 : 1) + (pendingTakeover === undefined ? 0 : 1);
      const visibleSkillCount = skillRowsRaw.length;

      const renderSkillRow = (row) => {
        const tier = skillTierOf(row);
        const base = tierOf(row.tier, skillsDefaultTier);
        const staged = hasOwn(pendingSkills, row.name);
        return h("tr", { key: row.name },
          h("td", null,
            h("div", { className: "dshg-mono", title: row.name }, row.name),
            row.path ? h("div", { className: "dshg-hint dshg-mono", title: row.path }, row.path) : null),
          h("td", null, h("span", { className: "dshg-badge", "data-origin": row.origin }, ORIGIN_LABEL[row.origin] || row.origin)),
          h("td", { className: "dshg-hideSm" }, h("span", { className: "dshg-hint" }, row.provider || "—")),
          h("td", null,
            row.shadowed
              ? h("span", { className: "dshg-tag is-warn", title: "被宿主或先声明的同名导入技能遮住：不列目录、gate_load 拒绝" }, "shadowed · 不可用")
              : h("div", { className: "dshg-seg", role: "group", "aria-label": "切换技能档位" },
                  TIER_ORDER.map((value) => h("button", {
                    key: value,
                    type: "button",
                    "data-tier": String(value),
                    className: value === tier ? "is-active" : "",
                    title: "把 " + row.name + " 切到「" + tierLabel(value) + "」",
                    onClick: () => stageSkillTier(row, value),
                  }, TIER_LABEL[value]))),
            staged ? h("span", { className: "dshg-tag is-warn", title: "待保存" }, tierLabel(base) + " → " + tierLabel(tier)) : null),
          h("td", { className: "dshg-hideSm" }, h("div", { className: "dshg-cellDesc" }, row.description || "（无描述）")),
          h("td", null, h("span", { className: "dshg-hint" }, row.shadowed ? "不可用" : row.capability || "—")));
      };

      const renderSkillsTab = () => {
        if (skillsError) {
          return h("div", { className: "dshg-card" },
            h("div", { className: "dshg-cardHead" }, h("span", null, "技能")),
            h("div", { className: "dshg-cardBody" },
              h("div", { className: "dshg-alert", "data-tone": "error" }, "读不到技能接口（GET /api/dsh-gate/skills）：" + skillsError),
              h("div", { className: "dshg-hint" }, "技能接管的服务端面来自 0.3.0 工单 14；那条分支没合进来时，这里只能看到「能力」页里按 provider 聚合的技能行。")));
        }
        if (skillsData === null) return h("div", { className: "dshg-empty" }, "技能表载入中…");
        return h("div", { className: "dshg-card" },
          h("div", { className: "dshg-cardHead" },
            h("span", null, "技能（" + filteredSkills.length + " / " + visibleSkillCount + "）"),
            h("span", { className: "dshg-note" }, skillsDirty ? "有未保存改动" : "与策略文件同步"),
            h("button", { className: "dshg-btn", onClick: discardSkills, disabled: !skillsDirty || skillsSaving }, "放弃改动"),
            h("button", {
              className: "dshg-btn is-primary",
              onClick: saveSkills,
              disabled: !skillsDirty || skillsSaving,
            }, skillsSaving ? "保存中…" : "保存技能配置" + (skillsDirty ? " (" + skillsDirtyCount + ")" : ""))),
          h("div", { className: "dshg-cardBody" },
            h("div", { className: "dshg-filters" },
              h("button", {
                className: "dshg-switch",
                "data-on": takeoverValue ? "true" : "false",
                onClick: () => { setPendingTakeover(!takeoverValue); setSkillsNotice(null); },
                title: "skills.takeover：开启后 gate deny 宿主 skill 工具，技能目录与正文全由 gate 出",
              }, h("i", null), "技能接管 " + (takeoverValue ? "开" : "关")),
              h("span", { className: "dshg-hint" }, takeoverValue
                ? "gate 接管：宿主 skill 工具被 deny，目录与正文由 gate 自己出。"
                : "接管关闭：宿主 skill 工具与目录照旧生效，下面的档位只影响 gate 自己的目录与 gate_load。")),
            h("div", { className: "dshg-note" }, "档位效果：" + SKILL_TIER_NOTE),
            skillOffList.length > 0
              ? h("div", { className: "dshg-hint" }, "skills.off 旧关闭清单（0.1.8 口径；0.3.0 起「关闭」写成能力条目 skill:<名字>）：" + skillOffList.join("、"))
              : null,
            h("div", { className: "dshg-sectionHead" }, h("span", null, "导入目录（skills.imports）"), h("span", { className: "dshg-hint" }, "相对路径以策略文件所在目录为基准；移除导入不会动原目录里的任何文件。")),
            h("div", { className: "dshg-hint" }, "扫描规则：目录里有 SKILL.md 算一个技能；否则看一层子目录各自的 SKILL.md；再否则目录下直接放的 *.md 各算一个。同名时宿主优先，导入的那份标 shadowed。"),
            skillImports.length === 0
              ? h("div", { className: "dshg-hint" }, "还没有导入目录。")
              : h("div", null, skillImports.map((item, index) => {
                const saved = listOf(skillsData.imports).find((row) => row && row.path === item.path);
                let stateNode;
                if (!saved) stateNode = h("span", { className: "dshg-tag is-business", key: "st" }, "待保存");
                else if (!saved.exists) stateNode = h("span", { className: "dshg-tag is-error", key: "st" }, "目录不存在");
                else if (!saved.hasSkills) stateNode = h("span", { className: "dshg-tag is-warn", key: "st" }, "目录里没有 SKILL.md/*.md");
                else stateNode = h("span", { className: "dshg-tag is-ok", key: "st" }, "已扫描到技能");
                return h("div", { className: "dshg-importRow", key: item.path + ":" + index },
                  h("span", { className: "dshg-importPath dshg-mono", title: item.path }, item.path),
                  item.id ? h("span", { className: "dshg-tag", key: "id" }, "id " + item.id) : null,
                  stateNode,
                  importConfirm === index
                    ? h("span", { className: "dshg-cellActions", key: "act" },
                        h("button", { className: "dshg-btn is-danger", onClick: () => stageImportRemove(index) }, "确认移除"),
                        h("button", { className: "dshg-btn", onClick: () => setImportConfirm(null) }, "取消"))
                    : h("button", { className: "dshg-btn", key: "act", onClick: () => { setImportConfirm(index); setSkillsNotice(null); } }, "移除"));
              })),
            h("div", { className: "dshg-filters" },
              h("input", {
                className: "dshg-input",
                placeholder: "技能目录路径（绝对路径，或相对策略文件目录）…",
                value: importDraft,
                onChange: (event) => setImportDraft(event.target.value),
              }),
              h("button", { className: "dshg-btn", onClick: stageImportAdd }, "加入草稿")),
            h("div", { className: "dshg-filters" },
              h("input", {
                className: "dshg-input",
                placeholder: "搜索技能名、provider、路径或描述…",
                value: skillQuery,
                onChange: (event) => setSkillQuery(event.target.value),
              }),
              h("button", { className: "dshg-btn", onClick: () => setSkillQuery(""), disabled: skillQuery.length === 0 }, "清除筛选")),
            filteredSkills.length === 0
              ? h("div", { className: "dshg-empty" }, visibleSkillCount === 0 ? (state.agent ? "本会话还没有装配过一次：技能清单在第一次请求后出现。" : "还没有技能：gate 没拿到宿主技能，也没有导入目录。") : "没有匹配的技能。")
              : h("div", { className: "dshg-tableWrap" },
                  h("table", { className: "dshg-table" },
                    h("thead", null, h("tr", null,
                      h("th", null, "技能"),
                      h("th", null, "来源"),
                      h("th", { className: "dshg-hideSm" }, "provider"),
                      h("th", null, "档位"),
                      h("th", { className: "dshg-hideSm" }, "描述"),
                      h("th", null, "能力"))),
                    h("tbody", null, filteredSkills.map(renderSkillRow)))),
            skillsDirty
              ? h("div", { className: "dshg-preview" },
                  Object.keys(pendingSkills).map((name) => {
                    const row = skillRowsRaw.find((item) => item.name === name);
                    const from = tierOf(row && row.tier, skillsDefaultTier);
                    return h("div", { className: "dshg-previewRow", key: "sk:" + name },
                      h("span", { className: "dshg-code" }, "skill:" + name),
                      h("span", null, tierLabel(from) + " → " + tierLabel(pendingSkills[name])));
                  }),
                  pendingTakeover !== undefined
                    ? h("div", { className: "dshg-previewRow", key: "takeover" },
                        h("span", { className: "dshg-code" }, "skills.takeover"),
                        h("span", null, (takeoverBase ? "开" : "关") + " → " + (pendingTakeover ? "开" : "关")))
                    : null,
                  pendingImports !== null
                    ? h("div", { className: "dshg-previewRow", key: "imports" },
                        h("span", { className: "dshg-code" }, "skills.imports"),
                        h("span", null, skillImportsBase.length + " → " + pendingImports.length + " 个目录"))
                    : null)
              : null,
            skillsNotice ? h("div", { className: "dshg-alert", "data-tone": skillsNotice.tone || undefined }, skillsNotice.text) : null,
            h("div", { className: "dshg-hint" }, "保存后立刻重算并重拉 /state、/capabilities、/skills、/mcp；单技能档位写在能力条目 skill:<名字> 上，优先于 skillpack:<provider> 组与 defaults.skillpack。")));
      };

      const renderMcpRow = (row) => {
        const name = String(row && row.name ? row.name : "");
        const stateName = row && typeof row.state === "string" ? row.state : "unavailable";
        const owned = stateName === "owned" || stateName === "stopped";
        const enabled = row && row.enabled !== false;
        // 服务端 POST 只认 enable/disable；stopped 状态下按钮写「启动」但动作必须是 enable。
        const stopAction = stateName === "stopped" ? "enable" : "disable";
        return h("tr", { key: name },
          h("td", null, h("div", { className: "dshg-mono" }, name)),
          h("td", null, h("span", { className: "dshg-hint" }, mcpTransportOf(row))),
          h("td", { className: "dshg-hideSm" }, h("div", { className: "dshg-cellDesc dshg-mono" }, mcpTargetOf(row))),
          h("td", null, h("span", { className: "dshg-badge", "data-state": stateName }, MCP_STATE_LABEL[stateName] || stateName)),
          h("td", null, h("span", { className: "dshg-hint" }, enabled ? "启用" : "禁用")),
          h("td", null, String(mcpToolCountOf(row))),
          h("td", null, owned
            ? h("div", { className: "dshg-cellActions" },
                h("button", {
                  className: "dshg-btn",
                  disabled: !mcpWritable,
                  title: mcpWritable ? "" : "M1 的 POST /api/dsh-gate/mcp 尚未接入",
                  onClick: () => { void mcpAction(stopAction, name); },
                }, stateName === "stopped" ? "启动" : "停止"),
                mcpConfirm === name
                  ? h("span", { className: "dshg-cellActions", key: "del" },
                      h("button", { className: "dshg-btn is-danger", onClick: () => { setMcpConfirm(null); void mcpAction("remove", name); } }, "确认删除"),
                      h("button", { className: "dshg-btn", onClick: () => setMcpConfirm(null) }, "取消"))
                  : h("button", { className: "dshg-btn", key: "del", disabled: !mcpWritable, onClick: () => setMcpConfirm(name) }, "删除"))
            : h("span", { className: "dshg-hint" }, "宿主配置，gate 只能观察")));
      };

      const renderMcpTab = () => {
        if (mcpStatus === "missing") {
          return h("div", { className: "dshg-card" },
            h("div", { className: "dshg-cardHead" }, h("span", null, "MCP server")),
            h("div", { className: "dshg-cardBody" },
              h("div", { className: "dshg-alert", "data-tone": "warn" }, "MCP 接管尚未接入（票 15）"),
              h("div", { className: "dshg-note" }, "服务端还没有 GET /api/dsh-gate/mcp（返回 404），所以这里显示「未接入」而不是报错。M1 接入后这一页会列出 gate 托管（owned）与宿主托管（external）的 server、连接状态、启用开关与工具数；owned 可启停/删除，external 只读。"),
              h("div", { className: "dshg-hint" }, "在那之前，MCP 的开关仍在「能力」页：一个 mcp:<server> 能力 = 一个档位开关，工具与说明书一起动。")));
        }
        if (mcpStatus === "error") {
          return h("div", { className: "dshg-card" },
            h("div", { className: "dshg-cardHead" }, h("span", null, "MCP server")),
            h("div", { className: "dshg-cardBody" },
              h("div", { className: "dshg-alert", "data-tone": "error" }, "读 MCP 清单失败：MCP 接口返回了非 404 的错误。"),
              h("button", { className: "dshg-btn", onClick: () => { void reload(""); } }, "重试")));
        }
        return h("div", { className: "dshg-card" },
          h("div", { className: "dshg-cardHead" },
            h("span", null, "MCP server（" + mcpServers.length + "）"),
            h("span", { className: "dshg-note" }, "owned = gate 托管（可改）；external = 宿主配置（只读）"),
            mcpNotice ? h("span", { className: "dshg-hint" }, mcpNotice.text) : null),
          h("div", { className: "dshg-cardBody" },
            mcpWritable
              ? h("div", { className: "dshg-filters", key: "mcpAdd" },
                  h("input", {
                    className: "dshg-input",
                    placeholder: "name（[A-Za-z0-9_-]{1,32}）",
                    value: mcpDraft.name,
                    onChange: (event) => setMcpDraftField("name", event.target.value),
                  }),
                  h("select", {
                    className: "dshg-select",
                    value: mcpDraft.transport,
                    onChange: (event) => setMcpDraftField("transport", event.target.value),
                  },
                    h("option", { value: "stdio" }, "stdio"),
                    h("option", { value: "http" }, "http")),
                  mcpDraft.transport === "http"
                    ? h("input", {
                        key: "url",
                        className: "dshg-input",
                        placeholder: "https://example.com/mcp",
                        value: mcpDraft.url,
                        onChange: (event) => setMcpDraftField("url", event.target.value),
                      })
                    : h("span", { key: "stdio", className: "dshg-filters" },
                        h("input", {
                          className: "dshg-input",
                          placeholder: "command（如 node）",
                          value: mcpDraft.command,
                          onChange: (event) => setMcpDraftField("command", event.target.value),
                        }),
                        h("input", {
                          className: "dshg-input",
                          placeholder: "args（空格分隔）",
                          value: mcpDraft.args,
                          onChange: (event) => setMcpDraftField("args", event.target.value),
                        })),
                  h("button", { className: "dshg-btn", onClick: () => { void mcpAdd(); } }, "添加"))
              : null,
            mcpServers.length === 0
              ? h("div", { className: "dshg-empty" }, mcpWritable ? "还没有 MCP server：用上面的表单添加第一个。" : "还没有 MCP server。")
              : h("div", { className: "dshg-tableWrap" },
                  h("table", { className: "dshg-table" },
                    h("thead", null, h("tr", null,
                      h("th", null, "name"),
                      h("th", null, "transport"),
                      h("th", { className: "dshg-hideSm" }, "目标"),
                      h("th", null, "状态"),
                      h("th", null, "enabled"),
                      h("th", null, "工具数"),
                      h("th", null, "操作"))),
                    h("tbody", null, mcpServers.map(renderMcpRow)))),
            h("div", { className: "dshg-hint" }, "连接态（连上/超时）由宿主 MCP 客户端给；gate 只观察，不谎报。")));
      };

      const renderCapsTab = () => h("div", { className: "dshg-tabBody" },
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
              : h("div", { className: "dshg-hint" }, "面板改动只改内存草稿；点「保存能力改动」后写入策略文件，下一轮生效。"),
            h("div", { className: "dshg-note" }, "保存按服务端 v3 规范化后落盘（UTF-8 无 BOM）；本会话已经加载的工具保持常驻。"))),
        h("div", { className: "dshg-card" },
          h("div", { className: "dshg-cardHead" },
            h("span", null, "工作原理 · 解析链与生效时机"),
            h("button", { className: "dshg-btn", onClick: () => setWorkOpen(!workOpen) }, workOpen ? "收起" : "展开")),
          workOpen ? h("div", { className: "dshg-cardBody" },
            h("ul", { className: "dshg-workList" },
              workItems.map((item, index) => h("li", { key: "work" + index },
                h("b", null, item[0] + "："),
                item[1])))) : null));

      const renderJsonTab = () => h("div", { className: "dshg-card" },
        h("div", { className: "dshg-cardHead" },
          h("span", null, "原始策略 JSON（v3）"),
          h("span", { className: "dshg-note" }, jsonDirty ? "有未保存修改" : "与文件同步"),
          h("button", { className: "dshg-btn", onClick: () => setEditorOpen(!editorOpen) }, editorOpen ? "收起编辑" : "展开编辑")),
        editorOpen ? h("div", { className: "dshg-cardBody" },
          h("div", { className: "dshg-hint" }, "直接读写 /api/dsh-gate/policy。保存是整份替换（不是合并），会丢弃面板里未保存的改动；v2 形状提交由服务端自动翻译成 v3。skills 接管配置也会原样保留。"),
          pendingTotal > 0 || skillsDirty ? h("div", { className: "dshg-alert", "data-tone": "warn" }, "面板里还有未保存改动（能力 " + pendingTotal + " 项、技能 " + skillsDirtyCount + " 项）；保存 JSON 会丢弃它们。") : null,
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
            h("button", { className: "dshg-btn", onClick: () => setJsonConfirm(null) }, "取消")) : null) : null);

      return h("div", { className: "dshg-wrap" },
        h("div", { className: "dshg-top" },
          h("div", { className: "dshg-grow" },
            h("div", { className: "dshg-title" }, "工具闸门 · 能力面板"),
            h("div", { className: "dshg-sub" },
              "策略 v" + versionNumber + " · " + (enabledValue ? "已启用" : "已禁用") + " · " + (state.passthrough ? "子代理豁免中" : "会话 " + (state.agent || "无活跃 agent")) + (state.policyFile ? " · " + state.policyFile : ""))),
          h("div", { className: "dshg-topRight" },
            h("button", {
              className: "dshg-switch",
              "data-on": enabledValue ? "true" : "false",
              onClick: () => setEnabledConfirm(true),
              disabled: loading || saving,
              title: enabledValue ? "点一下可禁用闸门（全部常驻、不摘段落）" : "点一下重新启用闸门",
            }, h("i", null), enabledValue ? "闸门已启用" : "闸门已禁用"),
            h("button", { className: "dshg-btn", onClick: requestReload, disabled: loading || saving }, loading ? "读取中…" : "重新读取"),
            h("button", {
              className: "dshg-btn is-primary",
              onClick: save,
              disabled: saving || !hasChanges || jsonDirty,
              title: jsonDirty ? "JSON 编辑器有未保存修改，请先保存或撤销" : "把能力页改动写入策略文件",
            }, saving ? "保存中…" : "保存能力改动" + (pendingTotal > 0 ? " (" + pendingTotal + ")" : "")))),
        enabledConfirm ? h("div", { className: "dshg-confirm" },
          h("div", { className: "dshg-grow" },
            enabledValue
              ? "确认禁用闸门？所有工具常驻、不摘段落，技能接管也会一起退回宿主行为。"
              : "确认重新启用闸门？会立刻按策略重算所有会话。"),
          h("button", { className: "dshg-btn is-primary", onClick: toggleEnabled }, enabledValue ? "确认禁用" : "确认启用"),
          h("button", { className: "dshg-btn", onClick: () => setEnabledConfirm(false) }, "取消")) : null,
        h("div", { className: "dshg-stats" },
          stat(visibleCount, "可见工具"),
          stat(residentNames.length, "常驻"),
          stat(onDemandNames.length, "按需"),
          stat(offNames.length, "关闭"),
          stat(upstreamHidden.length, "上游隐藏", upstreamHidden.length > 0 ? "warn" : ""),
          stat(sectionRows.length, "段落"),
          stat(visibleSkillCount, "技能"),
          stat("v" + versionNumber, "策略版本"),
          stat(alertCount, "告警", alertCount > 0 ? "warn" : "")),
        h("div", { className: "dshg-stats2" },
          stat(mcpOwnedCount, "MCP 托管", mcpOwnedCount > 0 ? "" : ""),
          stat(mcpExternalCount, "MCP 外部"),
          stat(executorKind + (frozen ? " · 冻结" : ""), "PTC 执行器"),
          stat(savedAtText, "最后保存"),
          stat(policy.migrated ? "v" + (policy.fromVersion || 2) + " → v3" : "v3", "策略文件版本")),
        alerts.length > 0 ? h("div", { className: "dshg-alerts" }, alerts) : null,
        state.agent && sectionRows.length === 0 && visibleSkillCount === 0
          ? h("div", { className: "dshg-note" }, "本会话还没有产生过一次请求：段落与技能清单要等第一次装配后才出现，工具档位与告警已按策略生效。")
          : null,
        h("div", { className: "dshg-tabs", role: "tablist" },
          TABS.map((item) => h("button", {
            key: item.value,
            type: "button",
            role: "tab",
            "aria-selected": tab === item.value,
            className: "dshg-tab" + (tab === item.value ? " is-active" : ""),
            onClick: () => setTab(item.value),
          }, item.label,
            h("span", { className: "dshg-tabCount" },
              item.value === "caps" ? String(rows.length)
                : item.value === "skills" ? String(visibleSkillCount)
                  : item.value === "mcp" ? (mcpStatus === "ok" ? String(mcpServers.length) : "—")
                    : jsonDirty ? "•" : "")))),
        reloadConfirm ? h("div", { className: "dshg-confirm" },
          h("div", { className: "dshg-grow" }, "有未保存改动（能力 " + pendingTotal + " 项、技能 " + skillsDirtyCount + " 项，或 JSON 编辑器有草稿），重新读取会丢弃它们。"),
          h("button", { className: "dshg-btn is-primary", onClick: commitReload }, "确认重新读取"),
          h("button", { className: "dshg-btn", onClick: () => setReloadConfirm(false) }, "取消")) : null,
        tab === "caps" ? renderCapsTab() : null,
        tab === "skills" ? renderSkillsTab() : null,
        tab === "mcp" ? renderMcpTab() : null,
        tab === "json" ? renderJsonTab() : null,
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
