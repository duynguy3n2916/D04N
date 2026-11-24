# Chạy hệ thống trên Windows (PowerShell), từ bất kỳ thư mục nào:
#   .\scripts\run.ps1            # chạy server ở http://localhost:8000
#   .\scripts\run.ps1 -Reload    # tự khởi động lại khi sửa code backend (chậm hơn một chút)
#   .\scripts\run.ps1 -Port 8001
#   .\scripts\run.ps1 -Lan       # mở cho máy khác cùng Wi-Fi (app điện thoại mobile/ cần cái này)
# Nếu mã giao diện (frontend/src) mới hơn bản build (frontend/dist) và máy có Node.js,
# script tự build lại để lúc nào cũng chạy giao diện mới nhất.
param([switch]$Reload, [int]$Port = 8000, [switch]$Lan)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
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

# Server cũ còn chạy ngầm (cửa sổ khác / lần chạy trước) sẽ chiếm cổng: tắt nó nếu là server của dự án này.
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    $procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'uvicorn' -and $_.CommandLine -match 'app\.main:app' }
    $owners = $busy | ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" }
    $foreign = $owners | Where-Object { $_.Name -notmatch '^python' }
    if ($foreign) {
        Write-Host "Cổng $Port đang bị chương trình khác dùng ($($foreign.Name -join ', ')). Tắt nó hoặc chạy: .\scripts\run.ps1 -Port 8001" -ForegroundColor Red
        exit 1
    }
    $ids = @($procs.ProcessId) + @($owners.ProcessId) | Where-Object { $_ } | Sort-Object -Unique
    $children = Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ParentProcessId }
    $ids = @($ids) + @($children.ProcessId) | Where-Object { $_ } | Sort-Object -Unique
    Write-Host "Tắt server cũ đang chạy ở cổng $Port..." -ForegroundColor Yellow
    $ids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800
}

Set-Location (Join-Path $root "ai-backend")
foreach ($venv in ".venv", "venv") {
    $activate = Join-Path $venv "Scripts\Activate.ps1"
    if (Test-Path $activate) { . $activate; break }
}
$uvicornArgs = @("app.main:app", "--port", $Port)
if ($Reload) { $uvicornArgs += @("--reload", "--reload-dir", "app") }
if ($Lan) {
    $uvicornArgs += @("--host", "0.0.0.0")
    $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -ExpandProperty IPAddress
    foreach ($ip in $ips) { Write-Host "Điện thoại cùng Wi-Fi nhập địa chỉ máy chủ: $($ip):$Port" -ForegroundColor Cyan }
    Write-Host "Nếu điện thoại không kết nối được: cho phép Python qua Windows Firewall (mạng Private)." -ForegroundColor Yellow
}
Write-Host "Mở http://localhost:$Port (Ctrl+C để dừng)" -ForegroundColor Green
python -m uvicorn @uvicornArgs
