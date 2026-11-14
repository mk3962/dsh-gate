# 排查

按现象查。每一条都是实际踩过的，不是猜的。

## 装不上 / 卸不了

| 现象 | 原因 | 处理 |
|---|---|---|
| 脚本报「目标 profile(x) 的 DSH 正在运行」 | 目标 profile 的实例还开着（脚本拒绝对运行中的 profile 写文件） | 退出该实例；确认是**目标 profile**，不是别的实例。需要强行时加 `-Force`（自行承担风险） |
| 脚本报「找不到插件源码目录」 | 在错误的工作目录运行；仓库布局下脚本在 `scripts\` | 保持仓库结构，或 `-Source <插件目录>` 显式指定 |
| 脚本报 `node` 不是命令 | 宿主 PATH 上没有 Node（DSH 自带 runtime 不算） | 安装 Node ≥ 20，或改用**方式 B** 手工安装 |
| `CreateJunction` 失败 / 拒绝访问 | 目标已存在实体目录，或没有权限 | 先把 `node_modules\dsh-gate` 移走；junction 不需要管理员权限，符号链接才需要 |

## 装好了但界面里看不到

| 现象 | 原因 | 处理 |
|---|---|---|
| 「插件 → 已安装」里没有 dsh-gate，但日志有 `dsh-gate: 已挂载 agent` | profile `package.json` 的 **dependencies** 里没有它（只写了 `dsh.profile.bundles`）。宿主 `installed = dependencies.includes(name)`，前端又把 `installed=false && official=false && error===undefined` 的行整条丢掉 | 用 0.1.2+ 的 `scripts/install.ps1`，或手工加 `"dsh-gate": "link:../../local-plugins/dsh-gate"` 到 dependencies |
| 有卡片，但点开没有「配置」 | client bundle 没加载（旧页面缓存 / `exports["./client"]` 不对） | 刷新页面；`npm run check` 验证 `exports["./client"]` 与 bundle 格式 |
| 面板能打开但一直是 0 | 策略文件路径不对（桌面版不设 `$DSH_HOME`） | 0.1.3+ 会回退 `~/.dsh`；确认文件在 `<DSH home>\gate.json` |
| 面板显示的是别的会话 | 多会话进程取错 agent（0.1.4 前） | 升级到 0.1.4+；必要时 `GET /api/dsh-gate/state?agent=<id>` 点名 |

## 闸门看起来没生效

| 现象 | 原因 | 处理 |
|---|---|---|
| 工具数量没变、token 没降 | `policy.enabled = false`，或策略文件读坏了（fail-open 全常驻） | `gate_status` 看 `enabled`；检查 `gate.json` 是否合法 JSON、是否带 BOM |
| 改了策略但下一轮没变 | 面板保存写的是策略文件，生效在**下一轮** assemble | 发下一条消息再看；段落/技能同理 |
| PTC profile 里 `pwsh`/`read` 等"藏不起来" | PTC 模式下这些工具根本不存在（不是闸门管不到） | 正常现象，见 README「已知限制」 |
| 技能列一直是空 | 宿主没注册 `skill` 工具（PTC profile） | 已知限制；非 PTC profile 会正常记录 |
| 段落「摘除」后目录里也找不到它 | 0.1.5 前段落快照是覆盖写 | 升级到 0.1.5+（改并集合并 + 立刻重算） |
| 目录里段落行只有名字、没有摘要 | 已知问题：`recordSections` 只记 `{name, chars, tokens}`，`renderCatalog` 却读 `entry.summary` | 正常现象，0.1.8 起记为已知限制（修它要改目录字节、破缓存前缀，另开票） |
| `gate_call` 一次后工具表抖两下 | 0.1.1 前 `callThrough` 没置 `applying` | 升级到 0.1.2+ |
| 真机调 `gate_status` 报 `ToolCallError: value.xxx is not a declared property` | `output.schema` 与 `STATUS_KEYS` 漂了（宿主 `additionalProperties: false`） | 升级到 0.1.5+；改 schema 时用 `npm test` 里的 schema 覆盖用例兜住 |
| PTC 下 `gate_load` 后工具不在工具表 | 正常：PTC 冻结了工具表，声明追加在消息末尾 | 用 `gate_invoke({ tool, arguments })` 调；`GET /api/dsh-gate/state` 的 `executor` / `frozen` 看判定（`gate_status` 18 键不含它们） |
| PTC 下工具表仍随 `gate_load` 变化 | 执行器没认出来（fail-open 按 native），或策略里 `freezePtcToolset: false` | 看 HTTP 快照的 `executor.reason`；认不出属宿主演进，按 native 跑即可 |
| `gate_invoke` 返回 `{ isError: true }` | 参数被宿主 `defineTool` 校验拒绝，或工具自身抛错 | 看 `text` 里的 `Error: …`；闸门不代校验参数，签名以声明里那行退化签名为准 |
| `gate_invoke` 说「未知工具」/「被上游隐藏」 | 目标不在 known、被上游隐藏、或名字打错（`gate_invoke` 只执行已加载 / 常驻工具，不像 `gate_call` 接受任意已知工具） | 先 `gate_search` / `gate_load`；上游隐藏的名字闸门不会放出来 |
| 尾部声明每次加载都多一条 | 清单变了（新加载的名字、段落正文首次取到） | 正常：只在内容变化时追加；旧的块留在历史里自然过时（宿主不提供摘除通道）。0.3.1 前每步都追加，长会话会累积上万 token |
| 尾部声明完全不见了 | 上下文被压缩/折叠，或插件重启后还没到下一步 | 0.3.1 起会按 `agent.session` 表面自愈；读不到表面时以 `lastEmitted` 记忆为准 |

## 官方 UI 的「卸载」按钮失败

现象：确认卸载后卡片还在、变成「已停用」，磁盘上 `dsh.profile.bundles` 已经摘了，但 `dependencies` 与 `node_modules` 还在。
日志 `.plugin-manager\logs\operation-*\pnpm.log` 里是：

```text
[ERR_PNPM_UNEXPECTED_STORE] Unexpected store location
dependencies at "<profile>\node_modules" are currently linked from the store at "C:\Users\...\pnpm\store\v11",
but pnpm would like to use "D:\.pnpm-store\v11"
```

原因：profile 在 D: 盘而 store 记录在 C: 盘（典型场景：整个 `~\.dsh` 被复制/迁移过）。
pnpm 在 D: 盘找不到同盘 store，于是拒绝任何写操作。两步对齐（**不需要**重装依赖）：

1. profile 的 `pnpm-workspace.yaml` 加一行 `storeDir: <原来那个 store 的路径>`
   （pnpm 11 的项目级设置走 workspace yaml，`.npmrc` 已不生效）；
2. `node_modules\.modules.yaml` 的 `virtualStoreDir` 改成该 profile 自己的 `<profile>\node_modules\.pnpm`。

改完 UI 卸载能跑完；不想折腾就直接用 `scripts\uninstall.ps1`（它不走 pnpm）。

## PTC 会话的加载语义（0.2.0+）

- 看到 `frozen: true` 就是冻结模式：`gate_load` 不改工具表，只让末尾声明变长；调用一律走 `gate_invoke`。
- 冻结在第一次 `gate_load` 之前就生效 —— 别指望「先加载一次、再冻上」能省缓存。
- 想退回 0.1.8 的加载语义（加载即改工具表）：策略里写 `"freezePtcToolset": false`，下一轮生效，不用降级。
- native 会话没有尾部声明；段落加载后仍回系统提示词，这是有意保留的差异（native 没有 `gate_invoke` 这条执行口）。

## 日志

插件只在三处写 info：挂载 agent 时的分层统计、禁用策略时的提示、执行器判定的首次 / 变化记录
（`dsh-gate: 执行器判定 …`）；其余失败一律 warn 且不阻塞。
想看更细的：把 `policyFile` 里的 `enabled` 改 false 再改回 true，可以确认"读到的是哪份策略"。
