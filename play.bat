@echo off
REM Double-click this to start Spellforge. Reads your key from the .env file.
cd /d "%~dp0"
echo Starting Spellforge...
echo Once it says "running", open http://localhost:5273 in your browser.
echo (Close this window to stop the game.)
echo.
node server.js
echo.
echo Server stopped. Press any key to close.
pause >nul
