@echo off
title Jarvis Desktop - Avvio
cd /d "%~dp0"

if exist "%LOCALAPPDATA%\Python\bin\pythonw.exe" (
    start "" "%LOCALAPPDATA%\Python\bin\pythonw.exe" "%~dp0jarvis_desktop.py"
    exit /b 0
)

if exist "%LOCALAPPDATA%\Python\bin\python.exe" (
    start "" "%LOCALAPPDATA%\Python\bin\python.exe" "%~dp0jarvis_desktop.py"
    exit /b 0
)

for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
    if exist "%%D\pythonw.exe" (
        start "" "%%D\pythonw.exe" "%~dp0jarvis_desktop.py"
        exit /b 0
    )
)

py "%~dp0jarvis_desktop.py"
if %errorlevel% neq 0 (
    echo Non trovo Python. Premi un tasto per chiudere.
    pause >nul
)
