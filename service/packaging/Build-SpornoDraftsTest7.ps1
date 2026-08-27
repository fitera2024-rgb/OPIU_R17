[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Test6Zip,
    [Parameter(Mandatory = $true)][string]$OutputZip,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$SourceHead
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ExpectedInputSha256 = '667C625DD5C5BB90C2177A866A23454782AF6C39E087E53F3E8F98503B6ACE06'
$ExpectedExeSha256 = '220B31545D637546D095C105D5E0726F06B02DBDD07AD7A6613D38E32147716B'
$WorkID = 'OPIU-2026-08-19-FINAL-OWNER-CONTRACT-TEST7'
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
    [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 100) + [Environment]::NewLine), $Utf8NoBom)
}

function Get-RelativeFiles([string]$Root) {
    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $paths = [Collections.Generic.List[string]]::new()
    foreach ($file in Get-ChildItem -LiteralPath $resolvedRoot -Recurse -File) {
        $paths.Add($file.FullName.Substring($resolvedRoot.Length + 1).Replace('\', '/'))
    }
    $result = $paths.ToArray()
    [Array]::Sort($result, [StringComparer]::Ordinal)
    return $result
}

function Get-Inventory([string]$Root) {
    $rows = [Collections.Generic.List[object]]::new()
    $canonical = [Text.StringBuilder]::new()
    foreach ($relative in Get-RelativeFiles -Root $Root) {
        $file = Join-Path $Root ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
        $item = Get-Item -LiteralPath $file
        $hash = Get-Sha256 $file
        $rows.Add([ordered]@{ path = $relative; size = $item.Length; sha256 = $hash })
        [void]$canonical.Append($relative).Append([char]9).Append($item.Length).Append([char]9).Append($hash).Append([Environment]::NewLine)
    }
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($hasher.ComputeHash($Utf8NoBom.GetBytes($canonical.ToString())))).Replace('-', '') }
    finally { $hasher.Dispose() }
    return [pscustomobject]@{ rows = $rows.ToArray(); file_count = $rows.Count; sha256 = $digest }
}

function Get-SourceModuleInventory([string]$Root) {
    $rows = [Collections.Generic.List[object]]::new()
    $canonical = [Text.StringBuilder]::new()
    foreach ($relative in Get-RelativeFiles -Root $Root) {
        $file = Join-Path $Root ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
        $item = Get-Item -LiteralPath $file
        $hash = Get-Sha256 $file
        $path = 'modules/' + $relative
        $rows.Add([ordered]@{ path = $path; size = $item.Length; sha256 = $hash })
        [void]$canonical.Append($path).Append([char]9).Append($item.Length).Append([char]9).Append($hash).Append([Environment]::NewLine)
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
        source = 'TEST7: current authoritative development/OPIU_1.9.4/modules'
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

$resolvedInput = (Resolve-Path -LiteralPath $Test6Zip).Path
$resolvedOutput = [IO.Path]::GetFullPath($OutputZip)
if (Test-Path -LiteralPath $resolvedOutput) { throw "Output already exists: $resolvedOutput" }
if ((Get-Sha256 $resolvedInput) -ne $ExpectedInputSha256) { throw 'Unexpected TEST6 SHA256' }

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('opiu-test7-build-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $tempRoot | Out-Null
    [IO.Compression.ZipFile]::ExtractToDirectory($resolvedInput, $tempRoot)
    $bundleRoot = Join-Path $tempRoot 'OPIU'
    $runtimeRoot = Join-Path $bundleRoot 'runtime'
    $serviceExe = Join-Path $bundleRoot 'OPIU_STABLE_Service.exe'
    if ((Get-Sha256 $serviceExe) -ne $ExpectedExeSha256) { throw 'TEST6 service EXE identity changed' }

    $sourceModulesRoot = Join-Path $RepositoryRoot 'development/OPIU_1.9.4/modules'
    $sourceInventory = Get-SourceModuleInventory -Root $sourceModulesRoot
    $oldRuntimeModuleInventory = Get-Inventory -Root (Join-Path $runtimeRoot 'modules')
    $runtimeManifestPath = Join-Path $runtimeRoot 'MANIFEST.json'
    $runtimeManifest = Get-Content -LiteralPath $runtimeManifestPath -Raw | ConvertFrom-Json
    $overlayHashes = [ordered]@{}

    foreach ($relative in Get-RelativeFiles -Root $sourceModulesRoot) {
        $source = Join-Path $sourceModulesRoot ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
        $runtimeRelative = 'modules/' + $relative
        $target = Join-Path $runtimeRoot ($runtimeRelative.Replace('/', [IO.Path]::DirectorySeparatorChar))
        $targetParent = Split-Path -Parent $target
        if (-not (Test-Path -LiteralPath $targetParent)) { New-Item -ItemType Directory -Path $targetParent | Out-Null }
        [IO.File]::Copy($source, $target, $true)
        $sourceHash = Get-Sha256 $source
        $targetHash = Get-Sha256 $target
        if ($sourceHash -ne $targetHash) { throw "Source/runtime byte mismatch: $runtimeRelative" }
        $overlayHashes[$runtimeRelative] = $targetHash
        Add-OrReplaceManifestFile $runtimeManifest $runtimeRoot $runtimeRelative
    }

    $runtimeModuleInventory = Get-Inventory -Root (Join-Path $runtimeRoot 'modules')
    $test7Record = [pscustomobject][ordered]@{
        schema_version = 'opiu-test7-owner-contract.v1'
        work_id = $WorkID
        source_head_sha = $SourceHead.ToLowerInvariant()
        input_test6_sha256 = $ExpectedInputSha256
        service_exe_reused = $true
        source_module_file_count = $sourceInventory.file_count
        source_module_inventory_sha256 = $sourceInventory.sha256
        source_module_inventory = $sourceInventory.rows
        old_runtime_module_inventory_sha256 = $oldRuntimeModuleInventory.sha256
        runtime_module_inventory_sha256 = $runtimeModuleInventory.sha256
        overlay_hashes = $overlayHashes
        draft_contract = [ordered]@{
            expected_files = @(
                '[ГК][30.11.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx',
                '[ООО  Группа компаний  Планета][30.11.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx',
                '[ООО  Планета Инноваций][30.11.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx'
            )
            sheet = 'Загрузка_A_AA'
            columns = 'A:AA'
            posting_rows = 13
            storno_rows = 6
            repost_rows = 7
            executed_posting_rows = 0
            live_posting_rows = 0
            execution_allowed = $false
            live_1c_allowed = $false
            live_delete_allowed = $false
        }
    }
    Set-Property $runtimeManifest 'test7_owner_contract' $test7Record
    Write-Json $runtimeManifestPath $runtimeManifest

    $readme = @"
OPIU 1.9.4 — SPORNO DRAFTS TEST7

Назначение: финальная проверка owner-контракта для DRAFT STORNO/REPOST на реальных ноябрьских данных.
Runtime modules byte-for-byte импортированы из development/OPIU_1.9.4/modules.

Это REPORT_ONLY-пакет. Материализованные posting_rows могут быть больше нуля,
но executed_posting_rows=0, live_posting_rows=0, execution_allowed=false,
live_1c_allowed=false и live_delete_allowed=false.

Input TEST6 SHA256: $ExpectedInputSha256
Implementation head: $($SourceHead.ToLowerInvariant())
Authoritative modules: $($sourceInventory.file_count) files / $($sourceInventory.sha256)
"@
    [IO.File]::WriteAllText((Join-Path $bundleRoot 'TEST7_README_RU.txt'), $readme, $Utf8NoBom)

    $runtimeInventory = Get-Inventory -Root $runtimeRoot
    $runtimeManifestSha256 = Get-Sha256 $runtimeManifestPath
    $provenancePath = Join-Path $bundleRoot 'BUNDLE_PROVENANCE.json'
    $provenance = Get-Content -LiteralPath $provenancePath -Raw | ConvertFrom-Json
    Set-Property $provenance 'implementation' 'SPORNO_DRAFTS_TEST7_REPORT_ONLY'
    Set-Property $provenance 'runtime_manifest_sha256' $runtimeManifestSha256
    Set-Property $provenance 'service_exe_sha256' $ExpectedExeSha256
    Set-Property $provenance 'test7_owner_contract' $test7Record
    Set-Property $provenance 'test7_user_test_candidate' $true
    Set-Property $provenance 'test6_user_test_candidate' $false
    Write-Json $provenancePath $provenance

    $bundleInventory = Get-Inventory -Root $bundleRoot
    $bundleManifest = $provenance | ConvertTo-Json -Depth 100 | ConvertFrom-Json
    Set-Property $bundleManifest 'file_count' $bundleInventory.file_count
    Set-Property $bundleManifest 'files' $bundleInventory.rows
    Write-Json (Join-Path $bundleRoot 'BUNDLE_MANIFEST.json') $bundleManifest
    New-DeterministicZip -SourceRoot $bundleRoot -Destination $resolvedOutput

    $archive = [IO.Compression.ZipFile]::OpenRead($resolvedOutput)
    try {
        $names = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') } | ForEach-Object FullName)
        foreach ($relative in $sourceInventory.rows.path) {
            if (('OPIU/runtime/' + $relative) -notin $names) { throw "Final TEST7 ZIP missing $relative" }
        }
        if ('OPIU/TEST7_README_RU.txt' -notin $names) { throw 'Final TEST7 ZIP missing README' }
        if (@($names | Where-Object { $_.Contains([char]0xfffd) -or $_ -match '[╨╤]' }).Count -ne 0) { throw 'Final TEST7 ZIP contains mojibake paths' }
    } finally { $archive.Dispose() }

    [ordered]@{
        status = 'BUILT'
        work_id = $WorkID
        package_path = $resolvedOutput
        package_size = (Get-Item -LiteralPath $resolvedOutput).Length
        package_sha256 = Get-Sha256 $resolvedOutput
        input_test6_sha256 = $ExpectedInputSha256
        service_exe_sha256 = $ExpectedExeSha256
        service_exe_changed = $false
        source_head_sha = $SourceHead.ToLowerInvariant()
        source_module_file_count = $sourceInventory.file_count
        source_module_inventory_sha256 = $sourceInventory.sha256
        old_runtime_module_inventory_sha256 = $oldRuntimeModuleInventory.sha256
        runtime_module_inventory_sha256 = $runtimeModuleInventory.sha256
        runtime_manifest_sha256 = $runtimeManifestSha256
        executed_posting_rows = 0
        live_posting_rows = 0
        execution_allowed = $false
        live_1c_allowed = $false
        live_delete_allowed = $false
    } | ConvertTo-Json -Depth 20
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
        $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        if ($resolvedTemp.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedTemp).StartsWith('opiu-test7-build-', [StringComparison]::Ordinal)) {
            [IO.Directory]::Delete($resolvedTemp, $true)
        }
    }
}
