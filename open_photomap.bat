@echo off
rem Opens Photo Map. If it is already running, only the browser is opened.
cd /d "%~dp0"
netstat -ano | findstr /R /C:":8712 .*LISTENING" >nul
if %errorlevel%==0 (
  start "" http://127.0.0.1:8712/
  goto :eof
)
call run.bat %*
