@echo off
REM Mo G4play Denuvo Manage. Xoa ELECTRON_RUN_AS_NODE (VS Code terminal hay set bien nay
REM khien electron chay nhu node thuan -> loi 'app undefined').
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
call node_modules\.bin\electron .
