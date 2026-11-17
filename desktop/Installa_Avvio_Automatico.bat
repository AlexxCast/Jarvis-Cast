@echo off
title Jarvis Desktop - Installazione Avvio Automatico in Background
cd /d "%~dp0"

set "PYW=%LOCALAPPDATA%\Python\bin\pythonw.exe"
if not exist "%PYW%" (
    for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
        if exist "%%D\pythonw.exe" set "PYW=%%D\pythonw.exe"
    )
)

reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "JarvisDesktop" /t REG_SZ /d "\"%PYW%\" \"%~dp0jarvis_desktop.py\" --bg" /f >nul
start "" "%PYW%" "%~dp0jarvis_desktop.py" --bg

echo.
echo [OK] Servizio in background di Jarvis Desktop attivato e impostato all'avvio di Windows!
echo Anche se chiudi la finestra o riavvii il PC, Jarvis rispondera sempre da remoto.
timeout /t 4 >nul
