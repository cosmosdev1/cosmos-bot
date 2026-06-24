# Cosmos bot installer (Windows PowerShell).
# Set $Repo to your cosmos-bot repo, then:  irm https://.../install.ps1 | iex
$ErrorActionPreference = "Stop"
$Repo = "https://github.com/<your-org>/cosmos-bot.git"
$dir = Join-Path $HOME "cosmos-bot"

Write-Host "`n  Installing the Cosmos bot to $dir`n"
try { node -v | Out-Null } catch { Write-Host "  Node.js 18+ required: https://nodejs.org/"; exit 1 }
try { git --version | Out-Null } catch { Write-Host "  git required: https://git-scm.com/"; exit 1 }

if (Test-Path $dir) { Set-Location $dir; git pull --quiet } else { git clone --quiet $Repo $dir; Set-Location $dir }
npm install --silent

Write-Host "`n  Done. Next:`n"
Write-Host "    cd $dir"
Write-Host "    npm run setup"
Write-Host "    npm start`n"
