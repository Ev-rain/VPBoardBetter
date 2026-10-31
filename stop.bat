@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [i] 正在关闭本地服务 ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\stop-server.ps1"
exit /b 0
