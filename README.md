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
| `gate_invoke <tool> <arguments>` | PTC 冻结下的日常执行口：走宿主完整执行管线执行一个已知工具（常驻 / 目录里的按需工具都行，**不必先 `gate_load`**），不把声明加回工具表 |
| `gate_call <name> <args>` | 临时撤限制 → 走宿主完整执行管线 → 立刻恢复，用于一次性的重型工具 |

> `gate_call` 与 `gate_invoke` 现在是**同一个执行口的两个键名**：同一份准入判据（已知、未被 `off`、未被上游藏），
> 同一条 `callThrough` 管线，差别只在参数键（`gate_call` 用 `name`、`gate_invoke` 用 `tool`）。两个都**不要求先 `gate_load`**；
> `gate_load` 买的是声明正文，不是调用权（展开见「PTC 语义边界」）。

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

0.2.0 起另有 `GET /api/dsh-gate/capabilities`（能力视图：来源置信度 / 命中链 / 例外偏离 / 上游隐藏）；
0.3.x 起面板分四个页签：**能力 / 技能 / MCP / 策略 JSON**。

0.5.0 起三个列表页各多一层**来源目录**：默认全部收起，点组行展开或收起，组行写「N 条 · 档位分布」，
搜索词命中时自动展开命中的组（清空搜索后回到你手动开的组）。

- 能力页按**来源类型**分组（`mcp` / `plugin` / `native` / `section` / 其它）；`native` 这一桶行数最多
  （本机 84 条），超过 24 行时桶内再按档位分两页收起。
- 技能页按 `provider` 分组，导入目录进来的归「导入」组。
- MCP 页按状态分组（自有 / 外部 / 已停 / 不可用）；只有一个状态时不折叠，平铺照旧。

技能页在**还没发第一条消息**的会话里也能列技能：服务端直接读宿主 registry 做一次预扫描
（`GET /api/dsh-gate/skills` 的 `prescan` 段），这些行带「预扫描」标记；没取到 preset 作用域时页面会明说
「provider 归属可能与装配后不同」。

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
  "catalog": {
    "groupByPlugin": true,
    "maxDescriptionLength": 64,
    "skillGroups": false,
    "signatureSummary": { "enabled": true, "tools": [] }
  },
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

`catalog.*` 是目录渲染的四个键（默认值就是内置默认，文件里写了哪个字段才覆盖哪个）：

| 键 | 默认 | 作用 |
|---|---|---|
| `catalog.groupByPlugin` | `true` | 目录按来源分组（`[mcp]` / `[univer]` / `[技能]` …）；`false` 时全部归 `[其他]` |
| `catalog.maxDescriptionLength` | `64` | 每行描述截断到多少字符 |
| `catalog.skillGroups` | `false` | 技能行按来源折叠成一行（0.4.1，见「catalog.skillGroups（0.4.1）」） |
| `catalog.signatureSummary` | `{ "enabled": true, "tools": [] }` | PTC 冻结下给点名的按需工具出一行参数摘要（0.5.1，见「目录签名摘要（0.5.1）」） |

`catalog.signatureSummary` 默认**开**、名单为空 —— 空名单时一个字都不渲染，所以「默认开」不改任何既有部署的目录字节；只有点过名的工具才会在 PTC 冻结的目录里多一行。支持布尔简写（`true` / `false`），关掉用 `false` 或 `{ "enabled": false }`（后者保留名单）：

```json
"catalog": { "signatureSummary": { "enabled": true, "tools": ["web_fetch", "univer_doc"] } }
```

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
- **技能激活转发（0.5.3，`skills.activationRelay`，默认 `true`）**：`univer_*` 14 + `office_*` 3 共 17 个工具
  曾经「目录里可见、`gate_load` 报成功、执行报 unknown tool」—— 那些插件的**技能激活门**只认宿主 `skill` 工具的
  `tools/result(exec.name === "skill")` 信号，接管后那个工具被 deny，信号永不到达。现在 `gate_load` 加载成功会在
  `reapply(agent)` 之后补发一条 `tools/result` 伪事件（`toolCallId = gate-load-skill-<name>`，失败只 warn）。
  万一有监听者把伪事件当真结果写进历史，改 `"activationRelay": false` + 重启即可止血（故意不进面板）。
  伪 exec **按真实形状发**（`callId` / `rootCallId` / `signal` / `parent`）：cordis 的 `emit` 没有 try/catch，
  宿主的 `dsh-agent-instructions` 监听者会读 `exec.signal.aborted`，少一个字段就会抛错并中断排在后面的激活门。
- **技能激活放行（0.5.4，`skills.activationPromote`，默认 `true`）**：0.5.3 只补了信号，实测仍不可执行 ——
  宿主 `dsh-tools` 的 `executable(name, scope, toolSet)` 在 `toolSet === undefined` 时对**带 `when` 的注册**
  一律返回 undefined（`dsh-tools/lib/index.js:531-535`），而 `gate_invoke` 的转发发生在 step 之外。0.5.4 两半一起修：
  ① 加载成功后把该族（技能名第一段，`univer-sheet` → `univer_*`）**conditional 工具**从 deny 放出并当常驻处理
  （下一步才会被声明、才会进 `tools.resolve()` 的 admission；explicit `off` 绝不放）；
  ② `gate_invoke` / `gate_call` 转发时，目标若是 conditional 注册，就把**本步的 `exec.toolSet`** 一起交给
  `executeToolBatch`，宿主才按 admission 解析。拿不到 `toolSet` 时给出可执行的提示（先 `gate_load`，
  下一步再调），不再原样抛 `unknown tool`。`"activationPromote": false` 可整体退回 0.5.3 行为。
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

### 重复调用护栏（0.5.3）

**为什么自己做**：宿主自带的 `@deepseek-ai/dsh-repeat-tool-reminder` 判据只有「**连续**同样调用」。PTC 会话里
`run_code`（外层）与内层 `pwsh` 交替落事件，每来一条别的调用就把链重置成 1 —— 实测一条 402 次 `pwsh` 的会话里
107 处同命令重复、最长连续 run 只有 2，**现行判据一次都没触发**。判据只能改在源码层，所以并进 gate。

```json
"repeatGuard": {
  "enabled": true,
  "windowSize": 20,
  "windowThreshold": 3,
  "maxRemindersPerEpisode": 2,
  "exclude": ["wait_agent", "todo_write", "list_agents", "job_list", "team_task_list"]
}
```

- **三道判据**：① 身份是精确签名 `(工具名, 深键序 JSON(args))` —— 换参数就是新签名，天然不触发
  （任何「家族/模糊/语义归一」都会把「换 filter 重试」的真进展判成重复）；② 相邻性换成**窗口**：
  同一签名两次出现之间允许夹 `windowSize` 条被跟踪调用；③ **结果指纹** `len + sha1(前/中/后各 4KB) + isError`：
  结果变了就是进展、episode 重置，于是「文件改了重读」「job 有新输出」不触发，而「结果一字未变」是强低效证据。
- **触发节奏**：第 `windowThreshold`（3）、6、9 … 次各一条，每个 episode 最多 `maxRemindersPerEpisode`（2）条。
  首条只给事实句 + 三个替代动作（`job_output({job_id, wait:true})` / 直接进入下一步 / 换 path-offset-filter-limit），
  第二条补上出现位置。被策略拒绝（`UNKNOWN_TOOL` / `*DENIED*` / `CANCELED`）的调用用固定哨兵进指纹 ——
  对着一个 deny 反复硬撞同样该被看见。
- **只提示不拦截**：监听 `tools/post-execute`，此刻调用已经发生，block 只能罚下一次。提醒作为一条 user 消息折在
  `additionalContexts` 最前面，下游决策（含 block）原样保留。
- **`exclude` 是透明语义**：命中的工具不计数、也不推进时钟（不打断别人的链）；支持 `*` 通配符。
  ⚠️ 默认五个（`wait_agent` / `todo_write` / `list_agents` / `job_list` / `team_task_list`）**恒在**，
  你写 `exclude` 只是往后面追加 —— 只写一个 `gate_*` 不会把轮询类放回计数。
- **提醒配额属于这条链**：结果变了只重置计数、不重置已发条数（否则「结果每次带个时间戳」的循环每轮白拿两条）。
- **用户插话即刷新**：`agent/pre-step` 看到 `source.kind === "user"` 的消息就清掉该 agent 的状态
  （跨插话的「重复」不是循环）。
- ⚠️ **打开前先停用宿主那一行**：profile 的 `cordis.patch.yml` 里加 `- id: repeat-tool-reminder` +
  `disabled: true`。护栏状态是进程内 per-agent，两套监听器同时挂 = 每条提醒发两次。默认 `enabled: false` 就是为了
  让「没做这一步的人」不会踩双提醒。
- ℹ️ 护栏配置在**挂载时读一次**：改 `gate.json` 的 `repeatGuard`（或面板保存）后要重启 DSH 才生效，
  与其它策略键一致（不是 rebug，别当故障查）。

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

### PTC 语义边界

PTC 下工具表里只有 `run_code`。冻结最容易让人把两件事混成一件：**看得见什么**（闸门改的）和**一轮能做几件**（宿主的执行模型，闸门改不了）。下面四段把这层边界说透。

**① 冻结只改「看得见什么」，不改执行模型**

一轮 = 一次模型调用 = 一个 `run_code` 程序。程序里串行、并发调多少次 `tools.名字(...)` 和 `gate_invoke` 都不产生额外往返；冻结只决定哪些名字能直接 `tools.` 调。

`gate_load` 过的工具**仍在 deny 集合里**：冻结时 `resolveTier` 把 `loaded` 恒当 `false`，工具留在第二层继续被 deny，`view(agent).visible` 不变 ⇒ `tools:sdk` 声明段逐字节不变。本机 2026-11 实测（宿主 0.2.2-rc.3，54 个 PTC 会话）：52 个会话全程只有一个声明哈希，最长 355 步的样本哈希也唯一；两个例外都来自宿主自己注册面的增删（`compress` 条件注册、`remote_*` 后注册），不是 `gate_load`。

编排能力同样没被削：30 天 1,231 个跑过 `run_code` 的 PTC 会话里 `tool/ptc-dispatch` 共 145,925 次（1.49 次/次 `run_code`），20.3% 的派遣步在同一程序体内调了 ≥2 个不同工具（最多 5 个）。

**② 常驻与按需可以混在同一段程序里**

```ts
// 常驻：工具表里本来就有，直接调
const code = await tools.read({ file_path: "lib/gate.js" });

// 按需：工具表里没有，走 gate_invoke —— 不需要先 gate_load
const policy = await tools.gate_invoke({
  tool: "mcp__<server>__<tool>",        // 目录里列着的按需工具名
  arguments: { /* 该工具自己的参数 */ },
});
```

`gate_invoke` 的准入**不是「已加载」**，而是三件事（`canInvoke` 的判据）：名字在候选集里、没被 `off` 关掉、没被上游 `restrict` 藏掉。所以目录里列着的按需工具可以直接 `gate_invoke`；`gate_load` 买的是**声明正文**（签名、描述、段落正文、技能全文），不是调用权。被关闭 / 被上游藏掉的名字会当场抛错（「已被闸门关闭」/「被上游隐藏」），未知名字报「未知工具」—— 这几条属于程序错误，值得用 `try/catch` 兜住。

> `gate_call` 与 `gate_invoke` 现在是同一个执行口的两个键名（同一份 `canInvoke` 准入、同一条 `callThrough` 管线），差别只在参数键（`name` / `tool`）。

**③ 「程序先行」：程序写死在执行之前**

`run_code` 的程序在执行前就固定了，`tools.*` 也按步渲染：同一次程序里 `gate_load` 返回的声明**只能给下一次程序用**，本次程序里 `tools.新名字` 根本不存在。没见过的按需工具有两条路：

| 做法 | 代价 | 什么时候选 |
|---|---|---|
| 盲写参数：`gate_invoke({ tool, arguments })` | 参数错就拿 `{ isError: true }`（宿主 `defineTool` 的原文报错），这一步白花 | 参数简单、名字可猜（`{ path }`、`{ query }`） |
| 先 `gate_load(["名字"])` 看签名，下一步再写程序 | 多一步（只加载、不干别的 = +1 轮） | 参数多 / 嵌套 / 枚举（MCP 工具常见） |

实测（最近 58 次加载）：44.8%（26 次）独占一步、实付 1 轮，其余 55.2% 与别的调用挤在同一步（不额外计费）—— 这就是「**交叉税**」的具体形态：非常驻工具首用要先加载，上界是每任务 +1 轮。`gate_invoke` 的 `isError` 率 1.1%（30 天 1,008 次），与原生派遣的 1.8% 同量级：盲写参数不是高危动作，但报错后应改用「先加载」。

**④ 尾块与目录的分工**

- **目录**（`<gate-catalog>`）：每请求固定注入一次，列全部按需能力（名字 + 截断描述 + 档位），技能可按 `catalog.skillGroups` 折叠。它待在系统提示最末尾，一次变化只报废尾部。
- **尾块**（`<gate-loaded>`）：只在清单变化时追加一条 user 消息。0.4.0 起只放一行「本次会话已加载 N 个：a, b, c」索引（签名已在 `gate_load` 的工具结果里给过）；清单没变就一条都不追加。

成本账（本机 2026-11 实测，PTC 常驻中位 26 工具；token 为插件自身估算式折算，不是账单口径）：

| 项 | ≈tok | 口径 |
|---|---:|---|
| 常驻声明段 | 6.3k | 23,736 字符（`estimateTokens` 折算） |
| `<gate-catalog>` | 3.1k | 150 条 / 11,670 字符 |
| **固定注入合计** | **9.4k** | 上两项相加，每请求重付 |
| 未启用时全量声明 | 36.1k | 145 工具 / 134,866 字符（10 月未冻结样本） |
| **净省** | **≈26.7k / 请求** | 中位口径，含目录 |

token 用 `estimateTokens` 的估算式（CJK×0.7 + ASCII/3.75）折算，绝对值和账单不完全相等；比例可以照用。
口径与「效果」一节不同：那里是单会话**首轮总量**的对比，这里是**每请求都要重付的固定前缀**中位。

> **「净省」是折算的前缀差，不是账单上的每请求省额**（2026-11-18 用真实 usage 复核）：日志 `assistant/message.data.usage` 带 `inputTokens / cacheReadTokens`，冻结态声明段在后续请求里按 `cacheRead` 计费、不是每请求全价重付。本机 0.5.x 期 PTC 单请求上下文中位 107,014 tok，其中 cacheRead 中位 104,576（≈98% 命中）。声明仍然真实影响**首次未命中量**（按声明工具数分桶的 `first-req inputTokens`：1–15 工具 23,037 / 16–30 25,591 / 31–60 22,956 / 61–100 35,180 / 100+ 48,998，100+ 桶混了未冻结期样本）。要账单侧结论请以 usage 字段为准，别直接引用 26.7k。

### 目录签名摘要（0.5.1）

**为什么**：上一节 ③ 里「先 `gate_load` 看签名」那条路，在 PTC 冻结下是纯开销 —— 程序先行，加载来的声明只能给下一次程序用，而 `gate_invoke` 的参数名原本只能从 `gate_load` 的结果里拿：多一轮，也多一次写错参数的机会。

**正文长什么样**：`catalog.signatureSummary.tools` 点名的**按需**工具，在 `<gate-catalog>` 的用法说明之后、各分组之前多一段：

```text
[签名] 按需工具参数（? 表示可选；gate_invoke 的 arguments 照此写）
- univer_doc(doc, sheet?)
- web_fetch(url)
```

行格式 `名字(必填参数, 可选参数?)`：必填在前，其余按 schema 声明顺序，可选带 `?`；单个工具最多 6 个参数（`SIGNATURE_MAX_PARAMS`）。照抄进 `gate_invoke({ tool, arguments })` 就是对的参数名。

**三条硬约束**（`lib/catalog.js` 注释里也写着，别顺手「优化」掉）：

| 约束 | 行为 |
|---|---|
| 只给点名的按需工具 | 名单只来自 `catalog.signatureSummary.tools`；没点名的、以及常驻的工具一个字符都不多 |
| 无 `required` 不出行 | 没有必填参数时摘要没有信息增量，只是白占前缀 —— 整行不出，`[签名]` 段也随之消失 |
| 只在 PTC 冻结渲染 | `ptcFrozen === true` 才渲染；native 会话的目录与 0.4.1 **逐字节相同** |

**成本**：签名几乎全是 ASCII，按 `estimateTokens` 的 3.75 字符/token 反推，预算 = **7,500 字符 ≈ 2k tok / 请求**（`SIGNATURE_BUDGET_CHARS`）；满预算就**停整行** —— 不截半行、不加省略号，同一策略重复渲染逐字节一致。

**怎么挑名单**：按本机会话统计的调用频率取 Top-N（高频 + 参数难猜的那几个），别把全部按需工具都点进去 —— 长尾点进来只是每请求重付前缀。注意**渲染顺序**用的是名字字典序、不是频率：同一策略 + 同一工具集重复渲染必须逐字节一致，而频率会随会话漂移（今天 A 在前、明天 B 在前 = 每次都断前缀缓存）。

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
