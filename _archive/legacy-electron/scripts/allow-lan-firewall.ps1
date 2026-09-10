$ErrorActionPreference = "Stop"
$ruleName = "Personal Workbench TCP 17500 (LocalSubnet)"
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($null -eq $existing) {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort 17500 -RemoteAddress LocalSubnet -Profile Any | Out-Null
  Write-Output "Created firewall rule: $ruleName"
} else {
  Write-Output "Firewall rule already exists: $ruleName"
}
