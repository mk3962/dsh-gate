/**
 * S5 部署契约（#08 版）：先红后绿的那一层
 *
 * 覆盖 G80–G89 / D-1：
 *   静态  G89 四脚本共用唯一公共模块；G86 批处理 CRLF + 非零退出码；无第二份 patch 正则
 *   行为  G84 -DryRun 五项 + 零写入；G81/G82 六步事务与故障注入回滚；G80/D-1 装卸往返逐字节
 *        G83 备份命名与保留上限；G85 旧行迁移；G87 DSH home 四级顺序；G88 进程检测拒写
 *
 * 所有用例都在 os.tmpdir() 下的假 HOME 里跑真脚本，绝不触碰真实 ~/.dsh。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  SCRIPTS,
  SCRIPTS_DIR,
  REPO_ROOT,
  FIXED_PATCH_PATTERN,
  PATCH_ROW,
  createFakeHome,
  createPluginSource,
  runScriptAsync,
  runDryRunAsync,
  runBatchAsync,
  snapshotTree,
  snapshotDigest,
  snapshotsEqual,
  diffSnapshots,
  readScript,
  readScriptBytes,
  assertNoBom,
  assertCrlf,
  findSurfaceGateRows,
  parsePatchRows,
  firstWriteIndex,
  dryRunGuardIndex,
  powershellVersion,
  realHomeFingerprint,
} from "./s5-deploy-seam.mjs";

const realHomeBefore = realHomeFingerprint();
const PS = powershellVersion();

/** 用例级并发度：25 个用例各自独立假 HOME，真跑脚本互不依赖。 */
const S5_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.DSH_GATE_S5_CONCURRENCY) || 8));

/** 每个用例一个一次性假 HOME，结束即删；body 内部真跑脚本。 */
async function withHome(options, body) {
  const home = createFakeHome(options);
  try {
    return await body(home);
  } finally {
    home.cleanup();
  }
}

function diagStep(result) {
  return "\n--- exit " + result.status + " ---\n" + result.stdout.slice(-2500) + "\n--- stderr ---\n" + result.stderr.slice(-800);
}

function assertOk(result, label) {
  assert.equal(result.status, 0, label + " 应 exit 0" + diagStep(result));
}

function assertFail(result, label) {
  assert.notEqual(result.status, 0, label + " 应非零退出" + diagStep(result));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("S5 部署契约 · 真跑脚本与共享模块", { concurrency: S5_CONCURRENCY }, () => {
  /* ── 静态不变量 ───────────────────────────────────────────────────────── */

  test("G89 · 四脚本共用唯一公共模块，脚本里没有第二份 patch 正则", async () => {
    const moduleSource = readScript("module");
    const installSource = readScript("install");
    const uninstallSource = readScript("uninstall");

    assert.ok(fs.existsSync(SCRIPTS.module), "缺少共享模块 " + SCRIPTS.module);
    for (const [name, source] of [["install.ps1", installSource], ["uninstall.ps1", uninstallSource]]) {
      assert.match(source, /Import-Module\s+\(Join-Path \$here 'dsh-gate-deploy\.psm1'\)/, name + " 必须导入共享模块");
      assert.doesNotMatch(source, /id:\\s\*surface-gate/, name + " 不许自带 patch 行正则（必须走模块的唯一模式）");
      assert.doesNotMatch(source, /^function\s+/m, name + " 不许定义本地函数（公共逻辑必须唯一实现在模块里）");
    }

    const patternDefinitions = moduleSource.match(/\$script:PatchRowPattern\s*=/g) || [];
    assert.equal(patternDefinitions.length, 1, "patch 行模式必须只有一处定义，实际 " + patternDefinitions.length + " 处");

    // install / uninstall / 回读三处都必须引用同一个变量，而不是各自拼正则
    assert.ok((moduleSource.match(/Test-GatePatchRowPresent/g) || []).length >= 2, "插入/摘除/回读都要走 Test-GatePatchRowPresent");
    assert.match(moduleSource, /function Test-GatePatchRowPresent[\s\S]{0,400}?\$script:PatchRowPattern/);
    assert.match(moduleSource, /function Add-GatePatchText[\s\S]{0,800}?Test-GatePatchRowPresent/, "插入前必须用同一模式判重");
    assert.match(moduleSource, /function Remove-GatePatchText[\s\S]{0,1200}?\$script:PatchRowPattern/, "摘除必须用同一模式");
  });

  test("G86 · 批处理全 CRLF、失败回传非零退出码", async () => {
    for (const name of ["activate.cmd", "rollback.cmd"]) {
      const bytes = readScriptBytes(name);
      const crlf = assertCrlf(bytes, name);
      assert.ok(crlf >= 3, name + " 行数异常：" + crlf);
      const source = bytes.toString("latin1");
      assert.match(source, /exit \/b %RC%/, name + " 必须用 exit /b %RC% 回传退出码");
      assert.match(source, /set "RC=%ERRORLEVEL%"/, name + " 必须先保存 ERRORLEVEL");
      assert.match(source, /chcp 65001/, name + " 必须切 UTF-8 代码页");
      assert.doesNotMatch(source, /^\s*@?rem[^\n]*\n(?![^\n]*\r\n)/, name + " 不许出现裸 LF");
    }
    // install / uninstall 的 DryRun 必须在任何写操作之前退出（写操作都在模块里）
    const installSource = readScript("install");
    assert.ok(dryRunGuardIndex(installSource) > 0, "install.ps1 缺少 if ($DryRun) 守卫");
    assert.ok(firstWriteIndex(installSource) === -1, "install.ps1 不应直接写盘（写操作必须归模块）");
  });

  test("模块与脚本都是无 BOM 写盘约定：脚本自身可带 BOM，但写入 DSH 文件的路径必须是 UTF8Encoding($false)", async () => {
    const moduleSource = readScript("module");
    assert.match(moduleSource, /New-Object System\.Text\.UTF8Encoding\(\$false\)/, "必须用无 BOM 的 UTF8Encoding($false) 落盘");
    assert.match(moduleSource, /fs\.writeFileSync\(file, Buffer\.from\(out, "utf8"\)\)/, "package.json 必须由 node 按 UTF-8 无 BOM 写");
    // 写 DSH 会解析的文件时不许出现会带 BOM 的 cmdlet
    for (const line of moduleSource.split(/\r?\n/)) {
      if (/Set-Content|Out-File|Add-Content/.test(line)) {
        assert.doesNotMatch(line, /Set-Content|Out-File|Add-Content/, "模块里出现了可能带 BOM 的写盘 cmdlet：" + line.trim());
      }
    }
  });

  /* ── G84 试运行 ───────────────────────────────────────────────────────── */

  test("G84 · install -DryRun 输出五项预检且零字节写入", async () => {
    await withHome({}, async (home) => {
      const plugin = createPluginSource(home);
      const before = snapshotTree(home.root);
      const result = await runDryRunAsync(home, "install", ["-Source", plugin.dir, "-BackupRoot", home.backupRoot]);
      assertOk(result, "install -DryRun");
      for (const label of [
        "1) 目标 profile 是否运行",
        "2) 目标路径可写",
        "3) 磁盘余量",
        "4) 是否同卷",
        "5) junction 权限",
        "[dry-run] 未写入任何字节（只读预览）",
      ]) {
        assert.ok(result.stdout.includes(label), "DryRun 输出缺少「" + label + "」" + diagStep(result));
      }
      assert.equal(snapshotDigest(before), snapshotDigest(snapshotTree(home.root)), "-DryRun 不许写任何字节" + diagStep(result));
      assert.deepEqual(diffSnapshots(before, snapshotTree(home.root)), []);
      assert.equal(fs.existsSync(home.backupRoot), false, "-DryRun 不许创建备份目录");
      assert.equal(fs.existsSync(home.junctionPath), false, "-DryRun 不许建 junction");
      assert.equal(fs.existsSync(home.sourceDir), false, "-DryRun 不许复制源码");
      assert.equal(fs.readFileSync(home.patchPath, "utf8"), "[]\n", "patch 文件必须原样");
    });
  });

  test("G84 · uninstall -DryRun 在已安装状态下同样零写入", async () => {
    await withHome({}, async (home) => {
      const plugin = createPluginSource(home);
      assertOk(await runScriptAsync("install", home, { source: plugin.dir, backupRoot: home.backupRoot }), "install");
      const before = snapshotTree(home.root);
      const result = await runDryRunAsync(home, "uninstall", ["-BackupRoot", home.backupRoot]);
      assertOk(result, "uninstall -DryRun");
      assert.ok(result.stdout.includes("6) cordis.patch.yml"), "uninstall DryRun 应列出摘除步骤" + diagStep(result));
      assert.ok(result.stdout.includes("[dry-run] 未写入任何字节（只读预览）"));
      assert.equal(snapshotDigest(before), snapshotDigest(snapshotTree(home.root)), "uninstall -DryRun 不许写任何字节");
    });
  });

  /* ── G81 真装 + G80 真卸 ──────────────────────────────────────────────── */

  test("G81 · 真装：六步输出、junction 就位、manifest/patch/策略种子齐全且无 BOM", async () => {
    await withHome({}, async (home) => {
      const plugin = createPluginSource(home);
      const result = await runScriptAsync("install", home, { source: plugin.dir, backupRoot: home.backupRoot });
      assertOk(result, "install");
      for (let step = 1; step <= 6; step += 1) {
        assert.ok(result.stdout.includes("[" + step + "/6]"), "缺少 [" + step + "/6] 输出" + diagStep(result));
      }

      const junctionStat = fs.lstatSync(home.junctionPath);
      assert.ok(junctionStat.isSymbolicLink(), "node_modules\\dsh-gate 必须是 junction/链接");
      assert.equal(path.resolve(fs.realpathSync(home.junctionPath)), path.resolve(fs.realpathSync(home.sourceDir)), "junction 必须指向 <DSH home>\\local-plugins\\dsh-gate");
      assert.ok(fs.existsSync(path.join(home.sourceDir, "package.json")), "源码目录缺 package.json");

      const manifest = readJson(home.manifestPath);
      assert.ok(manifest.dsh.profile.bundles.includes("dsh-gate"), "bundles 应含 dsh-gate");
      assert.equal(manifest.dependencies["dsh-gate"], "link:../../local-plugins/dsh-gate");

      const patchBytes = fs.readFileSync(home.patchPath);
      assertNoBom(patchBytes, "cordis.patch.yml");
      assertNoBom(fs.readFileSync(home.manifestPath), "package.json");
      const patchText = patchBytes.toString("utf8");
      assert.ok(FIXED_PATCH_PATTERN.test(patchText), "patch 文件里应有 surface-gate 行：" + patchText);
      const rows = findSurfaceGateRows(patchText);
      assert.equal(rows.length, 1, "只许一行 surface-gate");
      assert.ok(rows[0].indent > 0, "surface-gate 行应是缩进块成员（与宿主既有 patch 风格一致）");
      assert.equal(rows[0].fields.name, "dsh-gate");

      assert.ok(fs.existsSync(home.gateJsonPath), "策略种子应种到 DSH home/gate.json");
      assertNoBom(fs.readFileSync(home.gateJsonPath), "gate.json");
    });
  });

  test("G80 / D-1 · 装完再卸，profile 逐字节回到初始（含 patch 行真被摘掉）", async () => {
    await withHome({}, async (home) => {
      const plugin = createPluginSource(home);
      const before = snapshotTree(home.profileDir);
      const patchBefore = fs.readFileSync(home.patchPath);

      const install = await runScriptAsync("install", home, { source: plugin.dir, backupRoot: home.backupRoot });
      assertOk(install, "install");
      assert.ok(fs.existsSync(home.junctionPath));

      const uninstall = await runScriptAsync("uninstall", home, { backupRoot: home.backupRoot });
      assertOk(uninstall, "uninstall");
      for (let step = 1; step <= 7; step += 1) {
        assert.ok(uninstall.stdout.includes("[" + step + "/7]"), "缺少 [" + step + "/7] 输出" + diagStep(uninstall));
      }

      assert.deepEqual(diffSnapshots(before, snapshotTree(home.profileDir)), [], "profile 必须逐字节回到安装前");
      assert.deepEqual(fs.readFileSync(home.patchPath), patchBefore, "cordis.patch.yml 必须逐字节还原");
      assert.equal(fs.existsSync(home.junctionPath), false, "junction 必须消失");
      assert.equal(fs.existsSync(home.sourceDir), false, "源码目录应移入备份");
      const manifest = readJson(home.manifestPath);
      assert.deepEqual(manifest.dsh.profile.bundles, ["dsh-core"]);
      assert.equal(manifest.dependencies["dsh-gate"], undefined);
    });
  });

  test("S5 · 真缺陷登记：uninstall 认不出 install 写的缩进 patch 行（卸不掉）", async () => {
    // defect-registry D-1 的 replay.case 必须存在：合并前它断言缺陷（= False），合并后断言契约成立（= True）。
    // 这一条就是「D-1 已修」的可重放证据：卸载**看得见** install 写的缩进行，并且真的把它摘掉。
    await withHome({}, async (home) => {
      const plugin = createPluginSource(home);
      assertOk(await runScriptAsync("install", home, { source: plugin.dir, backupRoot: home.backupRoot }), "install");
      const installedPatch = fs.readFileSync(home.patchPath, "utf8");
      assert.ok(FIXED_PATCH_PATTERN.test(installedPatch), "install 应写入缩进的 surface-gate 行：" + installedPatch);

      const dry = await runDryRunAsync(home, "uninstall", ["-BackupRoot", home.backupRoot]);
      assertOk(dry, "uninstall -DryRun");
      assert.ok(dry.stdout.includes("patch 行 : surface-gate 已在 cordis.patch.yml = True"), "卸载必须认得缩进行（旧版这里是 False）" + diagStep(dry));

      assertOk(await runScriptAsync("uninstall", home, { backupRoot: home.backupRoot }), "uninstall");
      const finalPatch = fs.readFileSync(home.patchPath, "utf8");
      assert.equal(FIXED_PATCH_PATTERN.test(finalPatch), false, "卸载必须真的摘掉缩进行：" + finalPatch);
      assert.equal(finalPatch, "[]\n", "空数组 patch 应逐字节回到 []\\n：" + JSON.stringify(finalPatch));
    });
  });

  test("G80 · 重复安装幂等：patch 里只有一行 surface-gate，bundles 不重复", async () => {
    await withHome({}, async (home) => {
      const plugin = createPluginSource(home);
      assertOk(await runScriptAsync("install", home, { source: plugin.dir, backupRoot: home.backupRoot }), "第一次 install");
      const second = await runScriptAsync("install", home, { source: plugin.dir, backupRoot: home.backupRoot });
      assertOk(second, "第二次 install");
      assert.ok(second.stdout.includes("patch 行已存在"), "第二次应识别已有行" + diagStep(second));
      assert.equal(findSurfaceGateRows(fs.readFileSync(home.patchPath, "utf8")).length, 1);
      const manifest = readJson(home.manifestPath);
      assert.equal(manifest.dsh.profile.bundles.filter((b) => b === "dsh-gate").length, 1);
    });
  });

  /* ── G85 旧行迁移 ─────────────────────────────────────────────────────── */

  test("G85 · 旧 patch（顶层行 + 注释 + 空行 + 其它块）能迁移并安全往返", async () => {
    const legacy = [
      "# 手工维护的补丁",
      "",
      "- insert:",
      "    - id: other-plugin",
      "      name: other-plugin",
      "      disabled: false",
      "- id: surface-gate",
      "  name: dsh-gate",
      "  disabled: false",
      "",
    ].join("\n");
    await withHome({ patchText: legacy }, async (home) => {
      const plugin = createPluginSource(home);
      const install = await runScriptAsync("install", home, { source: plugin.dir, backupRoot: home.backupRoot });
      assertOk(install, "legacy install");
      assert.ok(install.stdout.includes("已迁移 1 条"), "应输出迁移计数" + diagStep(install));
      const installedText = fs.readFileSync(home.patchPath, "utf8");
      const rows = findSurfaceGateRows(installedText);
      assert.equal(rows.length, 1, "迁移后只许一行 surface-gate：" + installedText);
      assert.ok(rows[0].indent > 0, "迁移后必须落成缩进块成员：" + installedText);
      assert.ok(installedText.includes("other-plugin"), "其它插件行不许丢");

      const uninstall = await runScriptAsync("uninstall", home, { backupRoot: home.backupRoot });
      assertOk(uninstall, "legacy uninstall");
      const finalText = fs.readFileSync(home.patchPath, "utf8");
      assert.equal(FIXED_PATCH_PATTERN.test(finalText), false, "卸载后不许残留 surface-gate 行：" + finalText);
      assert.ok(finalText.includes("other-plugin"), "other-plugin 必须保留：" + finalText);
      assert.ok(finalText.includes("# 手工维护的补丁"), "注释必须保留：" + finalText);
      assert.equal(parsePatchRows(finalText).length, 1, "只剩 other-plugin 一行：" + finalText);
      assert.equal(/^-\s*insert:\s*$/m.test(finalText.split("other-plugin")[0]), true, "other-plugin 的 - insert: 块必须完整：" + finalText);
    });
  });

  test("G85 · 仅含历史裸顶层 surface-gate 行时直接卸载必须成功落盘且回读通过", async () => {
    const legacyOnly = [
      "# 手工维护的补丁",
      "- insert:",
      "    - id: other-plugin",
      "      name: other-plugin",
      "      disabled: false",
      "- id: surface-gate",
      "  name: dsh-gate",
      "  disabled: false",
      "",
    ].join("\n");
    await withHome({ patchText: legacyOnly }, async (home) => {
      const uninstall = await runScriptAsync("uninstall", home, { backupRoot: home.backupRoot });
      assertOk(uninstall, "legacy-only uninstall");
      const finalText = fs.readFileSync(home.patchPath, "utf8");
      assert.equal(FIXED_PATCH_PATTERN.test(finalText), false, "卸载后不许残留裸顶层 surface-gate 行：" + finalText);
      assert.ok(finalText.includes("other-plugin"), "other-plugin 必须保留：" + finalText);
      assert.ok(finalText.includes("# 手工维护的补丁"), "注释必须保留：" + finalText);
    });
  });

  /* ── G82 故障注入回滚 ────────────────────────────────────────────────── */

  for (const step of ["preflight", "stage", "stage-copy", "verify", "swap-before-promote", "swap", "patch", "readback"]) {
    test("G82 · 故障注入 " + step + "：非零退出且回滚到安装前、无悬空 junction", async () => {
      await withHome({}, async (home) => {
        const plugin = createPluginSource(home);
        const before = snapshotTree(home.profileDir);
        const result = await runScriptAsync("install", home, {
          source: plugin.dir,
          backupRoot: home.backupRoot,
          env: { DSH_GATE_TEST_FAIL_STEP: step },
        });
        assertFail(result, "注入 " + step + " 后");
        assert.ok(result.stdout.includes("[失败] 步骤"), "应打印失败步骤" + diagStep(result));
        assert.ok(result.stdout.includes("[回滚]"), "应打印回滚结果" + diagStep(result));
        assert.deepEqual(diffSnapshots(before, snapshotTree(home.profileDir)), [], "注入 " + step + " 后 profile 必须回到安装前");
        assert.equal(fs.existsSync(home.junctionPath), false, "不许留悬空 junction");
        assert.equal(fs.existsSync(home.sourceDir), false, "不许留半装源码目录");
        const localRoot = path.join(home.dshHome, "local-plugins");
        if (fs.existsSync(localRoot)) {
          const leftovers = fs.readdirSync(localRoot).filter((name) => name.startsWith(".staging-"));
          assert.deepEqual(leftovers, [], "不许留暂存目录：" + leftovers.join(","));
        }
        assert.equal(FIXED_PATCH_PATTERN.test(fs.readFileSync(home.patchPath, "utf8")), false, "patch 行必须已被撤销");
      });
    });
  }

  /* ── G83 备份 ─────────────────────────────────────────────────────────── */

  test("G83 · 备份命名带种类 + 时间戳，保留上限默认 3 且可配", async () => {
    await withHome({}, async (home) => {
      const plugin = createPluginSource(home);
      for (let round = 1; round <= 4; round += 1) {
        assertOk(await runScriptAsync("install", home, { source: plugin.dir, backupRoot: home.backupRoot, keepBackups: 3 }), "第 " + round + " 次 install");
      }
      const names = fs.readdirSync(home.backupRoot);
      const manifests = names.filter((name) => /^manifest\.\d{8}T\d{9}$/.test(name));
      const patches = names.filter((name) => /^patch\.\d{8}T\d{9}$/.test(name));
      const sources = names.filter((name) => /^source-preinstall\.\d{8}T\d{9}$/.test(name));
      assert.equal(manifests.length, 3, "manifest 备份应保留 3 份，实际：" + names.join(","));
      assert.equal(patches.length, 3, "patch 备份应保留 3 份，实际：" + names.join(","));
      assert.ok(sources.length <= 3, "source 备份应受同一上限约束，实际：" + sources.join(","));
      for (const dirName of ["manifest", "patch", "source-preinstall"]) {
        const kept = names.filter((name) => name.startsWith(dirName + ".")).sort();
        assert.equal(kept.length, new Set(kept).size, dirName + " 备份不许重名");
      }
    });
  });

  test("G83 · 卸载的两条备份路径不再同名冲突（manifest 与 patch 各自带种类）", async () => {
    await withHome({}, async (home) => {
      const plugin = createPluginSource(home);
      assertOk(await runScriptAsync("install", home, { source: plugin.dir, backupRoot: home.backupRoot }), "install");
      const uninstall = await runScriptAsync("uninstall", home, { backupRoot: home.backupRoot });
      assertOk(uninstall, "uninstall");
      const names = fs.readdirSync(home.backupRoot);
      const removed = names.filter((name) => /^source-removed\.\d{8}T\d{9}$/.test(name));
      assert.equal(removed.length, 1, "卸载源码备份应按 source-removed.<时间戳> 命名：" + names.join(","));
      assert.ok(names.some((name) => /^manifest\.\d{8}T\d{9}$/.test(name)), "卸载也必须备份 manifest：" + names.join(","));
      assert.ok(names.some((name) => /^patch\.\d{8}T\d{9}$/.test(name)), "卸载也必须备份 patch：" + names.join(","));
    });
  });

  /* ── G87 DSH home 顺序 ───────────────────────────────────────────────── */

  test("G87 · DSH home：显式参数 > 环境变量 DSH_HOME > profile 推导", async () => {
    await withHome({}, async (home) => {
      const plugin = createPluginSource(home);

      // ① 只有 -Profile：从 <home>/profiles/<name> 推导出 <home>
      const explicitProfile = await runScriptAsync("install", home, { source: plugin.dir, backupRoot: home.backupRoot, gateHome: null, noSnapshot: true });
      assertOk(explicitProfile, "profile 推导 GateHome");
      assert.ok(explicitProfile.stdout.includes("来源：profile 路径推导"), "应标注 profile 推导来源" + diagStep(explicitProfile));
      assert.ok(fs.existsSync(home.sourceDir), "源码应落在推导出的 DSH home 下");

      assertOk(await runScriptAsync("uninstall", home, { backupRoot: home.backupRoot, noSnapshot: true }), "清理");
    });

    await withHome({}, async (home) => {
      const plugin = createPluginSource(home);
      const fromEnv = await runScriptAsync("install", home, {
        source: plugin.dir,
        backupRoot: home.backupRoot,
        gateHome: null,
        env: { DSH_HOME: home.dshHome },
        noSnapshot: true,
      });
      assertOk(fromEnv, "环境变量 DSH_HOME");
      assert.ok(fromEnv.stdout.includes("来源：环境变量 DSH_HOME"), "DSH_HOME 优先于 profile 推导" + diagStep(fromEnv));
      assert.ok(fs.existsSync(home.gateJsonPath), "策略种子必须种到运行时用的 DSH home");
    });

    await withHome({}, async (home) => {
      const plugin = createPluginSource(home);
      const otherHome = path.join(home.root, "runtime-dsh");
      fs.mkdirSync(otherHome, { recursive: true });
      const mismatched = await runScriptAsync("install", home, {
        source: plugin.dir,
        backupRoot: home.backupRoot,
        env: { DSH_HOME: otherHome },
        noSnapshot: true,
      });
      assertOk(mismatched, "显式 -GateHome 与 DSH_HOME 不一致时仍继续");
      assert.ok(mismatched.stdout.includes("不一致"), "必须告警不一致" + diagStep(mismatched));
      // G87：策略种子必须种到运行时真的会读的目录（DSH_HOME），否则面板恒为零（工单点名的缺陷）。
      assert.ok(fs.existsSync(path.join(otherHome, "gate.json")), "策略必须种到运行时 DSH_HOME，而不是显式 -GateHome");
      assert.equal(fs.existsSync(home.gateJsonPath), false, "不许把策略种到运行时不读的路径");
      assert.ok(fs.existsSync(path.join(home.dshHome, "local-plugins", "dsh-gate")), "安装位置仍按显式 GateHome");
    });
  });

  /* ── G88 进程检测 ─────────────────────────────────────────────────────── */

  test("G88 · 进程检测不可用：默认拒写，-Force 才继续", async () => {
    await withHome({}, async (home) => {
      const plugin = createPluginSource(home);
      const before = snapshotTree(home.root);
      const blocked = await runScriptAsync("install", home, {
        source: plugin.dir,
        backupRoot: home.backupRoot,
        env: { DSH_GATE_TEST_PROCESS_PROBE: "unavailable" },
      });
      assertFail(blocked, "检测不可用");
      assert.equal(blocked.status, 10, "检测不可用应 exit 10" + diagStep(blocked));
      assert.ok(blocked.stdout.includes("无法判定") || blocked.stdout.includes("拒绝"), "文案必须诚实说明无法判定" + diagStep(blocked));
      assert.equal(snapshotDigest(before), snapshotDigest(snapshotTree(home.root)), "拒写时不许写任何字节");

      const forced = await runScriptAsync("install", home, {
        source: plugin.dir,
        backupRoot: home.backupRoot,
        flags: ["-Force"],
        env: { DSH_GATE_TEST_PROCESS_PROBE: "unavailable" },
      });
      assertOk(forced, "-Force 后应继续");
      assert.ok(fs.existsSync(home.junctionPath), "-Force 后应装好");
    });
  });

  test("G88 · 进程在跑：默认拒写，-Force 才继续", async () => {
    await withHome({}, async (home) => {
      const plugin = createPluginSource(home);
      const blocked = await runScriptAsync("install", home, {
        source: plugin.dir,
        backupRoot: home.backupRoot,
        env: { DSH_GATE_TEST_PROCESS_PROBE: "running" },
      });
      assertFail(blocked, "profile 在跑");
      assert.equal(blocked.status, 10);
      assert.equal(fs.existsSync(home.junctionPath), false);
    });
  });

  /* ── G86 批处理真跑 ───────────────────────────────────────────────────── */

  test("G86 · activate.cmd 成功退出码 0，rollback.cmd 失败时回传非零", async () => {
    await withHome({}, async (home) => {
      const plugin = createPluginSource(home);
      const ok = await runBatchAsync(SCRIPTS.activate, ["-DryRun", "-Profile", home.profileDir, "-GateHome", home.dshHome, "-Source", plugin.dir]);
      assert.equal(ok.status, 0, "activate.cmd 应 exit 0" + diagStep({ status: ok.status, stdout: ok.stdout, stderr: ok.stderr }));
      assert.ok(ok.stdout.includes("[dry-run]"), "应透传 install.ps1 输出" + diagStep({ status: ok.status, stdout: ok.stdout, stderr: ok.stderr }));

      const failing = await runBatchAsync(SCRIPTS.rollback, ["-Profile", home.profileDir, "-GateHome", home.dshHome], {
        env: { DSH_GATE_TEST_PROCESS_PROBE: "unavailable" },
      });
      assert.notEqual(failing.status, 0, "rollback.cmd 必须把失败退出码透传出来" + diagStep({ status: failing.status, stdout: failing.stdout, stderr: failing.stderr }));
      assert.equal(failing.status, 10, "应透传 install.ps1 的 exit 10");
    });
  });

});

/* ── 真 HOME 未被触碰 ─────────────────────────────────────────────────── */

test("全部用例跑完，真实 ~/.dsh 的 manifest / patch 指纹未变", async () => {
  // gate.json 由正在运行的 DSH 宿主自己写（活动统计），跑测试期间会变；
  // 这里只盯部署脚本会写的两个文件：真实 profile 的 package.json 与 cordis.patch.yml。
  const stable = (entries) => entries.filter((entry) => /(package.json|cordis.patch.yml)$/.test(entry.path));
  assert.deepEqual(stable(realHomeFingerprint()), stable(realHomeBefore), "真跑假 HOME 不许碰真实 ~/.dsh 的 manifest/patch");
  assert.ok(PS.version.length > 0);
});
