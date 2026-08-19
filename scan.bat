@echo off
chcp 65001 >nul
cd /d "%~dp0"

set PYTHONIOENCODING=utf-8
set PYTHONUNBUFFERED=1
set "PORT=18809"
set "URL=http://127.0.0.1:%PORT%/scan.html?auto=1"

echo 启动 Geo Photos 服务 http://127.0.0.1:%PORT%/
echo 请保持本窗口打开，关闭窗口会停止服务。
echo.

REM 端口已在监听：直接打开浏览器，避免二次启动失败
powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', %PORT%); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 (
  echo 服务已在运行，正在打开扫描页…
  start "" "%URL%"
  goto :eof
)

REM 等端口就绪后再打开浏览器（避免 1 秒就打开导致无法访问）
start "" powershell -NoProfile -Command "for ($i=0; $i -lt 80; $i++) { $c = New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1', %PORT%); $c.Close(); Start-Process '%URL%'; exit 0 } catch { Start-Sleep -Milliseconds 250 } }; exit 1"

set "PYEXE="
py -3 --version >nul 2>&1
if not errorlevel 1 set "PYEXE=py -3"
if not defined PYEXE (
  python --version >nul 2>&1
  if not errorlevel 1 set "PYEXE=python"
)

if not defined PYEXE (
  echo 未找到 Python。
  echo 请安装 Python 3，并勾选 "Add python.exe to PATH"。
  echo 安装后重新打开本窗口，或执行：pip install -r requirements.txt
  pause
  exit /b 1
)

%PYEXE% scripts\serve.py --port %PORT%
if errorlevel 1 (
  echo.
  echo 启动失败。请确认已安装依赖：pip install -r requirements.txt
  echo 若端口被占用，请先结束旧的 python / serve.py 进程。
  pause
)
