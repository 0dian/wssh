@echo off
REM Windows shim. wssh.js repairs the client-side console input mode itself (see
REM "The Windows client has the same bug" in the README), so the mouse does not
REM hinge on which host you launch from. Windows Terminal is still recommended.
setlocal
set "DIR=%~dp0"
if not defined WSSH_NODE set "WSSH_NODE=node"
"%WSSH_NODE%" "%DIR%wssh.js" %*
exit /b %ERRORLEVEL%
