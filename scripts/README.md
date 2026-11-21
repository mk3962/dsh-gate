# scripts

安装 / 卸载 / 激活 / 回滚四个脚本，共享同一个公共模块 `dsh-gate-deploy.psm1`。

| 文件 | 作用 |
|---|---|
| `dsh-gate-deploy.psm1` | 唯一公共模块（G89）：进程检测、DSH home 与 profile 路径解析、manifest 往返改写、patch 行匹配与写入、YAML 结构校验、备份与保留清理、无 BOM 写入断言、事务日志与失败逆操作回滚。四个脚本不再各写一份。 |
| `install.ps1` | 安装事务：预检 -> 复制到暂存 -> 校验 -> 交换 -> 写 patch 与策略种子 -> 回读校验；任一步失败自动回滚。参数：`-Profile` `-GateHome` `-Source` `-BackupRoot` `-KeepBackups` `-DryRun` `-Force`。 |
| `uninstall.ps1` | 对称卸载：备份 -> 摘 bundles/dependencies -> 删 junction -> 源码入备份 -> 摘 patch 行 -> 回读校验。认得 install 写的 4 空格缩进行，装与卸往返后 profile 逐字节回初始。 |
| `activate.cmd` | `install.ps1` 的双击包装（CRLF，失败回传非零退出码）。 |
| `rollback.cmd` | `uninstall.ps1` 的双击包装（CRLF，失败回传非零退出码）。 |
| `check-spec.mjs` | DSH 插件规范自检（入口文件 / BOM / patch 格式 / client externals / 策略示例），`npm run check`。 |

## 口径

- **patch 行匹配只有一条模式**（模块里的 `PatchRowPattern`）：允许行首任意空白、整行锚定 `- id: surface-gate`（容忍行尾注释）。安装判定、卸载摘除、回读校验三处共用；历史版本写坏的顶层裸行同样命中，写前会迁移成 `- insert:` 形状。
- **安装顺序**：旧源码只在新内容复制并校验通过后才移入备份；失败按日志分阶段逆操作（先拆新建物、再还原被移走/覆盖的路径、最后重建链接），不留悬空 junction。
- **备份**：`<种类>.<yyyyMMddTHHmmssfff>[-序号]`，例如 `manifest.20261121T143012345`、`source-preinstall.<stamp>`、`node-modules-removed.<stamp>`、`source-removed.<stamp>`。每个种类保留 `-KeepBackups` 份（默认 3），自动清理最旧。
- **试运行**：`-DryRun` 输出五项预检（运行状态、可写、磁盘余量、同卷、junction 权限），文件系统零字节写入。
- **进程检测**：判定手段不可用时默认拒绝写操作；确认实例已关闭后可显式 `-Force`，会打印诚实告警。
- **DSH home**：显式参数 -> 环境变量 `DSH_HOME` -> profile 推导 -> 用户目录 `~/.dsh`；与运行时（`DSH_HOME`）不一致时告警；策略种子（`gate.json`）种到运行时真的会读的目录（`DSH_HOME` 优先，未设置时才用本次 home）。
- **编码**：PowerShell 脚本 UTF-8 with BOM（5.1 需要，否则中文注释按 ANSI 读会 parse 失败）；`.cmd` 一律 CRLF；写 package.json / cordis.patch.yml 一律无 BOM（`UTF8Encoding($false)` 与 node `Buffer`）。

## 已知边界

- profile 的 `cordis.patch.yml` 若**不以换行结尾**，安装会先补一个换行；卸载回到的是补过换行的等价形式（仍是合法 YAML）。夹具与真实 profile 都带尾换行，正常往返逐字节一致。
- 空文件或无内容的 patch 文件卸载后归一为 `[]\n`（语义相同、宿主可解析）。
- `package.json` 由 node `JSON.stringify(doc, null, 2)` 往返；要保持逐字节往返，profile manifest 需有 `dependencies` 对象（DSH 生成的 profile 都有）。
