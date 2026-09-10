$ErrorActionPreference = "Stop"

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

$formalListeners = Get-NetTCPConnection -State Listen -LocalPort 17500 -ErrorAction SilentlyContinue
if ($formalListeners) {
  $owners = ($formalListeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
  throw "Port 17500 is already used by PID $owners. Stop the previous formal service first."
}

$developmentListeners = Get-NetTCPConnection -State Listen -LocalPort 5173 -ErrorAction SilentlyContinue
if ($developmentListeners) {
  $owners = ($developmentListeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
  throw "Development preview 5173 is used by PID $owners. Stop npm run dev or dev:web before starting the formal service."
}

Push-Location $projectRoot
try {
  & $nodePath "node_modules/vite/bin/vite.js" build --config web/vite.config.mts
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $nodePath "node_modules/typescript/lib/tsc.js" -p server/tsconfig.json
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  $env:NODE_ENV = "production"
  $env:HOST = "0.0.0.0"
  $env:PORT = "17500"
  & $nodePath "dist-server/server/src/index.js"
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
