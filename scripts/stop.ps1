$ErrorActionPreference = 'Stop'
$record = Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime/processes.json'
if (!(Test-Path -LiteralPath $record)) { Write-Host 'No running test was recorded.'; return }
$owned = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
foreach ($item in $owned) {
    $process = Get-Process -Id $item.Id -ErrorAction SilentlyContinue
    if ($process -and $process.StartTime.ToUniversalTime().Ticks -eq [long]$item.StartedTicks) {
        Stop-Process -Id $item.Id
        Wait-Process -Id $item.Id -Timeout 10 -ErrorAction SilentlyContinue
    }
}
Remove-Item -LiteralPath $record
Write-Host 'Local assistant stopped. Notes and memories are saved.'
