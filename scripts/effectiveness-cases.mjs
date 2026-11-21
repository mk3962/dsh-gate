/**
 * 定点破坏用例表（0.6.0 · 工单 #08 / D22 / G91）—— **有效性自检的唯一真源**。
 *
 * 每条用例 = 一条宿主事实或一条不变量 + 一处定点变异 + 一个内存/临时沙箱探针。
 * 判定完全在临时目录里做：复制 lib/ 与 scripts/ 到 os.tmpdir()，绝不写工作树。
 *
 * 字段：
 *   id / title      用例号与说明（HF-1..HF-6 宿主事实；I-10..I-16 不变量）
 *   target          变异目标源文件（相对仓库根）
 *   anchor          必须**恰好出现一次**的源码片段（漂移即报锚点失效）
 *   replacement     把 anchor 替换成什么（破坏该事实/不变量的最小改动）
 *   probe           探针源码（在沙箱根以 ESM 执行；断言失败 = 变异被发现）
 *   requires        依赖文件（缺任意一个 ⇒ 该用例 blocked，等对应工单集成）
 *   pending         true 表示已知要等别的工单落地，不计失败（--strict 下计失败）
 */
export const CASES = [
  {
    "id": "HF-1",
    "kind": "host-fact",
    "title": "双派发语义：隔离通道逐监听者 try/catch，一个抛错不中断其余",
    "target": "lib/host-adapter.js",
    "requires": [],
    "anchor": "        try {\n          callback(...args);\n          info.delivered += 1;\n        } catch (error) {\n          info.failed.push(String((error && error.message) || error));\n        }",
    "replacement": "        callback(...args);\n        info.delivered += 1;",
    "probe": "import assert from \"node:assert/strict\";\nimport { createHostAdapter } from \"./lib/host-adapter.js\";\nlet seen = 0;\nconst good = () => { seen += 1; };\nconst boom = () => { throw new Error(\"listener-boom\"); };\nconst ctx = { events: { dispatch: () => [boom, good] }, emit: () => { throw new Error(\"emit must not be used\"); } };\nconst adapter = createHostAdapter(ctx, {});\nlet info;\ntry { info = adapter.dispatchIsolated(\"probe.event\", [1]); } catch (error) { assert.fail(\"隔离派发不应把监听者异常抛给调用方: \" + error.message); }\nassert.equal(info.mode, \"isolated\");\nassert.equal(info.listeners, 2);\nassert.equal(info.delivered, 1, \"只有不抛错的监听者算 delivered\");\nassert.equal(info.failed.length, 1);\nassert.equal(seen, 1, \"第二个监听者必须仍然被执行\");\nconsole.log(\"PROBE OK HF-1\");"
  },
  {
    "id": "HF-2",
    "kind": "host-fact",
    "title": "限制完整契约：deny 去重排序、受保护名不可撤销、同目标幂等",
    "target": "lib/restriction.js",
    "requires": [],
    "anchor": "      if (protectedNames.has(name)) continue;   // 受保护名绝不被撤销（也绝不进 deny）",
    "replacement": "      if (false) continue;",
    "probe": "import assert from \"node:assert/strict\";\nimport { createRestriction, MODE_LIMITED, MODE_NONE } from \"./lib/restriction.js\";\nconst calls = [];\nconst restriction = createRestriction({ protectedNames: new Set([\"secret\"]), restrict: (target) => { calls.push(target.deny.slice()); return () => {}; } });\nrestriction.apply({ mode: MODE_LIMITED, deny: [\"b\", \"secret\", \"b\", \"a\"] });\nassert.deepEqual(calls, [[\"a\", \"b\"]], \"受保护名必须被排除，deny 必须去重排序\");\nrestriction.apply({ mode: MODE_LIMITED, deny: [\"b\", \"a\"] });\nassert.equal(calls.length, 1, \"同目标必须幂等短路\");\nrestriction.apply({ mode: MODE_NONE });\nassert.equal(restriction.state().mode, MODE_NONE);\nconsole.log(\"PROBE OK HF-2\");"
  },
  {
    "id": "HF-3",
    "kind": "host-fact",
    "title": "视图三件套：knownNames 只认原生 Set，visible 从 Map/可迭代形状取键",
    "target": "lib/host-adapter.js",
    "requires": [],
    "anchor": "    return view.knownNames instanceof Set ? view.knownNames : undefined;",
    "replacement": "    return view.visibleNames;",
    "probe": "import assert from \"node:assert/strict\";\nimport { createHostAdapter } from \"./lib/host-adapter.js\";\nconst tools = { view: () => ({ knownNames: new Set([\"a\", \"b\"]), visible: new Map([[\"a\", {}]]) }) };\nconst ctx = { get: (name) => (name === \"tools\" ? tools : undefined), tools };\nconst adapter = createHostAdapter(ctx, {});\nconst known = adapter.knownNames(undefined);\nassert.ok(known instanceof Set, \"knownNames 必须是原生 Set\");\nassert.deepEqual([...known].sort(), [\"a\", \"b\"]);\nassert.deepEqual([...adapter.visibleNames(undefined)], [\"a\"]);\nconst blind = createHostAdapter({ get: () => undefined }, {});\nassert.equal(blind.knownNames(undefined), undefined);\nassert.equal(blind.visibleNames(undefined), undefined);\nconsole.log(\"PROBE OK HF-3\");"
  },
  {
    "id": "HF-4",
    "kind": "host-fact",
    "title": "会话表面：子代理判定只认宿主给的 parent，不猜、不把 null 当父",
    "target": "lib/host-adapter.js",
    "requires": [],
    "anchor": "    return agent.parent !== undefined && agent.parent !== null;",
    "replacement": "    return agent.parent !== undefined;",
    "probe": "import assert from \"node:assert/strict\";\nimport { createHostAdapter } from \"./lib/host-adapter.js\";\nconst adapter = createHostAdapter({ get: () => undefined }, {});\nassert.equal(adapter.isSubagent({ parent: { id: \"root\" } }), true);\nassert.equal(adapter.isSubagent({}), false);\nassert.equal(adapter.isSubagent({ parent: null }), false, \"parent:null 不是子代理\");\nassert.equal(adapter.isSubagent(null), false);\nconsole.log(\"PROBE OK HF-4\");"
  },
  {
    "id": "HF-5",
    "kind": "host-fact",
    "title": "撤销器生命周期：拿到句柄才记状态，撤销只调一次，destroy 不重复调",
    "target": "lib/restriction.js",
    "requires": [],
    "anchor": "      try { handle(); } catch { /* 宿主已撤销 */ }",
    "replacement": "      try { void handle; } catch { /* 宿主已撤销 */ }",
    "probe": "import assert from \"node:assert/strict\";\nimport { createRestriction, MODE_LIMITED, MODE_NONE } from \"./lib/restriction.js\";\nlet revoked = 0;\nconst restriction = createRestriction({ restrict: () => () => { revoked += 1; } });\nrestriction.apply({ mode: MODE_LIMITED, deny: [\"x\"] });\nrestriction.apply({ mode: MODE_NONE });\nassert.equal(revoked, 1, \"撤销句柄必须被调用一次\");\nrestriction.destroy();\nassert.equal(revoked, 1, \"destroy 不得重复调用已撤销句柄\");\nconsole.log(\"PROBE OK HF-5\");"
  },
  {
    "id": "HF-6",
    "kind": "host-fact",
    "title": "消息构造两态：无 source 就不写 source，同输入同形状且每次新对象",
    "target": "lib/host-adapter.js",
    "requires": [],
    "anchor": "    if (source !== undefined) message.source = source;",
    "replacement": "    message.source = source === undefined ? \"user\" : source;",
    "probe": "import assert from \"node:assert/strict\";\nimport { createHostAdapter } from \"./lib/host-adapter.js\";\nconst adapter = createHostAdapter({ get: () => undefined }, {});\nconst plain = adapter.userMessage(\"hi\");\nassert.equal(\"source\" in plain, false, \"无 source 时不得凭空写 source\");\nassert.deepEqual(plain, { role: \"user\", content: [{ type: \"text\", text: \"hi\" }] });\nconst relayed = adapter.userMessage(\"hi\", \"activation-relay\");\nassert.equal(relayed.source, \"activation-relay\");\nconst again = adapter.userMessage(\"hi\");\nassert.deepEqual(again, plain);\nassert.notEqual(again, plain, \"每次构造必须是新对象\");\nconsole.log(\"PROBE OK HF-6\");"
  },
  {
    "id": "I-10",
    "kind": "invariant",
    "title": "I-10 读策略先剥 BOM；解析失败进入未读态，绝不空模板覆盖",
    "target": "lib/storage-seam.js",
    "requires": [],
    "anchor": "    const stripped = stripBom(text);",
    "replacement": "    const stripped = text;",
    "probe": "import assert from \"node:assert/strict\";\nimport { createMemoryStorageAdapter, createPolicyStore } from \"./lib/storage-seam.js\";\nconst bom = createMemoryStorageAdapter({ files: { \"gate.json\": \"\\uFEFF{\\\"version\\\":3,\\\"enabled\\\":true}\\n\" } });\nconst bomStore = createPolicyStore({ adapter: bom });\nconst read = await bomStore.read();\nassert.equal(read.ok, true);\nassert.equal(read.status, \"bom\");\nassert.equal(read.hadBom, true);\nassert.equal(read.value.version, 3);\nconst bad = createMemoryStorageAdapter({ files: { \"gate.json\": \"{ not json\" } });\nconst badStore = createPolicyStore({ adapter: bad });\nconst broken = await badStore.read();\nassert.equal(broken.ok, false);\nassert.equal(broken.status, \"syntax\");\nawait assert.rejects(() => badStore.write({ version: 3 }), /not readable|refusing/i, \"坏文件不得被覆盖\");\nawait badStore.write({ version: 3 }, { replaceCorrupt: true });\nassert.equal(bad.text(\"gate.json.bak\"), \"{ not json\", \"整份替换前必须备份原文\");\nconsole.log(\"PROBE OK I-10\");"
  },
  {
    "id": "I-11",
    "kind": "invariant",
    "title": "I-11 原子落盘、失败保留原文件、同进程写串行",
    "target": "lib/storage-seam.js",
    "requires": [],
    "anchor": "      await adapter.rename(tempName, policyFile);",
    "replacement": "      await adapter.writeText(policyFile, text);",
    "probe": "import assert from \"node:assert/strict\";\nimport { createMemoryStorageAdapter, createPolicyStore } from \"./lib/storage-seam.js\";\nconst original = \"{\\n  \\\"version\\\": 3,\\n  \\\"enabled\\\": true\\n}\\n\";\nconst adapter = createMemoryStorageAdapter({ files: { \"gate.json\": original }, faults: { renameError: true } });\nconst store = createPolicyStore({ adapter });\nawait assert.rejects(() => store.write({ version: 3, enabled: false }), /atomic rename|RENAME_FAILED/i);\nassert.equal(adapter.text(\"gate.json\"), original, \"rename 失败必须保留原文件\");\nassert.equal(adapter.exists(\"gate.json.tmp\"), false, \"临时文件必须清理\");\nconst slow = createMemoryStorageAdapter({ files: { \"gate.json\": original }, faults: { writeDelayMs: 5 } });\nconst store2 = createPolicyStore({ adapter: slow });\nawait Promise.all([\n  store2.write({ version: 3, enabled: true, n: 1 }),\n  store2.write({ version: 3, enabled: true, n: 2 }),\n]);\nassert.equal(JSON.parse(slow.text(\"gate.json\")).n, 2, \"后写者必须最后落盘\");\nconsole.log(\"PROBE OK I-11\");"
  },
  {
    "id": "I-12",
    "kind": "invariant",
    "title": "I-12 租约窗口内只登记目标，不得撤/改当前摘除集",
    "target": "lib/restriction.js",
    "requires": [],
    "anchor": "    if (leases > 0) {\n      pendingTarget = want;\n      return;\n    }",
    "replacement": "    if (false) {\n      pendingTarget = want;\n      return;\n    }",
    "probe": "import assert from \"node:assert/strict\";\nimport { createRestriction, MODE_LIMITED } from \"./lib/restriction.js\";\nconst calls = [];\nconst restriction = createRestriction({ restrict: (target) => { calls.push(target.deny.slice()); return () => {}; } });\nrestriction.apply({ mode: MODE_LIMITED, deny: [\"a\"] });\nassert.deepEqual(calls, [[\"a\"]]);\nconst lease = restriction.acquireLease({ reason: \"probe\" });\nassert.equal(restriction.isWindowOpen(), true);\nrestriction.apply({ mode: MODE_LIMITED, deny: [\"b\"] });\nassert.deepEqual(calls, [[\"a\"]], \"窗口内不得重算摘除集\");\nlease();\nassert.deepEqual(calls, [[\"a\"], [\"b\"]], \"最后一个租约释放时一次施加待生效目标\");\nconsole.log(\"PROBE OK I-12\");"
  },
  {
    "id": "I-13",
    "kind": "invariant",
    "title": "I-13 执行转发保留结构化结果块，绝不 stringify 成文本",
    "target": "lib/normalize.js",
    "requires": [],
    "anchor": "      // 原样保留：不再复制、不 stringify（引用同一份宿主块）。\n      contentBlocks.push(block);",
    "replacement": "      contentBlocks.push({ type, text: JSON.stringify(block) });",
    "probe": "import assert from \"node:assert/strict\";\nimport { normalizeToolResult } from \"./lib/normalize.js\";\nconst image = { type: \"image\", source: { type: \"base64\", media_type: \"image/png\", data: \"AAAA\" } };\nconst result = { content: [{ type: \"text\", text: \"before\" }, image] };\nconst normalized = normalizeToolResult(result);\nassert.equal(normalized.contentBlocks.length, 1);\nassert.equal(normalized.contentBlocks[0], image, \"结构化块必须原样保留（同一引用）\");\nassert.equal(normalized.text.includes(\"base64\"), false, \"文本视图不得塞 base64\");\nassert.equal(normalized.attachments[0].type, \"image\");\nconsole.log(\"PROBE OK I-13\");"
  },
  {
    "id": "I-14",
    "kind": "invariant",
    "title": "I-14 决策单入口：显式关闭高于一切（已加载/冻结都不能抬回）",
    "target": "lib/decide.js",
    "requires": [],
    "anchor": "  // 4) 显式关闭高于一切：已加载、冻结、技能激活都不能把它抬回来（B21/B20 的结构性修法）。\n  if (tier === TIER_OFF) {",
    "replacement": "  if (false) {",
    "probe": "import assert from \"node:assert/strict\";\nimport { decideTool } from \"./lib/decide.js\";\nconst closed = decideTool({ name: \"x\", tier: 0, loaded: true, frozen: true });\nassert.equal(closed.removed, true, \"显式关闭必须进摘除集\");\nassert.equal(closed.bucket, \"off\");\nassert.equal(closed.removalReason, \"off\");\nconst resident = decideTool({ name: \"y\", tier: 1 });\nassert.equal(resident.resident, true);\nconst ondemand = decideTool({ name: \"z\", tier: 2 });\nassert.equal(ondemand.bucket, \"ondemand\");\nassert.equal(decideTool({ name: \"q\", tier: \"1\" }).invalidTier, true);\nconsole.log(\"PROBE OK I-14\");"
  },
  {
    "id": "I-15",
    "kind": "invariant",
    "title": "I-15 控制面失败必须状态码 + 错误信封，不得 200-on-failure / 只发头",
    "target": "lib/control/decorator.js",
    "requires": [
      "lib/control/decorator.js",
      "lib/control/errors.js",
      "lib/control/http.js"
    ],
    "anchor": "return send(nextStatus, envelope, headers);",
    "replacement": "return send(200, { ok: true }, headers);",
    "probe": "import assert from \"node:assert/strict\";\nimport { createControlHandler } from \"./lib/control/decorator.js\";\nconst handler = createControlHandler(\n  { id: \"probe\", path: \"/api/dsh-gate/probe\", methods: [\"GET\"], body: false, scope: \"none\", handler: async () => ({ status: 200, body: { ok: true } }) },\n  { authenticate: async () => ({ ok: true }), resolveScope: () => ({ ok: true }) },\n);\nconst fake = { statusCode: 0, headers: {}, body: \"\", ended: false, writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); }, end(b) { this.ended = true; this.body = b === undefined ? \"\" : String(b); } };\nawait handler({ method: \"DELETE\", url: \"/api/dsh-gate/probe\", headers: {} }, fake);\nassert.equal(fake.ended, true, \"失败分支必须结束响应\");\nassert.equal(fake.statusCode, 405, \"方法不允许必须返回 405（不得 200-on-failure）\");\nconst env = JSON.parse(fake.body);\nassert.equal(env.ok, false, \"错误信封必须带 ok: false\");\nassert.equal(env.code, \"METHOD_NOT_ALLOWED\", \"错误信封必须带稳定错误码\");\nconsole.log(\"PROBE OK I-15\");"
  },
  {
    "id": "I-16",
    "kind": "invariant",
    "title": "I-16 部署装卸对称、patch 行知识单真源",
    "target": "scripts/dsh-gate-deploy.psm1",
    "requires": [
      "scripts/dsh-gate-deploy.psm1",
      "scripts/install.ps1",
      "scripts/uninstall.ps1"
    ],
    "anchor": "$script:PatchRowPattern = '^\\s*-\\s*id:\\s*surface-gate\\s*(?:#.*)?$'",
    "replacement": "$script:PatchRowPattern = '^-\\s*id:\\s*surface-gate\\s*(?:#.*)?$'",
    "probe": "import assert from \"node:assert/strict\";\nimport { readFileSync } from \"node:fs\";\nconst psm = readFileSync(\"scripts/dsh-gate-deploy.psm1\", \"utf8\");\nconst install = readFileSync(\"scripts/install.ps1\", \"utf8\");\nconst uninstall = readFileSync(\"scripts/uninstall.ps1\", \"utf8\");\nassert.match(install, /dsh-gate-deploy\\.psm1/, \"install.ps1 必须导入唯一公共模块\");\nassert.match(uninstall, /dsh-gate-deploy\\.psm1/, \"uninstall.ps1 必须导入唯一公共模块\");\nassert.doesNotMatch(install, /id:\\s*surface-gate/, \"install.ps1 不得私写 patch 行\");\nassert.doesNotMatch(uninstall, /id:\\s*surface-gate/, \"uninstall.ps1 不得私写 patch 行正则\");\nconst pats = [...psm.matchAll(/\\$script:PatchRowPattern\\s*=\\s*'([^']+)'/g)];\nassert.equal(pats.length, 1, \"PatchRowPattern 必须只在公共模块定义一次\");\nconst rowMatch = psm.match(/'(\\s*-\\s*id:\\s*surface-gate)'/);\nassert.ok(rowMatch, \"公共模块必须定义安装写入的缩进 patch 行\");\nconst re = new RegExp(pats[0][1], \"m\");\nassert.equal(re.test(rowMatch[1]), true, \"PatchRowPattern 必须匹配 install 写入的缩进 patch 行（D-1 装卸对称）\");\nconsole.log(\"PROBE OK I-16\");"
  }
];
