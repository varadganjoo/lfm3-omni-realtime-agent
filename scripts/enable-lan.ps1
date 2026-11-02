#Requires -Version 7.3
using namespace System.Security.Cryptography
using namespace System.Security.Cryptography.X509Certificates

param()
$ErrorActionPreference = 'Stop'
$rootPath = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $rootPath 'runtime/lan.json'
$tlsPath = Join-Path $rootPath 'runtime/tls'
$network = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
if (!$network) { throw 'Connect to your home network before enabling LAN access.' }
$address = $network.IPv4Address.IPAddress
$prefix = (Get-NetIPAddress -InterfaceIndex $network.InterfaceIndex -AddressFamily IPv4 | Where-Object IPAddress -eq $address).PrefixLength
if ($address -notmatch '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' -or !$prefix) { throw 'A private home-network IPv4 address is required.' }

if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($config.address -ne $address -or $config.prefixLength -ne $prefix) { throw 'The home-network address changed. See docs/network.md before replacing the existing certificate.' }
    foreach ($file in 'companion-ca.cer', 'companion-ca.pem', 'server.pem', 'server-key.pem') {
        if (!(Test-Path -LiteralPath (Join-Path $tlsPath $file))) { throw "Missing TLS file: $file. See docs/network.md." }
    }
    Write-Host "LAN is configured: https://${address}:8443"
    Write-Host "Device setup: http://${address}:8789"
    return
}

New-Item -ItemType Directory -Force -Path $tlsPath | Out-Null
$acl = Get-Acl -LiteralPath $tlsPath
$acl.SetAccessRuleProtection($true, $false)
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($identity in @($owner, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $tlsPath -AclObject $acl
$caKey = [RSA]::Create(2048)
$serverKey = [RSA]::Create(2048)
try {
    $before = [DateTimeOffset]::UtcNow.AddMinutes(-5)
    $caRequest = [CertificateRequest]::new('CN=Local Companion Home CA', $caKey, [HashAlgorithmName]::SHA256, [RSASignaturePadding]::Pkcs1)
    $caRequest.CertificateExtensions.Add([X509BasicConstraintsExtension]::new($true, $true, 0, $true))
    $caRequest.CertificateExtensions.Add([X509KeyUsageExtension]::new([X509KeyUsageFlags]::KeyCertSign -bor [X509KeyUsageFlags]::CrlSign, $true))
    $caRequest.CertificateExtensions.Add([X509SubjectKeyIdentifierExtension]::new($caRequest.PublicKey, $false))
    $ca = $caRequest.CreateSelfSigned($before, [DateTimeOffset]::UtcNow.AddYears(2))
    $request = [CertificateRequest]::new("CN=$address", $serverKey, [HashAlgorithmName]::SHA256, [RSASignaturePadding]::Pkcs1)
    $request.CertificateExtensions.Add([X509BasicConstraintsExtension]::new($false, $false, 0, $true))
    $request.CertificateExtensions.Add([X509KeyUsageExtension]::new([X509KeyUsageFlags]::DigitalSignature -bor [X509KeyUsageFlags]::KeyEncipherment, $true))
    $usage = [OidCollection]::new()
    $usage.Add([Oid]::new('1.3.6.1.5.5.7.3.1')) | Out-Null
    $request.CertificateExtensions.Add([X509EnhancedKeyUsageExtension]::new($usage, $false))
    $san = [SubjectAlternativeNameBuilder]::new()
    $san.AddIpAddress([Net.IPAddress]::Parse($address))
    $request.CertificateExtensions.Add($san.Build())
    $cert = $request.Create($ca, $before, [DateTimeOffset]::UtcNow.AddDays(365), [RandomNumberGenerator]::GetBytes(16))
    [IO.File]::WriteAllBytes((Join-Path $tlsPath 'companion-ca.cer'), $ca.Export([X509ContentType]::Cert))
    [IO.File]::WriteAllText((Join-Path $tlsPath 'companion-ca.pem'), $ca.ExportCertificatePem())
    [IO.File]::WriteAllText((Join-Path $tlsPath 'server.pem'), $cert.ExportCertificatePem())
    [IO.File]::WriteAllText((Join-Path $tlsPath 'server-key.pem'), $serverKey.ExportPkcs8PrivateKeyPem())
    $chain = [X509Chain]::new()
    try {
        $chain.ChainPolicy.TrustMode = [X509ChainTrustMode]::CustomRootTrust
        $chain.ChainPolicy.CustomTrustStore.Add($ca) | Out-Null
        $chain.ChainPolicy.RevocationMode = [X509RevocationMode]::NoCheck
        if (!$chain.Build($cert)) { throw 'The generated certificate chain failed validation.' }
    } finally { $chain.Dispose() }
    $config = @{ address = $address; prefixLength = [int]$prefix; certificateSha256 = $ca.GetCertHashString([HashAlgorithmName]::SHA256) }
    [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json))
} finally {
    if ($cert) { $cert.Dispose() }
    if ($ca) { $ca.Dispose() }
    # The signing key is discarded; only this server certificate can use this CA.
    $serverKey.Dispose()
    $caKey.Dispose()
}
Write-Host "Configured: https://${address}:8443 (no access code)"
Write-Host "Device setup: http://${address}:8789"
Write-Host "Certificate SHA-256: $($config.certificateSha256)"
Write-Host 'Restart with .\scripts\stop.ps1 then .\scripts\start.ps1. Trust the public certificate once on each client device.'
