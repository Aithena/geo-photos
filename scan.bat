@echo off
chcp 65001 >nul
cd /d "%~dp0"

set PYTHONIOENCODING=utf-8
echo 启动 Geo Photos 服务 http://127.0.0.1:18809
echo 浏览器将打开扫描进度界面…
start "" cmd /c "timeout /t 1 /nobreak >nul & start http://127.0.0.1:18809/scan.html?auto=1"
python scripts/serve.py --port 18809
if errorlevel 1 (
  echo.
  echo 启动失败。请确认已安装依赖：pip install -r requirements.txt
  echo 若端口被占用，请先结束旧的 python http.server / serve.py 进程。
  pause
)
