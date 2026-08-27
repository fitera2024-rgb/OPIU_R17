[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackagePath,
    [Parameter(Mandatory = $true)][string]$Test4BZip,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedSourceHead
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ExpectedInputSha256 = '4767BE40FD3FABC57B55686DDC14F8FC143A5D7F4919D271F569E8CFCB5C2840'
$ExpectedExeSha256 = '220B31545D637546D095C105D5E0726F06B02DBDD07AD7A6613D38E32147716B'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant() }
function Get-EntryHash([IO.Compression.ZipArchiveEntry]$Entry) {
    $hasher = [Security.Cryptography.SHA256]::Create(); $stream = $Entry.Open()
    try { return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '') }
    finally { $stream.Dispose(); $hasher.Dispose() }
}
function Read-EntryText([IO.Compression.ZipArchiveEntry]$Entry) {
    $stream = $Entry.Open(); $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false), $true)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose(); $stream.Dispose() }
}
function Get-ZipMap([string]$Path) {
    $map = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
    $archive = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        foreach ($entry in $archive.Entries) {
            if ($entry.FullName.EndsWith('/')) { continue }
            $name = $entry.FullName -replace '^OPIU/', ''
            if ($map.ContainsKey($name)) { throw "Duplicate ZIP path: $name" }
            $map.Add($name, [pscustomobject]@{ hash = Get-EntryHash $entry; length = $entry.Length })
        }
    } finally { $archive.Dispose() }
    return $map
}

$resolvedPackage = (Resolve-Path -LiteralPath $PackagePath).Path
$resolvedBase = (Resolve-Path -LiteralPath $Test4BZip).Path
if ((Get-Sha256 $resolvedBase) -ne $ExpectedInputSha256) { throw 'Unexpected TEST4B SHA256' }
$finalMap = Get-ZipMap $resolvedPackage
$baseMap = Get-ZipMap $resolvedBase
$added = @($finalMap.Keys | Where-Object { -not $baseMap.ContainsKey($_) } | Sort-Object)
$removed = @($baseMap.Keys | Where-Object { -not $finalMap.ContainsKey($_) } | Sort-Object)
$changed = @($baseMap.Keys | Where-Object { $finalMap.ContainsKey($_) -and $baseMap[$_].hash -ne $finalMap[$_].hash } | Sort-Object)
$expectedAdded = @('TEST5_README_RU.txt', 'runtime/modules/corrections/source/r001_sporno_materialization.mjs') | Sort-Object
$expectedChanged = @(
    'BUNDLE_MANIFEST.json', 'BUNDLE_PROVENANCE.json', 'runtime/MANIFEST.json',
    'runtime/modules/corrections/source/correction_engine_r001.mjs',
    'runtime/modules/corrections/source/service_r001_owner_wrapper.mjs',
    'runtime/modules/reconciliation/source/full_operation_evidence.mjs'
) | Sort-Object
if (($added -join "`n") -ne ($expectedAdded -join "`n")) { throw "Unexpected added files: $($added -join ', ')" }
if ($removed.Count -ne 0) { throw "Removed files: $($removed -join ', ')" }
if (($changed -join "`n") -ne ($expectedChanged -join "`n")) { throw "Unexpected changed files: $($changed -join ', ')" }
if ($finalMap['OPIU_STABLE_Service.exe'].hash -ne $ExpectedExeSha256) { throw 'Service EXE changed' }

$archive = [IO.Compression.ZipFile]::OpenRead($resolvedPackage)
try {
    $entries = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
    $names = @($entries | ForEach-Object FullName)
    if (@($names | Group-Object { $_.ToUpperInvariant() } | Where-Object Count -gt 1).Count -ne 0) { throw 'Windows case-colliding paths' }
    if (@($names | Where-Object { $_.Contains([char]0xfffd) -or $_ -match '[╨╤]' }).Count -ne 0) { throw 'Mojibake path' }
    $manifestEntry = $entries | Where-Object FullName -eq 'OPIU/runtime/MANIFEST.json' | Select-Object -First 1
    $provenanceEntry = $entries | Where-Object FullName -eq 'OPIU/BUNDLE_PROVENANCE.json' | Select-Object -First 1
    $manifest = (Read-EntryText $manifestEntry) | ConvertFrom-Json
    $provenance = (Read-EntryText $provenanceEntry) | ConvertFrom-Json
    if ([string]$manifest.test5_sporno_drafts.source_head_sha -ne $ExpectedSourceHead.ToLowerInvariant()) { throw 'Runtime manifest source head mismatch' }
    if ([string]$manifest.test5_sporno_drafts.input_test4b_sha256 -ne $ExpectedInputSha256) { throw 'Runtime manifest TEST4B mismatch' }
    if ([bool]$manifest.test5_sporno_drafts.draft_contract.materialized_posting_rows_may_be_nonzero -ne $true) { throw 'Materialized posting contract absent' }
    foreach ($name in @('execution_allowed', 'live_1c_allowed', 'live_delete_allowed')) {
        if ([bool]$manifest.test5_sporno_drafts.draft_contract.$name -ne $false) { throw "$name is unsafe" }
    }
    if ([int]$manifest.test5_sporno_drafts.draft_contract.executed_posting_rows -ne 0 -or [int]$manifest.test5_sporno_drafts.draft_contract.live_posting_rows -ne 0) { throw 'Live rows are nonzero' }
    if ([string]$provenance.runtime_manifest_sha256 -ne (Get-EntryHash $manifestEntry)) { throw 'Provenance runtime manifest SHA mismatch' }
} finally { $archive.Dispose() }

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('opiu-test5-test-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $tempRoot | Out-Null
    [IO.Compression.ZipFile]::ExtractToDirectory($resolvedPackage, $tempRoot)
    $runtimeRoot = Join-Path $tempRoot 'OPIU/runtime'
    $node = Join-Path $runtimeRoot 'runtime/node/node.exe'
    $importScript = @'
import path from "node:path"; import { pathToFileURL } from "node:url";
const root=process.argv[1];
for(const relative of ["modules/corrections/source/r001_sporno_materialization.mjs","modules/corrections/source/correction_engine_r001.mjs","modules/corrections/source/service_r001_owner_wrapper.mjs","modules/reconciliation/source/full_operation_evidence.mjs"]) await import(pathToFileURL(path.join(root,relative)).href);
console.log("TEST5_PACKAGED_IMPORTS_OK");
'@
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $node; $start.WorkingDirectory = $runtimeRoot; $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    foreach ($argument in @('--input-type=module', '-e', $importScript, $runtimeRoot)) { [void]$start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::Start($start); $stdout = $process.StandardOutput.ReadToEnd(); $stderr = $process.StandardError.ReadToEnd(); $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "Packaged imports failed: $stderr $stdout" }
    [ordered]@{
        status = 'PASS'; package_path = $resolvedPackage; package_size = (Get-Item -LiteralPath $resolvedPackage).Length
        package_sha256 = Get-Sha256 $resolvedPackage; service_exe_sha256 = $ExpectedExeSha256; service_exe_changed = $false
        final_file_count = $finalMap.Count; added = $added; changed = $changed; removed = $removed
        packaged_import_smoke = $stdout.Trim(); executed_posting_rows = 0; live_posting_rows = 0
        execution_allowed = $false; live_1c_allowed = $false; live_delete_allowed = $false
    } | ConvertTo-Json -Depth 10
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        $resolvedTemp = [IO.Path]::GetFullPath($tempRoot); $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        if ($resolvedTemp.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedTemp).StartsWith('opiu-test5-test-', [StringComparison]::Ordinal)) { Remove-Item -LiteralPath $resolvedTemp -Recurse -Force }
    }
}
