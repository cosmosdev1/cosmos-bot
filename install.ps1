# Cosmos bot installer (Windows PowerShell).
#   $env:COSMOS_TOKEN="csk_..."; irm https://try-cosmos.com/bot/install.ps1 | iex
$ErrorActionPreference = "Stop"
$Repo = "https://github.com/cosmosdev1/cosmos-bot.git"
$dir = Join-Path $HOME "cosmos-bot"

Write-Host "`n  Installing the Cosmos bot...`n"
try { node -v | Out-Null } catch { Write-Host "  Node.js 18+ required: https://nodejs.org/"; exit 1 }
try { git --version | Out-Null } catch { Write-Host "  git required: https://git-scm.com/"; exit 1 }

if (Test-Path $dir) { Set-Location $dir; git pull --quiet } else { git clone --quiet $Repo $dir; Set-Location $dir }
npm install --silent

# Configure (uses $env:COSMOS_TOKEN, asks only for your Polymarket key), then start trading.
node src/setup.mjs
if (Test-Path "./config.json") {
  # Restart loop: the bot exits cleanly after a self-update; pull + relaunch so local installs
  # stay current instead of dying on every code push (the launcher contract).
  $env:COSMOS_LAUNCHER = "1"
  while ($true) {
    node src/bot.mjs
    Start-Sleep -Seconds 3
    git pull --quiet 2>$null
    npm install --silent 2>$null
    Write-Host "[launcher] restarting bot..."
  }
}
