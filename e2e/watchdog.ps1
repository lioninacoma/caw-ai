# Starts the E2E and aborts it when the log has been silent for too long.
# Usage: pwsh watchdog.ps1 <ids> <log> [silentSeconds], e.g. pwsh watchdog.ps1 N1,A e2e.log (ids: see native-e2e.mjs)
# 240 s of silence: above Playwright's default launch timeout of 180 s, so a Chrome launch that hangs reports its own error
# in the log before the watchdog kills the run without a cause.
param([string]$Filter = '', [string]$Log = 'e2e.log', [int]$SilentSeconds = 240, [string[]]$NodeArgs = @(), [string]$Folder = $PSScriptRoot)
Set-Location $PSScriptRoot
$Log = Join-Path $PSScriptRoot $Log
$status = "$Log.status"
# The script also writes the check results here: in the log, output of child processes can overwrite lines.
$resultFile = "$Log.result"
Remove-Item $Log, $status, $resultFile -ErrorAction SilentlyContinue
$env:CAW_E2E_RESULT = $resultFile
if ($NodeArgs.Count -gt 0) { $nodeArgs = $NodeArgs } else { $nodeArgs = @('native-e2e.mjs'); if ($Filter -ne '') { $nodeArgs += $Filter } }
$proc = Start-Process node -ArgumentList $nodeArgs -RedirectStandardOutput $Log -RedirectStandardError "$Log.err" -WorkingDirectory $Folder -PassThru -NoNewWindow
$null = $proc.Handle  # otherwise ExitCode stays empty
$lastChange = Get-Date
$size = -1
while (-not $proc.HasExited) {
    Start-Sleep -Seconds 5
    $current = if (Test-Path $Log) { (Get-Item $Log).Length } else { 0 }
    if ($current -ne $size) { $size = $current; $lastChange = Get-Date; continue }
    if (((Get-Date) - $lastChange).TotalSeconds -ge $SilentSeconds) {
        "HANGING for $SilentSeconds s, killing process tree $($proc.Id)" | Out-File $status
        taskkill /T /F /PID $proc.Id | Out-Null
        exit 2
    }
}
$summary = if (Test-Path $resultFile) { Get-Content $resultFile | Where-Object { $_ -like 'RESULT *' } | Select-Object -Last 1 } else { 'RESULT missing' }
"END exit $($proc.ExitCode) $summary" | Out-File $status
exit $proc.ExitCode
