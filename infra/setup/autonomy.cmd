@echo off
rem started at logon by the wizard's "Run the helper at logon" task: no browser tab; with automatic
rem updates on it keeps the local family current (the PC's counterpart of the NAS deploy poller)
cd /d "%~dp0"
set SETUP_NO_OPEN=1
node serve.mjs
