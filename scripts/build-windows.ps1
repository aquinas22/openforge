$ErrorActionPreference = "Stop"

Write-Host "`nOpenforge Windows Builder" -ForegroundColor Green

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js was not found. Install Node.js 20 LTS or newer from https://nodejs.org, then reopen PowerShell."
}

$nodeMajor = [int]((node --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 20) {
  throw "Node.js 20 or newer is required. Found $(node --version)."
}

Set-Location (Resolve-Path (Join-Path $PSScriptRoot ".."))
$appVersion = node -p "require('./package.json').version"
Write-Host "Installing locked dependencies..."
npm ci

Write-Host "Checking TypeScript..."
npm run typecheck

Write-Host "Building Windows installer and portable executable..."
npm run dist

Write-Host "`nBuild complete. Files are in release\$appVersion\" -ForegroundColor Green
