# 架构

## 一句话

插件在宿主里只做两件事：**每轮 assemble 前算一份 deny 集合并调用 `tools.restrict`**，
以及**给模型四个闸门工具去改这份名单**。其余都是记账与 UI。

## 运行时全景

```text
                    ┌─────────────────────────── 宿主（DSH） ───────────────────────────┐
 cordis.patch.yml   │  loader → bundle 层 insert: surface-gate                          │
   - insert:        │            │                                                      │
     - id: surface- │            ▼                                                      │
       gate         │  apply(ctx, config)  ← lib/index.js                               │
                    │            │                                                      │
                    │   resolvePolicy(config, gate.json, 默认)  ← lib/policy.js         │
                    │            │                                                      │
                    │            ├── createGate()            ← lib/gate.js  ★核心        │
                    │            ├── mountSectionGate()      ← lib/sections.js          │
                    │            ├── mountSkillGate()        ← lib/prestep.js           │
                    │            ├── registerGateTools()     ← lib/proxy.js             │
                    │            └── mountServer()           ← lib/server.js            │
                    │                       │                                         │
                    │  agent/created ───────┤  每个 agent 一份 entry（独立记账）       │
                    │  agent/disposed ──────┘                                        │
                    │                                                                 │
                    │  tools/change → 防抖重算（restrict 自己也会发这个事件）           │
                    └─────────────────────────────────────────────────────────────────┘
```

## 一次 reapply 做了什么（核心 6 步）

以 agent 为作用域（`view(agent)` 只返回该 agent 可见的工具，并且**只允许 restrict 继承链上的全局工具**）：

1. 取全局视图 `tools.view()`（无 scope = 全部已注册工具）与 agent 视图 `tools.view(agent)`；
2. 用 `policy` 逐个算目标层：`own` 层（agent 自己注册的，如 `run_code` / `gate_*` / 团队工具）无条件常驻；
   `INTRINSIC_PROTECTED` 与 `policy.protected` 里的名字永远常驻；
3. deny 集 = 目标层为 0 或 2 的工具名。**key = deny 排序后 join("|")**，与 last deny 相同就直接 return（防自激回环）；
4. 组目录文本：按层 2 的分组渲染 `<gate-catalog>`（`lib/catalog.js`），token 用 chars/2.9 估算；
5. `tools.restrict({deny})` —— 返回的 disposer 记在 entry 上，下一次先 dispose 旧的再建新的；
6. 把目录文本与「被摘掉的段落」交给 `systemPrompt`（`lib/sections.js` 维护 `gate-catalog` 段落与段落摘除）。

`entry.applying` 在整个过程里为 `true`：`restrict()` 会同步 emit `tools/change`，
监听器看到 `applying` 就延后重试（最多 20 次 × 5ms），既不丢窗口期注册的工具，也不自激。

## 模块职责

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 插件入口。导出 `name` / `inject = ["tools"]` / `apply`。分段 `safe()` 挂载：任何一段失败只降级并 warn，绝不让宿主启动崩。`agent/created`、`agent/disposed`、`internal/dispatch(tools/change)` 三个订阅都在这里。 |
| `lib/policy.js` | 策略解析。`defaultDshHome()`（`$DSH_HOME` 优先，否则 `~/.dsh`）；`tierOf()` 通配匹配且**最具体者胜**；`normalizeTier()` 只认 0/1/2（非法值回退默认）；`resolvePolicy()` 合并 row config > 策略文件 > 内置默认，文件坏 → fail-open。 |
| `lib/gate.js` | 每个 agent 的 entry：`attach` / `reapply` / `status` / `callThrough` / `release` / `releaseAll` / `isApplying` / `tierMap` / `recordSections` / `rememberSkills`。`touchedAt` 记录最近活跃时间，供多会话下挑「当前会话」。 |
| `lib/catalog.js` | `<gate-catalog>` 渲染：按插件分组（`ownerOf`）、描述取首句并按 `maxDescriptionLength` 截断、token 估算、`gate_search` 的检索。 |
| `lib/sections.js` | 段落闸门：读宿主真实段落快照、摘除层 2 的段落、把被摘段落名塞进目录、维护 `gate-catalog` 这个注入段。 |
| `lib/prestep.js` | 技能闸门：pre-step 钩子里识别宿主的 skill 目录消息（`skill-catalog` kind / 文本特征），记录名单；`skills.tier = 2` 时把那条消息摘掉。 |
| `lib/proxy.js` | 四个闸门工具的 `defineTool` 定义与 `output.schema`。**schema 必须覆盖 `status()` 返回的全部键**，否则宿主校验会报 `ToolCallError: additionalProperties`（0.1.5 前真机上踩过）。 |
| `lib/server.js` | 两条本地 HTTP 路由 + 两道鉴权门（主门 `connection.requestRejection`，兜底门自建四道）+ 策略浅合并保存。 |
| `client/index.js` | web 侧 bundle：`window.__ModuleLoader__.load({id, factory})` 手接格式，注册 `plugins.row.config` 槽（key = `dsh-gate#surface-gate`），三列面板 + 保存。 |

## 数据流：模型怎么"提货"

```text
模型        工具表（T1 + gate_*）              <gate-catalog> 段落
 │              │                                  │
 │ 看到目录行 ──────────────────────────────────► │  "univer_sheet — 表格读写…"
 │              │                                  │
 ├─ gate_load(["univer_sheet"]) ──────────────────► restrict 重算：univer_sheet 进 T1
 │              │                                    下一模型步它就出现在工具表里
 ├─ 直接调用 univer_sheet ──────────────────────────► 成功
 │
 └─ gate_call("ssh_exec", {...}) ──────────────────► 临时撤限制 → 宿主完整管线 → 立刻恢复
```

## 装/卸与宿主的关系

- **装**：bundle 层 `insert` 一行 + `dsh.profile.bundles` 登记 + `dependencies` 里 `link:` 到源码 + profile patch 行 `disabled: false`。
  前两个决定"被加载"，后两个决定"在 UI 里可被管理"。
- **卸**：插件 fiber 被销毁 → 所有 `restrict` 的 disposer 与 `systemPrompt` 注入一并撤销，工具表立刻恢复全量。

## 关键不变量

1. `run_code` / `gate_*` / `protected` 永远不进 deny 集（`restrict` 点名 `run_code` 会直接抛错，整个插件会挂）。
2. `reapply` 必须幂等：denyKey 相同就短路，否则 `tools/change` 会自激成死循环。
3. `policy.enabled === false` 必须**撤销**已有限制，而不只是不再新增。
4. 任何读文件 / 读段落 / 读技能名单的失败都必须 fail-open 或 fail-soft，不能让会话崩。
