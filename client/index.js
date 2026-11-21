window.__ModuleLoader__.load({
  id: "dsh-gate",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const react = require("react");
    const h = react.createElement;

    /* =====================================================================
     * 0. 无状态共用工具
     * 说明：这里只有纯函数与冻结常量，不持有任何跨层可变状态。
     * L1-L7 的每个命名空间都只经 deps 取用它需要的东西（禁止读外层状态）。
     * ===================================================================== */

    const TIER_OFF = 0;
    const TIER_RESIDENT = 1;
    const TIER_ONDEMAND = 2;
    const TIER_ORDER = [1, 2, 0];
    const TIER_LABEL = { 0: "关闭", 1: "常驻", 2: "按需" };

    const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    const listOf = (value) => (Array.isArray(value) ? value : []);
    const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
    const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

    const stableStringify = (value) => {
      const walk = (input) => {
        if (input === null || typeof input !== "object") {
          const encoded = JSON.stringify(input === undefined ? null : input);
          return encoded === undefined ? "null" : encoded;
        }
        if (Array.isArray(input)) return "[" + input.map(walk).join(",") + "]";
        const keys = Object.keys(input).sort();
        return "{" + keys.map((key) => JSON.stringify(key) + ":" + walk(input[key])).join(",") + "}";
      };
      try { return walk(value); } catch (error) { return String(value); }
    };
    const fingerprint = (value) => stableStringify(value);

    const fnv1a = (text) => {
      const source = String(text === undefined || text === null ? "" : text);
      let hash = 2166136261;
      for (let index = 0; index < source.length; index += 1) {
        hash = hash ^ source.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16);
    };

    const bytesOf = (text) => {
      const source = String(text === undefined || text === null ? "" : text);
      try { return new TextEncoder().encode(source).length; } catch (error) { return source.length; }
    };

    const warningText = (warning) => {
      if (typeof warning === "string") return warning;
      if (warning && typeof warning.message === "string") return warning.message;
      if (warning && typeof warning.code === "string") return warning.code;
      try { return JSON.stringify(warning); } catch (error) { return String(warning); }
    };

    const newline = String.fromCharCode(10);
    const stackHead = (error, lines) => {
      const raw = error && typeof error.stack === "string" ? error.stack : String(error && error.message || error || "");
      return raw.split(newline).slice(0, lines || 3);
    };
    const errorText = (error) => String(error && error.message ? error.message : error);

    /* =====================================================================
     * 1. 文案常量表（L7 的唯一文案真源；视图不得自拼业务文案）
     * ===================================================================== */
    const TEXT = Object.freeze({
      "summary": "两层工具闸门 · 按能力开关",
      "title": "工具闸门 · 操作员工作台",
      "subtitle": "草稿只有一份真源；刷新、保存、启停都先确认会丢什么",
      "tabs.label": "面板页签",
      "tab.caps": "能力",
      "tab.skills": "技能",
      "tab.mcp": "MCP",
      "tab.json": "策略 JSON",
      "tab.settings": "设置",
      "common.yes": "是",
      "common.no": "否",
      "common.none": "—",
      "common.empty": "没有数据",
      "common.loading": "载入中…",
      "common.ready": "就绪",
      "common.partial": "部分可用",
      "common.error": "读取失败",
      "common.missing": "能力不存在",
      "common.stale": "陈旧",
      "common.justNow": "刚刚",
      "common.minutesAgo": "分钟前",
      "loading": "载入闸门状态…",
      "loadFailed": "读不到闸门状态",
      "retry": "重试",
      "reload": "重新读取",
      "saving": "保存中…",
      "save": "保存",
      "saved": "已保存，下一轮生效",
      "noChanges": "没有待保存改动",
      "noChangeWritten": "服务端判定没有变化，未写入",
      "discard": "放弃改动",
      "undo": "撤销",
      "redo": "重做",
      "undoHint": "快捷键 Ctrl+Z / Ctrl+Shift+Z；至少二十步",
      "caps.title": "能力",
      "caps.search": "搜索能力 id、工具名、段落名或技能名…",
      "caps.sourceAll": "全部来源",
      "caps.statusAll": "全部层",
      "caps.statusException": "有例外",
      "caps.statusPending": "待保存",
      "caps.clear": "清除筛选",
      "caps.empty": "没有匹配的能力",
      "caps.groupBatch": "整组设置",
      "caps.groupImpact": "影响预览",
      "caps.why": "为什么在这一层",
      "caps.hide": "收起解析",
      "caps.invalid": "层值非法，已标红并阻断保存",
      "caps.blocked": "阻断保存",
      "caps.complaints": "数据不完整",
      "caps.complaintsHint": "缺字段只降级相关卡片，其余照常可用",
      "caps.managed": "托管（只读服务端字段）",
      "caps.pending": "待保存",
      "caps.exception": "成员例外",
      "caps.followCap": "跟随能力层",
      "caps.locked": "被锁定，例外不改变实际层",
      "skills.title": "技能",
      "skills.search": "搜索技能名、provider、路径或描述…",
      "skills.save": "保存技能配置",
      "skills.takeover": "技能接管",
      "skills.relay": "激活转发",
      "skills.promote": "族内提升",
      "skills.relayHint": "从属于技能接管：接管关闭时转发没有接收方",
      "skills.promoteHint": "从属于激活转发：只对已转发到 gate 的技能生效",
      "skills.off": "旧关闭清单",
      "skills.offRemove": "移除",
      "skills.offClear": "清空清单",
      "skills.offClearConfirm": "清空旧关闭清单？可撤销。",
      "skills.imports": "导入目录",
      "skills.importAdd": "加入草稿",
      "skills.importPreview": "解析预览",
      "skills.importRemove": "移除",
      "skills.prescan": "预扫描清单",
      "skills.prescanRetry": "重试预扫描",
      "skills.warnings": "技能告警",
      "skills.empty": "还没有技能",
      "skills.dirty": "有未保存改动",
      "skills.synced": "与策略文件同步",
      "mcp.title": "MCP server",
      "mcp.add": "添加",
      "mcp.name": "name（[A-Za-z0-9_-]{1,32}）",
      "mcp.command": "command（如 node）",
      "mcp.args": "args（支持单双引号与空格）",
      "mcp.argsPreview": "参数解析预览",
      "mcp.url": "https://example.com/mcp",
      "mcp.actions": "操作",
      "mcp.readonly": "宿主配置，gate 只能观察",
      "mcp.empty": "还没有 MCP server",
      "mcp.notWritable": "POST /api/dsh-gate/mcp 不可写，按钮已禁用",
      "json.title": "原始策略 JSON",
      "json.validate": "校验",
      "json.format": "格式化",
      "json.restore": "载入服务端默认",
      "json.save": "保存 JSON",
      "json.replaceHint": "保存是整份替换（不是合并）；提交前先看差异",
      "json.import": "导入文件",
      "json.export": "导出当前策略",
      "json.diff": "差异预览",
      "json.bytes": "字节",
      "json.lines": "行",
      "json.invalid": "JSON 解析失败",
      "json.confirmTitle": "确认整份替换？",
      "settings.title": "设置与健康",
      "settings.guard": "重复劳动护栏",
      "settings.guardEnabled": "启用",
      "settings.window": "窗口（2–200）",
      "settings.threshold": "阈值（2–50）",
      "settings.reminders": "提醒（1–5）",
      "settings.preview": "预览字符（40–4000）",
      "settings.exclusions": "排除名单（逗号分隔）",
      "settings.fixedItems": "恒在项由服务端标记默认恒在，不可删",
      "settings.runtime": "运行态指标",
      "settings.noMetrics": "尚未统计（无数据显示为尚未统计，不是零）",
      "settings.catalog": "目录三选项",
      "settings.groupByPlugin": "按插件分组",
      "settings.cacheCost": "改目录字节会让从该段起的前缀缓存一次性失效",
      "settings.skillGroups": "技能按来源折叠",
      "settings.maxDesc": "描述截断长度（16–512）",
      "settings.autoRefresh": "自动刷新",
      "settings.autoOff": "关闭",
      "settings.auto15": "15 秒",
      "settings.auto30": "30 秒",
      "settings.auto60": "60 秒",
      "settings.autoPaused": "已暂停",
      "settings.session": "会话",
      "settings.sessionAuto": "自动（服务端选取）",
      "settings.sessionHost": "宿主注入",
      "settings.sessionPanel": "面板选择",
      "settings.listSessions": "列出已装配会话",
      "settings.signature": "签名摘要",
      "settings.restoreKey": "单键还原为服务端值",
      "health.title": "健康条",
      "health.file": "策略文件",
      "health.readAt": "读取时刻",
      "health.session": "会话",
      "health.sources": "数据源",
      "confirm.title": "确认操作",
      "confirm.ok": "确认丢弃并继续",
      "confirm.cancel": "取消",
      "confirm.consequence": "确认后会丢弃",
      "error.title": "面板出现异常",
      "error.summary": "错误摘要",
      "error.stack": "栈（前三行）",
      "error.copy": "复制诊断",
      "error.diagnostics": "诊断信息",
      "error.viewMissing": "这个视图暂不可用",
      "error.viewMissingHint": "已降级到这个卡片，其它页签照常可用",
      "error.backToCaps": "切回能力页",
      "tier.off": "关闭",
      "tier.resident": "常驻",
      "tier.ondemand": "按需",
      "tier.unset": "未设置",
      "tier.invalid": "非法",
      "chain.title": "决策链",
      "chain.winner": "赢家",
      "chain.none": "没有成员命中任何规则，层值来自能力条目或 defaults",
      "chain.filter": "只看没被限制的",
      "chain.filterAll": "全部",
      "chain.final": "最终层值",
      "chain.hit": "命中规则",
      "chain.reason": "原因链",
    });

    /** 文案取值器：所有界面文案只经它读取常量表（缺键显性回显，不静默吞掉）。 */
    const text = (key) => (hasOwn(TEXT, key) ? TEXT[key] : String(key));

    /* =====================================================================
     * 2. 样式常量（命名分区，拼一份文本；只允许主题令牌）
     * 幂等注入的宿主节点由 data-dsh-gate 属性唯一确定。
     * ===================================================================== */
    const STYLE_ATTR = "data-dsh-gate";
    const STYLE_SECTIONS = Object.freeze([
      ["tokens", ".dshg-wrap{--dshg-border:var(--dsw-alias-border-l1,rgba(0,0,0,.12));--dshg-border2:var(--dsw-alias-border-l2,rgba(0,0,0,.2));--dshg-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));--dshg-layer:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));--dshg-label:var(--dsw-alias-label-primary,#1d1d1f);--dshg-sub:var(--dsw-alias-label-secondary,#6e6e73);--dshg-faint:var(--dsw-alias-label-tertiary,#8e8e93);--dshg-business:var(--dsw-alias-state-business-primary,#0a84ff);--dshg-success:var(--dsw-alias-state-success-primary,#34c759);--dshg-warn:var(--dsw-alias-state-warn-primary,#ff9f0a);--dshg-error:var(--dsw-alias-state-error-primary,#ff453a);color:var(--dshg-label);font-family:var(--dsw-font-family,system-ui,sans-serif);display:flex;flex-direction:column;gap:12px;font-size:12.5px;line-height:1.55}"],
      ["layout", ".dshg-head{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap}.dshg-grow{flex:1 1 240px;min-width:0}.dshg-title{font-weight:650;font-size:15px}.dshg-sub{color:var(--dshg-sub);font-size:11.5px;word-break:break-all}.dshg-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.dshg-col{display:flex;flex-direction:column;gap:8px}.dshg-foot{display:flex;gap:8px;align-items:center;flex-wrap:wrap;color:var(--dshg-sub);font-size:11.5px}"],
      ["card", ".dshg-card{border:1px solid var(--dshg-border);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-base,transparent)}.dshg-cardHead{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 12px;font-weight:600;font-size:12px;background:var(--dshg-layer);border-bottom:1px solid var(--dshg-border)}.dshg-cardBody{display:flex;flex-direction:column;gap:10px;padding:10px 12px}"],
      ["tabs", ".dshg-tabs{display:flex;gap:4px;flex-wrap:wrap;align-items:center;border-bottom:1px solid var(--dshg-border);padding-bottom:6px}.dshg-tab{border:1px solid transparent;background:transparent;color:var(--dshg-sub);border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit}.dshg-tab:hover{background:var(--dshg-hover)}.dshg-tab[aria-selected=true]{color:var(--dshg-label);border-color:var(--dshg-border2);background:var(--dshg-hover);font-weight:650}.dshg-tabCount{color:var(--dshg-faint);font-size:10.5px;margin-left:4px}.dshg-panel[hidden]{display:none}"],
      ["stats", ".dshg-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(102px,1fr));gap:8px}.dshg-stat{border:1px solid var(--dshg-border);border-radius:10px;padding:7px 10px;min-width:0}.dshg-stat b{display:block;font-size:17px;line-height:1.2;font-variant-numeric:tabular-nums}.dshg-stat span{display:block;color:var(--dshg-sub);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dshg-stat[data-tone=warn]{border-color:var(--dshg-warn)}.dshg-stat[data-tone=error]{border-color:var(--dshg-error)}"],
      ["controls", ".dshg-input{flex:1 1 230px;min-width:170px;box-sizing:border-box;border:1px solid var(--dshg-border2);border-radius:8px;padding:5px 9px;font-size:12.5px;background:var(--dsw-specific-input-major,transparent);color:inherit;font-family:inherit}.dshg-select{box-sizing:border-box;border:1px solid var(--dshg-border2);border-radius:8px;padding:4px 6px;font-size:12px;background:var(--dsw-specific-input-major,transparent);color:inherit;font-family:inherit}.dshg-btn{border:1px solid var(--dshg-border2);background:transparent;color:inherit;border-radius:7px;font-size:11.5px;padding:3px 8px;cursor:pointer;font-family:inherit;white-space:nowrap}.dshg-btn:hover:not(:disabled){background:var(--dshg-hover)}.dshg-btn:disabled{opacity:.45;cursor:default}.dshg-btn[data-primary=true]{background:var(--dsw-alias-button-info-fill,var(--dshg-business));border-color:var(--dsw-alias-button-info-fill,var(--dshg-business));color:var(--dsw-alias-label-primary-foreground,#fff)}.dshg-btn[data-danger=true]{color:var(--dshg-error);border-color:var(--dshg-error)}.dshg-seg{display:inline-flex;border:1px solid var(--dshg-border2);border-radius:8px;overflow:hidden}.dshg-seg button{border:0;background:transparent;color:var(--dshg-sub);padding:3px 9px;font-size:11.5px;cursor:pointer;font-family:inherit}.dshg-seg button+button{border-left:1px solid var(--dshg-border2)}.dshg-seg button[aria-pressed=true]{background:var(--dsw-alias-button-info-fill,var(--dshg-business));color:var(--dsw-alias-label-primary-foreground,#fff)}.dshg-switch{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dshg-border2);border-radius:999px;padding:2px 9px 2px 7px;background:transparent;color:var(--dshg-sub);cursor:pointer;font-family:inherit;font-size:11.5px}.dshg-switch i{width:9px;height:9px;border-radius:50%;background:var(--dshg-faint);display:block}.dshg-switch[aria-checked=true]{border-color:var(--dshg-success);color:var(--dshg-success)}.dshg-switch[aria-checked=true] i{background:var(--dshg-success)}.dshg-switch[aria-checked=false]{border-color:var(--dshg-error);color:var(--dshg-error)}.dshg-switch[aria-checked=false] i{background:var(--dshg-error)}.dshg-switch:disabled{opacity:.5;cursor:default}"],
      ["tables", ".dshg-tableWrap{overflow:auto;max-height:560px;border:1px solid var(--dshg-border);border-radius:10px}.dshg-table{width:100%;border-collapse:collapse;font-size:11.5px}.dshg-table th{text-align:left;font-weight:600;color:var(--dshg-sub);padding:6px 8px;border-bottom:1px solid var(--dshg-border2);white-space:nowrap}.dshg-table td{padding:6px 8px;border-top:1px solid var(--dshg-border);vertical-align:top}.dshg-group{display:flex;flex-direction:column;border-top:1px solid var(--dshg-border)}.dshg-group:first-child{border-top:0}.dshg-groupHead{display:flex;gap:8px;align-items:center;flex-wrap:wrap;width:100%;box-sizing:border-box;background:transparent;border:0;padding:8px 12px;cursor:pointer;font-family:inherit;font-size:12px;color:inherit;text-align:left}.dshg-groupHead:hover{background:var(--dshg-hover)}.dshg-groupBody{display:flex;flex-direction:column;margin:0 12px 8px 26px;padding-left:8px;border-left:2px solid var(--dshg-border2)}"],
      ["feedback", ".dshg-alert{border:1px solid var(--dshg-border2);border-radius:8px;padding:6px 9px;font-size:11.5px;color:var(--dshg-sub)}.dshg-alert[data-tone=warn]{border-color:var(--dshg-warn);color:var(--dshg-warn)}.dshg-alert[data-tone=error]{border-color:var(--dshg-error);color:var(--dshg-error)}.dshg-alert[data-tone=ok]{border-color:var(--dshg-success);color:var(--dshg-success)}.dshg-toasts{display:flex;flex-direction:column;gap:6px;min-height:0}.dshg-toast{display:flex;gap:8px;align-items:center;border:1px solid var(--dshg-border2);border-radius:8px;padding:5px 9px;font-size:11.5px}.dshg-confirm{display:flex;gap:8px;align-items:center;flex-wrap:wrap;border:1px solid var(--dshg-warn);border-radius:9px;padding:8px 10px;background:var(--dshg-layer)}.dshg-skeleton{height:12px;border-radius:6px;background:var(--dshg-layer);margin:4px 0}"],
      ["badges", ".dshg-badge{display:inline-flex;align-items:center;border:1px solid var(--dshg-border2);border-radius:999px;padding:1px 7px;font-size:10.5px;font-weight:600;line-height:1.5}.dshg-badge[data-kind=mcp]{color:var(--dshg-business);border-color:var(--dshg-business)}.dshg-badge[data-kind=skillpack]{color:var(--dshg-success);border-color:var(--dshg-success)}.dshg-badge[data-kind=skill]{color:#8e5cd9;border-color:#8e5cd9}.dshg-badge[data-kind=native]{color:var(--dshg-business)}.dshg-badge[data-kind=plugin]{color:var(--dshg-success)}.dshg-tag{display:inline-flex;align-items:center;border:1px solid var(--dshg-border2);border-radius:5px;padding:0 5px;font-size:10.5px;line-height:1.6;white-space:nowrap}.dshg-tag[data-tone=warn]{color:var(--dshg-warn);border-color:var(--dshg-warn)}.dshg-tag[data-tone=error]{color:var(--dshg-error);border-color:var(--dshg-error)}.dshg-tag[data-tone=ok]{color:var(--dshg-success);border-color:var(--dshg-success)}.dshg-tag[data-tone=business]{color:var(--dshg-business);border-color:var(--dshg-business)}"],
      ["rows", ".dshg-cap{display:flex;flex-direction:column;gap:8px;padding:9px 12px;border-top:1px solid var(--dshg-border)}.dshg-cap:first-child{border-top:0}.dshg-capMain{display:flex;gap:9px;align-items:flex-start;flex-wrap:wrap}.dshg-capId{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;font-weight:600;word-break:break-all}.dshg-capMeta{display:flex;gap:7px;align-items:center;flex-wrap:wrap;color:var(--dshg-sub);font-size:11.5px}.dshg-detail{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dshg-border);border-radius:10px;padding:8px 10px;background:var(--dshg-layer)}.dshg-chain{display:flex;gap:4px;align-items:center;flex-wrap:wrap}.dshg-step{border:1px solid var(--dshg-border);border-radius:5px;padding:0 5px;font-size:10.5px;color:var(--dshg-faint)}.dshg-step[data-hit=true]{color:var(--dshg-business);border-color:var(--dshg-business);font-weight:600}.dshg-member{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:3px 0;border-top:1px dashed var(--dshg-border)}.dshg-member:first-child{border-top:0}.dshg-memberName{flex:1 1 190px;min-width:110px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;word-break:break-all}.dshg-hint{color:var(--dshg-faint);font-size:11px}.dshg-note{color:var(--dshg-sub);font-size:11.5px}.dshg-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;word-break:break-all}"],
      ["json", ".dshg-json{width:100%;box-sizing:border-box;min-height:260px;resize:vertical;border:1px solid var(--dshg-border2);border-radius:8px;padding:8px;background:var(--dsw-specific-input-major,transparent);color:inherit;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.5}.dshg-diff{display:flex;flex-direction:column;gap:4px;font-size:11.5px}.dshg-diffRow{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;padding:2px 0;border-top:1px dashed var(--dshg-border)}"],
      ["a11y", "*:focus-visible{outline:2px solid var(--dsw-alias-border-focus,var(--dshg-business));outline-offset:2px}.dshg-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}"],
      ["responsive", "@media (max-width:720px){.dshg-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.dshg-input{flex-basis:100%}.dshg-json{min-height:200px}}"],
      ["motion", "@media (prefers-reduced-motion:reduce){.dshg-wrap *{transition:none;animation:none;scroll-behavior:auto}}"],
    ]);

    const styleText = () => STYLE_SECTIONS.map((section) => section[1]).join("");

    /* =====================================================================
     * L1 · 传输适配器
     * 单一入口 request({method,path,query,bodyText,timeoutMs,signal,idempotencyKey,kind})
     * 六类失败归一：timeout / aborted / network / http / protocol / auth（外加 missing）
     * 规则：读 8s 仅超时与连接失败重试一次（400ms 退避）；写 15s 不重试；
     *       诊断 5s 不重试且 404 视为能力不存在；2xx 但 ok:false 统一按失败；
     *       读请求不发 JSON 内容类型；头浅合并；告警一律上抛。
     * ===================================================================== */
    function createL1Transport(deps) {
      const env = deps || {};
      const fetchImpl = typeof env.fetch === "function" ? env.fetch : (typeof fetch === "function" ? fetch : null);
      const schedule = typeof env.setTimeout === "function" ? env.setTimeout : (typeof setTimeout === "function" ? setTimeout : null);
      const unschedule = typeof env.clearTimeout === "function" ? env.clearTimeout : (typeof clearTimeout === "function" ? clearTimeout : null);
      const TIMEOUTS = Object.freeze({ read: 8000, write: 15000, diagnose: 5000 });
      const BACKOFF_MS = typeof env.backoffMs === "number" ? env.backoffMs : 400;
      const HARD_CEILING_MS = 16000;
      const KINDS = Object.freeze(["timeout", "aborted", "network", "http", "protocol", "auth", "missing"]);
      const RETRY_KINDS = Object.freeze(["timeout", "network"]);
      const WRITE_METHODS = Object.freeze(["POST", "PUT", "PATCH", "DELETE"]);

      const warningsOf = (body) => (isObject(body) && Array.isArray(body.warnings) ? body.warnings : []);

      const failure = (kind, status, body, error, extra) => Object.assign({
        ok: false,
        kind: kind,
        status: status,
        body: body === undefined ? null : body,
        error: String(error === undefined || error === null ? "" : error),
        code: "",
        warnings: warningsOf(body),
        capabilityMissing: kind === "missing",
        meta: {},
      }, extra || {});

      const buildPath = (path, query) => {
        const base = String(path === undefined || path === null ? "" : path);
        const entries = [];
        if (isObject(query)) {
          const keys = Object.keys(query);
          for (let index = 0; index < keys.length; index += 1) {
            const key = keys[index];
            const value = query[key];
            if (value === undefined || value === null || value === "") continue;
            entries.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
          }
        }
        if (entries.length === 0) return base;
        return base + (base.indexOf("?") >= 0 ? "&" : "?") + entries.join("&");
      };

      const delay = (ms) => new Promise((resolve) => {
        if (!schedule || ms <= 0) { resolve(); return; }
        schedule(resolve, ms);
      });

      /** 纯 JS 取消信号：无 DOM、无 AbortController 也能工作。 */
      const createSignal = () => {
        let aborted = false;
        const listeners = [];
        return {
          get aborted() { return aborted; },
          abort() {
            if (aborted) return;
            aborted = true;
            const pending = listeners.slice();
            listeners.length = 0;
            for (let index = 0; index < pending.length; index += 1) {
              try { pending[index](); } catch (error) { void error; }
            }
          },
          addEventListener(type, fn) {
            if (type !== "abort" || typeof fn !== "function") return;
            if (aborted) { fn(); return; }
            listeners.push(fn);
          },
          removeEventListener(type, fn) {
            if (type !== "abort") return;
            const index = listeners.indexOf(fn);
            if (index >= 0) listeners.splice(index, 1);
          },
        };
      };

      const requestOnce = (spec, timeoutMs) => new Promise((resolve) => {
        let settled = false;
        let timer = null;
        let detach = null;
        const done = (value) => {
          if (settled) return;
          settled = true;
          if (timer !== null && unschedule) unschedule(timer);
          if (detach) { try { detach(); } catch (error) { void error; } }
          resolve(value);
        };
        if (schedule) {
          timer = schedule(() => done(failure("timeout", 0, null, "请求超时（" + timeoutMs + "ms）", { meta: { timeoutMs: timeoutMs } })), Math.max(1, timeoutMs));
        }
        const signal = spec.signal;
        if (signal) {
          if (signal.aborted) { done(failure("aborted", 0, null, "请求已取消")); return; }
          if (typeof signal.addEventListener === "function") {
            const onAbort = () => done(failure("aborted", 0, null, "请求已取消"));
            signal.addEventListener("abort", onAbort);
            detach = () => { if (typeof signal.removeEventListener === "function") signal.removeEventListener("abort", onAbort); };
          }
        }
        const run = async () => {
          if (!fetchImpl) return failure("network", 0, null, "环境没有可用的 fetch");
          const method = String(spec.method || "GET").toUpperCase();
          const isWrite = WRITE_METHODS.indexOf(method) >= 0;
          const headers = Object.assign({}, isWrite ? { "content-type": "application/json" } : {}, isObject(spec.headers) ? spec.headers : {});
          if (spec.idempotencyKey) headers["x-dsh-gate-idempotency"] = String(spec.idempotencyKey);
          if (spec.agent) headers["x-dsh-gate-agent"] = String(spec.agent);
          const init = { method: method, headers: headers };
          if (spec.bodyText !== undefined && spec.bodyText !== null) init.body = String(spec.bodyText);
          try {
            const response = await fetchImpl(buildPath(spec.path, spec.query), init);
            if (!response || typeof response.status !== "number") return failure("protocol", 0, null, "响应形状不合法");
            let raw = "";
            try { raw = await response.text(); } catch (error) { return failure("protocol", response.status, null, "读取响应体失败：" + errorText(error)); }
            let body = null;
            let nonJson = false;
            if (typeof raw === "string" && raw.length > 0) {
              try { body = JSON.parse(raw); } catch (error) { nonJson = true; body = null; }
            }
            const status = response.status;
            if (status < 200 || status >= 300) {
              const envelope = isObject(body) ? body : {};
              const message = envelope.message || envelope.error || ("HTTP " + status);
              const kind = status === 401 || status === 403 ? "auth" : status === 404 ? "missing" : "http";
              return failure(kind, status, body, message, { code: String(envelope.code || ""), meta: { retryable: false } });
            }
            if (nonJson) return failure("protocol", status, null, "响应不是 JSON（HTTP " + status + "）", { meta: { retryable: false } });
            if (isObject(body) && body.ok === false) {
              return failure("protocol", status, body, body.message || body.code || "服务端判定失败", { code: String(body.code || ""), meta: { retryable: false } });
            }
            return {
              ok: true,
              kind: "ok",
              status: status,
              body: body,
              error: "",
              code: "",
              warnings: warningsOf(body),
              capabilityMissing: false,
              meta: { retryable: false },
            };
          } catch (error) {
            const name = String(error && error.name || "");
            if (name === "AbortError") return failure("aborted", 0, null, "请求已取消");
            return failure("network", 0, null, errorText(error) || "Failed to fetch", { meta: { retryable: true } });
          }
        };
        run().then(done, (error) => done(failure("network", 0, null, errorText(error))));
      });

      const request = async (spec) => {
        const input = spec || {};
        const requestKind = input.kind === "write" ? "write" : input.kind === "diagnose" ? "diagnose" : "read";
        const method = String(input.method || (requestKind === "write" ? "POST" : "GET")).toUpperCase();
        const timeoutMs = typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? input.timeoutMs : TIMEOUTS[requestKind];
        const meta = {
          method: method,
          path: String(input.path || ""),
          requestKind: requestKind,
          agent: input.agent === undefined ? null : input.agent,
          timeoutMs: timeoutMs,
          attempts: 1,
          revision: null,
        };
        let result = await requestOnce(Object.assign({}, input, { method: method }), timeoutMs);
        if (requestKind === "read" && RETRY_KINDS.indexOf(result.kind) >= 0) {
          await delay(BACKOFF_MS);
          result = await requestOnce(Object.assign({}, input, { method: method }), timeoutMs);
          meta.attempts = 2;
        }
        result.meta = Object.assign(meta, result.meta || {});
        result.warnings = warningsOf(result.body);
        result.revision = isObject(result.body) && result.body.revision !== undefined ? result.body.revision : null;
        result.serverStatus = result.status;
        return result;
      };

      const read = (path, options) => request(Object.assign({ kind: "read", method: "GET", path: path }, options || {}));
      let writeSeq = 0;
      const write = (path, body, options) => {
        const bodyText = body === undefined || body === null ? undefined : (typeof body === "string" ? body : JSON.stringify(body));
        const merged = Object.assign({ kind: "write", method: "POST", path: path, bodyText: bodyText }, options || {});
        if (!merged.idempotencyKey) {
          writeSeq += 1;
          merged.idempotencyKey = "w" + writeSeq + ":" + fnv1a((path || "") + "|" + (bodyText || ""));
        }
        return request(merged);
      };
      const diagnose = (path, options) => request(Object.assign({ kind: "diagnose", method: "GET", path: path, timeoutMs: TIMEOUTS.diagnose }, options || {}));

      const describe = (result) => {
        const value = result || {};
        if (value.ok) return { tone: "ok", text: "" };
        const kind = value.kind || "network";
        if (kind === "timeout") return { tone: "error", text: "请求超时：" + (value.error || "") };
        if (kind === "aborted") return { tone: "warn", text: "请求已取消" };
        if (kind === "auth") return { tone: "error", text: "鉴权失败：" + (value.error || "") };
        if (kind === "missing") return { tone: "warn", text: "能力不存在：" + (value.error || "") };
        if (kind === "protocol") return { tone: "error", text: "协议错误：" + (value.error || "") };
        if (kind === "http") return { tone: "error", text: "服务端拒绝：" + (value.error || "") };
        return { tone: "error", text: "连接失败：" + (value.error || "") };
      };

      return Object.freeze({
        TIMEOUTS: TIMEOUTS,
        BACKOFF_MS: BACKOFF_MS,
        HARD_CEILING_MS: HARD_CEILING_MS,
        KINDS: KINDS,
        RETRY_KINDS: RETRY_KINDS,
        request: request,
        read: read,
        write: write,
        diagnose: diagnose,
        describe: describe,
        createSignal: createSignal,
        buildPath: buildPath,
        failure: failure,
        warningsOf: warningsOf,
      });
    }

    /* =====================================================================
     * L2 · 草稿仓库（切片、脏集合、动作级撤销重做、键规范化、提交体生成）
     * 规范键：cap: / exc: / skill: / section: / imp:（另有 default:/close:/guard:/cat:/sig:）
     * 唯一刷新前置判据 = dirtyCount() > 0；撤销按动作记录，撤销后与基线比对重算脏。
     * ===================================================================== */
    function createL2DraftStore(deps) {
      const env = deps || {};
      const MAX_UNDO = 50;
      const PREFIX = Object.freeze({ cap: "cap:", exc: "exc:", skill: "skill:", section: "section:", imp: "imp:", close: "close:", guard: "guard:", cat: "cat:", sig: "sig:", def: "default:" });

      const keys = {
        cap: (id) => PREFIX.cap + String(id),
        exception: (id, kind, name) => PREFIX.exc + String(id) + "|" + String(kind) + ":" + String(name),
        skill: (name) => PREFIX.skill + String(name),
        section: (name) => PREFIX.section + String(name),
        imports: (path, index) => PREFIX.imp + fnv1a(String(path)) + "#" + String(index).padStart(2, "0"),
        close: (name) => PREFIX.close + String(name),
        guard: (field) => PREFIX.guard + String(field),
        catalog: (field) => PREFIX.cat + String(field),
        signature: (field) => PREFIX.sig + String(field),
        defaults: (field) => PREFIX.def + String(field),
      };

      const kindOfKey = (key) => {
        const text = String(key);
        if (text.indexOf(PREFIX.exc) === 0) return "exceptions";
        if (text.indexOf(PREFIX.skill) === 0 || text.indexOf(PREFIX.close) === 0) return "skills";
        if (text.indexOf(PREFIX.imp) === 0) return "imports";
        if (text.indexOf(PREFIX.sig) === 0) return "signature";
        if (text.indexOf(PREFIX.guard) === 0) return "guardrail";
        if (text.indexOf(PREFIX.cat) === 0) return "catalog";
        if (text.indexOf(PREFIX.cap) === 0 || text.indexOf(PREFIX.section) === 0 || text.indexOf(PREFIX.def) === 0) return "caps";
        return "other";
      };

      const emptyPolicy = () => ({
        version: 3,
        enabled: true,
        defaults: { capability: TIER_ONDEMAND, section: TIER_RESIDENT, skillpack: TIER_ONDEMAND },
        capabilities: {},
        sources: {},
        legacy: { unknownOverrides: {} },
        catalog: { groupByPlugin: true, maxDescriptionLength: 64, skillGroups: false, signatureSummary: { enabled: true, tools: [] } },
        narrowPassThrough: 12,
        protected: [],
        skills: { takeover: true, off: [], imports: [] },
        mcp: { servers: {} },
        repeatGuard: { enabled: true, windowSize: 10, threshold: 3, reminders: 1, previewChars: 400, exclusions: [] },
      });

      const state = {
        cells: {},
        baseline: null,
        baselineMeta: {},
        undo: [],
        redo: [],
        revision: 1,
        jsonRevision: 1,
        jsonDirty: false,
        jsonText: "",
      };

      const same = (left, right) => {
        if (left === undefined || right === undefined) return left === right;
        return fingerprint(left) === fingerprint(right);
      };

      const basePolicy = () => (isObject(state.baseline) ? state.baseline : emptyPolicy());
      const capabilityOf = (content, id) => (isObject(content.capabilities) && isObject(content.capabilities[id]) ? content.capabilities[id] : {});
      const importsOf = (content) => {
        const skills = isObject(content.skills) ? content.skills : {};
        return listOf(skills.imports).filter((item) => isObject(item) && typeof item.path === "string");
      };
      const offOf = (content) => {
        const skills = isObject(content.skills) ? content.skills : {};
        return listOf(skills.off).filter((name) => typeof name === "string");
      };

      const parseExceptionKey = (key) => {
        const body = String(key).slice(PREFIX.exc.length);
        const split = body.indexOf("|");
        if (split < 0) return null;
        const id = body.slice(0, split);
        const rest = body.slice(split + 1);
        const colon = rest.indexOf(":");
        if (colon < 0) return null;
        return { id: id, kind: rest.slice(0, colon), name: rest.slice(colon + 1) };
      };

      /** 从基线里读出某个规范键对应的服务端值（未脏判据的另一半）。 */
      const baseFor = (key) => {
        const content = basePolicy();
        const text = String(key);
        if (text.indexOf(PREFIX.cap) === 0) {
          const id = text.slice(PREFIX.cap.length);
          const entry = capabilityOf(content, id);
          return entry.tier === undefined ? undefined : entry.tier;
        }
        if (text.indexOf(PREFIX.section) === 0) {
          const entry = capabilityOf(content, text.slice(PREFIX.section.length));
          return entry.tier === undefined ? undefined : entry.tier;
        }
        if (text.indexOf(PREFIX.skill) === 0) {
          const entry = content.capabilities && content.capabilities[text];
          return isObject(entry) && entry.tier !== undefined ? entry.tier : undefined;
        }
        if (text.indexOf(PREFIX.exc) === 0) {
          const parsed = parseExceptionKey(text);
          if (!parsed) return undefined;
          const entry = capabilityOf(content, parsed.id);
          const map = parsed.kind === "section" ? entry.sectionExceptions : entry.toolExceptions;
          return isObject(map) && hasOwn(map, parsed.name) ? map[parsed.name] : undefined;
        }
        if (text.indexOf(PREFIX.imp) === 0) {
          const index = Number(text.slice(text.indexOf("#") + 1));
          const list = importsOf(content);
          if (!Number.isFinite(index) || index < 0 || index >= list.length) return undefined;
          const expected = fnv1a(String(list[index].path));
          if (text.slice(PREFIX.imp.length, text.indexOf("#")) !== expected) return undefined;
          return { path: list[index].path, id: list[index].id };
        }
        if (text.indexOf(PREFIX.close) === 0) {
          const name = text.slice(PREFIX.close.length);
          return offOf(content).indexOf(name) >= 0 ? name : undefined;
        }
        if (text.indexOf(PREFIX.guard) === 0) {
          const guard = isObject(content.repeatGuard) ? content.repeatGuard : {};
          const field = text.slice(PREFIX.guard.length);
          return hasOwn(guard, field) ? guard[field] : undefined;
        }
        if (text.indexOf(PREFIX.cat) === 0) {
          const catalog = isObject(content.catalog) ? content.catalog : {};
          const field = text.slice(PREFIX.cat.length);
          return hasOwn(catalog, field) ? catalog[field] : undefined;
        }
        if (text.indexOf(PREFIX.sig) === 0) {
          const catalog = isObject(content.catalog) ? content.catalog : {};
          const summary = isObject(catalog.signatureSummary) ? catalog.signatureSummary : {};
          const field = text.slice(PREFIX.sig.length);
          if (field === "enabled") return summary.enabled !== false;
          if (field === "tools") return listOf(summary.tools).filter((name) => typeof name === "string");
          return undefined;
        }
        if (text.indexOf(PREFIX.def) === 0) {
          const field = text.slice(PREFIX.def.length);
          if (field === "skillpack") {
            const defaults = isObject(content.defaults) ? content.defaults : {};
            return defaults.skillpack;
          }
          if (field === "takeover") {
            const skills = isObject(content.skills) ? content.skills : {};
            return skills.takeover !== false;
          }
        }
        return undefined;
      };

      const applyOps = (ops) => {
        for (let index = 0; index < ops.length; index += 1) {
          const op = ops[index];
          if (op.after === undefined) {
            delete state.cells[op.key];
            continue;
          }
          state.cells[op.key] = {
            key: op.key,
            kind: op.kind || kindOfKey(op.key),
            value: op.after,
            base: baseFor(op.key),
            dirty: true,
            label: op.label || op.key,
          };
        }
        recomputeDirty();
      };

      const recomputeDirty = () => {
        let dirty = 0;
        const ids = Object.keys(state.cells);
        for (let index = 0; index < ids.length; index += 1) {
          const cell = state.cells[ids[index]];
          cell.base = baseFor(cell.key);
          cell.dirty = !same(cell.value, cell.base);
          if (cell.dirty) dirty += 1;
          else delete state.cells[cell.key];
        }
        return dirty;
      };

      const pushAction = (action) => {
        state.undo.push(action);
        if (state.undo.length > MAX_UNDO) state.undo.shift();
        state.redo.length = 0;
        state.revision += 1;
      };

      const stage = (key, value, label) => {
        const existing = state.cells[key];
        const before = existing ? existing.value : undefined;
        if (same(before, value)) return false;
        applyOps([{ key: key, before: before, after: value, kind: kindOfKey(key), label: label }]);
        pushAction({ label: label || key, ops: [{ key: key, before: before, after: value, kind: kindOfKey(key), label: label }] });
        return true;
      };

      const stageMany = (entries, label) => {
        const ops = [];
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index] || {};
          const existing = state.cells[entry.key];
          const before = existing ? existing.value : undefined;
          if (same(before, entry.value)) continue;
          ops.push({ key: entry.key, before: before, after: entry.value, kind: kindOfKey(entry.key), label: entry.label });
        }
        if (ops.length === 0) return false;
        applyOps(ops);
        pushAction({ label: label || "批量暂存", ops: ops });
        return true;
      };

      const invert = (action) => ({
        label: "撤销：" + action.label,
        ops: action.ops.slice().reverse().map((op) => ({ key: op.key, before: op.after, after: op.before, kind: op.kind, label: op.label })),
      });

      const undo = () => {
        const action = state.undo.pop();
        if (!action) return null;
        applyOps(invert(action).ops);
        state.redo.push(action);
        state.revision += 1;
        return action;
      };

      const redo = () => {
        const action = state.redo.pop();
        if (!action) return null;
        applyOps(action.ops);
        state.undo.push(action);
        state.revision += 1;
        return action;
      };

      const dirtyKeys = () => Object.keys(state.cells).filter((key) => state.cells[key] && state.cells[key].dirty === true);

      const dirtySummary = () => {
        const byKind = { caps: 0, exceptions: 0, skills: 0, imports: 0, signature: 0, guardrail: 0, catalog: 0, other: 0 };
        const listed = dirtyKeys();
        for (let index = 0; index < listed.length; index += 1) byKind[kindOfKey(listed[index])] += 1;
        const json = state.jsonDirty === true ? 1 : 0;
        const total = byKind.caps + byKind.exceptions + byKind.skills + byKind.imports + byKind.signature + byKind.guardrail + byKind.catalog + byKind.other + json;
        const parts = [];
        if (byKind.caps > 0) parts.push("能力 " + byKind.caps + " 项");
        if (byKind.exceptions > 0) parts.push("例外 " + byKind.exceptions + " 项");
        if (byKind.skills > 0) parts.push("技能 " + byKind.skills + " 项");
        if (byKind.imports > 0) parts.push("导入 " + byKind.imports + " 项");
        if (byKind.signature > 0) parts.push("签名 " + byKind.signature + " 项");
        if (byKind.guardrail > 0) parts.push("护栏 " + byKind.guardrail + " 项");
        if (byKind.catalog > 0) parts.push("目录 " + byKind.catalog + " 项");
        if (json > 0) parts.push("JSON 草稿");
        return {
          total: total,
          byKind: byKind,
          jsonDirty: state.jsonDirty === true,
          keys: listed,
          text: parts.length === 0 ? "没有未保存改动" : parts.join("、"),
        };
      };

      const discardAll = (reason) => {
        const listed = dirtyKeys();
        if (listed.length === 0 && state.jsonDirty !== true) return false;
        const ops = listed.map((key) => ({ key: key, before: state.cells[key].value, after: undefined, kind: kindOfKey(key), label: reason || "丢弃全部草稿" }));
        if (ops.length > 0) {
          applyOps(ops);
          pushAction({ label: reason || "丢弃全部草稿", ops: ops });
        }
        state.jsonDirty = false;
        state.jsonRevision += 1;
        return true;
      };

      const discardKind = (kind) => {
        const listed = dirtyKeys();
        const ops = [];
        for (let index = 0; index < listed.length; index += 1) {
          if (kindOfKey(listed[index]) !== kind) continue;
          ops.push({ key: listed[index], before: state.cells[listed[index]].value, after: undefined, kind: kind, label: "丢弃 " + kind });
        }
        if (ops.length === 0) return false;
        applyOps(ops);
        pushAction({ label: "丢弃 " + kind, ops: ops });
        return true;
      };

      /** 提交成功后只清对应脏切片（不可撤销：服务端已经是新值）。 */
      const commitKeys = (listed) => {
        const keysToClear = Array.isArray(listed) ? listed : dirtyKeys();
        for (let index = 0; index < keysToClear.length; index += 1) delete state.cells[keysToClear[index]];
        state.revision += 1;
        recomputeDirty();
        return keysToClear.length;
      };

      const retainKeys = (listed) => {
        const keep = Array.isArray(listed) ? listed : [];
        const all = Object.keys(state.cells);
        for (let index = 0; index < all.length; index += 1) if (keep.indexOf(all[index]) < 0) delete state.cells[all[index]];
        state.revision += 1;
        recomputeDirty();
      };

      const setBaseline = (content, meta) => {
        state.baseline = isObject(content) ? clone(content) : emptyPolicy();
        state.baselineMeta = meta || {};
        recomputeDirty();
        state.revision += 1;
      };

      const importsSnapshot = () => {
        const content = basePolicy();
        const base = importsOf(content);
        const out = [];
        const consumed = {};
        for (let index = 0; index < base.length; index += 1) {
          const key = keys.imports(base[index].path, index);
          const cell = state.cells[key];
          consumed[key] = true;
          if (!cell) { out.push({ path: base[index].path, id: base[index].id, key: key }); continue; }
          if (cell.value === null) continue;
          if (isObject(cell.value)) out.push({ path: cell.value.path, id: cell.value.id, key: key });
        }
        const extras = Object.keys(state.cells).filter((key) => key.indexOf(PREFIX.imp) === 0 && consumed[key] !== true).sort();
        for (let index = 0; index < extras.length; index += 1) {
          const cell = state.cells[extras[index]];
          if (isObject(cell.value) && typeof cell.value.path === "string") out.push({ path: cell.value.path, id: cell.value.id, key: extras[index] });
        }
        return out;
      };

      const importsDirty = () => dirtyKeys().some((key) => key.indexOf(PREFIX.imp) === 0);

      const stageImport = (path, id) => {
        const text = String(path === undefined || path === null ? "" : path).trim();
        if (text.length === 0) return false;
        const current = importsSnapshot();
        const ordinal = current.filter((item) => item.path === text).length;
        const key = keys.imports(text, current.length + ordinal);
        return stage(key, { path: text, id: id }, "导入 " + text);
      };

      const removeImport = (path) => {
        const current = importsSnapshot();
        const index = current.findIndex((item) => item.path === path);
        if (index < 0) return false;
        const key = current[index].key;
        const base = baseFor(key);
        const value = base === undefined ? undefined : null;
        if (value === undefined) {
          delete state.cells[key];
          state.revision += 1;
          return true;
        }
        return stage(key, null, "移除导入 " + path);
      };

      const stageClose = (name) => stage(keys.close(name), null, "从旧关闭清单移除 " + name);

      const clearCloseList = () => {
        const off = offOf(basePolicy());
        const entries = off.map((name) => ({ key: keys.close(name), value: null }));
        return stageMany(entries, "清空旧关闭清单");
      };

      const offRemoved = () => dirtyKeys().filter((key) => key.indexOf(PREFIX.close) === 0).map((key) => key.slice(PREFIX.close.length));

      const signatureSnapshot = () => {
        const enabledCell = state.cells[keys.signature("enabled")];
        const toolsCell = state.cells[keys.signature("tools")];
        return {
          enabled: enabledCell ? enabledCell.value === true : baseFor(keys.signature("enabled")),
          tools: toolsCell ? listOf(toolsCell.value) : listOf(baseFor(keys.signature("tools"))),
          enabledDirty: Boolean(enabledCell && enabledCell.dirty),
          toolsDirty: Boolean(toolsCell && toolsCell.dirty),
        };
      };

      const policySnapshot = () => {
        const cells = state.cells;
        const caps = {};
        const exceptions = {};
        const skills = {};
        let skillpack;
        let takeover;
        const guardrail = {};
        const catalog = {};
        let signatureEnabled;
        let signatureTools;
        const ids = Object.keys(cells);
        for (let index = 0; index < ids.length; index += 1) {
          const key = ids[index];
          const cell = cells[key];
          if (!cell || cell.dirty !== true) continue;
          if (key.indexOf(PREFIX.cap) === 0) caps[key.slice(PREFIX.cap.length)] = cell.value;
          else if (key.indexOf(PREFIX.section) === 0) caps[key.slice(PREFIX.section.length)] = cell.value;
          else if (key.indexOf(PREFIX.skill) === 0) skills[key.slice(PREFIX.skill.length)] = cell.value;
          else if (key.indexOf(PREFIX.exc) === 0) {
            const parsed = parseExceptionKey(key);
            if (!parsed) continue;
            const group = exceptions[parsed.id] || (exceptions[parsed.id] = {});
            const map = group[parsed.kind] || (group[parsed.kind] = {});
            map[parsed.name] = cell.value;
          } else if (key.indexOf(PREFIX.guard) === 0) guardrail[key.slice(PREFIX.guard.length)] = cell.value;
          else if (key.indexOf(PREFIX.cat) === 0) catalog[key.slice(PREFIX.cat.length)] = cell.value;
          else if (key === keys.signature("enabled")) signatureEnabled = cell.value === true;
          else if (key === keys.signature("tools")) signatureTools = listOf(cell.value);
          else if (key === keys.defaults("skillpack")) skillpack = cell.value;
          else if (key === keys.defaults("takeover")) takeover = cell.value === true;
        }
        return {
          revision: state.revision,
          jsonDirty: state.jsonDirty === true,
          jsonText: state.jsonText,
          summary: dirtySummary(),
          caps: caps,
          exceptions: exceptions,
          skills: skills,
          skillpack: skillpack,
          takeover: takeover,
          imports: importsDirty() ? importsSnapshot() : null,
          offRemoved: offRemoved(),
          signature: { enabled: signatureEnabled, tools: signatureTools },
          guardrail: guardrail,
          catalog: catalog,
          diverged: dirtyKeys().length,
        };
      };

      const toPolicy = () => {
        const content = clone(basePolicy());
        content.version = 3;
        if (!isObject(content.capabilities)) content.capabilities = {};
        if (!isObject(content.defaults)) content.defaults = {};
        if (!isObject(content.skills)) content.skills = { takeover: true, off: [], imports: [] };
        if (!isObject(content.catalog)) content.catalog = { groupByPlugin: true, maxDescriptionLength: 64 };
        if (!isObject(content.repeatGuard)) content.repeatGuard = { enabled: true, windowSize: 10, threshold: 3, reminders: 1, previewChars: 400, exclusions: [] };
        const snapshot = policySnapshot();
        const capIds = Object.keys(snapshot.caps);
        for (let index = 0; index < capIds.length; index += 1) {
          const id = capIds[index];
          const entry = isObject(content.capabilities[id]) ? content.capabilities[id] : {};
          if (snapshot.caps[id] === null) delete entry.tier;
          else entry.tier = snapshot.caps[id];
          content.capabilities[id] = entry;
        }
        const skillNames = Object.keys(snapshot.skills);
        for (let index = 0; index < skillNames.length; index += 1) {
          const name = skillNames[index];
          const id = "skill:" + name;
          const entry = isObject(content.capabilities[id]) ? content.capabilities[id] : {};
          if (snapshot.skills[name] === null) delete entry.tier;
          else entry.tier = snapshot.skills[name];
          content.capabilities[id] = entry;
        }
        const exceptionIds = Object.keys(snapshot.exceptions);
        for (let index = 0; index < exceptionIds.length; index += 1) {
          const id = exceptionIds[index];
          const entry = isObject(content.capabilities[id]) ? content.capabilities[id] : {};
          const group = snapshot.exceptions[id];
          const kindKeys = ["tool", "section"];
          for (let cursor = 0; cursor < kindKeys.length; cursor += 1) {
            const kind = kindKeys[cursor];
            const staged = isObject(group[kind]) ? group[kind] : null;
            if (!staged) continue;
            const field = kind === "section" ? "sectionExceptions" : "toolExceptions";
            const map = Object.assign({}, isObject(entry[field]) ? entry[field] : {});
            const names = Object.keys(staged);
            for (let offset = 0; offset < names.length; offset += 1) {
              const name = names[offset];
              if (staged[name] === null) delete map[name];
              else map[name] = staged[name];
            }
            entry[field] = map;
          }
          content.capabilities[id] = entry;
        }
        if (snapshot.skillpack !== undefined) content.defaults.skillpack = snapshot.skillpack;
        if (snapshot.takeover !== undefined) content.skills.takeover = snapshot.takeover;
        if (snapshot.imports !== null) content.skills.imports = snapshot.imports.map((item) => (item.id ? { id: item.id, path: item.path } : { path: item.path }));
        if (snapshot.offRemoved.length > 0) {
          const removed = snapshot.offRemoved;
          content.skills.off = offOf(content).filter((name) => removed.indexOf(name) < 0);
        }
        const guardFields = Object.keys(snapshot.guardrail);
        for (let index = 0; index < guardFields.length; index += 1) content.repeatGuard[guardFields[index]] = snapshot.guardrail[guardFields[index]];
        const catalogFields = Object.keys(snapshot.catalog);
        for (let index = 0; index < catalogFields.length; index += 1) content.catalog[catalogFields[index]] = snapshot.catalog[catalogFields[index]];
        if (snapshot.signature.enabled !== undefined || snapshot.signature.tools !== undefined) {
          const baseSummary = isObject(content.catalog.signatureSummary) ? content.catalog.signatureSummary : { enabled: true, tools: [] };
          content.catalog.signatureSummary = {
            enabled: snapshot.signature.enabled === undefined ? baseSummary.enabled !== false : snapshot.signature.enabled,
            tools: snapshot.signature.tools === undefined ? listOf(baseSummary.tools) : snapshot.signature.tools,
          };
        }
        return content;
      };

      const revisionOf = () => (state.baselineMeta && state.baselineMeta.revision !== undefined ? state.baselineMeta.revision : null);

      const toPolicyBody = (options) => Object.assign(clone(toPolicy()), { replace: true, revision: revisionOf() }, options || {});
      const toSignatureBody = () => {
        const snapshot = signatureSnapshot();
        const body = { catalog: { signatureSummary: { enabled: snapshot.enabled === true, tools: listOf(snapshot.tools) } } };
        if (revisionOf() !== null) body.revision = revisionOf();
        return body;
      };
      const toGuardBody = () => {
        const snapshot = policySnapshot();
        const body = { repeatGuard: snapshot.guardrail };
        if (revisionOf() !== null) body.revision = revisionOf();
        return body;
      };
      const toCatalogBody = () => {
        const snapshot = policySnapshot();
        const body = { catalog: snapshot.catalog };
        if (revisionOf() !== null) body.revision = revisionOf();
        return body;
      };

      const toSkillOperations = () => {
        const snapshot = policySnapshot();
        const operations = [];
        if (snapshot.imports !== null) operations.push({ action: "imports", imports: snapshot.imports.map((item) => (item.id ? { id: item.id, path: item.path } : { path: item.path })), key: snapshot.summary.keys.filter((key) => String(key).indexOf(PREFIX.imp) === 0)[0] });
        if (snapshot.takeover !== undefined) operations.push({ action: "takeover", value: snapshot.takeover === true, key: keys.defaults("takeover") });
        const names = Object.keys(snapshot.skills);
        for (let index = 0; index < names.length; index += 1) operations.push({ action: "tier", name: names[index], tier: snapshot.skills[names[index]], key: keys.skill(names[index]) });
        for (let index = 0; index < snapshot.offRemoved.length; index += 1) operations.push({ action: "off-remove", name: snapshot.offRemoved[index], key: keys.close(snapshot.offRemoved[index]) });
        return operations;
      };

      const keysForSkillOperations = () => dirtyKeys().filter((key) => key.indexOf(PREFIX.skill) === 0 || key.indexOf(PREFIX.close) === 0 || key.indexOf(PREFIX.imp) === 0 || key === keys.defaults("takeover"));

      const json = {
        setText: (text) => {
          const next = String(text === undefined || text === null ? "" : text);
          if (state.jsonText === next) return false;
          state.jsonText = next;
          state.jsonRevision += 1;
          return true;
        },
        setDirty: (dirty, text) => {
          const next = dirty === true;
          const changed = state.jsonDirty !== next || (text !== undefined && state.jsonText !== String(text));
          if (!changed) return false;
          state.jsonDirty = next;
          if (text !== undefined) state.jsonText = String(text);
          state.jsonRevision += 1;
          return true;
        },
        snapshot: () => ({ dirty: state.jsonDirty === true, text: state.jsonText, revision: state.jsonRevision }),
      };

      return Object.freeze({
        MAX_UNDO: MAX_UNDO,
        PREFIX: PREFIX,
        keys: Object.freeze(keys),
        kindOfKey: kindOfKey,
        stage: stage,
        stageMany: stageMany,
        stageImport: stageImport,
        removeImport: removeImport,
        stageClose: stageClose,
        clearCloseList: clearCloseList,
        undo: undo,
        redo: redo,
        canUndo: () => state.undo.length > 0,
        canRedo: () => state.redo.length > 0,
        undoDepth: () => state.undo.length,
        redoDepth: () => state.redo.length,
        dirtyKeys: dirtyKeys,
        dirtyCount: () => dirtyKeys().length + (state.jsonDirty === true ? 1 : 0),
        dirtySummary: dirtySummary,
        discardAll: discardAll,
        discardKind: discardKind,
        commitKeys: commitKeys,
        retainKeys: retainKeys,
        setBaseline: setBaseline,
        snapshot: policySnapshot,
        imports: importsSnapshot,
        signature: signatureSnapshot,
        toPolicy: toPolicy,
        toPolicyBody: toPolicyBody,
        toSignatureBody: toSignatureBody,
        toGuardBody: toGuardBody,
        toCatalogBody: toCatalogBody,
        toSkillOperations: toSkillOperations,
        keysForSkillOperations: keysForSkillOperations,
        json: json,
        baseline: () => state.baseline,
        revision: () => state.revision,
      });
    }

    /* =====================================================================
     * L3 · 策略投影（纯函数；不读时钟、不碰渲染库、无副作用）
     * 输出行模型 / 分组 / 统计 / 健康度 / 抱怨清单 / 决策链 / 差异。
     * 层值真值表全行解析；合成行与真实行去重；种类单派生；按输入指纹缓存。
     * ===================================================================== */
    function createL3Projection(deps) {
      const env = deps || {};
      const KIND_ORDER = Object.freeze({ mcp: 0, plugin: 1, skillpack: 2, skill: 3, native: 4, section: 5, glob: 6, unknown: 7 });
      const KIND_LABEL = Object.freeze({ mcp: "MCP", plugin: "插件", skillpack: "技能包", skill: "技能", native: "原生", section: "段落", glob: "通配", unknown: "未知来源" });
      const REASON_LABEL = Object.freeze({
        own: "自身层（restrict 管不到）",
        preset: "预设层",
        loaded: "本会话已加载",
        protected: "保护名单",
        exception: "例外（显式偏离）",
        capability: "能力层",
        skill: "单技能层",
        takeover: "闸门接管",
        defaults: "defaults 默认层",
        declared: "sources 声明但当前表面没有",
        unknown: "来源未知，只标注不隐藏",
      });
      const VIA_LABEL = Object.freeze({ sources: "显式 sources", naming: "命名约定", prefix: "包前缀推断", native: "原生清单", provider: "provider 声明", name: "技能名", unknown: "推不出来源" });
      const CONF_LABEL = Object.freeze({ high: "高", medium: "中", low: "低", unknown: "未知" });
      const CONF_RANK = Object.freeze({ high: 0, medium: 1, low: 2, unknown: 3 });
      const TIER_LABEL_LOCAL = Object.freeze({ 0: "关闭", 1: "常驻", 2: "按需" });
      const CHAIN_ORDER = Object.freeze([
        ["own", "own"], ["preset", "preset"], ["loaded", "loaded"], ["protected", "protected"],
        ["sources", "sources"], ["infer", "推断"], ["capability", "能力层"], ["exception", "例外"], ["defaults", "defaults"],
      ]);
      const DEFAULT_TIERS = Object.freeze({ capability: 2, section: 1, skillpack: 2 });

      const cache = { key: "", value: null, recomputes: 0, hits: 0 };

      const kindOf = (id) => {
        const text = String(id === undefined || id === null ? "" : id);
        if (text.indexOf("mcp:") === 0) return "mcp";
        if (text.indexOf("skillpack:") === 0) return "skillpack";
        if (text.indexOf("skill:") === 0) return "skill";
        if (text.indexOf("plugin:") === 0) return "plugin";
        if (text.indexOf("native:") === 0) return "native";
        if (text.indexOf("section:") === 0) return "section";
        if (text.indexOf("glob:") === 0) return "glob";
        return "unknown";
      };

      /**
       * 层值真值表（全行）：
       *   0/1/2 与 "0"/"1"/"2" → set；带空白数字串 trim 解析并记警告；
       *   null/undefined → unset（不折算）；"" → unset + 警告；
       *   true/false、数组、对象、小数、负数、越界、"七" → invalid（标红、阻断保存）。
       */
      const parseTierValue = (raw) => {
        if (raw === null || raw === undefined) return { value: null, state: "unset", blocking: false, reason: "" };
        if (raw === "") return { value: null, state: "unset", blocking: false, warning: "层值为空串，按未设置处理", reason: "" };
        if (typeof raw === "boolean") return { value: null, state: "invalid", blocking: true, reason: "布尔值不是合法层值（" + String(raw) + "）" };
        if (Array.isArray(raw)) return { value: null, state: "invalid", blocking: true, reason: "数组不是合法层值" };
        if (typeof raw === "object") return { value: null, state: "invalid", blocking: true, reason: "对象不是合法层值" };
        if (typeof raw === "number") {
          if (Number.isInteger(raw) && raw >= 0 && raw <= 2) return { value: raw, state: "set", blocking: false, reason: "" };
          return { value: null, state: "invalid", blocking: true, reason: "层值只能是 0/1/2（收到 " + String(raw) + "）" };
        }
        if (typeof raw === "string") {
          const trimmed = raw.trim();
          if (trimmed === "") return { value: null, state: "unset", blocking: false, warning: "层值为空白串，按未设置处理", reason: "" };
          if (trimmed === "0" || trimmed === "1" || trimmed === "2") {
            return {
              value: Number(trimmed),
              state: "set",
              blocking: false,
              normalized: true,
              warning: trimmed === raw ? "非数字输入，已按数字层值处理" : "层值带空白，已解析为 " + trimmed,
              reason: "",
            };
          }
          if (trimmed === "七") return { value: null, state: "invalid", blocking: true, reason: "「七」不是合法层值" };
          return { value: null, state: "invalid", blocking: true, reason: "层值只能是 0/1/2（收到「" + raw + "」）" };
        }
        return { value: null, state: "invalid", blocking: true, reason: "无法识别的层值类型" };
      };

      const tierOf = (raw, fallback) => {
        const parsed = parseTierValue(raw);
        return parsed.state === "set" ? parsed.value : fallback;
      };

      const chainFor = (row) => {
        const members = row.members.all;
        const counts = { own: 0, preset: 0, loaded: 0, protected: 0, sources: 0, infer: 0, capability: 0, exception: 0, defaults: 0 };
        for (let index = 0; index < members.length; index += 1) {
          const member = members[index];
          if (hasOwn(counts, member.reason)) counts[member.reason] += 1;
          if (member.via === "sources") counts.sources += 1;
          else if (member.via === "naming" || member.via === "prefix" || member.via === "native" || member.via === "unknown") counts.infer += 1;
        }
        const steps = [];
        let winner = "";
        for (let index = 0; index < CHAIN_ORDER.length; index += 1) {
          const key = CHAIN_ORDER[index][0];
          const hit = counts[key] > 0;
          if (hit && winner === "") winner = key;
          steps.push({ key: key, label: CHAIN_ORDER[index][1], count: counts[key], hit: hit, winner: winner === key });
        }
        const winnerStep = steps.filter((step) => step.winner)[0] || null;
        return {
          steps: steps,
          winner: winner,
          winnerLabel: winnerStep ? winnerStep.label : "",
          finalTier: row.effectiveTier,
          hitRule: winner === "" ? "defaults" : winner,
          reasonChain: steps.filter((step) => step.hit).map((step) => step.label),
          text: winner === "" ? "没有成员命中任何规则，层值来自能力条目或 defaults" : "命中规则：" + winnerStep.label,
        };
      };

      const diffPolicies = (before, after) => {
        const left = isObject(before) ? before : {};
        const right = isObject(after) ? after : {};
        const flips = [];
        const added = [];
        const removed = [];
        const leftCaps = isObject(left.capabilities) ? left.capabilities : {};
        const rightCaps = isObject(right.capabilities) ? right.capabilities : {};
        const ids = Object.keys(leftCaps).concat(Object.keys(rightCaps).filter((id) => !hasOwn(leftCaps, id))).sort();
        for (let index = 0; index < ids.length; index += 1) {
          const id = ids[index];
          const leftEntry = isObject(leftCaps[id]) ? leftCaps[id] : null;
          const rightEntry = isObject(rightCaps[id]) ? rightCaps[id] : null;
          if (!leftEntry && rightEntry) { added.push({ path: id, label: id }); continue; }
          if (leftEntry && !rightEntry) { removed.push({ path: id, label: id }); continue; }
          if (leftEntry.tier !== rightEntry.tier) flips.push({ path: id, label: id, from: leftEntry.tier, to: rightEntry.tier });
          const fields = ["toolExceptions", "sectionExceptions"];
          for (let cursor = 0; cursor < fields.length; cursor += 1) {
            const field = fields[cursor];
            const leftMap = isObject(leftEntry[field]) ? leftEntry[field] : {};
            const rightMap = isObject(rightEntry[field]) ? rightEntry[field] : {};
            const names = Object.keys(leftMap).concat(Object.keys(rightMap).filter((name) => !hasOwn(leftMap, name))).sort();
            for (let offset = 0; offset < names.length; offset += 1) {
              const name = names[offset];
              if (leftMap[name] === rightMap[name]) continue;
              const path = id + " · " + field + " " + name;
              if (!hasOwn(rightMap, name)) removed.push({ path: path, label: path });
              else if (!hasOwn(leftMap, name)) added.push({ path: path, label: path });
              else flips.push({ path: path, label: path, from: leftMap[name], to: rightMap[name] });
            }
          }
        }
        const leftImports = listOf(isObject(left.skills) ? left.skills.imports : []).map((item) => String(item && item.path || ""));
        const rightImports = listOf(isObject(right.skills) ? right.skills.imports : []).map((item) => String(item && item.path || ""));
        for (let index = 0; index < rightImports.length; index += 1) if (rightImports[index] !== "" && leftImports.indexOf(rightImports[index]) < 0) added.push({ path: "skills.imports " + rightImports[index], label: rightImports[index] });
        for (let index = 0; index < leftImports.length; index += 1) if (leftImports[index] !== "" && rightImports.indexOf(leftImports[index]) < 0) removed.push({ path: "skills.imports " + leftImports[index], label: leftImports[index] });
        const leftDefaults = isObject(left.defaults) ? left.defaults : {};
        const rightDefaults = isObject(right.defaults) ? right.defaults : {};
        const defaultKeys = Object.keys(leftDefaults).concat(Object.keys(rightDefaults).filter((key) => !hasOwn(leftDefaults, key))).sort();
        for (let index = 0; index < defaultKeys.length; index += 1) {
          const key = defaultKeys[index];
          if (leftDefaults[key] !== rightDefaults[key]) flips.push({ path: "defaults." + key, label: "defaults." + key, from: leftDefaults[key], to: rightDefaults[key] });
        }
        const counts = { flips: flips.length, added: added.length, removed: removed.length, total: flips.length + added.length + removed.length };
        return {
          flips: flips,
          added: added,
          removed: removed,
          counts: counts,
          text: "翻转 " + counts.flips + " 项、新增 " + counts.added + " 项、移除 " + counts.removed + " 项",
        };
      };

      const groupNextOpen = (stored, searching) => {
        const current = stored === undefined ? searching === true : stored === true;
        return !current;
      };

      const resolveDefaultTemplate = (input) => {
        const source = input || {};
        const serverTemplate = isObject(source.serverTemplate) ? source.serverTemplate : null;
        const fallback = isObject(source.fallback) ? source.fallback : null;
        return {
          template: serverTemplate || fallback,
          source: serverTemplate ? "server" : "fallback",
          stale: serverTemplate === null,
        };
      };

      const build = (input) => {
        const source = input || {};
        const statePayload = isObject(source.state) ? source.state : {};
        const viewPayload = isObject(source.view) ? source.view : {};
        const policyPayload = isObject(source.policy) ? source.policy : {};
        const content = isObject(policyPayload.content) ? policyPayload.content : (isObject(policyPayload.template) ? policyPayload.template : {});
        const draft = isObject(source.draft) ? source.draft : {};
        const draftCaps = isObject(draft.caps) ? draft.caps : {};
        const draftSkills = isObject(draft.skills) ? draft.skills : {};
        const draftExceptions = isObject(draft.exceptions) ? draft.exceptions : {};
        const query = String(source.query || "").trim().toLowerCase();
        const sourceFilter = String(source.sourceFilter || "all");
        const statusFilter = String(source.statusFilter || "all");
        const chainFilter = String(source.chainFilter || "all");

        const cacheKey = [
          String(source.dataKey === undefined ? "0" : source.dataKey),
          String(draft.revision === undefined ? 0 : draft.revision),
          String(source.agent || ""),
          query,
          sourceFilter,
          statusFilter,
          chainFilter,
        ].join("|");
        if (cache.key === cacheKey && cache.value) { cache.hits += 1; return cache.value; }
        cache.recomputes += 1;

        const complaints = [];
        const complain = (path, message) => complaints.push({ path: path, message: message });

        /* 顶层列表也要逐条校验：缺字段只降级相关卡片，不把整块面板拖进白屏。 */
        const normalizeTopList = (path, value, label) => {
          if (value === undefined || value === null) return [];
          if (!Array.isArray(value)) { complain(path, label + "不是数组，已按空处理"); return []; }
          const out = [];
          for (let index = 0; index < value.length; index += 1) {
            const item = value[index];
            if (isObject(item) || typeof item === "string") out.push(item);
            else complain(path + "[" + index + "]", label + "条目不是对象，已跳过（只降级这张卡片）");
          }
          return out;
        };
        const viewDeviations = normalizeTopList("view.deviations", viewPayload.deviations, "偏离记录");
        const viewUpstreamHidden = normalizeTopList("view.upstreamHidden", viewPayload.upstreamHidden, "上游隐藏记录");

        const viewDefaults = isObject(viewPayload.defaults) ? viewPayload.defaults : {};
        const contentDefaults = isObject(content.defaults) ? content.defaults : {};
        const parseDefault = (key, fallback) => {
          const raw = viewDefaults[key] !== undefined ? viewDefaults[key] : contentDefaults[key];
          const parsed = parseTierValue(raw);
          if (parsed.state === "invalid") { complain("defaults." + key, parsed.reason); return fallback; }
          return parsed.state === "set" ? parsed.value : fallback;
        };
        const defaultCapability = parseDefault("capability", DEFAULT_TIERS.capability);
        const defaultSection = parseDefault("section", DEFAULT_TIERS.section);
        const defaultSkillpack = parseDefault("skillpack", DEFAULT_TIERS.skillpack);

        const normalizationWarnings = [];
        const normalizeMembers = (list, path, rowId, kindKey) => {
          const out = [];
          if (list === undefined || list === null) return out;
          if (!Array.isArray(list)) { complain(path, "成员列表不是数组，已按空处理"); return out; }
          for (let index = 0; index < list.length; index += 1) {
            const item = list[index];
            if (typeof item === "string") {
              out.push({ name: item, kind: kindKey, missing: false, tier: null, reason: "defaults", confidence: "unknown", via: "unknown", takenOver: false, forcedTier: null, exception: null, invalid: false });
              continue;
            }
            if (!isObject(item) || typeof item.name !== "string" || item.name.length === 0) {
              complain(path + "[" + index + "]", "成员记录缺名字，已跳过该条（只降级这张卡片）");
              continue;
            }
            out.push({
              name: item.name,
              kind: kindKey,
              missing: false,
              tier: item.tier === undefined ? null : tierOf(item.tier, null),
              reason: typeof item.reason === "string" ? item.reason : "defaults",
              confidence: typeof item.confidence === "string" ? item.confidence : "unknown",
              via: typeof item.via === "string" ? item.via : "unknown",
              takenOver: item.takenOver === true,
              forcedTier: item.forcedTier === undefined ? null : tierOf(item.forcedTier, null),
              exception: isObject(item.exception) ? item.exception : null,
              invalid: false,
              rowId: rowId,
            });
          }
          return out;
        };

        const entryFor = (id) => (isObject(content.capabilities) && isObject(content.capabilities[id]) ? content.capabilities[id] : null);

        const makeRow = (raw, phantom) => {
          const id = String(raw.id);
          const kind = kindOf(id);
          const entry = entryFor(id);
          const savedParsed = parseTierValue(raw.tier !== undefined ? raw.tier : (entry ? entry.tier : undefined));
          if (savedParsed.state === "invalid") complain(id, savedParsed.reason);
          if (savedParsed.warning) normalizationWarnings.push({ path: id, message: savedParsed.warning });
          const draftValue = hasOwn(draftCaps, id) ? draftCaps[id] : undefined;
          const draftParsed = draftValue === undefined ? null : parseTierValue(draftValue);
          if (draftParsed && draftParsed.state === "invalid") complain(id + "（草稿）", draftParsed.reason);
          const tools = normalizeMembers(raw.tools, "capabilities[" + id + "].tools", id, "tool");
          const sections = normalizeMembers(raw.sections, "capabilities[" + id + "].sections", id, "section");
          const all = tools.concat(sections);
          const baseTier = savedParsed.state === "set" ? savedParsed.value : (kind === "skill" || kind === "skillpack" ? defaultSkillpack : (sections.length > 0 && tools.length === 0 ? defaultSection : defaultCapability));
          const effectiveTier = draftParsed && draftParsed.state === "set" ? draftParsed.value : baseTier;
          const rowExceptions = isObject(draftExceptions[id]) ? draftExceptions[id] : {};
          const exceptionCount = Object.keys(isObject(entry && entry.toolExceptions) ? entry.toolExceptions : {}).length + Object.keys(isObject(entry && entry.sectionExceptions) ? entry.sectionExceptions : {}).length + Object.keys(isObject(rowExceptions.tool) ? rowExceptions.tool : {}).length + Object.keys(isObject(rowExceptions.section) ? rowExceptions.section : {}).length;
          const deviations = [];
          const rawDeviations = raw.deviations;
          if (Array.isArray(rawDeviations)) {
            for (let index = 0; index < rawDeviations.length; index += 1) {
              const item = rawDeviations[index];
              if (isObject(item)) deviations.push(item);
              else complain("capabilities[" + id + "].deviations[" + index + "]", "偏离记录不是对象，已跳过（只降级这张卡片）");
            }
          } else if (rawDeviations !== undefined && rawDeviations !== null) {
            complain("capabilities[" + id + "].deviations", "偏离记录不是数组，已按空处理");
          }
          const row = {
            id: id,
            kind: kind,
            kindSource: "id-prefix",
            phantom: phantom === true,
            synthetic: raw.synthetic === true,
            configured: raw.configured === true || entry !== null,
            savedTier: savedParsed.state === "set" ? savedParsed.value : null,
            savedState: savedParsed.state,
            draftTier: draftParsed && draftParsed.state === "set" ? draftParsed.value : null,
            effectiveTier: effectiveTier,
            baseTier: baseTier,
            invalid: savedParsed.state === "invalid" || Boolean(draftParsed && draftParsed.state === "invalid"),
            blocking: savedParsed.blocking === true || Boolean(draftParsed && draftParsed.blocking === true),
            invalidReason: savedParsed.state === "invalid" ? savedParsed.reason : (draftParsed && draftParsed.state === "invalid" ? draftParsed.reason : ""),
            members: { tools: tools, sections: sections, all: all },
            exceptionCount: exceptionCount,
            deviations: deviations,
            upstreamHidden: listOf(raw.upstreamHidden).filter((name) => typeof name === "string"),
            warnings: listOf(raw.warnings).map(warningText),
            confidence: typeof raw.confidence === "string" ? raw.confidence : "unknown",
            provenance: isObject(raw.provenance) ? raw.provenance : null,
            managed: raw.managed === true,
            readonlyService: raw.managed === true || raw.origin === "host",
            origin: typeof raw.origin === "string" ? raw.origin : "",
            skills: listOf(raw.skills).filter((name) => typeof name === "string"),
            label: typeof raw.label === "string" ? raw.label : "",
            merged: raw.merged === true,
          };
          row.memberCount = all.length;
          const worstConfidence = all.reduce((worst, member) => Math.max(worst, CONF_RANK[member.confidence] === undefined ? 3 : CONF_RANK[member.confidence]), -1);
          row.confidenceDerived = worstConfidence < 0 ? null : (worstConfidence >= 3 ? "unknown" : worstConfidence >= 2 ? "low" : "high");
          row.loadedCount = all.filter((member) => member.reason === "loaded").length;
          row.lockedCount = all.filter((member) => member.reason === "own" || member.reason === "protected" || member.reason === "loaded").length;
          row.takenOverCount = all.filter((member) => member.takenOver === true).length;
          row.chain = chainFor(row);
          return row;
        };

        const rows = [];
        const rowsById = {};
        const rawCapabilities = viewPayload.capabilities;
        if (rawCapabilities !== undefined && rawCapabilities !== null && !Array.isArray(rawCapabilities)) {
          complain("view.capabilities", "能力列表不是数组，已按空列表处理（只降级能力卡片）");
        }
        const capabilities = Array.isArray(rawCapabilities) ? rawCapabilities : [];
        for (let index = 0; index < capabilities.length; index += 1) {
          const raw = capabilities[index];
          if (!isObject(raw)) { complain("view.capabilities[" + index + "]", "不是对象的记录被跳过（缺字段只降级该卡片）"); continue; }
          if (typeof raw.id !== "string" || raw.id.length === 0) { complain("view.capabilities[" + index + "]", "记录缺少字符串 id，已跳过（只降级该卡片）"); continue; }
          if (rowsById[raw.id]) { complain("view.capabilities[" + index + "]", "重复的能力 id 被跳过：" + raw.id); continue; }
          const row = makeRow(raw, false);
          rows.push(row);
          rowsById[row.id] = row;
        }
        if (isObject(content.capabilities)) {
          const ids = Object.keys(content.capabilities).sort();
          for (let index = 0; index < ids.length; index += 1) {
            const id = ids[index];
            if (rowsById[id]) continue;
            const entry = isObject(content.capabilities[id]) ? content.capabilities[id] : {};
            const row = makeRow({ id: id, tier: entry.tier, configured: true, tools: [], sections: [] }, true);
            rows.push(row);
            rowsById[row.id] = row;
          }
        }

        const stateSkills = listOf(statePayload.skills).filter((name) => typeof name === "string");
        const hasSkillpackRow = rows.some((row) => row.kind === "skillpack");
        if (!hasSkillpackRow && stateSkills.length > 0) {
          const synthetic = makeRow({
            id: "skillpack:*",
            tier: defaultSkillpack,
            configured: contentDefaults.skillpack !== undefined,
            tools: [],
            sections: [],
            synthetic: true,
            skills: stateSkills,
            label: "技能目录（聚合）",
          }, false);
          synthetic.synthetic = true;
          synthetic.kind = "skillpack";
          synthetic.merged = rows.some((row) => row.kind === "skill");
          rows.push(synthetic);
          rowsById[synthetic.id] = synthetic;
        } else if (hasSkillpackRow && stateSkills.length > 0) {
          for (let index = 0; index < rows.length; index += 1) {
            if (rows[index].kind !== "skillpack") continue;
            if (rows[index].skills.length === 0) rows[index].skills = stateSkills.slice();
            rows[index].merged = true;
          }
        }

        rows.sort((left, right) => {
          const leftOrder = KIND_ORDER[left.kind] === undefined ? 9 : KIND_ORDER[left.kind];
          const rightOrder = KIND_ORDER[right.kind] === undefined ? 9 : KIND_ORDER[right.kind];
          if (leftOrder !== rightOrder) return leftOrder - rightOrder;
          return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
        });

        const filtered = rows.filter((row) => {
          if (sourceFilter !== "all" && row.kind !== sourceFilter) return false;
          if (statusFilter === "exception") { if (row.exceptionCount === 0 && row.deviations.length === 0) return false; }
          else if (statusFilter === "pending") { if (row.draftTier === null) return false; }
          else if (statusFilter !== "all" && String(row.effectiveTier) !== statusFilter) return false;
          if (query.length === 0) return true;
          if (row.id.toLowerCase().indexOf(query) >= 0) return true;
          for (let index = 0; index < row.skills.length; index += 1) if (row.skills[index].toLowerCase().indexOf(query) >= 0) return true;
          for (let index = 0; index < row.members.all.length; index += 1) if (row.members.all[index].name.toLowerCase().indexOf(query) >= 0) return true;
          return false;
        });

        const groups = [];
        const buckets = {};
        for (let index = 0; index < filtered.length; index += 1) {
          const row = filtered[index];
          if (!buckets[row.kind]) { buckets[row.kind] = []; groups.push({ kind: row.kind, label: KIND_LABEL[row.kind] || row.kind, rows: buckets[row.kind] }); }
          buckets[row.kind].push(row);
        }
        groups.sort((left, right) => (KIND_ORDER[left.kind] === undefined ? 9 : KIND_ORDER[left.kind]) - (KIND_ORDER[right.kind] === undefined ? 9 : KIND_ORDER[right.kind]));

        const residueCount = rows.filter((row) => row.chain.hitRule === "defaults" && row.chain.reasonChain.length === 0).length;
        const invalidCount = rows.filter((row) => row.blocking).length;
        const warningList = [];
        const seenWarnings = {};
        const warningSources = [listOf(statePayload.warnings), listOf(viewPayload.warnings), listOf(policyPayload.warnings)];
        for (let index = 0; index < warningSources.length; index += 1) {
          const list = warningSources[index];
          for (let cursor = 0; cursor < list.length; cursor += 1) {
            const text = warningText(list[cursor]);
            if (seenWarnings[text]) continue;
            seenWarnings[text] = true;
            warningList.push(text);
          }
        }

        const stats = {
          rows: rows.length,
          filtered: filtered.length,
          groups: groups.length,
          resident: rows.filter((row) => row.effectiveTier === TIER_RESIDENT).length,
          ondemand: rows.filter((row) => row.effectiveTier === TIER_ONDEMAND).length,
          off: rows.filter((row) => row.effectiveTier === TIER_OFF).length,
          sections: listOf(statePayload.sections).length,
          skills: stateSkills.length,
          visibleTools: typeof statePayload.visible === "number" ? statePayload.visible : listOf(statePayload.residentNames).length + listOf(statePayload.onDemandNames).length + listOf(statePayload.offNames).length,
          warnings: warningList.length,
          invalid: invalidCount,
          complaints: complaints.length,
          deviations: viewDeviations.length,
          upstreamHidden: viewUpstreamHidden.length,
          residue: residueCount,
          dirty: isObject(draft.summary) ? draft.summary.total : 0,
        };

        const health = {
          session: isObject(source.session) ? source.session : { agent: statePayload.agent || null, source: "auto" },
          file: typeof policyPayload.file === "string" ? policyPayload.file : "",
          readAt: source.readAt === undefined ? (policyPayload.mtime === undefined ? null : policyPayload.mtime) : source.readAt,
          sources: listOf(source.sources),
          stale: source.stale === true,
          staleReason: typeof source.staleReason === "string" ? source.staleReason : "",
        };

        const result = {
          rows: rows,
          rowsById: rowsById,
          filtered: filtered,
          groups: groups,
          stats: stats,
          health: health,
          complaints: complaints,
          warnings: warningList,
          normalizationWarnings: normalizationWarnings,
          defaults: { capability: defaultCapability, section: defaultSection, skillpack: defaultSkillpack },
          labels: { kinds: KIND_LABEL, reasons: REASON_LABEL, via: VIA_LABEL, confidence: CONF_LABEL, tiers: TIER_LABEL_LOCAL },
          chainOf: chainFor,
          kindOf: kindOf,
          dataKey: cacheKey,
        };
        cache.key = cacheKey;
        cache.value = result;
        return result;
      };

      return Object.freeze({
        KIND_ORDER: KIND_ORDER,
        KIND_LABEL: KIND_LABEL,
        CHAIN_ORDER: CHAIN_ORDER,
        kindOf: kindOf,
        parseTierValue: parseTierValue,
        tierOf: tierOf,
        chainFor: chainFor,
        diffPolicies: diffPolicies,
        groupNextOpen: groupNextOpen,
        resolveDefaultTemplate: resolveDefaultTemplate,
        build: build,
        metrics: () => ({ recomputes: cache.recomputes, hits: cache.hits }),
        resetCache: () => { cache.key = ""; cache.value = null; },
      });
    }

    /* =====================================================================
     * L4 · 提交编排（单飞、串行队列、代际令牌、引用计数、部分失败回执、revision 冲突）
     * 状态：单调递增 epoch + 每源状态与数据 + pending 引用计数。
     * 规则：并发读结果落地前判本轮序号；全部落定才递减；写成功后推进 epoch 再重读。
     * ===================================================================== */
    function createL4Orchestrator(deps) {
      const env = deps || {};
      const transport = env.transport;
      const draft = env.draft;
      const projection = env.projection;
      const schedule = typeof env.setTimeout === "function" ? env.setTimeout : (typeof setTimeout === "function" ? setTimeout : null);
      const unschedule = typeof env.clearTimeout === "function" ? env.clearTimeout : (typeof clearTimeout === "function" ? clearTimeout : null);
      const HARD_CEILING_MS = typeof env.hardCeilingMs === "number" ? env.hardCeilingMs : (transport && transport.HARD_CEILING_MS ? transport.HARD_CEILING_MS : 16000);
      const SOURCES = Object.freeze([
        { key: "state", path: "/api/dsh-gate/state" },
        { key: "view", path: "/api/dsh-gate/capabilities" },
        { key: "policy", path: "/api/dsh-gate/policy" },
        { key: "skills", path: "/api/dsh-gate/skills" },
        { key: "mcp", path: "/api/dsh-gate/mcp" },
      ]);
      const WRITE_ACTIONS = Object.freeze(["reload", "save-policy", "save-skills", "save-signature", "mcp"]);
      const AUTO_INTERVALS = Object.freeze([15, 30, 60]);
      const CONFLICT_CHOICES = Object.freeze([
        { value: "load-latest", label: "载入最新并丢弃我的", consequence: "服务端 revision 更新；本地未提交草稿全部丢弃" },
        { value: "overwrite", label: "覆盖服务端", consequence: "用本地 revision 强写；别人刚写的改动被覆盖" },
        { value: "diff", label: "先看差异", consequence: "不写入；先对比服务端与本地面板再决定" },
      ]);

      const statuses = { state: "loading", view: "loading", policy: "loading", skills: "loading", mcp: "loading" };
      const data = { state: null, view: null, policy: null, skills: null, mcp: null };
      const errors = {};
      const warnings = [];
      const superseded = {};
      const queueKeys = {};
      const listeners = [];

      let epoch = 0;
      let round = 0;
      let pending = 0;
      let writing = 0;
      let dataKey = 0;
      let lastError = "";
      let lastRevision = null;
      let lastReceipt = null;
      let session = { agent: env.agent === undefined ? null : env.agent, source: env.agent ? "host" : "auto" };
      let inflight = null;
      let inflightPending = false;
      let queue = Promise.resolve();
      let disposed = false;

      const sessionQuery = (options) => {
        const opts = options || {};
        const agent = opts.agent !== undefined ? opts.agent : session.agent;
        return agent === undefined || agent === null || agent === "" ? undefined : { agent: agent };
      };

      const snapshot = () => ({
        epoch: epoch,
        round: round,
        pending: pending,
        writing: writing,
        loading: pending > 0,
        writingActive: writing > 0,
        data: { state: data.state, view: data.view, policy: data.policy, skills: data.skills, mcp: data.mcp },
        status: { state: statuses.state, view: statuses.view, policy: statuses.policy, skills: statuses.skills, mcp: statuses.mcp },
        errors: {
          state: errors.state || "",
          view: errors.view || "",
          policy: errors.policy || "",
          skills: errors.skills || "",
          mcp: errors.mcp || "",
        },
        warnings: warnings.slice(),
        lastError: lastError,
        dataKey: dataKey,
        revision: lastRevision,
        session: { agent: session.agent, source: session.source },
        receipt: lastReceipt,
      });

      const notify = () => {
        const value = snapshot();
        const current = listeners.slice();
        for (let index = 0; index < current.length; index += 1) {
          try { current[index](value); } catch (error) { void error; }
        }
      };

      const subscribe = (fn) => {
        if (typeof fn !== "function") return () => undefined;
        listeners.push(fn);
        return () => {
          const index = listeners.indexOf(fn);
          if (index >= 0) listeners.splice(index, 1);
        };
      };

      const release = (marker) => {
        if (marker.released) return;
        marker.released = true;
        if (pending > 0) pending -= 1;
      };

      const withCeiling = (promise, ms, roundId, marker) => new Promise((resolve) => {
        let done = false;
        let timer = null;
        const finish = (value, timedOut) => {
          if (done) return;
          done = true;
          if (timer !== null && unschedule) unschedule(timer);
          if (timedOut) {
            superseded[roundId] = true;
            release(marker);
            round = round + 1;
            if (data.state === null) lastError = "载入超时（" + Math.round(ms / 1000) + " 秒）";
            notify();
            resolve({ applied: false, stale: false, timedOut: true, round: roundId, epoch: epoch, failed: [{ key: "load", error: "请求未在 " + ms + "ms 内返回" }], warnings: [] });
            return;
          }
          resolve(value);
        };
        if (schedule) timer = schedule(() => finish(null, true), Math.max(1, ms));
        promise.then((value) => finish(value, false), (error) => finish({ applied: false, stale: false, timedOut: false, round: roundId, epoch: epoch, failed: [{ key: "load", error: errorText(error) }], warnings: [] }, false));
      });

      const applyResults = (results, startedEpoch, roundId) => {
        const failed = [];
        const collected = [];
        for (let index = 0; index < results.length; index += 1) {
          const item = results[index];
          const result = item.result || {};
          if (result.ok) {
            data[item.key] = isObject(result.body) ? result.body : {};
            statuses[item.key] = "ready";
            delete errors[item.key];
          } else if (item.key === "mcp" && (result.kind === "missing" || result.capabilityMissing === true)) {
            data.mcp = null;
            statuses.mcp = "missing";
            delete errors.mcp;
          } else {
            failed.push({ key: item.key, kind: result.kind || "network", status: result.status || 0, error: result.error || "读取失败" });
            errors[item.key] = result.error || "读取失败";
            statuses[item.key] = data[item.key] ? "partial" : "error";
          }
          if (Array.isArray(result.warnings)) for (let cursor = 0; cursor < result.warnings.length; cursor += 1) collected.push(warningText(result.warnings[cursor]));
        }
        warnings.length = 0;
        for (let index = 0; index < collected.length; index += 1) if (warnings.indexOf(collected[index]) < 0) warnings.push(collected[index]);
        lastError = failed.length > 0 && data.state === null ? failed[0].error : "";
        if (isObject(data.policy)) {
          const content = isObject(data.policy.content) ? data.policy.content : (isObject(data.policy.template) ? data.policy.template : {});
          if (draft && typeof draft.setBaseline === "function") draft.setBaseline(content, { revision: data.policy.revision, file: data.policy.file });
        }
        if (isObject(data.policy) && data.policy.revision !== undefined) lastRevision = data.policy.revision;
        dataKey += 1;
        notify();
        return { applied: true, stale: false, timedOut: false, round: roundId, epoch: startedEpoch, failed: failed, warnings: warnings.slice(), dataKey: dataKey };
      };

      const loadRound = (options) => {
        const opts = options || {};
        const startedEpoch = epoch;
        const roundId = round + 1;
        round = roundId;
        pending += 1;
        const marker = { released: false };
        const scope = transport && typeof transport.createSignal === "function" ? transport.createSignal() : null;
        for (let index = 0; index < SOURCES.length; index += 1) statuses[SOURCES[index].key] = "loading";
        notify();
        const jobs = SOURCES.map((source) => {
          let call;
          try {
            call = transport.read(source.path, { query: sessionQuery(opts), signal: scope === null ? undefined : scope, agent: session.agent });
          } catch (error) {
            call = Promise.resolve({ ok: false, kind: "network", status: 0, body: null, error: errorText(error), warnings: [] });
          }
          return Promise.resolve(call).then(
            (result) => ({ key: source.key, result: result }),
            (error) => ({ key: source.key, result: { ok: false, kind: "network", status: 0, body: null, error: errorText(error), warnings: [] } }),
          );
        });
        const settle = Promise.all(jobs).then((results) => {
          const stale = roundId !== round || epoch !== startedEpoch || superseded[roundId] === true;
          release(marker);
          if (stale) {
            notify();
            return { applied: false, stale: true, timedOut: false, round: roundId, epoch: startedEpoch, failed: [], warnings: warnings.slice() };
          }
          return applyResults(results, startedEpoch, roundId);
        });
        return {
          round: roundId,
          epoch: startedEpoch,
          promise: withCeiling(settle, typeof opts.timeoutMs === "number" ? opts.timeoutMs : HARD_CEILING_MS, roundId, marker),
          abort: () => { if (scope) scope.abort(); },
        };
      };

      const refresh = (options) => {
        const opts = options || {};
        if (inflight) {
          inflightPending = true;
          return inflight.promise;
        }
        const job = loadRound(opts);
        const entry = { promise: job.promise, round: job.round };
        inflight = entry;
        inflightPending = false;
        const done = () => {
          if (inflight === entry) inflight = null;
          const again = inflightPending;
          inflightPending = false;
          if (again && !disposed) refresh(opts);
        };
        job.promise.then(done, done);
        return job.promise;
      };

      const receiptOf = (spec, result) => {
        const body = result && isObject(result.body) ? result.body : {};
        const base = {
          action: typeof spec.action === "string" ? spec.action : "",
          state: "failed",
          ok: Boolean(result && result.ok),
          status: result && typeof result.status === "number" ? result.status : 0,
          code: result && typeof result.code === "string" ? result.code : "",
          changed: body.changed !== false,
          revision: body.revision === undefined ? lastRevision : body.revision,
          warnings: Array.isArray(body.warnings) ? body.warnings : [],
          applied: Array.isArray(body.applied) ? body.applied : [],
          failed: Array.isArray(body.failed) ? body.failed : [],
          notExecuted: Array.isArray(body.notExecuted) ? body.notExecuted : [],
          message: "",
          choices: [],
          degraded: false,
        };
        if (!result || !result.ok) {
          if (result && result.status === 409 && (result.code === "REVISION_CONFLICT" || body.code === "REVISION_CONFLICT")) {
            return Object.assign(base, { state: "conflict", choices: CONFLICT_CHOICES.slice(), message: "服务端 revision 已变化：" + (result.error || "冲突") });
          }
          return Object.assign(base, { state: "failed", message: result ? (result.error || "提交失败") : "提交失败", failed: [{ index: 0, reason: result ? (result.error || "提交失败") : "提交失败" }] });
        }
        if (base.failed.length > 0) return Object.assign(base, { state: "partial", message: "部分失败：" + base.failed.length + " 项，未执行项仍留在草稿里" });
        if (base.changed === false) return Object.assign(base, { state: "no-change", message: "服务端判定没有变化，未写入" });
        return Object.assign(base, { state: "applied", message: "已应用" });
      };

      const write = (spec) => {
        const input = spec || {};
        const method = String(input.method || "POST").toUpperCase();
        const bodyText = input.body === undefined || input.body === null ? undefined : (typeof input.body === "string" ? input.body : JSON.stringify(input.body));
        const dedupeKey = String(input.queueKey || (input.path + "|" + (input.action || "") + "|" + (bodyText || "")));
        if (queueKeys[dedupeKey]) return queueKeys[dedupeKey];
        const run = () => {
          writing += 1;
          pending += 1;
          const startedEpoch = epoch;
          notify();
          let call;
          try {
            call = transport.write(input.path, bodyText === undefined ? undefined : bodyText, {
              query: sessionQuery(input),
              method: method,
              agent: session.agent,
              idempotencyKey: input.idempotencyKey || ((input.action || "write") + ":" + startedEpoch + ":" + fnv1a(bodyText || "")),
            });
          } catch (error) {
            call = Promise.resolve({ ok: false, kind: "network", status: 0, body: null, error: errorText(error), warnings: [] });
          }
          return Promise.resolve(call).then((result) => {
            writing = Math.max(0, writing - 1);
            if (pending > 0) pending -= 1;
            const receipt = receiptOf(input, result);
            if (result && result.ok && receipt.state !== "conflict" && receipt.state !== "failed") {
              epoch += 1;
              if (receipt.revision !== undefined && receipt.revision !== null) lastRevision = receipt.revision;
            }
            lastReceipt = receipt;
            delete queueKeys[dedupeKey];
            notify();
            return receipt;
          }, (error) => {
            writing = Math.max(0, writing - 1);
            if (pending > 0) pending -= 1;
            delete queueKeys[dedupeKey];
            const receipt = { action: input.action || "", state: "failed", ok: false, status: 0, code: "", changed: false, revision: lastRevision, warnings: [], applied: [], failed: [{ index: 0, reason: errorText(error) }], notExecuted: [], message: errorText(error), choices: [], degraded: false };
            lastReceipt = receipt;
            notify();
            return receipt;
          });
        };
        const promise = queue.then(run, run);
        queue = promise.then(() => undefined, () => undefined);
        queueKeys[dedupeKey] = promise;
        return promise;
      };

      const isBatchUnsupported = (receipt) => receipt.state === "failed" && (receipt.status === 404 || receipt.status === 405 || receipt.code === "UNSUPPORTED_ACTION" || receipt.code === "UNKNOWN_ACTION" || receipt.code === "INVALID_BODY");

      /** 技能保存：优先单次批量动作；服务端不支持时按顺序降级，失败即停并给部分失败回执。 */
      const saveSkills = async (operations) => {
        const ops = Array.isArray(operations) ? operations.slice() : [];
        if (ops.length === 0) return { action: "skills", state: "no-change", ok: true, status: 200, code: "", changed: false, revision: lastRevision, warnings: [], applied: [], failed: [], notExecuted: [], message: "没有待保存改动", choices: [], degraded: false };
        const batch = await write({ path: "/api/dsh-gate/skills", action: "skills-batch", body: { action: "batch", operations: ops, revision: lastRevision }, queueKey: "skills-batch" });
        if (!isBatchUnsupported(batch)) {
          if (batch.state === "applied" || batch.state === "no-change" || batch.state === "partial") await refresh({ reason: "reconcile" });
          return batch;
        }
        const applied = [];
        const failed = [];
        let stopAt = -1;
        for (let index = 0; index < ops.length; index += 1) {
          const single = await write({ path: "/api/dsh-gate/skills", action: "skills-single", body: Object.assign({}, ops[index], { revision: lastRevision }), queueKey: "skills-single:" + index });
          if (single.state === "applied" || single.state === "no-change") applied.push({ index: index, operation: ops[index] });
          else { failed.push({ index: index, reason: single.message, operation: ops[index] }); stopAt = index; break; }
        }
        const notExecuted = ops.slice(stopAt < 0 ? applied.length : stopAt + 1).map((operation, offset) => ({ index: (stopAt < 0 ? applied.length : stopAt + 1) + offset, operation: operation }));
        await refresh({ reason: "reconcile" });
        return {
          action: "skills",
          state: failed.length > 0 ? "partial" : "applied",
          ok: false,
          status: 400,
          code: "BATCH_DEGRADED",
          changed: applied.length > 0,
          revision: lastRevision,
          warnings: [],
          applied: applied,
          failed: failed,
          notExecuted: notExecuted,
          message: "服务端不支持批量动作，已按顺序降级：" + applied.length + " 项已应用、" + failed.length + " 项失败、" + notExecuted.length + " 项未执行",
          choices: [],
          degraded: true,
        };
      };

      const preflight = (action, summary) => {
        const current = summary || (draft && typeof draft.dirtySummary === "function" ? draft.dirtySummary() : { total: 0, text: "", jsonDirty: false });
        const total = current.total === undefined ? 0 : current.total;
        const needsConfirm = total > 0;
        return {
          action: action,
          known: WRITE_ACTIONS.indexOf(action) >= 0,
          needsConfirm: needsConfirm,
          dirtyTotal: total,
          summaryText: current.text || "",
          consequence: needsConfirm ? "确认后会丢弃：" + current.text : "",
          confirmLabel: "确认丢弃并继续",
          cancelLabel: "取消",
        };
      };

      const detectExternalChange = (input) => {
        const value = input || {};
        const incoming = value.revision;
        if (incoming === undefined || incoming === null || lastRevision === null || incoming === lastRevision) return { changed: false, automatic: false, choices: [], message: "" };
        const dirtyTotal = draft && typeof draft.dirtySummary === "function" ? draft.dirtySummary().total : 0;
        if (dirtyTotal === 0) return { changed: true, automatic: true, choices: [], message: "服务端策略已被外部修改（revision " + lastRevision + " → " + incoming + "），无本地草稿，已自动载入最新" };
        return {
          changed: true,
          automatic: false,
          choices: [
            { value: "load", label: "载入最新", consequence: "丢弃本地 " + dirtyTotal + " 项草稿" },
            { value: "keep", label: "保留草稿", consequence: "服务端改动暂不生效，继续用本地草稿" },
          ],
          message: "服务端策略已被外部修改（revision " + lastRevision + " → " + incoming + "），本地有 " + dirtyTotal + " 项未保存草稿",
        };
      };

      const autoRefreshDecision = (input) => {
        const value = input || {};
        const enabled = value.enabled !== false;
        const interval = AUTO_INTERVALS.indexOf(Number(value.intervalMs === undefined ? 30 : value.intervalMs)) >= 0 ? Number(value.intervalMs === undefined ? 30 : value.intervalMs) : 30;
        const dirtyTotal = value.dirtyCount === undefined ? (draft && typeof draft.dirtySummary === "function" ? draft.dirtySummary().total : 0) : value.dirtyCount;
        if (!enabled) return { run: false, interval: interval, reason: "已关闭自动刷新" };
        if (dirtyTotal > 0) return { run: false, interval: interval, reason: "有未保存草稿，自动刷新暂停" };
        if (value.writing === true || writing > 0) return { run: false, interval: interval, reason: "写在途，自动刷新暂停" };
        if (value.visible === false) return { run: false, interval: interval, reason: "文档不可见，自动刷新暂停" };
        return { run: true, interval: interval, reason: "每 " + interval + " 秒刷新" };
      };

      const listSessions = async () => {
        const result = await transport.diagnose("/api/dsh-gate/diagnostics", { query: sessionQuery({}) });
        if (!result || !result.ok) return { ok: false, sessions: [], error: result ? result.error : "读取失败" };
        const body = isObject(result.body) ? result.body : {};
        const runtime = isObject(body.runtime) ? body.runtime : {};
        const rows = Array.isArray(body.sessions) ? body.sessions : (Array.isArray(runtime.sessions) ? runtime.sessions : []);
        return {
          ok: true,
          error: "",
          sessions: rows.map((item, index) => {
            const row = isObject(item) ? item : {};
            const id = String(row.agent !== undefined ? row.agent : (row.id !== undefined ? row.id : "session-" + index));
            return { id: id, label: String(row.label !== undefined ? row.label : id), source: "panel" };
          }),
        };
      };

      const resolveSessionSource = (input) => {
        const value = input || {};
        if (typeof value.hostAgent === "string" && value.hostAgent.length > 0) return { agent: value.hostAgent, source: "host" };
        if (typeof value.selectedAgent === "string" && value.selectedAgent.length > 0) return { agent: value.selectedAgent, source: "panel" };
        return { agent: value.autoAgent === undefined ? null : value.autoAgent, source: "auto" };
      };

      const selectSession = (agent) => {
        const next = typeof agent === "string" && agent.length > 0 ? agent : null;
        if (next === session.agent) return false;
        session = { agent: next, source: next === null ? "auto" : "panel" };
        epoch += 1;
        notify();
        return true;
      };

      const savePolicy = (body) => write({ path: "/api/dsh-gate/policy", action: "policy", body: body, queueKey: "policy:" + (body && body.revision) });
      const saveSignature = (body) => write({ path: "/api/dsh-gate/policy", action: "signature", body: body, queueKey: "signature" });
      const saveGuard = (body) => write({ path: "/api/dsh-gate/policy", action: "guardrail", body: body, queueKey: "guardrail" });
      const saveCatalog = (body) => write({ path: "/api/dsh-gate/policy", action: "catalog", body: body, queueKey: "catalog" });

      const dispose = () => {
        disposed = true;
        listeners.length = 0;
        inflight = null;
        inflightPending = false;
      };

      return Object.freeze({
        SOURCES: SOURCES,
        WRITE_ACTIONS: WRITE_ACTIONS,
        AUTO_INTERVALS: AUTO_INTERVALS,
        CONFLICT_CHOICES: CONFLICT_CHOICES,
        HARD_CEILING_MS: HARD_CEILING_MS,
        loadRound: loadRound,
        refresh: refresh,
        write: write,
        saveSkills: saveSkills,
        savePolicy: savePolicy,
        saveSignature: saveSignature,
        saveGuard: saveGuard,
        saveCatalog: saveCatalog,
        receiptOf: receiptOf,
        preflight: preflight,
        detectExternalChange: detectExternalChange,
        autoRefreshDecision: autoRefreshDecision,
        listSessions: listSessions,
        selectSession: selectSession,
        resolveSessionSource: resolveSessionSource,
        getSnapshot: snapshot,
        subscribe: subscribe,
        dispose: dispose,
        epoch: () => epoch,
        pending: () => pending,
        writing: () => writing,
        revision: () => lastRevision,
        session: () => ({ agent: session.agent, source: session.source }),
      });
    }

    /* =====================================================================
     * L5 · 渲染原语（只收属性、不读全局状态、不自拼业务文案）
     * 确认条对话框语义、开关 aria、分组表、五态容器、提示宿主、层值条、差异预览、健康条。
     * ===================================================================== */
    function createL5Primitives(deps) {
      const env = deps || {};
      const h = env.h;
      const text = typeof env.text === "function" ? env.text : (key) => key;
      const TOAST_LIFETIME = Object.freeze({ ok: 4000, info: 6000, warn: 8000, error: 0 });
      const MAX_TOASTS = 5;
      const FIVE_STATES = Object.freeze(["loading", "ready", "empty", "error", "partial"]);
      const TONE_ROLE = Object.freeze({ ok: "status", info: "status", warn: "status", error: "alert" });

      const lifetimeOf = (tone) => (TOAST_LIFETIME[tone] === undefined ? TOAST_LIFETIME.info : TOAST_LIFETIME[tone]);

      const createToastQueue = (initial) => {
        let items = Array.isArray(initial) ? initial.slice() : [];
        const api = {
          items: () => items.slice(),
          push: (toast) => {
            const entry = toast || {};
            const key = String(entry.key === undefined ? (entry.text || "toast") : entry.key);
            const tone = TOAST_LIFETIME[entry.tone] === undefined ? "info" : entry.tone;
            const index = items.findIndex((item) => item.key === key);
            if (index >= 0) {
              const merged = Object.assign({}, items[index], { text: String(entry.text === undefined ? items[index].text : entry.text), tone: tone, count: (items[index].count || 1) + 1, lifetime: lifetimeOf(tone) });
              items = items.slice();
              items[index] = merged;
              return merged;
            }
            const next = { key: key, tone: tone, text: String(entry.text === undefined ? "" : entry.text), count: 1, lifetime: lifetimeOf(tone) };
            items = items.concat([next]);
            while (items.length > MAX_TOASTS) items.shift();
            return next;
          },
          dismiss: (key) => { items = items.filter((item) => item.key !== key); return items.slice(); },
          clear: () => { items = []; return items; },
          size: () => items.length,
        };
        return api;
      };

      const skeleton = (props) => {
        const value = props || {};
        const rows = typeof value.rows === "number" ? value.rows : 3;
        const lines = [];
        for (let index = 0; index < rows; index += 1) lines.push(h("div", { key: "skeleton:" + index, className: "dshg-skeleton", "aria-hidden": "true" }));
        return h("div", { key: value.key || "skeleton", className: "dshg-col", "aria-busy": "true" }, [
          h("div", { key: "label", className: "dshg-hint" }, text("common.loading")),
        ].concat(lines));
      };

      const stateContainer = (props) => {
        const value = props || {};
        const state = FIVE_STATES.indexOf(value.state) >= 0 ? value.state : "ready";
        const key = value.key || "state";
        if (state === "loading") return skeleton({ key: key, rows: value.rows });
        if (state === "ready") return h("div", { key: key, className: "dshg-col" }, value.children === undefined ? null : value.children);
        if (state === "empty") return h("div", { key: key, className: "dshg-empty" }, value.message || text("common.empty"));
        if (state === "partial") {
          return h("div", { key: key, className: "dshg-col" }, [
            h("div", { key: "banner", className: "dshg-alert", "data-tone": "warn", role: "status" }, value.message || text("common.partial")),
            h("div", { key: "body", className: "dshg-col" }, value.children === undefined ? null : value.children),
          ]);
        }
        return h("div", { key: key, className: "dshg-col" }, [
          h("div", { key: "alert", className: "dshg-alert", "data-tone": "error", role: "alert" }, value.message || text("common.error")),
          typeof value.onRetry === "function" ? h("button", { key: "retry", type: "button", className: "dshg-btn", onClick: value.onRetry }, text("retry")) : null,
        ]);
      };

      const confirmBar = (props) => {
        const value = props || {};
        const id = value.id || "dshg-confirm";
        return h("div", {
          key: value.key || id,
          id: id,
          className: "dshg-confirm",
          role: "alertdialog",
          "aria-modal": "true",
          "aria-labelledby": id + "-title",
          "aria-describedby": id + "-text",
          tabIndex: -1,
          onKeyDown: value.onKeyDown,
        }, [
          h("div", { key: "text", className: "dshg-grow" }, [
            h("div", { key: "title", id: id + "-title", className: "dshg-note" }, value.title || text("confirm.title")),
            h("div", { key: "body", id: id + "-text", className: "dshg-hint" }, value.text || ""),
            value.detail ? h("div", { key: "detail", className: "dshg-hint" }, value.detail) : null,
          ]),
          h("button", { key: "cancel", type: "button", className: "dshg-btn", autoFocus: true, "data-autofocus": "cancel", onClick: value.onCancel }, value.cancelLabel || text("confirm.cancel")),
          h("button", { key: "ok", type: "button", className: "dshg-btn", "data-primary": "true", "data-danger": value.destructive === true ? "true" : undefined, onClick: value.onConfirm }, value.confirmLabel || text("confirm.ok")),
        ]);
      };

      const switchButton = (props) => {
        const value = props || {};
        return h("button", {
          key: value.key || "switch",
          type: "button",
          role: "switch",
          className: "dshg-switch",
          "aria-checked": value.on === true,
          "aria-disabled": value.disabled === true ? "true" : undefined,
          "aria-label": value.ariaLabel || value.label,
          disabled: value.disabled === true,
          title: value.disabled === true ? (value.reason || "") : (value.title || ""),
          onClick: value.disabled === true ? undefined : value.onToggle,
        }, [h("i", { key: "dot", "aria-hidden": "true" }), String(value.label || "")]);
      };

      const segmented = (props) => {
        const value = props || {};
        const options = Array.isArray(value.options) ? value.options : [];
        return h("div", { key: value.key || "seg", className: "dshg-seg", role: "group", "aria-label": value.ariaLabel || "" }, options.map((option) => h("button", {
          key: String(option.value),
          type: "button",
          "data-value": String(option.value),
          "aria-pressed": option.value === value.value,
          disabled: value.disabled === true,
          title: value.disabled === true ? (value.reason || "") : (option.title || ""),
          onClick: value.disabled === true ? undefined : () => value.onSelect(option.value),
        }, option.label)));
      };

      const groupHead = (props) => {
        const value = props || {};
        const id = value.id || "group";
        return h("button", {
          key: value.key || "head:" + id,
          id: id + "-head",
          type: "button",
          className: "dshg-groupHead",
          "aria-expanded": value.open === true,
          "aria-controls": id + "-body",
          "aria-label": value.label + "，" + String(value.count) + " 条，" + (value.open === true ? "已展开" : "已收起"),
          onClick: value.onToggle,
        }, [
          h("span", { key: "caret", className: "dshg-groupCaret", "aria-hidden": "true" }, value.open === true ? "▾" : "▸"),
          h("span", { key: "name", className: "dshg-groupName" }, String(value.label || "")),
          h("span", { key: "count", className: "dshg-groupCount" }, String(value.count) + " 条"),
          value.chips ? h("span", { key: "chips", className: "dshg-row" }, value.chips) : null,
        ]);
      };

      const groupBody = (props) => {
        const value = props || {};
        if (value.open !== true) return null;
        return h("div", { key: value.key || "body:" + value.id, id: (value.id || "group") + "-body", className: "dshg-groupBody", role: "region", "aria-labelledby": (value.id || "group") + "-head" }, value.children);
      };

      const tierBar = (props) => {
        const value = props || {};
        const parts = [];
        if (value.saved !== undefined && value.saved !== null) parts.push("服务端 " + String(value.saved));
        if (value.draft !== undefined && value.draft !== null) parts.push("草稿 " + String(value.draft));
        if (value.effective !== undefined && value.effective !== null) parts.push("生效 " + String(value.effective));
        return h("span", { key: value.key || "tierbar", className: "dshg-hint" }, parts.join(" · "));
      };

      const diffPreview = (props) => {
        const value = props || {};
        const diff = value.diff || { flips: [], added: [], removed: [], counts: { total: 0 }, text: "" };
        const rows = [];
        for (let index = 0; index < diff.flips.length && index < 12; index += 1) {
          const item = diff.flips[index];
          rows.push(h("div", { key: "flip:" + index, className: "dshg-diffRow" }, [
            h("span", { key: "p", className: "dshg-mono" }, item.label),
            h("span", { key: "v" }, String(item.from) + " → " + String(item.to)),
          ]));
        }
        for (let index = 0; index < diff.added.length && index < 8; index += 1) rows.push(h("div", { key: "add:" + index, className: "dshg-diffRow" }, "新增 " + diff.added[index].label));
        for (let index = 0; index < diff.removed.length && index < 8; index += 1) rows.push(h("div", { key: "del:" + index, className: "dshg-diffRow" }, "移除 " + diff.removed[index].label));
        return h("div", { key: value.key || "diff", className: "dshg-diff" }, [
          h("div", { key: "head", className: "dshg-note" }, (value.title || text("json.diff")) + "：" + diff.text),
          rows.length === 0 ? h("div", { key: "none", className: "dshg-hint" }, text("common.none")) : h("div", { key: "rows", className: "dshg-col" }, rows),
        ]);
      };

      const toastHost = (props) => {
        const value = props || {};
        const items = Array.isArray(value.items) ? value.items : [];
        return h("div", { key: value.key || "toasts", className: "dshg-toasts", "aria-live": "polite" }, items.map((item) => h("div", {
          key: "toast:" + item.key,
          className: "dshg-toast",
          role: TONE_ROLE[item.tone] || "status",
          "data-tone": item.tone,
          "aria-atomic": "true",
        }, [
          h("span", { key: "text", className: "dshg-grow" }, item.text + (item.count > 1 ? "（" + item.count + "）" : "")),
          item.tone === "error" || item.lifetime === 0
            ? h("button", { key: "close", type: "button", className: "dshg-btn", "aria-label": "关闭提示", onClick: () => value.onDismiss(item.key) }, "×")
            : null,
        ])));
      };

      const healthBar = (props) => {
        const value = props || {};
        const health = value.health || {};
        const sources = Array.isArray(health.sources) ? health.sources : [];
        const labels = sources.map((source, index) => h("span", { key: "src:" + String(source.key || index), className: "dshg-tag", "data-tone": source.status === "error" ? "error" : (source.status === "partial" ? "warn" : "ok") }, String(source.label || source.key || index) + "：" + String(source.status || "unknown")));
        return h("div", { key: value.key || "health", className: "dshg-row" }, [
          h("span", { key: "session", className: "dshg-tag", "data-tone": "business" }, text("health.session") + "：" + String(value.sessionLabel || text("settings.sessionAuto"))),
          h("span", { key: "file", className: "dshg-hint" }, text("health.file") + "：" + (health.file || text("common.none"))),
          h("span", { key: "readAt", className: "dshg-hint" }, text("health.readAt") + "：" + String(value.readAtText || text("common.none"))),
          h("span", { key: "sources", className: "dshg-row" }, labels),
          health.stale === true ? h("span", { key: "stale", className: "dshg-tag", "data-tone": "warn" }, text("common.stale") + "：" + String(health.staleReason || "")) : null,
        ]);
      };

      const errorCard = (props) => {
        const value = props || {};
        const lines = Array.isArray(value.stack) ? value.stack : [];
        return h("div", { key: value.key || "errorCard", className: "dshg-card" }, [
          h("div", { key: "head", className: "dshg-cardHead" }, [
            h("span", { key: "title" }, value.title || text("error.title")),
            h("span", { key: "hint", className: "dshg-hint" }, text("error.summary") + "：" + String(value.message || "")),
          ]),
          h("div", { key: "body", className: "dshg-cardBody" }, [
            h("div", { key: "summary", className: "dshg-alert", "data-tone": "error", role: "alert" }, String(value.summary || value.message || text("error.title"))),
            lines.length > 0 ? h("div", { key: "stack", className: "dshg-col" }, [
              h("div", { key: "label", className: "dshg-hint" }, text("error.stack")),
              h("pre", { key: "pre", className: "dshg-mono" }, lines.join(newline)),
            ]) : null,
            h("div", { key: "actions", className: "dshg-row" }, [
              typeof value.onRetry === "function" ? h("button", { key: "retry", type: "button", className: "dshg-btn", onClick: value.onRetry }, text("retry")) : null,
              typeof value.onCopy === "function" ? h("button", { key: "copy", type: "button", className: "dshg-btn", onClick: value.onCopy }, text("error.copy")) : null,
            ]),
            value.diagnostics ? h("div", { key: "diag", className: "dshg-col" }, [
              h("div", { key: "label", className: "dshg-hint" }, text("error.diagnostics")),
              h("pre", { key: "pre", className: "dshg-mono" }, String(value.diagnostics)),
            ]) : null,
          ]),
        ]);
      };

      const tabsBar = (props) => {
        const value = props || {};
        const tabs = Array.isArray(value.tabs) ? value.tabs : [];
        return h("div", { key: value.key || "tabs", className: "dshg-tabs", role: "tablist", "aria-label": text("tabs.label"), onKeyDown: value.onKeyDown }, tabs.map((tab) => h("button", {
          key: "tab:" + tab.value,
          id: "dshg-tab-" + tab.value,
          type: "button",
          role: "tab",
          "aria-selected": value.active === tab.value,
          "aria-controls": "dshg-panel-" + tab.value,
          tabIndex: value.active === tab.value ? 0 : -1,
          className: "dshg-tab",
          onClick: () => value.onSelect(tab.value),
        }, [
          String(tab.label),
          tab.count === undefined || tab.count === null || tab.count === "" ? null : h("span", { key: "count", className: "dshg-tabCount" }, String(tab.count)),
        ])));
      };

      return Object.freeze({
        TOAST_LIFETIME: TOAST_LIFETIME,
        MAX_TOASTS: MAX_TOASTS,
        FIVE_STATES: FIVE_STATES,
        lifetimeOf: lifetimeOf,
        createToastQueue: createToastQueue,
        skeleton: skeleton,
        stateContainer: stateContainer,
        confirmBar: confirmBar,
        switchButton: switchButton,
        segmented: segmented,
        groupHead: groupHead,
        groupBody: groupBody,
        tierBar: tierBar,
        diffPreview: diffPreview,
        toastHost: toastHost,
        healthBar: healthBar,
        errorCard: errorCard,
        tabsBar: tabsBar,
      });
    }

    /* =====================================================================
     * L6 · 页签视图（只做展示与事件上抛；页签局部状态由外壳持有并保留）
     * 五视图：能力 / 技能 / MCP / JSON / 设置（K129-K134 全量入口）
     * ===================================================================== */
    function createL6Views(deps) {
      const env = deps || {};
      const h = env.h;
      const text = typeof env.text === "function" ? env.text : (key) => key;
      const primitives = env.primitives;

      const card = (key, title, children, headExtra) => h("div", { key: key, className: "dshg-card" }, [
        h("div", { key: "head", className: "dshg-cardHead" }, [h("span", { key: "title" }, String(title))].concat(Array.isArray(headExtra) ? headExtra : [])),
        h("div", { key: "body", className: "dshg-cardBody" }, children),
      ]);
      const hint = (key, content) => h("div", { key: key, className: "dshg-hint" }, content);
      const note = (key, content) => h("div", { key: key, className: "dshg-note" }, content);
      const alert = (key, content, tone) => h("div", { key: key, className: "dshg-alert", "data-tone": tone || "warn", role: tone === "error" ? "alert" : "status" }, content);
      const button = (key, label, onClick, options) => {
        const opts = options || {};
        return h("button", {
          key: key,
          type: "button",
          className: "dshg-btn",
          "data-primary": opts.primary === true ? "true" : undefined,
          "data-danger": opts.danger === true ? "true" : undefined,
          disabled: opts.disabled === true,
          title: opts.reason || (opts.disabled === true ? "" : opts.title || ""),
          onClick: opts.disabled === true ? undefined : onClick,
        }, String(label));
      };
      const tierOptions = () => [
        { value: 1, label: text("tier.resident") },
        { value: 2, label: text("tier.ondemand") },
        { value: 0, label: text("tier.off") },
      ];
      const tierLabel = (tier) => (TIER_LABEL[tier] === undefined ? text("tier.unset") : TIER_LABEL[tier]);

      const renderRow = (props, row) => {
        const expanded = props.view.expanded[row.id] === true;
        const disabled = row.blocking === true || row.readonlyService === true;
        const markerNodes = [];
        if (row.synthetic) markerNodes.push(h("span", { key: "m:synthetic", className: "dshg-tag", "data-tone": "business" }, "技能目录（聚合）"));
        if (row.managed) markerNodes.push(h("span", { key: "m:managed", className: "dshg-tag", "data-tone": "business" }, text("caps.managed")));
        if (row.draftTier !== null) markerNodes.push(h("span", { key: "m:pending", className: "dshg-tag", "data-tone": "warn" }, text("caps.pending")));
        if (row.exceptionCount > 0) markerNodes.push(h("span", { key: "m:exc", className: "dshg-tag", "data-tone": "warn" }, text("caps.exception") + " " + row.exceptionCount));
        if (row.deviations.length > 0) markerNodes.push(h("span", { key: "m:dev", className: "dshg-tag", "data-tone": "error" }, "偏离 " + row.deviations.length));
        if (row.blocking) markerNodes.push(h("span", { key: "m:invalid", className: "dshg-tag", "data-tone": "error" }, text("caps.invalid")));
        if (row.invalid && !row.blocking) markerNodes.push(h("span", { key: "m:invalidmark", className: "dshg-tag", "data-tone": "warn" }, text("tier.invalid")));
        if (row.merged) markerNodes.push(h("span", { key: "m:merged", className: "dshg-tag" }, "已合并真实行"));
        const detail = expanded ? h("div", { key: "detail", className: "dshg-detail" }, [
          h("div", { key: "chain", className: "dshg-chain" }, row.chain.steps.map((step) => h("span", { key: "step:" + step.key, className: "dshg-step", "data-hit": step.hit, "data-winner": step.winner }, step.label + (step.count > 0 ? " " + step.count : "") + (step.winner ? " · " + text("chain.winner") : "")))),
          hint("chainText", row.chain.text),
          hint("final", text("chain.final") + "：" + tierLabel(row.effectiveTier) + " · " + text("chain.hit") + "：" + (row.chain.winnerLabel || text("common.none"))),
          row.members.all.length === 0
            ? hint("noMembers", row.synthetic ? "技能目录由 defaults.skillpack 统一控制" : "策略里有这个能力，但当前表面没有成员")
            : h("div", { key: "members", className: "dshg-col" }, row.members.all.map((member) => h("div", { key: "mem:" + member.kind + ":" + member.name, className: "dshg-member" }, [
                h("span", { key: "name", className: "dshg-memberName", title: member.name }, member.name),
                h("span", { key: "tier", className: "dshg-tag" }, tierLabel(member.tier)),
                h("span", { key: "reason", className: "dshg-hint" }, member.reason),
                h("span", { key: "conf", className: "dshg-hint" }, "置信 " + member.confidence),
                h("select", {
                  key: "exc",
                  className: "dshg-select",
                  "aria-label": text("caps.exception") + " " + member.name,
                  disabled: member.takenOver === true || member.reason === "own" || member.reason === "protected" || member.reason === "loaded",
                  title: member.takenOver === true ? text("caps.locked") : "",
                  value: member.exception && member.exception.tier !== undefined && member.exception.tier !== null ? String(member.exception.tier) : "",
                  onChange: (event) => props.actions.stageException(row.id, member.kind, member.name, event.target.value === "" ? null : Number(event.target.value)),
                }, [
                  h("option", { key: "follow", value: "" }, text("caps.followCap")),
                  h("option", { key: "1", value: "1" }, text("tier.resident")),
                  h("option", { key: "2", value: "2" }, text("tier.ondemand")),
                  h("option", { key: "0", value: "0" }, text("tier.off")),
                ]),
              ]))),
          row.blocking ? alert("invalid", row.invalidReason + "（" + text("caps.blocked") + "）", "error") : null,
        ]) : null;
        return h("div", { key: "row:" + row.id, className: "dshg-cap" }, [
          h("div", { key: "main", className: "dshg-capMain" }, [
            h("span", { key: "badge", className: "dshg-badge", "data-kind": row.kind }, row.kind),
            h("div", { key: "grow", className: "dshg-grow" }, [
              h("div", { key: "id", className: "dshg-capId", title: row.id }, row.id),
              h("div", { key: "meta", className: "dshg-capMeta" }, markerNodes.concat([
                h("span", { key: "cfg", className: "dshg-hint" }, row.configured ? "策略已配置" : "走 defaults"),
                h("span", { key: "mc", className: "dshg-hint" }, row.memberCount + " 成员"),
                h("span", { key: "tb", className: "dshg-hint" }, primitives.tierBar({ saved: row.savedTier, draft: row.draftTier, effective: row.effectiveTier })),
              ])),
            ]),
            primitives.segmented({
              key: "seg:" + row.id,
              ariaLabel: "切换 " + row.id + " 的层",
              value: row.effectiveTier,
              options: tierOptions(),
              disabled: disabled,
              reason: row.readonlyService ? text("caps.managed") : text("caps.blocked"),
              onSelect: (tier) => props.actions.stageCap(row, tier),
            }),
            button("why:" + row.id, expanded ? text("caps.hide") : text("caps.why"), () => props.actions.toggleRow(row.id), { title: text("chain.title") }),
          ]),
          detail,
        ]);
      };

      const renderCaps = (props) => {
        const model = props.model;
        if (!model) return primitives.stateContainer({ key: "caps:loading", state: "loading", rows: 4 });
        const view = props.view;
        const searching = String(view.query || "").trim().length > 0;
        const groups = model.groups.map((group) => {
          const id = "caps:" + group.kind;
          const open = view.openGroups[id] === undefined ? searching : view.openGroups[id] === true;
          const batchRow = h("div", { key: "batch", className: "dshg-row" }, [
            h("span", { key: "label", className: "dshg-hint" }, text("caps.groupBatch") + "（" + group.rows.length + " 条）"),
            button("b1", text("tier.resident"), () => props.actions.requestGroupBatch(group.kind, TIER_RESIDENT)),
            button("b2", text("tier.ondemand"), () => props.actions.requestGroupBatch(group.kind, TIER_ONDEMAND)),
            button("b0", text("tier.off"), () => props.actions.requestGroupBatch(group.kind, TIER_OFF)),
            hint("impact", text("caps.groupImpact") + "：" + group.rows.length + " 条"),
          ]);
          return h("div", { key: id, className: "dshg-group" }, [
            primitives.groupHead({ key: "head:" + id, id: id, label: group.label, count: group.rows.length, open: open, onToggle: () => props.actions.toggleGroup(id, searching) }),
            batchRow,
            primitives.groupBody({ key: "body:" + id, id: id, open: open, children: group.rows.map((row) => renderRow(props, row)) }),
          ]);
        });
        const filters = h("div", { key: "filters", className: "dshg-row" }, [
          h("input", {
            key: "query",
            className: "dshg-input",
            type: "search",
            "aria-label": text("caps.search"),
            placeholder: text("caps.search"),
            value: view.query,
            onChange: (event) => props.actions.setView({ query: event.target.value }),
          }),
          h("select", { key: "source", className: "dshg-select", "aria-label": text("caps.sourceAll"), value: view.sourceFilter, onChange: (event) => props.actions.setView({ sourceFilter: event.target.value }) },
            [{ value: "all", label: text("caps.sourceAll") }].concat(Object.keys(model.labels.kinds).map((kind) => ({ value: kind, label: model.labels.kinds[kind] }))).map((option) => h("option", { key: option.value, value: option.value }, option.label))),
          h("select", { key: "status", className: "dshg-select", "aria-label": text("caps.statusAll"), value: view.statusFilter, onChange: (event) => props.actions.setView({ statusFilter: event.target.value }) }, [
            h("option", { key: "all", value: "all" }, text("caps.statusAll")),
            h("option", { key: "1", value: "1" }, text("tier.resident")),
            h("option", { key: "2", value: "2" }, text("tier.ondemand")),
            h("option", { key: "0", value: "0" }, text("tier.off")),
            h("option", { key: "exc", value: "exception" }, text("caps.statusException")),
            h("option", { key: "pending", value: "pending" }, text("caps.statusPending")),
          ]),
          button("clear", text("caps.clear"), () => props.actions.setView({ query: "", sourceFilter: "all", statusFilter: "all" }), { disabled: String(view.query).length === 0 && view.sourceFilter === "all" && view.statusFilter === "all" }),
        ]);
        const complaints = model.complaints.length === 0 ? null : card("caps:complaints", text("caps.complaints") + "（" + model.complaints.length + "）", [
          alert("hint", text("caps.complaintsHint")),
          h("ul", { key: "list", className: "dshg-col" }, model.complaints.slice(0, 10).map((item, index) => h("li", { key: "c:" + index, className: "dshg-hint" }, item.path + "：" + item.message))),
        ]);
        const body = model.filtered.length === 0
          ? primitives.stateContainer({ key: "caps:empty", state: "empty", message: text("caps.empty") })
          : h("div", { key: "list", className: "dshg-list" }, groups);
        const pendingCard = card("caps:pending", "待保存变更（" + props.summary.total + "）", [
          note("summary", props.summary.text),
          props.summary.total > 0 ? button("discard", text("discard"), () => props.actions.discard(), { danger: true }) : hint("clean", text("noChanges")),
          hint("undo", text("undoHint")),
        ]);
        return h("div", { key: "caps", className: "dshg-col" }, [
          complaints,
          card("caps:main", text("caps.title") + "（" + model.filtered.length + " / " + model.stats.rows + "）", [filters, body]),
          pendingCard,
        ].filter(Boolean));
      };

      const renderSkills = (props) => {
        const snapshot = props.snapshot;
        const status = snapshot.status.skills;
        const payload = snapshot.data.skills;
        if (status === "loading" && !payload) return primitives.stateContainer({ key: "skills:loading", state: "loading", rows: 4 });
        if (status === "error" && !payload) return primitives.stateContainer({ key: "skills:error", state: "error", message: text("common.error") + "：" + snapshot.errors.skills, onRetry: () => props.actions.reload() });
        const skills = listOf(payload && payload.skills).filter((row) => isObject(row) && typeof row.name === "string");
        const draft = props.draft;
        const summary = props.summary;
        const view = props.view;
        const query = String(view.skillQuery || "").trim().toLowerCase();
        const filtered = skills.filter((row) => {
          if (query.length === 0) return true;
          const haystack = [row.name, row.provider, row.path, row.description].filter((value) => typeof value === "string").join(" ").toLowerCase();
          return haystack.indexOf(query) >= 0;
        });
        const baseTakeover = !(payload && payload.takeover === false);
        const takeover = draft.takeover === undefined ? baseTakeover : draft.takeover === true;
        const relayBase = isObject(payload && payload.activationRelay) ? payload.activationRelay.enabled === true : Boolean(payload && payload.activationRelay === true);
        const relay = draft.catalog.activationRelay === undefined ? relayBase : draft.catalog.activationRelay === true;
        const promoteBase = isObject(payload && payload.activationPromote) ? payload.activationPromote.enabled === true : Boolean(payload && payload.activationPromote === true);
        const promote = draft.catalog.activationPromote === undefined ? promoteBase : draft.catalog.activationPromote === true;
        const providers = [];
        const buckets = {};
        for (let index = 0; index < filtered.length; index += 1) {
          const row = filtered[index];
          const name = String(row.provider || "未标注 provider");
          if (!buckets[name]) { buckets[name] = []; providers.push(name); }
          buckets[name].push(row);
        }
        providers.sort((left, right) => buckets[right].length - buckets[left].length || (left < right ? -1 : 1));
        const groupNodes = providers.map((name) => {
          const id = "skills:" + name;
          const searching = query.length > 0;
          const open = view.openGroups[id] === undefined ? searching : view.openGroups[id] === true;
          return h("div", { key: id, className: "dshg-group" }, [
            primitives.groupHead({ key: "head:" + id, id: id, label: name, count: buckets[name].length, open: open, onToggle: () => props.actions.toggleGroup(id, searching) }),
            primitives.groupBody({ key: "body:" + id, id: id, open: open, children: buckets[name].map((row) => {
              const tier = hasOwn(draft.skills, row.name) ? draft.skills[row.name] : (row.tier === undefined ? 2 : row.tier);
              return h("div", { key: "skill:" + row.name, className: "dshg-member" }, [
                h("span", { key: "name", className: "dshg-memberName", title: row.name }, row.name),
                h("span", { key: "origin", className: "dshg-tag" }, row.origin === "import" ? "导入" : "宿主"),
                h("span", { key: "provider", className: "dshg-hint" }, row.provider || text("common.none")),
                primitives.segmented({ key: "seg:" + row.name, ariaLabel: "切换 " + row.name + " 的层", value: tier, options: tierOptions(), onSelect: (next) => props.actions.stageSkill(row.name, next) }),
                row.shadowed ? h("span", { key: "shadowed", className: "dshg-tag", "data-tone": "warn" }, "shadowed · 不可用") : null,
              ]);
            }) }),
          ]);
        });
        const offList = listOf(payload && payload.off).filter((name) => typeof name === "string");
        const imports = draft.imports === null ? listOf(payload && payload.imports) : draft.imports;
        const warnings = listOf(payload && payload.warnings).map(warningText).concat(snapshot.warnings);
        const prescan = isObject(payload && payload.prescan) ? payload.prescan : null;
        return h("div", { key: "skills", className: "dshg-col" }, [
          card("skills:head", text("skills.title") + "（" + filtered.length + " / " + skills.length + "）", [
            h("div", { key: "switches", className: "dshg-row" }, [
              primitives.switchButton({ key: "takeover", on: takeover, label: text("skills.takeover"), onToggle: () => props.actions.stageTakeover(!takeover), title: text("skills.relayHint") }),
              primitives.switchButton({ key: "relay", on: relay, label: text("skills.relay"), disabled: !takeover, reason: text("skills.relayHint"), onToggle: () => props.actions.stageCatalog("activationRelay", !relay) }),
              primitives.switchButton({ key: "promote", on: promote, label: text("skills.promote"), disabled: !relay, reason: text("skills.promoteHint"), onToggle: () => props.actions.stageCatalog("activationPromote", !promote) }),
            ]),
            hint("relayHint", text("skills.relayHint")),
            hint("promoteHint", text("skills.promoteHint")),
            h("div", { key: "actions", className: "dshg-row" }, [
              note("state", summary.total > 0 ? text("skills.dirty") : text("skills.synced")),
              button("discard", text("discard"), () => props.actions.discard(), { disabled: summary.total === 0 }),
              button("save", text("skills.save") + (summary.total > 0 ? " (" + summary.total + ")" : ""), () => props.actions.saveSkills(), { primary: true, disabled: summary.total === 0 || props.saving }),
            ]),
            prescan && prescan.active === true ? alert("prescan", text("skills.prescan") + "：" + (prescan.complete === false ? "只拿到部分名单" : "已取到") + (prescan.reason ? "；原因：" + String(prescan.reason) : "") + "（" + text("skills.prescanRetry") + "）") : null,
          ]),
          warnings.length > 0 ? card("skills:warnings", text("skills.warnings") + "（" + warnings.length + "）", h("div", { key: "list", className: "dshg-col" }, warnings.slice(0, 8).map((item, index) => alert("w:" + index, item)))) : null,
          card("skills:filters", text("caps.search"), [
            h("div", { key: "row", className: "dshg-row" }, [
              h("input", { key: "q", className: "dshg-input", type: "search", "aria-label": text("skills.search"), placeholder: text("skills.search"), value: view.skillQuery, onChange: (event) => props.actions.setView({ skillQuery: event.target.value }) }),
              button("clear", text("caps.clear"), () => props.actions.setView({ skillQuery: "" }), { disabled: String(view.skillQuery).length === 0 }),
            ]),
            filtered.length === 0 ? primitives.stateContainer({ key: "empty", state: "empty", message: text("skills.empty") }) : h("div", { key: "groups", className: "dshg-list" }, groupNodes),
          ]),
          card("skills:imports", text("skills.imports"), [
            h("div", { key: "add", className: "dshg-row" }, [
              h("input", { key: "path", className: "dshg-input", "aria-label": text("skills.imports"), placeholder: "技能目录路径…", value: view.importDraft, onChange: (event) => props.actions.setView({ importDraft: event.target.value }) }),
              button("addBtn", text("skills.importAdd"), () => props.actions.addImport(view.importDraft)),
            ]),
            hint("preview", text("skills.importPreview") + "：" + (String(view.importDraft || "").trim().length === 0 ? text("common.none") : String(view.importDraft).trim())),
            imports.length === 0 ? hint("none", text("common.empty")) : h("div", { key: "list", className: "dshg-col" }, imports.map((item, index) => h("div", { key: "imp:" + String(item && item.path || index), className: "dshg-member" }, [
              h("span", { key: "p", className: "dshg-memberName" }, String(item && item.path || "")),
              button("remove:" + index, text("skills.importRemove"), () => props.actions.removeImport(String(item && item.path || ""))),
            ]))),
          ]),
          card("skills:off", text("skills.off") + (offList.length > 0 ? "（" + offList.length + "）" : ""), [
            hint("hint", "旧关闭清单每项可移除（可撤销）；清空需要确认"),
            offList.length === 0 ? hint("none", text("common.empty")) : h("div", { key: "list", className: "dshg-col" }, offList.map((name) => h("div", { key: "off:" + name, className: "dshg-member" }, [
              h("span", { key: "n", className: "dshg-memberName" }, name),
              button("rm:" + name, text("skills.offRemove"), () => props.actions.removeOff(name)),
            ]))),
            button("clear", text("skills.offClear"), () => props.actions.clearOff(), { danger: true, disabled: offList.length === 0 }),
          ]),
          summary.total > 0 ? card("skills:diff", text("json.diff"), primitives.diffPreview({ diff: props.diff, title: text("json.diff") })) : null,
        ].filter(Boolean));
      };

      const renderMcp = (props) => {
        const snapshot = props.snapshot;
        const status = snapshot.status.mcp;
        const payload = snapshot.data.mcp;
        if (status === "loading" && !payload) return primitives.stateContainer({ key: "mcp:loading", state: "loading", rows: 3 });
        if (status === "missing") return card("mcp:missing", text("mcp.title"), [alert("hint", "服务端还没有 GET /api/dsh-gate/mcp（能力不存在），这里显示「未接入」而不是报错", "warn"), button("retry", text("retry"), () => props.actions.reload())]);
        if (status === "error" && !payload) return primitives.stateContainer({ key: "mcp:error", state: "error", message: text("common.error") + "：" + snapshot.errors.mcp, onRetry: () => props.actions.reload() });
        const servers = listOf(payload && (payload.servers || payload.mcp)).filter(isObject);
        const writable = Boolean(payload && payload.writable === true);
        const warnings = listOf(payload && payload.warnings).map(warningText);
        const stateOrder = ["owned", "external", "stopped", "unavailable"];
        const buckets = {};
        const groupNames = [];
        for (let index = 0; index < servers.length; index += 1) {
          const name = String(servers[index].state || "unavailable");
          if (!buckets[name]) { buckets[name] = []; groupNames.push(name); }
          buckets[name].push(servers[index]);
        }
        groupNames.sort((left, right) => (stateOrder.indexOf(left) < 0 ? 9 : stateOrder.indexOf(left)) - (stateOrder.indexOf(right) < 0 ? 9 : stateOrder.indexOf(right)));
        const groups = groupNames.map((name) => {
          const id = "mcp:" + name;
          const open = props.view.openGroups[id] === undefined ? true : props.view.openGroups[id] === true;
          return h("div", { key: id, className: "dshg-group" }, [
            primitives.groupHead({ key: "head:" + id, id: id, label: name, count: buckets[name].length, open: open, onToggle: () => props.actions.toggleGroup(id, false) }),
            primitives.groupBody({ key: "body:" + id, id: id, open: open, children: buckets[name].map((row) => {
              const name2 = String(row.name || "");
              const owned = row.state === "owned" || row.state === "stopped";
              const target = typeof row.target === "string" ? row.target : (typeof row.command === "string" ? row.command : (typeof row.url === "string" ? row.url : text("common.none")));
              return h("div", { key: "srv:" + name2, className: "dshg-member" }, [
                h("span", { key: "n", className: "dshg-memberName" }, name2),
                h("span", { key: "t", className: "dshg-hint" }, String(row.transport || "stdio")),
                h("span", { key: "target", className: "dshg-hint dshg-mono" }, target),
                h("span", { key: "state", className: "dshg-tag" }, String(row.state || "unavailable")),
                h("span", { key: "tools", className: "dshg-hint" }, String(listOf(row.tools).length) + " 工具"),
                owned
                  ? h("span", { key: "actions", className: "dshg-row" }, [
                      button("toggle", row.state === "stopped" ? "启动" : "停止", () => props.actions.mcpAction(row.state === "stopped" ? "enable" : "disable", name2), { disabled: !writable, reason: text("mcp.notWritable") }),
                      button("remove", "删除", () => props.actions.mcpRemove(name2), { danger: true, disabled: !writable, reason: text("mcp.notWritable") }),
                    ])
                  : h("span", { key: "readonly", className: "dshg-hint" }, text("mcp.readonly")),
              ]);
            }) }),
          ]);
        });
        const argsPreview = props.argsPreview;
        const form = writable ? h("div", { key: "form", className: "dshg-col" }, [
          h("div", { key: "row", className: "dshg-row" }, [
            h("input", { key: "name", className: "dshg-input", "aria-label": text("mcp.name"), placeholder: text("mcp.name"), value: props.view.mcpDraft.name, onChange: (event) => props.actions.setMcpDraft({ name: event.target.value }) }),
            h("select", { key: "transport", className: "dshg-select", "aria-label": "transport", value: props.view.mcpDraft.transport, onChange: (event) => props.actions.setMcpDraft({ transport: event.target.value }) }, [
              h("option", { key: "stdio", value: "stdio" }, "stdio"),
              h("option", { key: "http", value: "http" }, "http"),
            ]),
          ]),
          props.view.mcpDraft.transport === "http"
            ? h("input", { key: "url", className: "dshg-input", "aria-label": text("mcp.url"), placeholder: text("mcp.url"), value: props.view.mcpDraft.url, onChange: (event) => props.actions.setMcpDraft({ url: event.target.value }) })
            : h("div", { key: "stdio", className: "dshg-col" }, [
                h("input", { key: "cmd", className: "dshg-input", "aria-label": text("mcp.command"), placeholder: text("mcp.command"), value: props.view.mcpDraft.command, onChange: (event) => props.actions.setMcpDraft({ command: event.target.value }) }),
                h("input", { key: "args", className: "dshg-input", "aria-label": text("mcp.args"), placeholder: text("mcp.args"), value: props.view.mcpDraft.args, onChange: (event) => props.actions.setMcpDraft({ args: event.target.value }) }),
                hint("preview", text("mcp.argsPreview") + "：" + (argsPreview.length === 0 ? text("common.none") : JSON.stringify(argsPreview))),
              ]),
          button("add", text("mcp.add"), () => props.actions.mcpAdd(), { primary: true }),
        ]) : hint("ro", text("mcp.notWritable"));
        return h("div", { key: "mcp", className: "dshg-col" }, [
          card("mcp:main", text("mcp.title") + "（" + servers.length + "）", [
            note("legend", "owned = gate 托管（可改）；external = 宿主配置（只读）"),
            form,
            servers.length === 0 ? primitives.stateContainer({ key: "empty", state: "empty", message: text("mcp.empty") }) : h("div", { key: "groups", className: "dshg-list" }, groups),
            warnings.length > 0 ? h("div", { key: "warnings", className: "dshg-col" }, warnings.map((item, index) => alert("w:" + index, item))) : null,
          ]),
        ]);
      };

      const renderJson = (props) => {
        const view = props.view;
        const notice = view.jsonNotice;
        const parsed = props.jsonParsed;
        const diff = props.jsonDiff;
        return h("div", { key: "json", className: "dshg-col" }, [
          card("json:main", text("json.title"), [
            note("hint", text("json.replaceHint")),
            h("textarea", {
              key: "editor",
              className: "dshg-json",
              spellCheck: false,
              "aria-label": text("json.title"),
              value: view.jsonText,
              onChange: (event) => props.actions.editJson(event.target.value),
            }),
            h("div", { key: "meta", className: "dshg-row" }, [
              hint("size", bytesOf(view.jsonText) + " " + text("json.bytes") + " · " + (view.jsonText.length === 0 ? 0 : view.jsonText.split(newline).length) + " " + text("json.lines")),
              button("validate", text("json.validate"), () => props.actions.validateJson()),
              button("format", text("json.format"), () => props.actions.formatJson()),
              button("restore", text("json.restore"), () => props.actions.requestJsonRestore(), { danger: true }),
              button("save", text("json.save"), () => props.actions.requestJsonSave(), { primary: true, disabled: props.summary.blocking === true }),
            ]),
            notice ? alert("notice", notice.text, notice.tone) : null,
            diff ? primitives.diffPreview({ diff: diff, title: text("json.diff") }) : null,
          ]),
          card("json:exchange", "导入导出", [
            h("div", { key: "actions", className: "dshg-row" }, [
              button("export", text("json.export"), () => props.actions.exportJson()),
              button("import", text("json.import"), () => props.actions.importJson()),
            ]),
            h("textarea", {
              key: "exchange",
              className: "dshg-json",
              spellCheck: false,
              "aria-label": "导入导出",
              value: view.exchangeText,
              onChange: (event) => props.actions.setView({ exchangeText: event.target.value }),
            }),
            hint("exchangeHint", "导入接受裸对象或信封（{policy:…}）；版本高于当前阻断、低于当前提示迁移"),
            parsed ? hint("parsed", "当前编辑器可解析：version=" + String(parsed.version) + "，能力 " + String(parsed.capabilities) + " 条") : hint("parsed", text("json.invalid")),
          ]),
        ]);
      };

      const renderSettings = (props) => {
        const guard = props.guard;
        const auto = props.autoRefresh;
        const decision = props.autoDecision;
        const sessionLabel = props.sessionLabel;
        const signature = props.draft.signature;
        const metrics = props.metrics;
        const numeric = (key, field, label, min, max) => h("label", { key: key, className: "dshg-row" }, [
          h("span", { key: "l", className: "dshg-hint" }, label),
          h("input", {
            key: "i",
            className: "dshg-input",
            inputMode: "numeric",
            "aria-label": label,
            value: String(guard[field] === undefined || guard[field] === null ? "" : guard[field]),
            onChange: (event) => props.actions.stageGuard(field, event.target.value === "" ? null : Number(event.target.value)),
          }),
          hint("range", min + "–" + max),
        ]);
        return h("div", { key: "settings", className: "dshg-col" }, [
          card("settings:health", text("settings.title"), [
            primitives.healthBar({ health: props.health, sessionLabel: sessionLabel, readAtText: props.readAtText }),
            h("div", { key: "session", className: "dshg-row" }, [
              hint("s", text("settings.session") + "：" + sessionLabel),
              button("list", text("settings.listSessions"), () => props.actions.listSessions()),
              h("select", {
                key: "select",
                className: "dshg-select",
                "aria-label": text("settings.session"),
                value: props.session.agent || "",
                onChange: (event) => props.actions.selectSession(event.target.value),
              }, [h("option", { key: "auto", value: "" }, text("settings.sessionAuto"))].concat(listOf(props.sessions).map((item) => h("option", { key: item.id, value: item.id }, item.label)))),
            ]),
            props.sessionNotice ? alert("sessionNotice", props.sessionNotice) : null,
          ]),
          card("settings:guard", text("settings.guard"), [
            h("div", { key: "row", className: "dshg-row" }, [
              primitives.switchButton({ key: "g", on: guard.enabled !== false, label: text("settings.guardEnabled"), onToggle: () => props.actions.stageGuard("enabled", guard.enabled === false) }),
              hint("fixed", text("settings.fixedItems")),
            ]),
            numeric("w", "windowSize", text("settings.window"), 2, 200),
            numeric("t", "threshold", text("settings.threshold"), 2, 50),
            numeric("r", "reminders", text("settings.reminders"), 1, 5),
            numeric("p", "previewChars", text("settings.preview"), 40, 4000),
            h("div", { key: "ex", className: "dshg-row" }, [
              hint("l", text("settings.exclusions")),
              h("input", { key: "i", className: "dshg-input", "aria-label": text("settings.exclusions"), value: listOf(guard.exclusions).join(", "), onChange: (event) => props.actions.stageGuard("exclusions", event.target.value.split(",").map((item) => item.trim()).filter((item) => item.length > 0)) }),
            ]),
            h("div", { key: "runtime", className: "dshg-col" }, [
              hint("l", text("settings.runtime")),
              metrics && metrics.counters ? h("div", { key: "kv", className: "dshg-row" }, Object.keys(metrics.counters).map((key) => h("span", { key: key, className: "dshg-tag" }, key + " " + String(metrics.counters[key])))) : hint("none", text("settings.noMetrics")),
            ]),
            button("saveGuard", text("save"), () => props.actions.saveGuard(), { primary: true, disabled: props.draft.guardrailDirty !== true }),
          ]),
          card("settings:catalog", text("settings.catalog"), [
            h("div", { key: "row", className: "dshg-row" }, [
              primitives.switchButton({ key: "g", on: props.catalog.groupByPlugin !== false, label: text("settings.groupByPlugin"), onToggle: () => props.actions.stageCatalog("groupByPlugin", props.catalog.groupByPlugin === false) }),
              primitives.switchButton({ key: "s", on: props.catalog.skillGroups === true, label: text("settings.skillGroups"), onToggle: () => props.actions.stageCatalog("skillGroups", props.catalog.skillGroups !== true) }),
            ]),
            alert("cost", text("settings.cacheCost"), "warn"),
            h("div", { key: "len", className: "dshg-row" }, [
              hint("l", text("settings.maxDesc")),
              h("input", { key: "i", className: "dshg-input", inputMode: "numeric", "aria-label": text("settings.maxDesc"), value: String(props.catalog.maxDescriptionLength === undefined ? "" : props.catalog.maxDescriptionLength), onChange: (event) => props.actions.stageCatalog("maxDescriptionLength", Number(event.target.value)) }),
            ]),
            button("saveCatalog", text("save"), () => props.actions.saveCatalog(), { primary: true, disabled: props.draft.catalogDirty !== true }),
          ]),
          card("settings:auto", text("settings.autoRefresh"), [
            h("div", { key: "row", className: "dshg-row" }, [
              h("select", { key: "i", className: "dshg-select", "aria-label": text("settings.autoRefresh"), value: String(auto.interval), onChange: (event) => props.actions.setView({ autoInterval: Number(event.target.value) }) }, [
                h("option", { key: "0", value: "0" }, text("settings.autoOff")),
                h("option", { key: "15", value: "15" }, text("settings.auto15")),
                h("option", { key: "30", value: "30" }, text("settings.auto30")),
                h("option", { key: "60", value: "60" }, text("settings.auto60")),
              ]),
              hint("d", decision.run ? decision.reason : text("settings.autoPaused") + "：" + decision.reason),
            ]),
          ]),
          card("settings:signature", text("settings.signature"), [
            h("div", { key: "row", className: "dshg-row" }, [
              primitives.switchButton({ key: "s", on: signature.enabled !== false, label: text("settings.signature"), onToggle: () => props.actions.stageSignature(signature.enabled === false, listOf(signature.tools).join(", ")) }),
              h("input", { key: "tools", className: "dshg-input", "aria-label": "签名工具名单", placeholder: "工具名，逗号分隔", value: String(props.view.signatureTools === undefined ? listOf(signature.tools).join(", ") : props.view.signatureTools), onChange: (event) => props.actions.stageSignature(signature.enabled !== false, event.target.value) }),
            ]),
            button("restore", text("settings.restoreKey"), () => props.actions.restoreSignature(), { disabled: props.draft.signatureDirty !== true }),
            button("save", text("save"), () => props.actions.saveSignature(), { primary: true, disabled: props.draft.signatureDirty !== true }),
          ]),
          card("settings:undo", "撤销重做", [
            h("div", { key: "row", className: "dshg-row" }, [
              button("undo", text("undo"), () => props.actions.undo(), { disabled: !props.canUndo }),
              button("redo", text("redo"), () => props.actions.redo(), { disabled: !props.canRedo }),
              hint("depth", "撤销栈 " + String(props.undoDepth) + " / " + String(props.maxUndo)),
            ]),
            hint("keys", text("undoHint")),
          ]),
        ]);
      };

      const renderTabPanel = (props) => {
        const panels = [
          { value: "caps", node: renderCaps(props) },
          { value: "skills", node: renderSkills(props) },
          { value: "mcp", node: renderMcp(props) },
          { value: "json", node: renderJson(props) },
          { value: "settings", node: renderSettings(props) },
        ];
        return h("div", { key: "panels", className: "dshg-col" }, panels.map((panel) => h("div", {
          key: "panel:" + panel.value,
          id: "dshg-panel-" + panel.value,
          role: "tabpanel",
          "aria-labelledby": "dshg-tab-" + panel.value,
          hidden: props.tab !== panel.value,
          className: "dshg-panel",
          tabIndex: 0,
        }, panel.node)));
      };

      return Object.freeze({
        renderCaps: renderCaps,
        renderSkills: renderSkills,
        renderMcp: renderMcp,
        renderJson: renderJson,
        renderSettings: renderSettings,
        renderTabPanel: renderTabPanel,
      });
    }

    /* =====================================================================
     * L7 · 外壳（错误边界、幂等样式注入、固定槽位、文案表、装配）
     * 组合根只做装配；入口只做注册（少于三十行）。
     * ===================================================================== */
    function createL7Shell(deps) {
      const env = deps || {};
      const h = env.h;
      const react = env.react;
      const text = env.text;
      const primitives = env.primitives;
      const views = env.views;
      const createTransport = env.createTransport;
      const createDraft = env.createDraft;
      const createProjection = env.createProjection;
      const createOrchestrator = env.createOrchestrator;
      const fallbackTemplate = env.fallbackTemplate;
      const PANEL_VERSION = "0.6.0";

      const TABS = Object.freeze([
        { value: "caps", label: text("tab.caps") },
        { value: "skills", label: text("tab.skills") },
        { value: "mcp", label: text("tab.mcp") },
        { value: "json", label: text("tab.json") },
        { value: "settings", label: text("tab.settings") },
      ]);

      const tabOf = (route) => {
        if (route === undefined || route === null || route === "") return "caps";
        const head = String(route).split("/")[0];
        for (let index = 0; index < TABS.length; index += 1) if (TABS[index].value === head) return head;
        return null;
      };

      /** 幂等注入：以 data 属性为唯一宿主节点（热重载不会叠加第二份）。 */
      const ensureStyle = (doc) => {
        const target = doc && typeof doc.createElement === "function" ? doc : (typeof document === "undefined" ? null : document);
        if (!target || typeof target.createElement !== "function") return false;
        if (typeof target.querySelector === "function") {
          const existing = target.querySelector("style[" + STYLE_ATTR + "]");
          if (existing) return false;
        }
        const tag = target.createElement("style");
        tag.setAttribute(STYLE_ATTR, "1");
        tag.textContent = styleText();
        if (target.head && typeof target.head.appendChild === "function") target.head.appendChild(tag);
        return true;
      };

      const initialView = (props) => ({
        tab: tabOf(props.route) === null ? "caps" : tabOf(props.route),
        routeMissing: tabOf(props.route) === null,
        query: "",
        sourceFilter: "all",
        statusFilter: "all",
        chainFilter: "all",
        openGroups: {},
        expanded: {},
        skillQuery: "",
        importDraft: "",
        mcpDraft: { name: "", transport: "stdio", command: "", args: "", url: "" },
        jsonText: "",
        jsonDirty: false,
        jsonNotice: null,
        exchangeText: "",
        autoInterval: 30,
        signatureTools: undefined,
      });

      const parseArgs = (input) => {
        const source = String(input === undefined || input === null ? "" : input);
        const out = [];
        let current = "";
        let quote = "";
        for (let index = 0; index < source.length; index += 1) {
          const char = source[index];
          if (quote !== "") {
            if (char === quote) { quote = ""; continue; }
            current = current + char;
            continue;
          }
          if (char === "\"" || char === "'") { quote = char; continue; }
          if (char === " " || char === "\t") { if (current.length > 0) { out.push(current); current = ""; } continue; }
          current = current + char;
        }
        if (quote !== "") out.push("__UNCLOSED__:" + current);
        if (current.length > 0 && quote === "") out.push(current);
        return out;
      };

      const relativeText = (timestamp, nowMs, labels) => {
        if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return text("common.none");
        const age = Math.max(0, nowMs - timestamp);
        if (age < 60000) return text("common.justNow");
        const minutes = Math.floor(age / 60000);
        if (minutes < 60) return minutes + " " + text("common.minutesAgo");
        return Math.floor(minutes / 60) + " 小时前";
      };

      const parseText = (source) => {
        try {
          const value = JSON.parse(source);
          if (!isObject(value)) return { ok: false, message: "顶层必须是 JSON 对象", value: null, version: null, capabilities: 0 };
          const version = Number(value.version);
          return { ok: true, message: "", value: value, version: Number.isFinite(version) ? version : null, capabilities: isObject(value.capabilities) ? Object.keys(value.capabilities).length : 0 };
        } catch (error) {
          return { ok: false, message: errorText(error), value: null, version: null, capabilities: 0 };
        }
      };

      const createRuntime = (props) => {
        const transport = createTransport({
          fetch: typeof fetch === "function" ? fetch : null,
          setTimeout: typeof setTimeout === "function" ? setTimeout : null,
          clearTimeout: typeof clearTimeout === "function" ? clearTimeout : null,
        });
        const draft = createDraft({});
        const projection = createProjection({});
        const orchestrator = createOrchestrator({ transport: transport, draft: draft, projection: projection, agent: props.agent === undefined ? null : props.agent });
        return {
          transport: transport,
          draft: draft,
          projection: projection,
          orchestrator: orchestrator,
          getSnapshot: () => orchestrator.getSnapshot(),
          subscribe: (fn) => orchestrator.subscribe(fn),
          start: () => orchestrator.refresh({ reason: "mount" }),
          stop: () => orchestrator.dispose(),
          refresh: (options) => orchestrator.refresh(options),
          preflight: (action, summary) => orchestrator.preflight(action, summary),
          savePolicy: (body) => orchestrator.savePolicy(body),
          saveSkills: (operations) => orchestrator.saveSkills(operations),
          saveSignature: (body) => orchestrator.saveSignature(body),
          saveGuard: (body) => orchestrator.saveGuard(body),
          saveCatalog: (body) => orchestrator.saveCatalog(body),
          write: (spec) => orchestrator.write(spec),
          listSessions: () => orchestrator.listSessions(),
          selectSession: (agent) => orchestrator.selectSession(agent),
          autoRefreshDecision: (input) => orchestrator.autoRefreshDecision(input),
          detectExternalChange: (input) => orchestrator.detectExternalChange(input),
          loadDiagnostics: () => transport.diagnose("/api/dsh-gate/diagnostics", { query: orchestrator.session().agent === null ? undefined : { agent: orchestrator.session().agent } }),
          session: () => orchestrator.session(),
          epoch: () => orchestrator.epoch(),
        };
      };

      function FatalCard(props) {
        const value = props || {};
        const error = value.error;
        const summary = errorText(error);
        const stack = stackHead(error, 3);
        const diagnostics = value.diagnostics || "";
        const retry = () => { if (typeof value.onRetry === "function") value.onRetry(); };
        const copy = () => {
          const target = typeof navigator !== "undefined" && navigator && navigator.clipboard && typeof navigator.clipboard.writeText === "function" ? navigator.clipboard.writeText(diagnostics) : null;
          if (target && typeof target.catch === "function") target.catch(() => undefined);
        };
        return h("div", { key: "fatal", className: "dshg-wrap" }, [
          primitives.errorCard({ key: "card", title: text("error.title"), message: summary, summary: summary, stack: stack, diagnostics: diagnostics, onRetry: retry, onCopy: copy }),
        ]);
      }

      function PanelBody(props) {
        const runtimeRef = react.useRef(null);
        if (runtimeRef.current === null) runtimeRef.current = createRuntime(props);
        const runtime = runtimeRef.current;
        const [snapshot, setSnapshot] = react.useState(runtime.getSnapshot());
        const [view, setViewState] = react.useState(initialView(props));
        const [toastItems, setToastItems] = react.useState([]);
        const [confirmState, setConfirmState] = react.useState(null);
        const [fatalToken, setFatalToken] = react.useState(0);
        const [metrics, setMetrics] = react.useState(null);
        const [sessions, setSessions] = react.useState([]);
        const [sessionNotice, setSessionNotice] = react.useState("");
        const [nowMs] = react.useState(() => Date.now());
        const toastRef = react.useRef(null);
        if (toastRef.current === null) toastRef.current = primitives.createToastQueue();

        const applyView = (patch) => setViewState((previous) => Object.assign({}, previous, patch));
        const toast = (tone, message, key) => {
          toastRef.current.push({ tone: tone, text: message, key: key === undefined ? tone + ":" + message : key });
          setToastItems(toastRef.current.items());
        };
        const dismissToast = (key) => { toastRef.current.dismiss(key); setToastItems(toastRef.current.items()); };
        const closeConfirm = () => setConfirmState(null);

        react.useEffect(() => runtime.subscribe(setSnapshot), []);
        react.useEffect(() => {
          void runtime.start();
          return () => runtime.stop();
        }, []);
        react.useEffect(() => {
          if (view.jsonDirty === true) return;
          const policy = snapshot.data.policy;
          const content = isObject(policy) && isObject(policy.content) ? policy.content : {};
          const next = JSON.stringify(content, null, 2);
          setViewState((previous) => (previous.jsonText === next ? previous : Object.assign({}, previous, { jsonText: next })));
        }, [snapshot.dataKey, view.jsonDirty]);

        const draftStore = runtime.draft;
        const projection = runtime.projection;
        const summaryBase = draftStore.dirtySummary();
        const draftSnapshot = draftStore.snapshot();
        const dirtyKeyList = draftStore.dirtyKeys();
        const hasKind = (prefix) => dirtyKeyList.some((key) => String(key).indexOf(prefix) === 0);
        const draftFlags = Object.assign({}, draftSnapshot, {
          guardrailDirty: dirtyKeyList.some((key) => String(key).indexOf("guard:") === 0),
          catalogDirty: dirtyKeyList.some((key) => String(key).indexOf("cat:") === 0),
          signatureDirty: hasKind("sig:"),
        });
        const policyContent = isObject(snapshot.data.policy) && isObject(snapshot.data.policy.content) ? snapshot.data.policy.content : {};
        const routes = [
          { key: "state", status: snapshot.status.state },
          { key: "view", status: snapshot.status.view },
          { key: "policy", status: snapshot.status.policy },
          { key: "skills", status: snapshot.status.skills },
          { key: "mcp", status: snapshot.status.mcp },
        ];
        const model = snapshot.data.state === null && snapshot.data.view === null && snapshot.data.policy === null
          ? null
          : projection.build({
              dataKey: snapshot.dataKey,
              state: snapshot.data.state,
              view: snapshot.data.view,
              policy: snapshot.data.policy,
              draft: draftSnapshot,
              session: snapshot.session,
              query: view.query,
              sourceFilter: view.sourceFilter,
              statusFilter: view.statusFilter,
              chainFilter: view.chainFilter,
              sources: routes,
              readAt: isObject(snapshot.data.policy) ? snapshot.data.policy.mtime : undefined,
              stale: snapshot.status.state === "partial" || snapshot.status.view === "partial" || snapshot.status.policy === "partial",
              staleReason: snapshot.lastError,
            });
        const blocking = Boolean(model && model.stats.invalid > 0);
        const summary = Object.assign({}, summaryBase, { blocking: blocking });

        const runAction = (action, run) => {
          const gate = runtime.preflight(action, summary);
          if (gate.needsConfirm === true) { setConfirmState({ gate: gate, run: run }); return; }
          void run();
        };
        const handleReceipt = (receipt) => {
          if (!receipt) return;
          if (receipt.state === "applied") toast("ok", text("saved"));
          else if (receipt.state === "no-change") toast("ok", text("noChangeWritten"));
          else if (receipt.state === "partial") toast("warn", receipt.message);
          else if (receipt.state === "conflict") setConfirmState({ conflict: receipt });
          else toast("error", receipt.message || text("common.error"));
          const warnings = Array.isArray(receipt.warnings) ? receipt.warnings : [];
          if (warnings.length > 0) toast("warn", "服务端告警：" + warnings.map(warningText).join("；"), "warnings");
        };

        const actions = {
          setView: applyView,
          toggleGroup: (key, searching) => {
            const next = Object.assign({}, view.openGroups);
            next[key] = projection.groupNextOpen(view.openGroups[key], searching);
            applyView({ openGroups: next });
          },
          toggleRow: (id) => {
            const next = Object.assign({}, view.expanded);
            next[id] = next[id] !== true;
            applyView({ expanded: next });
          },
          stageCap: (row, tier) => {
            if (row === undefined || row === null) return;
            const key = row.synthetic ? draftStore.keys.defaults("skillpack") : draftStore.keys.cap(row.id);
            draftStore.stage(key, tier, "能力 " + row.id);
          },
          stageSkillpack: (tier) => draftStore.stage(draftStore.keys.defaults("skillpack"), tier, "技能目录层"),
          stageSkill: (name, tier) => draftStore.stage(draftStore.keys.skill(name), tier, "技能 " + name),
          stageException: (rowId, kind, name, tier) => {
            const key = draftStore.keys.exception(rowId, kind, name);
            draftStore.stage(key, tier, "例外 " + rowId + " " + name);
          },
          stageTakeover: (value) => draftStore.stage(draftStore.keys.defaults("takeover"), value, "技能接管"),
          stageCatalog: (field, value) => draftStore.stage(draftStore.keys.catalog(field), value, "目录 " + field),
          stageGuard: (field, value) => draftStore.stage(draftStore.keys.guard(field), value, "护栏 " + field),
          stageSignature: (enabled, toolsText) => {
            draftStore.stage(draftStore.keys.signature("enabled"), enabled, "签名摘要开关");
            const tools = String(toolsText || "").split(",").map((item) => item.trim()).filter((item) => item.length > 0);
            draftStore.stage(draftStore.keys.signature("tools"), tools, "签名工具名单");
          },
          restoreSignature: () => {
            draftStore.stage(draftStore.keys.signature("enabled"), undefined, "还原签名开关");
            draftStore.stage(draftStore.keys.signature("tools"), undefined, "还原签名名单");
          },
          addImport: (path) => {
            const staged = draftStore.stageImport(path);
            if (staged) { applyView({ importDraft: "" }); toast("ok", "已加入草稿，保存后才写盘", "import"); }
            else toast("warn", "目录为空或已经在导入清单里", "import");
          },
          removeImport: (path) => { draftStore.removeImport(path); toast("ok", "已从草稿移除，不会动原目录文件", "import-remove"); },
          removeOff: (name) => { draftStore.stageClose(name); toast("ok", "已从旧关闭清单移除（可撤销）", "off"); },
          clearOff: () => {
            setConfirmState({ gate: { action: "save-skills", text: text("skills.offClearConfirm"), consequence: "清空后保存才写盘；可用撤销恢复", confirmLabel: text("confirm.ok"), cancelLabel: text("confirm.cancel"), needsConfirm: true }, run: () => { draftStore.clearCloseList(); toast("ok", "旧关闭清单已清空（可撤销）", "off-clear"); } });
          },
          discard: () => { draftStore.discardAll(); toast("ok", "已放弃面板里未保存的改动", "discard"); },
          undo: () => { const action = draftStore.undo(); if (action) toast("info", "已撤销：" + action.label, "undo"); },
          redo: () => { const action = draftStore.redo(); if (action) toast("info", "已重做：" + action.label, "redo"); },
          reload: () => runAction("reload", async () => { await runtime.refresh({ reason: "manual" }); toast("ok", "已重新读取", "reload"); }),
          requestGroupBatch: (kind, tier) => {
            const rows = model ? model.rows.filter((row) => row.kind === kind) : [];
            const changed = rows.filter((row) => row.effectiveTier !== tier);
            const detail = changed.length === 0 ? "没有成员的层会变化" : changed.slice(0, 8).map((row) => row.id + "：" + row.effectiveTier + " → " + tier).join("；");
            setConfirmState({
              gate: { action: "save-policy", text: "把整组「" + kind + "」设为「" + (TIER_LABEL[tier] || tier) + "」", consequence: "影响 " + changed.length + " 条（先看影响预览再决定）", detail: detail, confirmLabel: text("confirm.ok"), cancelLabel: text("confirm.cancel"), needsConfirm: true },
              run: () => {
                draftStore.stageMany(rows.map((row) => ({ key: row.synthetic ? draftStore.keys.defaults("skillpack") : draftStore.keys.cap(row.id), value: tier, label: row.id })), "整组 " + kind);
                toast("ok", "已暂存 " + changed.length + " 条，保存前可在待保存变更里看差异", "group-batch");
              },
            });
          },
          savePolicy: () => runAction("save-policy", async () => {
            const receipt = await runtime.savePolicy(draftStore.toPolicyBody());
            if (receipt.state === "applied" || receipt.state === "no-change") draftStore.commitKeys(draftStore.dirtyKeys());
            handleReceipt(receipt);
            if (receipt.state === "applied") await runtime.refresh({ reason: "post-save" });
          }),
          saveSkills: () => runAction("save-skills", async () => {
            const operations = draftStore.toSkillOperations();
            const keys = draftStore.keysForSkillOperations();
            const payload = operations.map((operation) => { const copy = Object.assign({}, operation); delete copy.key; return copy; });
            const receipt = await runtime.saveSkills(payload);
            if (receipt.state === "applied" || receipt.state === "no-change") draftStore.commitKeys(keys);
            else if (receipt.state === "partial" && Array.isArray(receipt.applied)) {
              const appliedIndexes = receipt.applied.map((item) => (item && typeof item.index === "number" ? item.index : -1)).filter((index) => index >= 0);
              const appliedKeys = appliedIndexes.map((index) => (operations[index] && operations[index].key ? operations[index].key : null)).filter(Boolean);
              if (appliedKeys.length > 0) draftStore.commitKeys(appliedKeys);
            }
            handleReceipt(receipt);
          }),
          saveSignature: () => runAction("save-signature", async () => {
            const receipt = await runtime.saveSignature(draftStore.toSignatureBody());
            if (receipt.state === "applied" || receipt.state === "no-change") draftStore.commitKeys(draftStore.dirtyKeys().filter((key) => String(key).indexOf("sig:") === 0));
            handleReceipt(receipt);
            if (receipt.state === "applied") await runtime.refresh({ reason: "post-save" });
          }),
          saveGuard: () => runAction("save-policy", async () => {
            const receipt = await runtime.saveGuard(draftStore.toGuardBody());
            if (receipt.state === "applied" || receipt.state === "no-change") draftStore.commitKeys(draftStore.dirtyKeys().filter((key) => String(key).indexOf("guard:") === 0));
            handleReceipt(receipt);
            if (receipt.state === "applied") await runtime.refresh({ reason: "post-save" });
          }),
          saveCatalog: () => runAction("save-policy", async () => {
            const receipt = await runtime.saveCatalog(draftStore.toCatalogBody());
            if (receipt.state === "applied" || receipt.state === "no-change") draftStore.commitKeys(draftStore.dirtyKeys().filter((key) => String(key).indexOf("cat:") === 0));
            handleReceipt(receipt);
            if (receipt.state === "applied") await runtime.refresh({ reason: "post-save" });
          }),
          mcpAction: (action, name) => runAction("mcp", async () => {
            const receipt = await runtime.write({ path: "/api/dsh-gate/mcp", action: "mcp-" + action, body: { action: action, name: name } });
            handleReceipt(receipt);
            if (receipt.state === "applied") await runtime.refresh({ reason: "post-mcp" });
          }),
          mcpRemove: (name) => setConfirmState({ gate: { action: "mcp", text: "删除 MCP server「" + name + "」？", consequence: "从 gate 托管配置里移除；宿主配置不受影响", confirmLabel: "确认删除", cancelLabel: text("confirm.cancel"), needsConfirm: true }, run: () => { void runtime.write({ path: "/api/dsh-gate/mcp", action: "mcp-remove", body: { action: "remove", name: name } }).then((receipt) => { handleReceipt(receipt); if (receipt.state === "applied") return runtime.refresh({ reason: "post-mcp" }); return undefined; }); } }),
          mcpAdd: () => {
            const name = String(view.mcpDraft.name || "").trim();
            if (name.length === 0) { toast("error", "name 不能为空", "mcp-add"); return; }
            const server = view.mcpDraft.transport === "http"
              ? { transport: "streamable-http", url: String(view.mcpDraft.url || "").trim() }
              : { transport: "stdio", command: String(view.mcpDraft.command || "").trim(), args: parseArgs(view.mcpDraft.args).filter((item) => item.indexOf("__UNCLOSED__:") !== 0) };
            runAction("mcp", async () => {
              const receipt = await runtime.write({ path: "/api/dsh-gate/mcp", action: "mcp-add", body: { action: "add", name: name, server: server } });
              handleReceipt(receipt);
              if (receipt.state === "applied") { applyView({ mcpDraft: { name: "", transport: "stdio", command: "", args: "", url: "" } }); await runtime.refresh({ reason: "post-mcp" }); }
            });
          },
          setMcpDraft: (patch) => applyView({ mcpDraft: Object.assign({}, view.mcpDraft, patch) }),
          editJson: (value) => { draftStore.json.setText(value); draftStore.json.setDirty(true); applyView({ jsonText: value, jsonDirty: true, jsonNotice: null }); },
          validateJson: () => {
            const parsed = parseText(view.jsonText);
            applyView({ jsonNotice: parsed.ok ? { tone: "ok", text: "校验通过（" + bytesOf(view.jsonText) + " 字节）" } : { tone: "error", text: text("json.invalid") + "：" + parsed.message } });
          },
          formatJson: () => {
            const parsed = parseText(view.jsonText);
            if (!parsed.ok) { applyView({ jsonNotice: { tone: "error", text: text("json.invalid") + "：" + parsed.message } }); return; }
            const next = JSON.stringify(parsed.value, null, 2);
            if (next === view.jsonText) { applyView({ jsonNotice: { tone: "ok", text: "格式化前后字节相同，未置脏" } }); return; }
            draftStore.json.setText(next);
            draftStore.json.setDirty(true);
            applyView({ jsonText: next, jsonDirty: true, jsonNotice: { tone: "ok", text: "已格式化；记得保存才会写盘" } });
          },
          requestJsonSave: () => {
            const parsed = parseText(view.jsonText);
            if (!parsed.ok) { applyView({ jsonNotice: { tone: "error", text: text("json.invalid") + "：" + parsed.message } }); return; }
            setConfirmState({ gate: { action: "save-policy", text: text("json.confirmTitle"), consequence: "整份替换会丢弃面板里的能力/技能草稿（" + summary.text + "）", detail: "提交带 revision=" + String(snapshot.revision === null ? "—" : snapshot.revision), confirmLabel: text("confirm.ok"), cancelLabel: text("confirm.cancel"), needsConfirm: summary.total > 0 }, run: () => {
              void runtime.savePolicy(Object.assign({}, parsed.value, { replace: true, revision: snapshot.revision })).then((receipt) => {
                if (receipt.state === "applied" || receipt.state === "no-change") { draftStore.discardAll(); draftStore.json.setDirty(false); applyView({ jsonDirty: false }); }
                handleReceipt(receipt);
                if (receipt.state === "applied") return runtime.refresh({ reason: "post-json" });
                return undefined;
              });
            } });
          },
          requestJsonRestore: () => {
            const resolved = projection.resolveDefaultTemplate({ serverTemplate: isObject(snapshot.data.policy) && isObject(snapshot.data.policy.template) ? snapshot.data.policy.template : null, fallback: fallbackTemplate() });
            setConfirmState({ gate: { action: "save-policy", text: "载入" + (resolved.source === "server" ? "服务端" : "内置兜底") + "默认？", consequence: "会覆盖编辑器内容（尚未写盘）；保存后整份替换", detail: resolved.stale ? "服务端没有给默认模板，用的是内置兜底（可能过时）" : "默认模板来自服务端生成器", confirmLabel: "载入默认", cancelLabel: text("confirm.cancel"), needsConfirm: true }, run: () => {
              const next = JSON.stringify(resolved.template || {}, null, 2);
              draftStore.json.setText(next);
              draftStore.json.setDirty(true);
              applyView({ jsonText: next, jsonDirty: true, jsonNotice: { tone: "warn", text: "已载入默认（尚未保存）" } });
              closeConfirm();
            } });
          },
          importJson: () => {
            const parsed = parseText(view.exchangeText);
            if (!parsed.ok) { applyView({ jsonNotice: { tone: "error", text: "导入失败：" + parsed.message } }); return; }
            const envelope = isObject(parsed.value.policy) ? parsed.value.policy : parsed.value;
            if (!isObject(envelope)) { applyView({ jsonNotice: { tone: "error", text: "导入失败：找不到策略对象" } }); return; }
            const version = Number(envelope.version);
            if (Number.isFinite(version) && version > 3) { applyView({ jsonNotice: { tone: "error", text: "导入失败：版本 " + version + " 高于当前 v3，已阻断" } }); return; }
            const next = JSON.stringify(envelope, null, 2);
            draftStore.json.setText(next);
            draftStore.json.setDirty(true);
            applyView({ jsonText: next, jsonDirty: true, jsonNotice: { tone: "warn", text: Number.isFinite(version) && version < 3 ? "已导入 v" + version + " 策略，保存时由服务端迁移到 v3" : "已导入，保存前先看差异" } });
          },
          exportJson: () => {
            const content = isObject(policyContent) ? policyContent : {};
            applyView({ exchangeText: JSON.stringify(content, null, 2) });
            toast("info", "已把当前有效策略写入导出框，可直接复制", "export");
          },
          listSessions: async () => {
            const result = await runtime.listSessions();
            if (!result.ok) { setSessionNotice("读取会话清单失败：" + (result.error || "")); return; }
            setSessions(result.sessions);
            setSessionNotice(result.sessions.length === 0 ? "诊断端点没有列出已装配会话，继续用自动选取" : "已列出 " + result.sessions.length + " 个会话");
          },
          selectSession: (agent) => { if (runtime.selectSession(agent)) void runtime.refresh({ reason: "session" }); },
          loadDiagnostics: async () => {
            const result = await runtime.loadDiagnostics();
            if (!result.ok) { setMetrics(null); toast("warn", "运行态读取失败（" + (result.error || "") + "），不冒充零", "metrics"); return; }
            const body = isObject(result.body) ? result.body : {};
            setMetrics(isObject(body.runtime) ? body.runtime : { counters: body });
          },
        };

        if (snapshot.loading === false && snapshot.data.state === null && snapshot.lastError !== "") {
          return h("div", { key: "root", className: "dshg-wrap" }, [
            h("div", { key: "error", className: "dshg-alert", "data-tone": "error", role: "alert" }, text("loadFailed") + "：" + snapshot.lastError),
            h("div", { key: "foot", className: "dshg-foot" }, [
              h("button", { key: "retry", type: "button", className: "dshg-btn", onClick: () => { void runtime.refresh({ reason: "retry" }); } }, text("retry")),
            ]),
          ]);
        }

        const viewProps = {
          model: model,
          snapshot: snapshot,
          draft: draftFlags,
          summary: summary,
          view: view,
          actions: actions,
          health: model ? model.health : { session: snapshot.session, file: "", readAt: null, sources: routes, stale: false, staleReason: "" },
          readAtText: relativeText(isObject(snapshot.data.policy) ? snapshot.data.policy.mtime : null, nowMs, null),
          argsPreview: parseArgs(view.mcpDraft.args),
          jsonParsed: parseText(view.jsonText),
          jsonDiff: model && view.jsonDirty === true && parseText(view.jsonText).ok ? projection.diffPolicies(policyContent, parseText(view.jsonText).value) : null,
          guard: Object.assign({ enabled: true, windowSize: 10, threshold: 3, reminders: 1, previewChars: 400, exclusions: [] }, isObject(policyContent.repeatGuard) ? policyContent.repeatGuard : {}, draftSnapshot.guardrail),
          catalog: Object.assign({ groupByPlugin: true, maxDescriptionLength: 64, skillGroups: false }, isObject(policyContent.catalog) ? policyContent.catalog : {}, draftSnapshot.catalog),
          autoRefresh: { enabled: view.autoInterval !== 0, interval: view.autoInterval === 0 ? 30 : view.autoInterval },
          autoDecision: runtime.autoRefreshDecision({ enabled: view.autoInterval !== 0, intervalMs: view.autoInterval === 0 ? 30 : view.autoInterval, dirtyCount: summary.total, writing: snapshot.writingActive, visible: true }),
          session: snapshot.session,
          sessionLabel: sessionLabelOf(snapshot.session, text),
          sessions: sessions,
          sessionNotice: sessionNotice,
          metrics: metrics,
          diff: model && summary.total > 0 ? projection.diffPolicies(policyContent, draftStore.toPolicy()) : null,
          canUndo: draftStore.canUndo(),
          canRedo: draftStore.canRedo(),
          undoDepth: draftStore.undoDepth(),
          maxUndo: draftStore.MAX_UNDO,
          saving: snapshot.writingActive,
          tab: view.tab,
        };

        const layout = () => {
          const statsNodes = model === null
            ? [statNode("stat:visible", text("common.none"), text("caps.title")), statNode("stat:rows", text("common.none"), text("common.none"))]
            : [
                statNode("stat:visible", String(model.stats.visibleTools), "可见工具"),
                statNode("stat:rows", String(model.stats.rows), text("caps.title")),
                statNode("stat:resident", String(model.stats.resident), text("tier.resident")),
                statNode("stat:ondemand", String(model.stats.ondemand), text("tier.ondemand")),
                statNode("stat:off", String(model.stats.off), text("tier.off")),
                statNode("stat:sections", String(model.stats.sections), "段落"),
                statNode("stat:skills", String(model.stats.skills), text("skills.title")),
                statNode("stat:warnings", String(model.stats.warnings), "告警", model.stats.warnings > 0 ? "warn" : undefined),
                statNode("stat:dirty", String(summary.total), text("caps.pending"), summary.total > 0 ? "warn" : undefined),
              ];
          const toolbarNodes = [
            primitives.switchButton({ key: "enabled", on: snapshot.data.state === null || snapshot.data.state.enabled !== false, label: snapshot.data.state === null ? "闸门" : (snapshot.data.state.enabled === false ? "闸门已禁用" : "闸门已启用"), disabled: snapshot.writingActive || snapshot.loading, reason: "读写进行中，按钮按统一矩阵禁用", onToggle: () => actions.reload() }),
            buttonNode("toolbar:reload", snapshot.loading ? text("common.loading") : text("reload"), () => actions.reload(), { disabled: snapshot.writingActive }),
            buttonNode("toolbar:save", snapshot.writingActive ? text("saving") : text("save"), () => actions.savePolicy(), { primary: true, disabled: summary.total === 0 || summary.blocking === true || snapshot.writingActive, reason: summary.blocking ? text("caps.blocked") : text("noChanges") }),
            buttonNode("toolbar:undo", text("undo"), () => actions.undo(), { disabled: !draftStore.canUndo() }),
            buttonNode("toolbar:redo", text("redo"), () => actions.redo(), { disabled: !draftStore.canRedo() }),
            h("span", { key: "dirty", className: "dshg-hint" }, summary.text),
            buttonNode("toolbar:discard", text("discard"), () => actions.discard(), { disabled: summary.total === 0, danger: true }),
          ];
          const tabsNodes = primitives.tabsBar({
            key: "tabsbar",
            tabs: TABS.map((tab) => ({ value: tab.value, label: tab.label, count: tab.value === "caps" ? (model ? model.stats.rows : "") : tab.value === "skills" ? (model ? model.stats.skills : "") : tab.value === "json" ? (view.jsonDirty ? "•" : "") : "" })),
            active: view.tab,
            onSelect: (value) => applyView({ tab: value }),
            onKeyDown: (event) => {
              const key = event && event.key;
              if (!key) return;
              const index = TABS.map((tab) => tab.value).indexOf(view.tab);
              let next = index;
              if (key === "ArrowRight") next = (index + 1) % TABS.length;
              else if (key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
              else if (key === "Home") next = 0;
              else if (key === "End") next = TABS.length - 1;
              else return;
              if (typeof event.preventDefault === "function") event.preventDefault();
              applyView({ tab: TABS[next].value });
            },
          });
          const bodyNode = view.routeMissing
            ? h("div", { key: "route-missing", className: "dshg-card" }, [
                h("div", { key: "head", className: "dshg-cardHead" }, text("error.viewMissing")),
                h("div", { key: "body", className: "dshg-cardBody" }, [
                  h("div", { key: "hint", className: "dshg-hint" }, text("error.viewMissingHint")),
                  h("div", { key: "actions", className: "dshg-row" }, [
                    h("button", { key: "retry", type: "button", className: "dshg-btn", onClick: () => { void runtime.refresh({ reason: "retry" }); } }, text("retry")),
                    h("button", { key: "caps", type: "button", className: "dshg-btn", onClick: () => applyView({ tab: "caps", routeMissing: false }) }, text("error.backToCaps")),
                  ]),
                ]),
              ])
            : views.renderTabPanel(viewProps);
          const dialog = confirmState === null ? null : (confirmState.conflict
            ? primitives.confirmBar({
                key: "dialog:conflict",
                id: "dshg-conflict",
                title: "revision 冲突：请三选一",
                text: confirmState.conflict.message,
                detail: confirmState.conflict.choices.map((choice) => choice.label + " — " + choice.consequence).join("；"),
                confirmLabel: "覆盖服务端",
                cancelLabel: text("confirm.cancel"),
                destructive: true,
                onConfirm: () => { const conflict = confirmState.conflict; setConfirmState(null); void runtime.savePolicy(Object.assign({}, draftStore.toPolicyBody(), { revision: conflict.revision })).then(handleReceipt); },
                onCancel: () => setConfirmState(null),
              })
            : primitives.confirmBar({
                key: "dialog:confirm",
                id: "dshg-confirm",
                title: confirmState.gate.text,
                text: confirmState.gate.consequence,
                detail: confirmState.gate.detail,
                confirmLabel: confirmState.gate.confirmLabel,
                cancelLabel: confirmState.gate.cancelLabel,
                destructive: true,
                onKeyDown: (event) => { if (event && event.key === "Escape") setConfirmState(null); },
                onConfirm: () => { const run = confirmState.run; setConfirmState(null); if (typeof run === "function") void run(); },
                onCancel: () => setConfirmState(null),
              }));
          return h("div", { key: "root:" + fatalToken, className: "dshg-wrap" }, [
            h("div", { key: "head", className: "dshg-head" }, [
              h("div", { key: "grow", className: "dshg-grow" }, [
                h("div", { key: "title", className: "dshg-title" }, text("title")),
                h("div", { key: "sub", className: "dshg-sub" }, text("subtitle") + " · v" + PANEL_VERSION),
              ]),
            ]),
            h("div", { key: "stats", className: "dshg-stats" }, statsNodes),
            h("div", { key: "health", className: "dshg-col" }, primitives.healthBar({ key: "healthbar", health: viewProps.health, sessionLabel: viewProps.sessionLabel, readAtText: viewProps.readAtText })),
            h("div", { key: "toasts", className: "dshg-col" }, primitives.toastHost({ key: "toasthost", items: toastItems, onDismiss: dismissToast })),
            h("div", { key: "dialog", className: "dshg-col" }, dialog),
            h("div", { key: "toolbar", className: "dshg-row" }, toolbarNodes),
            h("div", { key: "tabs", className: "dshg-col" }, tabsNodes),
            h("div", { key: "body", className: "dshg-col" }, bodyNode),
            h("div", { key: "foot", className: "dshg-foot" }, [
              h("span", { key: "file", className: "dshg-note" }, text("health.file") + "：" + (viewProps.health.file || text("common.none"))),
              h("span", { key: "note", className: "dshg-hint" }, "面板只读写本机 /api/dsh-gate/*；请求八到十五秒内必有结果"),
            ]),
          ]);
        };

        const statNode = (key, value, label, tone) => h("div", { key: key, className: "dshg-stat", "data-tone": tone }, [h("b", { key: "v" }, String(value)), h("span", { key: "l" }, String(label))]);
        const buttonNode = (key, label, onClick, options) => {
          const opts = options || {};
          return h("button", { key: key, type: "button", className: "dshg-btn", "data-primary": opts.primary === true ? "true" : undefined, "data-danger": opts.danger === true ? "true" : undefined, disabled: opts.disabled === true, title: opts.disabled === true ? (opts.reason || "") : "", onClick: opts.disabled === true ? undefined : onClick }, String(label));
        };

        try {
          return layout();
        } catch (error) {
          const diagnostics = JSON.stringify({ version: PANEL_VERSION, session: snapshot.session, tab: view.tab, lastFailedSource: Object.keys(snapshot.errors).filter((key) => snapshot.errors[key] !== "")[0] || "unknown" });
          return h(FatalCard, { key: "fatal:" + fatalToken, error: error, diagnostics: diagnostics, onRetry: () => { setFatalToken(fatalToken + 1); void runtime.refresh({ reason: "retry" }); } });
        }
      }

      const sessionLabelOf = (session, translate) => {
        const value = session || { agent: null, source: "auto" };
        if (value.source === "host") return String(value.agent || "") + "（" + translate("settings.sessionHost") + "）";
        if (value.source === "panel") return String(value.agent || "") + "（" + translate("settings.sessionPanel") + "）";
        return String(value.agent || translate("settings.sessionAuto")) + (value.agent ? "" : "");
      };

      return Object.freeze({
        PANEL_VERSION: PANEL_VERSION,
        TABS: TABS,
        tabOf: tabOf,
        ensureStyle: ensureStyle,
        parseArgs: parseArgs,
        relativeText: relativeText,
        PanelBody: PanelBody,
        FatalCard: FatalCard,
        sessionLabelOf: sessionLabelOf,
      });
    }

    /* =====================================================================
     * 默认策略模板（0.5.7 遗留字面量，仅作灾难兜底；真源在服务端生成器）
     * 面板保存与「载入默认」优先用 /policy 响应里的 template，只有服务端
     * 完全没给时才用这份；跨端一致性用例（FG-7）继续以静态抽取锁定其形状。
     * ===================================================================== */
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

    /* =====================================================================
     * 组合根（只做装配，不持有状态）
     * ===================================================================== */
    const primitives = createL5Primitives({ h: h, text: text });
    const views = createL6Views({ h: h, text: text, primitives: primitives });
    const shell = createL7Shell({
      react: react,
      h: h,
      text: text,
      primitives: primitives,
      views: views,
      createTransport: createL1Transport,
      createDraft: createL2DraftStore,
      createProjection: createL3Projection,
      createOrchestrator: createL4Orchestrator,
      fallbackTemplate: fallbackTemplate,
    });

    function GatePanel(props) {
      const value = props || {};
      return shell.PanelBody({ page: value.page === undefined ? true : value.page, agent: value.agent, route: value.route });
    }

    /* 测试门控钩子：只有宿主/垫片预先放了 __DSH_GATE_TEST_HOOK__ 才挂载。
     * 生产态该键不存在，exports 仍严格是 ['inject','apply']（I-6 / ADR A-5）。 */
    const testHook = typeof window === "undefined" ? undefined : window.__DSH_GATE_TEST_HOOK__;
    if (testHook !== undefined && testHook !== null && typeof testHook === "object") {
      testHook.version = "0.6.0";
      testHook.template = () => fallbackTemplate();
      testHook.text = TEXT;
      testHook.textKeys = Object.keys(TEXT);
      testHook.style = { attr: STYLE_ATTR, sections: STYLE_SECTIONS, text: styleText() };
      testHook.constants = {
        TIER_OFF: TIER_OFF,
        TIER_RESIDENT: TIER_RESIDENT,
        TIER_ONDEMAND: TIER_ONDEMAND,
        TIER_ORDER: TIER_ORDER,
        TIER_LABEL: TIER_LABEL,
        MAX_UNDO: 50,
        MAX_TOASTS: 5,
        TOAST_LIFETIME: { ok: 4000, info: 6000, warn: 8000, error: 0 },
        PANEL_VERSION: "0.6.0",
      };
      testHook.helpers = {
        parseArgs: shell.parseArgs,
        relativeText: shell.relativeText,
        tabOf: shell.tabOf,
        sessionLabelOf: shell.sessionLabelOf,
        stableStringify: stableStringify,
        fnv1a: fnv1a,
        warningText: warningText,
      };
      testHook.L1 = { create: createL1Transport, TIMEOUTS: { read: 8000, write: 15000, diagnose: 5000 }, KINDS: ["timeout", "aborted", "network", "http", "protocol", "auth", "missing"] };
      testHook.L2 = { create: createL2DraftStore, MAX_UNDO: 50, PREFIX: { cap: "cap:", exc: "exc:", skill: "skill:", section: "section:", imp: "imp:" } };
      testHook.L3 = { create: createL3Projection };
      testHook.L4 = { create: createL4Orchestrator, SOURCES: ["state", "view", "policy", "skills", "mcp"] };
      testHook.draft = createL2DraftStore({});
      testHook.projection = createL3Projection({});
      testHook.transport = createL1Transport({
        fetch: typeof fetch === "function" ? fetch : null,
        setTimeout: typeof setTimeout === "function" ? setTimeout : null,
        clearTimeout: typeof clearTimeout === "function" ? clearTimeout : null,
      });
      testHook.primitives = primitives;
      testHook.views = views;
      testHook.shell = shell;
    }

    const summaryText = () => TEXT["summary"];

    exports.inject = ["slots"];
    exports.apply = (ctx) => {
      ctx.slots.inject("plugins.row.config", () =>
        ctx.slots.register(
          { name: "plugins.row.config", key: "dsh-gate#surface-gate" },
          (slotProps) => (slotProps && slotProps.view === "summary"
            ? summaryText()
            : h(GatePanel, { page: true, agent: slotProps && slotProps.agent, route: slotProps && slotProps.route })),
        ));
    };

    return module.exports;
  },
});
