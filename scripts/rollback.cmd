@echo off
chcp 65001 >nul
setlocal
rem Prefer PowerShell 7; fall back to Windows PowerShell 5.1.
set "PS=powershell"
where pwsh >nul 2>&1 && set "PS=pwsh"
echo [dsh-gate] uninstalling from the DSH profile (the target instance must be closed) ...
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [dsh-gate] ROLLBACK FAILED ^(exit %RC%^) - see the messages above.
  echo [dsh-gate] nothing was silently ignored; fix the error and re-run.
)
if not defined DSH_GATE_NO_PAUSE pause
exit /b %RC%
