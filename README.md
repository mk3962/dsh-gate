# dsh-gate · 两层提示词表面闸门

> 给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）用的插件：把提示词表面 —— **工具声明 / 系统提示词段落 / skill 目录** ——
> 切成「常驻」和「按需」两层。按需那层不进工具表，只在 `<gate-catalog>` 目录里留一行；
> 模型需要时用 `gate_load` 提上来，下一步就能直接调用。
>
> 实测（DSH 桌面版 + 137 个工具）：首轮请求 **48.6K → 31.7K token，省 34.8%**。

MIT License · 需要 DSH ≥ 0.1.7-rc.1 · Node ≥ 20 · 离线可测（50 项断言）

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

配套四个**永远常驻**的闸门工具：

| 工具 | 作用 |
|---|---|
| `gate_status` | 看当前分层、目录体积、段落清单、已加载的工具 |
| `gate_search <query>` | 在按需工具里按名字/描述检索 |
| `gate_load <names>` | 把按需工具提到常驻（当前会话内保持） |
| `gate_call <name> <args>` | 临时撤限制 → 走宿主完整执行管线 → 立刻恢复，用于一次性的重型工具 |

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
4. profile 的 `cordis.patch.yml` 追加 `- id: surface-gate` + `disabled: false`，让官方行级开关能落到它头上。

> 为什么必须写 `dependencies`：宿主判定「已安装」只看 profile `package.json` 的 dependencies
> （`dsh-plugin-manager` → `installed = dependencies.includes(name)`），
> 而前端列表还会把 `installed=false && official=false && error===undefined` 的行整条丢掉。
> 只写 bundles 的插件能跑，但在「插件 → 已安装」里根本不出现 —— 这是 0.1.2 修掉的真实缺陷。

脚本会：备份 `package.json` 与 `cordis.patch.yml`（默认到 `<DSH home>\backups\dsh-gate\`）、
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

> 归层以服务端权威表 `state.tiers` 为准。`run_code`、四个 `gate_*`、团队工具这类
> **agent 自身注册**的工具（`state.own`）标「自身层」：`restrict` 管不到它们，永远常驻，面板不给无效按钮。

### 策略文件

优先级：插件行 `config` > `<DSH_HOME>/gate.json` > 内置默认（`gate.example.json` 就是可直接用的默认策略）。

```json
{
  "version": 2,
  "enabled": true,
  "tools":    { "defaultTier": 2, "overrides": { "read": 1, "univer_*": 2, "ops_*": 0 } },
  "sections": { "defaultTier": 1, "overrides": { "free-search:engines": 2 } },
  "skills":   { "tier": 1 },
  "catalog":  { "groupByPlugin": true, "maxDescriptionLength": 64 },
  "protected": []
}
```

- `overrides` 的键支持 `*` / `?` 通配；多条命中取**最具体**的一条（去掉通配后字面量最长者胜），所以 `univer_sheet` 压过 `univer_*`。
- `run_code`、四个 `gate_*`、以及 `protected` 里的名字**任何策略都动不了**（`restrict` 点名 `run_code` 会直接抛错）。
- 策略文件读坏 / JSON 解析失败 → **fail-open**（全部常驻）：宁可没省 token，也不让会话崩。
- 非法层值（`null` / `""` / `false`）按默认处理，不会被 `Number()` 静默转成 0 把工具关掉。

### 语义边界（都是实测的宿主行为）

| 事项 | 行为 |
|---|---|
| 被隐藏的工具 | 不在 SDK 声明里，调用返回 `UNKNOWN_TOOL` |
| `gate_load` 之后 | 当前会话内保持常驻，同一 agent 的后续步骤立即生效 |
| `gate_call` | 临时撤限制 → 宿主完整执行管线（含 pre-execute 守卫）→ `finally` 立刻恢复 |
| 子 agent | 继承同一套全局策略；闸门按 agent 分别记账 |
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

---

## 兼容性与已知限制

- **PTC 模式下工具面才是主场**：PTC profile 里 `pwsh` / `read` / `write` / `edit` / `grep` / `glob` 根本不存在，
  所以 `gate.json` 里给它们写的层不生效（没有这个工具，自然没得藏）。
- **技能面需要 `skill` 工具存在**：PTC profile 的宿主不注册 `skill` 工具、技能目录走别的注入通道，
  面板的技能列会保持为空。
- **段落面**依赖宿主每轮 assemble 的真实快照；宿主大版本改段落渲染时可能读不到（会 fail-open）。
- 目录里每条描述按 `catalog.maxDescriptionLength`（默认 64 字）截断。
- 本地目录插件在「插件市场」的**更新**按钮不可用（没有 registry 版本可比）—— 升级走重新跑安装脚本 / 重新 `link:`。

---

## 开发

```bash
npm run check     # DSH 插件规范自检（15 项：入口文件、BOM、patch 格式、client externals…）
npm test          # 50 项断言：selftest 40 + loadtest 10，离线跑，不碰真实宿主
npm run verify    # 上面两个一起
```

测试用 `test/vendor/dsh-tools` 的替身复刻宿主 `view / restrict / execute / assemble` 的真实语义
（含「`view()` 无 scope = 全局视图」这条关键区别），通过 `--import ./test/stub-loader.mjs` 解析裸包名，
因此**不需要 `npm install`、不需要 DSH 在跑**。

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
test/                离线测试 + dsh-tools 替身
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
