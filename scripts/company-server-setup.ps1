# Company IT — one-time setup on Windows Server / dedicated PC
# Run as Administrator from playwright-cli folder:
#   powershell -ExecutionPolicy Bypass -File .\scripts\company-server-setup.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host "=== MISA Automation Runner — Company Server Setup ===" -ForegroundColor Cyan
Write-Host "Folder: $Root`n"

# Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Node.js not found. Install Node 20 LTS from https://nodejs.org" -ForegroundColor Red
    exit 1
}
Write-Host "Node: $(node -v)"

# npm install
Write-Host "`nInstalling npm packages..."
npm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Installing Playwright Chromium..."
npx playwright install chromium
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# .env from example
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "`nCreated .env from .env.example — edit OPENAI_API_KEY before production runs." -ForegroundColor Yellow
} else {
    Write-Host "`.env already exists — not overwritten."
}

# folders
@("uploads", "logs") | ForEach-Object {
    if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ | Out-Null }
}

# PM2
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    Write-Host "`nInstalling PM2 globally..."
    npm install -g pm2
}

Write-Host "`nStarting dashboard (first run creates server-config.json)..."
pm2 delete misa-dashboard 2>$null
pm2 start ecosystem.config.js
pm2 save

Write-Host "`n=== Next steps for IT ===" -ForegroundColor Green
Write-Host "1. Edit .env — set OPENAI_API_KEY and RUN_AI_FALLBACK=1"
Write-Host "2. Open server-config.json — copy apiKey for dev team (secure channel)"
Write-Host "3. pm2 restart misa-dashboard"
Write-Host "4. Health check: http://localhost:3050/api/v1/health"
Write-Host "5. Enable PM2 on reboot:"
Write-Host "     npm install -g pm2-windows-startup"
Write-Host "     pm2-startup install"
Write-Host "     pm2 save"
Write-Host "6. HTTPS reverse proxy or firewall rule for port 3050"
Write-Host "7. Keep server logged in (RDP) for headed Playwright"
Write-Host "`nDevs: read EXTERNAL-API.md`n"
