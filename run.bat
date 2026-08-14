@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment...
  python -m venv .venv || goto :error
  .venv\Scripts\python.exe -m pip install -r requirements.txt || goto :error
)
.venv\Scripts\python.exe serve.py --lan %*
goto :eof

:error
echo.
echo Setup failed. Check that Python 3.10+ is on PATH.
pause
