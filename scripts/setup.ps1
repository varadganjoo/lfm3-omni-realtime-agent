$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
New-Item -ItemType Directory -Force -Path runtime, models, data | Out-Null

# Pinned official release and model revision; verify bytes before running them.
$downloads = @(
    @{
        Url = 'https://github.com/ggml-org/llama.cpp/releases/download/b12021/llama-b12021-bin-win-cuda-12.4-x64.zip'
        Path = 'runtime/llama-b12021.zip'
        Hash = 'ba613184d2a57bf0310efd721e89d640db64b69910588b295f2a9e2a410d4f12' # pragma: allowlist secret - public artifact SHA-256
    },
    @{
        Url = 'https://github.com/ggml-org/llama.cpp/releases/download/b12021/cudart-llama-bin-win-cuda-12.4-x64.zip'
        Path = 'runtime/cudart-b12021.zip'
        Hash = '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6' # pragma: allowlist secret - public artifact SHA-256
    },
    @{
        Url = 'https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF/resolve/3d29af2ad166f8299c2d820937e47dc0add20ffc/LFM3-Omni-2B-Q4_K_M.gguf'
        Path = 'models/LFM3-Omni-2B-Q4_K_M.gguf'
        Hash = '9f8d30e9d4fd7a9349d586e077988229b3ca0a0e4ad730897563d1eccc9893e2' # pragma: allowlist secret - public artifact SHA-256
    },
    @{
        Url = 'https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF/resolve/3d29af2ad166f8299c2d820937e47dc0add20ffc/mmproj-LFM3-Omni-2B-Q8_0.gguf'
        Path = 'models/mmproj-LFM3-Omni-2B-Q8_0.gguf'
        Hash = '8a25f9d1931244429de404fccacfb7fb933970a36aa5688d2f5069f29c6b27b1' # pragma: allowlist secret - public artifact SHA-256
    }
)
foreach ($download in $downloads) {
    if (!(Test-Path -LiteralPath $download.Path)) {
        Write-Host "Downloading $($download.Path)..."
        & curl.exe --fail --location --retry 3 --continue-at - --silent --show-error --output ($download.Path + '.part') $download.Url
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $($download.Path). Run setup again to resume." }
        Move-Item -LiteralPath ($download.Path + '.part') -Destination $download.Path
    }
    if ((Get-FileHash -LiteralPath $download.Path -Algorithm SHA256).Hash -ne $download.Hash) {
        throw "Checksum mismatch: $($download.Path). Move the file aside and run setup again."
    }
    Write-Host "Verified $($download.Path)"
}
Expand-Archive -LiteralPath runtime/llama-b12021.zip -DestinationPath runtime/llama -Force
Expand-Archive -LiteralPath runtime/cudart-b12021.zip -DestinationPath runtime/llama -Force
& uv sync --frozen
if ($LASTEXITCODE -ne 0) { throw 'Pipecat setup failed. Check uv and Python 3.11, then run setup again.' }
Write-Host 'Setup complete. Run .\scripts\start.ps1 to open the local assistant.'
