<#
  dsh-gate 卸载脚本 v0.2.0（Windows PowerShell 5.1 / 7 均可，本文件为 UTF-8 with BOM）

  与 v0.1.1 的 install.ps1 对称，回滚四件事：
    1) package.json：从 dsh.profile.bundles 摘掉 "dsh-gate"，从 dependencies 删掉 "dsh-gate"
    2) node_modules\dsh-gate 的 junction 删掉（只删链接，不碰源码）
    3) 源码目录 <DSH home>\local-plugins\dsh-gate 移到 <DSH home>\backups\dsh-gate\dsh-gate.removed.<stamp>
    4) profile 的 cordis.patch.yml 里只删自己写的那两行（- id: surface-gate / disabled: false）
  不跑 pnpm，不碰 lockfile，不碰别的插件。

  用法（在仓库根目录）：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -DryRun
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1
    ... -Force
  gate.json 默认保留（里面可能有你调好的名单）；要一起清就手动删。
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Force,
  [string]$Profile = "$env:USERPROFILE\.dsh\profiles\desktop",
  [string]$GateHome,
  [string]$BackupRoot
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Join-Path $Profile 'package.json'
$target = Join-Path $Profile 'node_modules\dsh-gate'
$patchFile = Join-Path $Profile 'cordis.patch.yml'
$profileName = Split-Path -Leaf $Profile

if (-not $GateHome) {
  $parent = Split-Path -Parent $Profile
  if ((Split-Path -Leaf $parent) -ieq 'profiles') { $GateHome = Split-Path -Parent $parent } else { $GateHome = Join-Path $env:USERPROFILE '.dsh' }
}
$sourceDir = Join-Path (Join-Path $GateHome 'local-plugins') 'dsh-gate'
$stamp = Get-Date -Format 'yyyyMMddTHHmmss'
# 备份落在 <DSH home>\backups\dsh-gate（与 install.ps1 同口径），不污染插件包目录。
if ($BackupRoot) {
  $backupDir = $BackupRoot
} elseif ($GateHome) {
  $backupDir = Join-Path $GateHome 'backups\dsh-gate'
} else {
  $backupDir = Join-Path $here 'backup'
}

if (-not (Test-Path $manifest)) { throw "找不到 profile manifest: $manifest" }

# 进程检查只看“跑这个 profile 的 DSH”，不再全局拦 *DeepSeek*（同 install.ps1 注释）。
$flagPattern = '(?i)--profile[=\s]+"?' + [regex]::Escape($profileName) + '"?(\s|$)'
$pathPattern = '(?i)profiles[\\/]' + [regex]::Escape($profileName) + '\b'
$dshPattern = '(?i)(app\.asar|dsh\.cmd|DeepSeek Harness)'
$running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $cl = $_.CommandLine
  if (-not $cl) { return $false }
  if ($cl -match '--type=') { return $false }
  if ($cl -match '(?i)(install|uninstall)\.ps1') { return $false }
  if ($cl -match $flagPattern) { return $true }
  return (($cl -match $pathPattern) -and ($cl -match $dshPattern))
})
$runningIds = ($running | Select-Object -First 5 -ExpandProperty ProcessId) -join ','

$doc = Get-Content $manifest -Raw | ConvertFrom-Json
$bundles = @($doc.dsh.profile.bundles)
$hasBundle = $bundles -contains 'dsh-gate'
$hasDep = [bool]($doc.dependencies.PSObject.Properties.Name -contains 'dsh-gate')
$hasDir = Test-Path $target
$hasSource = Test-Path $sourceDir
$hasPatchRow = (Test-Path $patchFile) -and (Select-String -Path $patchFile -Pattern '(?m)^-\s*id:\s*surface-gate\s*$' -Quiet)

Write-Output "manifest : $manifest"
Write-Output "bundles  : $($bundles.Count) 项，dsh-gate 已登记 = $hasBundle"
Write-Output "依赖     : dsh-gate 已登记 = $hasDep"
Write-Output "junction : $target (存在 = $hasDir)"
Write-Output "源码     : $sourceDir (存在 = $hasSource)"
Write-Output "patch 行 : surface-gate 在 cordis.patch.yml = $hasPatchRow"

if ($DryRun) {
  Write-Output ""
  Write-Output "[dry-run] 将执行："
  Write-Output "  1) 备份 package.json（及 cordis.patch.yml 若存在）-> $backupDir\*.$stamp"
  Write-Output "  2) package.json：bundles 摘掉 dsh-gate、dependencies 删掉 dsh-gate"
  Write-Output "  3) 删除 junction $target（只删链接）"
  Write-Output "  4) 源码目录 -> $backupDir\dsh-gate.removed.$stamp"
  Write-Output "  5) cordis.patch.yml 只删自己写的 surface-gate 两行"
  Write-Output "  6) 回读校验：bundles/依赖都不含 dsh-gate、junction 已消失、无 BOM"
  Write-Output "  保留：$GateHome\gate.json（要清请手动删）"
  if ($running.Count -gt 0) { Write-Output ""; Write-Output "注意：目标 profile($profileName) 的 DSH 正在运行（PID $runningIds），真卸会被拒绝。" }
  exit 0
}

if ($running.Count -gt 0) {
  if (-not $Force) { throw "目标 profile($profileName) 的 DSH 正在运行（PID $runningIds）。请先退出该实例再卸（或加 -Force 自行承担风险）。" }
  Write-Output "警告：-Force 跳过了进程检查（PID $runningIds 仍在运行）"
}

New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Copy-Item $manifest (Join-Path $backupDir "package.json.$stamp") -Force
Write-Output "已备份 package.json -> $backupDir\package.json.$stamp"
if (Test-Path $patchFile) {
  Copy-Item $patchFile (Join-Path $backupDir "cordis.patch.yml.$stamp") -Force
  Write-Output "已备份 cordis.patch.yml -> $backupDir\cordis.patch.yml.$stamp"
}

# ---- 1) package.json ----
$script = @"
const fs = require("fs");
const file = process.argv[2];
const mode = process.argv[3];
const doc = JSON.parse(fs.readFileSync(file, "utf8"));
const p = doc.dsh && doc.dsh.profile;
if (!p || !Array.isArray(p.bundles)) { console.log("FAIL no-bundles"); process.exit(4); }
doc.dependencies = doc.dependencies && typeof doc.dependencies === "object" ? doc.dependencies : {};
if (mode === "add") {
  if (!p.bundles.includes("dsh-gate")) p.bundles.push("dsh-gate");
  doc.dependencies["dsh-gate"] = process.argv[4];
} else {
  p.bundles = p.bundles.filter(function (b) { return b !== "dsh-gate"; });
  delete doc.dependencies["dsh-gate"];
}
const out = JSON.stringify(doc, null, 2) + "\n";
JSON.parse(out);
fs.writeFileSync(file, Buffer.from(out, "utf8"));
console.log("OK bundles=" + p.bundles.length + " hasBundle=" + p.bundles.includes("dsh-gate") + " dep=" + (doc.dependencies["dsh-gate"] || "-"));
"@
$scriptFile = Join-Path $env:TEMP ("dsh-gate-manifest-" + $stamp + ".cjs")
Set-Content -Path $scriptFile -Value $script -Encoding ASCII
node $scriptFile $manifest remove
$code = $LASTEXITCODE
Remove-Item $scriptFile -Force -ErrorAction SilentlyContinue
if ($code -ne 0) { throw "写入 package.json 失败（exit $code）" }

# ---- 2) junction ----
if ($hasDir) {
  $item = Get-Item $target -Force
  if ($item.LinkType) {
    [System.IO.Directory]::Delete($target)
    Write-Output "已删除 junction node_modules\dsh-gate（源码未动）"
  } else {
    Move-Item $target (Join-Path $backupDir "dsh-gate.removed.$stamp") -Force
    Write-Output "实体目录已移到 $backupDir\dsh-gate.removed.$stamp"
  }
} else { Write-Output "node_modules\dsh-gate 不存在，跳过" }

# ---- 3) 源码目录：别的 profile 还在用就保留 ----
# 源码在 <DSH home>\local-plugins 是同一 home 下所有 profile 共用的。
# 实测踩过：先在一个副 profile 上卸载，共享源码被搬走，主 profile 的 junction 直接悬空。
$otherUsers = @()
$profilesRoot = Join-Path $GateHome 'profiles'
if (Test-Path $profilesRoot) {
  $selfPath = [System.IO.Path]::GetFullPath($Profile).TrimEnd([char]92, [char]47)
  foreach ($dir in @(Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue)) {
    $dirPath = [System.IO.Path]::GetFullPath($dir.FullName).TrimEnd([char]92, [char]47)
    if ($dirPath -ieq $selfPath) { continue }
    $otherManifest = Join-Path $dirPath 'package.json'
    if (-not (Test-Path $otherManifest)) { continue }
    $depHit = $false; $bundleHit = $false
    try {
      $otherDoc = Get-Content $otherManifest -Raw | ConvertFrom-Json
      $depHit = [bool]$otherDoc.dependencies.'dsh-gate'
      $bundleHit = (@($otherDoc.dsh.profile.bundles) -contains 'dsh-gate')
    } catch { }
    if ($depHit -or $bundleHit -or (Test-Path (Join-Path $dirPath 'node_modules\dsh-gate'))) { $otherUsers += $dir.Name }
  }
}
if ($hasSource) {
  if ($otherUsers.Count -gt 0) {
    Write-Output ("源码目录仍被其它 profile 使用（" + ($otherUsers -join ', ') + "），保留不搬：" + $sourceDir)
  } else {
    Move-Item $sourceDir (Join-Path $backupDir "dsh-gate.removed.$stamp") -Force
    Write-Output "源码已移到 $backupDir\dsh-gate.removed.$stamp"
  }
} else { Write-Output "源码目录不存在，跳过" }

# ---- 4) cordis.patch.yml：只删自己写的块 ----
if ($hasPatchRow) {
  $nl = [string][char]10
  $lines = [System.IO.File]::ReadAllText($patchFile) -split $nl
  $kept = New-Object System.Collections.Generic.List[string]
  $skipping = $false
  foreach ($line in $lines) {
    if ($line -match '^-\s*id:\s*surface-gate\s*$') { $skipping = $true; continue }
    if ($skipping) {
      if ($line -match '^\s+\S') { continue }
      $skipping = $false
    }
    $kept.Add($line)
  }
  $outText = ($kept -join $nl).TrimEnd($nl)
  if ($outText.Trim() -eq '') { $outText = '[]' }
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($patchFile, $outText + $nl, $utf8)
  Write-Output "已从 cordis.patch.yml 删除 surface-gate 行"
} else { Write-Output "cordis.patch.yml 没有 surface-gate 行，跳过" }

# ---- 5) 回读校验 ----
$raw = [System.IO.File]::ReadAllBytes($manifest)
if ($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF) { throw "package.json 被写成 BOM，立即用 backup 覆盖回去" }
$verify = Get-Content $manifest -Raw | ConvertFrom-Json
if (@($verify.dsh.profile.bundles) -contains 'dsh-gate') { throw "回读校验失败：bundles 里还有 dsh-gate" }
if ($verify.dependencies.PSObject.Properties.Name -contains 'dsh-gate') { throw "回读校验失败：dependencies 里还有 dsh-gate" }
if (Test-Path $target) { throw "回读校验失败：node_modules\dsh-gate 还存在" }
if ((Test-Path $patchFile) -and (Select-String -Path $patchFile -Pattern '(?m)^-\s*id:\s*surface-gate\s*$' -Quiet)) { throw "回读校验失败：cordis.patch.yml 里还有 surface-gate 行" }

Write-Output "回读校验通过：bundles/依赖都不含 dsh-gate、junction 已消失、无 BOM、patch 行已清"
Write-Output ""
Write-Output "卸完了。重启该 profile 的 DSH 后："
Write-Output "  1) 侧栏 插件 -> 已安装 -> dsh-gate 卡片消失"
Write-Output "  2) 工具表恢复全量（不再有 <gate-catalog>，gate_* 工具不存在）"
Write-Output "保留：$GateHome\gate.json（名单），备份在 $backupDir\*.$stamp"
