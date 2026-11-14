# Changelog

版本号遵循语义化版本；格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.4.1] — 2026-11-15

### Added — gate_search 跨语言别名（生产体检票 03）

- **现象**：185 次 `gate_search` 里中文查询 34 次、**31 次零命中（91.2%）**。模型按用户语言写
  `记忆` / `天气` / `终端` 全部打空，只能改用英文重试 —— 一次往返 + 一次失败。
- **根因**：`searchCatalog` 只做名字与英文说明的子串匹配，而名字（`mnemon_remember` /
  `weather` / `terminal_open`）与宿主 `description` 几乎全是 ASCII ⇒ 中文查询在数学上不可能命中。
- **修法**：新增 `lib/search-alias.js`（`CJK_ALIASES` 70 组中文词 → 英文词根 +
  `cjkKeywordsOf` / `hasCjk`）；`searchCatalog` 在原有分档之后加一档 —— 命中别名词根的名字
  记 25、只在说明里命中记 15。低于精确/前缀/包含/说明包含，高于零 ⇒ **老行为不退化**。
- **字节影响**：0。别名表只被 `gate_search` 读，不进 `gate-catalog`。
- **回归**：`test/catalog-search.test.mjs` 新增 2 组，9/9 通过。

### Added — 技能目录可折叠（`catalog.skillGroups`，默认关闭）

- **依据**：57 条技能行占 5,585 字符 / 目录的 37.6%，而 7 天里被 `gate_load` 过的技能只有 5 个。
- **修法**：`renderCatalog` 新增 `options.skillGroups`；`lib/gate.js` 抽出 `catalogOptionsOf(policy)`，
  `skillGroups` 严格 `=== true` 才算打开（写 `"true"` / `1` 都不算）。
- **实测**：57 条技能 / 7 个来源，折叠前 3,248 字符 → 折叠后 900 字符（**省 72%**）。
  真实目录里技能段 5,585 字符 ⇒ 折叠后约 1,550，净省约 4,000 字符 ≈ 1,080 tok / 请求。
- **为什么默认关闭**：折叠改 `gate-catalog` 字节，从该段起前缀缓存失效一次。省 token 与
  一次重装配是用户的取舍，代码只提供开关；不打开时与 0.4.0 **逐字节一致**。
- **回归**：`test/catalog.test.mjs` 新增 1 组（折叠后每来源一行、描述消失、总长更短；
  默认与 0.4.0 逐字节一致）。

### Compatibility

- 无新增配置键以外的新接口；`gate_status` 键集不变；`gate_load` / `gate_invoke` 输出形状不变。
- `catalogOptionsOf` 是内部函数，不在公开面（`test/surface.test.mjs` 的 `ANY` 集合未变）。

## [0.4.0] — 2026-11-14

### Changed — 尾块改增量投递（后缀缓存优化）

- **动机**：0.3.x 每次清单变化就追加一条**全量** `<gate-loaded>` 快照。会话内加载 n 次，
  累计字符 ≈ n×(190+110n) —— 20 次加载约 26,900 字符，而增量只需 6,000。差额会永久
  留在前缀里，此后每个请求都重付一遍。（量化见 `.scratch/dsh-gate-尾块增量注入-…/issues/05`）
- **改法**（三个文件）：
  - `lib/gate.js`：`entry.emitted`（Set）与 `loaded` 分开记「模型已被告知过什么」；
    `loadedTextFor` 拆出 `loadedBlockFor(agent, only)`；新增 `deltaTextFor(agent, names)`
    返回 `{ text, fresh }`（只渲染未投递过的签名并记账）、`indexTextFor(agent)`（一行名字索引）。
  - `lib/proxy.js`：`gate_load` 输出加 `deltaText`，签名跟在**本条工具结果**里 ——
    模型在拿到「已加载」的同一个回合就看到参数，不必再等下一步的尾部 user 消息。
  - `lib/prestep.js`：`mountTailGate` 改用 `indexTextFor`，尾部只留一行
    「本次会话已加载 N 个：a, b, c」。
- **纪律不变**：已投递的签名**永不重发**，旧块留在原处自然过时、不搬动、不删除；
  模型靠块内索引行拼全集。压缩把块吃掉后，索引行会在下一步自愈补一条
  （实测 116 次压缩后 gate-tail 存活 0，自愈是主路径不是兜底）。
- **实测字节账**（10 个真实工具名）：全量重发累计 3,766 字符 → 增量累计 2,562 字符，
  **省 32%**；尾部索引行 206 字符且只在清单变化时发一条。
- **测试**：`test/tail.test.mjs` 新增 5 条回归（只发新增 / 不重复投递 / 索引反映全集 /
  增量累计<全量 / 尾部不含签名），3 处旧断言的取样点从尾块搬到 `deltaTextFor`；
  `test/surface.test.mjs` 公开面加 3 个新口。`npm test` 全绿（tail 37/37）。

### Compatibility

- `loadedTextFor(agent)` 保留原签名与原语义（全量快照），供测试、调试与外部调用方使用。
- 无新增配置键：不带回退开关，回退方式是装回旧版本。

## [0.3.3] — 2026-11-14

### Fixed — gate_search 的归一化（生产体检 P0）
- **根因**：`searchCatalog` 只做逐字子串匹配，不折叠下划线/连字符。模型按自然语言写
  `"deck issue"`、`"mnemon remember"`、`"video understand"`、`"unlag refresh"` 全部零命中 ——
  真名里是下划线，查询里是空格，两边永远碰不上。
- **实测代价**（生产环境 148 次 gate_search，`~/.dsh/sessions` 全量解码）：
  41.8% 零命中（体检票 03 的 55 次样本里 23 次）。发现通道自己坏了，
  「按需」的第二层实际上退化成「靠记忆猜名字」。
- **修法**（`lib/catalog.js`）：新增 `normalizeForSearch`（下划线/连字符/点 → 空格 + 折叠空白），
  匹配时两侧都归一；新增三档自然语言分：
  55 多词全中名字 / 40 多词全中名字或说明 / 20 任一词（≥3 字符）命中名字。
  精确名（100）/ 前缀（80）/ 包含（60）/ 说明包含（30）四档分数不变 —— 老行为不退化。
- **回归**：`test/catalog-search.test.mjs` 7 组断言，覆盖体检里打空的 4 个真实查询、
  7 个「首句完全相同」的 `deck_*` 可按自然语言区分、空查询与无命中不抛错。

### Fixed — 宿主批量委派失败的静默降级（生产体检 P1）
- **现象**：`gate_call` / `gate_load(skill)` / `gate_invoke` 统一报 `Error: Tool batch execution failed`。
  生产日志全量解码（1296 个会话）实测 **95 次**，分布在 2026-11-06 ~ 11-14 的 8 天里；
  `gate_call` 694 次里 87 次、`gate_load` 424 次里 7 次（全是技能正文）、`gate_invoke` 97 次里 10 次
  （那 10 次是 deck 工具的合法业务错误，不算）。**95 次里 0 次是参数错**。
- **根因**：这条文案是宿主 `tools.execute` 批量入口缺 `calls` 时的通用报错。
  插件已经改走 `@deepseek-ai/dsh-tools/pipeline`（`callThrough`），但管线在 PTC 步里
  被并发复用时会抛它 —— **同一次调用重试就成**，属宿主侧瞬时状态，不是模型写错参数。
- **修法**（`lib/gate.js` `callThrough`）：拆出 `callThroughOnce`；**只在管线「抛」出这条固定文案时**
  重试一次（目标工具根本没被执行，重试不会让副作用做两遍）。目标工具自己返回同名字样的
  isError 结果一律不重试 —— 判据是「抛」不是「文案」，这条差异有专门用例守着。
  重试仍失败时返回 `宿主执行通道暂时不可用（<name> 未被执行，参数没有错；重试同一次调用即可）`，
  不再把宿主内部报错原样丢给模型（那会让模型以为是自己参数写错，去乱改参数）。
- **回归**：`test/tail.test.mjs` 新增 3 组用例；`test/vendor/dsh-tools/pipeline.js` 增加
  `failBatchTimes(n)` 注入点，可在离线环境复现这条宿主报错。

## [0.3.2] — 2026-11-14

### Fixed — 0.3.1 现场复验暴露的回归（票 01）
- 0.3.1 加的「本轮宿主一条新消息都没交就别塞声明」守卫是错的：宿主 `inbox` 只装**用户消息**，
  工具结果直接写会话表面，所以 `executor=run_code` 的 PTC 会话里 **continuation 步的 claimed 常为空**，
  那恰好是「刚 gate_load 完、下一步必须让模型看到」的主要时机。表现为：升级到 0.3.1 后加载了工具，
  声明一条都不再出现（实测 8 步 / 0 条）。
- 修法：去掉该守卫；空数组追加一条声明不会多出模型调用（pre-step 本来每步都跑），
  去重仍由「正文没变就不发」保证。回归用例补「continuation 步（claimed 为空）照样补发变化的声明」。
- 结论：0.3.1 的去重方向正确（57 步 / 57 条 → 按变化次数），只是别把空 claimed 当成「不用发」。

## [0.3.1] — 2026-11-14

### Fixed — PTC 尾部声明每步累积（票 01）
- **根因是宿主契约而不是复用分支写错**：`dsh-agent-loop/src/agent.ts` 的 `preStep` 里
  `claimed = this.inbox.claim(target, position.turn)` —— `agent/pre-step` 监听者拿到的
  `decision.messages` **只是本轮新 claim 的消息**，历史里的尾部块永远不在里面；返回的数组又只会被
  `append` 进会话表面，摘除历史消息没有通道。所以 `prestep.js` 原来那条「`existing.length === 1` 就
  原地复用 / 搬到末尾」的分支在真机上一次都命中不了，每步都走 `makeTailMessage`，一步一条。
- **实测代价**：一条 57 步的会话里 `source.kind === "gate-tail"` 的 user 消息 **57 条**（57 个不同 id、
  只有 3 种正文），累计 39,884 字符 ≈ **9,971 token**，全部 `surfaceOp: "append"`。
- **修法**（`lib/prestep.js`）：
  - `lastEmitted`（`WeakMap<agent, text>`）记住上次**确实追加**的正文；正文没变就不再追加。
  - `retainedTailText(agent)` 在宿主提供 `agent.session`（`surface.nodes` + `eventAt`）时按会话表面
    判断「上下文里是否还有这份声明」，插件重启 / 声明被压缩掉之后也能正确决策（读不到就退回内存记录）。
  - 本轮宿主一条新消息都没交时不再塞声明（避免把空步撑成一次模型调用）。
  - 历史回灌型宿主（`existing` 出现在 `decision.messages` 里）的复用/搬家分支保留，作为兼容路径。
- 新增三条回归用例：delta 契约下不累积、清单变化才追加、按会话表面自愈（插件重启不重复发）。
- 效果：同一会话步数下声明只按「清单变化次数」增长（57 → 3），每步省约 175 token。

## [0.3.0] — 2026-11-14

### Added — 技能接管（工单 14）
- **策略 v3 新增 `skills`**：`{ takeover?: boolean, off?: string[], imports?: { id?, path }[] }`。
  `takeover` 缺省 `true`；`off` 是永不注入的技能名清单；`imports` 把本地技能目录接进 gate。
  已同步到 `POLICY_KEYS` / v3 规范化 / `mergePolicyFile` / v2→v3 迁移默认值 / `gate.example.json` /
  `scripts/check-spec.mjs`。v2 的 `skills: { tier }` 仍被识别并迁移成 `defaults.skillpack`；
  档位真源仍是 `defaults.skillpack`，v3 的 `skills` 里不再有 `tier`。
- **新模块 `lib/skills.js`**（纯函数为主）：宿主技能列/取正文（`ctx.skills.list/get`，形状按 0.2.2-rc.1 源码）、
  本地导入扫描（目录含 `SKILL.md` / 多子目录各一个 / 单文件 `*.md`，路径支持 `~/` 与策略文件相对）、
  自写 frontmatter 解析（`name` / `description`，无新依赖）、宿主优先的同名合并（导入标 `shadowed` + 告警）、
  统一的 `<skill_content name="…">` 渲染、常驻正文段落（`gate-skill:<name>`，单条上限 12000 字，超长截断告警）。
- **能力 id 扩到单技能**：`skill:<name>` 压过 `skillpack:<provider>`，再落到 `defaults.skillpack`；
  `resolveSkillDecision` 返回 `single` 与命中的 `capabilityEntry`，`/capabilities` 的 `skills` 行带
  `origin` / `path` / `tier` / `shadowed`。
- **接管**（`skills.takeover` 为真时，默认）：
  - `planFor` 无条件 deny 宿主 `skill` 工具（哪怕策略把 `native:skill` 写成常驻），归层表把它标成 off，
    能力视图标「由 gate 接管」（`takenOver` / `forcedTier`）；
  - pre-step 按 `source.kind` 摘掉**所有**技能目录消息（含宿主在「无技能可用」时补发的 `entries=[]`
    replacement）与用户 `/name` 显式调用的宿主正文；`/name` 改由 gate 用自己的技能表判档后重注入
    （`off` / `shadowed` / 未知不注入；同一步重复跑不重复、复用同一条消息对象保 id 稳定）；
  - 目录进 `<gate-catalog>` 的 `[技能]` 组（名字 + 描述首句 + 来源），`off` / `shadowed` 不列；
  - 常驻正文进系统提示词独立段落 `gate-skill:<name>`（`interpolate: false`，同策略逐字节稳定），
    不塞进目录行、不记进 UI 段落清单、不会被段落档位误摘；
  - `gate_load(["skill:<name>"])` 由 gate 自己解析并返回正文（native / PTC 同一条路，不再转发宿主，
    也不再追加尾部声明）；`off` 返回 denied、不存在返回 unknown；
  - `gate_search` 的技能候选带真实档位（`技能·常驻 / 技能·按需 / 技能·关闭`）与描述首句。
- **逃生门**：`"takeover": false` 完整退回 0.1.8 —— 宿主目录照旧注入、`skill` 工具照旧可见、
  `gate_load(["skill:x"])` 照旧转发宿主 `skill` 工具。
- `snapshot().skills` 改为 **gate 可见技能名单**（宿主 + 导入 − `off` − `shadowed`，键序/形状不变）；
  `gate_status` 的 18 键一个没动、顺序不变。
- 新测试套件 `test/skills.test.mjs`（8 条：目录/正文摘除、`/name` 重注入与幂等、常驻段落字节稳定与防误摘、
  加载/off/未知、导入三种形态与同名冲突、档位优先级、`takeover=false` 回退）；
  `selftest` / `surface` / `policy` / `migrate` / `catalog` / `tier` / `snapshot` 的既有断言按新语义更新
  （每条都在注释里写明为什么改）。

### Added — MCP 接管（工单 15）
- **策略 v3 新增顶层 `mcp`**：`{ servers: { <name>: { transport?, command?, args?, env?, cwd?, url?, headers?, enabled? } } }`。
  追加在 `POLICY_KEYS` 末尾，同步到 `V3_KEYS` / `normalizeV3Policy` / `mergePolicyFile` / `applyLayer` /
  `gate.example.json` / `scripts/check-spec.mjs`。v2→v3 迁移补默认 `{ servers: {} }`。
  - `normalizeMcpConfig`（`lib/migrate.js`）逐条复用 `lib/mcp.js` 的 `normalizeServerConfig` 校验
    （`serverName` 限 `[A-Za-z0-9_-]{1,32}`、stdio 要 `command`、streamable-http 要 `url`）；
    **单条非法只丢弃这一条并告警**，不让整份策略失败。servers 按名排序、字段序固定，落盘条目不带 `name`。
  - 保存时 `mcp.servers` **整表替换**（提交了就换，删除真的生效）；没提交时保留旧表。
- **`gate.startMcp()`**：从 `policy.mcp.servers` 取 `enabled !== false` 的条目 **并发** mount，返回
  `{ mounted, failed }`；失败只 `warn`、不抛。只跑一次（幂等），插件 apply 时触发。
- **`gate.reapplyAll()`**：挂/卸 MCP 后重算全部已挂 agent（新 `mcp__<name>__*` 工具进第二层，段落计划同步）。
- **`gate.mcpManager`**：暴露 M1-core 的 manager（mount / unmount / update / list / state / disposeAll）。
  插件卸载时 `disposeAll()` 断连（用 `ctx.effect` 注册清理）。
- **HTTP**：新增 `GET/POST /api/dsh-gate/mcp`（沿用宿主 connection 鉴权与本地四道门回退）。
  - GET 返回 `{ servers, warnings }`：`owned` + `external`（宿主 loader 行，只读）+
    `stopped`（声明了但没挂上）；每行 `{ name, transport, target, state, enabled, owned, toolCount }`。
  - POST 接受 `{ action: add|update|remove|enable|disable, name, server? }`：校验（非法 400）→
    落 `gate.json`（复用 `/policy` 的保存路径，无 BOM）→ mount/update/unmount → `reapplyAll` → 返回最新清单。
    重复 add / 闸门 `enabled=false` 返回 409，未知 server 404，非 JSON 415。
- **外部 server 只读**：宿主 loader 行里已有的 mcp-client 只观察，绝不 `dispose`（`dispose` 会写回
  `disabled:true`）；同 `serverName` / 同工具命名空间冲突时自挂拒绝。
- **新测试套件 `test/mcp-int.test.mjs`**（12 条）：mcp 归一/告警、整表替换、v2 默认、`startMcp` 并发与
  幂等与单条失败降级、`reapplyAll`、GET 三来源合并、POST 五个动作的写盘/manager/reapplyAll、
  错误分支 400/404/409/415、gate_status 18 键不变。`npm run verify` 全绿（208 条测试 + 16 项规范自检）。
- README 增「MCP 接管（0.3.0）」段与语义边界行；`gate.example.json` 增空 `mcp` 段。

### Changed — 技能接管带来的语义变化
- `defaults.skillpack=1`（常驻）不再「零改动透传」宿主目录：接管下常驻也摘，目录/正文都由 gate 出。
- `gate_search` 的技能行不再统一写「技能」，改为带真实档位；`takeover=false` 时仍是「技能」。
- `gate.example.json` 增 `skills`（`takeover: true` / `off: []` / `imports: []`），规范自检开始校验它的形状。

### Fixed — 0.3.0 复核（2026-11-14，r4 报告 P0=1 / P1=3）
- **P0 迁移放大**：v2 的 `skills.tier=1` 语义是「保留宿主目录」，0.3.0 接管后常驻变成正文注入。
  本机真实技能库 53 个、渲染 294,632 字、gate 自估 ≈78.6k token/次；照字面迁移升级即触发。
  现 v2/v3 旧 `skills.tier=1` 一律降为按需（2）并告警 `skills-tier-remapped`；
  **组级/默认常驻也降级为按需**（`reason: resident-group`），常驻正文只接受显式
  `capabilities["skill:<name>"]={tier:1}` —— 逐条确认才注入正文，避免整库灌入。
- **P1 首步缺失**：宿主先 `assemble` 后 `pre-step`，第一轮没有技能目录/常驻正文，第二轮系统提示词
  变字节、前缀缓存断。`sections.js` 装配前调用 `gate.ensureSkills()`，名单为空先刷一次。
- **P1 正文缓存不失效**：每步 `refreshResidentBodies` 回查常驻技能正文，按 sha1 变化才换缓存；
  `skillSections` 只读缓存，不再在装配路径回查宿主；改 `SKILL.md` 下一步生效。
- **P1 权限边界**：尊重宿主 `invocation.modelInvocable/userInvocable`；模型不可调用的技能不进目录、
  `gate_load` 返回 `not-invocable`；用户不可调用的技能不接 `/name` 手势。
- **P2**：`gate_search` 不再列 `off` 技能；`skills.off` 只在 `resolveSkillDecision` 一处消费。
- **/mcp 500**：`server.js` 三处 `savePolicyFile` 是 async 却未 `await`，add/remove/enable/disable
  全部 500；已修并补测试覆盖。

### Fixed — 0.3.0 复核 P2 批修（2026-11-14，r4 报告 P2=12）
- **P1-4b 导入技能改正文不生效**：`rememberSkills` 的签名不含正文，改动只发生在 `content` 时直接
  early-return，`entry.skills` 留着旧正文（而 `gate_load` 读新文件 ⇒ 同一技能两个版本）。
  签名现已纳入 `content` 的 sha1 前 12 位。
- **P2-6 不完整名单覆盖 last-good**：改用 `ctx.skills.snapshot()` 并检查 `complete`；宿主发现超时/被 abort
  时沿用上一份名单并告警一次（否则技能先消失再回来 = 两次断缓存）。
- **P2-7 装配不可取消**：`sections.js` 把 `context.signal` 传给 `gate.skillSections()`，装配期回查正文
  可随 turn abort 取消。
- **P2-8 正文瞬态失败抖动**：取不到正文时不再渲染「（这份技能没有正文。）」占位段（有旧缓存用旧值，
  没有就跳过该段），避免下一轮又变回正文。
- **P2-9 正文取不到被报成 unknown**：`gate_load("skill:x")` 只把「名字不存在」放 `unknown`；
  名单里有但正文暂时取不到时给出「暂时取不到正文」说明，不再诱导模型改名重试。
- **P2-11 非接管时技能列两遍**：`takeover=false` 且 `skillpack=1`（宿主目录没被摘）时，
  `<gate-catalog>` 不再重复列技能。
- **P2-12 导入技能不支持 `/name`**：新增 `collectSlashInvocations`，按「整条用户正文就是 `/技能名`」
  的严格词法识别（包含式提到不算），命中 gate 技能表的按同一份 `resolveSkill` 渲染注入。
- **P2-13 导入健壮性**：单文件超过 1 MiB 拒读并告警（`code=skill-too-large`，不静默截断正文）；
  `dirEntries` 跟随符号链接（断链跳过）；frontmatter 支持 `|` / `>` 块标量；扫描缓存改 LRU（上限 32）。
- **P2-14 每步空名单 reapply**：名单从空到空时不再触发 `reapply`。
- **P2-5 旧会话残留**（文档级，不改历史）：README「技能接管」新增两条说明——旧会话历史里的
  `skill-catalog` 消息无法被 `pre-step` 摘除，以 `<gate-catalog>` 为准。
- **MCP 工具数恒 0**：`countTools` 改用注册名（`knownNames`）计数，restriction 只影响 `visible`；
  没有活跃会话时面板不再把已挂载的 server 报成 0 工具。
- **面板空态**：会话尚未产生过一次请求时（段落/技能清单还没装配），面板显式说明原因，
  不再让两栏 `0` 看起来像坏了。

## [0.2.0] — 2026-11-13

### Added
- **能力模型（`lib/capabilities.js`）**：开关单位从「单个工具 / 单个段落」换成**能力**（一个来源实例）。
  能力 id 规则：`mcp:<server>`（工具 `mcp__<server>__*` + 段落 `mcp:<server>`）、`plugin:<包名>`、
  `native:<tool>`（原生工具彼此独立，不并组）、`tool:<name>`（推不出来源：只标注，不合并、不隐藏）、
  `section:<name>`、`glob:<pattern>`（v2 无命名空间的通配键）。
- **v3 策略**：`POLICY_KEYS` 换成 `version / enabled / defaults / capabilities / sources / legacy / catalog /
  protected / narrowPassThrough`；解析顺序 own → preset → protected → 显式 `sources` → 命名推断 → 能力档 →
  例外 → `defaults`。一个能力档变化**同时**驱动 `tools` 与 `sections` 两条限制，两条限制同源。
- **例外与偏离**：`capabilities[id].toolExceptions / sectionExceptions` 是唯一允许「同能力不同档」的地方，
  只能显式设置；`capabilityState()` / `resolveToolDecision()` 读回带 `deviation`，UI 可单独提醒。
  来源置信度 high / medium / low / unknown 逐成员给出（v2 的包前缀推断标 low，显式 `sources` 标 medium）。
- **v2 → v3 自动迁移（`lib/migrate.js`）**：读 v2 文件/插件行 config 时自动迁移；先备份
  `gate.json.v2.bak-<时间戳>`（同内容只留一份，原文件不改）。同能力档位冲突取**最宽松**
  （resident < on-demand < off），其余成员写成例外；`ws_mcp_call` 这类悬空键进
  `legacy.unknownOverrides` 并告警；同一输入迁两次逐字节一致；首次保存落盘 v3。
- **上游隐藏先减**：`knownNames − visible − 自己已 apply 的 deny` 算出的名字只标注（`snapshot.upstreamHidden`）、
  不进候选集、不可 `gate_load`，闸门不会把它们重新放出来。
- **能力视图**：`gate.capabilityView(agent)` / `gate.knownNames(agent)` 与
  `GET /api/dsh-gate/capabilities[?agent=]`。/`state` 与 `gate_status` 的固定形状不变。
- **PTC 末尾注入 + `gate_invoke`（票 07）**：检测到 PTC 执行器（`PtcExecutor`，或 `describe().schemas`
  恰好只有 `run_code`）后**冻结工具表**：`gate_load` 之后工具不进工具表，声明以一条 user 消息追加到
  messages 末尾（已加载工具的退化签名 + 已加载段落正文），模型用新增的 `gate_invoke({ tool, arguments })`
  执行。冻结从第一次加载**之前**生效，追加加载不改系统提示词 / `gate-catalog` 一个字节；
  native 会话维持 0.1.8 行为（加载即进工具表、段落回提示词），尾部声明与 `gate_invoke` 不启用。
  执行器认不出 → fail-open（按 native），原因记进 `snapshot.executor`。
- 新策略键 `freezePtcToolset`（默认 `true`）：PTC 冻结的总开关；置 `false` 退回 0.1.8 的加载语义。
  已进 `POLICY_KEYS` / `TOP_KEYS` / v3 规范化 / v2→v3 迁移 / `gate.example.json` / 规范自检。
- 新测试套件 `test/capabilities.test.mjs`（来源推断 / 解析链 / 例外偏离 / 双限制同步 / 上游隐藏）、
  `test/migrate.test.mjs`（迁移幂等 / 备份去重 / 冲突取最宽松 / 悬空键 / 首存写 v3）、
  `test/tail.test.mjs`（21 条：PTC 判据 / 冻结前后 / 尾部声明顺序与幂等 / 同输入字节一致 /
  native 行为 / 段落搬运 / `gate_invoke` 成功与错误）。

### Changed
- 空策略模板改为 v3：`defaults` 按需/常驻/按需 + 9 个基础原生工具显式常驻（`ws_mcp_call` 退休）。
  `defaults.capability` 显式写入时不再保留模板里的隐式常驻（「全关」不再被 read/write 顶掉）。
- `prestep` 的技能轴改读 `defaults.skillpack`（`skills.tier` 保留为只读别名）。
- 0.1.8 面板的 v2 形状保存（`tools/sections/skills`）在服务端翻译成 v3 `defaults + capabilities` 补丁后落盘；
  `client/` 未改（UI 工单 05 接能力视图）。注意：旧面板的**逐工具**操作会按能力归并 ——
  点一个 `univer_*` 工具 = 关整个插件能力，点 `mcp:<server>` 段落 = 同时收该 server 的工具与段落。
- `snapshot()` 增 `upstreamHidden / policyVersion / warnings` 三个字段，以及
  `executor: { kind, reason }` 与 `frozen`（PTC 判据与冻结状态）；`STATUS_KEYS` 与
  `gate_status` 的 18 键属性集、顺序**一字未改**（前缀缓存约束不变）。
- 闸门工具 4 → 5：新增 `gate_invoke`；`gate_load` 的描述改成「PTC 下工具表冻结，加载后仍用
  `gate_invoke` 执行；native 下下一步直接调用」。`gate_call` / `gate_load` 的执行改走
  `ToolExecutionPipeline + executeToolBatch`（旧宿主没有这个导出时退回 `tools.execute` 单调用）。
- `restriction.state()` 增只读 `deny` 数组（区分「自己藏的」与「上游藏的」）。

### Notes
- 升级后工具面可能变大：来源未知（`tool:<name>`）且没被策略点名的工具**不再**按默认层隐藏（fail-open）。
  这是 docs 04 §2「unknown 只标注、不合并、不隐藏」的落地；要藏它请在 `capabilities` 里显式点名。
- 回滚到 0.1.8：先停宿主，把 `gate.json.v2.bak-*` 复制回 `gate.json`（0.1.8 读不懂 v3 的 `capabilities`）。
- `npm run verify` 全绿：规范自检 16/16 + 11 个测试套件（124 → 145 条断言）。

## [0.1.8] — 2026-11-05

### Fixed
- **面板「关闭」计数永远是 0**（`/api/dsh-gate/state` 把 `off` 写成 `status.off.length`，而
  `status.off` 本来就是数字 ⇒ 越过界得 `undefined`，`JSON.stringify` 直接把键丢掉）。
  现在 `off` 由 `gate.snapshot()` 给出，服务端不再自己拼任何计量字段。
- **委派收窄豁免的幂等短路恒假**（passthrough 分支写了 `denyKey` 却不写 `lift`，而短路条件
  要求 `lift !== undefined` 或 `deny` 为空 ⇒ 每次重算都重新进一次 `applying`）。
  判据改成显式的目标形状比较，由 `lib/restriction.js` 独占判断「不动 / 更换 / 撤销」。

### Changed
- **限制所有权收口**：新增 `lib/restriction.js`，一个 agent 的受限状态（模式 + 键 + lift 句柄 +
  applying 标记）只由它持有；`gate` 只描述目标形状 `{ mode, deny }`，不再自己比较键或句柄。
  顺带修掉自指陷阱：`narrowPassThroughFor` 原来遍历受限制影响的 `visibleOf(agent)`，
  改遍历 `scopedViewOf(agent).knownNames`。
- **状态形状单一真源**：新增 `gate.snapshot(agent)`（`STATUS_KEYS` 定键与序）与 `pickStatus()`，
  面板、HTTP 快照、`gate_status`、`gate_search` 全部从它取；`proxy.js` 不再手抄 18 条 schema 属性。
- **归层单出口**：`policy.resolveTier(policy, name, context)` 返回 `{ tier, bucket }`，
  `planFor` 与面板层都从它派生，两者不可能不一致。
- **策略键一张表**：`POLICY_KEYS` 描述每个顶层键（种类 / 合并方式 / 兜底模板），
  `resolvePolicy`、`mergePolicyFile`、`emptyPolicyTemplate` 全部从表派生；
  删掉 `server.js` 的手工白名单 if 链与第二份模板，删掉死键 `catalog.maxNameLength` 与 `catalog.hint`。
- **gate 对外面投影**：公开面收缩为 14 个能力（`attach / listAgents / restrictionState / snapshot /
  planSections / reapply / isApplying / load / callThrough / catalogFor / rememberSkills /
  recordSections / release / releaseAll`）；不再交出 `entries` 裸 Map，也不再导出
  `status / tierMap / visibleOf / planFor`。
- **测试宿主单 seam**：新增 `test/host.mjs`（`makeHost`），`selftest` / `loadtest` /
  `passthrough` 三份假宿主合一；新增 `restriction / snapshot / tier / policy / surface` 五个套件。
- **插件开发文件平行**：安装 payload 与 `package.json` 的 `files` 对齐（去掉 `CHANGELOG.md`）、
  patch 行一律写 `- insert:` 嵌套形状（并对旧裸行做自动迁移）、README 不再写死断言条数。

### Notes
- **不改变任何一步渲染出的提示词字节**：`gate_status` 的 `output.schema` 属性集与顺序仍由
  `STATUS_KEYS` 逐字节确定（18 键），四个 `gate_*` 工具的 `name` / `description` /
  `parameters` 一字未改；`gate-catalog` 段落文本格式未动。因此本次升级不引入新的前缀缓存断点。
- 已装副本仍是 0.1.7，本次不重装；`~/.dsh/gate.json` 的任何取值未改。

### 0.1.8 收尾时补的（审查发现）
- **策略键优先级逐字段统一**：`catalog`（kind `object`）旧实现把插件行 config 最后的 `Object.assign`
  放在文件之后 ⇒ 这一个键反向覆盖文件；`tools` / `sections`（kind `section`）旧实现把 `defaultTier`
  一律取文件的，文件没写这个字段时就丢掉行 config 的值。现在所有键统一「逐字段：文件 > 行 config > 内置默认」。
- **`gate.snapshot()` 改成只读**：以前对未挂载的 agent 取快照会顺手 `ensureEntry`（注册 scoped ctx
  并施加限制），HTTP 层拿 `roots()` 兜底时会给别的会话建条目。
- **没有施加手段时不再假装「限制着」**：`lib/restriction.js` 的 `apply()` 在拿不到 `restrict` 回调时
  旧实现直接把状态置成 `limited` 却没有 lift 句柄 ⇒ 下一次同样的目标被幂等短路挡住，此后再也不尝试
  （与 `restrict()` 抛错那条路径同一个坑）。现在一并退回 `none`，并加断言覆盖。
- **删掉 `planSections().gated`**：全仓无读取者（`sections.js` 自带一份 `dropped`），是会漂的第二本账。
- **`lib/prestep.js` 不再写裸 `1`**：改用 `policy.js` 的 `TIER_RESIDENT`，层值定义一改不会静默跟丢。
- **两条验收项补上断言**：`test/surface.test.mjs` 扫描 `test/` 断言仓内只有一处 `view` / `restrict`
  适配（票 01 的验收项此前没有断言守着）；`test/restriction.test.mjs` 覆盖「拿不到施加手段」这条路径。
- **文档与实现对齐**：`docs/ARCHITECTURE.md` 里 policy.js 的优先级（原写成与实现相反的
  「行 config > 文件」）与 prestep.js 的技能识别能力（原写成有文本特征回退，实际只认
  `source.kind === "skill-catalog"`）两处已改正。

### 0.1.8 收尾第四轮（CI 首跑四连红 → 测试钩子补齐）
- **现象**：GitHub Actions 四个矩阵（ubuntu / windows × node 20 / 22）同时炸在
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-tools' imported from lib/proxy.js`。
- **根因**：仓库既不 vendor 真实现也不要求 `npm install`，靠 `--import ./test/stub-loader.mjs`
  把裸包名指到 `test/vendor` 的替身。0.1.8 新增的六个套件（passthrough / restriction /
  snapshot / tier / policy / surface）在 `package.json` 里写成了裸 `node test/*.mjs` ⇒ 干净
  checkout 上没有钩子就解析不到。本机之所以全绿，是因为仓库**上层**目录有个游离的
  `node_modules/@deepseek-ai/dsh-tools`，Node 向上查找恰好能命中。
- **修法**：`test` 与六个 `test:*` 脚本全部补 `--import ./test/stub-loader.mjs`；并新增第 16 项
  规范自检——遍历 `manifest.scripts`，凡是以 `node ` 开头且含 `test/<x>.mjs` 的 `&&` 段都必须带钩子，
  否则 FAIL 并列出违规段（反向验证：删掉一处钩子即 FAIL）。
- **验证**：`npm run verify` 16/16 + 109 条全绿；另把源码复制到无 `node_modules` 的临时目录复跑，
  同样全绿——即 CI 的真实环境。

### 0.1.8 收尾第三轮（code-review 双轴：硬违规 0 / 判断题 7 → 修 5）
- **测试自己骗自己（三处）**：① `test/policy.test.mjs` 的每键往返用 `spec.fallback` 当提交值 ⇒
  提交值恒等于现值，`mergePolicyFile` 写错也测不出；改成按 `kind` 造「与默认不同」的值并断言
  `notDeepEqual` 真的改掉了该键。② `test/tier.test.mjs` 里 `if (!(name in tiers)) continue;`
  让归层表漏掉 off 名字时静默跳过；改成 `assert.ok(name in tiers, …)`。③ `test/snapshot.test.mjs`
  的段落种子写在 `gate.attach(agent)` 返回的 Promise 上（`attach` 早已只回 thenable）⇒ 种子被
  静默吞掉、段落清单恒空也能绿；改走公开面 `recordSections` + `reapply`，并新增第 9 条断言
  校验「被摘掉的段落进了段落清单」（名字 / chars / tokens / gated 四项）。
- **`lib/gate.js` 不再写裸 `"none"`**：三态统一用 `lib/restriction.js` 导出的 `MODE_NONE`；
  `pickStatus` 用的空回退对象收敛成模块级冻结常量 `NO_RESTRICTION`（原来 :411、:495 各造一份）。
- **`lib/restriction.js` 内部 `release` 改名 `dropHandle`**：与 gate 公开的 `release(agent)`
  （释放 agent 条目）同名异义，读代码时极易混淆。
- **`lib/policy.js` 去重**：`normalizeThreshold` 与 `normalizeNumber` 逐字相同 ⇒ 合成
  `normalizeCount`（注释写明 0 合法、非法回退默认）；删死分支 `case "names": return []`
  （唯一调用方 `resolvePolicy` 在该 kind 直接 `continue` 丢弃返回值，protected 走合并循环）；
  `isPlainObject` 收成一份并导出，`lib/server.js` 改具名 import。
- **「段落行摘要恒空」落成书面已知限制**（规格 Out of Scope 声称「只记录不修」，但此前全仓
  没有任何记录）：写进 `README.md` 的「兼容性与已知限制」、`docs/TROUBLESHOOTING.md` 的症状表、
  `lib/gate.js` 的 `recordSections` 注释。修法会让 `<gate-catalog>` 字节变化 ⇒ 破前缀缓存，
  因此仍然只记录不修。
- **有意不改的两条判断题**：`lib/gate.js` 为打日志读 `restriction.state()` 自比 mode（比的是
  模式不是键/句柄，不违反「调用方不得自己比较」）；无 agent 分支手写的 21 键是 snapshot 的完整
  形状（比 `STATUS_KEYS` 多 `agent` / `tiers` / `skillEntries`），合并需要 builder 抽象。
- 断言总数 108 → **109**（snapshot 8 → 9）。

## [0.1.7] — 2026-11-01

### Fixed
- **委派收窄的子代理被剥空工具面**（2026-11-01 事故：dsh-mnemon 写记忆恒失败，父会话抛
  `memory subagent completed without recording its result`）。dsh-mnemon 的写入/复核子代理是
  「allow 白名单 + PTC」形态，工具面只有 `mnemon_*` + `mnemon_subagent_result`（4 个）；
  闸门按默认层（2 = 按需）把它们全部 deny 掉 ⇒ 子代理一个可用工具都没有，记不了结果，
  也无法用 `gate_load` 自救（不在它的白名单里）。
  现在：被委派的子代理（`session.header.origin === "subagent"`）如果**本来只被授予个位数工具**
  （去掉 agent 自己这一层的 own 工具后 ≤ `narrowPassThrough`，默认 12），直接跳过闸门 ——
  在个位数工具面上藏东西省不到 token，却会剥掉委派协议的必需工具。
  主会话与宽工具面子代理的行为完全不变（回归用例覆盖）。

### Added
- 策略键 `narrowPassThrough`（默认 12，`0` = 关闭豁免回到旧行为）；`gate.json` 与插件行 config 均可写，
  文件里点名优先。
- `gate_status` / `/api/dsh-gate/state` 增加 `passthrough`，一眼看出该 agent 是否走了豁免
  （`gate_status` 的 `output.schema` 同步补键；`additionalProperties: false` 下漏键会让真机调用直接失败）。
- UI 保存策略时不再抹掉 `narrowPassThrough`（`mergePolicy` 白名单补键）。

## [0.1.6] — 2026-10-30

### Fixed
- **候选集漏掉 preset 平面**（此前 `gate.json` 里给 `pwsh` / `read` / `write` / `edit` / `grep` / `glob` /
  `web_search` / `web_fetch` / `skill` 写的层"不生效"，旧文档还误写成"PTC profile 里根本不存在"）。
  根因：候选集只读 `tools.view()`（全局视图），而 agent preset 把工具注册在 **agent 祖先层**，
  `view(agent).knownNames` 才有它们。改为候选集 = `view(agent).knownNames` ∪ 全局视图。
- 为免误伤，preset 平面的工具**默认不受管**（常驻、不写 deny）；只有 `overrides` 点名（含通配）才真正生效。
- `gate_load` 的名字校验同步改用同一候选集（preset 工具不再被判 unknown）。

### Added
- `gate_status` 与 `GET /api/dsh-gate/state` 增加 `presetNames`（UI 用「预设层」标记，说明默认不受管）。
- 自测加 5 条 preset 平面用例（默认不受管 / 点名后真被 restrict / gate_load 认领 / tierMap 归层 / schema 覆盖）。

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
