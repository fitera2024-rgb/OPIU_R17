param(
    [Parameter(Position = 0)]
    [ValidateSet("init", "run", "status", "help", "detect-period", "journal-status", "build-codex-package")]
    [string]$Command = "help",

    [string]$Intalev,
    [string]$IntalevArticles,
    [string]$ERP,

    [ValidateSet("month", "quarter", "year")]
    [string]$Mode,

    [string]$Period,
    [string]$Organization,
    [string]$Output,
    [string]$CodexInput,
    [string]$Decisions,
    [string]$Rules,
    [string]$PackageOutput,
    [switch]$Render
)

$ErrorActionPreference = "Stop"
try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $utf8NoBom
    $OutputEncoding = $utf8NoBom
} catch {}

function Test-ErpJournalWorkbookContent {
    param([System.IO.Stream]$WorkbookStream)

    Add-Type -AssemblyName System.IO.Compression
    $memory = New-Object System.IO.MemoryStream
    $innerArchive = $null
    try {
        $WorkbookStream.CopyTo($memory)
        $memory.Position = 0
        $innerArchive = New-Object System.IO.Compression.ZipArchive($memory, [System.IO.Compression.ZipArchiveMode]::Read, $true)
        $parts = New-Object System.Collections.Generic.List[string]
        foreach ($innerEntry in $innerArchive.Entries) {
            $name = $innerEntry.FullName.Replace('\', '/').ToLowerInvariant()
            if ($name -ne 'xl/sharedstrings.xml' -and $name -notmatch '^xl/worksheets/sheet\d+\.xml$') { continue }
            $entryStream = $innerEntry.Open()
            $reader = New-Object System.IO.StreamReader($entryStream, [Text.Encoding]::UTF8, $true)
            try { $parts.Add($reader.ReadToEnd()) } finally { $reader.Dispose(); $entryStream.Dispose() }
        }
        $content = [string]::Join("`n", $parts)
        if ([string]::IsNullOrWhiteSpace($content)) { return $false }
        $requiredHeaders = @(
            'Дата', 'Документ', 'НомерСтроки', 'СчетДт', 'СчетКт',
            'СуммаВВалютеОтчетности', 'Организация', 'СтатьяДоходовИРасходов'
        )
        foreach ($header in $requiredHeaders) {
            if ($content.IndexOf($header, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
        }
        return $true
    }
    catch { return $false }
    finally {
        if ($null -ne $innerArchive) { $innerArchive.Dispose() }
        $memory.Dispose()
    }
}

function Get-ErpJournalArchiveInfo {
    param([string]$Path)

    $result = [ordered]@{
        status = "MISSING"
        severity = "warning"
        message = "В ERP-источнике не найден журнал проводок. Сверка ОПИУ продолжится, но расшифровка до проводок будет заблокирована."
        compatible_count = 0
        loose_count = 0
        will_normalize = $false
        entries = @()
    }
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        $result.message = "ERP-источник не найден; журнал проводок не проверен."
        return [pscustomobject]$result
    }
    if (-not [string]::Equals([IO.Path]::GetExtension($Path), ".zip", [StringComparison]::OrdinalIgnoreCase)) {
        if ([string]::Equals([IO.Path]::GetExtension($Path), ".xlsx", [StringComparison]::OrdinalIgnoreCase)) {
            $fileStream = $null
            try {
                $fileStream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
                if (Test-ErpJournalWorkbookContent $fileStream) {
                    $result.status = "JOURNAL_ONLY"
                    $result.message = "По обязательным колонкам определён отдельный журнал проводок. Он будет сохранён в роли журнала, но не заменит годовой источник ERP ОПИУ."
                    return [pscustomobject]$result
                }
            }
            finally { if ($null -ne $fileStream) { $fileStream.Dispose() } }
        }
        $result.message = "Выбран отдельный Excel ERP без доказанного журнала проводок. Сверка ОПИУ продолжится, но расшифровка до проводок будет заблокирована. Загрузите ZIP или папку, где вместе находятся ОПИУ и журнал."
        return [pscustomobject]$result
    }

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stream = $null
    $archive = $null
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Read, $false)
        $compatible = @()
        $journalsByContent = @()
        foreach ($entry in $archive.Entries) {
            if ([string]::IsNullOrWhiteSpace($entry.Name) -or -not $entry.Name.EndsWith(".xlsx", [StringComparison]::OrdinalIgnoreCase)) { continue }
            $entryStream = $entry.Open()
            try { $isJournal = Test-ErpJournalWorkbookContent $entryStream } finally { $entryStream.Dispose() }
            if (-not $isJournal) { continue }
            $journalsByContent += $entry.FullName
            $name = $entry.Name.ToLowerInvariant()
            $isCompatible = ($entry.Name -match '(?i)_01_.*\.xlsx$') -and $name.Contains("журнал") -and $name.Contains("провод") -and $name.Contains("мсфо")
            if ($isCompatible) { $compatible += $entry.FullName }
        }
        $result.entries = @($journalsByContent)
        $result.compatible_count = @($compatible).Count
        $result.loose_count = @($journalsByContent).Count
        if (@($compatible).Count -gt 0) {
            $result.status = if (@($compatible).Count -eq 1) { "READY" } else { "MULTIPLE" }
            $result.severity = if (@($compatible).Count -eq 1) { "info" } else { "warning" }
            $result.message = if (@($compatible).Count -eq 1) {
                "Журнал проводок найден и будет передан движку вместе с ERP ОПИУ."
            } else {
                "Найдено несколько журналов проводок. Движок проверит выбранный период; при неоднозначности расшифровка до проводок будет заблокирована."
            }
            return [pscustomobject]$result
        }
        if (@($journalsByContent).Count -eq 1) {
            $result.status = "READY_WITH_ALIAS"
            $result.severity = "info"
            $result.will_normalize = $true
            $result.message = "Журнал проводок доказан по обязательным колонкам и будет передан движку под служебным именем. Исходный ERP ZIP не изменяется."
            return [pscustomobject]$result
        }
        if (@($journalsByContent).Count -gt 1) {
            $result.status = "MULTIPLE"
            $result.message = "По обязательным колонкам найдено несколько журналов проводок. Сверка ОПИУ продолжится, но расшифровка будет заблокирована, если период не определится однозначно."
        }
        return [pscustomobject]$result
    }
    catch {
        $result.status = "UNREADABLE"
        $result.message = "Не удалось проверить журнал внутри ERP ZIP: $($_.Exception.Message)"
        return [pscustomobject]$result
    }
    finally {
        if ($null -ne $archive) { $archive.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function New-ErpPackageWithJournalAlias {
    param(
        [string]$SourcePath,
        [string]$JournalEntry,
        [string]$SourceSha256
    )

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $serviceRoot = [string]$env:OPIU_SERVICE_ROOT
    if ([string]::IsNullOrWhiteSpace($serviceRoot)) {
        $serviceRoot = Join-Path $env:LOCALAPPDATA "OPIU_Service"
    }
    $runtimeRoot = Join-Path $serviceRoot "data\runtime\erp-engine-inputs"
    [void](New-Item -ItemType Directory -Path $runtimeRoot -Force)
    $targetPath = Join-Path $runtimeRoot ("v160_{0}_journal-normalized.zip" -f $SourceSha256)
    if (Test-Path -LiteralPath $targetPath -PathType Leaf) { return $targetPath }
    $temporaryPath = $targetPath + "." + [Guid]::NewGuid().ToString("N") + ".part"
    $sourceStream = $null
    $sourceArchive = $null
    $targetStream = $null
    $targetArchive = $null
    try {
        $sourceStream = [IO.File]::Open($SourcePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $sourceArchive = New-Object System.IO.Compression.ZipArchive($sourceStream, [System.IO.Compression.ZipArchiveMode]::Read, $false)
        $targetStream = [IO.File]::Open($temporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $targetArchive = New-Object System.IO.Compression.ZipArchive($targetStream, [System.IO.Compression.ZipArchiveMode]::Create, $true)
        $journalSource = $null
        foreach ($entry in $sourceArchive.Entries) {
            if ($entry.FullName -eq $JournalEntry) { $journalSource = $entry }
            $copy = $targetArchive.CreateEntry($entry.FullName, [IO.Compression.CompressionLevel]::Optimal)
            if ([string]::IsNullOrWhiteSpace($entry.Name)) { continue }
            $input = $entry.Open()
            $output = $copy.Open()
            try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
        }
        if ($null -eq $journalSource) { throw "Журнал $JournalEntry не найден при подготовке пакета." }
        $journalDirectory = [IO.Path]::GetDirectoryName($journalSource.FullName)
        $aliasName = "__OPIU_01_Журнал_проводок_МСФО.xlsx"
        $aliasPath = if ([string]::IsNullOrWhiteSpace($journalDirectory)) { $aliasName } else { ($journalDirectory.TrimEnd('/', '\\') + "/" + $aliasName) }
        $alias = $targetArchive.CreateEntry($aliasPath, [IO.Compression.CompressionLevel]::Optimal)
        $input = $journalSource.Open()
        $output = $alias.Open()
        try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
        $targetArchive.Dispose(); $targetArchive = $null
        $targetStream.Dispose(); $targetStream = $null
        Move-Item -LiteralPath $temporaryPath -Destination $targetPath -Force
        return $targetPath
    }
    finally {
        if ($null -ne $targetArchive) { $targetArchive.Dispose() }
        if ($null -ne $targetStream) { $targetStream.Dispose() }
        if ($null -ne $sourceArchive) { $sourceArchive.Dispose() }
        if ($null -ne $sourceStream) { $sourceStream.Dispose() }
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) { Remove-Item -LiteralPath $temporaryPath -Force }
    }
}

function Resolve-ErpEngineInput {
    param([string]$Path)
    $info = Get-ErpJournalArchiveInfo $Path
    $resolvedPath = $Path
    if ($info.will_normalize -and @($info.entries).Count -eq 1) {
        $stream = $null
        try {
            $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
            $sourceSha256 = (Get-FileHash -Algorithm SHA256 -InputStream $stream).Hash
        }
        finally {
            if ($null -ne $stream) { $stream.Dispose() }
        }
        $resolvedPath = New-ErpPackageWithJournalAlias $Path ([string]$info.entries[0]) $sourceSha256
    }
    return [pscustomobject]@{ Path = $resolvedPath; Journal = $info }
}

if ($Command -eq "journal-status") {
    if (-not $ERP) { throw "Укажите -ERP с Excel или ZIP." }
    $journalInfo = Get-ErpJournalArchiveInfo $ERP
    Write-Output ("ERP_JOURNAL_JSON=" + ($journalInfo | ConvertTo-Json -Depth 5 -Compress))
    exit 0
}

$dependencies = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies"
$nodeCandidates = @(
    [string]$env:OPIU_NODE_EXE,
    (Join-Path $PSScriptRoot "..\..\..\runtime\node\node.exe"),
    (Join-Path $dependencies "node\bin\node.exe")
)
$node = $nodeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
$moduleCandidates = @(
    (Join-Path $PSScriptRoot "..\..\corrections\source\node_modules"),
    (Join-Path $dependencies "node\node_modules")
)
$modules = $moduleCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1
$junction = Join-Path $PSScriptRoot "node_modules"

if (-not $node) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) {
        throw "Встроенный Node.js не найден. Повторно распакуйте полный portable-пакет."
    }
    $node = $nodeCommand.Source
}

if (-not (Test-Path -LiteralPath $junction)) {
    if (-not $modules) {
        throw "Встроенные библиотеки Excel не найдены. Повторно распакуйте полный portable-пакет."
    }
    New-Item -ItemType Junction -Path $junction -Target $modules | Out-Null
}

if ($Command -eq "build-codex-package") {
    $scriptPath = Join-Path $PSScriptRoot "opiu_codex_package.mjs"
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        throw "Codex package builder was not found: $scriptPath"
    }
    $arguments = @($scriptPath)
    if ($CodexInput) { $arguments += @("--input", $CodexInput) }
    if ($Decisions) { $arguments += @("--decisions", $Decisions) }
    if ($Rules) { $arguments += @("--rules", $Rules) }
    if ($PackageOutput) { $arguments += @("--output", $PackageOutput) }
} else {
    $arguments = @((Join-Path $PSScriptRoot "opiu_reconcile.mjs"), $Command)
}

if ($Intalev) { $arguments += @("--intalev", $Intalev) }
if ($IntalevArticles) { $arguments += @("--intalev-articles", $IntalevArticles) }
if ($Command -eq "run" -and $ERP) {
    $resolvedErpInput = Resolve-ErpEngineInput $ERP
    Write-Output ("ERP_JOURNAL_JSON=" + ($resolvedErpInput.Journal | ConvertTo-Json -Depth 5 -Compress))
    $ERP = $resolvedErpInput.Path
}
if ($ERP) { $arguments += @("--erp", $ERP) }
if ($Command -eq "run" -and $ERP) {
    if (-not (Test-Path -LiteralPath $ERP -PathType Leaf)) {
        throw "Для проверенной версии выберите один ERP Excel-файл или ZIP-архив. Папка с несколькими файлами не закрепляется по SHA-256."
    }
    $erpStream = $null
    try {
        $erpStream = [IO.File]::Open($ERP, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $erpSha256 = (Get-FileHash -Algorithm SHA256 -InputStream $erpStream).Hash
    }
    finally {
        if ($null -ne $erpStream) { $erpStream.Dispose() }
    }
    $arguments += @("--erp-sha256", $erpSha256)
}
if ($Mode) { $arguments += @("--mode", $Mode) }
if ($Period) { $arguments += @("--period", $Period) }
if ($Organization) { $arguments += @("--organization", $Organization) }
if ($Output) { $arguments += @("--output", $Output) }
if ($Render) { $arguments += "--render" }

Push-Location $PSScriptRoot
try {
    & $node @arguments
    $engineExitCode = $LASTEXITCODE
}
finally { Pop-Location }
exit $engineExitCode
