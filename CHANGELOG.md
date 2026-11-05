# Changelog

版本号遵循语义化版本；格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
