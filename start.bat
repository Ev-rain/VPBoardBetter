@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem hand off to launch.vbs (hidden launcher, no console window)
start "" /b wscript.exe //nologo "%~dp0launch.vbs"
exit /b 0
