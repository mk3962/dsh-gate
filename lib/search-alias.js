/**
 * 中文 → 英文词根的别名索引（0.4.1）。
 *
 * 真实缺陷（体检票 03 / 2026-11-14）：gate_search 对中文查询 91.2% 零命中。
 * 名字（mnemon_remember / weather / terminal_open）与 description 几乎全是 ASCII，
 * 模型按用户语言写「记忆」「天气」时，子串匹配永远不可能命中。
 *
 * 口径：每个中文词映射到「真名或说明里一定会出现的英文词根」。命中即按别名档计分
 * （低于精确/前缀/包含，高于零），并在结果里照常排序。别名表只增不改 —— 它是
 * 纯查表，不影响目录字节（不进 gate-catalog，只被 gate_search 读）。
 */
export const CJK_ALIASES = Object.freeze([
  ["记忆", ["mnemon", "memory", "recall"]],
  ["回忆", ["mnemon", "recall", "memory"]],
  ["遗忘", ["mnemon", "forget"]],
  ["文档", ["document", "doc", "docx", "word"]],
  ["表格", ["sheet", "excel", "xlsx"]],
  ["幻灯片", ["slide", "pptx", "ppt"]],
  ["演示", ["slide", "pptx"]],
  ["天气", ["weather"]],
  ["汇率", ["finance", "currency"]],
  ["搜索", ["search"]],
  ["检索", ["search", "recall"]],
  ["终端", ["terminal", "pty"]],
  ["进程", ["process", "job", "ps"]],
  ["任务", ["job", "task", "todo", "schedule"]],
  ["计划", ["schedule", "plan", "todo"]],
  ["定时", ["schedule", "cron"]],
  ["通知", ["notify", "notifications"]],
  ["截图", ["screenshot", "image"]],
  ["图片", ["image", "picture"]],
  ["视频", ["video"]],
  ["音频", ["audio"]],
  ["语音", ["audio", "voice"]],
  ["专家", ["expert", "agency"]],
  ["团队", ["team", "expert"]],
  ["子代理", ["subagent", "agent"]],
  ["代理", ["subagent", "agent", "proxy"]],
  ["代码", ["code", "shell", "exec"]],
  ["执行", ["exec", "run", "pwsh", "shell"]],
  ["命令", ["command", "pwsh", "shell"]],
  ["文件", ["file", "read", "write", "glob"]],
  ["目录", ["directory", "glob", "list"]],
  ["编辑", ["edit", "write"]],
  ["写入", ["write"]],
  ["读取", ["read"]],
  ["网络", ["web", "fetch", "http"]],
  ["网页", ["web", "fetch", "url"]],
  ["浏览器", ["browser", "web"]],
  ["远程", ["ssh", "remote"]],
  ["主机", ["host", "ssh"]],
  ["压缩", ["compress", "context"]],
  ["上下文", ["context", "compress"]],
  ["会话", ["session"]],
  ["历史", ["session", "trace", "history"]],
  ["追踪", ["trace", "session"]],
  ["渲染", ["render", "ui"]],
  ["界面", ["ui", "render"]],
  ["组件", ["ui", "component"]],
  ["数据库", ["database", "sql", "db"]],
  ["服务", ["server", "service", "mcp"]],
  ["工具", ["tool"]],
  ["技能", ["skill"]],
  ["段落", ["section"]],
  ["策略", ["policy", "gate"]],
  ["闸门", ["gate"]],
  ["刷新", ["refresh", "reload"]],
  ["重启", ["restart", "reload"]],
  ["安装", ["install", "add"]],
  ["卸载", ["uninstall", "remove"]],
  ["升级", ["update", "upgrade"]],
  ["版本", ["version"]],
  ["日志", ["log"]],
  ["调试", ["debug"]],
  ["测试", ["test"]],
  ["运行", ["run", "exec"]],
  ["启动", ["start", "boot"]],
  ["停止", ["stop", "kill"]],
  ["删除", ["delete", "remove", "forget"]],
  ["创建", ["create", "new"]],
  ["更新", ["update", "edit"]],
  ["查询", ["query", "search", "get", "list"]],
  ["列表", ["list"]],
  ["状态", ["status", "state"]],
  ["配置", ["config", "setting"]],
  ["设置", ["config", "setting"]],
  ["权限", ["permission", "auth"]],
  ["安全", ["security", "safe"]],
  ["成本", ["cost", "usage"]],
  ["用量", ["usage", "cost"]],
  ["模型", ["model", "llm"]],
  ["提示词", ["prompt"]],
  ["邮件", ["mail", "email"]],
  ["表格数据", ["sheet", "data"]],
]);

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 查询里是否含 CJK（决定要不要走别名展开）。 */
export function hasCjk(text) {
  return CJK_RE.test(String(text === undefined || text === null ? "" : text));
}

/** 把查询里出现的中文词展开成英文词根（去重、保序）。 */
export function cjkKeywordsOf(text) {
  const raw = String(text === undefined || text === null ? "" : text);
  if (!hasCjk(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const [zh, en] of CJK_ALIASES) {
    if (!raw.includes(zh)) continue;
    for (const word of en) {
      if (seen.has(word)) continue;
      seen.add(word);
      out.push(word);
    }
  }
  return out;
}
