# Startet das E2E und bricht es ab, wenn das Log zu lange still steht.
# Aufruf: pwsh waechter.ps1 <filter> <log> [stillSekunden]
param([string]$Filter = '', [string]$Log = 'e2e.log', [int]$StillSekunden = 180, [string[]]$NodeArgs = @(), [string]$Ordner = $PSScriptRoot)
Set-Location $PSScriptRoot
$Log = Join-Path $PSScriptRoot $Log
$status = "$Log.status"
# Die Pruefergebnisse schreibt das Skript zusaetzlich hierhin: Im Log koennen Ausgaben von Kindprozessen Zeilen ueberschreiben.
$ergebnis = "$Log.ergebnis"
Remove-Item $Log, $status, $ergebnis -ErrorAction SilentlyContinue
$env:CAW_E2E_ERGEBNIS = $ergebnis
if ($NodeArgs.Count -gt 0) { $nodeArgs = $NodeArgs } else { $nodeArgs = @('schritte-e2e.mjs'); if ($Filter -ne '') { $nodeArgs += $Filter } }
$proc = Start-Process node -ArgumentList $nodeArgs -RedirectStandardOutput $Log -RedirectStandardError "$Log.err" -WorkingDirectory $Ordner -PassThru -NoNewWindow
$null = $proc.Handle  # sonst bleibt ExitCode leer
$letzte = Get-Date
$groesse = -1
while (-not $proc.HasExited) {
    Start-Sleep -Seconds 5
    $jetzt = if (Test-Path $Log) { (Get-Item $Log).Length } else { 0 }
    if ($jetzt -ne $groesse) { $groesse = $jetzt; $letzte = Get-Date; continue }
    if (((Get-Date) - $letzte).TotalSeconds -ge $StillSekunden) {
        "HAENGT seit $StillSekunden s, beende Prozessbaum $($proc.Id)" | Out-File $status
        taskkill /T /F /PID $proc.Id | Out-Null
        exit 2
    }
}
$summe = if (Test-Path $ergebnis) { Get-Content $ergebnis | Where-Object { $_ -like 'ERGEBNIS *' } | Select-Object -Last 1 } else { 'ERGEBNIS fehlt' }
"ENDE exit $($proc.ExitCode) $summe" | Out-File $status
exit $proc.ExitCode
