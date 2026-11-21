/**
 * 缺陷回放登记表（票 01 · gate:D2）
 *
 * 机器可读登记 17 条实证缺陷 + 1 条跨域缺陷（前端 P0 白屏，counted:false）
 * + 1 条部署侧发现（uninstall patch 行识别，counted:false，归票 08）+ 5 处假绿
 * + 2 处同源问题 + 12 条 ADR + 16 条不变量 + 18 条术语。票 02–08 按本表逐条
 * 「先红后绿」激活，票 08 用本表做 100% 闭环核验。
 *
 * 口径来源：
 *   - evidence/subagent1-backend-analysis.json（16 条实证 + 交叉裁定 1 条升 P0 = 17）
 *   - spec.md §729-905（假绿 FG-1..FG-5、同源 FG-6/FG-7、ADR/不变量承接矩阵、术语表）
 *
 * 本表只做登记，不判定行为；所有预期红/绿由各接缝契约测试断言。
 */

export const DEFECT_COUNT = 17;

/** 票 01 落地时仓库的基线版本：所有 counted 缺陷在此版本上必须复现。 */
export const BASELINE_VERSION = "0.5.7";

/** 每条缺陷的闸门状态；#08 只认 "verified" 视为闭环。 */
export const REPLAY_STATES = Object.freeze([
  "registered", // 已登记，回放用例还没写（#02–#08 的起点）
  "red-pending", // 回放用例已写，等下个提交变绿
  "verified", // 用例已写且修复后为绿；#08 只认这个
  "not-reproducible", // 在基线上复现不出：必须写明原因，禁止静默改状态
]);

/**
 * 17 条实证缺陷。
 *   id          统一编号（P0-1 / P1-4 / P2-5 …）
 *   severity    P0 | P1 | P2
 *   seam        S1..S5（所属接缝）
 *   ticket      承接票号（#02–#08）
 *   decision    规格决策号（带 be:/gate:/ui: 消歧前缀；无则 null）
 *   invariant   关联不变量（I-n）
 *   replay      回放入口（测试文件 + 用例名；票 08 用 npm script 跑 subsets）
 *   deleteBranch 「删被测分支必须红」靶点说明（该缺陷的修法一旦被短路，断言必然红）
 */
export const defects = [
  {
    id: "P0-1",
    severity: "P0",
    seam: "S2",
    ticket: "#02",
    decisions: ["be:D1","gate:D2"],
    invariant: "I-10",
    title: "策略文件带 BOM 时静默失守，全部工具被当作常驻",
    symptom: "readPolicyFile 用 JSON.parse 的宽容/失败路径吞掉 BOM，解析失败退化成空策略，归层全落常驻，读路径无任何报错。",
    replay: { file: "test/seams/s2-policy-store.test.mjs", case: "P0-1 BOM 不得静默失守" },
    deleteBranch: "adapter.readPolicyDocument 里的 stripBom 分支被删 ⇒ BOM 夹具必然抛错或给出错误形状 ⇒ 断言红。",
    state: "verified",
    verifiedBy: {
      file: "test/seams/s2-policy-store.test.mjs",
      case: "P0-1 BOM 不得静默失守：带 BOM 的 gate.json 必须正常生效且文件不被改写",
      also: "test/policy.test.mjs · P0-1（先红后绿）",
      commit: "先红提交 f5f225a（0.5.7 基线上稳定红）",
    },
  },
  {
    id: "P0-2",
    severity: "P0",
    seam: "S2",
    ticket: "#02",
    decisions: ["be:D1","gate:D2"],
    invariant: "I-10",
    title: "坏文件被空模板覆盖落盘（交叉裁定升 P0）",
    symptom: "解析失败后仍按空策略继续写，原文件（含用户手改内容）被空模板覆盖，且无 v2 备份可比对。",
    replay: { file: "test/seams/s2-policy-store.test.mjs", case: "P0-2 不可读时拒绝写" },
    deleteBranch: "writePolicyDocument 的『读不出就拒绝写』前置分支被删 ⇒ 坏文件被覆盖 ⇒ 字节快照断言红。",
    state: "verified",
    verifiedBy: {
      file: "test/seams/s2-policy-store.test.mjs",
      case: "P0-2 不可读时拒绝写：控制面 409 且磁盘字节不变、不产生备份/临时",
      also: "test/policy.test.mjs · 14. P0-2；test/seams/s2-storage-contract.test.mjs · P0-2 显式整份替换必须备份原文",
    },
  },
  {
    id: "P1-1",
    severity: "P1",
    seam: "S3",
    ticket: "#06",
    decisions: ["be:D2","gate:D2"],
    invariant: "I-15",
    title: "mergePolicyFile 遇 mcp:null 抛 TypeError，HTTP 无响应",
    symptom: "handler 内无 try/catch，异常逃逸到 webServer，客户端拿到 socket 挂起而不是结构化错误信封。",
    replay: { file: "test/seams/s3-http-contract.test.mjs", case: "八步·4 读体：客户端中途断连 → 500 INTERNAL 结构化信封并真的写了响应（P1-1）" },
    deleteBranch: "结构化错误信封分支被短路（handler 抛错直穿）⇒ 响应状态/信封断言红。",
    state: "registered",
  },
  {
    id: "P1-2",
    severity: "P1",
    seam: "S2",
    ticket: "#02",
    decisions: ["be:D2","gate:D2"],
    invariant: "I-4",
    title: "enabled:true 覆盖不掉显式 false",
    symptom: "归层时 enabled:true 的默认值把用户显式写的 false 覆盖掉，关闭能力仍常驻。",
    replay: { file: "test/seams/s2-policy-store.test.mjs", case: "P1-2 显式 false 必须优先" },
    deleteBranch: "合并方向（显式值优先）被改成默认值优先 ⇒ 夹具红。",
    state: "verified",
    verifiedBy: {
      file: "test/seams/s2-policy-store.test.mjs",
      case: "P1-2 显式 false 必须优先：文件 false 压过行 true，文件 true 也压过行 false",
      also: "test/policy-schema.test.mjs · 标量布尔双向覆盖",
    },
  },
  {
    id: "P1-3",
    severity: "P1",
    seam: "S2",
    ticket: "#02",
    decisions: ["be:D3","gate:D2"],
    invariant: "I-4",
    title: "v2→v3 迁移丢 repeatGuard 段落",
    symptom: "迁移只搬工具轴，段落轴的 repeatGuard 配置整段丢失，重复劳动护栏静默失效。",
    replay: { file: "test/seams/s2-policy-store.test.mjs", case: "P1-3 迁移保真" },
    deleteBranch: "迁移函数里『段落轴逐键搬运』那一步被删 ⇒ 迁移后快照缺键 ⇒ 断言红。",
    state: "verified",
    verifiedBy: {
      file: "test/seams/s2-policy-store.test.mjs",
      case: "P1-3 迁移保真：v2 的 repeatGuard 原样保留，备份独占且重启不重复堆备份",
      also: "test/migrate.test.mjs · 4. 幂等 / 6. A13 备份",
    },
  },
  {
    id: "P1-4",
    severity: "P1",
    seam: "S1",
    ticket: "#03",
    decisions: ["be:D4","be:D5","gate:D2"],
    invariant: "I-2",
    title: "glob:* 跨轴污染",
    symptom: "glob:* 在工具轴展开时把段落/技能轴的同名条目一起吞掉，轴边界失效。",
    replay: { file: "test/seams/s1-host-contract.test.mjs", case: "P1-4 glob 不跨轴" },
    deleteBranch: "轴过滤分支被删 ⇒ 跨轴条目进入结果集 ⇒ 断言红。",
    state: "verified",
    verifiedBy: {
      file: "test/seams/s1-host-contract.test.mjs",
      case: "P1-4 glob 不跨轴：一条工具通配不得连带关掉段落与技能",
      also: "test/decide.test.mjs · glob 只作用于工具轴",
      commit: "先红提交 3537080（lib 回退到 0.5.7 时 5 条全红）",
    },
  },
  {
    id: "P1-5",
    severity: "P1",
    seam: "S1",
    ticket: "#03",
    decisions: ["be:D4","gate:D2"],
    invariant: "I-3",
    title: "激活提升绕过 explicit off",
    symptom: "段落被激活时提层不看用户显式 off，关闭的段落照样常驻。",
    replay: { file: "test/seams/s1-host-contract.test.mjs", case: "P1-5 激活不得绕过 off" },
    deleteBranch: "『显式 off 优先』判定被删 ⇒ 激活条目透出 ⇒ 断言红。",
    state: "verified",
    verifiedBy: {
      file: "test/seams/s1-host-contract.test.mjs",
      case: "P1-5 激活不得绕过 off：技能加载不得把显式关闭的工具装回工具表",
      also: "test/activation.test.mjs · explicit off 绝不放",
      commit: "先红提交 3537080（lib 回退到 0.5.7 时 5 条全红）",
    },
  },
  {
    id: "P1-6",
    severity: "P1",
    seam: "S1",
    ticket: "#03",
    decisions: ["be:D4","gate:D2"],
    invariant: "I-3",
    title: "off 段落仍可 load（关闭不生效）",
    symptom: "关闭只影响展示，不改实际装配；off 段落还能被 load 进系统提示词。",
    replay: { file: "test/seams/s1-host-contract.test.mjs", case: "P1-6 off 必须不可 load" },
    deleteBranch: "装配期『off 段落不进计划对象』过滤被删 ⇒ 段落出现 ⇒ 断言红。",
    state: "verified",
    verifiedBy: {
      file: "test/seams/s1-host-contract.test.mjs",
      case: "P1-6 off 必须不可 load：关闭段落不得从加载口取正文",
      also: "test/decide.test.mjs · 段落 tier0 → loadable:false",
      commit: "先红提交 3537080（lib 回退到 0.5.7 时 5 条全红）",
    },
  },
  {
    id: "P1-7",
    severity: "P1",
    seam: "S1",
    ticket: "#03",
    decisions: ["be:D4","be:D7","gate:D2"],
    invariant: "I-3",
    title: "已加载压制 off（重载后关闭被忽略）",
    symptom: "只要插件已加载，off 就被忽略，必须重启才生效。",
    replay: { file: "test/seams/s1-host-contract.test.mjs", case: "P1-7 重载后 off 仍生效" },
    deleteBranch: "『off 优先于已加载状态』判定被删 ⇒ 重载后条目仍在 ⇒ 断言红。",
    state: "verified",
    verifiedBy: {
      file: "test/seams/s1-host-contract.test.mjs",
      case: "P1-7 重载后 off 仍生效：已加载不得压过显式关闭",
      also: "test/decide.test.mjs · 关闭压过 loaded/frozen",
      commit: "先红提交 3537080（lib 回退到 0.5.7 时 5 条全红）",
    },
  },
  {
    id: "P1-8",
    severity: "P1",
    seam: "S1",
    ticket: "#04",
    decisions: ["be:D10","gate:D2"],
    invariant: "I-8",
    title: "非 text 块被 stringify 破坏",
    symptom: "消息构造时把结构化块（image/attachment 等）当作字符串拼接，块被压平丢结构。",
    replay: { file: "test/seams/s1-host-contract.test.mjs", case: "P1-8 结构化块保真" },
    deleteBranch: "适配器的『块保真』路径被改成只返回 text ⇒ 块断言红。",
    state: "registered",
  },
  {
    id: "P1-9",
    severity: "P1",
    seam: "S1",
    ticket: "#04",
    decisions: ["be:D8","gate:D2"],
    invariant: "I-8",
    title: "suspend 非重入窗口全量放表",
    symptom: "suspend 期间的重入窗口没有闸，限制表被全量放开，任意并发都看到未限制的工具面。",
    replay: { file: "test/seams/s1-host-contract.test.mjs", case: "P1-9 suspend 只放行自己的作用域" },
    deleteBranch: "作用域比对分支被删 ⇒ 邻居作用域也被放行 ⇒ 断言红。",
    state: "registered",
  },
  {
    id: "P1-10",
    severity: "P1",
    seam: "S3",
    ticket: "#06",
    decisions: ["be:D5","gate:D2"],
    invariant: "I-15",
    title: "POST /skills 的 tier 被强转 0",
    symptom: "请求体 tier 非法（null/字符串）时被 Number() 强转成 0，静默变成「关闭」。",
    replay: { file: "test/seams/s3-http-contract.test.mjs", case: "P1-10：tier: null 不再被 Number() 强转成 0（400 INVALID_TIER，文件不动）" },
    deleteBranch: "字段校验分支被删 ⇒ 非法输入被强转后落盘 ⇒ 状态码/账本断言红。",
    state: "registered",
  },
  {
    id: "P2-1",
    severity: "P2",
    seam: "S1",
    ticket: "#03",
    decisions: ["be:D4","be:D7"],
    invariant: "I-5",
    title: "PTC 冻结下 tiers 与 status 快照自相矛盾",
    symptom: "PTC 执行器冻结了工具表，但 gate_status 仍按计划对象报 tiers，两处口径不一致。",
    replay: { file: "test/seams/s1-host-contract.test.mjs", case: "P2-1 冻结视图与快照一致" },
    deleteBranch: "快照投影分支被删 ⇒ 两处口径分叉 ⇒ 断言红。",
    state: "verified",
    verifiedBy: {
      file: "test/seams/s1-host-contract.test.mjs",
      case: "P2-1 冻结视图与快照一致：PTC 冻结下已加载工具仍是按需",
      also: "test/planner.test.mjs · frozen-loaded 层值与桶",
      commit: "先红提交 3537080（lib 回退到 0.5.7 时 5 条全红）",
    },
  },
  {
    id: "P2-2",
    severity: "P2",
    seam: "S1",
    ticket: "#05",
    decisions: ["be:D17"],
    invariant: "I-7",
    title: "searchCatalog limit 传 0/-1 返回全量",
    symptom: "limit 边界未校验，0 与 -1 都退化成不限制，检索结果爆量。",
    replay: { file: "test/seams/s1-host-contract.test.mjs", case: "P2-2 limit 边界" },
    deleteBranch: "limit 归一化分支被删 ⇒ 0/-1 返回全量 ⇒ 断言红。",
    state: "registered",
  },
  {
    id: "P2-3",
    severity: "P2",
    seam: "S1",
    ticket: "#05",
    decisions: ["be:D17"],
    invariant: "I-7",
    title: "firstSentence 截断版本号",
    symptom: "摘要生成按句号切分，把「v0.5.7 起」这类句内版本号截断成「v0.5」。",
    replay: { file: "test/seams/s1-host-contract.test.mjs", case: "P2-3 摘要不得截断版本号" },
    deleteBranch: "版本号保护分支被删 ⇒ 截断复现 ⇒ 断言红。",
    state: "registered",
  },
  {
    id: "P2-4",
    severity: "P2",
    seam: "S1",
    ticket: "#05",
    decisions: ["be:D17"],
    invariant: "I-7",
    title: "中文别名子串误命中",
    symptom: "别名匹配用 includes，短别名命中长词子串，检索给出不相关条目。",
    replay: { file: "test/seams/s1-host-contract.test.mjs", case: "P2-4 别名按词边界" },
    deleteBranch: "边界匹配分支被删 ⇒ 子串误命中 ⇒ 断言红。",
    state: "registered",
  },
  {
    id: "P2-5",
    severity: "P2",
    seam: "S1",
    ticket: "#04",
    decisions: ["be:D9"],
    invariant: "I-9",
    title: "gate_call 可自调转发（无限递归风险）",
    symptom: "被限制的会话仍能通过 gate_call 转发到受限工具，限制可被绕过。",
    replay: { file: "test/seams/s1-host-contract.test.mjs", case: "P2-5 受限会话不得转发" },
    deleteBranch: "转发目标校验分支被删 ⇒ 受限工具被调到 ⇒ 断言红。",
    state: "registered",
  },
];

/** 跨域缺陷：不在 17 条以内，但票 01 必须登记（gate:D4 的定案对象）。 */
export const crossDomainDefects = [
  {
    id: "X-1",
    severity: "P0",
    seam: "S4",
    ticket: "#07",
    decisions: ["gate:D4", "gate:D2"],
    invariant: "I-6",
    title: "前端路由缺失时整页白屏（无降级边界）",
    symptom: "客户端 bundle 引用不存在的页签路由时直接抛错，宿主没有 error boundary，整页白屏而非该页签降级。",
    counted: false,
    replay: { file: "test/seams/s4-frontend-contract.test.mjs", case: "X-1 路由缺失必须降级不白屏" },
    deleteBranch: "降级分支被删 ⇒ 渲染记录器捕获到未处理异常 ⇒ 断言红。",
    state: "registered",
  },
];

/**
 * 部署脚本侧的非 17 条发现（票 01 在 S5 上真跑脚本时实证；归票 08 修，不计入 DEFECT_COUNT）。
 * 单独一张表，免得不小心把 17 条实证口径改掉。
 */
export const deployFindings = [
  {
    id: "D-1",
    severity: "P1",
    seam: "S5",
    ticket: "#08",
    decisions: ["gate:D5", "gate:D2"],
    invariant: "I-16",
    title: "uninstall 认不出 install 写的缩进 patch 行（卸不掉，且可能留下孤立 - insert:）",
    symptom: "install 写缩进 4 空格的 \"    - id: surface-gate\"，而 uninstall 的 hasPatchRow / 摘除循环 / 回读校验三处都用 ^-\\s*id:\\s*surface-gate\\s*$（只认顶层）→ -DryRun 报 False、真卸跳过，行留在 profile。",
    counted: false,
    replay: { file: "test/seams/s5-deploy-contract.test.mjs", case: "S5 · 真缺陷登记：uninstall 认不出 install 写的缩进 patch 行（卸不掉）" },
    deleteBranch: "把 uninstall 三处正则改成 ^\\s*-… ⇒ 该用例的「= False」断言变红；把 fixture 改成顶层行同样变红。",
    state: "registered",
  },
];

/** 五处假绿（FG-1..FG-5）+ 两处同源问题（FG-6/FG-7）。 */
export const falseGreens = [
  {
    id: "FG-1",
    seam: "S1",
    ticket: "#04",
    title: "逐监听者吞错继续派发",
    was: "假宿主的 emit 对每个监听者 try/catch 后继续，广播语义（遇抛错即中断并上抛）从未被覆盖。",
    now: "契约夹具区分 serial/waterfall 与 parallel/isolated，断言遇抛错时 aborted/abortedAt 正确且错误上抛。",
    test: "S1 双派发语义",
  },
  {
    id: "FG-2",
    seam: "S1",
    ticket: "#03",
    title: "限制替身只模拟摘除形状",
    was: "假宿主只实现 {deny} 形状，allow-list 放行形状、幂等短路、句柄身份、受保护名全无契约。",
    now: "两种目标形状 + 同形状幂等短路 + 句柄身份 + 受保护名四组契约断言。",
    test: "S1 限制完整契约",
  },
  {
    id: "FG-3",
    seam: "S1",
    ticket: "#04",
    title: "假宿主无会话表面",
    was: "假宿主没有 session.surface，尾块自愈的去重分支（known === text）在夹具里永远走不到。",
    now: "会话表面回放 + preStep 追加，删除去重分支必然变红。",
    test: "S1 会话表面 + 删分支必红",
  },
  {
    id: "FG-4",
    seam: "S1",
    ticket: "#04",
    title: "副作用注册不保存撤销器",
    was: "假宿主注册 hook/tool/effect 后丢弃 disposer，泄漏无法观测。",
    now: "lifecycle 账本登记全部撤销器，dispose() 强制执行并报 leaks。",
    test: "S1 撤销器生命周期",
  },
  {
    id: "FG-5",
    seam: "S1",
    ticket: "#04",
    title: "桩解析器只映射工具包",
    was: "stub-resolver 只把 @deepseek-ai/dsh-tools 映射到 vendor，消息构造永远走退化分支且无两态资产。",
    now: "两态适配器（present/absent）+ construction 观测状态，两种模式各有子进程断言。",
    test: "S1 消息构造两态",
  },
  {
    id: "FG-6",
    seam: "S1",
    ticket: "#04",
    title: "pre-step 自拼字符串（同源问题）",
    was: "测试里自己拼尾块文本，绕过 createGateUserMessage 与 pre-step 入口。",
    now: "一律经 host.preStep + 真 lib/prestep.js 尾部自愈路径，禁止测试侧手拼消息。",
    test: "S1 pre-step 真入口",
  },
  {
    id: "FG-7",
    seam: "S4",
    ticket: "#07",
    title: "前端手抄默认策略模板（同源问题）",
    was: "前端内联一份默认策略字面量，与后端 lib/policy.js 的默认模板无一致性校验。",
    now: "S4 垫片装载真 client 源文件后，把默认策略与后端默认逐键比对（跨端一致性钩子）。",
    test: "S4 默认策略跨端一致",
  },
];

/** 12 条 ADR（承接票号见规格矩阵；topic 未定的显式标记 null，禁止臆造）。 */
export const adrs = [
  { id: "A-1", tickets: ["#04"], topic: null },
  { id: "A-2", tickets: ["#03"], topic: null },
  { id: "A-3", tickets: ["#03"], topic: null },
  { id: "A-4", tickets: ["#02"], topic: null },
  { id: "A-5", tickets: ["#01", "#03", "#06", "#07"], topic: "对外只给投影：客户端/控制面禁止读内部表" },
  { id: "A-6", tickets: ["#01", "#03", "#08"], topic: "测试宿主收成一个接缝，改为宿主契约 + 契约夹具；接缝按运行时边界扩到五条" },
  { id: "A-7", tickets: ["#01", "#02", "#05", "#08"], topic: null },
  { id: "A-8", tickets: ["#04"], topic: null },
  { id: "A-9", tickets: ["#03"], topic: null },
  { id: "A-10", tickets: ["#08"], topic: null },
  { id: "A-11", tickets: ["#02", "#08"], topic: null },
  { id: "A-12", tickets: ["#06"], topic: null },
];

/** 16 条不变量；statement 未在规格无歧义摘录的显式 null（见 spec 不变量段）。 */
export const invariants = [
  { id: "I-1", tickets: ["#03"], statement: null },
  { id: "I-2", tickets: ["#03", "#04"], statement: "轴边界不可跨越：工具/段落/技能三条轴各自归层，glob 不得跨轴。" },
  { id: "I-3", tickets: ["#03", "#04"], statement: "显式 off 优先于激活、已加载与默认值。" },
  { id: "I-4", tickets: ["#02", "#03", "#04"], statement: "用户显式值优先于默认值；v2→v3 迁移必须逐键保真。" },
  { id: "I-5", tickets: ["#01", "#02", "#03", "#06", "#07"], statement: "状态形状唯一：对外只暴露一份冻结键集的快照投影。" },
  { id: "I-6", tickets: ["#01", "#02", "#03", "#05", "#06"], statement: "公开面只给能力集：客户端只拿到 inject/apply，require 只在 PLATFORM_MODULES 白名单内。" },
  { id: "I-7", tickets: ["#03", "#04", "#05"], statement: null },
  { id: "I-8", tickets: ["#04", "#05"], statement: "消息块保真：非 text 块不得被 stringify。" },
  { id: "I-9", tickets: ["#03", "#04", "#06"], statement: "限制不可被自调转发绕过。" },
  { id: "I-10", tickets: ["#02"], statement: "策略文件字节不变量：BOM 必须剥、坏文件不得被覆盖。" },
  { id: "I-11", tickets: ["#02"], statement: null },
  { id: "I-12", tickets: ["#04"], statement: null },
  { id: "I-13", tickets: ["#04"], statement: null },
  { id: "I-14", tickets: ["#03"], statement: null },
  { id: "I-15", tickets: ["#06"], statement: "控制面必须有结构化错误信封，禁止无响应挂起。" },
  { id: "I-16", tickets: ["#08"], statement: null },
];

/** 18 条术语（口径唯一；banned 为禁用旧称）。 */
export const terms = [
  { term: "层", en: "tier", gloss: "关闭零、常驻一、按需二", banned: ["档位", "等级"] },
  { term: "能力", en: "capability", gloss: "声明式引用，命名空间 <kind>:<name>" },
  { term: "轴", en: "axis", gloss: "工具/段落/技能三条归层判定轴，不得跨轴污染" },
  { term: "段落摘除", en: "section strip", gloss: "从装配结果移除段落，不删正文" },
  { term: "收窄豁免", en: "narrow pass-through", gloss: "窄子代理不施加限制，直接放行" },
  { term: "状态快照", en: "status snapshot", gloss: "gate_status 的冻结键集投影" },
  { term: "段落注入与追加", en: "inject vs append", gloss: "注入=装配期加段落；追加=pre-step 末尾加 user 消息" },
  { term: "重复劳动", en: "repeat labor", gloss: "窗口内同工具同结果指纹的重复调用" },
  { term: "不可执行", en: "not actionable", gloss: "行动提示没有对应可执行工具" },
  { term: "决策", en: "decision", gloss: "一次归层判定的具名结果（含理由码）" },
  { term: "桶", en: "bucket", gloss: "常驻/按需/关闭三归属桶，与层一一对应但用于展示" },
  { term: "限制租约与待生效目标", en: "restriction lease & pending target", gloss: "引用计数所有权；最后一个释放才真正恢复" },
  { term: "假绿", en: "false green", gloss: "全绿但分支未被真实语义覆盖" },
  { term: "缺陷回放", en: "defect replay", gloss: "旧版必红、修复后必绿的仓内回归用例" },
  { term: "字节不变量", en: "byte invariant", gloss: "输入不变则目录文本/声明键集/尾块正文逐字节不变" },
  { term: "计划对象", en: "plan object", gloss: "一次装配/限制计算的唯一中间结果" },
  { term: "投影", en: "projection", gloss: "对外只给能力形状的只读派生，不是内部表" },
  { term: "命名真源", en: "named source of truth", gloss: "每个口径只有一处命名与实现" },
];

/** 五条接缝 + 一条可选探针；scripts 是 package.json 里的单命令入口。 */
export const seams = {
  S1: { name: "宿主契约", scripts: ["test:seam:s1"], test: "test/seams/s1-host-contract.test.mjs", blocking: true },
  S1b: { name: "真宿主一致性探针", scripts: ["test:probe:s1b"], test: "test/seams/s1b-real-host-probe.mjs", blocking: false },
  S2: { name: "策略存储", scripts: ["test:seam:s2"], test: "test/seams/s2-storage-contract.test.mjs", blocking: true },
  S3: { name: "控制面", scripts: ["test:seam:s3"], test: "test/seams/s3-http-contract.test.mjs", blocking: true },
  S4: { name: "前端数据无头垫片", scripts: ["test:seam:s4"], test: "test/seams/s4-frontend-contract.test.mjs", blocking: true },
  S5: { name: "部署脚本假 HOME", scripts: ["test:seam:s5"], test: "test/seams/s5-deploy-contract.test.mjs", blocking: true },
};

/** 结构化自检：票 08 与 S1 契约测试都调它。 */
export function validateRegistry() {
  const problems = [];
  const ids = new Set();
  const counted = defects.filter((d) => d.counted !== false);
  if (counted.length !== DEFECT_COUNT) problems.push("counted 缺陷数应为 " + DEFECT_COUNT + "，实际 " + counted.length);

  for (const d of counted) {
    if (ids.has(d.id)) problems.push("缺陷 id 重复: " + d.id);
    ids.add(d.id);
    if (!["P0", "P1", "P2"].includes(d.severity)) problems.push(d.id + " severity 非法");
    if (!/^#[0-8][0-9]$/.test(d.ticket)) problems.push(d.id + " ticket 非法");
    if (!/^S[1-5]b?$/.test(d.seam)) problems.push(d.id + " seam 非法");
    if (!Array.isArray(d.decisions) || d.decisions.length === 0) problems.push(d.id + " 缺 decisions");
    for (const dec of d.decisions || []) {
      if (!/^(be|gate|ui):D\d+$/.test(dec)) problems.push(d.id + " decision 必须带消歧前缀: " + dec);
    }
    if (!/^I-\d+$/.test(d.invariant)) problems.push(d.id + " invariant 非法");
    if (!REPLAY_STATES.includes(d.state)) problems.push(d.id + " state 非法");
    if (!d.replay || !d.replay.file || !d.replay.case) problems.push(d.id + " 缺回放入口");
    if (!d.deleteBranch) problems.push(d.id + " 缺删分支靶点");
    // 只有「用例已写且修复后为绿」才允许 verified；必须能定位到具体测试（#08 只认这个）。
    if (d.state === "verified" && (!d.verifiedBy || !d.verifiedBy.file || !d.verifiedBy.case)) {
      problems.push(d.id + " 标 verified 但缺 verifiedBy {file, case}");
    }
  }
  const severityCount = { P0: 0, P1: 0, P2: 0 };
  for (const d of counted) severityCount[d.severity] += 1;
  if (severityCount.P0 !== 2 || severityCount.P1 !== 10 || severityCount.P2 !== 5) {
    problems.push("分级应为 P0×2 + P1×10 + P2×5，实际 " + JSON.stringify(severityCount));
  }
  // 缺陷按票 02–07 分摊；#08 是部署脚本与全量收口核验票，不承接新缺陷（只核验闭环）。
  const ticketCoverage = new Set([...counted, ...crossDomainDefects].map((d) => d.ticket));
  for (let n = 2; n <= 7; n += 1) {
    if (!ticketCoverage.has("#0" + n)) problems.push("#0" + n + " 没有承接任何缺陷");
  }
  if (crossDomainDefects.length !== 1 || crossDomainDefects[0].ticket !== "#07") {
    problems.push("跨域前端 P0 必须恰好一条且归 #07");
  }
  if (falseGreens.length !== 7) problems.push("假绿应为 5 + 2，实际 " + falseGreens.length);
  if (deployFindings.length !== 1) problems.push("部署侧发现应为 1 条（D-1），实际 " + deployFindings.length);
  for (const d of deployFindings) {
    if (d.counted !== false) problems.push(d.id + " 不计入 DEFECT_COUNT，必须 counted:false");
    if (d.ticket !== "#08") problems.push(d.id + " 必须归票 08（部署脚本收口）");
    if (!REPLAY_STATES.includes(d.state)) problems.push(d.id + " state 非法");
    if (!d.replay || !d.replay.file || !d.replay.case) problems.push(d.id + " 缺回放入口");
    if (!d.deleteBranch) problems.push(d.id + " 缺删分支靶点");
  }
  if (adrs.length !== 12) problems.push("ADR 应为 12 条");
  if (invariants.length !== 16) problems.push("不变量应为 16 条");
  if (terms.length !== 18) problems.push("术语应为 18 条");
  for (const t of terms) {
    if (!t.term || !t.gloss) problems.push("术语缺字段: " + JSON.stringify(t.term));
  }
  for (const s of Object.values(seams)) {
    if (!s.scripts.length) problems.push("接缝 " + s.name + " 缺单命令入口");
  }
  return { ok: problems.length === 0, problems, severityCount, counted: counted.length };
}

/** 供台账/报告使用的紧凑摘要。 */
export function summary() {
  const byTicket = {};
  for (const d of defects) {
    byTicket[d.ticket] = byTicket[d.ticket] || [];
    byTicket[d.ticket].push(d.id);
  }
  return {
    baseline: BASELINE_VERSION,
    defects: defects.length,
    counted: defects.filter((d) => d.counted !== false).length,
    crossDomain: crossDomainDefects.length,
    deployFindings: deployFindings.length,
    falseGreens: falseGreens.length,
    byTicket,
    bySeam: defects.reduce((acc, d) => {
      acc[d.seam] = (acc[d.seam] || 0) + 1;
      return acc;
    }, {}),
    states: defects.reduce((acc, d) => {
      acc[d.state] = (acc[d.state] || 0) + 1;
      return acc;
    }, {}),
  };
}