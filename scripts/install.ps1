<#
  dsh-gate 安装脚本 v0.6.0（Windows PowerShell 5.1 / 7 均可；本文件 UTF-8 with BOM）

  安装事务六步（全部实现在 scripts/dsh-gate-deploy.psm1，本文件只留参数与输出）：
    1) 预检：目标 profile 是否运行、路径可写、磁盘余量、是否同卷、junction 权限
    2) 复制到暂存目录（旧源码此刻一动不动）
    3) 校验暂存：package.json 可解析、name=dsh-gate、main/exports/files 齐全、patch 结构合法
    4) 交换：旧源码移入备份 -> 暂存目录转正 -> 重建 junction（严禁先搬旧源码再复制）
    5) 写 package.json（bundles + dependencies）与 cordis.patch.yml（- insert: / surface-gate）
    6) 回读校验：JSON / 无 BOM / bundles / 依赖 / junction 目标 / patch 行与结构

  任一步失败自动按逆操作回滚到安装前状态；备份与回滚提示只在实际执行过对应代码路径时出现。

  用法（仓库根目录）：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -DryRun
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
    ... -Force        # 进程检测不可用或实例在运行时强制继续（自担风险）

  参数：
    -Profile      目标 profile 目录。默认顺序：参数 -> DSH_HOME\profiles\desktop -> ~/.dsh/profiles/desktop
    -GateHome     DSH 用户根（放 gate.json、local-plugins、backups）。
                  顺序：参数 -> 环境变量 DSH_HOME -> profile 推导 -> ~/.dsh；不一致会告警
    -Source       插件源码目录，默认自动探测（<脚本目录>\dsh-gate、<脚本目录>、<脚本目录>\..）
    -BackupRoot   备份目录，默认 <GateHome>\backups\dsh-gate
    -KeepBackups  每个备份种类保留份数，默认 3（范围 1-100），超出清理最旧
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Force,
  [string]$Profile,
  [string]$GateHome,
  [string]$Source,
  [string]$BackupRoot,
  [ValidateRange(1, 100)]
  [int]$KeepBackups = 3
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

try {
  Import-Module (Join-Path $here 'dsh-gate-deploy.psm1') -Force

  $context = New-GateContext -Profile $Profile -GateHome $GateHome -BackupRoot $BackupRoot -KeepBackups $KeepBackups
  foreach ($warning in @($context.Warnings)) {
    if ($warning) { Write-Output ('[告警] ' + $warning) }
  }
  $sourcePath = Resolve-GateSource -Source $Source -ScriptRoot $here
  $context.Source = $sourcePath
  $payload = @(Get-GatePayloadList -Source $sourcePath)

  Show-GatePlanSummary -Context $context -Kind 'install'

  if ($DryRun) {
    $preflight = Get-GatePreflight -Context $context -Kind 'install' -SourcePath $sourcePath -Payload $payload
    Show-GateDryRun -Context $context -Kind 'install' -Preflight $preflight
    exit 0
  }

  $gate = Assert-GateProcessGate -ProfileName $context.ProfileName -ProfileDir $context.ProfileDir -GateHome $context.GateHome -Force:$Force -TestProbe $env:DSH_GATE_TEST_PROCESS_PROBE
  if ($gate.Warning) { Write-Output ('[告警] ' + $gate.Warning) }

  Invoke-GateInstall -Context $context -SourcePath $sourcePath -Payload $payload | ForEach-Object { if ($_ -is [string]) { Write-Output $_ } }

  Write-Output ''
  Write-Output ('装完了。源码在 ' + $context.SourceDir + '，junction 在 ' + $context.TargetPath + '。')
  Write-Output '启动该 profile 的 DSH 后：'
  Write-Output '  1) 侧栏 插件 -> 已安装 -> 应出现 dsh-gate 卡片（可开关、可卸载、可配置）'
  Write-Output '  2) 卡片详情 -> surface-gate 行 -> 配置 = 工具闸门三列面板（常驻/按需/关闭）'
  Write-Output '  3) 日志里应有：dsh-gate: 已挂载 agent ... 可见 N，常驻 N，按需 N，隐藏 N'
  Write-Output ('卸载：powershell -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $here 'uninstall.ps1') + '"')
  exit 0
} catch {
  Write-Output ''
  $rolledBack = $_.Exception.Data -and $_.Exception.Data['GateRolledBack']
  $suffix = ''
  if ($rolledBack) { $suffix = '（已回滚到安装前状态）' } elseif ($_.Exception.Data -and $_.Exception.Data['GateRolledBack'] -eq $false) { $suffix = '（回滚未完全成功，见上方逐条提示）' }
  Write-Output ('[错误] 安装失败：' + $_.Exception.Message + $suffix)
  exit (Get-GateExitCode -ErrorRecord $_)
}
