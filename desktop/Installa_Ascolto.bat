@echo off
title Kestra Desktop - Installa ascolto dal microfono
cd /d "%~dp0"
echo Installo i componenti per ascoltare "Kestra" dal microfono del PC (una volta sola)...
echo.

set "PY="
if exist "%LOCALAPPDATA%\Python\bin\python.exe" set "PY=%LOCALAPPDATA%\Python\bin\python.exe"
if not defined PY (
    for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
        if exist "%%D\python.exe" set "PY=%%D\python.exe"
    )
)
if not defined PY set "PY=py"

"%PY%" -m pip install --upgrade faster-whisper sounddevice numpy
if %errorlevel% neq 0 (
    echo.
    echo Installazione non riuscita. Controlla la connessione e riprova.
    pause
    exit /b 1
)
echo.
echo Fatto. Apri Kestra Desktop e attiva la casella "Ascolta Kestra dal microfono del PC".
echo La prima volta scarica il modello vocale (circa 500 MB): ci vuole qualche minuto.
pause
