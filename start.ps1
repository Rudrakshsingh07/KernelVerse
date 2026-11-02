$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (-not (Test-Path "api\.venv\Scripts\python.exe")) {
    python -m venv api\.venv
    & "api\.venv\Scripts\pip.exe" install -r api\requirements.txt
}

if (-not (Test-Path "web\node_modules")) {
    Push-Location web
    npm install
    Pop-Location
}

Write-Host "Starting KernelVerse API on http://127.0.0.1:8000 ..."
$api = Start-Process -FilePath "api\.venv\Scripts\python.exe" `
  -ArgumentList "-m","uvicorn","app.main:app","--host","127.0.0.1","--port","8000","--reload" `
  -WorkingDirectory (Join-Path $root "api") -PassThru

Write-Host "Starting KernelVerse Web on http://127.0.0.1:3000 ..."
$web = Start-Process -FilePath "npm.cmd" -ArgumentList "run","dev" `
  -WorkingDirectory (Join-Path $root "web") -PassThru

Write-Host ""
Write-Host "App: http://127.0.0.1:3000"
Write-Host "API docs: http://127.0.0.1:8000/docs"
Write-Host "Press Enter to stop both servers."
[void][System.Console]::ReadLine()

Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue
Stop-Process -Id $web.Id -Force -ErrorAction SilentlyContinue
Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
