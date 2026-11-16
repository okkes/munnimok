@echo off
cd /d "%~dp0"
node serve.mjs
if errorlevel 1 (
  echo.
  echo The helper exited with an error — read the message above.
  echo ^(If node itself was not found: install Node 24+ or put it on PATH.^)
  pause
)
