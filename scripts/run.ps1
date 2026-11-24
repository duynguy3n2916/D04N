# Chạy hệ thống trên Windows (PowerShell), từ bất kỳ thư mục nào:
#   .\scripts\run.ps1            # chạy server ở http://localhost:8000
#   .\scripts\run.ps1 -Reload    # tự khởi động lại khi sửa code backend (chậm hơn một chút)
#   .\scripts\run.ps1 -Port 8001
# Nếu mã giao diện (frontend/src) mới hơn bản build (frontend/dist) và máy có Node.js,
# script tự build lại để lúc nào cũng chạy giao diện mới nhất.
param([switch]$Reload, [int]$Port = 8000)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Push-Location $root
try {
    $srcTime  = [int](git log -1 --format=%ct -- frontend/src 2>$null)
    $distTime = [int](git log -1 --format=%ct -- frontend/dist 2>$null)
    $srcDirty = git status --porcelain -- frontend/src 2>$null
    if (($srcTime -gt $distTime) -or $srcDirty) {
        if (Get-Command npm -ErrorAction SilentlyContinue) {
            Write-Host "Giao diện có thay đổi chưa build, đang build lại frontend/dist..." -ForegroundColor Yellow
            Push-Location frontend
            if (-not (Test-Path node_modules)) { npm install --no-audit --no-fund }
            npm run build
            Pop-Location
        } else {
            Write-Host "frontend/src mới hơn frontend/dist nhưng máy chưa có Node.js: giao diện có thể là bản cũ." -ForegroundColor Yellow
        }
    }
} finally { Pop-Location }

Set-Location (Join-Path $root "ai-backend")
foreach ($venv in ".venv", "venv") {
    $activate = Join-Path $venv "Scripts\Activate.ps1"
    if (Test-Path $activate) { . $activate; break }
}
$uvicornArgs = @("app.main:app", "--port", $Port)
if ($Reload) { $uvicornArgs += @("--reload", "--reload-dir", "app") }
Write-Host "Mở http://localhost:$Port (Ctrl+C để dừng)" -ForegroundColor Green
python -m uvicorn @uvicornArgs
