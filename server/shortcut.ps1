param(
  [Parameter(Mandatory = $true)]
  [string]$Keys
)

$ErrorActionPreference = 'Stop'

try {
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
  @{ ok = $true } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
