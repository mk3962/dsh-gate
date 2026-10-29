# Changelog

版本号遵循语义化版本；格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.5] — 2026-10-29

### Fixed
- 技能闸门在 `skills.tier = 1` 时提前返回，导致技能名单永不记录、UI 技能列永远为空。现在先记录名单再判档位。
- `rememberSkills` 增加名单比对：名单未变时跳过重算，避免每一步都全量 reapply。
- 段落被摘除后不再从清单里消失：`recordSections` 改为并集合并并立即重算。

### Added
- `gate_status` 输出补 `ownNames` / `catalogChars` / `sections` / `skills`，并同步 `output.schema`（此前真机会被宿主判 `ToolCallError: additionalProperties`）。

## [0.1.4] — 2026-10-29

### Fixed
- 多会话进程里 `/api/dsh-gate/state` 取错会话（取 Map 插入序第一个 = 最早恢复的会话），导致 `loaded` 恒为空、面板显示别的会话的分层。现在按 `touchedAt` 取最近活跃的 agent。

### Added
- `GET /api/dsh-gate/state?agent=<id>` 点名查询；未知 agent 返回 404 与已知列表。

## [0.1.3] — 2026-10-29

### Security
- `/api/dsh-gate/*` 改为宿主 `connection` 服务的 `requestRejection` 主门（与宿主 API 同一套 Host / Origin / Sec-Fetch-Site + `dsh web` 启动 token / `dsh-auth-*` cookie 判定）；取不到服务时 fail-closed。
- `POST /api/dsh-gate/policy` 额外要求 `content-type: application/json`，否则 415。

### Fixed
- 保存策略时静默丢失 `catalog` / `protected` 字段（改为与磁盘既有内容浅合并）。
- 策略文件路径只认 `DSH_HOME` 环境变量，桌面版不设该变量，导致读不到 `<home>/gate.json`（改为回退 `~/.dsh`）。
- 非法层值（`null` / `""` / `false`）被 `Number()` 静默转成 0 把工具关掉；现在只接受 0 / 1 / 2。
- `enabled: false` 只停止新增限制，不撤销已有限制。

## [0.1.2] — 2026-10-29

### Fixed
- 安装脚本只写 `dsh.profile.bundles` 不写 `dependencies`：插件能跑，但在「插件 → 已安装」里不出现，无法开关与卸载。
- 进程检查全局匹配 `*DeepSeek*`：只要用户开着任意 DSH 实例就永远装不了 / 卸不了。

## [0.1.1] — 2026-10-29

### Fixed
- `gate_status` 的 `output.schema` 与实际返回值不一致（真机 `ToolCallError`）。
- `tools/change` 自激回环；`callThrough` 不置 `applying`，每次 `gate_call` 多两轮全量重算。
- UI 把 agent 自身注册的工具（`own` 层）显示成「按需」，且渲染了无效的层按钮。
- `selftest` 的 `check` 不 await，两处 async 用例是空断言。

## [0.1.0] — 2026-10-29

### Added
- 首次发布：工具 / 段落 / 技能三层策略、`gate_status` / `gate_search` / `gate_load` / `gate_call` 四个闸门工具、`<gate-catalog>` 目录段、插件管理器内的三列 UI 面板。
