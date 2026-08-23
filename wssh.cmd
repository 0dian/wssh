@echo off
REM Windows shim. MUST be run from Windows Terminal (or another VT-capable host);
REM the legacy conhost window reproduces the very mouse bug this tool works around.
setlocal
set "DIR=%~dp0"
if not defined WSSH_NODE set "WSSH_NODE=node"
"%WSSH_NODE%" "%DIR%wssh.js" %*
exit /b %ERRORLEVEL%
