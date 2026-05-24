# Run after you created an empty repo on https://github.com/new
# Example: powershell -ExecutionPolicy Bypass -File .\scripts\push-to-github.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host "=== Push MISA automation to YOUR GitHub ===" -ForegroundColor Cyan

if (-not (Test-Path .env)) {
    Write-Host "Note: .env not found — create it locally for tests (never uploaded)." -ForegroundColor Yellow
}

$ignoreCheck = git check-ignore -v .env 2>$null
if ($ignoreCheck) {
    Write-Host "OK: .env is ignored by git — will NOT upload." -ForegroundColor Green
} else {
    Write-Host "WARNING: .env is NOT ignored! Stop and fix .gitignore" -ForegroundColor Red
    exit 1
}

git add .
$status = git status --porcelain
if ($status -match '(?m)^[AMRD][AMRD]? \.env$') {
    Write-Host "ERROR: .env is staged! Aborting." -ForegroundColor Red
    git reset HEAD .env 2>$null
    exit 1
}

$pending = git diff --cached --name-only
if (-not $pending) {
    Write-Host "Nothing new to commit (already committed?)." -ForegroundColor Yellow
} else {
    git commit -m "MISA automation runner — Render deploy + external API"
    Write-Host "Committed $($pending.Count) file(s)." -ForegroundColor Green
}

$repoUrl = Read-Host "Paste your GitHub repo URL (e.g. https://github.com/tarek/misa-automation.git)"
if (-not $repoUrl) { Write-Host "No URL — stopped."; exit 1 }
if ($repoUrl -notmatch '\.git$') { $repoUrl = $repoUrl.TrimEnd('/') + '.git' }

git remote remove origin 2>$null
git remote add origin $repoUrl
git branch -M main

Write-Host "Pushing to $repoUrl ..." -ForegroundColor Cyan
git push -u origin main

if ($LASTEXITCODE -eq 0) {
    $web = $repoUrl -replace '\.git$',''
    Write-Host "`nDone! Send IT this link:" -ForegroundColor Green
    Write-Host $web
} else {
    Write-Host "`nPush failed — log in to GitHub (browser) or use GitHub Desktop." -ForegroundColor Red
    Write-Host "Repo is committed locally; retry: git push -u origin main"
}
