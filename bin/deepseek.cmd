@echo off
setlocal
set "ENTRY=%~dp0..\dist\index.js"

if not exist "%ENTRY%" goto npm_bin
node "%ENTRY%" %*
exit /b %errorlevel%

:npm_bin
where wwhale >nul 2>nul
if errorlevel 1 goto missing
call wwhale %*
exit /b %errorlevel%

:missing
>&2 echo WEIPING_WHALE is not built and no installed wwhale binary was found on PATH.
>&2 echo Run npm ci ^&^& npm run build in the repository, or install weiping-whale globally.
exit /b 1
