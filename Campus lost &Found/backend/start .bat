@echo off
cd /d "%~dp0"
echo Installing packages...
call npm install
echo.
echo Starting CampusFind server...
node server.js
pause
