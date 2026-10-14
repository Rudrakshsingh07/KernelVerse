@echo off
setlocal
cd /d "%~dp0"

if not exist "api\.venv\Scripts\python.exe" (
  echo Creating Python virtualenv and installing backend deps...
  python -m venv api\.venv
  api\.venv\Scripts\pip install -r api\requirements.txt
)

if not exist "web\node_modules" (
  echo Installing frontend deps...
  pushd web
  call npm install
  popd
)

echo Starting KernelVerse...
start "KernelVerse API" cmd /k "cd /d %~dp0api && .venv\Scripts\activate && uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload"
start "KernelVerse Web" cmd /k "cd /d %~dp0web && npm run dev"

echo.
echo Open http://127.0.0.1:3000 (app) and http://127.0.0.1:8000/docs (API)
endlocal
