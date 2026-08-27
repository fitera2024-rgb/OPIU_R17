@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0ui_loader.ps1"
if errorlevel 1 (
  echo.
  echo OPIU interface could not be started.
  pause
)
endlocal
