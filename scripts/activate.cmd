@echo off
chcp 65001 >nul
setlocal
rem Prefer PowerShell 7; fall back to Windows PowerShell 5.1.
set "PS=powershell"
where pwsh >nul 2>&1 && set "PS=pwsh"
echo [dsh-gate] installing into the DSH profile (the target instance must be closed) ...
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [dsh-gate] FAILED ^(exit %RC%^) - the installer rolls back on its own when it can.
  echo [dsh-gate] manual fallback: rollback.cmd
)
if not defined DSH_GATE_NO_PAUSE pause
exit /b %RC%
