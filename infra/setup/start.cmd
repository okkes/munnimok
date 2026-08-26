@echo off
rem munni setup helper — double-click me. Starts the local helper server
rem (node infra/setup/serve.mjs) and opens the wizard in your browser;
rem the page can then run the whole local setup for you.
cd /d "%~dp0"
node serve.mjs
if errorlevel 1 (
  echo.
  echo The helper exited with an error. Is node installed and on PATH?
  pause
)
