<#
  dsh-gate-deploy.psm1 —— 部署脚本唯一公共模块（G89 / D21）

  install.ps1 / uninstall.ps1 / activate.cmd / rollback.cmd 只保留参数与输出；
  进程检测、DSH home 与 profile 路径解析、manifest 改写、patch 行匹配与写入、
  YAML 结构校验、备份与保留清理、无 BOM 写入断言、事务与失败逆操作回滚
  全部在这里，只有一份实现。兼容 Windows PowerShell 5.1 与 PowerShell 7+。

  口径（与工单 #08 / spec D21 对齐）：
    - patch 行匹配：唯一模式 PatchRowPattern，允许行首任意空白，安装/卸载/回读共用。
    - 安装事务：预检 -> 复制到暂存 -> 校验 -> 交换 -> 写 patch 与种子 -> 回读校验。
    - 旧源码只在新内容复制并校验通过后移入备份；任一步失败按日志逆序回滚。
    - 备份命名 种类.时间戳[.序号]，每种类保留 KeepBackups 份（默认 3），清理最旧。
    - DSH home：显式参数 -> 环境变量 DSH_HOME -> profile 推导 -> 用户目录。
    - 进程检测不可用时默认拒绝写操作（除非显式 -Force）。
#>

$script:PluginName = 'dsh-gate'
$script:PatchRowId = 'surface-gate'
$script:LF = [string][char]10
$script:CRLF = [string][char]13 + [string][char]10
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# 唯一模式：允许行首任意空白缩进，整行锚定插件行名（容忍行尾注释）。
# 安装判定、卸载摘除、回读校验三处共用这一条；历史版本写坏的顶层裸行同样命中。
$script:PatchRowPattern = '^\s*-\s*id:\s*surface-gate\s*(?:#.*)?$'

# install 写入的行形状：顶层 - insert:，id/name/disabled 缩进挂在下面。
$script:PatchRowText = @(
  '- insert:',
  '    - id: surface-gate',
  '      name: dsh-gate',
  '      disabled: false'
) -join $script:LF

$script:DefaultPayload = @('package.json', 'lib', 'client', 'cordis.patch.yml', 'gate.example.json', 'README.md', 'LICENSE')

# package.json 往返改写走 node：ConvertTo-Json 会重排键并改写缩进，装与卸就回不到原字节。
$script:ManifestScript = @'
const fs = require("fs");
const file = process.argv[2];
const mode = String(process.argv[3] || "").toLowerCase();
const depSpecRaw = process.argv[4];
const depSpec = depSpecRaw;
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
'@

# ---------------------------------------------------------------------------
# 通用小件
# ---------------------------------------------------------------------------

function New-GateError {
  param([string]$Code, [string]$Message, [int]$ExitCode = 1)
  $errorRecord = New-Object System.Exception($Message)
  $errorRecord.Data['GateCode'] = $Code
  $errorRecord.Data['GateExitCode'] = $ExitCode
  return $errorRecord
}

function Get-GateExitCode {
  param($ErrorRecord)
  $code = 1
  if ($ErrorRecord -and $ErrorRecord.Exception -and $ErrorRecord.Exception.Data -and $ErrorRecord.Exception.Data['GateExitCode']) {
    $code = [int]$ErrorRecord.Exception.Data['GateExitCode']
  }
  return $code
}

function Get-GateIndent {
  param([string]$Line)
  $match = [regex]::Match([string]$Line, '^\s*')
  return $match.Value.Length
}

function Test-GateCommentLine {
  param([string]$Line)
  return ([string]$Line).TrimStart().StartsWith('#')
}

function Format-GateBytes {
  param([double]$Bytes)
  if ($Bytes -ge 1073741824) { return ('{0:N1} GB' -f ($Bytes / 1073741824)) }
  if ($Bytes -ge 1048576) { return ('{0:N1} MB' -f ($Bytes / 1048576)) }
  if ($Bytes -ge 1024) { return ('{0:N1} KB' -f ($Bytes / 1024)) }
  return ('{0} B' -f [int]$Bytes)
}

function Get-GatePathSize {
  param([string]$Path)
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return [long]0 }
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer) { return [long]$item.Length }
  $total = [long]0
  foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction SilentlyContinue)) {
    if (-not $child.PSIsContainer) { $total += [long]$child.Length }
  }
  return $total
}

function Test-GateFaultPoint {
  param([string]$Step)
  $spec = $env:DSH_GATE_TEST_FAIL_STEP
  if (-not $spec) { return }
  foreach ($token in ([string]$spec -split ',')) {
    if ($token.Trim() -ieq $Step) {
      throw (New-GateError ('TEST-FAULT-' + $Step) ('测试注入故障：步骤 ' + $Step + '（DSH_GATE_TEST_FAIL_STEP）') 90)
    }
  }
}

# ---------------------------------------------------------------------------
# 无 BOM 写入与断言
# ---------------------------------------------------------------------------

function Assert-GateNoBom {
  param([string]$Path, [string]$Label)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    throw (New-GateError 'BOM-FOUND' ($Label + ' 带 BOM（' + $Path + '）：DSH 解析会失败') 8)
  }
}

function Write-GateTextNoBom {
  param([string]$Path, [string]$Text)
  $parent = Split-Path -Parent $Path
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  [System.IO.File]::WriteAllText($Path, $Text, $script:Utf8NoBom)
}

# ---------------------------------------------------------------------------
# DSH home 与 profile 路径解析（G87）
# ---------------------------------------------------------------------------

function Resolve-GateHome {
  param([string]$Profile, [string]$GateHome, [string]$BackupRoot, [string]$UserRoot)
  $warnings = New-Object System.Collections.Generic.List[string]
  $userHome = $UserRoot
  if (-not $userHome) { $userHome = $env:USERPROFILE }
  if (-not $userHome) { $userHome = $env:HOME }
  if (-not $userHome) { $userHome = [System.Environment]::GetFolderPath('UserProfile') }
  if (-not $userHome) { $userHome = (Get-Location).Path }

  $envHome = $env:DSH_HOME
  if ($Profile) {
    $profilePath = [System.IO.Path]::GetFullPath($Profile)
    $profileSource = 'parameter'
  } elseif ($envHome) {
    $profilePath = [System.IO.Path]::GetFullPath((Join-Path $envHome 'profiles\desktop'))
    $profileSource = 'env'
  } else {
    $profilePath = [System.IO.Path]::GetFullPath((Join-Path $userHome '.dsh\profiles\desktop'))
    $profileSource = 'user'
  }

  # profile 推导：<home>\profiles\<name>
  $derivedHome = $null
  $profileParent = Split-Path -Parent $profilePath
  if ($profileParent -and ((Split-Path -Leaf $profileParent) -ieq 'profiles')) {
    $derivedHome = Split-Path -Parent $profileParent
  }

  if ($GateHome) {
    $gateHomePath = [System.IO.Path]::GetFullPath($GateHome)
    $gateSource = 'parameter'
  } elseif ($envHome) {
    $gateHomePath = [System.IO.Path]::GetFullPath($envHome)
    $gateSource = 'env'
  } elseif ($derivedHome) {
    $gateHomePath = [System.IO.Path]::GetFullPath($derivedHome)
    $gateSource = 'profile'
  } else {
    $gateHomePath = [System.IO.Path]::GetFullPath((Join-Path $userHome '.dsh'))
    $gateSource = 'user'
  }

  $sourceLabel = @{
    'parameter' = '显式参数'
    'env' = '环境变量 DSH_HOME'
    'profile' = 'profile 路径推导'
    'user' = '用户目录 ~/.dsh'
  }

  if ($envHome) {
    $envHomePath = [System.IO.Path]::GetFullPath($envHome)
    if ($envHomePath -ine $gateHomePath) {
      $warnings.Add('DSH_HOME=' + $envHomePath + ' 与本次 DSH home=' + $gateHomePath + ' 不一致：策略种子会种到 ' + $gateHomePath + '，而运行时按 DSH_HOME 读 ' + $envHomePath + '（本次来源：' + $sourceLabel[$gateSource] + '）。') | Out-Null
    }
  }
  if ($derivedHome -and $gateSource -ne 'parameter') {
    $derivedFull = [System.IO.Path]::GetFullPath($derivedHome)
    if ($derivedFull -ine $gateHomePath) {
      $warnings.Add('profile 推导出的 DSH home=' + $derivedFull + ' 与本次采用的 ' + $gateHomePath + ' 不一致（来源：' + $sourceLabel[$gateSource] + '）。') | Out-Null
    }
  }

  if ($BackupRoot) {
    $backupPath = [System.IO.Path]::GetFullPath($BackupRoot)
  } else {
    $backupPath = [System.IO.Path]::GetFullPath((Join-Path $gateHomePath 'backups\dsh-gate'))
  }

  return [pscustomobject]@{
    Profile = $profilePath
    ProfileSource = $profileSource
    GateHome = $gateHomePath
    GateSource = $gateSource
    GateSourceLabel = $sourceLabel[$gateSource]
    BackupRoot = $backupPath
    UserRoot = $userHome
    EnvHome = $envHome
    Warnings = $warnings.ToArray()
  }
}

function New-GateContext {
  param([string]$Profile, [string]$GateHome, [string]$BackupRoot, [int]$KeepBackups = 3, [string]$UserRoot)
  $resolved = Resolve-GateHome -Profile $Profile -GateHome $GateHome -BackupRoot $BackupRoot -UserRoot $UserRoot
  $profileDir = $resolved.Profile
  # G87：策略种子必须种到**运行时真的会读**的目录。
  # 运行时口径是 DSH_HOME || ~/.dsh；脚本安装位置由 -GateHome 决定，两者可能不同。
  $seedHome = $resolved.GateHome
  if ($resolved.EnvHome) { $seedHome = $resolved.EnvHome }
  return [pscustomobject]@{
    Profile = $profileDir
    ProfileDir = $profileDir
    ProfileName = (Split-Path -Leaf $profileDir)
    ProfileSource = $resolved.ProfileSource
    GateHome = $resolved.GateHome
    GateSource = $resolved.GateSource
    GateSourceLabel = $resolved.GateSourceLabel
    BackupRoot = $resolved.BackupRoot
    ManifestPath = (Join-Path $profileDir 'package.json')
    PatchPath = (Join-Path $profileDir 'cordis.patch.yml')
    TargetPath = (Join-Path $profileDir 'node_modules\dsh-gate')
    SourceDir = (Join-Path (Join-Path $resolved.GateHome 'local-plugins') 'dsh-gate')
    LocalRoot = (Join-Path $resolved.GateHome 'local-plugins')
    GateJsonPath = (Join-Path $seedHome 'gate.json')
    SeedHome = $seedHome
    SeedHomeIsRuntime = [bool]$resolved.EnvHome
    KeepBackups = $KeepBackups
    Warnings = @($resolved.Warnings)
    EnvHome = $resolved.EnvHome
    Source = ''
  }
}

function Resolve-GateSource {
  param([string]$Source, [string]$ScriptRoot)
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($Source) { $candidates.Add($Source) }
  if ($ScriptRoot) {
    $candidates.Add((Join-Path $ScriptRoot 'dsh-gate'))
    $candidates.Add($ScriptRoot)
    $candidates.Add((Join-Path $ScriptRoot '..'))
  }
  foreach ($candidate in $candidates) {
    $resolved = $null
    try { $resolved = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path } catch { continue }
    $manifest = Join-Path $resolved 'package.json'
    if (-not (Test-Path -LiteralPath $manifest)) { continue }
    try { $doc = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json } catch { continue }
    if ($doc.name -eq $script:PluginName) { return $resolved }
  }
  $message = '找不到插件源码目录。试过：' + $script:LF + '  ' + ($candidates -join ($script:LF + '  '))
  $message += $script:LF + '请用 -Source <插件目录> 指定（目录里要有 package.json 且 name=dsh-gate）。'
  throw (New-GateError 'SOURCE-NOT-FOUND' $message 2)
}

function Get-GateDependencySpec {
  param([string]$Profile, [string]$SourceDir)
  $backslash = [string][char]92
  $from = [System.IO.Path]::GetFullPath($Profile).TrimEnd($backslash) + $backslash
  $to = [System.IO.Path]::GetFullPath($SourceDir)
  $uriFrom = New-Object System.Uri($from)
  $uriTo = New-Object System.Uri($to)
  $relative = [System.Uri]::UnescapeDataString($uriFrom.MakeRelativeUri($uriTo).ToString())
  return 'link:' + ($relative -replace '\\', '/')
}

# ---------------------------------------------------------------------------
# 进程检测（G88）
# ---------------------------------------------------------------------------

function Get-GateProcessProbe {
  param([string]$ProfileName, [string]$ProfileDir, [string]$GateHome, [string]$TestProbe)
  if ($TestProbe) {
    switch ($TestProbe.ToLowerInvariant()) {
      'none' { return [pscustomobject]@{ Available = $true; Running = @(); Reason = '' } }
      'unavailable' { return [pscustomobject]@{ Available = $false; Running = @(); Reason = '测试注入：进程检测不可用' } }
      'running' {
        $fake = [pscustomobject]@{ ProcessId = 4242; CommandLine = 'injected --profile ' + $ProfileName }
        return [pscustomobject]@{ Available = $true; Running = @($fake); Reason = '测试注入' }
      }
      default { }
    }
  }
  try {
    $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
  } catch {
    return [pscustomobject]@{ Available = $false; Running = @(); Reason = ('Win32_Process 查询失败：' + $_.Exception.Message) }
  }
  if ($processes.Count -eq 0) {
    return [pscustomobject]@{ Available = $false; Running = @(); Reason = 'Win32_Process 返回空集合，无法判定' }
  }
  $readable = @($processes | Where-Object { $_.CommandLine })
  if ($readable.Count -eq 0) {
    return [pscustomobject]@{ Available = $false; Running = @(); Reason = '所有进程的 CommandLine 都不可读（权限不足或非 Windows）' }
  }
  $flagPattern = '(?i)--profile[=\s]+"?' + [regex]::Escape($ProfileName) + '"?(\s|$)'

  # 假 HOME / 自定义 GateHome 上不能只凭 --profile <名字> 判定：
  # 用户日常实例同样可能用同一个名字（真实 ~/.dsh/profiles/desktop），只按名字会把夹具判成在运行。
  # 规则：① 命令行里出现本次 profile 的完整路径 -> 在跑；② 只有 --profile 名字、且本次 GateHome
  # 就是运行时默认 home（DSH_HOME 或 ~/.dsh）-> 才按名字判定；③ 其它名字匹配一律不信。
  $defaultHome = $env:DSH_HOME
  if (-not $defaultHome) {
    $userHomePath = $env:USERPROFILE
    if (-not $userHomePath) { $userHomePath = $env:HOME }
    if ($userHomePath) { $defaultHome = Join-Path $userHomePath '.dsh' }
  }
  $trustNameOnly = $false
  if ($GateHome -and $defaultHome) {
    try { $trustNameOnly = ([System.IO.Path]::GetFullPath($GateHome) -ieq [System.IO.Path]::GetFullPath($defaultHome)) } catch { $trustNameOnly = $false }
  }
  $profileFull = ''
  if ($ProfileDir) {
    try { $profileFull = [System.IO.Path]::GetFullPath($ProfileDir).ToLowerInvariant() } catch { $profileFull = '' }
  }
  $running = @()
  foreach ($proc in $readable) {
    $cl = [string]$proc.CommandLine
    if ($cl -match '--type=') { continue }
    if ($cl -match '(?i)(install|uninstall)\.ps1') { continue }
    if ($profileFull -and $cl.ToLowerInvariant().Contains($profileFull)) { $running += $proc; continue }
    if ($trustNameOnly -and ($cl -match $flagPattern)) { $running += $proc; continue }
  }
  return [pscustomobject]@{ Available = $true; Running = $running; Reason = '' }
}

function Assert-GateProcessGate {
  param([string]$ProfileName, [string]$ProfileDir, [string]$GateHome, [switch]$Force, [string]$TestProbe)
  $probe = Get-GateProcessProbe -ProfileName $ProfileName -ProfileDir $ProfileDir -GateHome $GateHome -TestProbe $TestProbe
  $ids = (@($probe.Running) | ForEach-Object { $_.ProcessId }) -join ','
  if (-not $probe.Available) {
    if (-not $Force) {
      throw (New-GateError 'PROCESS-UNKNOWN' ('无法判定目标 profile(' + $ProfileName + ') 是否在运行：' + $probe.Reason + '。' + $script:LF + '默认拒绝写操作；确认该实例已关闭后加 -Force 重试。') 10)
    }
    return [pscustomobject]@{ Running = $false; Forced = $true; Ids = ''; Warning = ('进程检测不可用（' + $probe.Reason + '），已按 -Force 继续：写 profile 期间实例若在运行，宿主缓存可能与磁盘不一致。') }
  }
  if ($probe.Running.Count -gt 0) {
    if (-not $Force) {
      throw (New-GateError 'PROCESS-RUNNING' ('目标 profile(' + $ProfileName + ') 的 DSH 正在运行（PID ' + $ids + '）。请先退出该实例（或加 -Force 自行承担风险）。') 10)
    }
    return [pscustomobject]@{ Running = $true; Forced = $true; Ids = $ids; Warning = ('-Force 跳过了进程检查（PID ' + $ids + ' 仍在运行）') }
  }
  return [pscustomobject]@{ Running = $false; Forced = $false; Ids = ''; Warning = '' }
}

# ---------------------------------------------------------------------------
# patch 行：唯一模式 + 缩进感知块扫描 + 结构校验（G80 / G85）
# ---------------------------------------------------------------------------

function Split-GateLines {
  param([string]$Text)
  $raw = [string]$Text
  $nl = $script:LF
  if ($raw.Contains($script:CRLF)) { $nl = $script:CRLF }
  $finalNewline = $raw.EndsWith($script:LF)
  $parts = @([regex]::Split($raw, '\r?\n'))
  if ($finalNewline -and $parts.Count -gt 0 -and $parts[$parts.Count - 1] -eq '') {
    if ($parts.Count -eq 1) { $parts = @() } else { $parts = $parts[0..($parts.Count - 2)] }
  }
  return [pscustomobject]@{ Lines = $parts; Nl = $nl; FinalNewline = $finalNewline }
}

function Test-GatePatchRowPresent {
  param([string]$Text)
  if (-not $Text) { return $false }
  return [regex]::IsMatch([string]$Text, $script:PatchRowPattern, [System.Text.RegularExpressions.RegexOptions]::Multiline)
}

function Get-GatePatchRowSpans {
  param([string[]]$Lines, [string]$Pattern)
  $spans = New-Object System.Collections.Generic.List[object]
  $index = 0
  while ($index -lt $Lines.Count) {
    if (-not ($Lines[$index] -cmatch $Pattern)) { $index++; continue }
    $indent = Get-GateIndent -Line $Lines[$index]
    $end = $index
    $cursor = $index + 1
    while ($cursor -lt $Lines.Count) {
      $line = $Lines[$cursor]
      if ($line.Trim() -eq '') { $cursor++; continue }
      if (Test-GateCommentLine -Line $line) {
        if ((Get-GateIndent -Line $line) -gt $indent) { $end = $cursor; $cursor++; continue }
        $look = $cursor + 1
        while ($look -lt $Lines.Count -and ($Lines[$look].Trim() -eq '' -or (Test-GateCommentLine -Line $Lines[$look]))) { $look++ }
        if ($look -lt $Lines.Count -and (Get-GateIndent -Line $Lines[$look]) -gt $indent) { $end = $cursor; $cursor++; continue }
        break
      }
      if ((Get-GateIndent -Line $line) -gt $indent) { $end = $cursor; $cursor++; continue }
      break
    }
    $spans.Add([pscustomobject]@{ Start = $index; End = $end; Indent = $indent }) | Out-Null
    $index = $end + 1
  }
  return $spans
}

function Find-GateInsertParent {
  param([string[]]$Lines, [int]$Index, [int]$Indent)
  for ($cursor = $Index - 1; $cursor -ge 0; $cursor--) {
    $line = $Lines[$cursor]
    if ($line.Trim() -eq '') { continue }
    if (Test-GateCommentLine -Line $line) { continue }
    if (($line -cmatch '^\s*-\s*insert:\s*$') -and ((Get-GateIndent -Line $line) -lt $Indent)) { return $cursor }
    return -1
  }
  return -1
}

function Test-GateBlockHasChild {
  param([string[]]$Lines, $Drop, [int]$ParentIndex)
  $parentIndent = Get-GateIndent -Line $Lines[$ParentIndex]
  for ($cursor = $ParentIndex + 1; $cursor -lt $Lines.Count; $cursor++) {
    if ($Drop.Contains($cursor)) { continue }
    $line = $Lines[$cursor]
    if ($line.Trim() -eq '') { continue }
    $indent = Get-GateIndent -Line $line
    if ($indent -le $parentIndent) { return $false }
    if (Test-GateCommentLine -Line $line) { continue }
    return $true
  }
  return $false
}

function Add-GatePatchText {
  param([string]$Text, [string]$RowText = $script:PatchRowText)
  $current = [string]$Text
  if (Test-GatePatchRowPresent -Text $current) {
    return [pscustomobject]@{ Text = $current; Changed = $false; Reason = 'already-present'; Added = 0 }
  }
  $nl = $script:LF
  if ($current.Contains($script:CRLF)) { $nl = $script:CRLF }
  $row = $RowText
  if ($nl -eq $script:CRLF) { $row = $RowText.Replace($script:LF, $script:CRLF) }
  $trimmed = $current.Trim()
  if ($trimmed -eq '' -or $trimmed -eq '[]') {
    return [pscustomobject]@{ Text = ($row + $nl); Changed = $true; Reason = 'empty-array'; Added = 1 }
  }
  $separator = ''
  if (-not $current.EndsWith($script:LF)) { $separator = $nl }
  return [pscustomobject]@{ Text = ($current + $separator + $row + $nl); Changed = $true; Reason = 'appended'; Added = 1 }
}

function Remove-GatePatchText {
  param([string]$Text)
  $current = [string]$Text
  $split = Split-GateLines -Text $current
  $lines = @($split.Lines)
  $spans = @(Get-GatePatchRowSpans -Lines $lines -Pattern $script:PatchRowPattern)
  if ($spans.Count -eq 0) {
    return [pscustomobject]@{ Text = $current; Changed = $false; Removed = 0; Pruned = 0 }
  }
  $drop = New-Object System.Collections.Generic.HashSet[int]
  $parents = New-Object System.Collections.Generic.List[int]
  foreach ($span in $spans) {
    for ($cursor = $span.Start; $cursor -le $span.End; $cursor++) { [void]$drop.Add($cursor) }
    if ($span.Indent -gt 0) {
      $parent = Find-GateInsertParent -Lines $lines -Index $span.Start -Indent $span.Indent
      if ($parent -ge 0 -and -not $parents.Contains($parent)) { $parents.Add($parent) }
    }
  }
  $pruned = 0
  foreach ($parent in $parents) {
    if (-not (Test-GateBlockHasChild -Lines $lines -Drop $drop -ParentIndex $parent)) {
      [void]$drop.Add($parent)
      $pruned++
    }
  }
  $kept = New-Object System.Collections.Generic.List[string]
  for ($cursor = 0; $cursor -lt $lines.Count; $cursor++) {
    if (-not $drop.Contains($cursor)) { $kept.Add($lines[$cursor]) }
  }
  $outText = ($kept -join $split.Nl)
  if ($split.FinalNewline -and $kept.Count -gt 0) { $outText += $split.Nl }
  if ($kept.Count -eq 0 -or $outText.Trim() -eq '') { $outText = '[]' + $split.Nl }
  return [pscustomobject]@{ Text = $outText; Changed = $true; Removed = $spans.Count; Pruned = $pruned }
}

function Convert-GateLegacyPatch {
  param([string]$Text)
  $current = [string]$Text
  $split = Split-GateLines -Text $current
  $lines = @($split.Lines)
  $spans = @(Get-GatePatchRowSpans -Lines $lines -Pattern $script:PatchRowPattern)
  $legacy = @($spans | Where-Object { $_.Indent -eq 0 })
  if ($legacy.Count -eq 0) {
    return [pscustomobject]@{ Text = $current; Changed = $false; Migrated = 0 }
  }
  $drop = New-Object System.Collections.Generic.HashSet[int]
  foreach ($span in $legacy) {
    for ($cursor = $span.Start; $cursor -le $span.End; $cursor++) { [void]$drop.Add($cursor) }
  }
  $kept = New-Object System.Collections.Generic.List[string]
  for ($cursor = 0; $cursor -lt $lines.Count; $cursor++) {
    if (-not $drop.Contains($cursor)) { $kept.Add($lines[$cursor]) }
  }
  $outText = ($kept -join $split.Nl)
  if ($split.FinalNewline -and $kept.Count -gt 0) { $outText += $split.Nl }
  if ($outText.Trim() -eq '') { $outText = '[]' + $split.Nl }
  return [pscustomobject]@{ Text = $outText; Changed = $true; Migrated = $legacy.Count }
}

function Test-GatePatchStructure {
  param([string]$Text)
  $problems = New-Object System.Collections.Generic.List[string]
  $split = Split-GateLines -Text ([string]$Text)
  $lines = @($split.Lines)
  if ($lines.Count -eq 0) { return [pscustomobject]@{ Ok = $true; Problems = @() } }
  if (($lines -join $script:LF).Trim() -eq '[]') { return [pscustomobject]@{ Ok = $true; Problems = @() } }

  $inInsert = $false
  $currentId = $null
  $currentHasName = $false
  $seenIds = @{}
  for ($index = 0; $index -lt $lines.Count; $index++) {
    $line = $lines[$index]
    $trim = $line.Trim()
    if ($trim -eq '' -or $trim.StartsWith('#')) { continue }
    $indent = Get-GateIndent -Line $line
    if ($indent -eq 0) {
      if ($currentId -and -not $currentHasName) { $problems.Add('第 ' + ($index + 1) + ' 行：id=' + $currentId + ' 缺少 name') | Out-Null }
      $currentId = $null
      $currentHasName = $false
      if ($line -cmatch '^-\s*insert:\s*$') { $inInsert = $true; continue }
      $problems.Add('第 ' + ($index + 1) + ' 行：顶层只允许 - insert:，实际 ' + $line) | Out-Null
      $inInsert = $false
      continue
    }
    if (-not $inInsert) {
      $problems.Add('第 ' + ($index + 1) + ' 行：缩进行不在任何 - insert: 块内') | Out-Null
      continue
    }
    if ($line -cmatch '^\s+-\s*id:\s*(\S+)\s*$') {
      if ($currentId -and -not $currentHasName) { $problems.Add('第 ' + ($index + 1) + ' 行：id=' + $currentId + ' 缺少 name') | Out-Null }
      $currentId = $Matches[1]
      $currentHasName = $false
      if ($seenIds.ContainsKey($currentId)) { $problems.Add('第 ' + ($index + 1) + ' 行：id 重复 ' + $currentId) | Out-Null } else { $seenIds[$currentId] = $true }
      continue
    }
    if ($line -cmatch '^\s+name:\s*(\S+)') { $currentHasName = $true; continue }
    if ($line -cmatch '^\s+[A-Za-z0-9_-]+:') { continue }
    if ($line -cmatch '^\s+-') { $problems.Add('第 ' + ($index + 1) + ' 行：insert 块里出现非 id 序列项') | Out-Null; continue }
    $problems.Add('第 ' + ($index + 1) + ' 行：无法识别的缩进行 ' + $line) | Out-Null
  }
  if ($currentId -and -not $currentHasName) { $problems.Add('末尾 id=' + $currentId + ' 缺少 name') | Out-Null }
  return [pscustomobject]@{ Ok = ($problems.Count -eq 0); Problems = $problems.ToArray() }
}

function Set-GatePatchText {
  param([string]$Text, [ValidateSet('Add', 'Remove')][string]$Action)
  $result = $null
  if ($Action -eq 'Add') { $result = Add-GatePatchText -Text $Text } else { $result = Remove-GatePatchText -Text $Text }
  if (-not $result.Changed) { return $result }
  $structure = Test-GatePatchStructure -Text $result.Text
  if (-not $structure.Ok) {
    throw (New-GateError 'PATCH-YAML' ('写入前 YAML 结构校验失败：' + ($structure.Problems -join '；')) 7)
  }
  return $result
}

# ---------------------------------------------------------------------------
# 备份与保留（G83）
# ---------------------------------------------------------------------------

function Get-GateBackupStamp {
  param([string]$Stamp)
  if ($Stamp) { return [string]$Stamp }
  return (Get-Date -Format 'yyyyMMddTHHmmssfff')
}

function Resolve-GateBackupPath {
  param([string]$BackupRoot, [string]$Kind, [string]$Stamp)
  if (-not (Test-Path -LiteralPath $BackupRoot)) {
    New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
  }
  $base = Join-Path $BackupRoot ($Kind + '.' + $Stamp)
  $candidate = $base
  $suffix = 2
  while (Test-Path -LiteralPath $candidate) {
    $candidate = $base + '-' + $suffix
    $suffix++
  }
  return $candidate
}

function Remove-GateOldBackups {
  param([string]$BackupRoot, [int]$Keep = 3, [string]$Kind = '')
  $removed = New-Object System.Collections.Generic.List[string]
  if (-not (Test-Path -LiteralPath $BackupRoot)) { return $removed.ToArray() }
  $pattern = '^[A-Za-z][A-Za-z0-9-]*\.\d{8}T\d{6}\d{3}(-\d+)?(\.[A-Za-z0-9]+)?$'
  $groups = @{}
  foreach ($item in @(Get-ChildItem -LiteralPath $BackupRoot -Force -ErrorAction SilentlyContinue)) {
    if ($item.Name -notmatch $pattern) { continue }
    $kindName = ($item.Name -split '\.')[0]
    if ($Kind -and $kindName -ine $Kind) { continue }
    if (-not $groups.ContainsKey($kindName)) { $groups[$kindName] = New-Object System.Collections.Generic.List[object] }
    $groups[$kindName].Add($item)
  }
  foreach ($key in @($groups.Keys)) {
    $sorted = @($groups[$key] | Sort-Object Name -Descending)
    if ($sorted.Count -le $Keep) { continue }
    for ($index = $Keep; $index -lt $sorted.Count; $index++) {
      $target = $sorted[$index].FullName
      Remove-Item -LiteralPath $target -Recurse -Force
      $removed.Add($target) | Out-Null
    }
  }
  return $removed.ToArray()
}

function New-GateBackupFile {
  param([string]$Path, [string]$Kind, [string]$BackupRoot, [string]$Stamp, [int]$Keep = 3)
  if (-not (Test-Path -LiteralPath $Path)) { throw (New-GateError 'BACKUP-SOURCE' ('要备份的文件不存在：' + $Path) 3) }
  $actualStamp = Get-GateBackupStamp -Stamp $Stamp
  $dest = Resolve-GateBackupPath -BackupRoot $BackupRoot -Kind $Kind -Stamp $actualStamp
  Copy-Item -LiteralPath $Path -Destination $dest -Force
  Remove-GateOldBackups -BackupRoot $BackupRoot -Keep $Keep | Out-Null
  return $dest
}

function Move-GatePathToBackup {
  param([string]$Path, [string]$Kind, [string]$BackupRoot, [string]$Stamp, [int]$Keep = 3)
  if (-not (Test-Path -LiteralPath $Path)) { throw (New-GateError 'BACKUP-SOURCE' ('要移动的路径不存在：' + $Path) 6) }
  $actualStamp = Get-GateBackupStamp -Stamp $Stamp
  $dest = Resolve-GateBackupPath -BackupRoot $BackupRoot -Kind $Kind -Stamp $actualStamp
  Move-Item -LiteralPath $Path -Destination $dest -Force
  Remove-GateOldBackups -BackupRoot $BackupRoot -Keep $Keep | Out-Null
  return $dest
}

# ---------------------------------------------------------------------------
# 回滚日志：分阶段执行逆操作（先拆新建物、再还原被移走/覆盖的路径、最后重建链接）
# ---------------------------------------------------------------------------

function Add-GateUndo {
  param($Journal, [ValidateSet('remove-path', 'remove-link', 'move', 'copy', 'create-link')][string]$Kind, [string]$Label, [hashtable]$Data)
  $Journal.Add([pscustomobject]@{ Kind = $Kind; Label = $Label; Data = $Data }) | Out-Null
}

function Invoke-GateRollback {
  param($Journal)
  $failures = New-Object System.Collections.Generic.List[string]
  if (-not $Journal -or $Journal.Count -eq 0) { return $failures.ToArray() }
  Write-Output '[回滚] 正在执行逆操作，回到操作前状态...'

  for ($index = $Journal.Count - 1; $index -ge 0; $index--) {
    $entry = $Journal[$index]
    if ($entry.Kind -ne 'remove-path' -and $entry.Kind -ne 'remove-link') { continue }
    try {
      if (Test-Path -LiteralPath $entry.Data.Path) {
        $item = Get-Item -LiteralPath $entry.Data.Path -Force
        if ($entry.Kind -eq 'remove-link' -or ($item.PSObject.Properties['LinkType'] -and $item.LinkType)) {
          [System.IO.Directory]::Delete($entry.Data.Path)
        } else {
          Remove-Item -LiteralPath $entry.Data.Path -Recurse -Force
        }
        Write-Output ('  [回滚] ' + $entry.Label)
      }
    } catch { $failures.Add($entry.Label + '：' + $_.Exception.Message) | Out-Null }
  }

  for ($index = $Journal.Count - 1; $index -ge 0; $index--) {
    $entry = $Journal[$index]
    if ($entry.Kind -ne 'move' -and $entry.Kind -ne 'copy') { continue }
    try {
      if (Test-Path -LiteralPath $entry.Data.From) {
        $parent = Split-Path -Parent $entry.Data.To
        if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        if (Test-Path -LiteralPath $entry.Data.To) { Remove-Item -LiteralPath $entry.Data.To -Recurse -Force }
        if ($entry.Kind -eq 'move') {
          Move-Item -LiteralPath $entry.Data.From -Destination $entry.Data.To -Force
        } else {
          Copy-Item -LiteralPath $entry.Data.From -Destination $entry.Data.To -Force
        }
        Write-Output ('  [回滚] ' + $entry.Label)
      }
    } catch { $failures.Add($entry.Label + '：' + $_.Exception.Message) | Out-Null }
  }

  for ($index = $Journal.Count - 1; $index -ge 0; $index--) {
    $entry = $Journal[$index]
    if ($entry.Kind -ne 'create-link') { continue }
    try {
      if (-not (Test-Path -LiteralPath $entry.Data.Path)) {
        New-GateJunction -Path $entry.Data.Path -Target $entry.Data.Target
        Write-Output ('  [回滚] ' + $entry.Label)
      }
    } catch { $failures.Add($entry.Label + '：' + $_.Exception.Message) | Out-Null }
  }
  return $failures.ToArray()
}

# ---------------------------------------------------------------------------
# 链接（junction）与平台检查
# ---------------------------------------------------------------------------

function Get-GateLinkTarget {
  param([string]$Path)
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSObject.Properties['Target']) { return '' }
  $target = $item.Target
  if ($target -is [array]) {
    if ($target.Count -gt 0) { return [string]$target[0] }
    return ''
  }
  if ($target) { return [string]$target }
  return ''
}

function New-GateJunction {
  param([string]$Path, [string]$Target)
  if (-not (Test-Path -LiteralPath $Target)) { throw (New-GateError 'JUNCTION-TARGET' ('junction 目标不存在：' + $Target) 6) }
  $parent = Split-Path -Parent $Path
  if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
  if (-not (Test-Path -LiteralPath $Path)) { throw (New-GateError 'JUNCTION-FAILED' ('junction 创建失败：' + $Path + ' -> ' + $Target) 6) }
}

function Test-GateJunctionTarget {
  param([string]$Path, [string]$Expected)
  if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{ Ok = $false; Reason = 'junction 不存在' } }
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSObject.Properties['LinkType'] -or -not $item.LinkType) { return [pscustomobject]@{ Ok = $false; Reason = '不是链接（LinkType 为空）' } }
  $target = Get-GateLinkTarget -Path $Path
  if ($target) {
    $actual = [System.IO.Path]::GetFullPath($target).TrimEnd([char]92, [char]47)
    $want = [System.IO.Path]::GetFullPath($Expected).TrimEnd([char]92, [char]47)
    if ($actual -ine $want) { return [pscustomobject]@{ Ok = $false; Reason = ('链接指向 ' + $actual + '，期望 ' + $want) } }
    return [pscustomobject]@{ Ok = $true; Reason = ('-> ' + $actual) }
  }
  $linkManifest = Join-Path $Path 'package.json'
  $sourceManifest = Join-Path $Expected 'package.json'
  if ((Test-Path -LiteralPath $linkManifest) -and (Test-Path -LiteralPath $sourceManifest)) {
    $hashLink = (Get-FileHash -LiteralPath $linkManifest -Algorithm SHA1).Hash
    $hashSource = (Get-FileHash -LiteralPath $sourceManifest -Algorithm SHA1).Hash
    if ($hashLink -eq $hashSource) { return [pscustomobject]@{ Ok = $true; Reason = '按 package.json 内容比对一致（该环境不暴露 Target）' } }
  }
  return [pscustomobject]@{ Ok = $false; Reason = '无法读取链接目标，且内容比对不一致' }
}

function Test-GatePathWritable {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{ Ok = $false; Reason = ('目录不存在：' + $Path) } }
  try {
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReadOnly) -eq [System.IO.FileAttributes]::ReadOnly) {
      return [pscustomobject]@{ Ok = $false; Reason = '目录带只读属性' }
    }
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $sids = @{}
    $sids[$identity.User.Value] = $true
    foreach ($group in $identity.Groups) { $sids[$group.Value] = $true }
    $acl = Get-Acl -LiteralPath $Path
    $mask = [System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::CreateFiles -bor [System.Security.AccessControl.FileSystemRights]::CreateDirectories
    $allowed = $false
    $denied = $false
    foreach ($rule in $acl.Access) {
      $sid = $null
      try { $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $sid = $null }
      if (-not $sid -or -not $sids.ContainsKey($sid)) { continue }
      if (($rule.FileSystemRights -band $mask) -eq 0) { continue }
      if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny) { $denied = $true } else { $allowed = $true }
    }
    if ($denied) { return [pscustomobject]@{ Ok = $false; Reason = '当前用户命中拒绝写入的 ACL 规则' } }
    if (-not $allowed) { return [pscustomobject]@{ Ok = $null; Reason = 'ACL 里没有直接授予当前用户/组的写权限' } }
    return [pscustomobject]@{ Ok = $true; Reason = 'ACL 允许写入' }
  } catch {
    return [pscustomobject]@{ Ok = $null; Reason = ('ACL 读取失败：' + $_.Exception.Message) }
  }
}

function Get-GateDiskInfo {
  param([string]$Path)
  try {
    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($full)
    $drive = New-Object System.IO.DriveInfo($root)
    return [pscustomobject]@{ Ok = $true; Root = $drive.Name; Free = [double]$drive.AvailableFreeSpace; Total = [double]$drive.TotalSize; Format = [string]$drive.DriveFormat; Reason = '' }
  } catch {
    try {
      $item = Get-Item -LiteralPath $Path -Force
      if ($item.PSDrive) {
        $psDrive = Get-PSDrive -Name $item.PSDrive.Name -ErrorAction Stop
        return [pscustomobject]@{ Ok = $true; Root = ($item.PSDrive.Name + ':'); Free = [double]$psDrive.Free; Total = [double]($psDrive.Used + $psDrive.Free); Format = 'unknown'; Reason = '' }
      }
    } catch { }
    return [pscustomobject]@{ Ok = $false; Root = ''; Free = 0; Total = 0; Format = ''; Reason = $_.Exception.Message }
  }
}

function Test-GateSameVolume {
  param([string]$PathA, [string]$PathB)
  $a = Get-GateDiskInfo -Path $PathA
  $b = Get-GateDiskInfo -Path $PathB
  if (-not $a.Ok -or -not $b.Ok) { return $null }
  return ($a.Root -ieq $b.Root)
}

function Test-GateJunctionCapability {
  param([string]$Parent, [string]$TargetPath)
  $probeDir = $Parent
  while ($probeDir -and -not (Test-Path -LiteralPath $probeDir)) { $probeDir = Split-Path -Parent $probeDir }
  if (-not $probeDir) { return [pscustomobject]@{ Ok = $false; Reason = '找不到可用的父目录' } }
  $disk = Get-GateDiskInfo -Path $probeDir
  if ($disk.Ok -and $disk.Format -and ($disk.Format -notmatch '(?i)^(NTFS|ReFS)$')) {
    return [pscustomobject]@{ Ok = $false; Reason = ('卷 ' + $disk.Root + ' 是 ' + $disk.Format + '，junction 需要 NTFS/ReFS') }
  }
  $writable = Test-GatePathWritable -Path $probeDir
  $extra = ''
  if ($TargetPath -and (Test-Path -LiteralPath $TargetPath)) {
    $existing = Get-Item -LiteralPath $TargetPath -Force
    if (-not $existing.PSObject.Properties['LinkType'] -or -not $existing.LinkType) { $extra = '；目标已存在且是实体目录，安装时会先移入备份' }
  }
  if ($writable.Ok -eq $false) { return [pscustomobject]@{ Ok = $false; Reason = ('父目录不可写：' + $writable.Reason) } }
  if ($writable.Ok -eq $null) { return [pscustomobject]@{ Ok = $null; Reason = ('父目录可写性未知：' + $writable.Reason) } }
  return [pscustomobject]@{ Ok = $true; Reason = ('父目录可写，卷 ' + $disk.Root + $extra) }
}

# ---------------------------------------------------------------------------
# payload 与暂存校验
# ---------------------------------------------------------------------------

function Get-GatePayloadList {
  param([string]$Source)
  $manifestPath = Join-Path $Source 'package.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { throw (New-GateError 'SOURCE-MANIFEST' ('源码缺少 package.json：' + $Source) 2) }
  $doc = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $list = New-Object System.Collections.Generic.List[string]
  $list.Add('package.json') | Out-Null
  foreach ($entry in @($doc.files)) {
    if (-not $entry) { continue }
    $trimmed = ([string]$entry).TrimEnd('/').TrimEnd('\')
    if ($trimmed -and -not $list.Contains($trimmed)) { $list.Add($trimmed) | Out-Null }
  }
  if ($list.Count -le 1) {
    foreach ($fallback in $script:DefaultPayload) { if (-not $list.Contains($fallback)) { $list.Add($fallback) | Out-Null } }
  }
  if ($doc.dsh -and $doc.dsh.bundle -and $doc.dsh.bundle.patch) {
    $patchRel = [string]$doc.dsh.bundle.patch
    if ($patchRel -and -not $list.Contains($patchRel)) { $list.Add($patchRel) | Out-Null }
  }
  return $list.ToArray()
}

function Get-GateManifestFileTargets {
  param($Manifest)
  $targets = New-Object System.Collections.Generic.List[string]
  if ($Manifest.main) { $targets.Add([string]$Manifest.main) | Out-Null }
  if ($Manifest.exports) {
    foreach ($prop in @($Manifest.exports.PSObject.Properties)) {
      $value = $prop.Value
      if ($value -is [string]) { $targets.Add($value) | Out-Null; continue }
      foreach ($key in @('default', 'import', 'require')) {
        $candidate = $null
        if ($value -and $value.PSObject.Properties[$key]) { $candidate = $value.$key }
        if ($candidate -is [string]) { $targets.Add($candidate) | Out-Null }
      }
    }
  }
  return $targets.ToArray()
}

function Copy-GatePayload {
  param([string]$Source, [string]$Destination, [string[]]$Payload)
  if (-not (Test-Path -LiteralPath $Destination)) { New-Item -ItemType Directory -Force -Path $Destination | Out-Null }
  foreach ($item in $Payload) {
    $from = Join-Path $Source $item
    if (-not (Test-Path -LiteralPath $from)) { throw (New-GateError 'PAYLOAD-MISSING' ('源码缺少必需文件：' + $item) 5) }
    Copy-Item -LiteralPath $from -Destination (Join-Path $Destination $item) -Recurse -Force
  }
}

function Test-GateStagedPayload {
  param([string]$Path)
  $problems = New-Object System.Collections.Generic.List[string]
  $manifestPath = Join-Path $Path 'package.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    $problems.Add('缺少 package.json') | Out-Null
    return [pscustomobject]@{ Ok = $false; Problems = $problems.ToArray() }
  }
  try { Assert-GateNoBom -Path $manifestPath -Label 'package.json' } catch { $problems.Add($_.Exception.Message) | Out-Null }
  $doc = $null
  try { $doc = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json } catch { $problems.Add('package.json 不可解析：' + $_.Exception.Message) | Out-Null }
  if ($doc) {
    if ($doc.name -ne $script:PluginName) { $problems.Add('package.json name 必须是 dsh-gate，实际 ' + $doc.name) | Out-Null }
    if (-not $doc.version) { $problems.Add('package.json 缺 version') | Out-Null }
    foreach ($target in @(Get-GateManifestFileTargets -Manifest $doc)) {
      $normalized = ([string]$target).TrimStart('.', '/', '\')
      if (-not (Test-Path -LiteralPath (Join-Path $Path $normalized))) { $problems.Add('package.json 指向的 ' + $target + ' 不存在') | Out-Null }
    }
    foreach ($entry in @($doc.files)) {
      if (-not $entry) { continue }
      $normalized = ([string]$entry).TrimEnd('/').TrimEnd('\')
      if (-not (Test-Path -LiteralPath (Join-Path $Path $normalized))) { $problems.Add('package.json files 里的 ' + $entry + ' 不存在') | Out-Null }
    }
  }
  $patchRel = 'cordis.patch.yml'
  if ($doc -and $doc.dsh -and $doc.dsh.bundle -and $doc.dsh.bundle.patch) { $patchRel = [string]$doc.dsh.bundle.patch }
  $patchPath = Join-Path $Path $patchRel
  if (-not (Test-Path -LiteralPath $patchPath)) {
    $problems.Add('缺少 ' + $patchRel) | Out-Null
  } else {
    $text = [System.IO.File]::ReadAllText($patchPath)
    $structure = Test-GatePatchStructure -Text $text
    if (-not $structure.Ok) { $problems.Add($patchRel + ' 结构非法：' + ($structure.Problems -join '；')) | Out-Null }
  }
  return [pscustomobject]@{ Ok = ($problems.Count -eq 0); Problems = $problems.ToArray() }
}

# ---------------------------------------------------------------------------
# manifest 读写
# ---------------------------------------------------------------------------

function Read-GateManifest {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { throw (New-GateError 'MANIFEST-MISSING' ('找不到 profile manifest：' + $Path) 3) }
  Assert-GateNoBom -Path $Path -Label 'package.json'
  try {
    return ([System.IO.File]::ReadAllText($Path) | ConvertFrom-Json)
  } catch {
    throw (New-GateError 'MANIFEST-PARSE' ('package.json 不可解析：' + $_.Exception.Message) 3)
  }
}

function Update-GateManifest {
  param([string]$ManifestPath, [ValidateSet('Add', 'Remove')][string]$Mode, [string]$DependencySpec = '', [string]$TempDir)
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw (New-GateError 'NO-NODE' 'PATH 上没有 node（本脚本用 node 往返写 package.json）。请安装 Node >= 20。' 3)
  }
  $dir = $TempDir
  if (-not $dir) { $dir = [System.IO.Path]::GetTempPath() }
  $scriptFile = Join-Path $dir ('dsh-gate-manifest-' + [guid]::NewGuid().ToString('N') + '.cjs')
  [System.IO.File]::WriteAllText($scriptFile, $script:ManifestScript, [System.Text.Encoding]::ASCII)
  try {
    $output = & node $scriptFile $ManifestPath $Mode $DependencySpec 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0) {
      throw (New-GateError 'MANIFEST-WRITE' ('写入 package.json 失败（exit ' + $code + '）：' + (($output | Out-String).Trim())) 7)
    }
    return ($output | Out-String).Trim()
  } finally {
    if (Test-Path -LiteralPath $scriptFile) { Remove-Item -LiteralPath $scriptFile -Force -ErrorAction SilentlyContinue }
  }
}

# ---------------------------------------------------------------------------
# 其它 profile 是否共用同一份源码
# ---------------------------------------------------------------------------

function Get-GateOtherProfileUsers {
  param([string]$GateHome, [string]$Profile)
  $users = New-Object System.Collections.Generic.List[string]
  $profilesRoot = Join-Path $GateHome 'profiles'
  if (-not (Test-Path -LiteralPath $profilesRoot)) { return $users.ToArray() }
  $selfPath = [System.IO.Path]::GetFullPath($Profile).TrimEnd([char]92, [char]47)
  foreach ($dir in @(Get-ChildItem -LiteralPath $profilesRoot -Directory -ErrorAction SilentlyContinue)) {
    $fullPath = [System.IO.Path]::GetFullPath($dir.FullName).TrimEnd([char]92, [char]47)
    if ($fullPath -ieq $selfPath) { continue }
    $used = $false
    $manifest = Join-Path $fullPath 'package.json'
    if (Test-Path -LiteralPath $manifest) {
      try {
        $doc = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
        if (@($doc.dsh.profile.bundles) -contains $script:PluginName) { $used = $true }
        if ($doc.dependencies -and ($doc.dependencies.PSObject.Properties.Name -contains $script:PluginName)) { $used = $true }
      } catch { }
    }
    if (-not $used -and (Test-Path -LiteralPath (Join-Path $fullPath 'node_modules\dsh-gate'))) { $used = $true }
    if ($used) { $users.Add($dir.Name) | Out-Null }
  }
  return $users.ToArray()
}

# ---------------------------------------------------------------------------
# 预检（G84：五项，零写入）
# ---------------------------------------------------------------------------

function Get-GatePreflight {
  param($Context, [ValidateSet('install', 'uninstall')][string]$Kind, [string]$SourcePath, [string[]]$Payload)
  $probe = Get-GateProcessProbe -ProfileName $Context.ProfileName -ProfileDir $Context.ProfileDir -GateHome $Context.GateHome -TestProbe $env:DSH_GATE_TEST_PROCESS_PROBE
  $ids = (@($probe.Running) | ForEach-Object { $_.ProcessId }) -join ','
  if (-not $probe.Available) {
    $processText = '无法判定：' + $probe.Reason + '（默认拒绝写操作，除非显式 -Force）'
  } elseif ($probe.Running.Count -gt 0) {
    $processText = '正在运行（PID ' + $ids + '）'
  } else {
    $processText = '未运行（检测可用）'
  }

  $writable = Test-GatePathWritable -Path $Context.ProfileDir
  if ($writable.Ok -eq $true) {
    $writableText = '是（ACL 判定，未落盘）'
  } elseif ($writable.Ok -eq $false) {
    $writableText = '否：' + $writable.Reason
  } else {
    $writableText = '未知：' + $writable.Reason + '（试运行不落盘，只按 ACL 判断）'
  }

  $needBytes = [long]0
  if ($Kind -eq 'install' -and $SourcePath -and $Payload) {
    foreach ($item in $Payload) { $needBytes += (Get-GatePathSize -Path (Join-Path $SourcePath $item)) }
  }
  $disk = Get-GateDiskInfo -Path $Context.ProfileDir
  if ($disk.Ok) {
    $diskText = '剩余 ' + (Format-GateBytes $disk.Free) + ' / 共 ' + (Format-GateBytes $disk.Total) + '（卷 ' + $disk.Root + '；本次预计需要 ' + (Format-GateBytes $needBytes) + '）'
    if ($disk.Free -lt $needBytes) { $diskText += ' ⚠ 余量不足' }
  } else {
    $diskText = '未知：' + $disk.Reason
  }

  $sameVolume = Test-GateSameVolume -PathA $Context.ProfileDir -PathB $Context.BackupRoot
  if ($sameVolume -eq $true) {
    $volumeText = '是（profile 与备份同卷，迁移=重命名）'
  } elseif ($sameVolume -eq $false) {
    $volumeText = '否（跨卷：源码移入备份会退化为复制）'
  } else {
    $volumeText = '未知（无法读取卷信息）'
  }

  $junction = Test-GateJunctionCapability -Parent (Split-Path -Parent $Context.TargetPath) -TargetPath $Context.TargetPath
  if ($junction.Ok -eq $true) {
    $junctionText = '可创建（' + $junction.Reason + '；junction 不需要管理员权限）'
  } elseif ($junction.Ok -eq $false) {
    $junctionText = '不可：' + $junction.Reason
  } else {
    $junctionText = '未知：' + $junction.Reason
  }

  return [pscustomobject]@{
    ProcessText = $processText
    WritableText = $writableText
    DiskText = $diskText
    VolumeText = $volumeText
    JunctionText = $junctionText
    ProcessAvailable = $probe.Available
    ProcessRunning = ($probe.Running.Count -gt 0)
    NeedBytes = $needBytes
  }
}

function Show-GateDryRun {
  param($Context, [ValidateSet('install', 'uninstall')][string]$Kind, $Preflight)
  Write-Output ''
  Write-Output '[预检]'
  Write-Output ('  1) 目标 profile 是否运行 : ' + $Preflight.ProcessText)
  Write-Output ('  2) 目标路径可写         : ' + $Preflight.WritableText)
  Write-Output ('  3) 磁盘余量             : ' + $Preflight.DiskText)
  Write-Output ('  4) 是否同卷             : ' + $Preflight.VolumeText)
  Write-Output ('  5) junction 权限        : ' + $Preflight.JunctionText)
  Write-Output ''
  Write-Output ('[dry-run] 将执行（' + $Kind + '）：')
  if ($Kind -eq 'install') {
    Write-Output ('  1) 预检（上面五项）')
    Write-Output ('  2) 复制到暂存目录 ' + $Context.LocalRoot + '\.staging-dsh-gate-<stamp>（旧源码此刻不动）')
    Write-Output ('  3) 校验暂存内容：package.json 可解析、name=dsh-gate、main/exports/files 齐全、patch 结构合法')
    Write-Output ('  4) 交换：旧源码移入备份 -> 暂存转正 -> 重建 junction ' + $Context.TargetPath + ' -> ' + $Context.SourceDir)
    Write-Output ('  5) 写 package.json（bundles + dependencies）与 cordis.patch.yml（- insert: / surface-gate）；先备份再写')
    Write-Output ('  6) 回读校验：JSON 合法 / 无 BOM / bundles / 依赖 / junction 目标 / patch 行与结构')
    Write-Output ('  策略种子：' + $Context.GateJsonPath + '（已存在则保留）')
  } else {
    Write-Output ('  1) 预检（上面五项）')
    Write-Output ('  2) 备份 package.json 与 cordis.patch.yml 到 ' + $Context.BackupRoot + '（种类.时间戳，两个名字不冲突）')
    Write-Output ('  3) package.json：bundles 摘掉 dsh-gate、dependencies 删掉 dsh-gate')
    Write-Output ('  4) 删 junction ' + $Context.TargetPath + '（只删链接，不碰源码）')
    Write-Output ('  5) 源码目录移入备份（仍被同一 DSH home 下其它 profile 使用时保留）')
    Write-Output ('  6) cordis.patch.yml：按唯一模式摘掉 surface-gate 行，空掉的 - insert: 块一并清掉，写前做结构校验')
    Write-Output ('  7) 回读校验：bundles / 依赖 / junction / patch 行 / 无 BOM')
    Write-Output ('  保留：' + $Context.GateJsonPath + '（要清请手动删）')
  }
  Write-Output '[dry-run] 未写入任何字节（只读预览）'
}

function Show-GatePlanSummary {
  param($Context, [ValidateSet('install', 'uninstall')][string]$Kind)
  $patchText = ''
  if (Test-Path -LiteralPath $Context.PatchPath) { $patchText = [System.IO.File]::ReadAllText($Context.PatchPath) }
  $hasPatchRow = Test-GatePatchRowPresent -Text $patchText
  $doc = $null
  if (Test-Path -LiteralPath $Context.ManifestPath) {
    try { $doc = Read-GateManifest -Path $Context.ManifestPath } catch { $doc = $null }
  }
  $bundles = @()
  $hasBundle = $false
  $depValue = $null
  if ($doc) {
    if ($doc.dsh -and $doc.dsh.profile) { $bundles = @($doc.dsh.profile.bundles) }
    $hasBundle = ($bundles -contains $script:PluginName)
    if ($doc.dependencies -and $doc.dependencies.PSObject.Properties[$script:PluginName]) { $depValue = $doc.dependencies.$script:PluginName }
  }
  $depSpec = ''
  if ($Kind -eq 'install') { $depSpec = Get-GateDependencySpec -Profile $Context.ProfileDir -SourceDir $Context.SourceDir }
  Write-Output ('DSH home : ' + $Context.GateHome + '（来源：' + $Context.GateSourceLabel + '）')
  Write-Output ('插件源码 : ' + $Context.Source)
  Write-Output ('安装位置 : ' + $Context.SourceDir + '（已存在 = ' + (Test-Path -LiteralPath $Context.SourceDir) + '）')
  Write-Output ('junction : ' + $Context.TargetPath + '（已存在 = ' + (Test-Path -LiteralPath $Context.TargetPath) + '）')
  Write-Output ('manifest : ' + $Context.ManifestPath)
  Write-Output ('bundles  : ' + $bundles.Count + ' 项，dsh-gate 已登记 = ' + $hasBundle)
  if ($depSpec) {
    Write-Output ('依赖     : dsh-gate = ' + $depSpec + '（已登记 = ' + [bool]$depValue + '）')
  } else {
    Write-Output ('依赖     : dsh-gate 已登记 = ' + [bool]$depValue)
  }
  $seedNote = '（安装位置口径）'
  if ($Context.SeedHomeIsRuntime) { $seedNote = '（运行时 DSH_HOME 口径）' }
  Write-Output ('策略文件 : ' + $Context.GateJsonPath + '（已存在 = ' + (Test-Path -LiteralPath $Context.GateJsonPath) + '）' + $seedNote)
  Write-Output ('patch 行 : surface-gate 已在 cordis.patch.yml = ' + $hasPatchRow)
  Write-Output ('备份目录 : ' + $Context.BackupRoot + '（每种类保留 ' + $Context.KeepBackups + ' 份，清理最旧）')
}

# ---------------------------------------------------------------------------
# 回读校验
# ---------------------------------------------------------------------------

function Invoke-GateInstallReadback {
  param($Context, [string]$DependencySpec)
  $problems = New-Object System.Collections.Generic.List[string]
  try { Assert-GateNoBom -Path $Context.ManifestPath -Label 'package.json' } catch { $problems.Add($_.Exception.Message) | Out-Null }
  $doc = $null
  try { $doc = Read-GateManifest -Path $Context.ManifestPath } catch { $problems.Add($_.Exception.Message) | Out-Null }
  if ($doc) {
    if (-not (@($doc.dsh.profile.bundles) -contains $script:PluginName)) { $problems.Add('bundles 里没有 dsh-gate') | Out-Null }
    $dep = $null
    if ($doc.dependencies -and $doc.dependencies.PSObject.Properties[$script:PluginName]) { $dep = $doc.dependencies.$script:PluginName }
    if (-not $dep) { $problems.Add('dependencies 里没有 dsh-gate（市场/配置页会看不到它）') | Out-Null }
  }
  if (-not (Test-Path -LiteralPath $Context.SourceDir)) { $problems.Add('源码目录不存在：' + $Context.SourceDir) | Out-Null }
  $junction = Test-GateJunctionTarget -Path $Context.TargetPath -Expected $Context.SourceDir
  if (-not $junction.Ok) { $problems.Add('junction 校验失败：' + $junction.Reason) | Out-Null }
  if (-not (Test-Path -LiteralPath $Context.PatchPath)) {
    $problems.Add('cordis.patch.yml 不存在') | Out-Null
  } else {
    $text = [System.IO.File]::ReadAllText($Context.PatchPath)
    if (-not (Test-GatePatchRowPresent -Text $text)) { $problems.Add('cordis.patch.yml 里没有 surface-gate 行') | Out-Null }
    $structure = Test-GatePatchStructure -Text $text
    if (-not $structure.Ok) { $problems.Add('cordis.patch.yml 结构非法：' + ($structure.Problems -join '；')) | Out-Null }
    try { Assert-GateNoBom -Path $Context.PatchPath -Label 'cordis.patch.yml' } catch { $problems.Add($_.Exception.Message) | Out-Null }
  }
  if ($problems.Count -gt 0) {
    throw (New-GateError 'READBACK' ('回读校验失败：' + $problems.Count + ' 项' + $script:LF + '  - ' + ($problems -join ($script:LF + '  - '))) 8)
  }
  return $doc
}

function Invoke-GateUninstallReadback {
  param($Context)
  $problems = New-Object System.Collections.Generic.List[string]
  try { Assert-GateNoBom -Path $Context.ManifestPath -Label 'package.json' } catch { $problems.Add($_.Exception.Message) | Out-Null }
  $doc = $null
  try { $doc = Read-GateManifest -Path $Context.ManifestPath } catch { $problems.Add($_.Exception.Message) | Out-Null }
  if ($doc) {
    if (@($doc.dsh.profile.bundles) -contains $script:PluginName) { $problems.Add('bundles 里还有 dsh-gate') | Out-Null }
    if ($doc.dependencies -and ($doc.dependencies.PSObject.Properties.Name -contains $script:PluginName)) { $problems.Add('dependencies 里还有 dsh-gate') | Out-Null }
  }
  if (Test-Path -LiteralPath $Context.TargetPath) { $problems.Add('node_modules\dsh-gate 还存在') | Out-Null }
  if ((Test-Path -LiteralPath $Context.PatchPath) -and (Test-GatePatchRowPresent -Text ([System.IO.File]::ReadAllText($Context.PatchPath)))) {
    $problems.Add('cordis.patch.yml 里还有 surface-gate 行') | Out-Null
  }
  if ($problems.Count -gt 0) {
    throw (New-GateError 'READBACK' ('回读校验失败：' + $problems.Count + ' 项' + $script:LF + '  - ' + ($problems -join ($script:LF + '  - '))) 8)
  }
  return $doc
}

# ---------------------------------------------------------------------------
# 安装事务（G81 / G82）
# ---------------------------------------------------------------------------

function Invoke-GateInstall {
  param($Context, [string]$SourcePath, [string[]]$Payload)
  if (-not $SourcePath) { throw (New-GateError 'SOURCE-MISSING' '缺少插件源码目录' 2) }
  if (-not $Payload -or $Payload.Count -eq 0) { $Payload = @(Get-GatePayloadList -Source $SourcePath) }
  $stamp = Get-GateBackupStamp
  $journal = New-Object System.Collections.Generic.List[object]
  $step = 'preflight'
  try {
    # ---- 1) 预检 ----
    Test-GateFaultPoint -Step 'preflight'
    if (-not (Test-Path -LiteralPath $Context.ManifestPath)) { throw (New-GateError 'MANIFEST-MISSING' ('找不到 profile manifest：' + $Context.ManifestPath) 3) }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw (New-GateError 'NO-NODE' 'PATH 上没有 node（本脚本用 node 往返写 package.json）。请安装 Node >= 20。' 3) }
    $dependencySpec = Get-GateDependencySpec -Profile $Context.ProfileDir -SourceDir $Context.SourceDir
    Write-Output '[1/6] 预检通过（进程状态已在上层确认；目标路径存在、node 可用）'

    # ---- 2) 复制到暂存（旧源码一动不动）----
    $step = 'stage'
    Test-GateFaultPoint -Step 'stage'
    if (-not (Test-Path -LiteralPath $Context.LocalRoot)) { New-Item -ItemType Directory -Force -Path $Context.LocalRoot | Out-Null }
    $staging = Join-Path $Context.LocalRoot ('.staging-dsh-gate-' + $stamp)
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    Add-GateUndo -Journal $journal -Kind 'remove-path' -Label ('清理暂存目录：' + $staging) -Data @{ Path = $staging }
    Write-Output ('[2/6] 复制到暂存目录：' + $staging)
    Copy-GatePayload -Source $SourcePath -Destination $staging -Payload $Payload
    Test-GateFaultPoint -Step 'stage-copy'

    # ---- 3) 校验暂存 ----
    $step = 'verify'
    Test-GateFaultPoint -Step 'verify'
    $staged = Test-GateStagedPayload -Path $staging
    if (-not $staged.Ok) {
      throw (New-GateError 'STAGE-VERIFY' ('暂存校验失败：' + $script:LF + '  - ' + ($staged.Problems -join ($script:LF + '  - '))) 5)
    }
    Write-Output '[3/6] 暂存校验通过：package.json 可解析、必需文件齐全、patch 结构合法'

    # ---- 4) 交换：旧源码只在新内容就绪后移入备份 ----
    $step = 'swap'
    Test-GateFaultPoint -Step 'swap-before-promote'
    if (Test-Path -LiteralPath $Context.SourceDir) {
      $oldSource = Move-GatePathToBackup -Path $Context.SourceDir -Kind 'source-preinstall' -BackupRoot $Context.BackupRoot -Stamp $stamp -Keep $Context.KeepBackups
      Add-GateUndo -Journal $journal -Kind 'move' -Label ('把旧源码移回 ' + $Context.SourceDir) -Data @{ From = $oldSource; To = $Context.SourceDir }
      Write-Output ('[4/6] 旧源码已移入备份：' + $oldSource)
    }
    Move-Item -LiteralPath $staging -Destination $Context.SourceDir -Force
    Add-GateUndo -Journal $journal -Kind 'remove-path' -Label ('删除新源码目录：' + $Context.SourceDir) -Data @{ Path = $Context.SourceDir }
    if (-not (Test-Path -LiteralPath (Join-Path $Context.SourceDir 'package.json'))) {
      throw (New-GateError 'SWAP' '交换后源码目录里没有 package.json' 6)
    }
    if (Test-Path -LiteralPath $Context.TargetPath) {
      $existing = Get-Item -LiteralPath $Context.TargetPath -Force
      if ($existing.PSObject.Properties['LinkType'] -and $existing.LinkType) {
        $oldLinkTarget = Get-GateLinkTarget -Path $Context.TargetPath
        [System.IO.Directory]::Delete($Context.TargetPath)
        if ($oldLinkTarget) {
          Add-GateUndo -Journal $journal -Kind 'create-link' -Label ('恢复旧链接：' + $Context.TargetPath) -Data @{ Path = $Context.TargetPath; Target = $oldLinkTarget }
        }
        Write-Output ('[4/6] 旧链接已移除（' + $existing.LinkType + '）')
      } else {
        $oldNodeModules = Move-GatePathToBackup -Path $Context.TargetPath -Kind 'node-modules-old' -BackupRoot $Context.BackupRoot -Stamp $stamp -Keep $Context.KeepBackups
        Add-GateUndo -Journal $journal -Kind 'move' -Label ('把旧 node_modules 目录移回 ' + $Context.TargetPath) -Data @{ From = $oldNodeModules; To = $Context.TargetPath }
        Write-Output ('[4/6] 旧实体目录已移入备份：' + $oldNodeModules)
      }
    }
    New-GateJunction -Path $Context.TargetPath -Target $Context.SourceDir
    Add-GateUndo -Journal $journal -Kind 'remove-link' -Label ('删除新 junction：' + $Context.TargetPath) -Data @{ Path = $Context.TargetPath }
    Write-Output ('[4/6] junction 就位：' + $Context.TargetPath + ' -> ' + $Context.SourceDir)
    Test-GateFaultPoint -Step 'swap'

    # ---- 5) 写 package.json / cordis.patch.yml / 策略种子 ----
    $step = 'patch'
    $manifestBackup = New-GateBackupFile -Path $Context.ManifestPath -Kind 'manifest' -BackupRoot $Context.BackupRoot -Stamp $stamp -Keep $Context.KeepBackups
    Add-GateUndo -Journal $journal -Kind 'copy' -Label '从备份还原 package.json' -Data @{ From = $manifestBackup; To = $Context.ManifestPath }
    $patchExisted = Test-Path -LiteralPath $Context.PatchPath
    if ($patchExisted) {
      $patchBackup = New-GateBackupFile -Path $Context.PatchPath -Kind 'patch' -BackupRoot $Context.BackupRoot -Stamp $stamp -Keep $Context.KeepBackups
      Add-GateUndo -Journal $journal -Kind 'copy' -Label '从备份还原 cordis.patch.yml' -Data @{ From = $patchBackup; To = $Context.PatchPath }
    } else {
      Add-GateUndo -Journal $journal -Kind 'remove-path' -Label ('删除本次创建的 cordis.patch.yml：' + $Context.PatchPath) -Data @{ Path = $Context.PatchPath }
    }
    Update-GateManifest -ManifestPath $Context.ManifestPath -Mode 'Add' -DependencySpec $dependencySpec | Out-Null
    Write-Output ('[5/6] package.json 已写：bundles += dsh-gate，dependencies.dsh-gate = ' + $dependencySpec)
    $patchText = ''
    if ($patchExisted) { $patchText = [System.IO.File]::ReadAllText($Context.PatchPath) }
    $legacy = Convert-GateLegacyPatch -Text $patchText
    if ($legacy.Migrated -gt 0) { Write-Output ('[5/6] 已迁移 ' + $legacy.Migrated + ' 条旧的裸顶层 surface-gate 行') }
    $updated = Add-GatePatchText -Text $legacy.Text
    if ($updated.Changed) {
      $structure = Test-GatePatchStructure -Text $updated.Text
      if (-not $structure.Ok) { throw (New-GateError 'PATCH-YAML' ('写入前 YAML 结构校验失败：' + ($structure.Problems -join '；')) 7) }
      Write-GateTextNoBom -Path $Context.PatchPath -Text $updated.Text
      Write-Output ('[5/6] 已写 patch 行（' + $updated.Reason + '），落盘前结构校验通过')
    } else {
      Write-Output '[5/6] patch 行已存在，保留不动'
    }
    if (-not (Test-Path -LiteralPath $Context.GateJsonPath)) {
      $example = Join-Path $Context.SourceDir 'gate.example.json'
      if (Test-Path -LiteralPath $example) {
        $gateParent = Split-Path -Parent $Context.GateJsonPath
        if ($gateParent -and -not (Test-Path -LiteralPath $gateParent)) { New-Item -ItemType Directory -Force -Path $gateParent | Out-Null }
        Copy-Item -LiteralPath $example -Destination $Context.GateJsonPath -Force
        Add-GateUndo -Journal $journal -Kind 'remove-path' -Label ('删除本次种入的策略文件：' + $Context.GateJsonPath) -Data @{ Path = $Context.GateJsonPath }
        if ($Context.SeedHomeIsRuntime -and ([System.IO.Path]::GetFullPath($Context.SeedHome) -ine [System.IO.Path]::GetFullPath($Context.GateHome))) {
          Write-Output ('[5/6] 已种入策略文件（运行时读取口径 DSH_HOME）：' + $Context.GateJsonPath)
        } else {
          Write-Output ('[5/6] 已种入策略文件：' + $Context.GateJsonPath)
        }
      } else {
        Write-Output '[5/6] 源码里没有 gate.example.json，跳过策略种子'
      }
    } else {
      Write-Output '[5/6] 策略文件已存在，保留不动'
    }
    Test-GateFaultPoint -Step 'patch'

    # ---- 6) 回读校验 ----
    $step = 'readback'
    Test-GateFaultPoint -Step 'readback'
    $verified = Invoke-GateInstallReadback -Context $Context -DependencySpec $dependencySpec
    Write-Output ('[6/6] 回读校验通过：JSON 合法、无 BOM、bundles 含 dsh-gate（' + (@($verified.dsh.profile.bundles).Count) + ' 项）、依赖 ' + $dependencySpec + '、junction 就位、patch 行就位')
    return [pscustomobject]@{ Stamp = $stamp; SourceDir = $Context.SourceDir; DependencySpec = $dependencySpec }
  } catch {
    $failure = $_.Exception
    Write-Output ''
    Write-Output ('[失败] 步骤 ' + $step + '：' + $failure.Message)
    $failures = @(Invoke-GateRollback -Journal $journal)
    if ($failures.Count -eq 0) {
      Write-Output ('[回滚] 完成：已回到安装前状态（备份保留在 ' + $Context.BackupRoot + '）')
      $failure.Data['GateRolledBack'] = $true
    } else {
      Write-Output '[回滚] 未完全成功，以下需要手工处理：'
      foreach ($item in $failures) { Write-Output ('  - ' + $item) }
      $failure.Data['GateRolledBack'] = $false
    }
    throw $failure
  }
}

# ---------------------------------------------------------------------------
# 卸载事务
# ---------------------------------------------------------------------------

function Invoke-GateUninstall {
  param($Context)
  $stamp = Get-GateBackupStamp
  $journal = New-Object System.Collections.Generic.List[object]
  $step = 'preflight'
  try {
    Test-GateFaultPoint -Step 'preflight'
    if (-not (Test-Path -LiteralPath $Context.ManifestPath)) { throw (New-GateError 'MANIFEST-MISSING' ('找不到 profile manifest：' + $Context.ManifestPath) 3) }
    Write-Output '[1/7] 预检通过'

    $step = 'backup'
    $manifestBackup = New-GateBackupFile -Path $Context.ManifestPath -Kind 'manifest' -BackupRoot $Context.BackupRoot -Stamp $stamp -Keep $Context.KeepBackups
    Add-GateUndo -Journal $journal -Kind 'copy' -Label '从备份还原 package.json' -Data @{ From = $manifestBackup; To = $Context.ManifestPath }
    $patchExisted = Test-Path -LiteralPath $Context.PatchPath
    if ($patchExisted) {
      $patchBackup = New-GateBackupFile -Path $Context.PatchPath -Kind 'patch' -BackupRoot $Context.BackupRoot -Stamp $stamp -Keep $Context.KeepBackups
      Add-GateUndo -Journal $journal -Kind 'copy' -Label '从备份还原 cordis.patch.yml' -Data @{ From = $patchBackup; To = $Context.PatchPath }
    }
    Write-Output ('[2/7] 已备份 package.json' + $(if ($patchExisted) { ' 与 cordis.patch.yml' } else { '' }) + ' -> ' + $Context.BackupRoot)

    $step = 'manifest'
    Update-GateManifest -ManifestPath $Context.ManifestPath -Mode 'Remove' | Out-Null
    Write-Output '[3/7] package.json 已摘掉 bundles 与 dependencies 里的 dsh-gate'

    $step = 'junction'
    $otherUsers = @(Get-GateOtherProfileUsers -GateHome $Context.GateHome -Profile $Context.ProfileDir)
    if (Test-Path -LiteralPath $Context.TargetPath) {
      $existing = Get-Item -LiteralPath $Context.TargetPath -Force
      if ($existing.PSObject.Properties['LinkType'] -and $existing.LinkType) {
        $oldLinkTarget = Get-GateLinkTarget -Path $Context.TargetPath
        [System.IO.Directory]::Delete($Context.TargetPath)
        if ($oldLinkTarget) {
          Add-GateUndo -Journal $journal -Kind 'create-link' -Label ('恢复旧链接：' + $Context.TargetPath) -Data @{ Path = $Context.TargetPath; Target = $oldLinkTarget }
        }
        Write-Output ('[4/7] 已删除 junction（' + $existing.LinkType + '，只删链接，源码未动）')
      } else {
        $moved = Move-GatePathToBackup -Path $Context.TargetPath -Kind 'node-modules-removed' -BackupRoot $Context.BackupRoot -Stamp $stamp -Keep $Context.KeepBackups
        Add-GateUndo -Journal $journal -Kind 'move' -Label ('把 node_modules 目录移回 ' + $Context.TargetPath) -Data @{ From = $moved; To = $Context.TargetPath }
        Write-Output ('[4/7] node_modules 实体目录已移入备份：' + $moved)
      }
    } else {
      Write-Output '[4/7] node_modules\dsh-gate 不存在，跳过'
    }

    $step = 'source'
    if (Test-Path -LiteralPath $Context.SourceDir) {
      if ($otherUsers.Count -gt 0) {
        Write-Output ('[5/7] 源码仍被其它 profile 使用（' + ($otherUsers -join ', ') + '），保留不搬：' + $Context.SourceDir)
      } else {
        $removedSource = Move-GatePathToBackup -Path $Context.SourceDir -Kind 'source-removed' -BackupRoot $Context.BackupRoot -Stamp $stamp -Keep $Context.KeepBackups
        Add-GateUndo -Journal $journal -Kind 'move' -Label ('把源码移回 ' + $Context.SourceDir) -Data @{ From = $removedSource; To = $Context.SourceDir }
        Write-Output ('[5/7] 源码已移入备份：' + $removedSource)
      }
    } else {
      Write-Output '[5/7] 源码目录不存在，跳过'
    }

    $step = 'patch'
    if ($patchExisted) {
      $text = [System.IO.File]::ReadAllText($Context.PatchPath)
      $legacy = Convert-GateLegacyPatch -Text $text
      if ($legacy.Migrated -gt 0) { Write-Output ('[6/7] 顺手清掉 ' + $legacy.Migrated + ' 条旧的裸顶层 surface-gate 行') }
      $removed = Remove-GatePatchText -Text $legacy.Text
      if ($removed.Changed) {
        $structure = Test-GatePatchStructure -Text $removed.Text
        if (-not $structure.Ok) { throw (New-GateError 'PATCH-YAML' ('摘除后 YAML 结构校验失败：' + ($structure.Problems -join '；')) 7) }
        Write-GateTextNoBom -Path $Context.PatchPath -Text $removed.Text
        Write-Output ('[6/7] 已摘掉 patch 行（removed=' + $removed.Removed + '，pruned=' + $removed.Pruned + '），落盘前结构校验通过')
      } else {
        Write-Output '[6/7] cordis.patch.yml 没有 surface-gate 行，跳过'
      }
    } else {
      Write-Output '[6/7] cordis.patch.yml 不存在，跳过'
    }

    $step = 'readback'
    Invoke-GateUninstallReadback -Context $Context | Out-Null
    Write-Output '[7/7] 回读校验通过：bundles/依赖都不含 dsh-gate、junction 已消失、无 BOM、patch 行已清'
  } catch {
    $failure = $_.Exception
    Write-Output ''
    Write-Output ('[失败] 步骤 ' + $step + '：' + $failure.Message)
    $failures = @(Invoke-GateRollback -Journal $journal)
    if ($failures.Count -eq 0) {
      Write-Output ('[回滚] 完成：已回到卸载前状态（备份保留在 ' + $Context.BackupRoot + '）')
      $failure.Data['GateRolledBack'] = $true
    } else {
      Write-Output '[回滚] 未完全成功，以下需要手工处理：'
      foreach ($item in $failures) { Write-Output ('  - ' + $item) }
      $failure.Data['GateRolledBack'] = $false
    }
    throw $failure
  }
}

Export-ModuleMember -Function *
