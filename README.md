# dsh-gate

DeepSeek Harness 的工具闸门：按策略把工具分到三个层，决定哪些工具常驻、哪些按需加载、哪些关闭；同时提供分段目录、技能组合、MCP 收敛与重复调用防护。

- 层 0（关闭零）：工具完全不可见，也不会出现在目录里。
- 层 1（常驻一）：工具常驻工具表，随时可调用。
- 层 2（按需二）：工具只出现在目录中，模型按需用 `gate_load` 拉取，或经 `gate_call` 直接调用。

层值的写法统一为「层 0 / 层 1 / 层 2」，不使用旧称。

## 安装

    dsh plugin install dsh-gate

或从 Release 下载 `dsh-gate-<version>.tgz`，在插件市场本地安装。安装脚本会把 patch 写入 `cordis.patch.yml`；卸载时只删自己写的那几行，profile 里其它内容保持不动。

要求：Node.js >= 20；Windows 上安装脚本用 PowerShell 5.1 执行（脚本为 UTF-8 with BOM）。

## 策略

策略文件是 profile 根下的 `gate.json`（v3）。没写过的键取默认值；写错的文件**不会被空模板覆盖**，而是按 I-10 报错并保持原文件。最小示例：

    {
      "version": 3,
      "defaults": { "capability": "层 2", "section": "层 1", "skillpack": "层 1" },
      "capabilities": {
        "native:read": "层 1",
        "native:write": "层 0",
        "native:exec": "层 0"
      },
      "skills": { "takeover": "层 2" },
      "mcp": { "servers": {} }
    }

字段全集与类型见 `gate.example.json` 与 `lib/policy-schema.js`；示例与空模板的顶层键由门禁强制一致（G90.10）。

## 架构（0.6.0）

0.6.0 把原来混在 `lib/index.js` 与 `lib/server.js` 里的职责拆成六个模块，每个都能单独测试：

| 模块 | 职责 |
|---|---|
| `lib/policy-schema.js` | 策略字段、类型、层值、合并与校验的唯一真源 |
| `lib/storage-seam.js` | 策略文件读写接缝：剥 BOM、原子落盘、串行写、租约 |
| `lib/decide.js` | 决策单入口：三轴（工具/段落/技能）× 四维（层/桶/原因/可见性） |
| `lib/naming.js` | 工具与技能名字的匹配、别名、前缀切分 |
| `lib/planner.js` | 把决策结果编译成一次装载计划，带戳可复现 |
| `lib/host-adapter.js` | 宿主能力适配：隔离派发、撤销器、子代理判定、消息构造 |
| `lib/normalize.js` | 执行面公共件：结果结构化、文本拼接、超限占位与转发禁令 |

数据流：策略文件 → storage-seam（读）→ policy-schema（校验/合并）→ decide（出层值）→ planner（编译计划）→ host-adapter / restriction（施加到宿主）→ normalize（结果回传）。

不可执行的不变量（I-10–I-16）写进了测试与 `scripts/verify-effectiveness.mjs`：每条都能在临时沙箱里定点破坏源码后必红，绝不污染工作树。

| 编号 | 约束 |
|---|---|
| I-10 | 读策略先剥 BOM；解析失败不得用空模板覆盖 |
| I-11 | 落盘原子、同进程写串行、写前重解析 |
| I-12 | 租约期内不得撤摘除集；窗口内先记账归零再一次施加 |
| I-13 | 执行转发保留结构化结果块，不得字符串化 |
| I-14 | 决策单入口，产出层值/桶/原因，其余模块只投影 |
| I-15 | 控制面失败必须状态码 + 错误信封，不得 200-on-failure |
| I-16 | 部署装卸对称、失败可回滚、patch 行知识单真源 |

## 控制面端点

控制面默认只监听本机回环地址；路由元数据 `CONTROL_PLANE_ROUTES` 是唯一真源。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/dsh-gate/state | 当前状态、策略 revision、生效层统计 |
| GET | /api/dsh-gate/policy | 读取生效策略 |
| POST | /api/dsh-gate/policy | 写入策略（走 storage-seam） |
| GET | /api/dsh-gate/capabilities | 能力清单与当前层值 |
| GET | /api/dsh-gate/skills | 技能组 |
| POST | /api/dsh-gate/skills | 修改技能组 |
| GET | /api/dsh-gate/mcp | MCP 服务器 |
| POST | /api/dsh-gate/mcp | 修改 MCP 服务器 |
| GET | /api/dsh-gate/diagnostics | 只读诊断：文件状态、revision、租约窗口 |

## 命令

    npm run check                    # 工程门禁 G90–G92（18 项）
    npm test                         # 扫描 test/ 与 test/seams/，输出文件/断言/跳过/用时
    npm run test:effectiveness       # 定点破坏自检（HF-1–6 + I-10–I-16）
    npm run verify                   # 上面三步串起来

测试总预算 12s；单个文件 2s。跳过必须带原因，静默跳过视为失败。

## 兼容与升级

- 0.5.x 的 `gate.json` 可直接升级：v2 → v3 的迁移由 `lib/migrate.js` 完成，`repeatGuard` 等段不会丢。
- 0.6.0 起 `npm test` 不再依赖手写长链；新增测试文件只要放进 `test/` 或 `test/seams/` 就会自动执行（注册表遗漏会被门禁 G90.5 抓到）。
- 卸载不删用户策略文件；重装会复用原文件。

## 许可

MIT。
