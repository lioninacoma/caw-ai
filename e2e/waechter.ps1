# Starts the E2E and aborts it when the log has been silent for too long.
# Usage: pwsh waechter.ps1 <filter> <log> [stillSekunden]
param([string]$Filter = '', [string]$Log = 'e2e.log', [int]$StillSekunden = 180, [string[]]$NodeArgs = @(), [string]$Ordner = $PSScriptRoot)
Set-Location $PSScriptRoot
$Log = Join-Path $PSScriptRoot $Log
$status = "$Log.status"
# The script also writes the check results here: in the log, output of child processes can overwrite lines.
$resultFile = "$Log.ergebnis"
Remove-Item $Log, $status, $resultFile -ErrorAction SilentlyContinue
$env:CAW_E2E_ERGEBNIS = $resultFile
if ($NodeArgs.Count -gt 0) { $nodeArgs = $NodeArgs } else { $nodeArgs = @('schritte-e2e.mjs'); if ($Filter -ne '') { $nodeArgs += $Filter } }
$proc = Start-Process node -ArgumentList $nodeArgs -RedirectStandardOutput $Log -RedirectStandardError "$Log.err" -WorkingDirectory $Ordner -PassThru -NoNewWindow
$null = $proc.Handle  # otherwise ExitCode stays empty
$lastChange = Get-Date
$size = -1
while (-not $proc.HasExited) {
    Start-Sleep -Seconds 5
    $current = if (Test-Path $Log) { (Get-Item $Log).Length } else { 0 }
    if ($current -ne $size) { $size = $current; $lastChange = Get-Date; continue }
    if (((Get-Date) - $lastChange).TotalSeconds -ge $StillSekunden) {
        "HAENGT seit $StillSekunden s, beende Prozessbaum $($proc.Id)" | Out-File $status
        taskkill /T /F /PID $proc.Id | Out-Null
        exit 2
    }
}
$summary = if (Test-Path $resultFile) { Get-Content $resultFile | Where-Object { $_ -like 'ERGEBNIS *' } | Select-Object -Last 1 } else { 'ERGEBNIS fehlt' }
"ENDE exit $($proc.ExitCode) $summary" | Out-File $status
exit $proc.ExitCode
