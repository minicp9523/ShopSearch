@echo off
setlocal
cd /d "%~dp0"
".venv\Scripts\python.exe" -u main.py
echo.
echo Program finished. Press any key to close this window.
pause >nul
