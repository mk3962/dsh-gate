# 架构

## 一句话

插件在宿主里只做三件事：**每轮 assemble 前算一份 deny 集合并调用 `tools.restrict`**、
**给模型五个闸门工具去改这份名单 / 执行已加载工具**，以及**在每个 agent 的 pre-step 末尾追加声明块**。
其余都是记账与 UI。

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
                    │            ├── mountTailGate()         ← lib/prestep.js          │
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

1. 取 **agent 视图** `tools.view(agent)` 的 `knownNames`（不受 restriction 影响，含 agent preset 注册在祖先层的
   `pwsh` / `read` / `write` / `grep` / `glob` / `web_search` / `skill` 等）∪ **全局视图** `tools.view()` 的 visible。
   只用全局视图会漏掉整个 preset 平面（v0.1.5 及以前的实际缺陷：`gate.json` 给它们写的层形同死键）；
2. 用 `policy` 逐个算目标层：`own` 层（agent 自己注册的，如 `run_code` / `gate_*` / 团队工具）无条件常驻；
   **preset 平面默认不受管**（没被 `overrides` 点名就常驻、不进 deny），点名后才按层生效；
   `INTRINSIC_PROTECTED` 与 `policy.protected` 里的名字永远常驻；
3. deny 集 = 目标层为 0 或 2 的工具名。把它包成目标形状 `{mode, deny}` 交给**限制所有权对象**
   （`lib/restriction.js`）：它自己比「模式 + 键」，一模一样就一点动作都不做（防自激回环）；
4. 组目录文本：按层 2 的分组渲染 `<gate-catalog>`（`lib/catalog.js`），token 用 `estimateTokens()` 估算
   （CJK 1 字 ≈ 0.7 token、ASCII 3.75 字符 ≈ 1 token，只用于预算显示）；
5. `tools.restrict({deny})` —— 只有目标形状变了才真的调用；返回的撤销句柄由限制对象独占，下一次先撤旧的再建新的；
6. 把目录文本与「被摘掉的段落」交给 `systemPrompt`（`lib/sections.js` 维护 `gate-catalog` 段落与段落摘除）。

真正动限制的那一小段里 `applying` 为 `true`：`restrict()` 会同步 emit `tools/change`，
监听器看到 `applying` 就延后重试（最多 20 次 × 5ms），既不丢窗口期注册的工具，也不自激。
这个标记由限制对象自己维护，gate 主体不再手工置位 —— 以前散在四个字段上，收窄豁免那条分支
只写了键没写句柄，短路判据恒假，每轮重算都白跑一遍。

## 模块职责

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 插件入口。导出 `name` / `inject = ["tools"]` / `apply`。分段 `safe()` 挂载：任何一段失败只降级并 warn，绝不让宿主启动崩。`agent/created`、`agent/disposed`、`internal/dispatch(tools/change)` 三个订阅都在这里。 |
| `lib/tiers.js` | 层与匹配的基础件：`TIER_OFF/RESIDENT/ONDEMAND`、`matches()` 通配、`specificity()` 最具体者胜、`normalizeTier()` 只认 0/1/2、`loosenessRank()`（迁移取最宽松用）。`policy.js` 继续 re-export，老 import 路径不变。 |
| `lib/policy.js` | 策略解析（v3）。`defaultDshHome()`（`$DSH_HOME` 优先，否则 `~/.dsh`）；`POLICY_KEYS` 是**顶层键的唯一真源**：一行 = 键名 + 怎么读（`kind`）+ 保存时怎么合并（`merge`）+ 内置默认（`fallback`）。`resolvePolicy()` / `emptyPolicyTemplate()` / `mergePolicyFile()` 三者都从这张表派生，加一个键只加一行；优先级**逐字段**是策略文件 > row config > 表里的默认，文件坏 → fail-open。v2 文件/行 config 在读取时自动迁移（先备份 `gate.json.v2.bak-<时间戳>`，原文件不改）。`tierForTool() / resolveTier() / tierForSection()` 都走 `capabilities.js` 的解析链。 |
| `lib/capabilities.js` | **能力模型**：能力 id（`mcp:<server>` / `plugin:<包名>` / `native:<tool>` / `tool:<name>` / `section:<name>` / `glob:<pattern>`）、显式 `sources` 映射、解析顺序（own → preset → protected → sources → 命名推断 → 能力档 → 例外 → defaults）、例外 `toolExceptions/sectionExceptions` 与 `deviation` 判定、`capabilityState()` 能力视图。一个能力档变化同时决定工具与段落两条限制。 |
| `lib/migrate.js` | v2 → v3 迁移与 v3 规范化：同能力档位冲突取**最宽松**、其余成员写例外；悬空键进 `legacy.unknownOverrides` 并告警；键序/数组序固定（同输入迁两次逐字节一致）。`mergeCapabilities() / mergeSources()` 供保存路径与层合并复用。 |
| `lib/restriction.js` | **限制所有权**：一个 agent 身上「当前被限制成什么样」的唯一真源。显式三态（`none` / `limited` / `passthrough`）＋ 显式键比较，四个动作 `apply(target)` / `drop()` / `isApplying()` / `state()`，外加 `suspend(fn)` 给 `gate_call` 的临时放行窗口。`apply` 幂等：模式与键都相同就什么都不做。 |
| `lib/gate.js` | 每个 agent 的 entry，对外只给**能力**不给内部表（票 06）：`attach`（挂载并等就绪）/ `listAgents`（谁挂着、多久前活过）/ `snapshot`（唯一状态形状）/ `capabilityView`（能力视图）/ `knownNames`（当前工具面，迁移判定悬空键用）/ `restrictionState` / `planSections` / `reapply` / `isApplying` / `load` / `callThrough`（执行管线单调用）/ `canInvoke`（冻结下 gate_invoke 的准入）/ `loadedTextFor`（尾部声明正文）/ `catalogFor` / `rememberSkills` / `recordSections` / `release` / `releaseAll`。执行器判定（`detectExecutor`）与冻结（`freezeFor`）也在这一层：PTC 下 `planFor` 不看 `loaded`，已加载段落不再从目录摘掉。内部条目、候选集、归层表、计划函数都不外露。它只负责「算目标形状」，限制怎么落由 `restriction.js` 管；上游已隐藏（`known − visible − 自己的 deny`）先减掉，只标注不放出。 |
| `lib/catalog.js` | `<gate-catalog>` 渲染：按插件分组（`ownerOf`）、描述取首句并按 `maxDescriptionLength` 截断、token 估算、`gate_search` 的检索。 |
| `lib/sections.js` | 段落闸门：读宿主真实段落快照、摘除层 2 的段落、把被摘段落名塞进目录、维护 `gate-catalog` 这个注入段。 |
| `lib/prestep.js` | 两个 pre-step 闸门。**技能目录**：识别宿主的 skill 目录消息（只看 `source.kind === "skill-catalog"`，没有文本特征回退 —— 认不出来就原样放行），记录名单；技能轴不是常驻（`defaults.skillpack`，`skills.tier` 是只读别名）时把那条消息摘掉。**末尾声明**（`mountTailGate`）：PTC 冻结下把 `gate.loadedTextFor(agent)` 渲染成一条 `source.kind === "gate-tail"` 的 user 消息放到 messages 末尾 —— 已有消息不改、不重排；正文没变就不再追加（宿主每步只交新增消息，历史看不见自己的旧块），变了才追加新块。 |
| `lib/proxy.js` | 五个闸门工具的 `defineTool` 定义与 `output.schema`（`gate_invoke` 是 PTC 冻结下唯一执行口，参数只做准入检查，真正校验交给宿主 `defineTool`）。**schema 属性集必须与导出的 `STATUS_KEYS` 逐项一致**（`pickStatus(snapshot)` 就按这份清单取子集），否则宿主校验会报 `ToolCallError: additionalProperties`（0.1.5 前真机上踩过）。 |
| `lib/server.js` | 三条本地 HTTP 路由（`state` / `policy` / `capabilities`）+ 两道鉴权门（主门 `connection.requestRejection`，兜底门自建四道）。策略保存只负责「读回 → `mergePolicyFile()` → 兼容旧 UI 的 v2 提交 → `normalizeV3Policy()` → 按字节写无 BOM」，自己不再维护键表或空模板。`/policy` 读回永远是 v3 形状（v2 文件只读迁移，不写盘）。 |
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

### PTC 会话：工具表冻结，声明走末尾

PTC 执行器（`PtcExecutor`）的工具表由 SDK 从固定 schema 渲染，`restrict` 之外再改工具面代价很高。
0.2.0 起检测到 PTC 就**冻结工具表**：`gate_load` 不再改 restrict 的目标形状（已加载的工具继续留在
deny 集里、`<gate-catalog>` 字节不变），而是由 pre-step 把一份声明追加到 messages 末尾：
已加载工具的**退化签名** + 已加载段落的**正文**（`<gate-section>`）。模型下一步用
`gate_invoke({ tool, arguments })` 执行它们。

```text
模型        工具表（与冻结前逐字节相同）            消息末尾（每条 user 消息之后）
 │              │                                      │
 ├─ gate_load(["univer_sheet", "section:office"]) ───► │ 追加 <gate-loaded> / <gate-section>
 │              │                                      │
 ├─ gate_invoke({ tool: "univer_sheet", arguments:{…} }) ► suspend → 宿主管线 → reapply
 │              │                                      │
 └─ 用户发新消息 ─────────────────────────────────────► 同一条尾块搬到末尾（id 不变）
```

冻结从**第一次 `gate_load` 之前**就生效：否则第一次加载已经改过工具面，之后再冻结也补不回前缀缓存。
native 会话维持 0.1.8 行为：加载即改工具表、段落回系统提示词 —— 尾部声明与 `gate_invoke` 都不启用。
判据拿不到执行器时 fail-open 按 native 处理。

## 装/卸与宿主的关系

- **装**：bundle 层 `insert` 一行 + `dsh.profile.bundles` 登记 + `dependencies` 里 `link:` 到源码 + profile patch 行 `disabled: false`。
  前两个决定"被加载"，后两个决定"在 UI 里可被管理"。
- **卸**：插件 fiber 被销毁 → 所有 `restrict` 的 disposer 与 `systemPrompt` 注入一并撤销，工具表立刻恢复全量。

## 关键不变量

1. `run_code` / `gate_*` / `protected` 永远不进 deny 集（`restrict` 点名 `run_code` 会直接抛错，整个插件会挂）。
2. `reapply` 必须幂等：目标形状与当前相同就一次都不动限制，否则 `tools/change` 会自激成死循环。
   幂等由 `lib/restriction.js` 保证，调用方不得自己比较键或句柄。
3. `policy.enabled === false` 必须**撤销**已有限制，而不只是不再新增。
4. 任何读文件 / 读段落 / 读技能名单的失败都必须 fail-open 或 fail-soft，不能让会话崩。
5. 状态形状只有一份（`gate.snapshot`）：`gate_status` 的 schema、HTTP 快照、面板都从它派生；
   键集与顺序由 `STATUS_KEYS` 定，改键等于改工具声明，会从那一刻起让前缀缓存失效。
6. gate 的公开面是一组能力（`attach / listAgents / snapshot / reapply / …`），不是内部表；
   外部不得读 entry 字段，也不得自行拼状态。
7. PTC 冻结下，追加加载**不改变系统提示词或 `<gate-catalog>` 的字节**：段落正文改由尾部声明承载，
   目录里保留该段落行；否则每次加载都断一次前缀缓存。
8. 尾部声明只在**内容变化时**追加一条，且只追加在 messages 末尾：不改已有消息、不重排。
   宿主的 `agent/pre-step` 只交本轮新 claim 的消息（历史不回灌），返回数组只走 `append`，
   所以「复用同一条消息对象」不可达；去重靠 `lastEmitted` 记忆 + 会话表面（`agent.session`）判断，
   读不到表面时退回记忆（0.3.1 修：此前每步一条，57 步会话累积约 1 万 token）。
9. 执行器认不出时一律 **fail-open**（按 native）：不冻结、不启用尾部声明，原因记进 `snapshot.executor`。
