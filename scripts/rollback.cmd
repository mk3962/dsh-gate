@echo off
chcp 65001 >nul
setlocal
echo [dsh-gate] uninstalling from the DSH profile (the target DSH instance must be closed) ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
echo.
pause
