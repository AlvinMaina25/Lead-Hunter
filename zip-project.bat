@echo off
setlocal EnableDelayedExpansion

REM ============================================================
REM  Alvin Lead Hunter - zip project (safe for sharing)
REM  Place this file in the project root (same folder as
REM  package.json) and double-click it.
REM
REM  Excludes: node_modules, .env (real secrets), .git, build
REM  output, logs, and other sensitive/junk files.
REM  Keeps:    .env.example
REM ============================================================

set "PROJECT_NAME=Alvin-Lead-Hunter"
set "SRC=%~dp0"
if "%SRC:~-1%"=="\" set "SRC=%SRC:~0,-1%"

REM Timestamp (locale-independent) via PowerShell
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmm"') do set "STAMP=%%i"

set "OUT=%SRC%\%PROJECT_NAME%_%STAMP%.zip"
set "STAGE=%TEMP%\%PROJECT_NAME%_stage_%STAMP%"

echo.
echo Packaging "%PROJECT_NAME%" ...
echo Source : %SRC%
echo Output : %OUT%
echo.

if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%"

REM ---- Copy everything except excluded folders/files ----------
REM /XD = exclude directories, /XF = exclude files
robocopy "%SRC%" "%STAGE%" /E /NFL /NDL /NJH /NJS /NP ^
  /XD node_modules .git .vscode .idea dist build coverage .next .cache logs tmp uploads secrets ^
  /XF .env .env.local .env.development .env.production .env.*.local ^
      *.pem *.key *.p12 *.pfx *.crt *.cer id_rsa id_rsa.pub ^
      *.log *.sqlite *.sqlite3 *.db *.sql.bak ^
      credentials.json service-account*.json *.zip .DS_Store Thumbs.db

REM Robocopy exit codes 0-7 are success, 8+ are errors
if %ERRORLEVEL% GEQ 8 (
  echo ERROR: Copy step failed.
  rmdir /s /q "%STAGE%"
  pause
  exit /b 1
)

REM ---- Remove old zip with same name if present ---------------
if exist "%OUT%" del /q "%OUT%"

REM ---- Create the zip -----------------------------------------
powershell -NoProfile -Command "Compress-Archive -Path '%STAGE%\*' -DestinationPath '%OUT%' -CompressionLevel Optimal"

if errorlevel 1 (
  echo ERROR: Zip creation failed.
  rmdir /s /q "%STAGE%"
  pause
  exit /b 1
)

REM ---- Cleanup ------------------------------------------------
rmdir /s /q "%STAGE%"

echo.
echo Done! Created:
echo   %OUT%
echo.
echo Excluded: node_modules, .env files, .git, keys/certs, logs, local DBs.
echo.
pause
endlocal
