@echo off
title Jarvis Desktop - Avvio
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
    start "" pythonw jarvis_desktop.py
    exit /b 0
)

if exist "%LOCALAPPDATA%\Python\bin\python.exe" (
    start "" "%LOCALAPPDATA%\Python\bin\python.exe" jarvis_desktop.py
    exit /b 0
)

echo Python non trovato nel PATH. Avvio con py...
py jarvis_desktop.py
