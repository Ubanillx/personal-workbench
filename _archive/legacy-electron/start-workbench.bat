@echo off
rem Personal Workbench launcher (ASCII only to avoid encoding issues)
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
start "" "node_modules\electron\dist\electron.exe" .
