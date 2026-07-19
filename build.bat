@echo off
rem Rebuilds the Windows executables into dist\
rem   MangaShelf Setup <version>.exe     - installer (auto-updates itself)
rem   MangaShelf-<version>-portable.exe  - single-file portable (no auto-update)
cd /d "%~dp0"
call npm run dist
if errorlevel 1 (
	echo.
	echo Build FAILED - see output above.
	pause
	exit /b 1
)
echo.
echo Build complete. Artifacts are in the dist\ folder.
pause
