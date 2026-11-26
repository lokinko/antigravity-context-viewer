@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>&1
cd /d "%~dp0"

set "NONINTERACTIVE=0"
if /i "%AG_NONINTERACTIVE%"=="1" set "NONINTERACTIVE=1"
for %%A in (%*) do (
  if /i "%%~A"=="--yes" set "NONINTERACTIVE=1"
  if /i "%%~A"=="-y" set "NONINTERACTIVE=1"
)

if exist "%~dp0cli.js" goto :CLI_OK
echo [错误] 未找到 cli.js，请先将压缩包完整解压后再运行 uninstall.bat。
if "%NONINTERACTIVE%"=="0" pause
exit /b 1

:CLI_OK
call :FIND_RUNTIME
if not errorlevel 1 goto :RUNTIME_OK
if "%NONINTERACTIVE%"=="0" pause
exit /b 1

:RUNTIME_OK
:RUN_RESTORE
set "LAST_LOG=%TEMP%\ag-meter-restore-%RANDOM%-%RANDOM%.log"
echo.
if "%USE_ELECTRON%"=="1" echo [环境] 未检测到独立 Node.js ^(>=18^)，已自动复用 Antigravity 内置运行时执行卸载...
if not "%USE_ELECTRON%"=="1" echo [环境] 使用运行时: %NODE_EXE% ^(Node %NODE_VER%^)
echo [卸载] 正在无损还原 Antigravity app.asar...
call :EXEC_JS "cli.js" restore %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" goto :HANDLE_ERROR
echo.
echo [成功] 已还原原始 Antigravity 文件。
echo        完全退出并重新打开 Antigravity 后生效。
goto :DONE

:HANDLE_ERROR
echo.
findstr /i /c:"锁定" /c:"EBUSY" /c:"被占用" "%LAST_LOG%" >nul 2>&1
if errorlevel 1 goto :CHECK_PERM_ERR
echo [提示] Antigravity 当前仍在后台运行并锁定了 app.asar。
echo        请右键点击屏幕右下角系统托盘里的 Antigravity 图标 -^> 退出（Quit），确认进程已关闭。
if "%NONINTERACTIVE%"=="1" goto :DONE_ERR
set "RETRY="
set /p "RETRY=关闭后输入 Y 并按回车重试，直接按回车退出: "
if /i not "%RETRY%"=="Y" goto :DONE_ERR
del /f /q "%LAST_LOG%" >nul 2>&1
goto :RUN_RESTORE

:CHECK_PERM_ERR
findstr /i /c:"权限不足" /c:"管理员身份" /c:"EPERM" /c:"EACCES" "%LAST_LOG%" >nul 2>&1
if errorlevel 1 goto :GENERIC_ERR
echo [提示] 目标目录需要管理员权限才能写入（常见于 C:\Program Files 下的安装）。
if "%NONINTERACTIVE%"=="1" goto :DONE_ERR
set "ELEV="
set /p "ELEV=是否立即申请管理员权限重新运行？[Y/N]: "
if /i not "%ELEV%"=="Y" goto :DONE_ERR
del /f /q "%LAST_LOG%" >nul 2>&1
powershell -NoProfile -Command "Start-Process -FilePath 'cmd.exe' -Verb RunAs -ArgumentList '/c','cd /d \"%~dp0\" && \"%~f0\" %*'"
exit /b 0

:GENERIC_ERR
echo [失败] 卸载退出，错误码 %EXIT_CODE%。请检查上方报错提示后重试。

:DONE_ERR
del /f /q "%LAST_LOG%" >nul 2>&1
if "%NONINTERACTIVE%"=="0" pause
exit /b %EXIT_CODE%

:DONE
del /f /q "%LAST_LOG%" >nul 2>&1
if "%NONINTERACTIVE%"=="0" pause
exit /b 0

:EXEC_JS
setlocal EnableDelayedExpansion
set "JS_ENTRY=%~1"
shift
set "JS_ARGS="
:ARG_LOOP
if "%~1"=="" goto :ARGS_READY
set "JS_ARGS=!JS_ARGS! %1"
shift
goto :ARG_LOOP
:ARGS_READY
set "RUN_LOG=%LAST_LOG%"
if "%RUN_LOG%"=="" set "RUN_LOG=%TEMP%\ag-meter-exec-%RANDOM%.log"
if "%USE_ELECTRON%"=="1" (
  cmd /c "set ELECTRON_RUN_AS_NODE=1&& ^"%NODE_EXE%^" ^"%JS_ENTRY%^"!JS_ARGS! > ^"%RUN_LOG%^" 2>&1"
  set "RC=!ERRORLEVEL!"
) else (
  "%NODE_EXE%" "%JS_ENTRY%"!JS_ARGS! > "%RUN_LOG%" 2>&1
  set "RC=!ERRORLEVEL!"
)
if exist "%RUN_LOG%" type "%RUN_LOG%"
endlocal & exit /b %RC%

:FIND_RUNTIME
set "NODE_EXE="
set "NODE_VER="
set "USE_ELECTRON=0"

if /i "%AG_FORCE_ELECTRON_RUNTIME%"=="1" goto :FIND_ELECTRON

for /f "delims=" %%P in ('where node 2^>nul') do (
  call :TEST_NODE "%%~fP"
  if not errorlevel 1 goto :EOF
)

for %%P in (
  "%ProgramFiles%\nodejs\node.exe"
  "%ProgramFiles(x86)%\nodejs\node.exe"
  "%LOCALAPPDATA%\Programs\nodejs\node.exe"
  "%NVM_SYMLINK%\node.exe"
  "%USERPROFILE%\.volta\bin\node.exe"
  "%LOCALAPPDATA%\Volta\bin\node.exe"
  "%APPDATA%\Antigravity\bin\agy-node.cmd"
) do (
  if exist "%%~fP" (
    call :TEST_NODE "%%~fP"
    if not errorlevel 1 goto :EOF
  )
)

for /d %%D in ("%LOCALAPPDATA%\Programs\nodejs\node-*") do (
  if exist "%%~fD\node.exe" (
    call :TEST_NODE "%%~fD\node.exe"
    if not errorlevel 1 goto :EOF
  )
)

for /d %%D in ("%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*") do (
  if exist "%%~fD\bin\node.exe" (
    call :TEST_NODE "%%~fD\bin\node.exe"
    if not errorlevel 1 goto :EOF
  )
)

:FIND_ELECTRON
set "AG_EXE="
for %%P in (
  "%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe"
  "%LOCALAPPDATA%\Programs\Antigravity IDE\Antigravity IDE.exe"
  "%LOCALAPPDATA%\Programs\Antigravity IDE\Antigravity.exe"
  "%LOCALAPPDATA%\Programs\Google Antigravity\Antigravity.exe"
  "%ProgramFiles%\antigravity\Antigravity.exe"
  "%ProgramFiles%\Antigravity IDE\Antigravity IDE.exe"
  "%ProgramFiles%\Google Antigravity\Antigravity.exe"
) do (
  if not defined AG_EXE if exist "%%~fP" set "AG_EXE=%%~fP"
)

if defined AG_EXE goto :ELECTRON_FOUND
for %%H in ("HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall" "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall" "HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall") do (
  if not defined AG_EXE (
    for /f "tokens=2,*" %%A in ('reg query %%~H /s /f "Antigravity" 2^>nul ^| findstr /i "InstallLocation"') do (
      if not defined AG_EXE if exist "%%~B\Antigravity.exe" set "AG_EXE=%%~B\Antigravity.exe"
      if not defined AG_EXE if exist "%%~B\Antigravity IDE.exe" set "AG_EXE=%%~B\Antigravity IDE.exe"
    )
  )
)

:ELECTRON_FOUND
if not defined AG_EXE goto :NO_RUNTIME
set "NODE_EXE=%AG_EXE%"
set "NODE_VER=24-electron"
set "USE_ELECTRON=1"
exit /b 0

:NO_RUNTIME
echo [缺少依赖] 未检测到可用 Node.js ^(>=18^) 与 Antigravity 客户端，无法执行卸载。
echo 请先安装 Node.js 22+ ^(https://nodejs.org/^) 或安装 Antigravity 后再运行本脚本。
exit /b 1

:TEST_NODE
set "CAND=%~1"
set "VER="
for /f "delims=" %%V in ('"%CAND%" -p "process.versions.node" 2^>nul') do set "VER=%%V"
if not defined VER exit /b 1
for /f "tokens=1 delims=." %%M in ("%VER%") do set "MAJ=%%M"
if not defined MAJ exit /b 1
if %MAJ% LSS 18 exit /b 1
set "NODE_EXE=%CAND%"
set "NODE_VER=%VER%"
set "USE_ELECTRON=0"
exit /b 0
