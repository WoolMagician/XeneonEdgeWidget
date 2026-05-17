param(
  [string]$ServerDir = $PSScriptRoot
)

$ErrorActionPreference = 'SilentlyContinue'

try {
  $resolvedServerDir = (Resolve-Path -LiteralPath $ServerDir).Path
} catch {
  exit 0
}

$resolvedRepoDir = Split-Path -Parent $resolvedServerDir
$escapedRepoDir = [Regex]::Escape($resolvedRepoDir)
$repoPattern = $escapedRepoDir -replace '\\\\', '[\\/]'
$debugMode = ($env:XEW_KILL_DEBUG -eq '1')

$pidsToKill = @{}

# Kill the node process currently bound to the widget port.
$listeners = Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue
if ($debugMode) { Write-Output ("[kill-existing] listeners={0}" -f @($listeners).Count) }
foreach ($entry in @($listeners)) {
  $targetPid = [int]$entry.OwningProcess
  if ($targetPid -le 0) { continue }
  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -ieq 'node') {
    $pidsToKill[$targetPid] = 'port-listener'
  }
}

# Kill npm/node launchers related to this repo and any AudioCtl worker from this repo.
$repoProcesses = Get-CimInstance Win32_Process | Where-Object {
  $name = [string]$_.Name
  $cmd = [string]$_.CommandLine
  if ([string]::IsNullOrWhiteSpace($cmd)) {
    $false
  } elseif ($name -ieq 'node.exe') {
    (($cmd -match 'npm-cli\.js') -and ($cmd -match $repoPattern)) -or ($cmd -match '(?i)server[\\/]+server\.js')
  } elseif ($name -ieq 'dotnet.exe') {
    ($cmd -match 'AudioCtl\.dll') -and ($cmd -match $repoPattern)
  } else {
    $false
  }
}
if ($debugMode) { Write-Output ("[kill-existing] repoProcesses={0}" -f @($repoProcesses).Count) }

foreach ($proc in @($repoProcesses)) {
  $targetPid = [int]$proc.ProcessId
  if ($targetPid -gt 0) {
    $pidsToKill[$targetPid] = 'repo-process'
  }
}

if ($debugMode) {
  foreach ($entry in $pidsToKill.GetEnumerator()) {
    Write-Output ("[kill-existing] stopping pid={0} reason={1}" -f $entry.Key, $entry.Value)
  }
}

foreach ($targetPid in @($pidsToKill.Keys)) {
  Stop-Process -Id ([int]$targetPid) -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 300
