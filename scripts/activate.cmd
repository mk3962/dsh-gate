@echo off
chcp 65001 >nul
setlocal
echo [dsh-gate] installing into the DSH profile (the target DSH instance must be closed) ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set RC=%ERRORLEVEL%
if not "%RC%"=="0" echo.
if not "%RC%"=="0" echo [dsh-gate] FAILED - see the error above. Rollback: rollback.cmd
echo.
pause
exit /b %RC%
