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
| `gate_call` 一次后工具表抖两下 | 0.1.1 前 `callThrough` 没置 `applying` | 升级到 0.1.2+ |
| 真机调 `gate_status` 报 `ToolCallError: value.xxx is not a declared property` | `output.schema` 漏了 `status()` 的键（宿主 `additionalProperties: false`） | 升级到 0.1.5+；改 schema 时用 `npm test` 里的 schema 覆盖用例兜住 |

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

## 日志

插件只在两处写 info：挂载 agent 时的分层统计、以及禁用策略时的提示；其余失败一律 warn 且不阻塞。
想看更细的：把 `policyFile` 里的 `enabled` 改 false 再改回 true，可以确认"读到的是哪份策略"。
