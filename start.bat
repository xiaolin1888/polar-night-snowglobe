@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 极夜雪境 - 本地服务

set "PORT=8940"
set "PY="

python -c "import sys" >nul 2>&1 && set "PY=python"
if not defined PY py -3 -c "import sys" >nul 2>&1 && set "PY=py -3"
if not defined PY (
  for /d %%V in ("%USERPROFILE%\.dsh\dsh-runtimes\*\dependencies\python") do (
    if exist "%%V\python.exe" set "PY=%%V\python.exe"
  )
)
if not defined PY goto NOPY

echo.
echo   极夜雪境 - 水晶球
echo   启动中... 端口 %PORT%
echo.

start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 80;$i++){ try{ $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',%PORT%); $c.Close(); Start-Process ('http://127.0.0.1:%PORT%/index.html'); exit }catch{ Start-Sleep -Milliseconds 250 } }"

%PY% serve.py %PORT% .
echo.
echo   服务已停止。按任意键关闭。
pause >nul
exit /b 0

:NOPY
echo   未检测到 Python 3，无法启动。
echo   请安装 Python 3 并勾选 "Add to PATH"。
pause
exit /b 1