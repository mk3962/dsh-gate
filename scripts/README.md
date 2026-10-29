# scripts

| 文件 | 作用 |
|---|---|
| `install.ps1` | 安装到某个 DSH profile：源码进 `<DSH home>\local-plugins\dsh-gate`、`node_modules` 建 junction、写 `bundles` + `dependencies`、补 `cordis.patch.yml` 行级开关。支持 `-DryRun` / `-Force` / `-Profile` / `-GateHome` / `-BackupRoot` / `-Source`。 |
| `uninstall.ps1` | 与安装对称的回滚：摘 `bundles`、删 `dependencies` 条目、删 junction、源码移入备份、只删自己写的 patch 行。`gate.json` 默认保留。 |
| `activate.cmd` | `install.ps1` 的双击包装（带 pause，便于看输出）。 |
| `rollback.cmd` | `uninstall.ps1` 的双击包装。 |
| `check-spec.mjs` | DSH 插件规范自检（15 项），`npm run check`。 |

两个 PowerShell 脚本都是 **UTF-8 with BOM**：Windows PowerShell 5.1 会把无 BOM 的 UTF-8 当 ANSI 读，
中文注释会让整份脚本 parse 失败（32 个语法错误）。改脚本时别把 BOM 弄丢。

`uninstall.ps1` 不会搬走仍被**同一 DSH home 下其它 profile** 使用的共享源码 —— 否则会把那些 profile 的 junction 弄成悬空。
