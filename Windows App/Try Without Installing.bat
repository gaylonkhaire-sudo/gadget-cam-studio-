@echo off
title Gadget Cam Studio
cd /d "%~dp0"
if not exist node_modules (
  echo Installing (first time only)...
  call npm install || (echo Install failed. & pause & exit /b 1)
)
call npm start
