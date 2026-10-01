@echo off
cd /d "%~dp0"
if exist dist-electron rmdir /s /q dist-electron
pnpm dev
pause
