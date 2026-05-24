# Build zip for company handoff (excludes secrets and heavy folders)
# Run from playwright-cli: powershell -File .\scripts\package-for-company.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$OutDir = Join-Path $Root "dist"
$ZipName = "misa-automation-handoff-$(Get-Date -Format 'yyyyMMdd').zip"
$ZipPath = Join-Path $OutDir $ZipName

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$Stage = Join-Path $OutDir "misa-automation-stage"
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Path $Stage | Out-Null

$ExcludeDirs = @('node_modules', 'uploads', 'test-results', 'logs', 'dist', '.git')
$ExcludeFiles = @('.env', 'config.json', 'server-config.json')
$ExcludePatterns = @('config_*.json', 'otp_session*.json')

Get-ChildItem $Root -Force | ForEach-Object {
    $name = $_.Name
    if ($ExcludeDirs -contains $name) { return }
    if ($_.PSIsContainer) {
        Copy-Item $_.FullName -Destination (Join-Path $Stage $name) -Recurse -Force
    } elseif ($ExcludeFiles -notcontains $name -and $name -notlike 'config_*' -and $name -notlike 'otp_session*') {
        Copy-Item $_.FullName -Destination (Join-Path $Stage $name) -Force
    }
}

# Prune nested junk if copied
@('node_modules', 'uploads', 'test-results', 'logs') | ForEach-Object {
    $p = Join-Path $Stage $_
    if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}

if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
Compress-Archive -Path (Join-Path $Stage '*') -DestinationPath $ZipPath -Force
Remove-Item $Stage -Recurse -Force

Write-Host "Created: $ZipPath" -ForegroundColor Green
Write-Host "Send this zip to company IT with RENDER.md instructions."
