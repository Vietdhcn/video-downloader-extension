@echo off
rem ExecutionPolicy Bypass chi ap dung cho lan chay nay, khong doi cai dat bao mat cua may.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0youtube\setup-youtube.ps1" %*
if errorlevel 1 echo Setup failed. See the error above.
pause
