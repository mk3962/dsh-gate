/**
 * S5 契约：假 HOME 上真跑 install.ps1 / uninstall.ps1 -DryRun（零写入）+ 字节快照
 * + patch 行插入/摘除对称性（含 0.5.7 的「卸不掉」真缺陷登记）。
 *
 * 运行：node --import ./test/stub-loader.mjs test/seams/s5-deploy-contract.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SCRIPTS,
  PATCH_ROW,
  INSTALL_PATCH_PATTERN,
  UNINSTALL_PATCH_PATTERN,
  FIXED_PATCH_PATTERN,
  assertIsolatedRoot,
  assertInsideRoot,
  createFakeHome,
  writeTextNoBom,
  writeTextWithBom,
  snapshotTree,
  snapshotDigest,
  diffSnapshots,
  snapshotsEqual,
  runDryRun,
  parsePatchRows,
  findSurfaceGateRows,
  applyPatchInsertion,
  removeSurfaceGateRows,
  readScript,
  firstWriteIndex,
  dryRunGuardIndex,
  realHomeFingerprint,
  powershellVersion,
} from "./s5-deploy-seam.mjs";

const countOf = (text, needle) => text.split(needle).length - 1;

const withHome = async (options, run) => {
  const home = createFakeHome(options);
  try { return await run(home); } finally { home.cleanup(); }
};

test("S5 · 假 HOME 落在临时目录、结构最小可用，且拒绝指向真实 ~/.dsh", async () => {
  await withHome({}, (home) => {
    assert.ok(home.root.startsWith(os.tmpdir()), "夹具根必须在系统临时目录内");
    assert.notEqual(path.resolve(home.root), path.resolve(os.homedir(), ".dsh"));
    for (const dir of [home.profileDir, home.nodeModules, home.pluginsDir]) assert.ok(fs.existsSync(dir), "目录必须存在：" + dir);
    assert.ok(home.exists(".dsh/profiles/desktop/package.json"));
    assert.ok(home.exists(".dsh/profiles/desktop/cordis.patch.yml"));
    assert.deepEqual(JSON.parse(home.read(".dsh/profiles/desktop/package.json")).dsh.profile.bundles, ["dsh-core"]);

    const realHome = path.join(os.homedir(), ".dsh");
    assert.throws(() => assertIsolatedRoot(realHome), (error) => error.code === "REAL_HOME_FORBIDDEN");
    assert.throws(() => assertIsolatedRoot(path.join(realHome, "profiles", "desktop")), (error) => error.code === "REAL_HOME_FORBIDDEN");
    assert.throws(() => writeTextNoBom(home.root, "../escape.txt", "x"), (error) => error.code === "TARGET_OUTSIDE_ROOT");
    assert.throws(() => assertInsideRoot(home.root, realHome), (error) => error.code === "TARGET_OUTSIDE_ROOT");
  });
});

test("S5 · 字节快照：排序稳定、能识别 BOM / 修改 / 增删", async () => {
  await withHome({}, (home) => {
    const before = snapshotTree(home.root);
    assert.deepEqual(before.files.map((file) => file.path), before.files.map((file) => file.path).slice().sort());
    assert.ok(before.files.every((file) => file.bom === false), "种子文件都不许带 BOM");
    assert.equal(snapshotDigest(before), snapshotDigest(snapshotTree(home.root)), "未改动时摘要必须相同");

    writeTextWithBom(home.root, ".dsh/profiles/desktop/bom.json", "{}\n");
    writeTextNoBom(home.root, ".dsh/profiles/desktop/extra.yml", "- insert: []\n");
    const after = snapshotTree(home.root);
    const changes = diffSnapshots(before, after);
    assert.deepEqual(changes.map((item) => [item.path, item.change]), [
      [".dsh/profiles/desktop/bom.json", "added"],
      [".dsh/profiles/desktop/extra.yml", "added"],
    ]);
    const bomFile = after.files.find((file) => file.path.endsWith("bom.json"));
    assert.equal(bomFile.bom, true, "带 BOM 的文件必须被标记");
    assert.equal(snapshotsEqual(before, after), false);

    const modified = snapshotTree(home.root);
    writeTextNoBom(home.root, ".dsh/profiles/desktop/extra.yml", "- insert: [x]\n");
    const afterModify = diffSnapshots(modified, snapshotTree(home.root));
    assert.deepEqual(afterModify.map((item) => [item.path, item.change]), [[".dsh/profiles/desktop/extra.yml", "modified"]]);

    fs.rmSync(path.join(home.root, ".dsh/profiles/desktop/extra.yml"));
    const afterRemove = diffSnapshots(modified, snapshotTree(home.root));
    assert.deepEqual(afterRemove.map((item) => [item.path, item.change]), [[".dsh/profiles/desktop/extra.yml", "removed"]]);
  });
});

test("S5 · install.ps1 -DryRun 真跑：exit 0、零写入、真实 home 指纹不变", async () => {
  const realBefore = realHomeFingerprint();
  await withHome({ patchText: "[]\n" }, (home) => {
    const result = runDryRun(home, "install");
    assert.equal(result.status, 0, "install -DryRun 必须 exit 0；stderr=" + result.stderr.slice(0, 400));
    assert.equal(result.stderr.trim(), "");
    assert.match(result.stdout, /\[dry-run\] 将执行/);
    assert.match(result.stdout, /8\) 回读校验/);
    assert.match(result.stdout, /patch 行 : surface-gate 已在 cordis\.patch\.yml = False/);
    assert.deepEqual(result.changes, [], "DryRun 不许有任何字节变化");
    assert.equal(snapshotDigest(result.before), snapshotDigest(result.after));
  });
  assert.deepEqual(realHomeFingerprint(), realBefore, "真实 ~/.dsh 的只读指纹必须不变");
});

test("S5 · uninstall.ps1 -DryRun 真跑：exit 0、零写入", async () => {
  const realBefore = realHomeFingerprint();
  await withHome({ patchText: PATCH_ROW.text + "\n" }, (home) => {
    const result = runDryRun(home, "uninstall");
    assert.equal(result.status, 0, "uninstall -DryRun 必须 exit 0；stderr=" + result.stderr.slice(0, 400));
    assert.equal(result.stderr.trim(), "");
    assert.match(result.stdout, /\[dry-run\] 将执行/);
    assert.match(result.stdout, /6\) 回读校验/);
    assert.deepEqual(result.changes, []);
  });
  assert.deepEqual(realHomeFingerprint(), realBefore, "真实 ~/.dsh 的只读指纹必须不变");
});

test("S5 · 真缺陷登记：uninstall 认不出 install 写的缩进 patch 行（卸不掉）", async () => {
  await withHome({ patchText: PATCH_ROW.text + "\n" }, (home) => {
    // uninstall 自己宣布「没有这一行」——可 install 明明刚写进去。
    const result = runDryRun(home, "uninstall");
    assert.match(result.stdout, /patch 行 : surface-gate 在 cordis\.patch\.yml = False/);
    const text = home.read(".dsh/profiles/desktop/cordis.patch.yml");
    assert.equal(findSurfaceGateRows(text).length, 1, "文件里确实有一行 surface-gate");
    assert.equal(UNINSTALL_PATCH_PATTERN.test(text), false, "uninstall 的正则认不出缩进行");
    assert.equal(INSTALL_PATCH_PATTERN.test(text), true, "install 的正则认得出");
    assert.equal(FIXED_PATCH_PATTERN.test(text), true);
  });
});

test("S5 · patch 插入幂等 + 摘除往返字节不变量（修复后的正则）", async () => {
  await withHome({ patchText: "[]\n" }, (home) => {
    const first = applyPatchInsertion("[]\n");
    assert.deepEqual([first.inserted, first.reason], [true, "empty-array"]);
    const second = applyPatchInsertion(first.text);
    assert.deepEqual([second.inserted, second.reason], [false, "already-present"]);
    assert.equal(second.text, first.text, "重复安装不得重复追加");

    const emptySnapshot = snapshotTree(home.root);
    writeTextNoBom(home.root, ".dsh/profiles/desktop/cordis.patch.yml", first.text);
    const insertedSnapshot = snapshotTree(home.root);
    const digestOf = (snapshot) => snapshot.files.find((file) => file.path.endsWith("cordis.patch.yml")).sha1;
    assert.notEqual(digestOf(insertedSnapshot), digestOf(emptySnapshot), "插入必须改字节");

    const removed = removeSurfaceGateRows(first.text, { pattern: FIXED_PATCH_PATTERN });
    assert.equal(removed.removed, 1);
    assert.equal(removed.pruned, 1, "空掉的 - insert: 块必须一起摘掉");
    assert.equal(removed.text, "[]\n", "摘掉唯一一行后必须回到空数组");
    assert.deepEqual(findSurfaceGateRows(removed.text), []);
    writeTextNoBom(home.root, ".dsh/profiles/desktop/cordis.patch.yml", removed.text);
    assert.equal(digestOf(snapshotTree(home.root)), digestOf(emptySnapshot), "插入再摘除必须回到同一字节");
  });
});

test("S5 · 用脚本现有正则摘除：行留着 + 只剩孤零零的 - insert:", async () => {
  await withHome({}, () => {
    const inserted = applyPatchInsertion("[]\n");
    const broken = removeSurfaceGateRows(inserted.text);
    assert.equal(broken.removed, 0, "现有 uninstall 正则一行也认不出");
    assert.equal(broken.text, inserted.text);
    assert.equal(broken.text.split("\n")[0], "- insert:", "真正的后果：- insert: 变成孤儿，宿主解析会炸");
    assert.equal(findSurfaceGateRows(broken.text).length, 1);
  });
});

test("S5 · 修复后的摘除只删自己那一行，别家的行原样保留", async () => {
  await withHome({}, () => {
    const text = [
      "- insert:",
      "    - id: other-plugin",
      "      name: other-plugin",
      "      disabled: false",
      PATCH_ROW.text,
      "",
    ].join("\n");
    const rows = parsePatchRows(text);
    assert.deepEqual(rows.map((row) => [row.id, row.indent, row.topLevel]), [["other-plugin", 4, false], ["surface-gate", 4, false]]);
    const removed = removeSurfaceGateRows(text, { pattern: FIXED_PATCH_PATTERN });
    assert.equal(removed.removed, 1);
    assert.match(removed.text, /- id: other-plugin/);
    assert.doesNotMatch(removed.text, /- id: surface-gate/);
    assert.equal(findSurfaceGateRows(removed.text).length, 0);
  });
});

test("S5 · 静态不变量：DryRun 在第一次写盘之前（两脚本都成立）", () => {
  for (const kind of ["install", "uninstall"]) {
    const source = readScript(kind);
    const guard = dryRunGuardIndex(source);
    const write = firstWriteIndex(source);
    assert.ok(guard > 0, kind + " 必须有 if ($DryRun)");
    assert.ok(write > guard, kind + " 的第一次写盘必须晚于 DryRun 分支（guard=" + guard + " write=" + write + "）");
    const guardBody = source.slice(guard, write);
    assert.match(guardBody, /exit 0/, "DryRun 分支必须 exit 0");
    assert.doesNotMatch(guardBody, /\bNew-Item\b|\bCopy-Item\b|WriteAllText/, "DryRun 分支里不许出现写盘动作");
  }
});

test("S5 · 静态不变量：写 JSON/YAML 一律无 BOM（UTF8Encoding($false) + node Buffer）", () => {
  for (const kind of ["install", "uninstall"]) {
    const source = readScript(kind);
    assert.match(source, /New-Object System\.Text\.UTF8Encoding\(\$false\)/, kind + " 必须显式无 BOM 编码");
    assert.doesNotMatch(source, /UTF8Encoding\(\$true\)/, kind + " 不许用带 BOM 编码");
    assert.ok(source.includes('fs.writeFileSync(file, Buffer.from(out, "utf8"))'), kind + " 写 package.json 必须走 node Buffer");
    const setContents = source.split("\n").filter((line) => line.includes("Set-Content"));
    assert.ok(setContents.length > 0, "脚本用 Set-Content 写临时 .cjs");
    for (const line of setContents) assert.match(line, /-Encoding ASCII/, "Set-Content 只允许 ASCII 临时脚本：" + line.trim());
  }
});

test("S5 · 静态不变量：install 写缩进行、uninstall 三处都用顶层正则（缺陷锚点固定）", () => {
  const install = readScript("install");
  const uninstall = readScript("uninstall");
  // install 的 $row 字面量必须就是 PATCH_ROW 的形状（缩进 4 空格的 - id:）。
  const start = install.indexOf('$row = @"');
  assert.ok(start > 0, "install 里必须能抽出 $row 字面量");
  const bodyStart = install.indexOf("\n", start) + 1;
  const bodyEnd = install.indexOf('"@', bodyStart);
  const rowText = install.slice(bodyStart, bodyEnd).replace(/\r\n/g, "\n").replace(/\n$/, "");
  assert.equal(rowText, PATCH_ROW.text, "install 写的 patch 行形状必须固定");
  const rows = parsePatchRows(rowText);
  assert.deepEqual(rows.map((row) => [row.id, row.indent, row.topLevel]), [["surface-gate", 4, false]]);
  assert.deepEqual(rows[0].fields, { name: "dsh-gate", disabled: "false" });

  // uninstall 的三处判定（hasPatchRow / 摘除循环 / 回读校验）都是顶层形状。
  assert.ok(countOf(uninstall, "^-\\s*id:\\s*surface-gate\\s*$") >= 3, "uninstall 三处判定都写死顶层形状");
  // install 的判定允许缩进。
  assert.ok(countOf(install, "^\\s*-\\s*id:\\s*surface-gate\\s*$") >= 3, "install 判定允许缩进");
  // 两个脚本对「自己写的行」给出相反结论 —— 这就是真缺陷。
  assert.equal(INSTALL_PATCH_PATTERN.test(PATCH_ROW.text), true);
  assert.equal(UNINSTALL_PATCH_PATTERN.test(PATCH_ROW.text), false);
});

test("S5 · 真跑前后 manifest 语义不变：DryRun 不登记 bundles/dependencies", async () => {
  await withHome({}, (home) => {
    const before = home.read(".dsh/profiles/desktop/package.json");
    const bytesBefore = home.readBytes(".dsh/profiles/desktop/package.json");
    const result = runDryRun(home, "install");
    assert.equal(result.status, 0);
    assert.equal(home.read(".dsh/profiles/desktop/package.json"), before);
    assert.deepEqual(Array.from(home.readBytes(".dsh/profiles/desktop/package.json")), Array.from(bytesBefore), "package.json 必须逐字节不变");
    const manifest = JSON.parse(before);
    assert.equal(manifest.dsh.profile.bundles.includes("dsh-gate"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(manifest.dependencies, "dsh-gate"), false);
    assert.equal(home.read(".dsh/profiles/desktop/cordis.patch.yml"), "[]\n");
  });
});

test("S5 · 真跑脚本只认参数传入的 profile（输出指向夹具，不指向真实 profile）", async () => {
  await withHome({ profileName: "fixture-profile" }, (home) => {
    const result = runDryRun(home, "install");
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("profiles\\fixture-profile"), "输出必须指向夹具 profile");
    assert.ok(result.stdout.includes(home.profileDir), "manifest 路径必须是夹具路径");
    assert.equal(result.stdout.includes(path.join(os.homedir(), ".dsh", "profiles", "desktop")), false, "不许出现真实 profile 路径");
  });
});

test("S5 · PowerShell 可用且脚本存在（门禁前提自检）", () => {
  const { shell, version } = powershellVersion();
  assert.ok(shell && version, "必须找得到 PowerShell");
  for (const key of Object.keys(SCRIPTS)) assert.ok(fs.existsSync(SCRIPTS[key]), "脚本必须存在：" + SCRIPTS[key]);
});