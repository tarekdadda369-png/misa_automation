# MISA Dashboard (port 3050) + ngrok public URL
# Usage:
#   .\start-dashboard-ngrok.ps1
#   .\start-dashboard-ngrok.ps1 -Domain "your-subdomain.ngrok-free.app"

param(
    [int]$Port = 3050,
    [string]$Domain = ""
)

Set-Location $PSScriptRoot

Write-Host "============================================================"
Write-Host " MISA Dashboard + ngrok"
Write-Host " Local: http://localhost:$Port"
Write-Host "============================================================"

if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    Write-Error "pm2 not found. Run: npm install -g pm2"
    exit 1
}

$running = pm2 describe misa-dashboard 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Starting misa-dashboard..."
    pm2 start ecosystem.config.js
} else {
    Write-Host "Restarting misa-dashboard..."
    pm2 restart misa-dashboard
}

Start-Sleep -Seconds 2

$configPath = Join-Path $PSScriptRoot "server-config.json"
if (Test-Path $configPath) {
    $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
    Write-Host "API key (server-config.json): $($cfg.apiKey)"
}

if (-not (Get-Command ngrok -ErrorAction SilentlyContinue)) {
    Write-Error "ngrok not in PATH. Install from https://ngrok.com/download"
    exit 1
}

Write-Host ""
Write-Host "Starting ngrok → localhost:$Port"
if ($Domain) {
    ngrok http $Port --domain=$Domain
} else {
    ngrok http $Port
}
