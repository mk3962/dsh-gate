<#
  dsh-gate 卸载脚本 v0.6.0（Windows PowerShell 5.1 / 7 均可；本文件 UTF-8 with BOM）

  与 install.ps1 对称的回滚，全部实现在 scripts/dsh-gate-deploy.psm1：
    1) 预检（五项：运行状态、可写、磁盘余量、同卷、junction 权限）
    2) 备份 package.json 与 cordis.patch.yml（种类.时间戳；与源码备份不同名）
    3) package.json：bundles 摘掉 dsh-gate、dependencies 删掉 dsh-gate
    4) 删 node_modules\dsh-gate 的 junction（只删链接，不碰源码；实体目录移入备份）
    5) 源码目录移入备份（同一 DSH home 下其它 profile 仍在用时保留）
    6) cordis.patch.yml：按唯一模式摘掉 surface-gate 行，空掉的 - insert: 块一并清掉
    7) 回读校验：bundles/依赖/junction/patch 行都不含 dsh-gate，且无 BOM

  跟旧版的关键差别（D-1）：卸载认得 install 写的 4 空格缩进行，
  所以 cordis.patch.yml 能真正回到安装前的字节（默认 []\n）。

  用法（仓库根目录）：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -DryRun
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1
    ... -Force

  参数与 install.ps1 同名同义；gate.json 默认保留（里面可能有调好的名单）。
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Force,
  [string]$Profile,
  [string]$GateHome,
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
  Show-GatePlanSummary -Context $context -Kind 'uninstall'

  if ($DryRun) {
    $preflight = Get-GatePreflight -Context $context -Kind 'uninstall'
    Show-GateDryRun -Context $context -Kind 'uninstall' -Preflight $preflight
    exit 0
  }

  $gate = Assert-GateProcessGate -ProfileName $context.ProfileName -ProfileDir $context.ProfileDir -GateHome $context.GateHome -Force:$Force -TestProbe $env:DSH_GATE_TEST_PROCESS_PROBE
  if ($gate.Warning) { Write-Output ('[告警] ' + $gate.Warning) }

  Invoke-GateUninstall -Context $context | ForEach-Object { if ($_ -is [string]) { Write-Output $_ } }

  Write-Output ''
  Write-Output '卸完了。重启该 profile 的 DSH 后：'
  Write-Output '  1) 侧栏 插件 -> 已安装 -> dsh-gate 卡片消失'
  Write-Output '  2) 工具表恢复全量（不再有 <gate-catalog>，gate_* 工具不存在）'
  Write-Output ('保留：' + $context.GateJsonPath + '（名单）；备份在 ' + $context.BackupRoot)
  exit 0
} catch {
  Write-Output ''
  $rolledBack = $_.Exception.Data -and $_.Exception.Data['GateRolledBack']
  $suffix = ''
  if ($rolledBack) { $suffix = '（已回滚到卸载前状态）' } elseif ($_.Exception.Data -and $_.Exception.Data['GateRolledBack'] -eq $false) { $suffix = '（回滚未完全成功，见上方逐条提示）' }
  Write-Output ('[错误] 卸载失败：' + $_.Exception.Message + $suffix)
  exit (Get-GateExitCode -ErrorRecord $_)
}
