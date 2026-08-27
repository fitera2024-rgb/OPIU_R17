[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Test4FixedZip,

    [Parameter(Mandatory = $true)]
    [string]$OutputZip,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F]{40}$')]
    [string]$SourceHead
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ExpectedInputSha256 = '55637B9553D7DD5BD86927A7241D987244EFCF39DD6C5E67D83E9176ACC52EEA'
$ExpectedTest3Sha256 = 'AB0FFC72D5171B0EFDB0CD194D6632FC7A27AF6FC82F6ED59504622E1A8C7A5A'
$ExpectedExeSha256 = '220B31545D637546D095C105D5E0726F06B02DBDD07AD7A6613D38E32147716B'
$WorkID = 'OPIU-2026-08-18-TEST4-STARTUP-PACKAGING-FIX'
$FixedTimestamp = [DateTimeOffset]::new(2026, 8, 18, 0, 0, 0, [TimeSpan]::Zero)
$Utf8NoBom = [Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Set-Property([object]$Object, [string]$Name, [object]$Value) {
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
    } else {
        $property.Value = $Value
    }
}

function Write-Json([string]$Path, [object]$Value) {
    $json = $Value | ConvertTo-Json -Depth 100
    [IO.File]::WriteAllText($Path, $json + "`n", $Utf8NoBom)
}

function Get-RelativeFiles([string]$Root, [string[]]$Exclude = @()) {
    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $excluded = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $Exclude) { [void]$excluded.Add($name.Replace('\', '/')) }
    $paths = [Collections.Generic.List[string]]::new()
    foreach ($file in Get-ChildItem -LiteralPath $resolvedRoot -Recurse -File) {
        $relative = $file.FullName.Substring($resolvedRoot.Length + 1).Replace('\', '/')
        if (-not $excluded.Contains($relative)) { $paths.Add($relative) }
    }
    $result = $paths.ToArray()
    [Array]::Sort($result, [StringComparer]::Ordinal)
    return $result
}

function Get-Inventory([string]$Root, [string[]]$Exclude = @()) {
    $rows = [Collections.Generic.List[object]]::new()
    $canonical = [Text.StringBuilder]::new()
    foreach ($relative in Get-RelativeFiles -Root $Root -Exclude $Exclude) {
        $path = Join-Path $Root ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
        $item = Get-Item -LiteralPath $path
        $hash = Get-Sha256 $path
        $rows.Add([ordered]@{ path = $relative; size = $item.Length; sha256 = $hash })
        [void]$canonical.Append($relative).Append("`t").Append($item.Length).Append("`t").Append($hash).Append("`n")
    }
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = ([BitConverter]::ToString($hasher.ComputeHash($Utf8NoBom.GetBytes($canonical.ToString())))).Replace('-', '')
    } finally {
        $hasher.Dispose()
    }
    return [pscustomobject]@{ rows = $rows.ToArray(); file_count = $rows.Count; sha256 = $digest }
}

function Assert-StrictSafety([object]$Safety, [string]$Label) {
    foreach ($name in @('mode', 'posting_rows', 'execution_allowed', 'ready_to_upload', 'release_allowed', 'live_1c_allowed')) {
        if ($null -eq $Safety.PSObject.Properties[$name]) { throw "$Label missing required safety field: $name" }
    }
    if ($Safety.mode -ne 'REPORT_ONLY' -or
        [int]$Safety.posting_rows -ne 0 -or
        [bool]$Safety.execution_allowed -ne $false -or
        [bool]$Safety.ready_to_upload -ne $false -or
        [bool]$Safety.release_allowed -ne $false -or
        [bool]$Safety.live_1c_allowed -ne $false) {
        throw "$Label is not strict REPORT_ONLY"
    }
}

function Add-OrReplaceManifestFile([object]$Manifest, [string]$RuntimeRoot, [string]$Relative, [string]$Source) {
    $path = Join-Path $RuntimeRoot ($Relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
    $item = Get-Item -LiteralPath $path
    $record = [pscustomobject][ordered]@{
        path = $Relative
        size = $item.Length
        sha256 = Get-Sha256 $path
        classification = 'RUNTIME_SOURCE'
        source = $Source
    }
    $kept = @($Manifest.files | Where-Object { [string]$_.path -ne $Relative })
    Set-Property $Manifest 'files' @($kept + $record)
}

function New-DeterministicZip([string]$SourceRoot, [string]$Destination) {
    $parent = Split-Path -Parent $Destination
    if ([string]::IsNullOrWhiteSpace($parent)) { $parent = (Get-Location).Path }
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
    $stream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $archive = [IO.Compression.ZipArchive]::new(
            $stream,
            [IO.Compression.ZipArchiveMode]::Create,
            $false,
            $Utf8NoBom
        )
        try {
            foreach ($relative in Get-RelativeFiles -Root $SourceRoot) {
                $source = Join-Path $SourceRoot ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
                $entry = $archive.CreateEntry('OPIU/' + $relative, [IO.Compression.CompressionLevel]::Optimal)
                $entry.LastWriteTime = $FixedTimestamp
                $input = [IO.File]::OpenRead($source)
                $output = $entry.Open()
                try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
            }
        } finally {
            $archive.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

$resolvedInput = (Resolve-Path -LiteralPath $Test4FixedZip).Path
$resolvedOutput = [IO.Path]::GetFullPath($OutputZip)
if (Test-Path -LiteralPath $resolvedOutput) { throw "Output already exists: $resolvedOutput" }
if ((Get-Sha256 $resolvedInput) -ne $ExpectedInputSha256) { throw 'Unexpected TEST4_FIXED SHA256' }

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('opiu-test4b-build-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $tempRoot | Out-Null
    [IO.Compression.ZipFile]::ExtractToDirectory($resolvedInput, $tempRoot)
    $bundleRoot = Join-Path $tempRoot 'OPIU'
    $runtimeRoot = Join-Path $bundleRoot 'runtime'
    if (-not (Test-Path -LiteralPath $bundleRoot -PathType Container)) { throw 'TEST4_FIXED root OPIU is missing' }
    if ((Get-Sha256 (Join-Path $bundleRoot 'OPIU_STABLE_Service.exe')) -ne $ExpectedExeSha256) { throw 'TEST3 service EXE identity was not preserved' }

    $safetyPath = Join-Path $runtimeRoot 'SAFETY.json'
    $safety = Get-Content -LiteralPath $safetyPath -Raw | ConvertFrom-Json
    Assert-StrictSafety $safety 'runtime SAFETY.json'

    $runtimeManifestPath = Join-Path $runtimeRoot 'MANIFEST.json'
    $runtimeManifest = Get-Content -LiteralPath $runtimeManifestPath -Raw | ConvertFrom-Json
    Assert-StrictSafety $runtimeManifest.safety 'runtime MANIFEST.json/safety'
    if ([string]$runtimeManifest.test4_owner_decision_overlay.input_test3_bundle_sha256 -ne $ExpectedTest3Sha256) {
        throw 'TEST4_FIXED provenance is not bound to the expected TEST3 ZIP'
    }

    $aliases = @(
        [ordered]@{
            source = 'modules/reconciliation/source/opiu_reconcile.mjs'
            target = 'modules/reconciliation/source/service_r005_owner_wrapper.mjs'
        },
        [ordered]@{
            source = 'modules/corrections/source/correction_engine_r001.mjs'
            target = 'modules/corrections/source/service_r001_owner_wrapper.mjs'
        }
    )
    $aliasHashes = [ordered]@{}
    foreach ($alias in $aliases) {
        $source = Join-Path $runtimeRoot ($alias.source.Replace('/', [IO.Path]::DirectorySeparatorChar))
        $target = Join-Path $runtimeRoot ($alias.target.Replace('/', [IO.Path]::DirectorySeparatorChar))
        if (Test-Path -LiteralPath $target) { throw "Wrapper alias unexpectedly exists: $($alias.target)" }
        [IO.File]::Copy($source, $target, $false)
        $aliasHashes[$alias.target] = Get-Sha256 $target
        Add-OrReplaceManifestFile $runtimeManifest $runtimeRoot $alias.target 'TEST4_FIXED:fixed-entrypoint-wrapper-alias'
    }

    foreach ($relative in @(
        'modules/reconciliation/source/owner_decision_policy.json',
        'modules/reconciliation/source/owner_decision_projection.mjs',
        'modules/reconciliation/source/owner_decision_xlsx.mjs',
        'modules/reconciliation/source/service_r005_owner_wrapper.mjs',
        'modules/corrections/source/owner_decision_r001.mjs',
        'modules/corrections/source/service_r001_owner_wrapper.mjs'
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $runtimeRoot ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))) -PathType Leaf)) {
            throw "Required owner-decision runtime file is missing: $relative"
        }
    }

    $launcher = @'
@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $h=Invoke-RestMethod -Uri 'http://127.0.0.1:8765/api/health' -TimeoutSec 2; if($h.service -eq 'OPIU_STABLE'){if($env:OPIU_LAUNCHER_NO_BROWSER -ne '1'){Start-Process 'http://127.0.0.1:8765/'}; exit 100}; exit 0"
if %errorlevel% equ 100 exit /b 0
"%~dp0OPIU_STABLE_Service.exe"
if errorlevel 1 pause
'@
    [IO.File]::WriteAllText((Join-Path $bundleRoot 'ЗАПУСТИТЬ_OPIU_STABLE.cmd'), $launcher.Replace("`n", "`r`n"), [Text.ASCIIEncoding]::new())

    $readme = @"
OPIU 1.9.4 — OWNER DECISIONS TEST4B

Назначение: Windows-тест owner decisions после исправления startup/packaging.
Режим: REPORT_ONLY. Загрузка, проведение, удаление и live 1C запрещены.

Запуск:
1. Полностью распаковать ZIP в новую папку.
2. Запустить ЗАПУСТИТЬ_OPIU_STABLE.cmd или OPIU_STABLE_Service.exe.
3. Если OPIU уже работает на 127.0.0.1:8765, launcher откроет существующий сервис и не запустит конфликтующий второй процесс.

Пакет сохраняет service EXE из TEST3 byte-identical и добавляет оба именованных owner wrapper-файла.
Input TEST4_FIXED SHA256: $ExpectedInputSha256
Input TEST3 SHA256: $ExpectedTest3Sha256
Source PR #64 head: $($SourceHead.ToLowerInvariant())

Это тестовый REPORT_ONLY пакет. Merge, release и live 1C не выполнялись.
"@
    [IO.File]::WriteAllText((Join-Path $bundleRoot 'TEST4_README_RU.txt'), $readme.Replace("`n", "`r`n"), $Utf8NoBom)

    $runtimeInventory = Get-Inventory -Root $runtimeRoot -Exclude @('MANIFEST.json')
    $fixRecord = [pscustomobject][ordered]@{
        schema_version = 'opiu-test4b-startup-packaging.v1'
        work_id = $WorkID
        source_pr = 64
        source_head_sha = $SourceHead.ToLowerInvariant()
        input_test4_fixed_sha256 = $ExpectedInputSha256
        input_test3_sha256 = $ExpectedTest3Sha256
        service_exe_reused = $true
        root_cause = 'PORT_8765_ALREADY_IN_USE_BY_EXISTING_OPIU_SERVICE'
        startup_fix = 'IDEMPOTENT_LAUNCHER_OPENS_EXISTING_HEALTHY_OPIU'
        wrapper_alias_hashes = $aliasHashes
        materialized_manifest_file_count = @($runtimeManifest.files).Count
        actual_runtime_file_count = $runtimeInventory.file_count + 1
        runtime_inventory_sha256 = $runtimeInventory.sha256
        unicode_required_path = 'modules/reconciliation/source/external_reference/erp/ОПИУ_Структура_ерп.xlsx'
        safety = [ordered]@{
            mode = 'REPORT_ONLY'
            posting_rows = 0
            execution_allowed = $false
            ready_to_upload = $false
            release_allowed = $false
            live_1c_allowed = $false
        }
    }
    Set-Property $runtimeManifest 'test4b_startup_packaging_fix' $fixRecord
    Write-Json $runtimeManifestPath $runtimeManifest
    $runtimeManifestSha256 = Get-Sha256 $runtimeManifestPath

    $provenancePath = Join-Path $bundleRoot 'BUNDLE_PROVENANCE.json'
    $provenance = Get-Content -LiteralPath $provenancePath -Raw | ConvertFrom-Json
    Set-Property $provenance 'implementation' 'OWNER_DECISIONS_TEST4B_STARTUP_PACKAGING_REPORT_ONLY'
    Set-Property $provenance 'runtime_manifest_sha256' $runtimeManifestSha256
    Set-Property $provenance 'test4b_startup_packaging_fix' $fixRecord
    Set-Property $provenance 'test4_user_test_candidate' $false
    Set-Property $provenance 'test4b_user_test_candidate' $true
    Assert-StrictSafety $provenance.safety 'BUNDLE_PROVENANCE.json/safety'
    Write-Json $provenancePath $provenance

    $bundleInventory = Get-Inventory -Root $bundleRoot -Exclude @('BUNDLE_MANIFEST.json')
    $bundleManifest = $provenance | ConvertTo-Json -Depth 100 | ConvertFrom-Json
    Set-Property $bundleManifest 'file_count' $bundleInventory.file_count
    Set-Property $bundleManifest 'files' $bundleInventory.rows
    Write-Json (Join-Path $bundleRoot 'BUNDLE_MANIFEST.json') $bundleManifest

    New-DeterministicZip -SourceRoot $bundleRoot -Destination $resolvedOutput

    $zip = [IO.Compression.ZipFile]::OpenRead($resolvedOutput)
    try {
        $names = @($zip.Entries | Where-Object { -not $_.FullName.EndsWith('/') } | ForEach-Object { $_.FullName })
        foreach ($required in @(
            'OPIU/runtime/modules/reconciliation/source/service_r005_owner_wrapper.mjs',
            'OPIU/runtime/modules/corrections/source/service_r001_owner_wrapper.mjs',
            'OPIU/runtime/modules/reconciliation/source/external_reference/erp/ОПИУ_Структура_ерп.xlsx'
        )) {
            if ($required -notin $names) { throw "Final ZIP missing exact path: $required" }
        }
        if (@($names | Where-Object { $_.Contains([char]0xfffd) -or $_ -match '[╨╤]' }).Count -ne 0) {
            throw 'Final ZIP contains mojibake or replacement characters'
        }
    } finally {
        $zip.Dispose()
    }

    [ordered]@{
        status = 'BUILT'
        work_id = $WorkID
        package_path = $resolvedOutput
        package_size = (Get-Item -LiteralPath $resolvedOutput).Length
        package_sha256 = Get-Sha256 $resolvedOutput
        service_exe_sha256 = $ExpectedExeSha256
        service_exe_changed = $false
        materialized_manifest_file_count = @($runtimeManifest.files).Count
        actual_runtime_file_count = $runtimeInventory.file_count + 1
        runtime_inventory_sha256 = $runtimeInventory.sha256
        runtime_manifest_sha256 = $runtimeManifestSha256
        runtime_safety_sha256 = Get-Sha256 $safetyPath
    } | ConvertTo-Json -Depth 10
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
        $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        if ($resolvedTemp.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and
            [IO.Path]::GetFileName($resolvedTemp).StartsWith('opiu-test4b-build-', [StringComparison]::Ordinal)) {
            Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
        }
    }
}
