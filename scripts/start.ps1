param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$rootPath = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $rootPath
$runtimePath = Join-Path $rootPath 'runtime'
$serverPath = Join-Path $runtimePath 'llama/llama-server.exe'
if (!(Test-Path -LiteralPath $serverPath)) { throw 'Run .\scripts\setup.ps1 first.' }
if (!(Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22 or newer is required.' }
$pythonPath = Join-Path $rootPath '.venv/Scripts/python.exe'
if (!(Test-Path -LiteralPath $pythonPath)) { throw 'Run .\scripts\setup.ps1 to install Pipecat in the project environment.' }
$keyPath = Join-Path $runtimePath 'api-key'
if (!(Test-Path -LiteralPath $keyPath)) {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    [IO.File]::WriteAllText($keyPath, [Convert]::ToBase64String($bytes))
}
function Test-Ready([string]$Url) {
    try { $response = Invoke-WebRequest -Uri $Url -TimeoutSec 2 -UseBasicParsing; return $response.StatusCode -eq 200 }
    catch { return $false }
}
if (Test-Ready 'http://127.0.0.1:8787/api/state') {
    $state = Invoke-RestMethod 'http://127.0.0.1:8787/api/state'
    if (!$state.liveReady) { throw 'An older or incomplete assistant is running. Run .\scripts\stop.ps1, then start again.' }
    Write-Host 'The local assistant is already running: http://127.0.0.1:8787'
    if (Test-Path -LiteralPath (Join-Path $runtimePath 'lan.json')) {
        $lan = Get-Content -LiteralPath (Join-Path $runtimePath 'lan.json') -Raw | ConvertFrom-Json
        Write-Host "Home network (after restarting to enable changes): https://$($lan.address):8443"
        Write-Host "Device setup: http://$($lan.address):8789"
    }
    if (!$NoBrowser) { Start-Process 'http://127.0.0.1:8787' }
    return
}
$owned = @()
try {
    if (Test-Ready 'http://127.0.0.1:8081/health') { throw 'Port 8081 is already in use. Stop that service before starting this test.' }
    if (Test-Ready 'http://127.0.0.1:8788/health') { throw 'Port 8788 is already in use.' }
    $modelArgs = @('-m', 'models/LFM3-Omni-2B-Q4_K_M.gguf', '--mmproj', 'models/mmproj-LFM3-Omni-2B-Q8_0.gguf', '--host', '127.0.0.1', '--port', '8081', '--alias', 'local-omni', '-c', '8192', '-ngl', '99', '--parallel', '1', '--reasoning', 'off', '--temp', '0', '--jinja', '--video-fps', '2', '--api-key-file', ('"' + $keyPath + '"'))
    $modelProcess = Start-Process -FilePath $serverPath -ArgumentList $modelArgs -WorkingDirectory $rootPath -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'model.stdout.log') -RedirectStandardError (Join-Path $runtimePath 'model.stderr.log') -PassThru
    $owned += @{ Id = $modelProcess.Id; StartedTicks = $modelProcess.StartTime.ToUniversalTime().Ticks }
    $deadline = (Get-Date).AddSeconds(90)
    while (!(Test-Ready 'http://127.0.0.1:8081/health')) {
        if ($modelProcess.HasExited) { throw 'The model stopped. See runtime/model.stderr.log.' }
        if ((Get-Date) -gt $deadline) { throw 'The model did not start within 90 seconds. See runtime/model.stderr.log.' }
        Start-Sleep -Milliseconds 500
    }
    $appProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList 'src/server/server.mjs' -WorkingDirectory $rootPath -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'app.stdout.log') -RedirectStandardError (Join-Path $runtimePath 'app.stderr.log') -PassThru
    $owned += @{ Id = $appProcess.Id; StartedTicks = $appProcess.StartTime.ToUniversalTime().Ticks }
    $deadline = (Get-Date).AddSeconds(15)
    while (!(Test-Ready 'http://127.0.0.1:8787/api/state')) {
        if ($appProcess.HasExited) { throw 'The app stopped. See runtime/app.stderr.log.' }
        if ((Get-Date) -gt $deadline) { throw 'The app did not start. See runtime/app.stderr.log.' }
        Start-Sleep -Milliseconds 300
    }
    $liveProcess = Start-Process -FilePath $pythonPath -ArgumentList '-m src.media.live' -WorkingDirectory $rootPath -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'live.stdout.log') -RedirectStandardError (Join-Path $runtimePath 'live.stderr.log') -PassThru
    $owned += @{ Id = $liveProcess.Id; StartedTicks = $liveProcess.StartTime.ToUniversalTime().Ticks }
    $deadline = (Get-Date).AddSeconds(60)
    while (!(Test-Ready 'http://127.0.0.1:8788/health')) {
        if ($liveProcess.HasExited) { throw 'Pipecat stopped. See runtime/live.stderr.log.' }
        if ((Get-Date) -gt $deadline) { throw 'Pipecat did not start. See runtime/live.stderr.log.' }
        Start-Sleep -Milliseconds 300
    }
    $owned | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimePath 'processes.json')
    Write-Host 'Ready: http://127.0.0.1:8787'
    if (Test-Path -LiteralPath (Join-Path $runtimePath 'lan.json')) {
        $lan = Get-Content -LiteralPath (Join-Path $runtimePath 'lan.json') -Raw | ConvertFrom-Json
        Write-Host "Home network: https://$($lan.address):8443 (no access code)"
        Write-Host "Device setup: http://$($lan.address):8789"
    }
    Write-Host 'Use .\scripts\stop.ps1 to stop the app and free the GPU memory.'
    if (!$NoBrowser) { Start-Process 'http://127.0.0.1:8787' }
} catch {
    foreach ($item in $owned) {
        $process = Get-Process -Id $item.Id -ErrorAction SilentlyContinue
        if ($process -and $process.StartTime.ToUniversalTime().Ticks -eq $item.StartedTicks) { Stop-Process -Id $item.Id }
    }
    throw
}
