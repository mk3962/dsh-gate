# dsh-gate · 两层提示词表面闸门

> 给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）用的插件：把提示词表面 —— **工具声明 / 系统提示词段落 / skill 目录** ——
> 切成「常驻」和「按需」两层。按需那层不进工具表，只在 `<gate-catalog>` 目录里留一行；
> 模型需要时用 `gate_load` 提上来：native 会话下一步直接可调；PTC 会话把声明追加到消息末尾、
> 用 `gate_invoke` 执行，之后的追加加载不改系统提示词一个字节。
>
> 实测（DSH 桌面版 + 137 个工具）：首轮请求 **48.6K → 31.7K token，省 34.8%**。

MIT License · 需要 DSH ≥ 0.1.7-rc.1 · Node ≥ 20 · 离线可测（自测 / 加载 / 委派收窄 / 限制对象 / 快照 / 归层 / 策略 / 对外面 / 末尾注入）

[![CI](https://github.com/mk3962/dsh-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/mk3962/dsh-gate/actions/workflows/ci.yml)

---

## 为什么需要它

DSH 的固定系统提示词里，**工具声明是最大的一块**。本机实测：

| 组成 | token | 占比 |
|---|---:|---:|
| 工具声明（137 个工具） | 36,339 | 83.4% |
| 其余固定提示词 | 7,213 | 16.6% |
| **合计** | **43,552** | 100% |

而一次任务里真正被调用的工具通常只有十几个。剩下的上百个工具声明，每轮都在付钱、挤占上下文。

dsh-gate 不改宿主的任何代码，只做一件事：**没被用到的工具，先别写进工具表**。
它利用的是 `tools.restrict({deny})` 的真实语义 —— 被 deny 的工具从 `view(scope).visible` 消失，
PTC 的 SDK 声明段是按 `sdkSchemas(scope)` **现渲染**的，所以隐藏工具等于声明段直接变短，
而不是在提示词里写「请忽略以下工具」（后者照样占 token）。

## 三层模型

| 层 | 名字 | 行为 |
|---|---|---|
| **T1** | 常驻（resident） | 照常进工具表，模型直接可调 —— 放高频工具 |
| **T2** | 按需（on-demand） | 从工具表里 restrict 掉，只在 `<gate-catalog>` 里留「名字 — 一句话」 |
| **T0** | 关闭（off） | 既不进工具表也不进目录 —— 放完全不该被模型看到的东西 |

配套五个**永远常驻**的闸门工具：

| 工具 | 作用 |
|---|---|
| `gate_status` | 看当前分层、目录体积、段落清单、已加载的工具 |
| `gate_search <query>` | 在按需工具里按名字/描述检索 |
| `gate_load <names>` | 把按需工具提到常驻（当前会话内保持）；`section:` 前缀把段落搬到末尾声明 |
| `gate_invoke <tool> <arguments>` | PTC 冻结下的唯一执行口：走宿主完整执行管线执行一个已加载工具，不把声明加回工具表 |
| `gate_call <name> <args>` | 临时撤限制 → 走宿主完整执行管线 → 立刻恢复，用于一次性的重型工具 |

> `gate_call` 与 `gate_invoke` 的区别：前者按**任意已知工具**执行、不要求先 `gate_load`（一次性重型工具）；
> 后者只执行**已加载 / 常驻**的工具（未知或上游隐藏的会被拒），是冻结下日常调用的口子。

### 两种会话模式：native 与 PTC

| 模式 | 怎么认出来 | `gate_load` 之后 |
|---|---|---|
| **native** | 执行器 `constructor.name` 是 `NativeToolExecutor`，或 `describe().schemas` 不止 `run_code` | 0.1.8 行为：下一步工具直接进工具表；加载的段落回系统提示词 |
| **PTC** | 执行器 `constructor.name` 是 `PtcExecutor`，或 `describe().schemas` **恰好只有** `run_code` | **工具表冻结**：加载的工具不进工具表，声明以一条 user 消息追加到消息末尾，用 `gate_invoke` 执行 |

判据拿不到执行器 / 认不出类型 → **fail-open**：按 native 处理（不冻结、不启用尾部声明）。
判定结果在 `gate.snapshot()` / `GET /api/dsh-gate/state` 的 `executor: { kind, reason }` 与 `frozen` 里
（`gate_status` 的 18 键形状是前缀缓存约束的一部分，**不**加这两个字段）。两种模式的目录、deny 集合、
面板计数完全相同，差别只在「加载之后怎么用」。

## 效果（同一台机器、同一 profile、首轮只说「只回复两个字：收到」）

| | 未启用 | 启用 dsh-gate | 变化 |
|---|---:|---:|---:|
| 首轮总 token | 48.6K | 31.7K | **−16.9K（−34.8%）** |
| 其中系统提示词段 | ≈37.3k | ≈19.4k | −48% |
| 工具定义段 | ≈628 | ≈628 | — |

数字来自 dsh-context 的「当前上下文」面板与每轮真实用量，不是估算。
工具越多、MCP server 越多，收益越大（MCP 工具最占声明体积）。

---

## 安装

### 方式 A：Windows 桌面版，一条命令（推荐）

```powershell
# 先看计划，不动任何文件
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -DryRun

# 真装（目标 profile 的 DSH 必须先退出）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
```

默认装到 `~\.dsh\profiles\desktop`，可用 `-Profile` 指定别的 profile（例如隔离测试实例）。
脚本做四件事，**缺任何一件界面就会「看不到插件 / 不能开关 / 不能卸载」**：

1. 源码复制到 `<DSH home>\local-plugins\dsh-gate`（pnpm remove 删不到的位置）；
2. `<profile>\node_modules\dsh-gate` 建成 **junction** 指向它；
3. `package.json` 同时写 `dsh.profile.bundles += "dsh-gate"`（决定被加载）与
   `dependencies["dsh-gate"] = "link:../../local-plugins/dsh-gate"`（决定可被管理）；
4. profile 的 `cordis.patch.yml` 追加 `- insert:` 块（内含 `- id: surface-gate` / `name: dsh-gate` / `disabled: false`），
   让官方行级开关能落到它头上 —— 顶层必须写 `- insert:`，裸 `- id:` 会让宿主解析崩掉（崩溃陷阱 #3）。

> 为什么必须写 `dependencies`：宿主判定「已安装」只看 profile `package.json` 的 dependencies
> （`dsh-plugin-manager` → `installed = dependencies.includes(name)`），
> 而前端列表还会把 `installed=false && official=false && error===undefined` 的行整条丢掉。
> 只写 bundles 的插件能跑，但在「插件 → 已安装」里根本不出现 —— 这是 0.1.2 修掉的真实缺陷。

脚本会：备份 `package.json` 与 `cordis.patch.yml`（默认到 `<DSH home>\backups\dsh-gate`）、
把旧源码移进备份、回读校验六项（JSON 合法 / 无 BOM / bundles 含 / 依赖含 / junction 就位 / patch 行就位）。
进程检查只看**跑这个 profile 的 DSH**，不会因为你同时开着别的实例就拒绝。

### 方式 B：手动 / macOS / Linux

```bash
HOME_DIR="$HOME/.dsh"            # 或 $DSH_HOME
PROFILE="$HOME_DIR/profiles/desktop"

mkdir -p "$HOME_DIR/local-plugins" "$PROFILE/node_modules"
cp -R . "$HOME_DIR/local-plugins/dsh-gate"
ln -s "$HOME_DIR/local-plugins/dsh-gate" "$PROFILE/node_modules/dsh-gate"   # Windows 用 mklink /J
```

然后编辑 `$PROFILE/package.json`：

```json
{
  "dependencies": { "dsh-gate": "link:../../local-plugins/dsh-gate" },
  "dsh": { "profile": { "bundles": ["...", "dsh-gate"] } }
}
```

> 用 `link:` 而**不是** `file:`：`file:` 依赖执行 `pnpm remove` 时会连源码目录一起删掉。

### 方式 C：官方界面「插件 → 添加插件」（不用脚本，已实测）

侧栏 **插件** → 右上 **添加插件** → **安装第三方插件** → 填一个**绝对路径**（或 GitHub 仓库地址）→ **安装**
→ 安装完成对话框里点 **立即启用** → 重启该 profile 的 DSH。

实测（2026-10-30，隔离实例 gate-test）：填入 `D:\dsh-gate-test-home\local-plugins\dsh-gate` 后，宿主跑的是
`pnpm add link:<该路径>`，`package.json` 写入 `dependencies["dsh-gate"] = "link:D:/…/dsh-gate"`、
`node_modules\dsh-gate` 是符号链接；**「立即启用」**把 `dsh-gate` 推进 `dsh.profile.bundles`（36→37）。
重启后插件正常挂载：`/api/dsh-gate/state` 200（可见 179 / 常驻 14 / 按需 174 / 目录 3960 tokens），
卡片可开关、可卸载、可配置 —— 和方式 A 的结果一致，只是不写 `gate.json`、不动 `cordis.patch.yml` 行。

注意：

- **必须绝对路径**：相对路径 / `~` 会被宿主拒绝（`a local path must be absolute`）。
- 源码目录要**留着**：`link:` 只是符号链接，删了源码插件就加载不了。建议先固定放到
  `<DSH home>\local-plugins\dsh-gate`（和方式 A 同一个位置），再把这个路径填进对话框。
- 安装那一步**不会自动启用**，必须再点一次「立即启用」（漏了就会看到卡片但显示未启用）。
- 本插件没有 `prepare`/构建脚本，所以 **Git 地址也能直接装**（宿主按 `kind: git` 走 `pnpm add <地址>`，
  会把仓库拷进 `node_modules`，升级＝卸载后重装）。npm 包名暂时用不了：还没发布到 npm。
- pnpm 会对 `link:` 依赖报一条 peerDependencies 警告（`@deepseek-ai/dsh-tools` 不从目标 node_modules 解析）——
  无害，该模块由宿主 loader 提供。
- **不写 `gate.json` 也能用**：没有策略文件时按内置默认（能力默认按需 + 9 个基础原生工具常驻）；
  第一次点「保存策略」才会在 `<DSH home>\gate.json` 落地。

### 装好之后

重启该 profile 的 DSH：

- 日志里应有 `dsh-gate: 已挂载 agent … — 可见 N，常驻 M，按需 K，隐藏 J`
- 侧栏 **插件 → 已安装** 里出现 dsh-gate 卡片，可开关、可卸载、可配置
- 卡片详情 → `surface-gate` 行 → **配置** = 两层面板

首次启动如果没看到面板，**刷新一次页面**（插件自带的 client bundle 需要重新拉取）。

---

## 使用

### 面板

「插件 → 已安装 → dsh-gate → surface-gate 配置」是一页三列：**常驻 / 按需 / 关闭**。
点工具上的按钮即在三层间移动；底下还有一列**实测的系统提示词段落清单**（名字 + token 体积，来自每轮 assemble 的真实快照），
点「摘除」把它降到按需。

「保存策略」写回策略文件（按字节写无 BOM UTF-8），**下一轮生效**，不需要重启；
段落/技能改动同样下一轮生效。

> 归层以服务端权威表 `state.tiers` 为准。`run_code`、五个 `gate_*`、团队工具这类
> **agent 自身注册**的工具（`state.own`）标「自身层」：`restrict` 管不到它们，永远常驻，面板不给无效按钮。

0.2.0 起另有 `GET /api/dsh-gate/capabilities`（能力视图：来源置信度 / 命中链 / 例外偏离 / 上游隐藏），
面板暂时还是三列；按能力切换的 UI 在工单 05。

### 策略文件

优先级：`<DSH_HOME>/gate.json` > 插件行 `config` > 内置默认，**逐键**比较（`gate.example.json` 就是可直接用的默认策略）。
文件里写了的键以文件为准；文件没写的键回落到插件行 config；两者都没有才用内置默认。

```json
{
  "version": 3,
  "enabled": true,
  "freezePtcToolset": true,
  "defaults": { "capability": 2, "section": 1, "skillpack": 2 },
  "capabilities": {
    "native:read": { "tier": 1 },
    "plugin:dsh-univer-office": { "tier": 2 },
    "mcp:context7": { "tier": 2, "toolExceptions": { "mcp__context7__resolve": 1 } }
  },
  "sources": { "plugin:dsh-gate": { "tools": ["gate_status", "gate_load"], "sections": ["gate-catalog"] } },
  "legacy": { "unknownOverrides": { "ws_mcp_call": 1 } },
  "catalog": { "groupByPlugin": true, "maxDescriptionLength": 64, "skillGroups": false },
  "narrowPassThrough": 12,
  "protected": [],
  "skills": { "takeover": true, "off": [], "imports": [{ "id": "local", "path": "~/skills" }] }
}
```

- 开关单位是**能力**（一个来源实例），不是单个工具：`mcp:<server>`（工具 `mcp__<server>__*` + 段落 `mcp:<server>`）、
  `plugin:<包名>`、`native:<tool>`（原生工具彼此独立，不并组）、`tool:<name>`（推不出来源：只标注，不合并、不隐藏）、
  `section:<name>`。改一个能力档 = 同时改工具与段落两条限制，不会留下「有工具没段落」的半截状态。
- 例外 `toolExceptions` / `sectionExceptions` 是唯一允许「同能力不同档」的地方，只能显式写；读回自动标 `deviation`。
  成员名支持 `*` / `?` 通配，多条命中取**最具体**的一条。
- `sources` 是显式来源映射（键 = 能力 id，值 = 成员名，支持通配）：包前缀推断错了用它纠正，
  推断出来的插件来源置信度是 low，UI 会提示。
- 解析顺序：own → preset → protected → 显式 `sources` → 命名推断 → 能力档 → 例外 → `defaults`。
- `legacy.unknownOverrides` 只展示告警、不参与解析（v2 里 `ws_mcp_call` 这类已经找不到对应能力的键落在那里）。
- `version: 2` 的旧文件**自动迁移**：首次读取先在旁边写一份 `gate.json.v2.bak-<时间戳>`（原文件不改），
  同能力档位冲突取最宽松、其余成员写成例外；首次保存时落盘 v3。回滚到 0.1.8 前先把备份复制回 `gate.json`。
- 优先级**逐字段**一致：文件里写了的字段以文件为准，没写才回落到插件行 `config`，最后才是内置默认。
- `freezePtcToolset`（默认 `true`）：PTC 会话是否启用「工具表冻结 + 末尾声明」。设 `false` 退回 0.1.8 的加载语义
  （`gate_load` 直接改工具表），用于调试或上游执行器判据不稳时；native 会话不受这个键影响。
- `run_code`、五个 `gate_*`、以及 `protected` 里的名字**任何策略都动不了**（`restrict` 点名 `run_code` 会直接抛错）。
- 策略文件读坏 / JSON 解析失败 → **fail-open**（全部常驻）：宁可没省 token，也不让会话崩。
- 非法层值（`null` / `""` / `false`）按默认处理，不会被 `Number()` 静默转成 0 把工具关掉。
- `narrowPassThrough`（默认 `12`，读法与其它键一样逐键比较：`gate.json` 点名 > 插件行 config > 内置默认）：
  **被委派出去的子代理**（`session.header.origin === "subagent"`）如果本来只被授予个位数工具
  （去掉 agent 自己这一层 own 工具后的可见数），闸门整体跳过它 —— 在个位数工具面上藏东西省不到 token，
  却会把「委派协议的必需工具」一起剥光。`0` = 关闭豁免（子代理也照策略藏）。
  典型受害者：`dsh-mnemon` 的写记忆子代理（白名单只有 `mnemon_*` + `mnemon_subagent_result`），
  被藏掉后子代理只能纯文本收尾，父会话抛 `memory subagent completed without recording its result`。

### 技能接管（0.3.0）

0.3.0 起闸门把**技能注入**也收进自己手里（不再只靠宿主把目录塞进系统提示词）。默认开启，策略键：

```json
"skills": {
  "takeover": true,
  "off": ["某个不想让模型用的技能名"],
  "imports": [{ "id": "local", "path": "~/skills" }]
}
```

- `takeover`（默认 `true`）：宿主 `skill` 工具被**无条件 deny**（即使 `capabilities` 里把 `native:skill` 写成常驻），
  宿主的技能目录消息（含它发现「没有技能可用」时补发的 `entries=[]` replacement）与 `/name` 显式调用正文
  都按 `source.kind` 摘掉；目录由 `<gate-catalog>` 的 `[技能]` 组给（名字 + 描述首句 + 来源），
  正文由 `gate_load(["skill:<name>"])` 返回。
- 档位解析顺序：`skill:<name>`（单技能）→ `skillpack:<provider>`（同一来源的技能包）→ `defaults.skillpack`。
  `0` = 关闭（不列目录、`gate_load` 返回 denied）、`1` = 常驻、`2` = 按需。
  单技能条目永远压过技能包（「这一条单独关掉」是最具体的意图）。
- **常驻（1）**：正文以 `<skill_content name="…">` 包装，作为独立段落 `gate-skill:<name>` 追加在系统提示词末尾，
  `interpolate: false`，不进 `<gate-catalog>` 行。同一策略下逐字节稳定；单条超过 12000 字会截断并告警
  （`skill-too-long`），全文随时可以 `gate_load`。
  **常驻正文只接受显式单技能条目**（`capabilities["skill:<name>"]={tier:1}`）；组级/默认常驻
  （`skillpack:<provider>=1` 或 `defaults.skillpack=1`）会降级为按需（`reason: resident-group`），
  只列目录、不灌正文 —— 旧 v2 的 `skills.tier=1` 也是「保留目录」，迁移时同样降为 2 并告警。
- **按需（2）**：只在目录里列一行，模型 `gate_load(["skill:<name>"])` 才拿到正文（native / PTC 都一样，
  正文走工具结果，不再追加尾部块）。
- **关闭（0）**：不列、不加载；用户 `/name` 显式点名也不会注入正文。`gate_search` 也不列它
  （想恢复就去面板能力视图找 `skill:<name>` 那一行改档）。
- `imports` 让闸门把**本地技能目录**也接进来（不依赖宿主注册）：目录含 `SKILL.md` 算一个技能；
  目录下多个子目录各含 `SKILL.md` 算多个；单文件 `*.md` 也支持；符号链接目录照常跟随（断链跳过）。
  frontmatter 的 `name` / `description` 自解（支持 `|` / `>` 块标量），正文是 frontmatter 之后的部分。
  单个技能文件超过 1 MiB 拒绝读取并告警（不静默截断正文）。相对路径以策略文件所在目录为基准，
  `~/` 展开到家目录。
- **`/name` 手势**：宿主技能与导入技能都支持——导入技能宿主不认识，闸门会按「整条正文就是一个 `/技能名`」
  的严格词法自行识别（只是正文里提到 `/xxx` 不算）。
- **同名冲突**：宿主优先。同名导入条目标 `shadowed`（`/api/dsh-gate/capabilities` 的 `skills` 行带
  `origin` / `path` / `tier` / `shadowed`），并 warn 一次；导入之间同名也是先声明的赢。
- **逃生门**：`"takeover": false` 完整退回 0.1.8 —— 宿主照常注入目录、`skill` 工具照常可见、
  `gate_load(["skill:x"])` 照旧转发宿主 `skill` 工具，闸门只按 `defaults.skillpack` 决定要不要摘目录。
- **不完整名单**：宿主 `skills.snapshot()` 返回 `complete: false`（provider 发现超时/被 abort）时，
  闸门沿用上一份可用名单并告警一次，不拿部分名单覆盖（否则技能会先消失再回来，两次改字节 = 两次断缓存）。
- **旧会话残留**：升级前就存在的会话里，历史中的旧技能目录消息（`source.kind=skill-catalog`）已经写进
  durable 事件，`pre-step` 只过滤本轮消息、改不了历史。这类会话恢复后可能同时看到旧目录与
  `<gate-catalog>`；**以 `<gate-catalog>` 为准**（旧目录是历史记录，不再更新）。
- 与宿主 UI 的边界：宿主自己的技能面板/按钮只认宿主注册的技能，看不到 `imports` 进来的条目；
  闸门面板的技能列（`/api/dsh-gate/state` 的 `skills`）是**gate 可见名单**（宿主 + 导入 − `off` − `shadowed`），
  能力视图 `/api/dsh-gate/capabilities` 才带来源、路径与被遮信息。改 `skills` 策略后下一轮生效。

### MCP 接管（0.3.0）

0.3.0 起闸门可以**自己挂 MCP server**：在 `gate.json` 里声明，gate 启动时用宿主同款
`mcp-client` 插件逐台挂载；工具照旧走 `mcp__<serverName>__*` 命名空间，也照旧受能力档
（`mcp:<serverName>`）管理 —— 默认为「按需」，被藏进第二层后由 `gate_load` / `gate_invoke` 打开。

```json
"mcp": {
  "servers": {
    "files": { "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "remote": { "transport": "streamable-http", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer …" } }
  }
}
```

- **声明即接管**：`enabled`（默认 `true`）为假的条目不挂；其余在插件 apply 时由 gate 并发挂载。
  连接失败只降级成 `unavailable` 并 warn，**不阻塞宿主启动、不抛到 gate 主链路**（`failOnStartupError` 恒 `false`，
  mcp-client 自己重连；工具出现后状态自动翻成 `owned`）。
- **一条坏配置不拖垮整份策略**：`mcp.servers` 逐项用 `lib/mcp.js` 的 `normalizeServerConfig` 校验
  （`serverName` 限 `[A-Za-z0-9_-]{1,32}`，stdio 要 `command`，streamable-http 要 `url`）；非法条目丢弃并告警。
- **保存语义**：POST 提交了 `mcp.servers` 就**整表替换**（删除真的生效），不逐项拼。gate.json 永不写 BOM。
- **外部 server 只读**：宿主 `loader` 行里已经有的 mcp-client（比如用户在插件市场装的）只**观察**，
  列进清单并标 `external` / `owned:false`；gate 绝不 dispose 或改它的配置（`dispose` 会写回 `disabled:true`）。
  同 `serverName` 或同 `mcp__<name>__*` 命名空间已被占用时，自挂直接拒绝（`conflict`）。
- **UI / API**：`GET /api/dsh-gate/mcp` 返回 `{ servers, warnings }`，每行
  `{ name, transport, target, state, enabled, owned, toolCount }`；`state` 为 `owned`（gate 挂着）/
  `unavailable`（挂了但没工具/重连中）/ `external`（宿主托管）/ `stopped`（声明了但没挂）。
  `POST /api/dsh-gate/mcp` 接受 `{ action: "add" | "update" | "remove" | "enable" | "disable", name, server? }`：
  校验通过后先写 `gate.json`（复用 `/policy` 的保存路径），再 mount / update / unmount，最后重算全部 agent 的限制。
- **限制**：挂载会 `await` 初始连接（多个 server 并发，不会串行叠加等待）；`update` 是「先卸再挂」，
  新配置启动失败不会回滚旧实例；loader 行识别依赖包名 `dsh-mcp-client`；宿主没有连接状态 API，
  「有没有工具」是唯一的连接证据。

### 语义边界（都是实测的宿主行为）

| 事项 | 行为 |
|---|---|
| 被隐藏的工具 | 不在 SDK 声明里，调用返回 `UNKNOWN_TOOL` |
| `gate_load` 之后 | 当前会话内保持常驻，同一 agent 的后续步骤立即生效 |
| `gate_call` | 临时撤限制 → 宿主完整执行管线（含 pre-execute 守卫）→ `finally` 立刻恢复 |
| PTC 会话的 `gate_load` | 工具表冻结：名字仍在 deny 集、工具表字节不变；声明追加为**最后一条 user 消息**（`<gate-loaded>` / `<gate-section>`），已有消息不改、不重排 |
| `gate_invoke` | 冻结下的日常执行口：临时撤限制 → 宿主完整管线（含 `defineTool` 参数校验）→ `finally` 恢复；宿主侧错误以 `{ isError: true }` 返回 |
| 追加加载段落（PTC） | 系统提示词**逐字节不变**；段落正文搬进末尾声明；`<gate-catalog>` 也继续保留该段落 |
| 尾部声明的位置与幂等 | 宿主交给 `agent/pre-step` 的只有**本轮新 claim 的消息**（历史不回灌），返回数组只会 `append` 进会话表面 ⇒ 「复用同一条消息」做不到。0.3.1 起按内容去重：**清单没变就一条都不追加**；清单变了才追加一条新的（旧块留在历史里，自然过时）。有 `agent.session` 时还按会话表面判断，声明被压缩掉后会自动补一条 |
| 技能（0.3.0 接管） | 宿主 `skill` 工具进 deny；目录消息与 `/name` 正文按 `source.kind` 摘掉后由闸门重出（常驻进系统提示词独立段落、按需进 `<gate-catalog>`、正文走 `gate_load`）；`off` 的技能不列不载，`/name` 也不注入 |
| MCP server（0.3.0 接管） | `gate.json` 的 `mcp.servers` 由 gate 自挂（`ctx.plugin(mcp-client)`）；宿主 loader 行里已有的只观察、不 dispose；工具照旧按 `mcp:<server>` 能力档归层 |
| 子 agent | 继承同一套全局策略；闸门按 agent 分别记账。**例外**：`origin=subagent` 且授予工具数 ≤ `narrowPassThrough` 的子代理整台跳过闸门（见「策略文件」），`gate_status.passthrough` 可查 |
| 工具热插拔 | 监听 `tools/change` 重算限制，不会留下过期 deny |
| 插件卸载 | 所有 `restrict` 的 disposer 挂在插件 fiber 上，卸载即全部撤销 |

---

## 安全模型

插件自带两条本地 HTTP 路由（面板数据 + 保存策略）：`GET /api/dsh-gate/state`、`GET|POST /api/dsh-gate/policy`。
它们**绕开宿主的 SPA/认证中间件**，所以鉴权由插件自己做，两道门：

1. **主门**：宿主 `connection` 服务的 `requestRejection(req)` —— 与宿主 API 完全同一套判定
   （Host / Origin / Sec-Fetch-Site 围栏 + `dsh web` 启动 token / `dsh-auth-*` 签名 cookie）。
   **取不到服务或鉴权抛错时 fail-closed（按 403 拒绝）**，绝不放行。
2. **兜底门**：宿主没有 `connection` 服务时启用 —— 只接受回环来源、Host 头必须是回环名（防 DNS rebinding）、
   `Origin` / `Sec-Fetch-Site` 必须同源，并 warn 一次。

两条路由都额外要求 POST 带 `content-type: application/json`（否则 415）。
保存时与文件既有内容**浅合并**，不会把 `catalog` / `protected` 之类的字段抹掉。

插件本身**不发任何网络请求**，不收集遥测，不读写策略文件以外的文件。

### catalog.skillGroups（0.4.1）

技能行默认**逐条**列进 `<gate-catalog>`（名字 + 描述首句 + 来源）。设为 `true` 时按来源折叠成一行：
`- [技能] 宿主:mattpocock 16 条：a, b, c…`。

- **收益**：本机 57 条技能 / 7 个来源，技能段从 5,585 字符降到约 1,550，净省约 **1,080 tok / 请求**。
- **代价**：折叠会改 `<gate-catalog>` 的字节，**从该段起前缀缓存失效一次**。
- **默认关闭**（`false`），不打开时与 0.4.0 逐字节一致。只有严格 `true` 才生效（`"true"` / `1` 不算）。
- 折叠后技能仍可被 `gate_search` 按名字、说明与中文别名逐个命中（0.4.1 的别名字典已覆盖这一点）。

---

## 兼容性与已知限制

- **`gate_load` 只看本插件的候选集，不复核别人的 `restrict`**（0.4.1 复核结论）：别人藏掉、
  本插件候选集里还在的名字会被报成「已加载」，直到 `gate_invoke` 走宿主 `executable()`
  得到 `UNKNOWN_TOOL` 才暴露。修它要么在热路径上每次撤一次限制（重开 0.3.4 堵上的
  重载泄漏口子），要么做成 `gate_invoke` 错误路径上的自愈 —— 目前选择**不修**，因为
  两套 deny 重叠时本机结构上触发不了，且失败是一次明确报错而不是错误执行。
- **两类工具平面**（v0.1.6 起说清楚，旧文档写反了）：
  - **全局层**：插件注册的工具（MCP 工具、`ws_mcp_call`、office/univer 之类）与宿主全局注册的工具 ——
    闸门默认**全权管理**（默认层 + `overrides` 说了算）。
  - **preset 平面**：`pwsh` / `read` / `write` / `edit` / `grep` / `glob` / `web_search` / `web_fetch` / `skill`
    这些由 **agent preset**（`@deepseek-ai/dsh-web-app/presets/{ptc,standard}.patch.yml`）注册在 agent 祖先层。
    它们**确实存在、也确实能调**（PTC 会话里实测 8/8 全在），但 v0.1.5 及以前的候选集只读全局视图，
    于是"看不见、管不到"，`gate.json` 给它们写的层像个死键 —— 旧文档据此误写成"根本不存在"。
    v0.1.6 起它们进候选集，但**默认不受管**（保持常驻、不写 deny）：只有你在 `overrides` 里点名
    （例如 `"read": 2` 把它贬成按需），闸门才真正对它们生效。UI 上这类工具带「预设层」标记。
  - 技能面同理：`skill` 工具存在且可点名受管。0.3.0 起默认由闸门**接管**（`skills.takeover`，见「技能接管」）：
    宿主工具被 deny、目录/正文由闸门出；`takeover: false` 时退回 0.1.8（面板技能列只在宿主真的注入目录后非空）。
- **段落面**依赖宿主每轮 assemble 的真实快照；宿主大版本改段落渲染时可能读不到（会 fail-open）。
- **`gate_load` 的粒度是「下一步」**：SDK 声明在每一步开始前渲染好，所以同一个 `run_code` 程序体内
  紧跟 `gate_load` 再调该工具仍会 `tools.<name> is not a function`（真机实测），下一步才可用。
  PTC 冻结下同一程序体内**立即可以** `gate_invoke`（它不依赖工具表，走的是执行管线）。
- **PTC 冻结的已知代价**：`gate_invoke` 每次调用会临时 `suspend` 再 `reapply`（发出两次 `tools/change`；
  `applying` 窗口内不重算，但订阅者会收到事件）。尾部声明的函数签名是**退化渲染** ——
  复杂 schema 只到 `array<object>` / `object` / `any`，参数校验仍由宿主的 `defineTool` 负责，
  参数不对会得到 `{ isError: true, text: "Error: … should be string" }` 而不是崩溃。
- **PTC 判据依赖执行器实现**：`constructor.name` 是 dist 里的实现细节，宿主演进后认不出会 fail-open
  （不冻结、不启用尾部声明），原因在 HTTP 快照的 `executor.reason`；语义判据 `describe().schemas` 是第二道保险。
- **反复 `gate_load` 无副作用**：PTC 下已加载的工具不会再进目录，声明只按当前清单重渲染。
- 目录里每条描述按 `catalog.maxDescriptionLength`（默认 64 字）截断。
- **段落行的说明永远是空的**（已知问题）：`recordSections` 只记 `{name, chars, tokens}`，目录渲染却读 `entry.summary`，
  所以 `<gate-catalog>` 里段落行只有名字、没有那句摘要。修它会让目录字节变化 ⇒ 从那一段起前缀缓存失效，另开票处理。
- 本地目录插件在「插件市场」的**更新**按钮不可用（没有 registry 版本可比）—— 升级走重新跑安装脚本 / 重新 `link:`。

---

## 开发

```bash
npm run check     # DSH 插件规范自检（入口文件、BOM、patch 格式、client externals…）
npm test          # 全部套件（自测 / 加载 / 委派收窄 / 限制对象 / 快照 / 归层 / 策略 / 迁移 / 能力 / 对外面 / 末尾注入），离线跑，不碰真实宿主
npm run verify    # 上面两个一起
```

测试用一个共享宿主 seam `test/host.mjs`（`makeHost`）复刻宿主的 `view / restrict / execute / assemble /
pre-step` 真实语义（含「`view()` 无 scope = 全局视图」与「preset 平面注册在 agent 祖先层」这两条关键区别）；
需要宿主的八个套件（自测 / 加载 / 委派收窄 / 限制对象 / 快照 / 归层 / 对外面 / 末尾注入）全部从它取宿主，
宿主演进只改这一处（策略表那套是纯函数，不需要宿主）。`test/vendor/dsh-tools` 只负责让裸包名 `@deepseek-ai/dsh-tools`
能解析（`--import ./test/stub-loader.mjs`），因此**不需要 `npm install`、不需要 DSH 在跑**。

### 持续集成

推送到 `main`、开 PR 或手动触发时，[.github/workflows/ci.yml](.github/workflows/ci.yml) 跑四组矩阵：

| 平台 | Node | 跑什么 |
|---|---|---|
| ubuntu-latest | 20 / 22 | `npm run check` + `npm test` |
| windows-latest | 20 / 22 | 同上，另加 PowerShell 安装/卸载脚本语法检查（`[Parser]::ParseFile`） |

一次约 1 分钟，**不需要 `npm install`**（测试自带 `dsh-tools` 替身，见下）。徽章状态见文件顶部。

---

目录说明：

```text
lib/                 host 侧：policy 解析 / gate 引擎 / 目录渲染 / 段落与技能 / HTTP 路由 / 工具代理
client/index.js      web 侧：window.__ModuleLoader__ 手接的 cjs bundle，面板 UI
cordis.patch.yml     插件自己的 bundle 层补丁（insert 一行 surface-gate）
gate.example.json    默认可直接用的策略文件
scripts/             安装 / 卸载 / 规范自检
test/                离线测试；host.mjs 是共享宿主 seam，vendor/ 只解析裸包名
docs/                架构、troubleshooting（见下）
```

细节：[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)（数据流与每个模块的职责）、
[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)（装不上/看不到/不生效的排查表）。

---

## 卸载与回退

1. **临时关掉**：面板里把工具移回常驻，或把 `gate.json` 写成 `{"enabled": false}` ——
   `enabled:false` 会**撤销**已经建立的限制，不只是不再新增。
2. **彻底卸载**：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1`
   —— 摘 bundles、删 dependencies 条目、删 junction、源码移进备份、只删自己写的 patch 行，重启即可。
3. **官方 UI 的卸载按钮**同样可用，但它走 `pnpm remove`：本地 `link:` 依赖会保留源码目录，
   却可能在 `node_modules` 里留下悬空链接。想要干净回滚仍推荐 `uninstall.ps1`。
   若 pnpm 报 `ERR_PNPM_UNEXPECTED_STORE`，见 [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)。

所有改动都可回滚：脚本在动文件前会备份，回滚 = 用备份覆盖 + 重跑 `uninstall.ps1`。

## 许可

[MIT](LICENSE)
