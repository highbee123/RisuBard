@echo off
setlocal DisableDelayedExpansion
title RisuBard Save Recovery
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0scripts\recover-save.ps1"
if errorlevel 1 (
  echo Recovery did not complete. Please keep the original save and check the report.
  pause
  exit /b 1
)
exit /b 0
