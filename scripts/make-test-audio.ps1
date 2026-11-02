$ErrorActionPreference = 'Stop'
$rootPath = Split-Path -Parent $PSScriptRoot
$runtimePath = Join-Path $rootPath 'runtime'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
$outputPath = Join-Path $runtimePath 'live-command.wav'
$voice = $null
$stream = $null
try {
    $voice = New-Object -ComObject SAPI.SpVoice
    $stream = New-Object -ComObject SAPI.SpFileStream
    $stream.Format.Type = 18 # SAPI format 18 is 16 kHz, mono, PCM16.
    $stream.Open($outputPath, 3, $false)
    $voice.AllowAudioOutputFormatChangesOnNextSet = $false
    $voice.AudioOutputStream = $stream
    $voice.Speak('Save a note titled Pipecat live test, with the body: Live video and voice worked.') | Out-Null
    $stream.Close()
    $bytes = [IO.File]::ReadAllBytes($outputPath)
    if ([Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne 'RIFF' -or
        [BitConverter]::ToUInt16($bytes, 22) -ne 1 -or
        [BitConverter]::ToUInt32($bytes, 24) -ne 16000 -or
        [BitConverter]::ToUInt16($bytes, 34) -ne 16) {
        throw 'Synthetic test speech must be a 16 kHz mono PCM16 WAV file.'
    }
    Write-Host 'Created runtime/live-command.wav using local Windows speech synthesis.'
} finally {
    foreach ($item in @($voice, $stream)) {
        if ($item -and [Runtime.InteropServices.Marshal]::IsComObject($item)) {
            [Runtime.InteropServices.Marshal]::FinalReleaseComObject($item) | Out-Null
        }
    }
}
