# Changelog

本项目遵循语义化版本；0.6.0 是「全量缺陷整改 + 架构深化」的收口版本。

## [0.7.2] — 2026-11-25

0.7.2 是 0.7.1 的**缺陷收口补丁**：技能族前缀改由 `lib/naming.js` 的显式别名表解析，`/policy` 写入补上 `skills.imports` 路径闸；复核阶段又堵住两处漏拦（历史免检按「键存在」判导致等价重复直接落盘、反向查前缀大小写不敏感口径不一致），并各自钉成接缝回归门禁，回退即红。

### 一、P1 修复 · 技能族前缀与激活双通道转发 + `gate_load` outputSchema 同步扩展

- **现象**：`browser-skill` 加载成功、激活信号也送到，族内 `bsk_*` 工具却一个都放不出来（0.7.1 真机缺陷）。
- **根因**：① 族前缀只按技能名第一段切（`browser-skill` → `browser`），而该插件的工具前缀全是 `bsk_*`；② 懒加载插件仅监听 `tools/post-execute` 瀑布流，0.7.1 只派发 `tools/result` 导致注册未触发；③ 扩展 `relay` 与空放行 `diagnostic` 后，`lib/proxy.js` 的 `gate_load` `output.schema` 仍带 `additionalProperties: false` 且未声明新字段，真实宿主严格校验直接拒收。
- **修复**：
  - `lib/naming.js` 新增 `SKILL_TOOL_PREFIXES`（显式别名表，值为前缀数组）与 `toolPrefixesForSkill` / `skillsForToolPrefix` 双向查询；`lib/activation.js` 不再自己切字符串，一律问这张表，未命中才回退首段（与 0.5.4 起逐字节一致）。
  - 技能激活双通道转发（`lib/gate.js` + `lib/host-adapter.js`）：`tools/post-execute` 瀑布流 + `tools/result` 兼发，`relay` 回执含 `waterfall` / `emit` 通道明细；族前缀零命中时生成 `diagnostic` 空放行诊断。
  - `gate_load` `outputSchema` 同步扩展（`lib/proxy.js`）：拆出单通道 `RELAY_CHANNEL_SCHEMA`，`RELAY_SCHEMA` 补齐可选 `waterfall` / `emit`，`ACTIVATION_SCHEMA` 补齐可选 `diagnostic` 并随回执透出（`receipts[]` 与 `activation` 共用），全路径通过宿主 strict `additionalProperties: false` 校验。

### 二、P1 修复 · `/policy` 写入前的 `skills.imports` 路径闸

- **现象**：控制面保存策略时，新增导入目录里的 `..` 路径穿越、设备名 / UNC 路径可以直接落盘，与 `/skills` 的判定口径不一致。
- **修复**：`lib/control/policy-service.js` 在 `savePolicyFile` 之前补一道闸——结构（空路径 / `..` 穿越 / 等价重复，`policy-schema.validateSkillsImports`）与安全（设备名 / UNC，复用 `core.checkImportPath`）叠加；**只校验新增或变更的条目**，历史配置里已有的路径原样回传仍放行，老 `gate.json` 不会被一保存就锁死。非法写入一律 400 `INVALID_BODY` 且文件零字节变化。

### 三、复核缺陷收口（must-fix / should-fix 双票）

- **历史免检改为按次数扣减（must-fix）**：原先用 `Set` 按「等价键存在」判历史条目，历史已有 `skills/a` 时提交 `["skills/a", "skills/a/"]` 两条都算历史命中 ⇒ 待检集合为空 ⇒ 重复校验被整体短路 ⇒ 等价重复落盘。改为计数表逐条扣减历史配额，超出的那条按新增进入校验，重复项稳定拦成 400 `IMPORT_PATH_DUPLICATE`；`test/seams/s3-http-contract.test.mjs` 增两条回归（尾斜杠、`./` 前缀），断言 400 且文件不变。
- **反向查前缀大小写不敏感（should-fix）**：`skillsForToolPrefix` 原按 `prefixes.includes(prefix)` 精确比对，`skillsForToolPrefix("BSK")` 返回空数组，与 `TOOL_PREFIX_RE` / `toolPrefixesForSkill` 的大小写不敏感口径不一致。改为小写归一后比对，`test/naming.test.mjs` 补 `"BSK" → ["browser-skill"]` 断言。

### 四、发版元信息与测试注册表

- `package.json` / `scripts/test-suites.mjs BASELINE_VERSION` / 本段三处版本号统一为 0.7.2（G90.1 同源校验）。
- `test/seams/s4-frontend-gate.test.mjs` 实测 25 条真实挂载渲染用例：`node --test` 自报 3.49–3.56s、进程墙钟约 4.0s，默认单文件 2s 预算必被误杀；在 `OVERRIDES` 里登记 `seam-s4-frontend-gate` 并放宽到 7000ms（与 `seam-s4-frontend-v2` 同源渲染夹具同档），整轮 12s 总闸不变。

### 五、行为变化与回滚对照

| 场景 | 0.7.1 行为 | 0.7.2 行为 | 兼容性 |
|---|---|---|---|
| `browser-skill` 激活与双通道转发 | 族切成 `browser` 且只发 `tools/result`，`bsk_*` 不可见 | 按别名表取 `bsk` 并兼发 `tools/post-execute` + `tools/result`；`gate_load` `outputSchema` 同步声明 `waterfall` / `emit` / `diagnostic` | `gate.json` 形状不变 |
| 历史一条 + 本次塞等价重复 | 判成「历史原样回传」，200 且重复写进文件 | 400 `INVALID_BODY` / `IMPORT_PATH_DUPLICATE`，文件不动 | 合法保存行为不变 |
| 新增 `..` / 设备名 / UNC 导入路径 | 200 落盘 | 400 `INVALID_BODY`，错误带 `index` | 历史已有路径原样回传仍放行 |
| 反查前缀大小写 | `skillsForToolPrefix("BSK")` 为空 | 返回 `["browser-skill"]` | 只读查询，无写盘影响 |

回滚：本版不改 `gate.json` v3 语义与控制面路由，回退到 `v0.7.1` 即可，无需数据迁移。

## [0.7.1] — 2026-11-22

0.7.1 是 0.7.0 的**交互缺陷收口补丁**：只动 `client/index.js` 的视图层与动作层，不改 `gate.json` v3 策略语义、不新增控制面路由、不改后端模块；另把两处 P1 缺陷固化为 S4 渲染级回归门禁（S4G-11 / S4G-12），回退即红。

### 一、P1 修复 · 技能页导入目录渲染 `[object Object]` 且删除失效

- **现象**：技能页「自定义目录」卡片在草稿态每行显示 `[object Object]`；点「移除」界面无变化，却每次弹出「已从草稿移除，不会动原目录文件」。
- **根因**：`skills.imports` 元素为 `{ path, id, key }` 对象，0.7.0 视图直接 `String(item)` 渲染并传入 `removeImport`，导致 `draftStore.removeImport` 精确匹配 `path` 返回 `false`，动作层未判断返回值仍弹成功提示。
- **修复**：`renderSkills` 统一归一化提取非空 `.path` 字符串用于列表 `key` / `title` / 展示文本与 `removeImport(path)`；`actions.removeImport` 仅在返回 `true` 时弹成功提示，否则弹 warn「导入目录不在当前草稿里」。

### 二、P1 修复 · MCP 编辑表单未等回执就关闭，失败丢输入

- **现象**：MCP 页编辑已有服务器，点「保存更改」后表单立即清空并折叠；写接口返回 500 或网络异常时用户输入直接丢失。
- **根因**：0.7.0 保存按钮同步连续执行 `mcpAction("update", editing)`、`resetMcpDraft()` 与关闭表单，未等待 `POST /api/dsh-gate/mcp` 回执。
- **修复**：保存按钮只调用 `props.actions.mcpAction("update", editing)`；`actions.mcpAction` 仅在 `receipt.state === "applied"` 时执行 `resetMcpDraft()` 与关闭编辑表单并刷新，非 `applied` 分支原样保留用户输入以便重试。

### 三、同类审计顺手收口（1 P1 + 2 P2）

- **冲突强制覆盖刷新（P1）**：冲突弹窗确认「用面板改动覆盖」保存成功后补 `draftStore.commitKeys(draftStore.dirtyKeys())` 与 `runtime.refresh({ reason: "post-save" })`，消除草稿与旧 `expectedRevision` 残留导致的连续 409。
- **旧关闭清单草稿同步（P2）**：技能页旧关闭清单改读 `draft.offList`，暂存移除或清空即时反映在界面。
- **放弃改动同步 JSON 编辑器（P2）**：`actions.discard` 同步复位 `jsonDirty`、`jsonText` 与 `jsonNotice`。

### 四、S4 渲染级回归门禁（S4G-11 / S4G-12）

- `test/seams/s4-frontend-gate.test.mjs` 新增两条真实挂载渲染用例（共 12 条）：
  - **S4G-11**：输入导入目录并加入草稿后断言显示真实路径、零 `[object Object]`，点移除后视图与 `draftStore` 快照均清空且未命中返回 warn。
  - **S4G-12**：MCP 编辑态 `POST /api/dsh-gate/mcp` 返 500 时断言表单保持打开且用户输入保留；返 200 `applied` 后断言表单关闭且草稿重置。
- 反证校验：对 `v0.7.0`（`7373f42`）客户端运行新门禁实测 **10 pass / 2 fail**（精准拦截 S4G-11 与 S4G-12）。

### 五、行为变化与回滚对照

| 场景 | 0.7.0 行为 | 0.7.1 行为 | 兼容性 |
|---|---|---|---|
| 导入目录列表 | 渲染 `[object Object]` | 显示真实路径，命中才提示成功 | `gate.json` 形状不变 |
| MCP 编辑保存 | 不等回执立即清空折叠 | `applied` 才清空折叠，失败保留输入 | 请求与回执字段不变 |
| 冲突强制覆盖 | 成功后草稿与旧版本残留 | 成功后提交草稿并刷新基线 | 无结构变化，双向兼容 |

## [0.7.0] — 2026-11-22

0.7.0 是**纯前端版本**：不改 `gate.json` v3 策略语义、不新增后端路由、不改控制面接口签名；改的是 `client/index.js` 的视图层与样式层，以及守住这层契约的 S4 门禁。宿主升级后立刻可见的差别是——面板变成宽松卡片风、在任何主题下都真实生效、每个控件自己说清「它是干什么的、为什么需要它」，并且所有策略类改动只有一个保存出口。

本版三条线并行，缺一条都不算收口：

1. **视觉线**：颜色与间距全部改吃宿主 `--dsw-alias-*` / `--dsw-radius-*` / `--dsw-font-*` 令牌，fallback 去硬编码，层 0 / 层 1 / 层 2 各自独立色标。
2. **交互线**：4 页签 + 单吸底变更栏 + 自解释入口（每个页签一句人话目的、每个开关带后果说明、每个状态带图例）。
3. **门禁线**：S4 前端契约从「能跑」升级为「改坏必红」，并堵住旧称复活。

### 一、视觉与样式修复（宽松卡片 · 双主题 · 层色标）

- **令牌层重写**：`--dshg-surface` / `--dshg-surface-2` / `--dshg-hover` / `--dshg-border` / `--dshg-border-2` / `--dshg-fg` / `--dshg-fg-2` / `--dshg-fg-3` / `--dshg-accent` / `--dshg-focus` 一律两段式 `var(--dsw-alias-*, fallback)`。fallback 由旧版硬编码暗色（旧令牌段的 `--dshg-bg:var(--dsw-alias-bg-base,#16181d)`、`--dshg-layer1:var(--dsw-alias-layer-1,#1d20…)`）改为 `rgba(128,128,128,α)` / `color-mix(in srgb,currentColor …)` 中性自适应，亮色主题下不再出现「黑底白字硬切」。
- **作用域收口**：全部规则挂 `.dshg-wrap`；不再有裸元素选择器，也不再有宿主全局的 `:focus-visible` 书写，焦点环只存在于 `.dshg-wrap :focus-visible { outline:2px solid var(--dshg-focus) }`，宿主其它面板的焦点样式不受污染。
- **层色标各自独立**：层 1 常驻 = 绿（`--dshg-t1`，`--dsw-alias-state-success-primary`）、层 2 按需 = 蓝（`--dshg-t2`，`--dsw-alias-state-business-primary`）、层 0 关闭 = 中性灰（`--dshg-t0`，`--dsw-alias-label-secondary`）。关闭**不使用红色**：`--dshg-error` 只留给真实报错、坏策略文件与删除确认，避免把「关」误读成「坏」。
- **总开关关闭态**：`[aria-checked="false"]` 使用中性边框 + 灰圆点，修掉旧版「关 = 报错色」的误导。
- **宽松卡片基座**：卡片圆角 / 内边距 / 阴影来自 `--dsw-radius-*` 与 `--dsw-alias-settings-card-*`；能力行 `min-height:52px`；组头、成员行、参数网格共用一套卡面与分隔线，视觉密度从「表格」改为「设置页卡片」。
- **幂等注入**：宿主样式节点按 `data-dsh-gate` 属性唯一确定，重复挂载不叠加；`STYLE_SECTIONS` 内同一选择器只定义一次（S4 断言）。
- **减少动态**：`prefers-reduced-motion: reduce` 下关闭全部过渡与骨架屏动画。

### 二、交互与布局重构

- **信息架构**：去掉与宿主页头重复的大标题和内部口号，改为固定根槽位（`topbar` / `diag` / `corrupt` / `toasts` / `dialog` / `tabs` / `body` / `savebar` / `foot` 九个 + 加载占位），加载态与就绪态同树形，避免首屏跳动。
- **顶栏**：一行式，含真启停开关、常驻/按需/关闭分布胶囊、条件显示的异常与待保存徽章、刷新按钮、诊断抽屉开关。启停开关不再错绑 `reload`，只写策略。
- **诊断抽屉**：默认收起；展开展示会话来源、策略文件路径、读取时间、五路接口状态与告警汇总，排障不必再猜。
- **坏文件恢复引导条**：策略文件命中 BOM / 解析失败时给出「另存为无 BOM」与显式 `replaceCorrupt` 两个入口，替换前仍强制备份原文。
- **通知**：右上角浮动，`ok 4s / info 6s / warn 8s` 自动消失（仅 `error` 常驻待确认），每条都带手动关闭；同时最多 5 条。
- **二次确认条**：`role="alertdialog"`，打开即聚焦取消按钮，`Escape` 关闭，只用于破坏性动作——普通保存不再弹「确认丢弃」。
- **页签**：4 个（能力 / 技能 / MCP / 高级），roving tabindex 支持 `ArrowLeft/Right`、`Home/End`；旧 `json` 路由映射到「高级」，旧链接不失效。
- **单一保存闭环**：吸底变更栏在有草稿或阻断错误时显现，汇总改动项、可展开差异预览、撤销/重做、放弃，主按钮「保存更改」统一走 `POST /api/dsh-gate/policy`；遇 409 与 `changedKeys` 时就地提示刷新后重试，不再各处各存各的。
- **能力页**：两级折叠——第一级按来源分组（内置 / 插件 / 段落 / MCP / 技能包，默认折叠，搜索时自动展开），第二级只在 `内置 native` 内按职责归类（文件读写 / 搜索定位 / 命令与终端 / 网络与浏览 / 代理与任务 / 其它）；整组设层收进组头下拉菜单，行内保留常驻 | 按需 | 关闭三段切换与「原因」展开（决策链步骤条 + 逐成员例外）。
- **技能页**：修复搜索框误用能力搜索文案的缺陷；四张卡片（接管与联动 / 技能清单 / 自定义目录 / 旧关闭清单）；旧关闭清单空态整块隐藏，移除项并入草稿随底部统一保存，不再发必 400 的 `off-remove`。
- **MCP 页**：表单默认折叠，支持 `add` 与 `update` 双模式，编辑态名称只读，`stdio`（含参数预览）与 `http` 两种传输；列表按 `托管运行中 / 宿主只读 / 托管已停用 / 不可用` 分组；启停、编辑、删除即时生效。
- **高级页**：四张卡片（重复劳动护栏 / 目录格式与签名摘要 / 原始策略 JSON / 会话与运行诊断）；移除无定时器的假自动刷新（旧版状态里的 `autoInterval: 30`，刷新决策却只在有草稿时暂停、从不真正比对时间）；JSON 收敛为单一编辑器，工具栏给校验 / 格式化 / 导入 / 导出复制 / 载入默认 / 整份替换 + 差异预览；会话选择改读 `runtime.agents.ids`。
- **响应式与键盘**：`@media (max-width:720px)` 顶栏折行、筛选条全宽、能力行改上下两段、参数网格单列、变更栏紧凑折行；`Ctrl+Z` / `Ctrl+Shift+Z` 全局撤销重做，输入框聚焦时不劫持原生文本撤销。

### 三、控制面与前后端契约修复

- **接口零变更**：沿用 0.6.0 的 `CONTROL_PLANE_ROUTES` 路由表，本版不新增端点、不改请求体与响应体形状；`docs/ARCHITECTURE.md` 端点表与路由元数据仍由 G90.9 双向比对。
- **写路径唯一**：策略类改动只走 `POST /api/dsh-gate/policy`（带 revision 乐观锁）；MCP 写操作即时生效，但每次写后回读一次状态，失败按错误信封 `code / message / detail` 落到通知条，不再静默。
- **坏文件与 BOM**：读取诊断（`absent / ok / bom / syntax / shape / io`）在面板上可读可操作；进入未读态时禁止覆盖写，只给恢复引导。
- **前端降级边界**：每个页签独立错误边界（I-6），单页签渲染失败不白屏整页，失败页签内给重试按钮。
- **单文件约束不变**：仍是 `client/index.js` 一份零构建源码，L1–L7 命名空间职责不动；入口注册段不超过 20 行（S4 断言）。

### 四、测试门禁升级（S4 前端契约）

`test/seams/s4-frontend-v2.test.mjs` 由「语法能过」升级为契约级，新增/加强的断言：

| 断言 | 位置 | 改坏会怎样 |
|---|---|---|
| `PANEL_VERSION` = `package.json` 版本（本版 0.7.0） | `s4-frontend-v2.test.mjs:172` | 版本漏改即红 |
| 旧称四词在 `client/index.js` 零命中 | `s4-frontend-v2.test.mjs:195` | 复活旧文案即红 |
| `text()` 键必须存在于文案表、文案表每个键必须被引用（双向零死键） | `s4-frontend-v2.test.mjs:186-194` | 死键或拼错键即红 |
| 样式必须用 `--dsw-alias-` 令牌、`:focus-visible` + `outline:2px`、尊重 `prefers-reduced-motion` | `s4-frontend-v2.test.mjs:198-204` | 去掉令牌/焦点环/减少动态即红 |
| 同类选择器单定义；样式节点属性 `data-dsh-gate` | `s4-frontend-v2.test.mjs:205-215` | 重复定义即红 |
| 入口注册段 ≤ 20 行 | `s4-frontend-v2.test.mjs:218-225` | 入口膨胀即红 |

配套：G92.3 的 `client/index.js` 旧称计数由 WARN 降为 0；G91.1 仍以 FAIL 级守住 `README.md` 与 `docs/*.md`。真机验收补 1440px 与 ≤720px × 亮/暗双主题四张截图。

### 五、版本联动与发布

- 版本号从 `0.6.0` 升到 `0.7.0`，联动 6 处（`package.json` / `scripts/test-suites.mjs` 基线 / `client/index.js` 三处 / S4 断言），逐条见本文件第二节。
- 发版顺序：`npm run check` → `npm test` → `npm run test:effectiveness` 全绿 → `npm pack` → main 提交 + tag `v0.7.0` + Release 挂资产 zip → 用户在插件市场手动更新（只推提交不算发版）。
- 本段插在 `## [0.6.0]` 之前，**0.6.0 历史段一字不动**：G91.3 扫的是 0.6.0 段内 17 条缺陷编号 + X-1 + D-1 + I-10–I-16 + L143 + 回滚 + P0–P3，任一缺失即红。

### 六、行为变化与回滚说明（L143 对照清单）

| 场景 | 0.6.0 行为 | 0.7.0 行为 | 兼容性 / 迁移动作 |
|---|---|---|---|
| 面板结构 | 7 个页签、多处各自保存 | 4 个页签 + 单一吸底变更栏 | 纯前端；旧 `json` 路由自动映射到「高级」 |
| 策略保存 | 各页签分别 `POST`，失败各自提示 | 统一 `POST /policy`，409 + `changedKeys` 提示刷新 | `gate.json` 字段与语义完全不变，无需迁移 |
| 自动刷新 | 30s 轮询（无定时器的假刷新） | 改为手动刷新 + 诊断抽屉显示读取时间 | 在意刷新的用户改用顶栏刷新按钮 |
| 关闭清单移除 | 发 `off-remove`（后端必 400） | 并入草稿，随底部保存统一落盘 | 旧配置键不变 |
| MCP 表单 | 常显 | 默认折叠，点「+ 添加服务器」展开 | 无感，行为等价 |
| 颜色语义 | 关闭态用红 | 关闭态中性灰，红只表示错误 | 视觉语义变化，操作含义不变 |
| 面板用语 | 层级的旧说法 | 「层 0 / 层 1 / 层 2」（关闭零、常驻一、按需二） | 仅文案变化，策略键名不变 |
| 顶栏总开关 | 错绑「重新读取」 | 只写 `enabled` 策略 | 修的是缺陷，无迁移 |

**回滚**：① 面板侧无持久化改动，回滚只需装回 0.6.0 资产（`npm pack` 产物或 `_quarantine/old-packaging/` 内的 0.6.0 tgz），profile 的 `package.json` 与 `cordis.patch.yml` 用安装时备份还原；② `gate.json` 全程未被本版改写，回滚后无需反向迁移；③ 回滚不改变模型侧可见能力，策略语义未动。

### 七、门禁自证

- G90.1 版本基线 / 包元数据：`package.json` = `scripts/test-suites.mjs:24 BASELINE_VERSION` = 0.7.0。
- G90.4 CHANGELOG 顶部版本 = `package.json`，标题含 `— 2026-11-22`，段落远超 30 行下限。
- G91.1 文档术语统一：`README.md` 与 `docs/*.md` 零旧称。
- G91.3 0.6.0 收口段完整：历史段未改，断言照旧通过。
- G92.3 面板文案：`client/index.js` 旧称计数为 0（由 WARN 转 PASS）。

## [0.6.0] — 2026-11-21

0.6.0 有两条并行主线，缺一条都不算收口：

1. **缺陷修复线**：回放审计的 17 条缺陷（P0-1 .. P2-5）全部修复并由回归用例守住；跨域缺陷 X-1、部署缺陷 D-1 同批处理。
2. **架构深化线**：把「谁落哪层、策略怎么读写、宿主怎么读、名字怎么切、结果怎么规范化」拆成六个可独立测试的模块（外加执行面公共件 normalize），并首次把 I-10–I-16 写成可执行不变量。

### 一、缺陷修复线（17 + 2）

| 编号 | 级别 | 接缝 | 不变量 | 问题 | 回归用例 |
|---|---|---|---|---|---|
| P0-1 | P0 | S2 | I-10 | 策略文件带 BOM 时静默失守，全部工具被当作常驻 | s2-storage-contract · BOM |
| P0-2 | P0 | S2 | I-10 | 坏文件被空模板覆盖落盘 | s2-storage-contract · 坏文件不覆盖 |
| P1-1 | P1 | S3 | I-15 | mergePolicyFile 遇 mcp:null 抛 TypeError，HTTP 无响应 | s3-http-contract |
| P1-2 | P1 | S2 | I-4 | enabled:true 覆盖不掉显式 false | policy.test |
| P1-3 | P1 | S2 | I-4 | v2→v3 迁移丢 repeatGuard 段落 | migrate.test |
| P1-4 | P1 | S1 | I-2 | glob:* 跨轴污染 | capabilities.test |
| P1-5 | P1 | S1 | I-3 | 激活提升绕过 explicit off | activation.test |
| P1-6 | P1 | S1 | I-3 | off 段落仍可 load（关闭不生效） | sections / planner.test |
| P1-7 | P1 | S1 | I-3 | 已加载压制 off（重载后关闭被忽略） | planner.test |
| P1-8 | P1 | S1 | I-8 | 非 text 块被 stringify 破坏 | resource-bounds / normalize.test |
| P1-9 | P1 | S1 | I-8 | suspend 非重入窗口全量放表 | restriction.test |
| P1-10 | P1 | S3 | I-15 | POST /skills 的 tier 被强转 0 | s3-http-contract |
| P2-1 | P2 | S1 | I-5 | PTC 冻结下 tiers 与 status 快照自相矛盾 | snapshot.test |
| P2-2 | P2 | S1 | I-7 | searchCatalog limit 传 0/-1 返回全量 | catalog-search.test |
| P2-3 | P2 | S1 | I-7 | firstSentence 截断版本号 | catalog-search.test |
| P2-4 | P2 | S1 | I-7 | 中文别名子串误命中 | catalog-search.test |
| P2-5 | P2 | S1 | I-9 | gate_call 可自调转发（无限递归风险） | proxy-args.test |
| X-1 | P0 | S4 | I-6 | 前端路由缺失时整页白屏（无降级边界） | s4-frontend-contract |
| D-1 | P1 | S5 | I-16 | uninstall 认不出 install 写的缩进 patch 行（卸不掉，且可能留下孤立 insert） | s5-deploy-contract |

修复不是「改一处让用例变绿」，而是把根因收口到结构上：

- P0-1 / P0-2 的根因是「读策略」与「写策略」各处各自 fs.readFileSync + JSON.parse，BOM 与解析失败没有单一处置点。现在统一走 storage-seam 的五级读取诊断（absent / ok / bom / syntax / shape / io）与未读态（poisoned）；坏文件只有显式 replaceCorrupt 才能整份替换，且替换前强制备份原文。
- P1-1 / P1-10 / X-1 的根因是控制面与前端各自拼错误处理与降级边界。现在控制面统一错误信封与状态码（I-15），前端每个页签有独立降级边界（I-6）。
- P1-2 / P1-3 / P1-4 / P1-5 / P1-6 / P1-7 / P2-1 的根因是「谁落哪层」被算了四遍。现在决策只存在于 decide.js，装配只存在于 planner.js，其余位置只投影（I-14）。
- P1-8 / P2-2 / P2-3 / P2-4 / P2-5 分属执行面与目录/检索面：结果规范化收口到 normalize.js（I-13），目录检索边界与 gate 工具族禁令各有回归用例。
- P1-9 的租约语义（I-12）与 D-1 的部署对称（I-16）各有独立接缝用例。

### 二、架构深化线（六模块 + 执行面公共件）

| 模块 | 职责 | 依赖纪律 |
|---|---|---|
| lib/policy-schema.js | 策略字段的唯一真源：模板、归一、逐键合并、严格校验、内省、迁移键集全部由它派生 | 只依赖 capabilities / catalog，不读文件 |
| lib/storage-seam.js | 唯一落盘边界：BOM、原子 rename、备份、revision、并发写串行、五级读取诊断 | 文件系统以适配器注入（内存/磁盘） |
| lib/decide.js | 归层决策引擎：工具 / 段落 / 技能三轴 × 层值 / 桶 / 原因 | 只依赖 tiers.js，不 import 宿主、不读 ctx |
| lib/naming.js | 命名与分组：能力 id、目录分组、技能来源标签的唯一实现 | 只依赖 tiers.js |
| lib/planner.js | 一次产出不可变计划；下游七个派生点只读计划 | 只依赖 decide.js |
| lib/host-adapter.js | 所有「只有宿主知道」的读取与派发（视图三件套、执行器判定、隔离派发、消息构造） | 运行时层只通过它问宿主 |
| lib/normalize.js | 执行面公共件：结果规范化（文本单换行拼接、结构化块原样保留、超限占位摘要）与转发目标禁令 | 零依赖（proxy 与 guardrail 共用） |

拆分的判据不是「文件更小」，而是**同一件事只有一个实现**：策略字段只有 policy-schema 知道、落盘只有 storage-seam 知道、落层只有 decide/planner 知道、名字切分只有 naming 知道、宿主形状只有 host-adapter 知道、结果拍平只有 normalize 知道。

### 三、不变量 I-10–I-16（0.6.0 起可执行）

- **I-10** 读策略先剥 BOM；解析失败进入未读态，绝不以空模板覆盖落盘。
- **I-11** 落盘原子（临时文件 + rename）；同进程写串行；写前重解析；rename 失败保留原文件。
- **I-12** 租约期内不得撤/改当前摘除集；窗口内先记账，归零后一次施加。
- **I-13** 执行转发保留结构化结果块（image / audio / resource），不得字符串化。
- **I-14** 决策单入口（三轴 × 四维 → 层值 / 桶 / 原因），其余位置只投影。
- **I-15** 控制面失败必须状态码 + 错误信封，不得 200-on-failure、不得只发头。
- **I-16** 部署装卸对称、失败可回滚、patch 行知识单真源。

I-1–I-9 由扫描链回归兜底；I-10–I-16 另有定点破坏自检（scripts/verify-effectiveness.mjs）逐条证明「改坏必红」。

### 四、L143 行为变化对照清单

L143 记录的是「升级后行为会变」的显式清单。0.6.0 的变化如下（升级前请逐行确认）：

| 场景 | 0.5.7 行为 | 0.6.0 行为 | 兼容性 / 迁移动作 |
|---|---|---|---|
| 策略文件带 UTF-8 BOM | BOM 导致 JSON.parse 失败，静默落回空模板，全部工具常驻 | 先剥 BOM 再解析，读取诊断标 bom；策略按文件内容生效 | 无需改文件；建议顺手另存为无 BOM |
| 策略文件损坏 | 空模板覆盖原文件，用户配置永久丢失 | 进入未读态，默认拒绝写；显式 replaceCorrupt 才替换且备份原文 | 修好后重新保存；原文件在 gate.json.bak |
| 并发保存策略 | 后写覆盖前写，备份链错乱 | 同进程串行 + revision 乐观锁；冲突返回 409 与 changedKeys | 面板遇 409 应刷新后重试 |
| 限制期间重算 | 窗口内直接改摘除集，正在跑的工具被 deny | 窗口内只登记待生效目标，最后一个租约释放时一次施加 | 无感；suspend 并发语义更严格 |
| 工具返回图片/音频 | 结构化块被 stringify 成文本，模型看不见 | 结构化块原样转发；超限降级为占位摘要 | 无感；上游若依赖旧文本形态需改读结构化块 |
| 策略显式写 0（关闭） | 已加载 / 激活提升可能把它抬回来 | 显式关闭高于一切；已加载只能把按需抬成常驻 | 检查依赖「加载后自动恢复」的配置 |
| 控制面失败 | 可能 200 + 空体，或只发响应头 | 统一 >=400 + error 信封（code / message / detail） | 调用方按状态码判定，不再看 200 的 body |
| GET /api/dsh-gate/diagnostics | 不存在 | 新增只读诊断端点（读取诊断 / 租约 / 计划摘要） | 面板与排障脚本可接入 |
| 文档端点表 | 手写，易漂 | 由 CONTROL_PLANE_ROUTES 生成，check-spec 双向比对 | 新增端点必须同时改路由表 |
| 测试入口 | package.json 32 段 && 长链，链外两个 .test.mjs 从未执行 | scripts/run-tests.mjs 扫描 test/**.test.mjs 与 test/seams/*.test.mjs，注册表与磁盘双向比对 | npm test 语义不变；单套件用 --filter |
| 面板用语 | 「档位」「等级」 | 「层 0 / 1 / 2（关闭零、常驻一、按需二）」 | 旧配置键不变，仅文案变化 |
| 部署卸载 | uninstall 只删两行，缩进 patch 行卸不掉，可能留下孤立 insert | 安装事务化（备份 + 失败回滚）；卸载按 patch 行知识单真源整块摘除 | 先用 -DryRun 核对计划，再执行 |

### 五、阶段化集成与独立回滚（P0–P3）

四个阶段各自可独立回滚：任一阶段失败，只回退该阶段的提交，不需要把前序阶段一起回退。

| 阶段 | 内容 | 独立回滚方式 | 必过门 |
|---|---|---|---|
| P0 门禁与 runner | check-spec 升级、test-suites 注册表、run-tests、verify-effectiveness、CI 工作流 | 还原 scripts/check-spec.mjs、scripts/run-tests.mjs、CI 文件；npm test 回退到旧链（仅应急） | npm run check + npm test 全绿；effectiveness 13/13（I-15 缺 errors.js 时 blocked） |
| P1 策略存储与 schema | policy-schema、storage-seam、policy 接入、BOM / 坏文件 / 并发修复 | 还原对应 lib 文件与 gate.json 读写调用点；保留备份 | s2-storage-contract、policy.test、migrate.test |
| P2 决策与执行面 | decide、naming、planner、host-adapter、normalize、关闭/加载/租约修复 | 还原对应 lib 文件；planner 调用点回到旧 planFor | decide / planner / naming / host-adapter / restriction / resource-bounds |
| P3 部署、控制面与收口文档 | install/uninstall 事务化、CONTROL_PLANE_ROUTES、diagnostics、README/ARCHITECTURE/CHANGELOG | 还原 scripts/install.ps1、uninstall.ps1 与 docs；profile 用备份回滚 | s3/s5 接缝、check-spec 全绿、装/卸往返逐字节回初始 |

回滚前置：任何阶段回滚前先备份 profile 的 package.json 与 cordis.patch.yml；旧 tgz（0.4.0 / 0.4.1）已移入 _quarantine/old-packaging/ 并单列说明，不随 0.6.0 发布。

### 六、验证记录（0.6.0 发布门）

- npm run check：全量门禁通过（0 FAIL / 0 WARN），覆盖打包内容、编码与 BOM、端点表、示例模板、恒真断言与术语统一。
- npm test：扫描式 runner（默认 4 并发，LJF 调度）覆盖 test/ 与 test/seams/ 全部必过套件，跳过项均带原因；具体套件数、断言数与用时以实际运行输出为准（总预算 12s）。
- npm run test:effectiveness -- --strict：全部宿主事实（HF-1–HF-6）与不变量（I-10–I-16）定点破坏用例均为 effective。
- 装/卸往返：Windows 上 install → uninstall → 再 install，profile 逐字节回到初始状态。
- 发布红线：只推本地提交，不 push / 不 tag / 不建 Release；发版由维护者按 release.yml 手动触发。

版本号遵循语义化版本；格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.5.7] — 2026-11-20

### Fixed — 激活回执带 `promoted`（0.5.6 的同一类错换了个位置）

0.5.6 真机验收通过（office 族 3 个工具进 resident、`office_render` 真执行、`office_convert` 真转出一个 77 B 的 CSV），
但读回执时发现 `activation` 里**没有 `promoted`**：`loadSkill` 只把 `promoted` 放在返回对象顶层，而 `gate_load`
经 proxy 只透出 `activation` 这一个字段 ⇒ 「让用户去看 `activation.promoted`」在真机上等于没发生。
与 0.5.5 回执被 schema 裁掉是同一类错：**诊断字段必须落在模型真正看得到的那个对象里**。

- `lib/gate.js`：`activation` 增加 `promoted`（与顶层同源，不再两处各自演化）。
- `test/activation.test.mjs`：端到端与「认不出 when」两条回归点都断言 `activation.promoted === promoted`。

### 流程变更（用户 2026-11-20 16:53）

gate 的升级修复改为**先在 WSL 里的 dsh 完成验收、通过后才推 GitHub**（WSL 里可装插件复刻 office/univer 的技能激活场景）。
本版即第一个走该流程的版本：本地 `npm run verify` 全绿 → WSL 验收 → 通过后才 push + tag + Release。

## [0.5.6] — 2026-11-20

### Fixed — 技能族「族内全放」+ 激活回执真的送到模型

0.5.5 真机：`gate_load(["skill:office-pptx"])` 报成功，但返回对象里 `activation` 是 `undefined`，
`gate_status` 的 resident 不增，`gate_invoke({ tool: "office_render" })` 仍 `unknown tool`。
对照 univer 正常 ⇒ 两个独立的错叠在一起：

1. **回执被 schema 裁掉**：`lib/proxy.js` 的 `gate_load` `output.schema` 是 `additionalProperties: false` 且只列
   `loaded / unknown / denied / skillText / deltaText`，0.5.5 写进结果的 `activation` 在 proxy 层就丢了。
   诊断信息写了却永远到不了模型 —— 这本身是 0.5.5 的设计缺陷。
2. **放行判据认不出 office 的门**：`pickPromotable` 当时要求「名字在我们认出的 `conditional` 集合里」，
   而 `conditionalNamesOf()` 真机只认得出 univer 的 `when`、认不出 office 的（`dsh-tool-office` 与
   `dsh-univer-office` 的激活门源码一字不差，原因仍未查明）⇒ office 族永远放不出来，与「信号有没有送到」无关。

改法：

- **族内全放**（`lib/activation.js`）：`pickPromotable` 不再读 `conditional`。判据变成
  「注册在案 + 族内（名字 = 族 或 `族_` 前缀）+ 不在 explicit `off` + 不在 resident」，结果排序返回。
  族外一个不碰；能不能执行交给宿主自己判（plain 工具放出来照样能跑，conditional 工具下一步才有机会进 `toolSet`）。
- **`promoteSkillFamily` 不再因「认不出 conditional」整体放弃**（删掉 `conditional.size === 0` 的早退）。
- **回执进 schema**（`lib/proxy.js`）：`gate_load` 的 `output.schema` 新增
  `activation: { skill, conditional, promoted[], relay: { mode, listeners, delivered, failed[] } }`（仍 `additionalProperties: false`）；
  成功加载多条技能时取最后一条。render 在 `relay.failed.length > 0` 时追加一行
  「激活信号：送到 N/M 个监听者（mode）；失败 K 个：…」。
- **转发带 toolSet 的范围放宽**（`lib/gate.js` `callThrough`）：`promoted` 里的名字与 conditional 注册同待遇，
  转发时一并交出本步 `exec.toolSet`。

### 测试

- `test/activation.test.mjs` 第 3 组改写：不再断言「非 conditional 不放」，改为断言族内全放 + 换族只出本族。
- 第 4 组（off / 常驻）按新判据重算期望值，幂等与 `off` 语义不变。
- 第 5 组新增回归点：宿主工具表里**没有**能认出的 `when`（`conditional: []`，真机 office 的样子）时，
  `loadSkill("office")` 仍须把 `office_render` 放进 resident 并从 deny 移除。

## [0.5.5] — 2026-11-20

### Fixed — 技能激活信号逐个派发（office_* 也点亮）

0.5.4 真机验收：univer 族 14 个工具全部可执行（`univer_status` 返回 `INVALID_FILE_PATH` 而不是
`unknown tool`），但同形的 office 族 3 个工具仍 `unknown tool`。查宿主源码：

- office 工具由宿主内置 `@deepseek-ai/dsh-tool-office` 注册，激活门与 univer **一字不差**：
  `ctx.on("tools/result", …)` 置 `marked`，`when = marked.has(agent) || requestHeader().tools.some(…)`；
- cordis 的 `emit` 是 `dispatch().map(cb => cb(...args))` —— **一个监听者抛错，排在后面的一律收不到**
  （0.5.3 复审在 dsh-agent-instructions 上踩过一次，只修了 exec 形状）；
- 两家形状相同、结局不同 ⇒ 差别只在排队位置：有监听者夹在中间抛错。

改法：不再用 `ctx.emit`，改走 cordis 自己的 per-listener 通道 `ctx.events.dispatch("emit", …)`
（宿主 `emitPluginDisposed` 同款用法）：拿回绑定好的回调后**逐个调用 + 各自 try/catch**，
谁抛只记进 `failed`，后面那家照样收到信号。没有 `events.dispatch` 时（老宿主/测试桩）退回 `ctx.emit`。

- **Added — 加载回执带激活诊断**：`gate_load` 的结果新增 `activation: { relay: { mode, listeners, delivered, failed[] }, conditional, skill }`。
  真机看不到 `ctx.logger`，这条回执让「信号没送到 / 送了但 when 仍是假 / 压根没认出 conditional」三种失败可区分，不必再发诊断版。
- **Fixed — `unknown tool` 提示覆盖 promoted 工具**：同一步里 `gate_load` 之后立刻 `gate_invoke`
  （那一步的 `toolSet` 冻结在放行之前）现在也给「先激活、新一步再调」的可执行提示，不再原样抛宿主文案。

### 测试

- `test/host.mjs`：可选 `isolatedEvents`（暴露 `ctx.events.dispatch`，语义同 cordis：只取回调、不执行）。
- `test/activation.test.mjs` 第 6 组：排在前面的监听者抛 `TypeError`，后面的照收；断言
  `mode=isolated`、`listeners=2`、`delivered=1`、`failed=["boom"]`，且 `exec.signal` 仍在。

## [0.5.4] — 2026-11-20

### Fixed — 技能激活族的工具真正可执行（D2 收口）

0.5.3 的 `activationRelay` 只补了「信号」，实测 `gate_load(["skill:univer"])` 成功（正文 9,322 字）后
`gate_invoke({ tool: "univer_status" })` 仍返回 `Error: unknown tool`。根因是宿主执行面的第二道限制，
与信号有没有发出去无关：

- `dsh-tools/lib/index.js:531-535` → `executable(name, scope, toolSet)`：`toolSet === undefined` 时，
  `view.registrations.get(name)?.when === void 0` 才返回定义，**带 `when` 的 conditional 注册一律 undefined**；
- `gate.callThrough` 的 `tools.execute({callId,name,agent,arguments,signal})` 正是无 `toolSet` 调用
  （它发生在模型 step 之外），所以 univer/office 那 17 个工具永远 `UNKNOWN_TOOL`；
- 而且这些工具被闸门 deny ⇒ 不进 `tools.resolve()` 的 admission ⇒ 即使 `when` 为真也没有「步内」执行口。

两半一起修（缺一不可）：

- **Added — `skills.activationPromote`（默认开）**：`gate_load("skill:x")` 成功后，按「技能名第一段 = 工具族前缀」
  （`univer` / `univer-sheet` → `univer_*`；`office-docx` → `office_*`）把该族**带 `when` 的注册**从 deny 放出，
  在 `planFor` 里按常驻处理 —— 下一步它们才会被声明并进 admission。只放 conditional（没有 `when` 的工具按档位走），
  绝不碰 explicit `off`，已常驻的不再放（幂等）。`false` 可整体退回 0.5.3 行为。
- **Fixed — 转发带上本步 `toolSet`**：`gate_invoke` / `gate_call` 把自身 `exec.toolSet` 交下去；
  `callThrough` 只在目标是 conditional 注册时才带（非 conditional 工具保持 0.5.3 语义，第二层工具照样能转发）。
  拿不到 `toolSet` 时返回可执行提示（先 `gate_load`，**下一步 / 新程序**里再调），不再原样抛宿主那句
  `unknown tool`（模型会以为名字写错，跑去换名字）。
- **Fixed — 归层表与工具面同口径**：`tierMap` 对已放出的工具报常驻，面板不再显示「按需」而工具其实已在工具表里。
- **新增 `lib/activation.js`**（纯判断，可单测）：`skillFamilyOf` / `familyToolNames` / `pickPromotable`；
  族切分只认标识符形状 + 第一段，匹配只认「名字就是族」与「族_ 前缀」—— 误放等于把用户藏的工具塞回工具表。
- **测试**：`test/activation.test.mjs` 6 组（族切分 / 族内判据 / 只放 conditional / off 与幂等 /
  端到端「加载技能 ⇒ 该族工具进常驻面、从 deny 消失」/ `activationPromote=false` 退回）；
  `test/host.mjs` 增加 conditional 注册与 `view().registrations`（与真实宿主同形）；
  `migrate` / `server-skills` 的 skills 形状断言同步。`npm run verify` 全绿。
- **注意**：仍要**重启 DSH** 才生效（插件代码随市场更新落盘）；本次不需要改 `gate.json`（默认值就是开）。

## [0.5.3] — 2026-11-20

### Added — 重复调用护栏（`repeatGuard`，**默认关**）

- **动机**：宿主自带的 `@deepseek-ai/dsh-repeat-tool-reminder` 判据只有「**连续**同样调用」，而 PTC 会话里
  `run_code`（外层）与内层 `pwsh` 交替落事件，每来一条别的调用就把链重置为 1。实测 7dff3468：402 次
  `pwsh`、107 处同命令重复、最长连续 run 只有 2 —— 现行 3/5/8 判据**一次都没触发**。
- **判据换代**（`lib/guardrail.js`）：① 身份仍是精确签名 `(工具名, 深键序 JSON(args))`（换参数 = 新签名，
  这是误伤免疫器，禁模糊/家族归一）；② 相邻性换成**窗口** `windowSize=20`（中间夹几条别的调用仍算同一条链）；
  ③ **结果指纹** `len + sha1(前/中/后各 4KB) + isError` —— 文件改了重读、job 出新输出自动重置 episode，
  「参数一样 + 结果一字未变」才是真低效。deny / `UNKNOWN_TOOL` 用固定哨兵：对着拒绝硬撞同样该被看见。
- **触发**：第 `windowThreshold`（默认 3）、2×、3× … 次各提醒一条，每个 episode 最多
  `maxRemindersPerEpisode`（默认 2）条；首条只给事实 + 三个替代动作，第二条补上出现位置。
- **只降级提示，不 block**：护栏挂在 `tools/post-execute`，调用已经发生，在这里拦只能罚下一次 ——
  误拦一次 = 任务中断，误提示一次 ≈ 150 token。消息折在 `additionalContexts` 最前面，下游决策（含 block）原样保留。
- **transparent exclude**：`wait_agent` / `todo_write` / `list_agents` / `job_list` / `team_task_list` 不计数、
  也不推进时钟（不打断别人的链）；支持 `*` 通配符。
- **默认关**：`repeatGuard.enabled` 只认显式 `true`。打开前**必须**在 profile 的 `cordis.patch.yml` 里停用
  宿主那一行（`- id: repeat-tool-reminder` + `disabled: true`），否则每条提醒发两次（状态是进程内 per-agent）。
- **用户插话即刷新**：`agent/pre-step` 看到 `source.kind === 'user'` 的消息就清掉该 agent 的状态。

### Added — `skills.activationRelay`（默认开）

- **修的能力丢失**：`univer_*` 14 + `office_*` 3 共 17 个工具「目录里可见、`gate_load` 报成功、执行报
  unknown tool」。根因是 `dsh-univer-office` 这类插件的**技能激活门**只认宿主 `skill` 工具的
  `tools/result(exec.name === "skill")` 信号；技能接管后那个工具被 deny，信号永远不来 ⇒ 工具永不注册。
- **修法**：`loadSkill` 成功（`reapply(agent)` 之后）补发一条 `tools/result` 伪事件，
  `toolCallId = "gate-load-skill-<name>"`（可识别、可排查重复计数）；失败只 warn。
- **逃生门**：`skills.activationRelay: false` 一键关掉（万一有监听者把伪事件当真结果写进历史，改文件 + 重启即可止血；
  故意不进面板）。

### Fixed — 0.5.3 代码复审（blocker 1 + major 4，全部已修并入测试）

- **伪事件的 exec 形状补齐**（blocker）：cordis 的 `emit` 是 `dispatch().map(cb => cb(...args))`，**没有 try/catch** ——
  一个监听者抛错就中断后续监听者并把异常抛回发射方。宿主 `dsh-agent-instructions` 的监听者会读
  `exec.signal.aborted`，只发 `{agent,name,arguments,toolCallId}` 会让它抛 TypeError，排在它后面的
  univer/office 激活门**永远收不到信号**（转发等于失效）。现在伪 exec 带 `callId / rootCallId / signal / parent`。
- **`repeatGuard` 进 `POLICY_KEYS` / `V3_KEYS`**（major）：不进键表时 `mergePolicyFile` 只遍历表内键，
  面板/接口**非 replace 保存**与「恢复默认」都会把 `repeatGuard` 静默丢掉。现在读、规范化、保存、禁用态四处同源。
- **结果抖动不再白拿提醒**（major）：结果指纹变化只重置 `copies`、**不清 `fired`** —— 否则「结果每次带个时间戳/进度」
  的循环每轮都能重拿两条，`maxRemindersPerEpisode` 形同虚设。配额属于这条链。
- **`exclude` = 默认五项恒在 + 追加项**（major）：原来「用户写了 exclude 就整体替换」，只加一个 `gate_*` 就把
  `wait_agent` / `job_list` 放回计数，第一次轮询就被当循环提醒。
- **提醒 id 加 agent 级序号**（major）：同一签名第二次走到同一个 `copies` 时，id 与上一轮逐字节相同；
  上游同职责实现用 randomUUID，说明 id 被当唯一键用。现在 seed = 签名 + 链起点 + copies + 该 agent 提醒序号
  （同一段历史重放仍逐字节稳定，不破前缀缓存）。
- **`windowSize` 语义修正**：允许夹在中间的**其它**调用条数（原来 `now - lastPos` 少给一条，注释与实现不一致）。
- **测试**：`test/guardrail.test.mjs` 8 → 10 组（新增「抖动不白拿提醒」「`repeatGuard` 走保存/规范化/解析全链不丢」），
  转发用例新增两个按真实形状写的监听者（读 `exec.signal.aborted` / 排在后面的激活门），
  `test/host.mjs` 把监听者异常记进 `emittedErrors` 供断言；`policy` / `mcp-int` 的键表断言同步。
- **注意**：护栏配置在挂载时读一次 —— **面板/文件改 `repeatGuard` 后要重启 DSH 才生效**（与 `gate.json` 其它键一致）。

### Changed — PTC 目录的用法句按会话模式分叉（`lib/catalog.js`）

- 原句「先 `gate_load` 加载，下一步即可直接调用」在 PTC 冻结下是错的：加载不改工具表，模型照做会撞
  `UNKNOWN_TOOL`。冻结时改为「先 `gate_load`，再用 `gate_invoke({ tool, arguments })` 调用（工具表已冻结）」。
  native 会话逐字节不变。

### Refactor — 注入消息统一到 `lib/messages.js`

- 技能正文 / 尾部声明 / 护栏提醒共用一份 `createGateUserMessage`：优先宿主 `createUserMessage`，
  拿不到才退化成**确定性 id**（前缀 + 正文 sha1 前 12 位）的同形状对象 —— id 每步都变就会从这条消息处断前缀缓存。

### Compatibility

- 策略层新增两个键（`repeatGuard`、`skills.activationRelay`）：老 `gate.json` 不需要改，缺省即 0.5.2 行为
  （护栏关、转发开）。`gate_status` 键集、`gate_invoke` / `canInvoke` / 冻结判定零改动。
- 与宿主护栏**不要同时开**：`repeat-tool-reminder` 那一行请先 `disabled: true`。

### Tests

- 新增 `test/guardrail.test.mjs`（8 组）：配置归一与默认关闭、深键序签名与指纹、触发节奏 3/6 与封顶、
  结果变了重置、窗口内/外、exclude 透明、用户插话重置 + 无 agent 降级、技能激活转发（发一次 / 失败不发 / 可关）。
- `test/migrate.test.mjs`、`test/server-skills.test.mjs` 的 `skills` 形状断言补 `activationRelay: true`。
- `test/host.mjs` 补 `postExecute` 运行器与 `emit` 记录、`preStep` 传 `messages`（护栏与转发都要能被断言）。

## [0.5.2] — 2026-11-18

### Docs — 成本口径勘误正式发版

- 0.5.1 的内容（目录签名摘要 + README「PTC 语义边界」）未变，本版**只补发版**：
  0.5.1 当时版本号已升、提交已推，但没打 tag，市场把它读成「有新提交（未发版）」而不是更新。
- 文档勘误正式进版：README 成本表下已注明 **「净省 ≈26.7k / 请求」是 `estimateTokens` 折算的前缀差，
  不是账单上的每请求省额**；v4 会话日志其实**带** usage 字段（`assistant/message.data.usage`：
  `inputTokens / outputTokens / totalTokens / cacheReadTokens`），此前研究包判「无该字段」有误。
- 实测（0.5.x 期 PTC）：单请求上下文（input + cacheRead）中位 107,014 tok，其中 cacheRead 中位 104,576
  （≈98% 命中）；fresh input 中位 1,233 → 1,075。**判据 C 的「省费用」一半记为样本不足、不予判定。**
- 代码零改动，与 0.5.1 逐字节相同。

## [0.5.1] — 2026-11-18

### Added — 目录签名摘要（`catalog.signatureSummary`，默认开）

- **动机**：PTC 冻结下模型写 `run_code` 只能用 `gate_invoke({ tool, arguments })`，而目录原来
  只有名字 + 一句说明 —— 参数名得先 `gate_load` 拿签名，多一次往返、多一次写错参数的机会。
- **修法**：`renderCatalog` 新增签名段（`名字(必填参数, 可选参数?)`）；参数取 `required` 列表 +
  `properties` 名，必填在前、其余按 schema 声明顺序，可选带 `?`，单个工具最多 6 个参数。
- **选择口径**：只对 `catalog.signatureSummary.tools` 点名的工具出摘要，**按名字字典序**
  （不按频率：同一策略 + 同一工具集重复渲染必须逐字节一致）；无 `required` 的工具不出行。
- **只在 PTC 冻结下渲染**：native 会话的目录与不开这项时逐字节相同。
- **预算**：目录增量 ≤ +2k tok ⇒ 按 3.75 字符/tok 反推 **7,500 字符**；满预算即停，不截半行。
- **配置**：`catalog.signatureSummary: { enabled: true, tools: [] }`（挂在 `POLICY_KEYS` 的 catalog
  下，支持 `true` / `false` 简写）；名单为空时零输出，所以「默认开」不改任何既有部署的目录字节。
  面板新增「目录 · 签名摘要」卡片（开关 + 工具名单 + 只提交该键的合并保存）。
- **回归**：`test/catalog-signature.test.mjs` 新增 9 组（出现/不出现、参数顺序、预算截断、字节稳定、
  native 不变、配置归一、策略默认、gate 级 PTC 与 native 各一）。

### Compatibility

- `gate_status` 键集不变；`canInvoke` / 冻结判定 / `gate_invoke` 转发零改动。
- 未配置或名单为空时 `gate-catalog` 与 0.4.1 逐字节一致。

### Docs — 成本口径勘误（2026-11-18 用真实 usage 复核）

- README「PTC 语义边界」④ 的成本表下补一条：**「净省 ≈26.7k / 请求」是 `estimateTokens` 折算的前缀差，
  不是账单上的每请求省额**。v4 会话日志其实**带** usage 字段（`assistant/message.data.usage`：
  `inputTokens / outputTokens / totalTokens / cacheReadTokens`），此前研究包判「无该字段」有误。
- 实测：0.5.x 期 PTC 单请求上下文（input + cacheRead）中位 107,014 tok，其中 cacheRead 中位 104,576
  （≈98% 命中）⇒ 冻结态声明段命中后按 cacheRead 计费。声明仍影响**首次未命中量**（分桶中位
  23,037 / 25,591 / 22,956 / 35,180 / 48,998）。
- 代码零改动，仅文档；证据见 `.scratch/ptc-gate-roundtrip-20261118/research/01-roundtrip-facts.md` §5。

## [0.5.0] — 2026-11-15

### Added — 面板三页签按来源折叠（能力 / 技能 / MCP）

- **动机**：103 条能力平铺成一屏，`native` 一个桶就占 84 行；57 条技能占 11 个 provider 却混在一张表里，
  想「看看 univer 那几个」只能靠搜索。折叠的价值在**扫视**，不在省钱（面板不进上下文）。
- **分组口径**（实测分布见 `.scratch/dsh-gate-panel-ui-0.5.0/research/03-grouping-distribution.md`）：
  - 能力页一级 = `kind`：native 84 / plugin 9 / section 6 / unknown 3 / mcp 1。**没有**真实 source 跨 kind，
    双层分组无收益，所以组内保持现有行；`native` 这个超过 24 行的大桶在桶内再按档位分二级（按需 66 / 常驻 18）。
  - 技能页一级 = `provider`：bundled-mattpocock 27 / univer 12 / filesystem 9 / runtime 2 / 其余 7 个各 1；
    `skills.imports` 导入的技能归「导入」组。
  - MCP 页一级 = `state`（owned / external / stopped / unavailable）：实测只有 2 个 server，
    所以**只有一个分组时不折叠**，平铺照旧。
- **交互**：所有分组默认收起（大表默认展开会退回原样）；组行显示「N 条 · 档位分布」；搜索词命中时
  自动展开命中的分组，清空搜索后回到用户手动开的组（`openGroups` 里没写过的键跟随搜索）。
- **面**：纯客户端（`client/index.js`），目录字节 0 影响、`gate-catalog` / `gate_status` 不变，无新配置键。

### Added — 技能页冷启动清单（未装配也能看到技能）

- **现象**：新开一个会话、还没发第一条消息时，技能页写「本会话还没有装配过」——因为清单只来自
  pre-step 解析到的宿主 `skill-catalog` 消息，没装配就什么都没有。
- **修法**：`lib/skills.js` 新增 `prescanHostSkills(ctx,{preset,cwd,signal,timeoutMs})`，直接读宿主
  registry：`ctx.get('agentPresets').acquireScope(preset)` 拿 preset 的 standing scope（只 +1 引用、
  不重 mount）→ `ctx.skills.snapshot({cwd,signal,scope})` → 过滤 `modelInvocable===false` → 映射成技能行。
  1500 ms 超时兜底；租约在 `finally` 里用 `Symbol.asyncDispose` 释放。本机实测 10.7 ms（12 根 / 66 个 SKILL.md）。
- **服务端**：`GET /skills` 与四处 POST 都先 `await prescanFor(want)`，`skillsPayload(want, prescan)`
  **保持同步**，只在真清单为空时填、行标 `prescan:true`；顶层新增
  `prescan:{active,scoped,preset,cwd,complete,at,reason}`。缓存 10 s（`complete:false` 时 2 s）+
  `ctx.on('skills/change')` 立即失效。服务缺失 ⇒ `active:false` + `reason`，**不当成「没有技能」**。
- **一个反直觉事实**：有 agent ≠ 有技能表。宿主在 `agent/created` 就挂上闸门，而技能表由 pre-step 的
  `refreshSkills` 在**第一条消息**时填，所以新建会话是「有 agent + 空表」。因此 `agent-live` 只在技能表
  已经非空时才返回，空表照扫（否则本票目的落空）。
- **降级**：拿不到 preset scope 时标 `scoped:false`，UI 明说「provider 归属可能与装配后不同」
  （`~/.dsh/skills` 会落到 global 层第二个 filesystem 实例名下）；`cwd` 用宿主默认工作目录，
  不猜工作区根 ⇒ project 级技能仍可能缺席。
- **回归**：`test/server-skills.test.mjs` 补 4 组（预扫描正常 / `acquireScope` 抛错 / 服务缺失 /
  有 agent 但空表），顶层键断言同步加 `prescan`；全套 20 套件通过。

### Compatibility

- `gate_status` 仍是 18 键；`gate-catalog` 字节不变；`gate_load` / `gate_invoke` 输出形状不变。
- `GET /api/dsh-gate/skills` 顶层多一个 `prescan` 键（三键以外不变），老客户端忽略即可。
- 无新增 `gate.json` 键。

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
