@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed or not on PATH.
  echo Install it from https://nodejs.org/ ^(version 18.15 or newer^) and try again.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kill-existing.ps1" >nul 2>nul

start "Xenon Edge Widget" /min node "%~dp0server.js"
