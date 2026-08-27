[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$CandidateZip,

    [switch]$Launch
)

$ErrorActionPreference = 'Stop'
$resolvedZip = (Resolve-Path -LiteralPath $CandidateZip).Path
if (-not $Launch) {
    [ordered]@{
        status = 'NOT_RUN'
        reason = 'Pass -Launch for the isolated localhost smoke.'
        candidate_sha256 = (Get-FileHash -LiteralPath $resolvedZip -Algorithm SHA256).Hash
    } | ConvertTo-Json -Depth 4
    exit 2
}

$tempBase = [System.IO.Path]::GetTempPath()
$tempRoot = Join-Path $tempBase ('opiu-portable-smoke-' + [guid]::NewGuid().ToString('N'))
$process = $null
$listener = $null
$httpClient = $null
try {
    New-Item -ItemType Directory -Path $tempRoot | Out-Null
    Expand-Archive -LiteralPath $resolvedZip -DestinationPath $tempRoot
    # The review bundle contains the Service executable and the pinned Node
    # runtime. Node is a dependency, not a candidate application entrypoint.
    $executables = @(
        Get-ChildItem -LiteralPath $tempRoot -Recurse -File -Filter '*.exe' |
            Where-Object { $_.Name -ine 'node.exe' }
    )
    if ($executables.Count -ne 1) { throw "CANDIDATE_EXE_COUNT_INVALID:$($executables.Count)" }
    $exe = $executables[0]

    $bundledNode = Join-Path $exe.Directory.FullName 'runtime\runtime\node\node.exe'
    $artifactToolEntry = Join-Path $exe.Directory.FullName 'runtime\node_modules\@oai\artifact-tool\node_modules\skia-canvas\lib\index.js'
    if (-not (Test-Path -LiteralPath $bundledNode -PathType Leaf) -or
        -not (Test-Path -LiteralPath $artifactToolEntry -PathType Leaf)) {
        throw 'ARTIFACT_TOOL_NATIVE_RUNTIME_MISSING'
    }
    & $bundledNode -e 'require(process.argv[1])' $artifactToolEntry *> $null
    if ($LASTEXITCODE -ne 0) { throw "ARTIFACT_TOOL_NATIVE_RUNTIME_LOAD_FAILED:$LASTEXITCODE" }

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    $listener = $null

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $exe.FullName
    $serviceData = Join-Path $tempRoot 'service-data'
    $startInfo.Arguments = "-addr 127.0.0.1:$port -data-dir `"$serviceData`" -no-open"
    $startInfo.WorkingDirectory = $exe.Directory.FullName
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw 'SERVICE_PROCESS_START_FAILED' }

    $baseUri = "http://127.0.0.1:$port"
    $health = $null
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($process.HasExited) { throw "SERVICE_EXITED_EARLY:$($process.ExitCode)" }
        try {
            $health = Invoke-RestMethod -Uri "$baseUri/api/health" -TimeoutSec 2
            break
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
    if ($null -eq $health) { throw 'HEALTH_TIMEOUT' }
    $bootstrap = Invoke-RestMethod -Uri "$baseUri/api/bootstrap" -TimeoutSec 10
    $index = Invoke-WebRequest -Uri "$baseUri/" -UseBasicParsing -TimeoutSec 10
    $httpClient = [System.Net.Http.HttpClient]::new()
    $resultsUiBytes = $httpClient.GetByteArrayAsync("$baseUri/results-ui.js").GetAwaiter().GetResult()
    $resultsUiHasher = [Security.Cryptography.SHA256]::Create()
    try {
        $resultsUiSha256 = (
            [BitConverter]::ToString($resultsUiHasher.ComputeHash($resultsUiBytes))
        ).Replace('-', '')
    } finally {
        $resultsUiHasher.Dispose()
    }
    $embeddedUiVerified = $false
    $provenancePath = Join-Path $exe.Directory.FullName 'BUNDLE_PROVENANCE.json'
    if (Test-Path -LiteralPath $provenancePath) {
        $provenance = Get-Content -Raw -LiteralPath $provenancePath | ConvertFrom-Json
        $expectedResultsUi = [string]$provenance.service_build.embedded_results_ui_sha256
        if (-not [string]::IsNullOrWhiteSpace($expectedResultsUi)) {
            if ($resultsUiSha256 -ne $expectedResultsUi) {
                throw "EMBEDDED_RESULTS_UI_HASH_MISMATCH:$resultsUiSha256`:$expectedResultsUi"
            }
            $embeddedUiVerified = $true
        }
    }

    if ($health.status -ne 'ok' -or $health.service -ne 'OPIU_STABLE') {
        throw 'HEALTH_CONTRACT_INVALID'
    }
    if ($health.safety.mode -ne 'REPORT_ONLY' -or
        $health.safety.posting_rows -ne 0 -or
        $health.safety.ready_to_upload -ne $false -or
        $health.safety.release_allowed -ne $false -or
        $health.safety.live_1c_allowed -ne $false) {
        throw 'HEALTH_SAFETY_INVALID'
    }
    if ($bootstrap.service_version -notlike '1.9.4*' -or
        $bootstrap.safety.mode -ne 'REPORT_ONLY' -or
        $bootstrap.safety.posting_rows -ne 0 -or
        $bootstrap.safety.ready_to_upload -ne $false -or
        $bootstrap.safety.release_allowed -ne $false -or
        $bootstrap.safety.live_1c_allowed -ne $false -or
        $bootstrap.engine_adapter_ready -ne $true) {
        throw 'BOOTSTRAP_SAFETY_INVALID'
    }
    if ($index.StatusCode -ne 200 -or [string]::IsNullOrWhiteSpace($index.Content)) {
        throw 'STATIC_UI_INVALID'
    }

    [ordered]@{
        status = 'PASS'
        candidate_sha256 = (Get-FileHash -LiteralPath $resolvedZip -Algorithm SHA256).Hash
        executable_sha256 = (Get-FileHash -LiteralPath $exe.FullName -Algorithm SHA256).Hash
        health = [ordered]@{
            status = $health.status
            service = $health.service
            mode = $health.safety.mode
        }
        bootstrap = [ordered]@{
            version = $bootstrap.service_version
            report_only = ($bootstrap.safety.mode -eq 'REPORT_ONLY')
            engine_adapter_ready = $bootstrap.engine_adapter_ready
        }
        ui_http_status = $index.StatusCode
        embedded_results_ui_sha256 = $resultsUiSha256
        embedded_results_ui_verified = $embeddedUiVerified
        artifact_tool_native_verified = $true
        localhost_only = $true
        live_1c_invoked = $false
        upload_invoked = $false
        release_invoked = $false
    } | ConvertTo-Json -Depth 6
} finally {
    if ($null -ne $httpClient) { $httpClient.Dispose() }
    if ($null -ne $listener) { $listener.Stop() }
    if ($null -ne $process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
        $process.WaitForExit()
    }
    $resolvedTemp = [System.IO.Path]::GetFullPath($tempRoot)
    $resolvedBase = [System.IO.Path]::GetFullPath($tempBase)
    if ($resolvedTemp.StartsWith($resolvedBase, [System.StringComparison]::OrdinalIgnoreCase) -and
        [System.IO.Path]::GetFileName($resolvedTemp).StartsWith('opiu-portable-smoke-')) {
        try {
            Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
        } catch {
            $longPath = '\\?\' + $resolvedTemp
            try {
                if ([System.IO.Directory]::Exists($longPath)) {
                    [System.IO.Directory]::Delete($longPath, $true)
                }
            } catch {
                Write-Warning "SMOKE_TEMP_CLEANUP_FAILED:$([System.IO.Path]::GetFileName($resolvedTemp))"
            }
        }
    }
}
