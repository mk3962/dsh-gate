<#
  dsh-gate 安装脚本 v0.2.0（Windows PowerShell 5.1 / 7 均可，本文件为 UTF-8 with BOM）

  装法（本地目录插件的官方形态，pnpm 语义实测过）：
    1) 源码放 <DSH home>\local-plugins\dsh-gate（pnpm remove 删不到它）
    2) <profile>\node_modules\dsh-gate 做成 junction 指过去
    3) package.json 同时写：
         dsh.profile.bundles      += "dsh-gate"                          （决定被加载）
         dependencies["dsh-gate"]  = "link:../../local-plugins/dsh-gate"（决定可被管理）
    4) profile 的 cordis.patch.yml 追加 - insert: 块（- id: surface-gate / name: dsh-gate /
       disabled: false），让官方「设置 → 插件」的行级开关也能作用到它。
      顶层只能写 - insert:；裸 - id:/name: 是崩溃陷阱 #3。

  为什么不能只写 bundles：
    宿主判定"已安装"的唯一依据是 profile package.json 的 dependencies
    （dsh-plugin-manager/lib/types/index.js:327  installed = dependencies.includes(name)），
    而前端列表还会把 installed=false && official=false && error=undefined 的行整条丢掉
    （dsh-client-ui-plugin-manager/lib/client.js:3879）。
    只写 bundles 的插件其实在跑，但界面上既没有卡片、也没有启用开关和卸载按钮。

  用法（在仓库根目录）：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -DryRun
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
    ... -Force      # 跳过进程检查（不推荐）
  参数：
    -Profile   目标 profile 目录，默认 ~\.dsh\profiles\desktop
    -GateHome  DSH 用户根（放 gate.json 与 local-plugins），默认由 profile 路径推出
    -Source    插件源码目录，默认自动探测（<脚本目录>\dsh-gate、<脚本目录>、<脚本目录>\..）
    -BackupRoot 备份目录，默认 <GateHome>\backups\dsh-gate
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Force,
  [string]$Profile = "$env:USERPROFILE\.dsh\profiles\desktop",
  [string]$GateHome,
  [string]$Source,
  [string]$BackupRoot
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Join-Path $Profile 'package.json'
$target = Join-Path $Profile 'node_modules\dsh-gate'
$patchFile = Join-Path $Profile 'cordis.patch.yml'
$profileName = Split-Path -Leaf $Profile
$NL = [Environment]::NewLine

# ---- 源码位置：支持两种布局 ----
#   交付包布局： <包>\dsh-gate\{package.json,lib,client,...}   ← 脚本在 <包>\
#   仓库布局：   <repo>\{package.json,lib,client,...}          ← 脚本在 <repo>\scripts\
$candidates = New-Object System.Collections.Generic.List[string]
if ($Source) { $candidates.Add($Source) }
$candidates.Add((Join-Path $here 'dsh-gate'))
$candidates.Add($here)
$candidates.Add((Join-Path $here '..'))
$source = $null
foreach ($candidate in $candidates) {
  $resolved = $null
  try { $resolved = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path } catch { continue }
  $candidateManifest = Join-Path $resolved 'package.json'
  if (-not (Test-Path -LiteralPath $candidateManifest)) { continue }
  try { $candidateDoc = Get-Content -LiteralPath $candidateManifest -Raw | ConvertFrom-Json } catch { continue }
  if ($candidateDoc.name -eq 'dsh-gate') { $source = $resolved; break }
}
if (-not $source) {
  $message = "找不到插件源码目录。试过：" + $NL + "  " + ($candidates -join ($NL + "  "))
  $message += $NL + '请用 -Source <插件目录> 指定（目录里要有 package.json 且 name=dsh-gate）。'
  throw $message
}

if (-not $GateHome) {
  $parent = Split-Path -Parent $Profile
  if ((Split-Path -Leaf $parent) -ieq 'profiles') { $GateHome = Split-Path -Parent $parent } else { $GateHome = Join-Path $env:USERPROFILE '.dsh' }
}
$gateJson = Join-Path $GateHome 'gate.json'
$localRoot = Join-Path $GateHome 'local-plugins'
$sourceDir = Join-Path $localRoot 'dsh-gate'
$stamp = Get-Date -Format 'yyyyMMddTHHmmss'
# 备份落在 DSH 用户根下（不是插件包自己的目录）：插件包分发/升级时不该把备份一起带走。
if ($BackupRoot) {
  $backupDir = $BackupRoot
} else {
  $backupDir = Join-Path $GateHome 'backups\dsh-gate'
}

if (-not (Test-Path $manifest)) { throw "找不到 profile manifest: $manifest" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "PATH 上没有 node（本脚本用 node 往返写 package.json）。请安装 Node >= 20，或按 README 的「方式 B」手工安装。"
}

# 只把运行时需要的文件装进去（不装 test/、docs/、scripts/、node_modules）。
# 这份清单必须与 package.json 的 files 一致：files 里没有的东西（例如 CHANGELOG.md）不进 npm 包，
# 交付包里也就不存在，列进来只会让安装脚本白跑一遍（这里靠下面的 Test-Path 兜底跳过）。
$payload = @('package.json', 'lib', 'client', 'cordis.patch.yml', 'gate.example.json', 'README.md', 'LICENSE')

# ---- 进程检查：只拦"跑这个 profile 的 DSH"，不全局拦 *DeepSeek* ----
# 旧实现 Get-Process -like '*DeepSeek*' 会把用户日常实例也算进来，于是只要用户开着 DSH
# 就永远装不了也卸不了（实测输出「DSH 正在运行（PID 240,4288,8976）」）。
# 判定规则：①命令行带 --profile <name> 开关，或 ②命令行里出现 profiles\<name> 且确实是 DSH 本体
# （app.asar / dsh.cmd / DeepSeek Harness）。这样才不会把"命令行里恰好带着 profile 路径"的
# 调用方（编辑器、shell 包装层）误判成 DSH 在跑。
$flagPattern = '(?i)--profile[=\s]+"?' + [regex]::Escape($profileName) + '"?(\s|$)'
$pathPattern = '(?i)profiles[\\/]' + [regex]::Escape($profileName) + '\b'
$dshPattern = '(?i)(app\.asar|dsh\.cmd|DeepSeek Harness)'
$running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $cl = $_.CommandLine
  if (-not $cl) { return $false }
  if ($cl -match '--type=') { return $false }
  # 排除调用本脚本的那层 shell 自己（命令行里必然带 install.ps1 / uninstall.ps1）
  if ($cl -match '(?i)(install|uninstall)\.ps1') { return $false }
  if ($cl -match $flagPattern) { return $true }
  return (($cl -match $pathPattern) -and ($cl -match $dshPattern))
})
$runningIds = ($running | Select-Object -First 5 -ExpandProperty ProcessId) -join ','

# ---- 依赖写法：相对 profile 目录的 link: ----
# Windows PowerShell 5.1 没有 [System.IO.Path]::GetRelativePath，用 Uri.MakeRelativeUri 自己算。
$backslash = [string][char]92
function Get-RelativeTo([string]$fromDir, [string]$toPath) {
  $from = [System.IO.Path]::GetFullPath($fromDir).TrimEnd($backslash) + $backslash
  $to = [System.IO.Path]::GetFullPath($toPath)
  $uriFrom = New-Object System.Uri($from)
  $uriTo = New-Object System.Uri($to)
  return [System.Uri]::UnescapeDataString($uriFrom.MakeRelativeUri($uriTo).ToString())
}
$depSpec = 'link:' + ((Get-RelativeTo $Profile $sourceDir) -replace '\\', '/')

$doc = Get-Content $manifest -Raw | ConvertFrom-Json
$bundles = @($doc.dsh.profile.bundles)
$hasBundle = $bundles -contains 'dsh-gate'
$hasDep = [bool]($doc.dependencies.PSObject.Properties.Name -contains 'dsh-gate')
$hasDir = Test-Path $target
$hasGate = Test-Path $gateJson
$patchNote = ''
if (Test-Path $patchFile) { $patchNote = ' 与 cordis.patch.yml' }
$hasPatchRow = (Test-Path $patchFile) -and (Select-String -Path $patchFile -Pattern '(?m)^\s*-\s*id:\s*surface-gate\s*$' -Quiet)

Write-Output "插件源码 : $source"
Write-Output "安装位置 : $sourceDir (已存在 = $(Test-Path $sourceDir))"
Write-Output "junction : $target (已存在 = $hasDir)"
Write-Output "manifest : $manifest"
Write-Output "bundles  : $($bundles.Count) 项，dsh-gate 已登记 = $hasBundle"
Write-Output "依赖     : dsh-gate = $depSpec（已登记 = $hasDep）"
Write-Output "策略文件 : $gateJson (已存在 = $hasGate)"
Write-Output "patch 行 : surface-gate 已在 cordis.patch.yml = $hasPatchRow"

if ($DryRun) {
  Write-Output ""
  Write-Output "[dry-run] 将执行："
  Write-Output "  1) 备份 package.json$patchNote -> $backupDir\*.$stamp"
  Write-Output "  2) 复制插件源码（package.json/lib/client/cordis.patch.yml/gate.example.json/README/LICENSE）-> $sourceDir"
  Write-Output "  3) 旧的 node_modules\dsh-gate 移入 $backupDir（junction 则只删链接）"
  Write-Output "  4) 建立 junction：$target -> $sourceDir"
  Write-Output "  5) 若无 gate.json，种入 gate.example.json -> $gateJson"
  Write-Output "  6) package.json：bundles += dsh-gate，dependencies.dsh-gate = $depSpec"
  Write-Output "  7) cordis.patch.yml：追加 - insert: / - id: surface-gate / name: dsh-gate / disabled: false"
  Write-Output "  8) 回读校验：JSON 合法 / 无 BOM / bundles 含 / 依赖含 / junction 存在 / patch 行存在"
  if ($running.Count -gt 0) { Write-Output ""; Write-Output "注意：目标 profile($profileName) 的 DSH 正在运行（PID $runningIds），真装会被拒绝。" }
  exit 0
}

if ($running.Count -gt 0) {
  if (-not $Force) { throw "目标 profile($profileName) 的 DSH 正在运行（PID $runningIds）。请先退出该实例再装（或加 -Force 自行承担风险）。" }
  Write-Output "警告：-Force 跳过了进程检查（PID $runningIds 仍在运行）"
}

New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Copy-Item $manifest (Join-Path $backupDir "package.json.$stamp") -Force
Write-Output "已备份 package.json -> $backupDir\package.json.$stamp"
if (Test-Path $patchFile) {
  Copy-Item $patchFile (Join-Path $backupDir "cordis.patch.yml.$stamp") -Force
  Write-Output "已备份 cordis.patch.yml -> $backupDir\cordis.patch.yml.$stamp"
}

# ---- 1) 源码放到 local-plugins（升级时旧源码进 backup） ----
if (Test-Path $sourceDir) {
  Move-Item $sourceDir (Join-Path $backupDir "dsh-gate.src.old.$stamp") -Force
  Write-Output "旧源码已移到 $backupDir\dsh-gate.src.old.$stamp"
}
New-Item -ItemType Directory -Force -Path $localRoot | Out-Null
New-Item -ItemType Directory -Force -Path $sourceDir | Out-Null
foreach ($item in $payload) {
  $itemPath = Join-Path $source $item
  if (-not (Test-Path -LiteralPath $itemPath)) { continue }
  Copy-Item -LiteralPath $itemPath (Join-Path $sourceDir $item) -Recurse -Force
}
Write-Output "已复制插件源码 -> $sourceDir"

# ---- 2) node_modules 里的旧实体目录/junction 清掉，再建 junction ----
if ($hasDir) {
  $item = Get-Item $target -Force
  if ($item.LinkType) {
    [System.IO.Directory]::Delete($target)
    Write-Output "已移除旧链接 node_modules\dsh-gate（$($item.LinkType)）"
  } else {
    Move-Item $target (Join-Path $backupDir "dsh-gate.old.$stamp") -Force
    Write-Output "旧实体目录已移到 $backupDir\dsh-gate.old.$stamp"
  }
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
New-Item -ItemType Junction -Path $target -Target $sourceDir | Out-Null
Write-Output "已建立 junction -> $sourceDir"

# ---- 3) 种入策略文件 ----
if (-not $hasGate) {
  Copy-Item (Join-Path $source 'gate.example.json') $gateJson -Force
  Write-Output "已种入策略文件 -> $gateJson"
} else { Write-Output "策略文件已存在，保留不动。" }

# ---- 4) package.json：bundles + dependencies（node 往返，避免 ConvertTo-Json 变形） ----
$script = @"
const fs = require("fs");
const file = process.argv[2];
const mode = process.argv[3];
const depSpec = process.argv[4];
const doc = JSON.parse(fs.readFileSync(file, "utf8"));
const p = doc.dsh && doc.dsh.profile;
if (!p || !Array.isArray(p.bundles)) { console.log("FAIL no-bundles"); process.exit(4); }
doc.dependencies = doc.dependencies && typeof doc.dependencies === "object" ? doc.dependencies : {};
if (mode === "add") {
  if (!p.bundles.includes("dsh-gate")) p.bundles.push("dsh-gate");
  doc.dependencies["dsh-gate"] = depSpec;
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
node $scriptFile $manifest add $depSpec
$code = $LASTEXITCODE
Remove-Item $scriptFile -Force -ErrorAction SilentlyContinue
if ($code -ne 0) { throw "写入 package.json 失败（exit $code）" }

# ---- 5) cordis.patch.yml：让行级开关可控 ----
# 宿主先铺 bundles，再叠 profile 的 cordis.patch.yml；行上 disabled: false 才是官方 UI
# "启用组件"开关落盘的位置（bundle 层 disabled 是内存态，boot 会重放）。
# 形状必须与 scripts/check-spec.mjs 的断言一致：顶层行一律写成 - insert:，
# id / name 缩进挂在 insert 下面。裸顶层 - id:/name: 是崩溃陷阱 #3，宿主解析直接炸。
$nl = [string][char]10
$row = @"
- insert:
    - id: surface-gate
      name: dsh-gate
      disabled: false
"@
$utf8 = New-Object System.Text.UTF8Encoding($false)
if (-not (Test-Path $patchFile)) {
  [System.IO.File]::WriteAllText($patchFile, $row + $nl, $utf8)
  Write-Output "已创建 cordis.patch.yml 并写入 surface-gate 行"
} else {
  $text = [System.IO.File]::ReadAllText($patchFile)
  # 旧版本装过裸顶层 "- id: surface-gate"（崩溃陷阱 #3）：先整块摘掉，再按 insert 形状重写，
  # 免得升级后 profile 里留着一条会把宿主解析炸掉的行。
  if ($text -match '(?m)^- id: surface-gate\s*$') {
    $kept = New-Object System.Collections.Generic.List[string]
    $legacySkip = $false
    foreach ($line in ($text -split $nl)) {
      if ($line -match '^- id: surface-gate\s*$') { $legacySkip = $true; continue }
      if ($legacySkip) {
        if ($line -match '^\s+\S') { continue }
        $legacySkip = $false
      }
      $kept.Add($line)
    }
    $text = ($kept -join $nl).TrimEnd($nl) + $nl
    Write-Output "已把旧的裸顶层 surface-gate 行改写成 - insert: 形状"
  }
  $trimmed = $text.Trim()
  if ($trimmed -eq '[]' -or $trimmed -eq '') {
    [System.IO.File]::WriteAllText($patchFile, $row + $nl, $utf8)
    Write-Output "cordis.patch.yml 原为空数组，已写入 surface-gate 行"
  } elseif ($text -match '(?m)^\s*-\s*id:\s*surface-gate\s*$') {
    Write-Output "cordis.patch.yml 已有 surface-gate 行，保留不动"
  } else {
    $sep = ''
    if (-not $text.EndsWith($nl)) { $sep = $nl }
    [System.IO.File]::WriteAllText($patchFile, $text + $sep + $row + $nl, $utf8)
    Write-Output "已向 cordis.patch.yml 追加 surface-gate 行"
  }
}

# ---- 6) 回读校验 ----
$raw = [System.IO.File]::ReadAllBytes($manifest)
if ($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF) { throw "package.json 被写成 BOM，立即用 backup 覆盖回去" }
$verify = Get-Content $manifest -Raw | ConvertFrom-Json
if (-not (@($verify.dsh.profile.bundles) -contains 'dsh-gate')) { throw "回读校验失败：bundles 里没有 dsh-gate" }
$depValue = $verify.dependencies.'dsh-gate'
if (-not $depValue) { throw "回读校验失败：dependencies 里没有 dsh-gate（市场/配置页会看不到它）" }
if (-not (Test-Path $target)) { throw "回读校验失败：node_modules\dsh-gate 不存在" }
$linkItem = Get-Item $target -Force
if (-not $linkItem.LinkType) { throw "回读校验失败：node_modules\dsh-gate 不是链接（$($linkItem.LinkType)）" }
if (-not (Select-String -Path $patchFile -Pattern '(?m)^\s*-\s*id:\s*surface-gate\s*$' -Quiet)) { throw "回读校验失败：cordis.patch.yml 里没有 surface-gate 行" }
$patchBytes = [System.IO.File]::ReadAllBytes($patchFile)
if ($patchBytes.Length -ge 3 -and $patchBytes[0] -eq 0xEF -and $patchBytes[1] -eq 0xBB -and $patchBytes[2] -eq 0xBF) { throw "cordis.patch.yml 被写成 BOM" }

Write-Output "回读校验通过：JSON 合法、无 BOM、bundles 含 dsh-gate（$(@($verify.dsh.profile.bundles).Count) 项）、依赖 $depValue、junction 就位、patch 行就位"

Write-Output ""
Write-Output "装完了。启动该 profile 的 DSH，然后："
Write-Output "  1) 侧栏 插件 -> 已安装 -> 应出现 dsh-gate 卡片（可开关、可卸载、可配置）"
Write-Output "  2) 卡片详情 -> surface-gate 行 -> 配置 = 工具闸门三列面板（常驻/按需/关闭）"
Write-Output "  3) 日志里应有：dsh-gate: 已挂载 agent ... 可见 N，常驻 N，按需 N，隐藏 N"
Write-Output "回滚：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1"
