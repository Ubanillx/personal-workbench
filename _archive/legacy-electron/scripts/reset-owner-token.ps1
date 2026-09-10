param(
  [switch]$Confirm
)

$ErrorActionPreference = "Stop"

if (-not $Confirm) {
  throw "This revokes all owner tokens and sessions. Run: powershell -ExecutionPolicy Bypass -File scripts/reset-owner-token.ps1 -Confirm"
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$managedNvmNode = Join-Path $env:LOCALAPPDATA "nvm\v22.22.2\node.exe"
$nvmNode = @($managedNvmNode, $env:NVM_SYMLINK, "C:\nvm4w\nodejs") | Where-Object { $_ } | ForEach-Object { if ($_.EndsWith("node.exe")) { $_ } else { Join-Path $_ "node.exe" } } | Where-Object { Test-Path $_ } | Select-Object -First 1
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nvmNode) { $nvmNode } elseif ($nodeCommand) { $nodeCommand.Source } else { throw "Node.js was not found. Run nvm use 22.22.2, then open a new PowerShell window." }
$nodeVersionText = & $nodePath -p "process.versions.node"
$nodeVersion = [version]$nodeVersionText

if ($nodeVersion -lt [version]"22.5.0") {
  throw "Node.js >=22.5.0 is required; current version is $nodeVersion. Run nvm use 22.22.2."
}

Push-Location $projectRoot
try {
  & $nodePath --import tsx scripts/reset-owner-token.ts --confirm
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
