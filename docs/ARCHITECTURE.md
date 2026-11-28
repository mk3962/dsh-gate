# dsh-gate 架构（0.6.0）

> 本文描述 0.6.0 的模块边界、数据流与接缝不变量。旧版本术语已废止，统一称 **层 0 / 层 1 / 层 2**（关闭零、常驻一、按需二）。

## 1. 一句话

dsh-gate 把「模型能看见多少提示面」收成一份策略文件：**层 0 = 关闭（关闭零）**、**层 1 = 常驻（常驻一）**、**层 2 = 按需（按需二）**。工具、段落、技能走同一套归层判定，控制面只负责读写策略与展示结论。

## 2. 运行期分层

    ┌────────────────────────────────────────────────────────────┐
    │ 宿主（DeepSeek Harness）                                    │
    │  tools / events / agent / loader / http / logger           │
    └───────────────▲────────────────────────────┬───────────────┘
                    │ 只通过 host-adapter 读      │ 控制面 HTTP
    ┌───────────────┴────────────┐   ┌───────────▼───────────────┐
    │ 运行时层                    │   │ 控制面层                  │
    │ gate / sections / prestep   │   │ server + lib/control/*    │
    │ proxy / guardrail / server  │   │ 路由表 / 错误信封 / 指标  │
    └───────────────▲────────────┘   └───────────▲───────────────┘
                    │ 只读计划                    │ 只读写策略
    ┌───────────────┴────────────────────────────┴───────────────┐
    │ 领域层（纯函数，零宿主依赖）                                │
    │ decide（归层）→ planner（装配）→ capabilities / skills      │
    │ naming（命名）· policy-schema（策略规格）· normalize（结果）│
    └───────────────▲────────────────────────────────────────────┘
                    │ 唯一落盘边界
    ┌───────────────┴────────────────────────────────────────────┐
    │ 存储层 storage-seam                                        │
    │ 内存适配器（测试）/ 磁盘适配器（运行）                      │
    └────────────────────────────────────────────────────────────┘

依赖方向只有自上而下：领域层不认识宿主，运行时层不直接读写文件，控制面不自己拼归层判断。

## 3. 模块清单（0.6.0）

| 模块 | 角色 | 关键导出 |
|---|---|---|
| lib/index.js | 插件入口：挂载限制、段落、pre-step、护栏、工具与控制面，返回卸载函数 | apply |
| lib/gate.js | agent 级状态机：attach / release / 计划刷新 / 诊断快照 | createGate, pickStatus |
| lib/policy.js | 策略解析入口：把 config 与 gate.json 合成有效策略 | resolvePolicy, defaultDshHome |
| lib/policy-schema.js | **策略字段唯一真源**：模板、归一、逐键合并、严格校验、内省、v2 迁移键集 | POLICY_FIELDS, emptyPolicyTemplate, mergePolicyLayer, validatePolicyInput, normalizePolicyDocument, describePolicySchema |
| lib/storage-seam.js | **唯一落盘边界**：BOM、原子 rename、备份、revision、写串行、五级读取诊断 | createPolicyStore, createFilePolicyStore, createMemoryStorageAdapter, createDiskStorageAdapter, stripBom, STORAGE_CODES |
| lib/decide.js | **归层决策引擎**：工具 / 段落 / 技能三轴，输出层值 / 桶 / 原因 | AXES, REASONS, parseTier, decideTool, decideSection, decideSkill, decide |
| lib/naming.js | **命名与分组唯一实现**：能力 id、插件前缀、目录分组、技能来源标签 | PLUGIN_PREFIXES, capabilityIdOfToolName, ownerOf, skillSourceLabel |
| lib/planner.js | **一次产出不可变计划**：下游七个派生点只读计划 | buildPlan, sectionDecisionOf, toolTierOf, planStamp |
| lib/host-adapter.js | **宿主适配层**：视图三件套、执行器判定、隔离派发、消息构造、loader 读取 | createHostAdapter |
| lib/normalize.js | **执行面公共件**：结果规范化 + 转发目标禁令（零依赖，proxy 与 guardrail 共用） | normalizeToolResult, textViewOf, forwardTargetRefusal, isGateToolName |
| lib/capabilities.js | 能力视图：把工具/段落/技能投影成带来源与置信度的能力行 | capabilityState, capabilityOfTool, resolveToolDecision |
| lib/skills.js | 技能扫描、导入与来源标注 | scanSkills, skillSourceLabel |
| lib/sections.js | 段落装配与摘除（只读 plan.sections） | mountSectionGate |
| lib/prestep.js | pre-step 有序管线（尾块自愈与去重） | mountPreStepPipeline |
| lib/proxy.js | 闸门四工具族（`gate_status` / `gate_search` / `gate_load` / `gate_invoke`）：状态、搜索、加载、统一转发 | registerGateTools |
| lib/guardrail.js | 重复调用护栏（只读文本视图，不解析结构化块） | mountRepeatGuard |
| lib/mcp.js / lib/upstream.js | MCP 自挂与上游工具面 | — |
| lib/server.js | 控制面 HTTP 页与 JSON 端点 | mountServer |
| lib/control/* | 路由表、错误信封、指标、HTTP 工具 | CONTROL_PLANE_ROUTES, sendError |
| lib/tiers.js | 层值原语与 pattern 匹配（唯一 tier 常量） | TIER_OFF, TIER_RESIDENT, TIER_ONDEMAND, matches |
| lib/migrate.js | v2 → v3 迁移（键集从 policy-schema 派生） | migratePolicyDocument |

## 4. 归层数据流（I-14）

    策略层值（gate.json / config）
        │  normalizeTier（读策略时唯一的归一）
        ▼
    decideTool / decideSection / decideSkill     ← 四维显式状态
        │  { tier, bucket, reason, removalReason, catalog, loadable }
        ▼
    planner.buildPlan（不可变计划）
        │
        ├── 限制 deny（restriction）
        ├── 目录（catalog / gate_load 候选）
        ├── 快照 tiers（控制面）
        ├── 段落摘除（sections）
        ├── 加载口（proxy）
        ├── 能力视图（capabilities）
        └── 搜索（catalog-search）

纪律：**显式关闭高于一切**；已加载只能把按需抬成常驻，永不能把关闭抬成可见；冻结只影响「是否抬升」；保护名单常驻且绝不进摘除集。其余模块只读计划，不得自己再算一遍。

## 5. 策略读写（I-10 / I-11）

读：adapter.readTextSync → stripBom → JSON.parse → 形状判定 → 五级诊断（absent / ok / bom / syntax / shape / io）+ revision（seq + 内容指纹）。读到坏文件进入未读态（poisoned），此后默认拒绝写；只有 replaceCorrupt 才能整份替换，且替换前把原文写入 gate.json.bak。

写：串行队列 → 校验对象 → 读前重解析 → revision 乐观锁（冲突 409 + changedKeys）→ 备份当前文件 → 写临时文件 → rename → 更新 revision / 影子副本。rename 失败保留原文件、清理临时文件、抛 StorageError（RENAME_FAILED）。

## 6. 执行面（I-12 / I-13）

- 转发结果统一走 normalize.normalizeToolResult：文本块按单个换行拼接；image / audio / resource 原样保留为结构化块（绝不 base64 进 text）；超限降级为结构化占位摘要。
- 转发目标禁令统一走 normalize.forwardTargetRefusal：`gate_invoke` / `gate_load` / `gate_search` / `gate_status`（闸门四工具族）一律不得作为转发目标。
- 限制租约：窗口内新的目标只登记（pending），最后一个租约释放时一次施加；窗口内不得撤/改当前摘除集。

## 7. 控制面端点（由 CONTROL_PLANE_ROUTES 生成）

路由元数据是唯一真源：lib/control/routes.js 导出 CONTROL_PLANE_ROUTES，lib/server.js 用它注册 handler；本文端点表由同一份元数据生成，check-spec 会双向比对（文档缺端点或多端点都红）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/dsh-gate/state | 插件状态、层分布、诊断摘要 |
| GET | /api/dsh-gate/policy | 读策略 + 读取诊断 + revision |
| POST | /api/dsh-gate/policy | 保存策略（校验 + 乐观锁 + 备份） |
| GET | /api/dsh-gate/capabilities | 能力视图（来源 / 置信度 / 层值） |
| GET | /api/dsh-gate/skills | 技能清单与激活状态 |
| POST | /api/dsh-gate/skills | 激活 / 停用技能（tier 严格校验） |
| GET | /api/dsh-gate/mcp | MCP server 清单与连接状态 |
| POST | /api/dsh-gate/mcp | 增删 / 重连 MCP server |
| GET | /api/dsh-gate/diagnostics | 只读诊断（读取诊断 / 租约 / 计划摘要） |

约定：错误一律 >=400 + error 信封（code / message / detail / revision?），不得 200-on-failure，不得只发响应头（I-15）。

## 8. 部署接缝（I-16）

- install.ps1：探测源码 → 备份 profile → 复制源码 → 处理旧链接 → 改 package.json（bundles + dependencies）→ 追加 cordis.patch.yml 的 insert 块 → 回读校验；任一步失败按备份回滚。
- uninstall.ps1：备份 → 摘 bundles / dependencies → 删链接或移走实体目录 → 按**同一个 patch 行选择器**整块摘除 insert 块 → 回读校验（行已消失）。
- patch 行知识单真源：安装写什么形状，卸载就认什么形状；两边选择器必须一致。旧 tgz 不随包发布，移入 _quarantine/old-packaging/ 并单列说明。

## 9. 不变量 I-10–I-16

| 编号 | 内容 | 守门用例 |
|---|---|---|
| I-10 | 读策略先剥 BOM；解析失败不得空模板覆盖 | s2-storage-contract、effectiveness I-10 |
| I-11 | 落盘原子、同进程写串行、写前重解析 | s2-storage-contract、effectiveness I-11 |
| I-12 | 租约期内不得撤/改摘除集；归零后一次施加 | restriction.test、effectiveness I-12 |
| I-13 | 转发保留结构化结果块，不得字符串化 | resource-bounds、effectiveness I-13 |
| I-14 | 决策单入口，其余只投影 | decide / planner、effectiveness I-14 |
| I-15 | 控制面失败必须状态码 + 错误信封 | s3-http-contract、effectiveness I-15 |
| I-16 | 部署装卸对称、失败可回滚、patch 行知识单真源 | s5-deploy-contract、effectiveness I-16 |

I-1–I-9 由扫描链回归兜底（test/*.test.mjs + test/seams/*.test.mjs）。I-10–I-16 除回归用例之外，还必须通过 scripts/verify-effectiveness.mjs 的定点破坏：基线绿 → 把守门分支改坏 → 同一探针必须红。

## 10. 测试与接缝

| 接缝 | 覆盖 |
|---|---|
| S1 宿主契约 | 双派发语义、限制完整契约、视图三件套、会话表面、撤销器生命周期、消息构造两态 |
| S2 策略存储 | BOM、坏文件、原子写、并发、revision、备份 |
| S3 控制面 | 路由元数据、错误信封、状态码、skills 的 tier 严格校验 |
| S4 前端 | 页签降级边界、默认模板不手抄、路由缺失不白屏 |
| S5 部署 | 装/卸往返、缩进 patch 行、事务失败回滚（仅 Windows） |

扫描式 runner（scripts/run-tests.mjs）扫描 test/*.test.mjs 与 test/seams/*.test.mjs，执行清单来自 scripts/test-suites.mjs，注册表与磁盘双向比对；跳过必须带原因，静默跳过视为失败；整轮预算 < 12s。

## 11. 工程门禁（G90–G92）

check-spec 只做可失败的检查：打包内容与 files 互含、编码与行尾、CHANGELOG 版本、测试注册表、真实语法解析、端点表与路由元数据、示例与空模板、仓库根残留、术语、收口文档完整性、有效性用例锚点、CI 工作流。任何一条被改坏都必须红。
