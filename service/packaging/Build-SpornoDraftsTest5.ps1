[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Test4BZip,
    [Parameter(Mandatory = $true)][string]$OutputZip,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$SourceHead
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ExpectedInputSha256 = '4767BE40FD3FABC57B55686DDC14F8FC143A5D7F4919D271F569E8CFCB5C2840'
$ExpectedExeSha256 = '220B31545D637546D095C105D5E0726F06B02DBDD07AD7A6613D38E32147716B'
$WorkID = 'OPIU-2026-08-19-R001-MATERIALIZE-SPORNO-DRAFTS-R3'
$FixedTimestamp = [DateTimeOffset]::new(2026, 8, 19, 0, 0, 0, [TimeSpan]::Zero)
$Utf8NoBom = [Text.UTF8Encoding]::new($false)
$RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../../..')).Path

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Set-Property([object]$Object, [string]$Name, [object]$Value) {
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value }
    else { $property.Value = $Value }
}

function Write-Json([string]$Path, [object]$Value) {
    [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 100) + "`n"), $Utf8NoBom)
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
        $file = Join-Path $Root ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
        $item = Get-Item -LiteralPath $file
        $hash = Get-Sha256 $file
        $rows.Add([ordered]@{ path = $relative; size = $item.Length; sha256 = $hash })
        [void]$canonical.Append($relative).Append("`t").Append($item.Length).Append("`t").Append($hash).Append("`n")
    }
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($hasher.ComputeHash($Utf8NoBom.GetBytes($canonical.ToString())))).Replace('-', '') }
    finally { $hasher.Dispose() }
    return [pscustomobject]@{ rows = $rows.ToArray(); file_count = $rows.Count; sha256 = $digest }
}

function Add-OrReplaceManifestFile([object]$Manifest, [string]$RuntimeRoot, [string]$Relative) {
    $file = Join-Path $RuntimeRoot ($Relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
    $item = Get-Item -LiteralPath $file
    $record = [pscustomobject][ordered]@{
        path = $Relative
        size = $item.Length
        sha256 = Get-Sha256 $file
        classification = 'RUNTIME_SOURCE'
        source = 'TEST5:materialize-sporno-drafts-r3'
    }
    Set-Property $Manifest 'files' @(@($Manifest.files | Where-Object { [string]$_.path -ne $Relative }) + $record)
}

function New-DeterministicZip([string]$SourceRoot, [string]$Destination) {
    $parent = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
    $stream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false, $Utf8NoBom)
        try {
            foreach ($relative in Get-RelativeFiles -Root $SourceRoot) {
                $source = Join-Path $SourceRoot ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
                $entry = $archive.CreateEntry('OPIU/' + $relative, [IO.Compression.CompressionLevel]::Optimal)
                $entry.LastWriteTime = $FixedTimestamp
                $input = [IO.File]::OpenRead($source)
                $output = $entry.Open()
                try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
            }
        } finally { $archive.Dispose() }
    } finally { $stream.Dispose() }
}

$resolvedInput = (Resolve-Path -LiteralPath $Test4BZip).Path
$resolvedOutput = [IO.Path]::GetFullPath($OutputZip)
if (Test-Path -LiteralPath $resolvedOutput) { throw "Output already exists: $resolvedOutput" }
if ((Get-Sha256 $resolvedInput) -ne $ExpectedInputSha256) { throw 'Unexpected TEST4B SHA256' }

$overlay = [ordered]@{
    'modules/corrections/source/correction_engine_r001.mjs' = 'development/OPIU_1.9.4/modules/corrections/source/correction_engine_r001.mjs'
    'modules/corrections/source/service_r001_owner_wrapper.mjs' = 'development/OPIU_1.9.4/modules/corrections/source/service_r001_owner_wrapper.mjs'
    'modules/corrections/source/r001_sporno_materialization.mjs' = 'development/OPIU_1.9.4/modules/corrections/source/r001_sporno_materialization.mjs'
    'modules/reconciliation/source/full_operation_evidence.mjs' = 'development/OPIU_1.9.4/modules/reconciliation/source/full_operation_evidence.mjs'
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('opiu-test5-build-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $tempRoot | Out-Null
    [IO.Compression.ZipFile]::ExtractToDirectory($resolvedInput, $tempRoot)
    $bundleRoot = Join-Path $tempRoot 'OPIU'
    $runtimeRoot = Join-Path $bundleRoot 'runtime'
    if ((Get-Sha256 (Join-Path $bundleRoot 'OPIU_STABLE_Service.exe')) -ne $ExpectedExeSha256) { throw 'TEST4B service EXE identity changed' }

    $runtimeManifestPath = Join-Path $runtimeRoot 'MANIFEST.json'
    $runtimeManifest = Get-Content -LiteralPath $runtimeManifestPath -Raw | ConvertFrom-Json
    $overlayHashes = [ordered]@{}
    foreach ($relative in $overlay.Keys) {
        $source = Join-Path $RepositoryRoot $overlay[$relative]
        $target = Join-Path $runtimeRoot ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
        $targetParent = Split-Path -Parent $target
        if (-not (Test-Path -LiteralPath $targetParent)) { New-Item -ItemType Directory -Path $targetParent | Out-Null }
        [IO.File]::Copy($source, $target, $true)
        $overlayHashes[$relative] = Get-Sha256 $target
        Add-OrReplaceManifestFile $runtimeManifest $runtimeRoot $relative
    }

    $runtimeInventory = Get-Inventory -Root $runtimeRoot -Exclude @('MANIFEST.json')
    $test5Record = [pscustomobject][ordered]@{
        schema_version = 'opiu-test5-sporno-drafts.v1'
        work_id = $WorkID
        source_head_sha = $SourceHead.ToLowerInvariant()
        input_test4b_sha256 = $ExpectedInputSha256
        service_exe_reused = $true
        overlay_hashes = $overlayHashes
        actual_runtime_file_count = $runtimeInventory.file_count + 1
        runtime_inventory_sha256 = $runtimeInventory.sha256
        draft_contract = [ordered]@{
            materialized_posting_rows_may_be_nonzero = $true
            disputed_suffix = '_ОПИУ_ГОТОВО_СПОРНО.xlsx'
            executed_posting_rows = 0
            live_posting_rows = 0
            execution_allowed = $false
            live_1c_allowed = $false
            live_delete_allowed = $false
        }
    }
    Set-Property $runtimeManifest 'test5_sporno_drafts' $test5Record
    Write-Json $runtimeManifestPath $runtimeManifest

    $readme = @"
OPIU 1.9.4 — SPORNO DRAFTS TEST5

Назначение: проверка материализации DRAFT STORNO/REPOST из точных строк ERP.
Неопределённые действия явно маркируются _СПОРНО и разделяются по организации источника ERP.

Это REPORT_ONLY-пакет. Материализованные posting_rows могут быть больше нуля,
но executed_posting_rows=0, live_posting_rows=0, execution_allowed=false,
live_1c_allowed=false и live_delete_allowed=false.

Input TEST4B SHA256: $ExpectedInputSha256
Implementation head: $($SourceHead.ToLowerInvariant())
"@
    [IO.File]::WriteAllText((Join-Path $bundleRoot 'TEST5_README_RU.txt'), $readme.Replace("`n", "`r`n"), $Utf8NoBom)

    $runtimeManifestSha256 = Get-Sha256 $runtimeManifestPath
    $provenancePath = Join-Path $bundleRoot 'BUNDLE_PROVENANCE.json'
    $provenance = Get-Content -LiteralPath $provenancePath -Raw | ConvertFrom-Json
    Set-Property $provenance 'implementation' 'SPORNO_DRAFTS_TEST5_REPORT_ONLY'
    Set-Property $provenance 'runtime_manifest_sha256' $runtimeManifestSha256
    Set-Property $provenance 'test5_sporno_drafts' $test5Record
    Set-Property $provenance 'test4b_user_test_candidate' $false
    Set-Property $provenance 'test5_user_test_candidate' $true
    Write-Json $provenancePath $provenance

    $bundleInventory = Get-Inventory -Root $bundleRoot -Exclude @('BUNDLE_MANIFEST.json')
    $bundleManifest = $provenance | ConvertTo-Json -Depth 100 | ConvertFrom-Json
    Set-Property $bundleManifest 'file_count' $bundleInventory.file_count
    Set-Property $bundleManifest 'files' $bundleInventory.rows
    Write-Json (Join-Path $bundleRoot 'BUNDLE_MANIFEST.json') $bundleManifest
    New-DeterministicZip -SourceRoot $bundleRoot -Destination $resolvedOutput

    $archive = [IO.Compression.ZipFile]::OpenRead($resolvedOutput)
    try {
        $names = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') } | ForEach-Object FullName)
        foreach ($relative in $overlay.Keys) {
            if (('OPIU/runtime/' + $relative) -notin $names) { throw "Final TEST5 ZIP missing $relative" }
        }
        if ('OPIU/TEST5_README_RU.txt' -notin $names) { throw 'Final TEST5 ZIP missing README' }
        if (@($names | Where-Object { $_.Contains([char]0xfffd) -or $_ -match '[╨╤]' }).Count -ne 0) { throw 'Final TEST5 ZIP contains mojibake paths' }
    } finally { $archive.Dispose() }

    [ordered]@{
        status = 'BUILT'
        work_id = $WorkID
        package_path = $resolvedOutput
        package_size = (Get-Item -LiteralPath $resolvedOutput).Length
        package_sha256 = Get-Sha256 $resolvedOutput
        input_test4b_sha256 = $ExpectedInputSha256
        service_exe_sha256 = $ExpectedExeSha256
        service_exe_changed = $false
        overlay_hashes = $overlayHashes
        runtime_inventory_sha256 = $runtimeInventory.sha256
        runtime_manifest_sha256 = $runtimeManifestSha256
        executed_posting_rows = 0
        live_posting_rows = 0
        execution_allowed = $false
        live_1c_allowed = $false
    } | ConvertTo-Json -Depth 10
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
        $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        if ($resolvedTemp.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedTemp).StartsWith('opiu-test5-build-', [StringComparison]::Ordinal)) {
            Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
        }
    }
}
