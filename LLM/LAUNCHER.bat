@echo off
chcp 65001 >nul

REM Change to script directory
cd /d "%~dp0"

REM Find Python executable
set PYTHON_EXE=python

REM Check if python is in PATH
python --version >nul 2>&1
if errorlevel 1 (
    REM Check common Python install locations
    for %%P in (
        "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
        "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
        "%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
        "%LOCALAPPDATA%\Programs\Python\Python39\python.exe"
        "%LOCALAPPDATA%\Programs\Python\Python38\python.exe"
        "C:\Python312\python.exe"
        "C:\Python311\python.exe"
        "C:\Python310\python.exe"
        "C:\Python39\python.exe"
        "C:\Python38\python.exe"
        "%ProgramFiles%\Python312\python.exe"
        "%ProgramFiles%\Python311\python.exe"
        "%ProgramFiles%\Python310\python.exe"
        "%ProgramFiles%\Python39\python.exe"
        "%ProgramFiles%\Python38\python.exe"
    ) do (
        if exist %%P (
            set PYTHON_EXE=%%P
            goto :python_found
        )
    )
    
    REM Python not found anywhere
    msg * "Python not found! Please install Python 3.8+ from: https://www.python.org/downloads/ and check 'Add Python to PATH' during installation."
    exit /b 1
)

:python_found

REM Call LAUNCHER.py which has all the new state management and resume logic
"%PYTHON_EXE%" LAUNCHER.py

exit /b %ERRORLEVEL%
