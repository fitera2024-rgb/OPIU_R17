[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PackagePath,

    [Parameter(Mandatory = $true)]
    [string]$Test4FixedZip,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F]{40}$')]
    [string]$ExpectedSourceHead
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ExpectedInputSha256 = '55637B9553D7DD5BD86927A7241D987244EFCF39DD6C5E67D83E9176ACC52EEA'
$ExpectedTest3Sha256 = 'AB0FFC72D5171B0EFDB0CD194D6632FC7A27AF6FC82F6ED59504622E1A8C7A5A'
$ExpectedExeSha256 = '220B31545D637546D095C105D5E0726F06B02DBDD07AD7A6613D38E32147716B'
$ExpectedR005CoreSha256 = 'E87A4C2415216C6DA688A6A98B7FF1AC0D95C7E0ADAE75BD447C12DB21E90990'
$ExpectedR001CoreSha256 = '85C1C8514B5B49F17D43EF97C2754CBAFDEB2E64867569200917BEC34D5F86C9'
$RequiredOwnerFiles = @(
    'runtime/modules/reconciliation/source/owner_decision_policy.json',
    'runtime/modules/reconciliation/source/owner_decision_projection.mjs',
    'runtime/modules/reconciliation/source/owner_decision_xlsx.mjs',
    'runtime/modules/reconciliation/source/service_r005_owner_wrapper.mjs',
    'runtime/modules/corrections/source/owner_decision_r001.mjs',
    'runtime/modules/corrections/source/service_r001_owner_wrapper.mjs'
)
$AllowedChangedFiles = @(
    'BUNDLE_MANIFEST.json',
    'BUNDLE_PROVENANCE.json',
    'TEST4_README_RU.txt',
    'runtime/MANIFEST.json',
    'ЗАПУСТИТЬ_OPIU_STABLE.cmd'
)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Get-EntryHash([IO.Compression.ZipArchiveEntry]$Entry) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    $stream = $Entry.Open()
    try { return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '') }
    finally { $stream.Dispose(); $hasher.Dispose() }
}

function Read-EntryText([IO.Compression.ZipArchiveEntry]$Entry) {
    $stream = $Entry.Open()
    $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false), $true)
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

function Assert-StrictSafety([object]$Safety, [string]$Label) {
    foreach ($name in @('mode', 'posting_rows', 'execution_allowed', 'ready_to_upload', 'release_allowed', 'live_1c_allowed')) {
        if ($null -eq $Safety.PSObject.Properties[$name]) { throw "$Label missing required field: $name" }
    }
    if ($Safety.mode -ne 'REPORT_ONLY' -or
        [int]$Safety.posting_rows -ne 0 -or
        [bool]$Safety.execution_allowed -ne $false -or
        [bool]$Safety.ready_to_upload -ne $false -or
        [bool]$Safety.release_allowed -ne $false -or
        [bool]$Safety.live_1c_allowed -ne $false) {
        throw "$Label is unsafe"
    }
}

function Invoke-Node([string]$Node, [string]$WorkingDirectory, [string[]]$Arguments, [string]$Label) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Node
    $start.WorkingDirectory = $WorkingDirectory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.Environment['NODE_PATH'] = ''
    $start.Environment['NODE_OPTIONS'] = ''
    foreach ($argument in $Arguments) { [void]$start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    if (-not $process.Start()) { throw "$Label did not start" }
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "$Label failed with $($process.ExitCode): $stderr $stdout" }
    return [pscustomobject]@{ stdout = $stdout.Trim(); stderr = $stderr.Trim() }
}

$resolvedPackage = (Resolve-Path -LiteralPath $PackagePath).Path
$resolvedBase = (Resolve-Path -LiteralPath $Test4FixedZip).Path
if ((Get-Sha256 $resolvedBase) -ne $ExpectedInputSha256) { throw 'Unexpected TEST4_FIXED SHA256' }

$finalMap = Get-ZipMap $resolvedPackage
$baseMap = Get-ZipMap $resolvedBase
$baseNonAsciiRuntimePaths = @(
    $baseMap.Keys |
        Where-Object { $_.StartsWith('runtime/', [StringComparison]::Ordinal) -and $_ -match '[^\x00-\x7F]' } |
        Sort-Object
)
$finalNonAsciiRuntimePaths = @(
    $finalMap.Keys |
        Where-Object { $_.StartsWith('runtime/', [StringComparison]::Ordinal) -and $_ -match '[^\x00-\x7F]' } |
        Sort-Object
)
if (($baseNonAsciiRuntimePaths -join "`n") -ne ($finalNonAsciiRuntimePaths -join "`n")) {
    throw 'Final ZIP non-ASCII runtime paths differ from the verified TEST4_FIXED source paths'
}
$added = @($finalMap.Keys | Where-Object { -not $baseMap.ContainsKey($_) } | Sort-Object)
$removed = @($baseMap.Keys | Where-Object { -not $finalMap.ContainsKey($_) } | Sort-Object)
$changed = @($baseMap.Keys | Where-Object { $finalMap.ContainsKey($_) -and $baseMap[$_].hash -ne $finalMap[$_].hash } | Sort-Object)
$expectedAdded = @(
    'runtime/modules/corrections/source/service_r001_owner_wrapper.mjs',
    'runtime/modules/reconciliation/source/service_r005_owner_wrapper.mjs'
) | Sort-Object
if (($added -join "`n") -ne ($expectedAdded -join "`n")) { throw "Unexpected added files: $($added -join ', ')" }
if ($removed.Count -ne 0) { throw "Files removed from TEST4_FIXED: $($removed -join ', ')" }
if (@($changed | Where-Object { $_ -notin $AllowedChangedFiles }).Count -ne 0) {
    throw "Unexpected changed files: $(($changed | Where-Object { $_ -notin $AllowedChangedFiles }) -join ', ')"
}
foreach ($requiredChange in $AllowedChangedFiles) {
    if ($requiredChange -notin $changed) { throw "Expected packaging metadata/startup change is absent: $requiredChange" }
}

if ($finalMap['OPIU_STABLE_Service.exe'].hash -ne $ExpectedExeSha256) { throw 'Service EXE changed' }
if ($finalMap['runtime/modules/reconciliation/source/opiu_reconcile_core.mjs'].hash -ne $ExpectedR005CoreSha256) { throw 'R005 protected core changed' }
if ($finalMap['runtime/modules/corrections/source/correction_engine_r001_core.mjs'].hash -ne $ExpectedR001CoreSha256) { throw 'R001 protected core changed' }
foreach ($required in $RequiredOwnerFiles) {
    if (-not $finalMap.ContainsKey($required)) { throw "Required owner file missing: $required" }
}
if ($finalMap['runtime/modules/reconciliation/source/service_r005_owner_wrapper.mjs'].hash -ne $finalMap['runtime/modules/reconciliation/source/opiu_reconcile.mjs'].hash) {
    throw 'R005 wrapper alias is not the verified TEST4_FIXED wrapper byte'
}
if ($finalMap['runtime/modules/corrections/source/service_r001_owner_wrapper.mjs'].hash -ne $finalMap['runtime/modules/corrections/source/correction_engine_r001.mjs'].hash) {
    throw 'R001 wrapper alias is not the verified TEST4_FIXED wrapper byte'
}

$archive = [IO.Compression.ZipFile]::OpenRead($resolvedPackage)
try {
    $entries = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
    $names = @($entries | ForEach-Object { $_.FullName })
    $caseCollisions = @($names | Group-Object { $_.ToUpperInvariant() } | Where-Object { $_.Count -gt 1 })
    if ($caseCollisions.Count -ne 0) { throw 'ZIP contains Windows case-colliding paths' }
    $badNames = @($names | Where-Object { $_.Contains([char]0xfffd) -or $_ -match '[╨╤]' })
    if ($badNames.Count -ne 0) { throw "ZIP contains mojibake names: $($badNames -join ', ')" }
    $unicodePath = 'OPIU/runtime/modules/reconciliation/source/external_reference/erp/ОПИУ_Структура_ерп.xlsx'
    if ($unicodePath -notin $names) { throw 'Exact Unicode ERP structure filename is absent' }

    $safetyEntry = $entries | Where-Object { $_.FullName -eq 'OPIU/runtime/SAFETY.json' } | Select-Object -First 1
    $manifestEntry = $entries | Where-Object { $_.FullName -eq 'OPIU/runtime/MANIFEST.json' } | Select-Object -First 1
    $provenanceEntry = $entries | Where-Object { $_.FullName -eq 'OPIU/BUNDLE_PROVENANCE.json' } | Select-Object -First 1
    $safety = (Read-EntryText $safetyEntry) | ConvertFrom-Json
    $manifest = (Read-EntryText $manifestEntry) | ConvertFrom-Json
    $provenance = (Read-EntryText $provenanceEntry) | ConvertFrom-Json
    Assert-StrictSafety $safety 'runtime SAFETY.json'
    Assert-StrictSafety $manifest.safety 'runtime MANIFEST.json/safety'
    Assert-StrictSafety $provenance.safety 'BUNDLE_PROVENANCE.json/safety'
    if ([string]$provenance.test4b_startup_packaging_fix.source_head_sha -ne $ExpectedSourceHead.ToLowerInvariant()) {
        throw 'Package provenance source head mismatch'
    }
    if ([string]$provenance.test4b_startup_packaging_fix.input_test3_sha256 -ne $ExpectedTest3Sha256) {
        throw 'Package provenance TEST3 mismatch'
    }
    if ([string]$provenance.runtime_manifest_sha256 -ne (Get-EntryHash $manifestEntry)) {
        throw 'Package provenance runtime manifest hash mismatch'
    }
} finally { $archive.Dispose() }

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('opiu-test4b-test-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $tempRoot | Out-Null
    [IO.Compression.ZipFile]::ExtractToDirectory($resolvedPackage, $tempRoot)
    $bundleRoot = Join-Path $tempRoot 'OPIU'
    $extracted = @(
        Get-ChildItem -LiteralPath $bundleRoot -Recurse -File |
            ForEach-Object { 'OPIU/' + $_.FullName.Substring($bundleRoot.Length + 1).Replace('\', '/') }
    ) | Sort-Object
    $zipped = @($finalMap.Keys | ForEach-Object { 'OPIU/' + $_ }) | Sort-Object
    if (($extracted -join "`n") -ne ($zipped -join "`n")) { throw 'Extracted Windows paths do not exactly match ZIP paths' }
    foreach ($required in $RequiredOwnerFiles) {
        $path = Join-Path $bundleRoot ($required.Replace('/', [IO.Path]::DirectorySeparatorChar))
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Extracted owner file missing: $required" }
    }

    $runtimeRoot = Join-Path $bundleRoot 'runtime'
    $node = Join-Path $runtimeRoot 'runtime/node/node.exe'
    $importScript = @'
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = process.argv[1];
for (const relative of [
  "modules/reconciliation/source/service_r005_owner_wrapper.mjs",
  "modules/reconciliation/source/opiu_reconcile_core.mjs",
  "modules/reconciliation/source/owner_decision_xlsx.mjs",
  "modules/corrections/source/service_r001_owner_wrapper.mjs",
  "modules/corrections/source/owner_decision_r001.mjs",
  "modules/reconciliation/source/owner_decision_projection.mjs"
]) await import(pathToFileURL(path.join(root, relative)).href);
console.log("PACKAGED_IMPORTS_OK");
'@
    $imports = Invoke-Node -Node $node -WorkingDirectory $runtimeRoot -Arguments @('--input-type=module', '-e', $importScript, $runtimeRoot) -Label 'Packaged owner import smoke'
    $core = Invoke-Node -Node $node -WorkingDirectory $runtimeRoot -Arguments @((Join-Path $runtimeRoot 'modules/reconciliation/source/opiu_reconcile_core.mjs'), 'help') -Label 'Packaged R005 core launch'
    $launcherText = Get-Content -LiteralPath (Join-Path $bundleRoot 'ЗАПУСТИТЬ_OPIU_STABLE.cmd') -Raw
    if ($launcherText -notmatch '/api/health' -or $launcherText -notmatch 'exit 100' -or $launcherText -notmatch 'OPIU_LAUNCHER_NO_BROWSER') {
        throw 'Idempotent launcher contract is absent'
    }

    $runtimeManifestPath = Join-Path $runtimeRoot 'MANIFEST.json'
    $runtimeSafetyPath = Join-Path $runtimeRoot 'SAFETY.json'
    $runtimeManifest = Get-Content -LiteralPath $runtimeManifestPath -Raw | ConvertFrom-Json
    $actualRuntimeCount = @(Get-ChildItem -LiteralPath $runtimeRoot -Recurse -File).Count
    if ([int]$runtimeManifest.test4b_startup_packaging_fix.actual_runtime_file_count -ne $actualRuntimeCount) {
        throw "Runtime file count mismatch: expected $($runtimeManifest.test4b_startup_packaging_fix.actual_runtime_file_count), actual $actualRuntimeCount"
    }

    [ordered]@{
        status = 'PASS'
        package_path = $resolvedPackage
        package_size = (Get-Item -LiteralPath $resolvedPackage).Length
        package_sha256 = Get-Sha256 $resolvedPackage
        service_exe_sha256 = $ExpectedExeSha256
        service_exe_changed = $false
        final_file_count = $finalMap.Count
        materialized_manifest_file_count = @($runtimeManifest.files).Count
        actual_runtime_file_count = $actualRuntimeCount
        runtime_inventory_sha256 = [string]$runtimeManifest.test4b_startup_packaging_fix.runtime_inventory_sha256
        runtime_manifest_sha256 = Get-Sha256 $runtimeManifestPath
        runtime_safety_sha256 = Get-Sha256 $runtimeSafetyPath
        unicode_filename_test = 'PASS_EXACT_ZIP_AND_WINDOWS_EXTRACTION'
        non_ascii_runtime_path_count = $finalNonAsciiRuntimePaths.Count
        non_ascii_runtime_paths_match_source = $true
        packaged_import_smoke = $imports.stdout
        packaged_r005_core_smoke = if ([string]::IsNullOrWhiteSpace($core.stdout)) { 'PASS' } else { $core.stdout }
        only_added = $added
        changed_packaging_files = $changed
        removed_files = $removed
        posting_rows = 0
        execution_allowed = $false
        ready_to_upload = $false
        release_allowed = $false
        live_1c_allowed = $false
    } | ConvertTo-Json -Depth 10
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
        $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        if ($resolvedTemp.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and
            [IO.Path]::GetFileName($resolvedTemp).StartsWith('opiu-test4b-test-', [StringComparison]::Ordinal)) {
            Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
        }
    }
}
