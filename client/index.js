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
      "title": "工具闸门",
      "tabs.label": "页签",
      "tab.caps": "能力",
      "tab.skills": "技能",
      "tab.mcp": "MCP",
      "tab.settings": "高级",
      "purpose.caps": "这一页管能力层：每条能力单独设层——常驻＝始终可用、按需＝被调用时才放行、关闭＝不注入。改动先落草稿，用底部保存栏一次写盘。",
      "purpose.skills": "这一页管技能与技能目录：接管开关决定技能是否由闸门审批，目录按来源分组折叠，搜索只过滤不写盘；旧关闭清单为空时不显示。",
      "purpose.mcp": "这一页管 MCP 服务器：新增、编辑、启用、删除都即时写盘并立刻生效，不经过底部保存栏。",
      "purpose.settings": "这一页是高级设置：会话与诊断、防复读护栏、目录摘要、策略 JSON、运行态指标。策略 JSON 是整份替换，保存前先看差异。",
      "common.none": "—",
      "common.justNow": "刚刚",
      "common.minutesAgo": "分钟前",
      "common.loading": "读取中…",
      "common.error": "出错了",
      "common.stale": "旧数据",
      "common.count": "条",
      "tier.off": "关闭",
      "tier.resident": "常驻",
      "tier.ondemand": "按需",
      "tier.offHint": "不注入、不审批",
      "tier.residentHint": "始终可用",
      "tier.ondemandHint": "被调用时才放行",
      "tier.label": "层",
      "caps.search": "搜索能力名、工具名或原因",
      "caps.filterSource": "按来源筛选",
      "caps.filterStatus": "按层筛选",
      "caps.all": "全部",
      "caps.clearFilter": "清除筛选",
      "caps.expand": "看例外与工具",
      "caps.collapse": "收起详情",
      "caps.empty": "没有匹配的能力：清掉筛选或换个搜索词",
      "caps.groupSet": "整组设置",
      "caps.groupSetHint": "把这一组一次设成同一层，先看影响预览再确认",
      "caps.member": "成员",
      "caps.tools": "工具",
      "caps.sections": "段落",
      "caps.why": "为什么是这个层",
      "caps.exception": "例外",
      "caps.chainTitle": "决策链",
      "caps.chainNone": "没有成员命中任何规则，层值来自能力条目或默认层",
      "caps.winner": "生效来源",
      "caps.deviations": "数据不完整",
      "caps.upstream": "被上游隐藏",
      "caps.warnings": "告警",
      "caps.confidence": "置信度",
      "caps.synthetic": "默认层",
      "caps.merged": "已合并",
      "caps.managed": "宿主托管",
      "caps.readonly": "只读服务",
      "caps.memberTier": "成员层",
      "caps.filtered": "筛选中",
      "caps.pending": "待保存",
      "caps.blocked": "有阻塞项，先修掉再保存",
      "caps.memberEmpty": "这一组暂时没有成员",
      "skills.title": "技能",
      "skills.search": "搜索技能名、来源或路径",
      "skills.empty": "没有匹配的技能",
      "skills.takeoverTitle": "技能接管",
      "skills.takeover": "接管技能审批",
      "skills.takeoverHint": "打开后技能的新增与禁用由闸门审批；关闭则一切照旧",
      "skills.relay": "旧关闭清单中继",
      "skills.promote": "提升为常驻",
      "skills.importsTitle": "导入技能目录",
      "skills.importsHint": "加入草稿后保存才写盘，不清空原目录",
      "skills.importPlaceholder": "目录绝对路径",
      "skills.importAdd": "加入草稿",
      "skills.importRemove": "移除",
      "skills.importEmpty": "还没有待导入的目录",
      "skills.offTitle": "旧关闭清单",
      "skills.offHint": "这些名字来自旧版本的关闭清单，移除后保存才写盘",
      "skills.offClear": "清空清单",
      "skills.offClearConfirm": "清空旧关闭清单？保存后才写盘，可用撤销恢复",
      "skills.shadowed": "被同名技能遮挡",
      "skills.providers": "来源",
      "skills.searchEmpty": "搜索词为空时列出全部",
      "mcp.title": "MCP 服务器",
      "mcp.liveHint": "这一页即时生效：启用、禁用、编辑、删除都立刻写盘并重载连接",
      "mcp.empty": "还没有托管任何 MCP 服务器，展开下面的表单添加第一个",
      "mcp.addTitle": "新增 MCP 服务器",
      "mcp.addToggle": "展开表单",
      "mcp.addCollapse": "收起表单",
      "mcp.edit": "编辑",
      "mcp.editTitle": "编辑 MCP 服务器",
      "mcp.saveEdit": "保存修改",
      "mcp.cancelEdit": "取消编辑",
      "mcp.name": "名称",
      "mcp.transport": "传输",
      "mcp.url": "地址（https://…）",
      "mcp.command": "命令",
      "mcp.args": "参数（空格分隔，可加引号）",
      "mcp.argsPreview": "解析成",
      "mcp.enable": "启用",
      "mcp.remove": "删除",
      "mcp.removeTitle": "删除这个 MCP 服务器？",
      "mcp.removeConsequence": "从闸门托管配置里移除；宿主自己的配置不受影响",
      "mcp.tools": "工具数",
      "mcp.state": "状态",
      "mcp.writable": "只读：宿主没有给写入口，这一页只能看",
      "mcp.emptyName": "名称不能为空",
      "mcp.count": "台",
      "mcp.noTools": "尚未统计",
      "settings.sessionTitle": "会话切换与诊断",
      "settings.sessionHint": "宿主注入的会话优先；没有时按面板选择；再没有就自动选取",
      "settings.sessionAuto": "自动选取",
      "settings.sessionHost": "宿主注入",
      "settings.sessionPanel": "面板选择",
      "settings.sessionList": "读取会话清单",
      "settings.sessionEmpty": "诊断端点没有列出会话，继续用自动选取",
      "settings.guardTitle": "重复劳动护栏",
      "settings.guardHint": "护栏只管重复劳动提醒，不改能力行为；数值越界会被服务端拒绝",
      "settings.guardEnabled": "启用护栏",
      "settings.window": "窗口（2–200）",
      "settings.threshold": "阈值（2–50）",
      "settings.reminders": "提醒（1–5）",
      "settings.previewChars": "预览字符（40–4000）",
      "settings.exclusions": "排除名单（逗号分隔）",
      "settings.catalogTitle": "目录摘要",
      "settings.catalogHint": "决定能力清单怎么分组、描述截多长；缓存与恒在项只影响展示",
      "settings.catalogThree": "目录三选项",
      "settings.catalogByPlugin": "按插件",
      "settings.catalogBySkillGroup": "按技能包",
      "settings.catalogFlat": "平铺",
      "settings.catalogMaxDesc": "描述上限",
      "settings.catalogCache": "缓存",
      "settings.catalogUnknown": "尚未统计",
      "settings.catalogResident": "恒在项",
      "settings.signatureTitle": "签名摘要",
      "settings.signatureHint": "给每次调用附签名便于去重；工具名单为空表示全部",
      "settings.signatureEnabled": "启用签名摘要",
      "settings.signatureTools": "工具名单（逗号分隔）",
      "settings.signatureRestore": "单键还原",
      "settings.autoHint": "面板不自动刷新（自动刷新只发生在宿主前台轮询），需要新数据点「重新读取」",
      "settings.jsonTitle": "策略 JSON",
      "settings.jsonHint": "这里是整份替换：先校验，再看差异，最后点整份替换；它会丢弃面板里的其它草稿；导入导出共用这一个文本框",
      "settings.jsonValidate": "校验",
      "settings.jsonFormat": "格式化",
      "settings.jsonDefault": "载入默认",
      "settings.jsonReplace": "整份替换",
      "settings.jsonImport": "导入",
      "settings.jsonExport": "导出复制",
      "settings.jsonInvalid": "JSON 不合法",
      "settings.jsonValidated": "校验通过",
      "settings.jsonExported": "已复制到剪贴板",
      "settings.jsonCopyFallback": "剪贴板不可用，请手动复制导出框",
      "settings.jsonDiff": "整份替换的差异",
      "settings.jsonBytes": "字节",
      "settings.metricsTitle": "运行态指标",
      "settings.metricsHint": "指标来自 /api/dsh-gate/diagnostics；读不到就写尚未统计，不冒充零",
      "settings.metricsRefresh": "刷新指标",
      "settings.metricsNone": "尚未统计",
      "settings.metricsFailed": "指标读取失败",
      "top.enabled": "闸门已启用",
      "top.disabled": "闸门已禁用",
      "top.toggleReason": "读写进行中，先等这一轮结束",
      "top.reload": "重新读取",
      "top.diag": "诊断",
      "top.pending": "待保存",
      "top.warnings": "告警",
      "diag.file": "文件",
      "diag.readAt": "读取时刻",
      "diag.sources": "数据源",
      "diag.hint": "每份数据源单独报告状态；单个接口失败只降级对应卡片",
      "corrupt.title": "策略文件读不干净",
      "corrupt.text": "文件里可能有 BOM、多余逗号或语法错误，面板已进入只读保护：能力与技能暂时读不出来。",
      "corrupt.rebuild": "用默认策略重建",
      "corrupt.confirmTitle": "用默认策略整份重建？",
      "corrupt.confirmText": "会覆盖当前策略文件（原文件由服务端备份）；重建后能力层回到默认值。",
      "save.title": "待保存改动",
      "save.save": "保存全部改动",
      "save.discard": "放弃",
      "save.details": "看差异",
      "save.hideDetails": "收起差异",
      "save.undo": "撤销",
      "save.redo": "重做",
      "save.noChanges": "没有改动",
      "save.saving": "保存中…",
      "retry": "重试",
      "save": "保存",
      "saved": "已保存",
      "noChangeWritten": "服务端确认无需写盘",
      "loadFailed": "读不到闸门状态",
      "confirm.title": "请确认",
      "confirm.ok": "确认",
      "confirm.cancel": "取消",
      "health.session": "会话",
      "health.file": "文件",
      "health.readAt": "读取于",
      "toast.dismiss": "关闭提示",
      "error.title": "面板渲染出错",
      "error.stack": "错误栈",
      "error.diagnostics": "诊断信息",
      "error.viewMissing": "这个视图暂不可用",
      "error.viewMissingHint": "路由里的视图名不在闸门页签里；面板本身还能用，可以重试或回到能力页。",
      "error.backToCaps": "回到能力页",
      "error.copyDiagnostics": "复制诊断",
      "error.retry": "重试",
      "json.diff": "差异",
      "json.invalid": "JSON 不合法",
      "json.confirmTitle": "整份替换策略？",
    });
    /** 文案取值器：所有界面文案只经它读取常量表（缺键显性回显，不静默吞掉）。 */
    const text = (key) => (hasOwn(TEXT, key) ? TEXT[key] : String(key));

    /* =====================================================================
     * 2. 样式常量（命名分区，拼一份文本；只允许主题令牌）
     * 幂等注入的宿主节点由 data-dsh-gate 属性唯一确定。
     * ===================================================================== */
    const STYLE_ATTR = "data-dsh-gate";
    const STYLE_SECTIONS = Object.freeze([
      ["tokens", ".dshg-wrap{--dshg-bg:var(--dsw-alias-bg-base,#16181d);--dshg-layer1:var(--dsw-alias-bg-layer-1,#1d2027);--dshg-layer2:var(--dsw-alias-bg-layer-2,#23262e);--dshg-layer3:var(--dsw-alias-bg-layer-3,#2a2e37);--dshg-card:var(--dsw-alias-settings-card-fill,var(--dshg-layer1));--dshg-stroke:var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l1,#333845));--dshg-stroke2:var(--dsw-alias-border-l2,#2a2e37);--dshg-text:var(--dsw-alias-label-primary,#e6e8ee);--dshg-text2:var(--dsw-alias-label-secondary,#b6bbc7);--dshg-text3:var(--dsw-alias-label-tertiary,#8b919e);--dshg-accent:var(--dsw-alias-button-primary-fill,#4f8cff);--dshg-accentHover:var(--dsw-alias-button-primary-hover,#6a9dff);--dshg-hover:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));--dshg-active:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.1));--dshg-dangerHover:var(--dsw-alias-interactive-bg-hover-danger,rgba(255,107,107,.16));--dshg-focus:var(--dsw-focus-ring-color,#6a9dff);--dshg-ok:var(--dsw-alias-state-success-primary,#3ecf8e);--dshg-okSoft:var(--dsw-alias-state-success-secondary,rgba(62,207,142,.14));--dshg-warn:var(--dsw-alias-state-warn-primary,#f0b429);--dshg-warnSoft:var(--dsw-alias-state-warn-secondary,rgba(240,180,41,.16));--dshg-danger:var(--dsw-alias-state-error-primary,#ff6b6b);--dshg-dangerSoft:var(--dsw-alias-state-error-secondary,rgba(255,107,107,.14));--dshg-business:var(--dsw-alias-state-business-primary,#4f8cff);--dshg-businessSoft:var(--dsw-alias-state-business-secondary,rgba(79,140,255,.14));--dshg-tier-resident:var(--dshg-ok);--dshg-tier-ondemand:var(--dshg-business);--dshg-tier-off:var(--dsw-alias-label-secondary,#9aa0ae);--dshg-radiusLg:var(--dsw-radius-lg,12px);--dshg-radiusMd:var(--dsw-radius-md,8px);--dshg-radiusSm:var(--dsw-radius-sm,6px);--dshg-font:var(--dsw-font-family,system-ui,sans-serif);--dshg-mono:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Consolas,monospace);display:flex;flex-direction:column;gap:10px;padding:12px;color:var(--dshg-text);font-family:var(--dshg-font);font-size:12.5px;line-height:1.55;background:var(--dshg-bg)}"],
      ["shell", ".dshg-top{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--dshg-stroke);border-radius:var(--dshg-radiusLg);background:var(--dshg-card)}.dshg-chips{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.dshg-grow{flex:1 1 200px;min-width:0}.dshg-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.dshg-col{display:flex;flex-direction:column;gap:8px}.dshg-wraps{display:flex;gap:6px;flex-wrap:wrap}.dshg-foot{display:flex;gap:10px;align-items:center;flex-wrap:wrap;color:var(--dshg-text3);font-size:11.5px}.dshg-hint{color:var(--dshg-text2);font-size:11.5px;word-break:break-word}.dshg-note{color:var(--dshg-text3);font-size:11.5px}.dshg-mono{font-family:var(--dshg-mono);font-size:11.5px;white-space:pre-wrap;word-break:break-all;background:var(--dshg-layer2);border-radius:var(--dshg-radiusSm);padding:6px 8px;margin:0}.dshg-purpose{color:var(--dshg-text2);font-size:12px;padding:2px 2px 0}.dshg-section{border-top:1px dashed var(--dshg-stroke2);padding-top:8px;margin-top:2px}.dshg-subTitle{font-weight:600;font-size:12.5px;color:var(--dshg-text)}.dshg-wrap>div:empty{display:none}"],
      ["card", ".dshg-card{border:1px solid var(--dshg-stroke);border-radius:var(--dshg-radiusLg);background:var(--dshg-card);overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.12)}.dshg-cardHead{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid var(--dshg-stroke2)}.dshg-cardTitle{font-weight:650;font-size:13px}.dshg-cardBody{display:flex;flex-direction:column;gap:10px;padding:12px 14px}.dshg-corrupt{border-color:var(--dshg-danger)}.dshg-list{display:flex;flex-direction:column;gap:8px}.dshg-panel{display:flex;flex-direction:column;gap:10px;outline:none}.dshg-chip{display:inline-flex;gap:5px;align-items:center;padding:2px 9px;border-radius:999px;border:1px solid var(--dshg-stroke);background:var(--dshg-layer2);color:var(--dshg-text2);font-size:11.5px;white-space:nowrap}"],
      ["tabs", ".dshg-tabs{display:flex;gap:4px;align-items:center;padding:3px;border:1px solid var(--dshg-stroke);border-radius:var(--dshg-radiusMd);background:var(--dshg-layer2)}.dshg-tab{display:inline-flex;gap:6px;align-items:center;border:0;background:transparent;color:var(--dshg-text2);font:inherit;font-size:12.5px;padding:6px 12px;border-radius:var(--dshg-radiusSm);cursor:pointer;min-height:34px}.dshg-tab[aria-selected='true']{background:var(--dshg-card);color:var(--dshg-text);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.18)}.dshg-tabCount{color:var(--dshg-text3);font-size:11px}.dshg-tab:hover:not([aria-selected='true']){background:var(--dshg-hover);color:var(--dshg-text)}"],
      ["controls", ".dshg-btn{display:inline-flex;gap:6px;align-items:center;justify-content:center;border:1px solid var(--dshg-stroke);background:var(--dshg-layer2);color:var(--dshg-text);font:inherit;font-size:12px;padding:6px 11px;border-radius:var(--dshg-radiusSm);cursor:pointer;min-height:32px}.dshg-btn[data-primary='true']{background:var(--dshg-accent);border-color:transparent;color:#fff;font-weight:600}.dshg-btn[data-danger='true']{color:var(--dshg-danger);border-color:var(--dshg-dangerSoft)}.dshg-btn:disabled{opacity:.5;cursor:not-allowed}.dshg-btn:hover:not(:disabled){background:var(--dshg-hover)}.dshg-btn[data-primary='true']:hover:not(:disabled){background:var(--dshg-accentHover)}.dshg-btn[data-danger='true']:hover:not(:disabled){background:var(--dshg-dangerHover)}.dshg-input{flex:1 1 220px;min-width:0;min-height:32px;padding:6px 10px;border:1px solid var(--dshg-stroke);border-radius:var(--dshg-radiusSm);background:var(--dshg-layer1);color:var(--dshg-text);font:inherit;font-size:12px}.dshg-select{min-height:32px;padding:6px 8px;border:1px solid var(--dshg-stroke);border-radius:var(--dshg-radiusSm);background:var(--dshg-layer1);color:var(--dshg-text);font:inherit;font-size:12px}.dshg-json{width:100%;min-height:240px;padding:10px 12px;border:1px solid var(--dshg-stroke);border-radius:var(--dshg-radiusMd);background:var(--dshg-layer1);color:var(--dshg-text);font-family:var(--dshg-mono);font-size:11.5px;line-height:1.5;resize:vertical}.dshg-field{display:flex;flex-direction:column;gap:4px;flex:1 1 200px;min-width:0}.dshg-form{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start}.dshg-filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.dshg-filterBar{padding:10px 12px;border-radius:var(--dshg-radiusMd)}"],
      ["seg", ".dshg-seg{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--dshg-stroke);border-radius:var(--dshg-radiusSm);background:var(--dshg-layer1)}.dshg-seg button{border:0;background:transparent;color:var(--dshg-text2);font:inherit;font-size:11.5px;padding:4px 10px;border-radius:4px;cursor:pointer;min-height:26px}.dshg-seg button[aria-pressed='true']{font-weight:600;color:var(--dshg-text);background:var(--dshg-layer3)}.dshg-seg button[aria-pressed='true'][data-tier='1']{color:var(--dshg-tier-resident);background:var(--dshg-okSoft)}.dshg-seg button[aria-pressed='true'][data-tier='2']{color:var(--dshg-tier-ondemand);background:var(--dshg-businessSoft)}.dshg-seg button[aria-pressed='true'][data-tier='0']{color:var(--dshg-text);background:var(--dshg-layer3)}.dshg-seg button:hover:not([aria-pressed='true']){background:var(--dshg-hover);color:var(--dshg-text)}.dshg-seg button:hover:not([aria-pressed='true'])[data-tier='1']{color:var(--dshg-tier-resident)}.dshg-seg button:hover:not([aria-pressed='true'])[data-tier='2']{color:var(--dshg-tier-ondemand)}.dshg-seg button:hover:not([aria-pressed='true'])[data-tier='0']{color:var(--dshg-text)}"],
      ["switch", ".dshg-switch{display:inline-flex;gap:8px;align-items:center;border:0;background:transparent;color:var(--dshg-text);font:inherit;font-size:12px;padding:2px 4px;cursor:pointer;min-height:32px}.dshg-switch i{width:30px;height:18px;border-radius:999px;background:var(--dshg-layer3);border:1px solid var(--dshg-stroke);position:relative;flex:0 0 auto;transition:background .12s ease}.dshg-switch[aria-checked='true'] i{background:var(--dshg-accent);border-color:transparent}.dshg-switch[aria-checked='true'] i::after{content:'';position:absolute;top:2px;left:14px;width:12px;height:12px;border-radius:50%;background:#fff}.dshg-switch[aria-checked='false'] i::after{content:'';position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dshg-text3)}.dshg-switch:disabled{opacity:.5;cursor:not-allowed}"],
      ["groups", ".dshg-group{border:1px solid var(--dshg-stroke);border-radius:var(--dshg-radiusLg);background:var(--dshg-card);overflow:hidden}.dshg-subGroup{border:1px solid var(--dshg-stroke2);border-radius:var(--dshg-radiusMd);background:var(--dshg-layer1);overflow:hidden}.dshg-groupHeadWrap{display:flex;gap:8px;align-items:center;padding:4px 10px 4px 6px;background:var(--dshg-layer2)}.dshg-groupHead{display:flex;gap:8px;align-items:center;flex:1 1 auto;min-width:0;border:0;background:transparent;color:var(--dshg-text);font:inherit;font-size:12.5px;padding:8px 6px;text-align:left;cursor:pointer;min-height:40px}.dshg-groupCaret{color:var(--dshg-text3);width:12px;flex:0 0 auto}.dshg-groupName{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dshg-groupCount{color:var(--dshg-text3);font-size:11.5px;white-space:nowrap}.dshg-groupOps{display:flex;gap:6px;align-items:center;flex:0 0 auto}.dshg-groupBody{display:flex;flex-direction:column;gap:8px;padding:10px}.dshg-groupHead:hover{background:var(--dshg-hover);border-radius:var(--dshg-radiusSm)}"],
      ["rows", ".dshg-capRow{border:1px solid var(--dshg-stroke2);border-radius:var(--dshg-radiusMd);background:var(--dshg-layer1)}.dshg-capMain{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 12px;min-height:52px}.dshg-capId{font-family:var(--dshg-mono);font-size:12px;font-weight:600;word-break:break-all}.dshg-rowMeta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:3px}.dshg-detail{display:flex;flex-direction:column;gap:8px;padding:0 12px 12px;border-top:1px dashed var(--dshg-stroke2);margin-top:2px;padding-top:10px}.dshg-chain{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.dshg-step{padding:2px 8px;border-radius:999px;border:1px solid var(--dshg-stroke2);background:var(--dshg-layer2);color:var(--dshg-text3);font-size:11px}.dshg-memberRow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 8px;border-radius:var(--dshg-radiusSm);background:var(--dshg-layer2)}.dshg-memberName{font-family:var(--dshg-mono);font-size:11.5px;min-width:0;word-break:break-all}.dshg-importRow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 8px;border-radius:var(--dshg-radiusSm);background:var(--dshg-layer2)}"],
      ["badges", ".dshg-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;background:var(--dshg-layer3);color:var(--dshg-text2);font-size:11px;white-space:nowrap}.dshg-tag{display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;background:var(--dshg-layer3);color:var(--dshg-text2);font-size:11px;white-space:nowrap}.dshg-tag[data-tone='ok']{background:var(--dshg-okSoft);color:var(--dshg-ok)}.dshg-tag[data-tone='warn']{background:var(--dshg-warnSoft);color:var(--dshg-warn)}.dshg-tag[data-tone='error']{background:var(--dshg-dangerSoft);color:var(--dshg-danger)}.dshg-tag[data-tone='business']{background:var(--dshg-businessSoft);color:var(--dshg-business)}.dshg-tag[data-tone='muted']{background:var(--dshg-layer2);color:var(--dshg-text3)}.dshg-tag[data-tone='info']{background:var(--dshg-layer3);color:var(--dshg-text2)}.dshg-chip[data-tone='ok']{color:var(--dshg-ok);border-color:var(--dshg-okSoft)}.dshg-chip[data-tone='business']{color:var(--dshg-business);border-color:var(--dshg-businessSoft)}.dshg-chip[data-tone='muted']{color:var(--dshg-text3)}.dshg-chip[data-tone='warn']{color:var(--dshg-warn);border-color:var(--dshg-warnSoft)}"],
      ["feedback", ".dshg-alert{padding:8px 11px;border-radius:var(--dshg-radiusSm);border:1px solid var(--dshg-stroke);background:var(--dshg-layer2);color:var(--dshg-text2);font-size:12px}.dshg-alert[data-tone='error']{border-color:var(--dshg-dangerSoft);background:var(--dshg-dangerSoft);color:var(--dshg-danger)}.dshg-alert[data-tone='warn']{border-color:var(--dshg-warnSoft);background:var(--dshg-warnSoft);color:var(--dshg-warn)}.dshg-alert[data-tone='info']{border-color:var(--dshg-businessSoft);background:var(--dshg-businessSoft);color:var(--dshg-text)}.dshg-alert[data-tone='ok']{border-color:var(--dshg-okSoft);background:var(--dshg-okSoft);color:var(--dshg-ok)}.dshg-empty{padding:18px 12px;border:1px dashed var(--dshg-stroke2);border-radius:var(--dshg-radiusMd);color:var(--dshg-text3);font-size:12px;text-align:center}.dshg-skeleton{height:38px;border-radius:var(--dshg-radiusSm);background:linear-gradient(90deg,var(--dshg-layer2),var(--dshg-layer3),var(--dshg-layer2))}.dshg-toasts{display:flex;flex-direction:column;gap:6px}.dshg-toast{display:flex;gap:10px;align-items:center;padding:8px 10px;border-radius:var(--dshg-radiusSm);border:1px solid var(--dshg-stroke);background:var(--dshg-layer2);font-size:12px}.dshg-toast[data-tone='ok']{border-color:var(--dshg-okSoft)}.dshg-toast[data-tone='warn']{border-color:var(--dshg-warnSoft);color:var(--dshg-warn)}.dshg-toast[data-tone='error']{border-color:var(--dshg-dangerSoft);color:var(--dshg-danger)}.dshg-toastClose{margin-left:auto;min-height:24px;padding:0 8px}.dshg-confirm{position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:40;display:flex;flex-direction:column;gap:10px;width:min(560px,92vw);padding:14px;border:1px solid var(--dshg-stroke);border-radius:var(--dshg-radiusLg);background:var(--dshg-layer2);box-shadow:0 12px 32px rgba(0,0,0,.4)}.dshg-diff{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:var(--dshg-radiusSm);border:1px solid var(--dshg-stroke2);background:var(--dshg-layer2)}.dshg-diffRow{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;padding:2px 0;font-size:11.5px;color:var(--dshg-text2)}"],
      ["save", ".dshg-saveBar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--dshg-stroke);border-radius:var(--dshg-radiusLg);background:var(--dshg-layer2);position:sticky;bottom:0}.dshg-saveClean{border-style:dashed;padding:6px 10px}.dshg-saveTitle{font-weight:600;font-size:12.5px}"],
      ["a11y", ".dshg-wrap :focus-visible{outline:2px solid var(--dshg-focus);outline-offset:2px}.dshg-wrap [aria-busy='true']{cursor:progress}.dshg-wrap [hidden]{display:none !important}"],
      ["responsive", "@media (max-width:720px){.dshg-top{flex-wrap:wrap}.dshg-capMain{flex-wrap:wrap}.dshg-saveBar{flex-direction:column;align-items:stretch}.dshg-filters{flex-direction:column;align-items:stretch}.dshg-input,.dshg-select{flex-basis:100%;width:100%}.dshg-groupHeadWrap{flex-wrap:wrap}.dshg-groupOps{width:auto;margin-left:auto;justify-content:flex-end}.dshg-groupOps .dshg-select{width:auto;flex-basis:auto}.dshg-tabs{overflow-x:auto}.dshg-json{min-height:180px}.dshg-foot{flex-direction:column;align-items:flex-start}.dshg-confirm{width:92vw;top:8px}}"],
      ["motion", "@media (prefers-reduced-motion:reduce){.dshg-wrap *{transition:none !important;animation:none !important;scroll-behavior:auto !important}}"],
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
          if (field === "enabled") return content.enabled !== false;
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
        let enabled;
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
          else if (key === keys.defaults("enabled")) enabled = cell.value === true;
        }
        const removedOff = offRemoved();
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
          enabled: enabled,
          imports: importsDirty() ? importsSnapshot() : null,
          offRemoved: removedOff,
          offList: offOf(basePolicy()).filter((name) => removedOff.indexOf(name) < 0),
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
        if (snapshot.enabled !== undefined) content.enabled = snapshot.enabled === true;
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
        const readOnlyFields = ["revision", "corrupt", "path", "warnings", "ok", "error", "code", "generatedAt", "readAt", "mtimeMs", "size", "source"];
        for (let index = 0; index < readOnlyFields.length; index += 1) delete content[readOnlyFields[index]];
        return content;
      };

      const revisionOf = () => (state.baselineMeta && state.baselineMeta.revision !== undefined ? state.baselineMeta.revision : null);

      const withRevision = (body) => {
        const rev = revisionOf();
        if (rev !== null) body.expectedRevision = rev;
        return body;
      };
      const toPolicyBody = (options) => {
        const body = Object.assign(clone(toPolicy()), { replace: true, acknowledge: true }, options || {});
        if (body.expectedRevision === undefined && revisionOf() !== null) body.expectedRevision = revisionOf();
        return body;
      };
      const toSignatureBody = () => {
        const snapshot = signatureSnapshot();
        return withRevision({ catalog: { signatureSummary: { enabled: snapshot.enabled === true, tools: listOf(snapshot.tools) } } });
      };
      const toGuardBody = () => {
        const snapshot = policySnapshot();
        return withRevision({ repeatGuard: snapshot.guardrail });
      };
      const toCatalogBody = () => {
        const snapshot = policySnapshot();
        return withRevision({ catalog: snapshot.catalog });
      };

      const toSkillOperations = () => {
        const snapshot = policySnapshot();
        const operations = [];
        if (snapshot.imports !== null) operations.push({ action: "imports", imports: snapshot.imports.map((item) => (item.id ? { id: item.id, path: item.path } : { path: item.path })), key: snapshot.summary.keys.filter((key) => String(key).indexOf(PREFIX.imp) === 0)[0] });
        if (snapshot.takeover !== undefined) operations.push({ action: "takeover", value: snapshot.takeover === true, key: keys.defaults("takeover") });
        const names = Object.keys(snapshot.skills);
        for (let index = 0; index < names.length; index += 1) operations.push({ action: "tier", name: names[index], tier: snapshot.skills[names[index]], key: keys.skill(names[index]) });
        if (snapshot.offRemoved.length > 0) operations.push({ action: "off", off: snapshot.offList.slice(), key: keys.close(snapshot.offRemoved[0]) });
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

        const nativeClusterOf = (row) => {
          const raw = String(row.id || "").toLowerCase().replace(/^native:/, "");
          if (/^(read|write|edit|glob|grep|file|notebook|image|patch|diff)/.test(raw) || /read_image/.test(raw)) return { key: "files", label: "文件与检索", order: 0 };
          if (/^(bash|pwsh|shell|exec|terminal|user_terminal|job|working_directory|run_code|process|pty)/.test(raw)) return { key: "exec", label: "命令与终端", order: 1 };
          if (/^(web|fetch|search|http|ssh|remote|weather|video|domain|platform|research|cache_search|multi_search|advanced_search|free_search|url)/.test(raw)) return { key: "net", label: "网络与远程", order: 2 };
          if (/^(subagent|agent|team|goal|todo|ask_user|schedule|plan|ralph|present|suggest|propose|session|compress|decompress|acp|wait_agent|send_message|list_agent|worktree|validate_dsh_ui|render_ui)/.test(raw)) return { key: "agent", label: "代理与会话", order: 3 };
          return { key: "other", label: "其它内置", order: 4 };
        };

        const groups = [];
        const buckets = {};
        for (let index = 0; index < filtered.length; index += 1) {
          const row = filtered[index];
          if (!buckets[row.kind]) { buckets[row.kind] = []; groups.push({ kind: row.kind, label: KIND_LABEL[row.kind] || row.kind, rows: buckets[row.kind], subgroups: [] }); }
          buckets[row.kind].push(row);
        }
        groups.sort((left, right) => (KIND_ORDER[left.kind] === undefined ? 9 : KIND_ORDER[left.kind]) - (KIND_ORDER[right.kind] === undefined ? 9 : KIND_ORDER[right.kind]));
        for (let index = 0; index < groups.length; index += 1) {
          if (groups[index].kind !== "native") continue;
          const subMap = {};
          const subList = [];
          for (let cursor = 0; cursor < groups[index].rows.length; cursor += 1) {
            const row = groups[index].rows[cursor];
            const cluster = nativeClusterOf(row);
            if (!subMap[cluster.key]) { subMap[cluster.key] = { key: cluster.key, label: cluster.label, order: cluster.order, rows: [] }; subList.push(subMap[cluster.key]); }
            subMap[cluster.key].rows.push(row);
          }
          subList.sort((left, right) => left.order - right.order);
          groups[index].subgroups = subList;
        }

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
      const WRITE_ACTIONS = Object.freeze(["reload", "switch-session", "replace-json", "save-policy", "save-skills", "save-signature", "save-all", "mcp", "toggle-enabled"]);
      const DISCARD_CONFIRM_ACTIONS = Object.freeze(["reload", "switch-session", "replace-json"]);
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

      const activeCeilingTimers = [];
      const withCeiling = (promise, ms, roundId, marker) => new Promise((resolve) => {
        let done = false;
        let timer = null;
        const finish = (value, timedOut) => {
          if (done) return;
          done = true;
          if (timer !== null) {
            const idx = activeCeilingTimers.indexOf(timer);
            if (idx >= 0) activeCeilingTimers.splice(idx, 1);
            if (unschedule) unschedule(timer);
          }
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
        if (schedule) {
          timer = schedule(() => finish(null, true), Math.max(1, ms));
          activeCeilingTimers.push(timer);
        }
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
        const isDiscardAction = DISCARD_CONFIRM_ACTIONS.indexOf(action) >= 0;
        const needsConfirm = total > 0 && isDiscardAction;
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
        const agentIds = isObject(runtime.agents) && Array.isArray(runtime.agents.ids) ? runtime.agents.ids : null;
        const rows = agentIds && agentIds.length > 0
          ? agentIds
          : (Array.isArray(body.sessions) ? body.sessions : (Array.isArray(runtime.sessions) ? runtime.sessions : []));
        return {
          ok: true,
          error: "",
          sessions: rows.map((item, index) => {
            if (typeof item === "string" && item.length > 0) return { id: item, label: item, source: "panel" };
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

      const savePolicy = (body) => write({ path: "/api/dsh-gate/policy", action: "policy", body: body, queueKey: "policy:" + (body && (body.expectedRevision || body.revision)) });
      const saveSignature = (body) => write({ path: "/api/dsh-gate/policy", action: "signature", body: body, queueKey: "signature" });
      const saveGuard = (body) => write({ path: "/api/dsh-gate/policy", action: "guardrail", body: body, queueKey: "guardrail" });
      const saveCatalog = (body) => write({ path: "/api/dsh-gate/policy", action: "catalog", body: body, queueKey: "catalog" });
      const toggleEnabled = (nextEnabled) => {
        const body = { enabled: Boolean(nextEnabled) };
        if (lastRevision !== null) body.expectedRevision = lastRevision;
        return write({ path: "/api/dsh-gate/policy", action: "toggle-enabled", body: body, queueKey: "toggle-enabled" });
      };
      const recoverCorruptPolicy = (template) => {
        const body = Object.assign(clone(isObject(template) ? template : fallbackTemplate()), {
          replace: true,
          acknowledge: true,
          replaceCorrupt: true,
          forceOverwriteCorrupt: true,
        });
        return write({ path: "/api/dsh-gate/policy", action: "recover-corrupt", body: body, queueKey: "recover-corrupt" });
      };
      const mcpMutate = (payload) => write({ path: "/api/dsh-gate/mcp", action: "mcp", body: payload, queueKey: "mcp:" + String(payload && payload.action || "") + ":" + String(payload && payload.name || "") });

      const dispose = () => {
        disposed = true;
        while (activeCeilingTimers.length > 0) {
          const t = activeCeilingTimers.pop();
          if (t !== null && unschedule) unschedule(t);
        }
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
        toggleEnabled: toggleEnabled,
        recoverCorruptPolicy: recoverCorruptPolicy,
        mcpMutate: mcpMutate,
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
              const mergedLifetime = lifetimeOf(tone);
              const merged = Object.assign({}, items[index], { text: String(entry.text === undefined ? items[index].text : entry.text), tone: tone, count: (items[index].count || 1) + 1, lifetime: mergedLifetime, expiresAt: mergedLifetime > 0 ? Date.now() + mergedLifetime : 0 });
              items = items.slice();
              items[index] = merged;
              return merged;
            }
            const nextLifetime = lifetimeOf(tone);
            const next = { key: key, tone: tone, text: String(entry.text === undefined ? "" : entry.text), count: 1, lifetime: nextLifetime, expiresAt: nextLifetime > 0 ? Date.now() + nextLifetime : 0 };
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
        if (state === "empty") return h("div", { key: key, className: "dshg-empty" }, value.message || text("common.none"));
        if (state === "partial") {
          return h("div", { key: key, className: "dshg-col" }, [
            h("div", { key: "banner", className: "dshg-alert", "data-tone": "warn", role: "status" }, value.message || text("common.error")),
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
          "data-tier": option.tier === undefined || option.tier === null ? undefined : String(option.tier),
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
          h("button", {
            key: "close",
            type: "button",
            className: "dshg-btn dshg-toastClose",
            "aria-label": text("toast.dismiss"),
            title: text("toast.dismiss"),
            onClick: () => value.onDismiss(item.key),
          }, "×"),
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
            h("span", { key: "hint", className: "dshg-hint" }, String(value.message || "")),
          ]),
          h("div", { key: "body", className: "dshg-cardBody" }, [
            h("div", { key: "summary", className: "dshg-alert", "data-tone": "error", role: "alert" }, String(value.summary || value.message || text("error.title"))),
            lines.length > 0 ? h("div", { key: "stack", className: "dshg-col" }, [
              h("div", { key: "label", className: "dshg-hint" }, text("error.stack")),
              h("pre", { key: "pre", className: "dshg-mono" }, lines.join(newline)),
            ]) : null,
            h("div", { key: "actions", className: "dshg-row" }, [
              typeof value.onRetry === "function" ? h("button", { key: "retry", type: "button", className: "dshg-btn", onClick: value.onRetry }, text("retry")) : null,
              typeof value.onCopy === "function" ? h("button", { key: "copy", type: "button", className: "dshg-btn", onClick: value.onCopy }, text("error.copyDiagnostics")) : null,
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
     * L6 · 页签视图（宽松卡片风：一页一用途，展示与事件上抛）
     * 四页签：能力 / 技能 / MCP / 高级（原 JSON 编辑器并入高级页）
     * ===================================================================== */
    function createL6Views(deps) {
      const env = deps || {};
      const h = env.h;
      const text = typeof env.text === "function" ? env.text : (key) => key;
      const primitives = env.primitives;

      const card = (key, title, children, headExtra) => {
        const head = [h("span", { key: "title", className: "dshg-cardTitle" }, String(title))];
        if (Array.isArray(headExtra)) head.push.apply(head, headExtra);
        else if (headExtra !== undefined && headExtra !== null && headExtra !== false) head.push(headExtra);
        return h("div", { key: key, className: "dshg-card" }, [
          h("div", { key: "head", className: "dshg-cardHead" }, head),
          h("div", { key: "body", className: "dshg-cardBody" }, children),
        ]);
      };
      const purpose = (key, content) => h("div", { key: key, className: "dshg-purpose" }, content);
      const hint = (key, content) => h("div", { key: key, className: "dshg-hint" }, content);
      const tag = (key, label, tone) => h("span", { key: key, className: "dshg-tag", "data-tone": tone }, String(label));
      const alert = (key, content, tone) => h("div", { key: key, className: "dshg-alert", "data-tone": tone || "info", role: tone === "error" ? "alert" : "status" }, content);
      const button = (key, label, onClick, options) => {
        const opts = options || {};
        return h("button", {
          key: key,
          type: "button",
          className: "dshg-btn",
          "data-primary": opts.primary === true ? "true" : undefined,
          "data-danger": opts.danger === true ? "true" : undefined,
          disabled: opts.disabled === true,
          title: opts.reason || opts.title || "",
          onClick: opts.disabled === true ? undefined : onClick,
        }, String(label));
      };
      const tierOptions = () => [
        { value: TIER_RESIDENT, tier: TIER_RESIDENT, label: text("tier.resident"), title: text("tier.residentHint") },
        { value: TIER_ONDEMAND, tier: TIER_ONDEMAND, label: text("tier.ondemand"), title: text("tier.ondemandHint") },
        { value: TIER_OFF, tier: TIER_OFF, label: text("tier.off"), title: text("tier.offHint") },
      ];
      const tierLabel = (tier) => (TIER_LABEL[tier] === undefined ? text("common.none") : TIER_LABEL[tier]);
      const purposeOf = (key, key2) => purpose(key, text(key2));
      const statePanel = (key, purposeNode, stateNode) => h("div", { key: key, className: "dshg-col" }, [purposeNode, stateNode]);
      const tierTag = (key, tier) => tag(key, tierLabel(tier), tier === TIER_RESIDENT ? "ok" : (tier === TIER_ONDEMAND ? "business" : "muted"));

      // ---- 能力行（宽松卡片行：名称 + 标记 + 层色标 + 展开详情） ----
      const renderRow = (props, row) => {
        const view = props.view;
        const expanded = view.expanded[row.id] === true;
        const disabled = row.blocking === true || row.readonlyService === true;
        const markers = [];
        if (row.synthetic === true) markers.push(tag("m:synthetic", text("caps.synthetic"), "info"));
        if (row.merged === true) markers.push(tag("m:merged", text("caps.merged")));
        if (row.managed === true) markers.push(tag("m:managed", text("caps.managed"), "info"));
        if (row.readonlyService === true) markers.push(tag("m:readonly", text("caps.readonly"), "warn"));
        if (row.draftTier !== null && row.draftTier !== undefined) markers.push(tag("m:pending", text("caps.pending"), "warn"));
        if (row.exceptionCount > 0) markers.push(tag("m:exc", text("caps.exception") + " " + String(row.exceptionCount), "warn"));
        if (row.deviations.length > 0) markers.push(tag("m:dev", text("caps.deviations") + " " + String(row.deviations.length), "error"));
        if (row.upstreamHidden.length > 0) markers.push(tag("m:up", text("caps.upstream") + " " + String(row.upstreamHidden.length), "warn"));
        if (row.blocking === true) markers.push(tag("m:blocked", text("caps.blocked"), "error"));
        const chainSteps = [h("span", { key: "label", className: "dshg-hint" }, text("caps.chainTitle"))];
        for (let index = 0; index < row.chain.steps.length; index += 1) {
          const step = row.chain.steps[index];
          chainSteps.push(h("span", { key: "step:" + step.key, className: "dshg-step", "data-hit": step.hit === true ? "true" : "false", "data-winner": step.winner === true ? "true" : "false" }, step.label + (step.count > 0 ? " " + String(step.count) : "") + (step.winner === true ? " · " + text("caps.winner") : "")));
        }
        const memberNodes = row.members.all.length === 0
          ? hint("noMembers", text("caps.memberEmpty"))
          : h("div", { key: "members", className: "dshg-col" }, row.members.all.map((member) => h("div", { key: "mem:" + member.kind + ":" + member.name, className: "dshg-memberRow" }, [
            h("span", { key: "name", className: "dshg-memberName", title: member.name }, member.name),
            tierTag("tier", member.tier),
            h("span", { key: "reason", className: "dshg-hint" }, member.reason),
            h("span", { key: "conf", className: "dshg-hint" }, text("caps.confidence") + " " + String(member.confidence)),
            h("select", {
              key: "exc",
              className: "dshg-select",
              "aria-label": text("caps.exception") + " " + member.name,
              disabled: member.takenOver === true,
              title: member.takenOver === true ? text("caps.managed") : text("caps.exception"),
              value: member.exception && member.exception.tier !== undefined && member.exception.tier !== null ? String(member.exception.tier) : "",
              onChange: (event) => props.actions.stageException(row.id, member.kind, member.name, event.target.value === "" ? null : Number(event.target.value)),
            }, [
              h("option", { key: "follow", value: "" }, text("caps.memberTier")),
              h("option", { key: "1", value: "1" }, text("tier.resident")),
              h("option", { key: "2", value: "2" }, text("tier.ondemand")),
              h("option", { key: "0", value: "0" }, text("tier.off")),
            ]),
          ])));
        const detail = expanded ? h("div", { key: "detail", className: "dshg-detail" }, [
          h("div", { key: "chain", className: "dshg-chain" }, chainSteps),
          hint("chainText", row.chain.text || text("caps.chainNone")),
          row.chain.winnerLabel ? hint("winner", text("caps.winner") + "：" + row.chain.winnerLabel) : null,
          h("div", { key: "counts", className: "dshg-row" }, [
            hint("tools", text("caps.tools") + " " + String(row.members.tools.length)),
            hint("sections", text("caps.sections") + " " + String(row.members.sections.length)),
            hint("tier", text("tier.label") + " " + tierLabel(row.effectiveTier)),
          ]),
          memberNodes,
          row.invalidReason ? alert("invalid", String(row.invalidReason), "error") : null,
          row.warnings.length > 0 ? h("div", { key: "warnings", className: "dshg-col" }, row.warnings.map((item, index) => alert("w:" + index, String(item), "warn"))) : null,
        ]) : null;
        const kindLabel = props.model && props.model.labels && props.model.labels.kinds && props.model.labels.kinds[row.kind] ? props.model.labels.kinds[row.kind] : row.kind;
        return h("div", { key: "row:" + row.id, className: "dshg-capRow" }, [
          h("div", { key: "main", className: "dshg-capMain" }, [
            h("span", { key: "badge", className: "dshg-badge", "data-kind": row.kind }, String(kindLabel)),
            h("div", { key: "grow", className: "dshg-grow" }, [
              h("div", { key: "id", className: "dshg-capId", title: row.id }, row.id),
              h("div", { key: "meta", className: "dshg-rowMeta" }, markers.concat([
                hint("mc", String(row.memberCount) + " " + text("caps.member")),
                hint("conf", text("caps.confidence") + " " + String(row.confidence)),
                primitives.tierBar({ key: "tb", saved: row.savedTier, draft: row.draftTier, effective: row.effectiveTier }),
              ])),
            ]),
            primitives.segmented({
              key: "seg:" + row.id,
              ariaLabel: text("tier.label") + " · " + row.id,
              value: row.effectiveTier,
              options: tierOptions(),
              disabled: disabled,
              reason: row.readonlyService === true ? text("caps.readonly") : text("caps.blocked"),
              onSelect: (tier) => props.actions.stageCap(row, tier),
            }),
            button("why:" + row.id, expanded ? text("caps.collapse") : text("caps.expand"), () => props.actions.toggleRow(row.id), { title: text("caps.why") }),
          ]),
          detail,
        ]);
      };

      const renderSubgroup = (props, group, sub, searching) => {
        const id = "caps:" + group.kind + ":" + sub.key;
        const open = props.view.openGroups[id] === undefined ? searching : props.view.openGroups[id] === true;
        return h("div", { key: id, className: "dshg-subGroup" }, [
          h("div", { key: "wrap", className: "dshg-groupHeadWrap" }, [
            primitives.groupHead({ key: "head", id: id, label: sub.label, count: sub.rows.length, open: open, onToggle: () => props.actions.toggleGroup(id, searching) }),
          ]),
          primitives.groupBody({ key: "body", id: id, label: sub.label, open: open, children: sub.rows.map((row) => renderRow(props, row)) }),
        ]);
      };

      const renderGroup = (props, group, searching) => {
        const id = "caps:" + group.kind;
        const open = props.view.openGroups[id] === undefined ? searching : props.view.openGroups[id] === true;
        const ops = h("div", { key: "ops", className: "dshg-groupOps" }, [
          h("select", {
            key: "batch",
            className: "dshg-select",
            "aria-label": group.label + " · " + text("caps.groupSet"),
            title: text("caps.groupSetHint"),
            value: "",
            onChange: (event) => {
              const raw = event && event.target ? event.target.value : "";
              if (raw === "") return;
              props.actions.requestGroupBatch(group.kind, Number(raw));
            },
          }, [
            h("option", { key: "none", value: "" }, text("caps.groupSet")),
            h("option", { key: "1", value: "1" }, text("tier.resident")),
            h("option", { key: "2", value: "2" }, text("tier.ondemand")),
            h("option", { key: "0", value: "0" }, text("tier.off")),
          ]),
        ]);
        const children = group.subgroups && group.subgroups.length > 0
          ? group.subgroups.map((sub) => renderSubgroup(props, group, sub, searching))
          : group.rows.map((row) => renderRow(props, row));
        return h("div", { key: id, className: "dshg-group" }, [
          h("div", { key: "wrap", className: "dshg-groupHeadWrap" }, [
            primitives.groupHead({ key: "head", id: id, label: group.label, count: group.rows.length, open: open, onToggle: () => props.actions.toggleGroup(id, searching) }),
            ops,
          ]),
          primitives.groupBody({ key: "body", id: id, label: group.label, open: open, children: children }),
        ]);
      };

      const renderCaps = (props) => {
        const model = props.model;
        const purposeNode = purpose("caps:purpose", text("purpose.caps"));
        if (!model) {
          return statePanel("caps", purposeNode, primitives.stateContainer({ key: "caps:loading", state: "loading", rows: 5 }));
        }
        const view = props.view;
        const searching = String(view.query || "").trim().length > 0 || view.sourceFilter !== "all" || view.statusFilter !== "all";
        const filterValues = [];
        if (model.labels && model.labels.kinds) {
          const kinds = Object.keys(model.labels.kinds);
          for (let index = 0; index < kinds.length; index += 1) filterValues.push({ value: kinds[index], label: model.labels.kinds[kinds[index]] });
        }
        const filters = h("div", { key: "caps:filters", className: "dshg-card dshg-filterBar" }, [
          h("div", { key: "row", className: "dshg-filters" }, [
            h("input", {
              key: "query",
              className: "dshg-input",
              type: "search",
              "aria-label": text("caps.search"),
              placeholder: text("caps.search"),
              value: view.query,
              onChange: (event) => props.actions.setView({ query: event.target.value }),
            }),
            h("select", { key: "source", className: "dshg-select", "aria-label": text("caps.filterSource"), title: text("caps.filterSource"), value: view.sourceFilter, onChange: (event) => props.actions.setView({ sourceFilter: event.target.value }) },
              [{ value: "all", label: text("caps.all") }].concat(filterValues).map((option) => h("option", { key: option.value, value: option.value }, option.label))),
            h("select", { key: "status", className: "dshg-select", "aria-label": text("caps.filterStatus"), title: text("caps.filterStatus"), value: view.statusFilter, onChange: (event) => props.actions.setView({ statusFilter: event.target.value }) }, [
              h("option", { key: "all", value: "all" }, text("caps.all")),
              h("option", { key: "r", value: "1" }, text("tier.resident")),
              h("option", { key: "o", value: "2" }, text("tier.ondemand")),
              h("option", { key: "f", value: "0" }, text("tier.off")),
              h("option", { key: "exc", value: "exception" }, text("caps.exception")),
              h("option", { key: "pending", value: "pending" }, text("caps.pending")),
            ]),
            button("clear", text("caps.clearFilter"), () => props.actions.setView({ query: "", sourceFilter: "all", statusFilter: "all" }), { disabled: searching !== true }),
            hint("count", text("caps.filtered") + " " + String(model.filtered.length) + " / " + String(model.stats.rows) + " " + text("common.count")),
          ]),
        ]);
        const complaints = model.complaints.length === 0 ? null : card("caps:complaints", text("caps.deviations") + " · " + text("caps.warnings") + "（" + String(model.complaints.length) + "）",
          model.complaints.slice(0, 10).map((item, index) => alert("c:" + index, String(item.path) + "：" + String(item.message), "warn")));
        const groups = model.groups.map((group) => renderGroup(props, group, searching));
        const listNode = model.filtered.length === 0
          ? primitives.stateContainer({ key: "caps:empty", state: "empty", message: text("caps.empty") })
          : h("div", { key: "caps:list", className: "dshg-list" }, groups);
        return h("div", { key: "caps", className: "dshg-col" }, [purposeNode, filters, complaints, listNode].filter(Boolean));
      };

      // ---- 技能页 ----
      const renderSkills = (props) => {
        const snapshot = props.snapshot;
        const status = snapshot.status.skills;
        const payload = snapshot.data.skills;
        const purposeNode = purpose("skills:purpose", text("purpose.skills"));
        if (status === "loading" && !payload) {
          return statePanel("skills", purposeNode, primitives.stateContainer({ key: "skills:loading", state: "loading", rows: 4 }));
        }
        if (status === "error" && !payload) {
          return statePanel("skills", purposeNode, primitives.stateContainer({
            key: "skills:error",
            state: "error",
            message: text("common.error") + "：" + String(snapshot.errors.skills === undefined ? text("common.none") : snapshot.errors.skills),
            onRetry: () => props.actions.reload(),
          }));
        }
        const draft = props.draft;
        const view = props.view;
        const skills = listOf(payload && payload.skills).filter((row) => isObject(row) && typeof row.name === "string");
        const query = String(view.skillQuery || "").trim().toLowerCase();
        const filtered = skills.filter((row) => {
          if (query.length === 0) return true;
          const haystack = [row.name, row.provider, row.path, row.description].filter((value) => typeof value === "string").join(" ").toLowerCase();
          return haystack.indexOf(query) >= 0;
        });
        const takeoverBase = !(payload && payload.takeover === false);
        const takeover = draft.takeover === undefined ? takeoverBase : draft.takeover === true;
        const relayBase = isObject(payload && payload.activationRelay) ? payload.activationRelay.enabled === true : Boolean(payload && payload.activationRelay === true);
        const relay = draft.catalog.activationRelay === undefined ? relayBase : draft.catalog.activationRelay === true;
        const promoteBase = isObject(payload && payload.activationPromote) ? payload.activationPromote.enabled === true : Boolean(payload && payload.activationPromote === true);
        const promote = draft.catalog.activationPromote === undefined ? promoteBase : draft.catalog.activationPromote === true;
        const buckets = {};
        const providers = [];
        for (let index = 0; index < filtered.length; index += 1) {
          const row = filtered[index];
          const name = String(row.provider || text("skills.providers"));
          if (!buckets[name]) { buckets[name] = []; providers.push(name); }
          buckets[name].push(row);
        }
        providers.sort((left, right) => buckets[right].length - buckets[left].length || (left < right ? -1 : 1));
        const searching = query.length > 0;
        const groupNodes = providers.map((name) => {
          const id = "skills:" + name;
          const open = view.openGroups[id] === undefined ? searching : view.openGroups[id] === true;
          return h("div", { key: id, className: "dshg-group" }, [
            h("div", { key: "wrap", className: "dshg-groupHeadWrap" }, [
              primitives.groupHead({ key: "head", id: id, label: name, count: buckets[name].length, open: open, onToggle: () => props.actions.toggleGroup(id, searching) }),
            ]),
            primitives.groupBody({ key: "body", id: id, label: name, open: open, children: buckets[name].map((row) => {
              const tier = hasOwn(draft.skills, row.name) ? draft.skills[row.name] : (row.tier === undefined || row.tier === null ? TIER_ONDEMAND : row.tier);
              return h("div", { key: "skill:" + row.name, className: "dshg-capRow" }, [
                h("div", { key: "main", className: "dshg-capMain" }, [
                  h("div", { key: "grow", className: "dshg-grow" }, [
                    h("div", { key: "id", className: "dshg-capId", title: row.name }, row.name),
                    h("div", { key: "meta", className: "dshg-rowMeta" }, [
                      hint("prov", String(row.provider || text("common.none"))),
                      typeof row.path === "string" && row.path.length > 0 ? hint("path", row.path) : null,
                      row.shadowed === true ? tag("shadowed", text("skills.shadowed"), "warn") : null,
                    ]),
                  ]),
                  primitives.segmented({ key: "seg:" + row.name, ariaLabel: text("tier.label") + " · " + row.name, value: tier, options: tierOptions(), onSelect: (next) => props.actions.stageSkill(row.name, next) }),
                ]),
              ]);
            }) }),
          ]);
        });
        const takeoverCard = card("skills:takeover", text("skills.takeoverTitle"), [
          h("div", { key: "switches", className: "dshg-row" }, [
            primitives.switchButton({ key: "takeover", on: takeover, label: text("skills.takeover"), onToggle: () => props.actions.stageTakeover(!takeover) }),
            primitives.switchButton({ key: "relay", on: relay, label: text("skills.relay"), disabled: !takeover, reason: text("skills.takeoverHint"), onToggle: () => props.actions.stageCatalog("activationRelay", !relay) }),
            primitives.switchButton({ key: "promote", on: promote, label: text("skills.promote"), disabled: !relay, reason: text("skills.takeoverHint"), onToggle: () => props.actions.stageCatalog("activationPromote", !promote) }),
          ]),
          hint("hint", text("skills.takeoverHint")),
        ]);
        const searchCard = card("skills:search", text("skills.title") + "（" + String(filtered.length) + " / " + String(skills.length) + "）", [
          h("div", { key: "row", className: "dshg-filters" }, [
            h("input", { key: "q", className: "dshg-input", type: "search", "aria-label": text("skills.search"), placeholder: text("skills.search"), value: view.skillQuery, onChange: (event) => props.actions.setView({ skillQuery: event.target.value }) }),
            button("clear", text("caps.clearFilter"), () => props.actions.setView({ skillQuery: "" }), { disabled: String(view.skillQuery || "").length === 0 }),
            hint("hint", text("skills.searchEmpty")),
          ]),
          filtered.length === 0
            ? primitives.stateContainer({ key: "empty", state: "empty", message: text("skills.empty") })
            : h("div", { key: "groups", className: "dshg-list" }, groupNodes),
        ]);
        const imports = draft.imports === null ? listOf(payload && payload.imports) : draft.imports;
        const importsCard = card("skills:imports", text("skills.importsTitle"), [
          h("div", { key: "row", className: "dshg-filters" }, [
            h("input", { key: "p", className: "dshg-input", "aria-label": text("skills.importPlaceholder"), placeholder: text("skills.importPlaceholder"), value: view.importDraft, onChange: (event) => props.actions.setView({ importDraft: event.target.value }) }),
            button("add", text("skills.importAdd"), () => {
              const value = String(view.importDraft || "").trim();
              if (value.length === 0) return;
              props.actions.addImport(value);
              props.actions.setView({ importDraft: "" });
            }, { disabled: String(view.importDraft || "").trim().length === 0 }),
          ]),
          hint("hint", text("skills.importsHint")),
          imports.length === 0
            ? hint("empty", text("skills.importEmpty"))
            : h("div", { key: "list", className: "dshg-col" }, imports.map((item, index) => h("div", { key: "imp:" + String(item) + ":" + index, className: "dshg-importRow" }, [
              h("span", { key: "p", className: "dshg-grow", title: String(item) }, String(item)),
              button("rm", text("skills.importRemove"), () => props.actions.removeImport(String(item))),
            ]))),
        ]);
        const offList = listOf(payload && payload.off).filter((name) => typeof name === "string");
        const offCard = offList.length === 0 ? null : card("skills:off", text("skills.offTitle") + "（" + String(offList.length) + "）", [
          hint("hint", text("skills.offHint")),
          h("div", { key: "list", className: "dshg-col" }, offList.map((name) => h("div", { key: "off:" + name, className: "dshg-importRow" }, [
            h("span", { key: "n", className: "dshg-grow" }, name),
            button("rm", text("skills.importRemove"), () => props.actions.removeOff(name)),
          ]))),
          button("clear", text("skills.offClear"), () => props.actions.clearOff(), { danger: true }),
        ]);
        const warnings = listOf(payload && payload.warnings).map(warningText).concat(snapshot.warnings);
        const warningsCard = warnings.length === 0 ? null : card("skills:warnings", text("caps.warnings") + "（" + String(warnings.length) + "）",
          warnings.slice(0, 8).map((item, index) => alert("w:" + index, String(item), "warn")));
        const prescan = isObject(payload && payload.prescan) ? payload.prescan : null;
        const prescanNode = prescan && prescan.active === true ? alert("prescan", text("skills.takeoverHint"), "info") : null;
        return h("div", { key: "skills", className: "dshg-col" }, [purposeNode, takeoverCard, prescanNode, searchCard, importsCard, offCard, warningsCard].filter(Boolean));
      };

      // ---- MCP 页（即时生效，不走吸底保存栏） ----
      const renderMcp = (props) => {
        const snapshot = props.snapshot;
        const status = snapshot.status.mcp;
        const payload = snapshot.data.mcp;
        const purposeNode = purpose("mcp:purpose", text("purpose.mcp"));
        if (status === "loading" && !payload) {
          return statePanel("mcp", purposeNode, primitives.stateContainer({ key: "mcp:loading", state: "loading", rows: 3 }));
        }
        if (status === "error" && !payload) {
          return statePanel("mcp", purposeNode, primitives.stateContainer({
            key: "mcp:error",
            state: "error",
            message: text("common.error") + "：" + String(snapshot.errors.mcp === undefined ? text("common.none") : snapshot.errors.mcp),
            onRetry: () => props.actions.reload(),
          }));
        }
        const view = props.view;
        const policyContent = isObject(props.snapshot.data.policy) && isObject(props.snapshot.data.policy.content) ? props.snapshot.data.policy.content : {};
        const policyServers = isObject(policyContent.mcp) && isObject(policyContent.mcp.servers) ? policyContent.mcp.servers : {};
        const writable = !(payload && payload.writable === false);
        const servers = listOf(payload && payload.servers).filter((row) => isObject(row) && typeof row.name === "string");
        const draft = view.mcpDraft;
        const editing = String(view.mcpEditing || "");
        const formOpen = view.mcpAddOpen === true || editing.length > 0;
        const serverRows = servers.map((row) => {
          const stateTone = row.state === "owned" ? "ok" : (row.state === "stopped" ? "warn" : "error");
          return h("div", { key: "mcp:" + row.name, className: "dshg-capRow" }, [
            h("div", { key: "main", className: "dshg-capMain" }, [
              h("div", { key: "grow", className: "dshg-grow" }, [
                h("div", { key: "id", className: "dshg-capId", title: row.name }, row.name),
                h("div", { key: "meta", className: "dshg-rowMeta" }, [
                  tag("state", text("mcp.state") + " " + String(row.state === undefined ? text("common.none") : row.state), stateTone),
                  hint("transport", String(row.transport === undefined ? text("common.none") : row.transport)),
                  hint("target", String(row.target === undefined ? "" : row.target)),
                  hint("tools", text("mcp.tools") + " " + String(row.toolCount === undefined || row.toolCount === null ? text("mcp.noTools") : row.toolCount)),
                ]),
              ]),
              primitives.switchButton({
                key: "sw",
                on: row.enabled === true,
                label: text("mcp.enable"),
                disabled: writable !== true,
                reason: text("mcp.writable"),
                onToggle: () => props.actions.mcpAction(row.enabled === true ? "disable" : "enable", row.name),
              }),
              button("edit", text("mcp.edit"), () => {
                const stored = isObject(policyServers[row.name]) ? policyServers[row.name] : null;
                const source = isObject(row.server) ? row.server : (stored === null ? row : stored);
                const stdio = row.transport === "stdio";
                const rawCommand = isObject(source) && typeof source.command === "string" ? source.command : (stdio ? String(row.target || "") : "");
                const rawUrl = isObject(source) && typeof source.url === "string" ? source.url : (stdio ? "" : String(row.target || ""));
                const rawArgs = isObject(source) && Array.isArray(source.args) ? source.args.join(" ") : "";
                props.actions.setMcpDraft({
                  name: row.name,
                  transport: stdio ? "stdio" : "streamable-http",
                  url: stdio ? "" : rawUrl,
                  command: stdio ? rawCommand : "",
                  args: stdio ? rawArgs : "",
                  rawServer: clone(source),
                });
                props.actions.setView({ mcpEditing: row.name, mcpAddOpen: true });
              }, { disabled: writable !== true, reason: text("mcp.writable") }),
              button("rm", text("mcp.remove"), () => props.actions.mcpRemove(row.name), { danger: true, disabled: writable !== true, reason: text("mcp.writable") }),
            ]),
          ]);
        });
        const serversCard = card("mcp:servers", text("mcp.title") + "（" + String(servers.length) + " " + text("mcp.count") + "）", [
          servers.length === 0
            ? primitives.stateContainer({ key: "empty", state: "empty", message: text("mcp.empty") })
            : h("div", { key: "list", className: "dshg-list" }, serverRows),
        ]);
        const field = (key, label, node) => h("label", { key: key, className: "dshg-field" }, [
          h("span", { key: "l", className: "dshg-hint" }, label),
          node,
        ]);
        const formFields = [
          field("name", text("mcp.name"), h("input", { key: "i", className: "dshg-input", "aria-label": text("mcp.name"), value: String(draft.name || ""), disabled: editing.length > 0, onChange: (event) => props.actions.setMcpDraft({ name: event.target.value }) })),
          field("transport", text("mcp.transport"), h("select", { key: "i", className: "dshg-select", "aria-label": text("mcp.transport"), value: String(draft.transport || "stdio"), onChange: (event) => props.actions.setMcpDraft({ transport: event.target.value }) }, [
            h("option", { key: "stdio", value: "stdio" }, "stdio"),
            h("option", { key: "http", value: "streamable-http" }, "streamable-http"),
          ])),
        ];
        if (String(draft.transport || "stdio") === "stdio") {
          formFields.push(field("command", text("mcp.command"), h("input", { key: "i", className: "dshg-input", "aria-label": text("mcp.command"), value: String(draft.command || ""), onChange: (event) => props.actions.setMcpDraft({ command: event.target.value }) })));
          formFields.push(field("args", text("mcp.args"), h("input", { key: "i", className: "dshg-input", "aria-label": text("mcp.args"), value: String(draft.args || ""), onChange: (event) => props.actions.setMcpDraft({ args: event.target.value }) })));
          formFields.push(hint("preview", text("mcp.argsPreview") + " " + JSON.stringify(props.argsPreview)));
        } else {
          formFields.push(field("url", text("mcp.url"), h("input", { key: "i", className: "dshg-input", "aria-label": text("mcp.url"), value: String(draft.url || ""), onChange: (event) => props.actions.setMcpDraft({ url: event.target.value }) })));
        }
        const formCard = card("mcp:form", editing.length > 0 ? text("mcp.editTitle") : text("mcp.addTitle"), formOpen
          ? [
            h("div", { key: "fields", className: "dshg-form" }, formFields),
            h("div", { key: "actions", className: "dshg-row" }, [
              editing.length > 0
                ? button("save", text("mcp.saveEdit"), () => {
                  props.actions.mcpAction("update", editing);
                  props.actions.resetMcpDraft();
                  props.actions.setView({ mcpEditing: "", mcpAddOpen: false });
                }, { primary: true, disabled: writable !== true, reason: text("mcp.writable") })
                : button("add", text("mcp.addTitle"), () => props.actions.mcpAdd(), {
                  primary: true,
                  disabled: writable !== true || String(draft.name || "").trim().length === 0,
                  reason: String(draft.name || "").trim().length === 0 ? text("mcp.emptyName") : text("mcp.writable"),
                }),
              button("cancel", editing.length > 0 ? text("mcp.cancelEdit") : text("mcp.addCollapse"), () => {
                props.actions.resetMcpDraft();
                props.actions.setView({ mcpAddOpen: false, mcpEditing: "" });
              }),
            ]),
          ]
          : [button("open", text("mcp.addToggle"), () => props.actions.setView({ mcpAddOpen: true }), { disabled: writable !== true, reason: text("mcp.writable") })]);
        return h("div", { key: "mcp", className: "dshg-col" }, [
          purposeNode,
          alert("live", text("mcp.liveHint"), "info"),
          writable === true ? null : alert("writable", text("mcp.writable"), "warn"),
          serversCard,
          formCard,
        ].filter(Boolean));
      };

      // ---- 高级页（会话诊断 / 护栏与目录摘要 / 策略 JSON / 运行态指标） ----
      const renderSettings = (props) => {
        const guard = props.guard;
        const catalog = props.catalog;
        const signature = props.draft.signature;
        const view = props.view;
        const purposeNode = purpose("settings:purpose", text("purpose.settings"));
        const numeric = (key, field, label) => h("label", { key: key, className: "dshg-field" }, [
          h("span", { key: "l", className: "dshg-hint" }, label),
          h("input", {
            key: "i",
            className: "dshg-input",
            inputMode: "numeric",
            "aria-label": label,
            value: String(guard[field] === undefined || guard[field] === null ? "" : guard[field]),
            onChange: (event) => props.actions.stageGuard(field, event.target.value === "" ? null : Number(event.target.value)),
          }),
        ]);
        const sessionCard = card("settings:session", text("settings.sessionTitle"), [
          primitives.healthBar({ key: "health", health: props.health, sessionLabel: props.sessionLabel, readAtText: props.readAtText }),
          h("div", { key: "session", className: "dshg-row" }, [
            hint("s", text("health.session") + "：" + String(props.sessionLabel || text("common.none"))),
            button("list", text("settings.sessionList"), () => props.actions.listSessions()),
            h("select", {
              key: "select",
              className: "dshg-select",
              "aria-label": text("health.session"),
              value: props.session.agent || "",
              onChange: (event) => props.actions.selectSession(event.target.value),
            }, [h("option", { key: "auto", value: "" }, text("settings.sessionAuto"))].concat(listOf(props.sessions).map((item) => h("option", { key: item.id, value: item.id }, item.label)))),
          ]),
          hint("hint", text("settings.sessionHint")),
          props.sessionNotice ? alert("sessionNotice", String(props.sessionNotice), "warn") : null,
          listOf(props.sessions).length === 0 ? hint("empty", text("settings.sessionEmpty")) : null,
        ]);
        const groupMode = catalog.skillGroups === true ? "skill" : (catalog.groupByPlugin === false ? "flat" : "plugin");
        const catalogMode = h("div", { key: "mode", className: "dshg-row" }, [
          h("span", { key: "l", className: "dshg-hint" }, text("settings.catalogThree")),
          primitives.segmented({
            key: "seg",
            ariaLabel: text("settings.catalogThree"),
            value: groupMode,
            options: [
              { value: "plugin", label: text("settings.catalogByPlugin") },
              { value: "skill", label: text("settings.catalogBySkillGroup") },
              { value: "flat", label: text("settings.catalogFlat") },
            ],
            onSelect: (next) => {
              props.actions.stageCatalog("groupByPlugin", next === "plugin");
              props.actions.stageCatalog("skillGroups", next === "skill");
            },
          }),
        ]);
        const guardCard = card("settings:guard", text("settings.guardTitle"), [
          hint("guardHint", text("settings.guardHint")),
          h("div", { key: "row", className: "dshg-row" }, [
            primitives.switchButton({ key: "g", on: guard.enabled !== false, label: text("settings.guardEnabled"), onToggle: () => props.actions.stageGuard("enabled", guard.enabled === false) }),
          ]),
          h("div", { key: "grid", className: "dshg-form" }, [
            numeric("w", "windowSize", text("settings.window")),
            numeric("t", "threshold", text("settings.threshold")),
            numeric("r", "reminders", text("settings.reminders")),
            numeric("p", "previewChars", text("settings.previewChars")),
          ]),
          h("label", { key: "ex", className: "dshg-field" }, [
            h("span", { key: "l", className: "dshg-hint" }, text("settings.exclusions")),
            h("input", { key: "i", className: "dshg-input", "aria-label": text("settings.exclusions"), value: listOf(guard.exclusions).join(", "), onChange: (event) => props.actions.stageGuard("exclusions", event.target.value.split(",").map((item) => item.trim()).filter((item) => item.length > 0)) }),
          ]),
          button("saveGuard", text("save"), () => props.actions.saveGuard(), { primary: true, disabled: props.draft.guardrailDirty !== true }),
          h("div", { key: "catalog", className: "dshg-col dshg-section" }, [
            h("div", { key: "title", className: "dshg-subTitle" }, text("settings.catalogTitle")),
            hint("hint", text("settings.catalogHint")),
            catalogMode,
            h("label", { key: "len", className: "dshg-field" }, [
              h("span", { key: "l", className: "dshg-hint" }, text("settings.catalogMaxDesc")),
              h("input", { key: "i", className: "dshg-input", inputMode: "numeric", "aria-label": text("settings.catalogMaxDesc"), value: String(catalog.maxDescriptionLength === undefined ? "" : catalog.maxDescriptionLength), onChange: (event) => props.actions.stageCatalog("maxDescriptionLength", Number(event.target.value)) }),
            ]),
            h("div", { key: "meta", className: "dshg-row" }, [
              tag("cache", text("settings.catalogCache") + " " + text("settings.catalogUnknown"), "muted"),
              tag("resident", text("settings.catalogResident") + " " + text("settings.catalogUnknown"), "muted"),
            ]),
            button("saveCatalog", text("save"), () => props.actions.saveCatalog(), { primary: true, disabled: props.draft.catalogDirty !== true }),
          ]),
          h("div", { key: "signature", className: "dshg-col dshg-section" }, [
            h("div", { key: "title", className: "dshg-subTitle" }, text("settings.signatureTitle")),
            hint("hint", text("settings.signatureHint")),
            h("div", { key: "row", className: "dshg-row" }, [
              primitives.switchButton({ key: "s", on: signature.enabled !== false, label: text("settings.signatureEnabled"), onToggle: () => props.actions.stageSignature(signature.enabled === false, listOf(signature.tools).join(", ")) }),
              h("input", { key: "tools", className: "dshg-input", "aria-label": text("settings.signatureTools"), placeholder: text("settings.signatureTools"), value: String(view.signatureTools === undefined ? listOf(signature.tools).join(", ") : view.signatureTools), onChange: (event) => props.actions.stageSignature(signature.enabled !== false, event.target.value) }),
            ]),
            button("restore", text("settings.signatureRestore"), () => props.actions.restoreSignature(), { disabled: props.draft.signatureDirty !== true }),
            button("save", text("save"), () => props.actions.saveSignature(), { primary: true, disabled: props.draft.signatureDirty !== true }),
          ]),
        ]);
        const jsonCard = card("settings:json", text("settings.jsonTitle"), [
          hint("hint", text("settings.jsonHint")),
          h("textarea", {
            key: "editor",
            className: "dshg-json",
            spellCheck: false,
            "aria-label": text("settings.jsonTitle"),
            value: view.jsonText,
            onChange: (event) => props.actions.editJson(event.target.value),
          }),
          h("div", { key: "meta", className: "dshg-row" }, [
            hint("size", bytesOf(view.jsonText) + " " + text("settings.jsonBytes") + " · " + String(view.jsonText.length === 0 ? 0 : view.jsonText.split(newline).length) + " " + text("common.count")),
            props.jsonParsed ? hint("parsed", text("settings.jsonValidated")) : hint("parsed", text("settings.jsonInvalid")),
          ]),
          h("div", { key: "actions", className: "dshg-row" }, [
            button("validate", text("settings.jsonValidate"), () => props.actions.validateJson()),
            button("format", text("settings.jsonFormat"), () => props.actions.formatJson()),
            button("default", text("settings.jsonDefault"), () => props.actions.requestJsonRestore(), { danger: true }),
            button("import", text("settings.jsonImport"), () => props.actions.importJson(), { disabled: String(view.jsonText || "").trim().length === 0 }),
            button("export", text("settings.jsonExport"), () => props.actions.exportJson()),
            button("replace", text("settings.jsonReplace"), () => props.actions.requestJsonSave(), { primary: true, disabled: props.summary.blocking === true }),
          ]),
          view.jsonNotice ? alert("notice", view.jsonNotice.text, view.jsonNotice.tone) : null,
          props.jsonDiff ? primitives.diffPreview({ key: "diff", diff: props.jsonDiff, title: text("settings.jsonDiff") }) : null,
        ]);
        const counters = props.metrics && isObject(props.metrics.counters) ? props.metrics.counters : null;
        const metricsCard = card("settings:metrics", text("settings.metricsTitle"), [
          hint("hint", text("settings.metricsHint")),
          counters === null
            ? hint("none", text("settings.metricsNone"))
            : h("div", { key: "kv", className: "dshg-wraps" }, Object.keys(counters).map((key) => h("span", { key: key, className: "dshg-tag" }, key + " " + String(counters[key])))),
          h("div", { key: "actions", className: "dshg-row" }, [
            button("refresh", text("settings.metricsRefresh"), () => props.actions.loadDiagnostics()),
            hint("auto", text("settings.autoHint")),
          ]),
        ]);
        return h("div", { key: "settings", className: "dshg-col" }, [purposeNode, sessionCard, guardCard, jsonCard, metricsCard]);
      };

      const renderTabPanel = (props) => {
        const panels = [
          { value: "caps", node: renderCaps(props) },
          { value: "skills", node: renderSkills(props) },
          { value: "mcp", node: renderMcp(props) },
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
        renderJson: renderSettings,
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
      const PANEL_VERSION = "0.7.0";

      const TABS = Object.freeze([
        { value: "caps", label: text("tab.caps") },
        { value: "skills", label: text("tab.skills") },
        { value: "mcp", label: text("tab.mcp") },
        { value: "settings", label: text("tab.settings") },
      ]);

      const tabOf = (route) => {
        if (route === undefined || route === null || route === "") return "caps";
        const head = String(route).split("/")[0];
        if (head === "json") return "settings";
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
        mcpDraft: { name: "", transport: "stdio", command: "", args: "", url: "", rawServer: null },
        mcpAddOpen: false,
        mcpEditing: "",
        diagOpen: false,
        diffOpen: false,
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
          toggleEnabled: (next) => orchestrator.toggleEnabled(next),
          recoverCorruptPolicy: (template) => orchestrator.recoverCorruptPolicy(template),
          mcpMutate: (payload) => orchestrator.mcpMutate(payload),
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
        const confirmRef = react.useRef(null);
        confirmRef.current = confirmState;
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

        const MCP_UI_FIELDS = ["name", "mounted", "status", "error", "tools", "toolCount", "source", "warning", "warnings", "healthy", "id", "target", "state", "owned"];
        const mcpServerOf = (draft) => {
          const base = isObject(draft && draft.rawServer) ? clone(draft.rawServer) : {};
          for (let index = 0; index < MCP_UI_FIELDS.length; index += 1) delete base[MCP_UI_FIELDS[index]];
          delete base.transport;
          if (String((draft && draft.transport) || "stdio") === "stdio") {
            delete base.url;
            base.transport = "stdio";
            base.command = String((draft && draft.command) || "").trim();
            base.args = parseArgs((draft && draft.args) || "").filter((item) => item.indexOf("__UNCLOSED__:") !== 0);
          } else {
            delete base.command;
            delete base.args;
            base.transport = "streamable-http";
            base.url = String((draft && draft.url) || "").trim();
          }
          return base;
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
          mcpAction: (action, name) => {
            const body = { action: action, name: name };
            if (action === "update") body.server = mcpServerOf(view.mcpDraft);
            runAction("mcp", async () => {
              const receipt = await runtime.mcpMutate(body);
              handleReceipt(receipt);
              if (receipt.state === "applied") await runtime.refresh({ reason: "post-mcp" });
            });
          },
          mcpRemove: (name) => setConfirmState({ gate: { action: "mcp", text: text("mcp.removeTitle") + "（" + name + "）", consequence: text("mcp.removeConsequence"), confirmLabel: "确认删除", cancelLabel: text("confirm.cancel"), needsConfirm: true }, run: () => { void runtime.write({ path: "/api/dsh-gate/mcp", action: "mcp-remove", body: { action: "remove", name: name } }).then((receipt) => { handleReceipt(receipt); if (receipt.state === "applied") return runtime.refresh({ reason: "post-mcp" }); return undefined; }); } }),
          mcpAdd: () => {
            const name = String(view.mcpDraft.name || "").trim();
            if (name.length === 0) { toast("error", text("mcp.emptyName"), "mcp-add"); return; }
            runAction("mcp", async () => {
              const receipt = await runtime.mcpMutate({ action: "add", name: name, server: mcpServerOf(view.mcpDraft) });
              handleReceipt(receipt);
              if (receipt.state === "applied") {
                actions.resetMcpDraft();
                applyView({ mcpAddOpen: false });
                await runtime.refresh({ reason: "post-mcp" });
              }
            });
          },
          setMcpDraft: (patch) => applyView({ mcpDraft: Object.assign({}, view.mcpDraft, patch) }),
          resetMcpDraft: () => applyView({ mcpDraft: { name: "", transport: "stdio", command: "", args: "", url: "", rawServer: null } }),
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
            setConfirmState({ gate: { action: "save-policy", text: text("json.confirmTitle"), consequence: "整份替换会丢弃面板里的能力/技能草稿（" + summary.text + "）", detail: "当前版本 expectedRevision=" + String(snapshot.revision === null ? "—" : snapshot.revision), confirmLabel: text("confirm.ok"), cancelLabel: text("confirm.cancel"), needsConfirm: summary.total > 0 }, run: () => {
              const jsonBody = Object.assign({}, parsed.value, { replace: true, acknowledge: true });
              if (snapshot.revision !== null && snapshot.revision !== undefined) jsonBody.expectedRevision = snapshot.revision;
              void runtime.savePolicy(jsonBody).then((receipt) => {
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
            const parsed = parseText(view.jsonText);
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
            const body = JSON.stringify(content, null, 2);
            applyView({ exchangeText: body });
            const clipboard = typeof navigator !== "undefined" && navigator && navigator.clipboard && typeof navigator.clipboard.writeText === "function" ? navigator.clipboard : null;
            if (clipboard === null) { toast("warn", text("settings.jsonCopyFallback"), "export"); return; }
            try {
              const pending = clipboard.writeText(body);
              if (pending && typeof pending.then === "function") pending.then(() => toast("ok", text("settings.jsonExported"), "export"), () => toast("warn", text("settings.jsonCopyFallback"), "export"));
              else toast("ok", text("settings.jsonExported"), "export");
            } catch (error) {
              toast("warn", text("settings.jsonCopyFallback"), "export");
            }
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
            if (!result.ok) { setMetrics(null); toast("warn", text("settings.metricsFailed") + "（" + (result.error || "") + "）", "metrics"); return; }
            const body = isObject(result.body) ? result.body : {};
            setMetrics(isObject(body.runtime) ? body.runtime : { counters: body });
          },
          toggleEnabled: () => {
            const current = snapshot.data.state;
            const next = !(current === null || current.enabled !== false);
            runAction("save-policy", async () => {
              const receipt = await runtime.toggleEnabled(next);
              handleReceipt(receipt);
              if (receipt.state === "applied") await runtime.refresh({ reason: "toggle" });
            });
          },
          recoverCorrupt: () => {
            setConfirmState({
              gate: {
                action: "recover-corrupt",
                text: text("corrupt.confirmTitle"),
                consequence: text("corrupt.confirmText"),
                confirmLabel: text("corrupt.rebuild"),
                cancelLabel: text("confirm.cancel"),
                needsConfirm: true,
              },
              run: () => {
                void runtime.recoverCorruptPolicy(fallbackTemplate()).then((receipt) => {
                  if (receipt && (receipt.state === "applied" || receipt.state === "no-change" || receipt.state === "noop")) {
                    draftStore.discardAll();
                    draftStore.json.setDirty(false);
                    applyView({ jsonDirty: false });
                  }
                  handleReceipt(receipt);
                  if (receipt.state === "applied") return runtime.refresh({ reason: "recover" });
                  return undefined;
                });
              },
            });
          },
        };

        // 幂等样式注入（P0）：挂载即确保 style[data-dsh-gate] 存在
        react.useEffect(() => {
          ensureStyle(typeof document === "undefined" ? null : document);
        }, []);

        // 键盘撤销/重做：输入类控件内不拦截
        react.useEffect(() => {
          if (typeof document === "undefined" || typeof document.addEventListener !== "function") return undefined;
          const handler = (event) => {
            if (confirmRef.current) return;
            if (!event || event.isComposing === true) return;
            const target = event.target;
            const tag = target && target.tagName ? String(target.tagName).toUpperCase() : "";
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (target && target.isContentEditable === true)) return;
            if (event.ctrlKey !== true && event.metaKey !== true) return;
            const key = String(event.key || "").toLowerCase();
            if (key === "z") {
              if (typeof event.preventDefault === "function") event.preventDefault();
              if (event.shiftKey === true) actions.redo(); else actions.undo();
              return;
            }
            if (key === "y") {
              if (typeof event.preventDefault === "function") event.preventDefault();
              actions.redo();
            }
          };
          document.addEventListener("keydown", handler);
          return () => { if (typeof document.removeEventListener === "function") document.removeEventListener("keydown", handler); };
        }, []);

        // 提示自动消失：error（lifetime 0）常驻，其余按级别计时
        react.useEffect(() => {
          if (typeof setTimeout !== "function") return undefined;
          const timers = [];
          for (let index = 0; index < toastItems.length; index += 1) {
            const item = toastItems[index];
            if (typeof item.lifetime !== "number" || item.lifetime <= 0) continue;
            const key = item.key;
            const expiresAt = typeof item.expiresAt === "number" && item.expiresAt > 0 ? item.expiresAt : (Date.now() + item.lifetime);
            timers.push(setTimeout(() => { toastRef.current.dismiss(key); setToastItems(toastRef.current.items()); }, Math.max(0, expiresAt - Date.now())));
          }
          return () => { for (let index = 0; index < timers.length; index += 1) clearTimeout(timers[index]); };
        }, [toastItems]);

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

        const gateState = snapshot.data.state;
        const gateOn = gateState === null || gateState.enabled !== false;
        const corrupt = isObject(snapshot.data.policy) && snapshot.data.policy.corrupt === true;
        const loadError = snapshot.loading === false && snapshot.data.state === null && snapshot.lastError !== "";
        const diagOpen = view.diagOpen === true;
        const diffOpen = view.diffOpen === true;

        const layout = () => {
          const chip = (key, label, tone) => h("span", { key: key, className: "dshg-chip", "data-tone": tone }, String(label));
          const chips = [
            chip("c:resident", text("tier.resident") + " " + String(model ? model.stats.resident : 0), "ok"),
            chip("c:ondemand", text("tier.ondemand") + " " + String(model ? model.stats.ondemand : 0), "business"),
            chip("c:off", text("tier.off") + " " + String(model ? model.stats.off : 0), "muted"),
            model && model.stats.warnings > 0 ? chip("c:warn", text("top.warnings") + " " + String(model.stats.warnings), "warn") : null,
            summary.total > 0 ? chip("c:pending", text("top.pending") + " " + String(summary.total), "warn") : null,
          ].filter(Boolean);
          const top = h("div", { key: "top", className: "dshg-top" }, [
            primitives.switchButton({
              key: "enabled",
              on: gateOn,
              label: gateOn ? text("top.enabled") : text("top.disabled"),
              disabled: snapshot.writingActive === true || snapshot.loading === true,
              reason: text("top.toggleReason"),
              onToggle: () => actions.toggleEnabled(),
            }),
            h("div", { key: "chips", className: "dshg-chips" }, chips),
            h("span", { key: "grow", className: "dshg-grow" }, null),
            buttonNode("top:diag", text("top.diag"), () => applyView({ diagOpen: !diagOpen }), { title: text("diag.hint") }),
            buttonNode("top:reload", snapshot.loading ? text("common.loading") : text("top.reload"), () => actions.reload(), { disabled: snapshot.writingActive === true }),
          ]);
          const diag = h("div", { key: "diag", className: "dshg-col" }, diagOpen ? [
            primitives.healthBar({ key: "hb", health: viewProps.health, sessionLabel: viewProps.sessionLabel, readAtText: viewProps.readAtText }),
            h("div", { key: "meta", className: "dshg-row" }, [
              h("span", { key: "file", className: "dshg-hint" }, text("diag.file") + "：" + String(viewProps.health.file || text("common.none"))),
              h("span", { key: "read", className: "dshg-hint" }, text("diag.readAt") + "：" + String(viewProps.readAtText)),
              h("span", { key: "ver", className: "dshg-hint" }, text("title") + " v" + PANEL_VERSION),
            ]),
            h("div", { key: "src", className: "dshg-row" }, routes.map((route) => h("span", { key: route.key, className: "dshg-tag", "data-tone": route.status === "error" ? "error" : (route.status === "partial" ? "warn" : "ok") }, text("diag.sources") + " · " + route.key + "：" + String(route.status === undefined || route.status === null ? "?" : route.status)))),
            h("div", { key: "hint", className: "dshg-hint" }, text("diag.hint")),
          ] : null);
          const corruptNode = h("div", { key: "corrupt", className: "dshg-col" }, corrupt === true ? h("div", { key: "card", className: "dshg-card dshg-corrupt" }, [
            h("div", { key: "head", className: "dshg-cardHead" }, h("span", { key: "t", className: "dshg-cardTitle" }, text("corrupt.title"))),
            h("div", { key: "body", className: "dshg-cardBody" }, [
              h("div", { key: "text", className: "dshg-alert", "data-tone": "error", role: "alert" }, text("corrupt.text")),
              h("div", { key: "actions", className: "dshg-row" }, [buttonNode("rebuild", text("corrupt.rebuild"), () => actions.recoverCorrupt(), { primary: true })]),
            ]),
          ]) : null);
          const toasts = h("div", { key: "toasts", className: "dshg-col" }, primitives.toastHost({ key: "toasthost", items: toastItems, onDismiss: dismissToast }));
          const dialog = confirmState === null ? null : (confirmState.conflict
            ? primitives.confirmBar({
                key: "dialog:conflict",
                id: "dshg-conflict",
                title: text("confirm.ok"),
                text: confirmState.conflict.message,
                detail: confirmState.conflict.choices.map((choice) => choice.label + " — " + choice.consequence).join("；"),
                confirmLabel: text("confirm.ok"),
                cancelLabel: text("confirm.cancel"),
                destructive: true,
                onConfirm: () => { const conflict = confirmState.conflict; setConfirmState(null); void runtime.savePolicy(Object.assign({}, draftStore.toPolicyBody(), { expectedRevision: conflict.revision })).then(handleReceipt); },
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
          const tabCount = (value) => {
            if (value === "caps") return model ? model.stats.rows : "";
            if (value === "skills") return model ? model.stats.skills : "";
            if (value === "mcp") return isObject(snapshot.data.mcp) && Array.isArray(snapshot.data.mcp.servers) ? snapshot.data.mcp.servers.length : "";
            return summary.total > 0 ? "•" : "";
          };
          const tabs = h("div", { key: "tabs", className: "dshg-col" }, primitives.tabsBar({
            key: "tabsbar",
            tabs: TABS.map((tab) => ({ value: tab.value, label: tab.label, count: tabCount(tab.value) })),
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
          }));
          let bodyNode = null;
          if (loadError === true) {
            bodyNode = primitives.errorCard({
              key: "load",
              title: text("error.title"),
              message: text("loadFailed") + "：" + String(snapshot.lastError),
              onRetry: () => { void runtime.refresh({ reason: "retry" }); },
            });
          } else if (view.routeMissing === true) {
            bodyNode = h("div", { key: "route-missing", className: "dshg-card" }, [
              h("div", { key: "head", className: "dshg-cardHead" }, h("span", { key: "t", className: "dshg-cardTitle" }, text("error.viewMissing"))),
              h("div", { key: "body", className: "dshg-cardBody" }, [
                h("div", { key: "hint", className: "dshg-hint" }, text("error.viewMissingHint")),
                h("div", { key: "actions", className: "dshg-row" }, [
                  buttonNode("retry", text("error.retry"), () => { void runtime.refresh({ reason: "retry" }); }),
                  buttonNode("caps", text("error.backToCaps"), () => applyView({ tab: "caps", routeMissing: false }), { primary: true }),
                ]),
              ]),
            ]);
          } else {
            bodyNode = views.renderTabPanel(viewProps);
          }
          const body = h("div", { key: "body", className: "dshg-col" }, bodyNode);
          const saveNodes = summary.total > 0
            ? [
              h("div", { key: "bar", className: "dshg-saveBar" }, [
                h("div", { key: "info", className: "dshg-grow" }, [
                  h("div", { key: "t", className: "dshg-saveTitle" }, text("save.title") + "（" + String(summary.total) + "）"),
                  h("div", { key: "s", className: "dshg-hint" }, summary.text),
                ]),
                buttonNode("save:details", diffOpen ? text("save.hideDetails") : text("save.details"), () => applyView({ diffOpen: !diffOpen })),
                buttonNode("save:undo", text("save.undo"), () => actions.undo(), { disabled: !draftStore.canUndo() }),
                buttonNode("save:redo", text("save.redo"), () => actions.redo(), { disabled: !draftStore.canRedo() }),
                buttonNode("save:discard", text("save.discard"), () => actions.discard(), { danger: true }),
                buttonNode("save:commit", snapshot.writingActive ? text("save.saving") : text("save.save"), () => actions.savePolicy(), {
                  primary: true,
                  disabled: summary.blocking === true || snapshot.writingActive === true,
                  reason: summary.blocking === true ? text("caps.blocked") : text("top.toggleReason"),
                }),
              ]),
              diffOpen === true && viewProps.diff ? primitives.diffPreview({ key: "diff", diff: viewProps.diff, title: text("save.details") }) : null,
            ]
            : [
              h("div", { key: "bar", className: "dshg-saveBar dshg-saveClean" }, [
                h("span", { key: "t", className: "dshg-hint" }, text("save.noChanges")),
                buttonNode("save:undo", text("save.undo"), () => actions.undo(), { disabled: !draftStore.canUndo() }),
                buttonNode("save:redo", text("save.redo"), () => actions.redo(), { disabled: !draftStore.canRedo() }),
              ]),
            ];
          const save = h("div", { key: "save", className: "dshg-col" }, saveNodes.filter(Boolean));
          const foot = h("div", { key: "foot", className: "dshg-foot" }, [
            h("span", { key: "file", className: "dshg-note" }, text("health.file") + "：" + String(viewProps.health.file || text("common.none"))),
            h("span", { key: "note", className: "dshg-hint" }, text("summary")),
            h("span", { key: "ver", className: "dshg-hint" }, "v" + PANEL_VERSION),
          ]);
          const dialogSlot = h("div", { key: "dialog", className: "dshg-col" }, dialog);
          return h("div", { key: "root:" + fatalToken, className: "dshg-wrap" }, [top, diag, corruptNode, toasts, dialogSlot, tabs, body, save, foot]);
        };

        const buttonNode = (key, label, onClick, options) => {
          const opts = options || {};
          return h("button", {
            key: key,
            type: "button",
            className: "dshg-btn",
            "data-primary": opts.primary === true ? "true" : undefined,
            "data-danger": opts.danger === true ? "true" : undefined,
            disabled: opts.disabled === true,
            title: opts.disabled === true ? (opts.reason || "") : (opts.title || ""),
            onClick: opts.disabled === true ? undefined : onClick,
          }, String(label));
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
      testHook.version = "0.7.0";
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
        PANEL_VERSION: "0.7.0",
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
