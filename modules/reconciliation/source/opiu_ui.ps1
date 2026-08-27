param(
    [Parameter(Mandatory = $true)]
    [string]$AppDir,
    [switch]$SelfTest,
    [string]$PreviewPath,
    [string]$ContextPath,
    [string]$ReadyPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$launcherPath = Join-Path $AppDir "Запуск_сверки.ps1"
$currentSnapshotPath = Join-Path $AppDir "data\current.json"
$defaultOutputPath = Join-Path $AppDir "outputs"
$organizationProfilesPath = Join-Path $AppDir "organization_profiles.json"
$configPath = Join-Path $AppDir "config.json"
$xlsConverterPath = Join-Path $AppDir "convert_xls_to_xlsx.ps1"
$codexUiLoaderPath = Join-Path $AppDir "codex_ui_loader.ps1"
$codexUiPath = Join-Path $AppDir "opiu_codex_ui.ps1"
$codexPackageBuilderPath = Join-Path $AppDir "opiu_codex_package.mjs"

$defaultOrganization = "9 Управляющая компания"
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    try {
        $appConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not [string]::IsNullOrWhiteSpace([string]$appConfig.default_organization)) {
            $defaultOrganization = [string]$appConfig.default_organization
        }
    } catch {
        # Безопасное значение для текущей программы уже задано выше.
    }
}

function Test-Period {
    param(
        [string]$Mode,
        [string]$Period
    )

    switch ($Mode) {
        "month" { return $Period -match "^20\d{2}-(0[1-9]|1[0-2])$" }
        "quarter" { return $Period -match "^20\d{2}-Q[1-4]$" }
        "year" { return $Period -match "^20\d{2}$" }
        default { return $false }
    }
}

function Test-UiPath {
    param(
        [string]$Value,
        [ValidateSet("Any", "Leaf", "Container")]
        [string]$PathType = "Any"
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $false
    }
    try {
        switch ($PathType) {
            "Leaf" { return Test-Path -LiteralPath $Value -PathType Leaf }
            "Container" { return Test-Path -LiteralPath $Value -PathType Container }
            default { return Test-Path -LiteralPath $Value }
        }
    } catch {
        return $false
    }
}

function ConvertTo-CommandLineArgument {
    param([string]$Value)

    if ($null -eq $Value -or $Value.Length -eq 0) {
        return '""'
    }
    if ($Value -notmatch '[\s"]') {
        return $Value
    }

    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes++
            continue
        }
        if ($character -eq '"') {
            [void]$builder.Append(('\' * ($backslashes * 2 + 1)))
            [void]$builder.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) {
            [void]$builder.Append(('\' * $backslashes))
            $backslashes = 0
        }
        [void]$builder.Append($character)
    }
    if ($backslashes -gt 0) {
        [void]$builder.Append(('\' * ($backslashes * 2)))
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Get-ModeCode {
    param([string]$DisplayName)
    switch ($DisplayName) {
        "Месяц" { return "month" }
        "Квартал" { return "quarter" }
        "Год" { return "year" }
        default { return "" }
    }
}

function Get-PeriodExample {
    param([string]$Mode)
    switch ($Mode) {
        "month" { return "2025-01" }
        "quarter" { return "2025-Q1" }
        "year" { return "2025" }
        default { return "" }
    }
}

function Get-ModeDisplayName {
    param([string]$Mode)
    switch ($Mode) {
        "month" { return "Месяц" }
        "quarter" { return "Квартал" }
        "year" { return "Год" }
        default { return "" }
    }
}

function Get-ErpPeriodInfo {
    param(
        [string]$ErpPath,
        [string]$Mode,
        [string]$Period
    )

    $powershellPath = Join-Path $PSHOME "powershell.exe"
    if (-not (Test-Path -LiteralPath $powershellPath)) {
        $powershellPath = "powershell.exe"
    }
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $launcherPath,
        "detect-period",
        "-ERP", $ErpPath,
        "-Mode", $Mode,
        "-Period", $Period
    )
    $argumentLine = ($arguments | ForEach-Object {
        ConvertTo-CommandLineArgument ([string]$_)
    }) -join " "

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $powershellPath
    $startInfo.Arguments = $argumentLine
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    try {
        $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
        $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    } catch {
        # Encoding properties are unavailable only on very old .NET versions.
    }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Не удалось открыть отчёт ERP для определения периода."
    }
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    $exitCode = $process.ExitCode
    $process.Dispose()

    if ($exitCode -ne 0) {
        $detail = ($stderr + "`r`n" + $stdout).Trim()
        $errorLine = $detail -split "`r?`n" |
            Where-Object { $_ -match "ОШИБКА:" } |
            Select-Object -First 1
        if ([string]::IsNullOrWhiteSpace($errorLine)) {
            $errorLine = "В выбранном файле не найден заголовок месяца или года."
        }
        throw $errorLine
    }

    $match = [regex]::Match($stdout, "(?m)^ERP_PERIOD_JSON=(.+)$")
    if (-not $match.Success) {
        throw "Программа не получила период из отчёта ERP."
    }
    return ($match.Groups[1].Value.Trim() | ConvertFrom-Json)
}

function Get-IntalevArticlesPathFromServiceContext {
    param([object]$Context)
    if ($null -eq $Context) { return "" }
    $sourcesProperty = $Context.PSObject.Properties['sources']
    if ($null -eq $sourcesProperty -or $null -eq $sourcesProperty.Value) { return "" }
    $referenceProperty = $sourcesProperty.Value.PSObject.Properties['reference_catalogs']
    if ($null -eq $referenceProperty -or $null -eq $referenceProperty.Value) { return "" }
    $articlesProperty = $referenceProperty.Value.PSObject.Properties['intalev_bdr_articles_path']
    if ($null -eq $articlesProperty) { return "" }
    return [string]$articlesProperty.Value
}

function Set-PeriodChoicesV180 {
    param(
        [System.Windows.Forms.Control]$Control,
        [string]$Mode,
        [string]$SelectedValue
    )
    if (-not (Test-Period $Mode $SelectedValue)) { return }
    $Control.Text = $SelectedValue
    if ($null -ne $script:periodCalendarControl) {
        $calendarDate = Get-DateForPeriodV180 $Mode $SelectedValue
        if ($null -ne $calendarDate) {
            $script:updatingPeriodCalendar = $true
            try { $script:periodCalendarControl.Value = $calendarDate } finally { $script:updatingPeriodCalendar = $false }
        }
    }
}

function Get-DateForPeriodV180 {
    param([string]$Mode, [string]$Period)
    $match = $null
    if ($Mode -eq 'year') {
        $match = [regex]::Match($Period, '^(20\d{2})$')
        if ($match.Success) { return [datetime]::new([int]$match.Groups[1].Value, 1, 1) }
    } elseif ($Mode -eq 'quarter') {
        $match = [regex]::Match($Period, '^(20\d{2})-Q([1-4])$')
        if ($match.Success) { return [datetime]::new([int]$match.Groups[1].Value, (([int]$match.Groups[2].Value - 1) * 3) + 1, 1) }
    } else {
        $match = [regex]::Match($Period, '^(20\d{2})-(0[1-9]|1[0-2])$')
        if ($match.Success) { return [datetime]::new([int]$match.Groups[1].Value, [int]$match.Groups[2].Value, 1) }
    }
    return $null
}

function Get-PeriodFromCalendarV180 {
    param([string]$Mode, [datetime]$Value)
    if ($Mode -eq 'year') { return ('{0:yyyy}' -f $Value) }
    if ($Mode -eq 'quarter') { return ('{0:yyyy}-Q{1}' -f $Value, ([Math]::Floor(($Value.Month - 1) / 3) + 1)) }
    return ('{0:yyyy-MM}' -f $Value)
}

function Get-ErpJournalInfo {
    param([string]$ErpPath)

    $powershellPath = Join-Path $PSHOME "powershell.exe"
    if (-not (Test-Path -LiteralPath $powershellPath)) {
        $powershellPath = "powershell.exe"
    }
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $launcherPath,
        "journal-status",
        "-ERP", $ErpPath
    )
    $argumentLine = ($arguments | ForEach-Object {
        ConvertTo-CommandLineArgument ([string]$_)
    }) -join " "
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $powershellPath
    $startInfo.Arguments = $argumentLine
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    try {
        $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
        $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    } catch {}
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "Не удалось проверить журнал проводок ERP." }
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    $exitCode = $process.ExitCode
    $process.Dispose()
    if ($exitCode -ne 0) {
        throw (($stderr + "`r`n" + $stdout).Trim())
    }
    $match = [regex]::Match($stdout, "(?m)^ERP_JOURNAL_JSON=(.+)$")
    if (-not $match.Success) { throw "Программа не получила результат проверки журнала ERP." }
    return ($match.Groups[1].Value.Trim() | ConvertFrom-Json)
}

function Test-ErpJournalReadyForEngine {
    param([object]$JournalInfo)
    if ($null -eq $JournalInfo) { return $false }
    return @("READY", "READY_WITH_ALIAS") -contains ([string]$JournalInfo.status).ToUpperInvariant()
}

function Get-RunButtonLabel {
    param([bool]$IntalevSelectionIsPending)
    return "Сформировать сверку"
}

function Test-ErpPeriodAvailable {
    param(
        [string]$Mode,
        [string]$Period,
        [object[]]$AvailablePeriods
    )

    $available = @($AvailablePeriods | ForEach-Object { [string]$_ })
    if ($Mode -eq "month") {
        return (Test-Period $Mode $Period) -and ($available -contains $Period)
    }
    if ($Mode -eq "quarter" -and (Test-Period $Mode $Period)) {
        $match = [regex]::Match($Period, "^(20\d{2})-Q([1-4])$")
        $firstMonth = (([int]$match.Groups[2].Value - 1) * 3) + 1
        foreach ($offset in 0..2) {
            $month = "{0}-{1:D2}" -f $match.Groups[1].Value, ($firstMonth + $offset)
            if ($available -notcontains $month) {
                return $false
            }
        }
        return $true
    }
    if ($Mode -eq "year" -and (Test-Period $Mode $Period)) {
        foreach ($monthNumber in 1..12) {
            $month = "{0}-{1:D2}" -f $Period, $monthNumber
            if ($available -notcontains $month) {
                return $false
            }
        }
        return $true
    }
    return $false
}

function Get-RequestedPeriodDecision {
    param(
        [string]$Mode,
        [string]$RequestedPeriod,
        [object[]]$AvailablePeriods
    )

    # The period selected in the service overview/user field is authoritative.
    # Annual sources may confirm or reject it, but never choose another month.
    return [pscustomobject]@{
        mode = $Mode
        requestedPeriod = $RequestedPeriod
        selectedPeriod = $RequestedPeriod
        availablePeriods = @($AvailablePeriods | ForEach-Object { [string]$_ })
        ready = Test-ErpPeriodAvailable $Mode $RequestedPeriod $AvailablePeriods
        fallbackAllowed = $false
    }
}

function Format-AnnualSourceText {
    param(
        [string]$Label,
        [object]$Source
    )
    $organization = [string]$Source.organization_name
    $year = [string]$Source.year
    $periods = @($Source.available_periods).Count
    if ([string]::IsNullOrWhiteSpace($organization)) { $organization = "организация не указана" }
    if ([string]::IsNullOrWhiteSpace($year)) { $year = "год не указан" }
    return "${Label}: $organization, $year, $periods/12"
}

function Format-SourceTechnicalDetails {
    param(
        [string]$Path,
        [object]$Source
    )
    $details = @()
    if (-not [string]::IsNullOrWhiteSpace($Path)) { $details += "Путь: $Path" }
    if ($null -ne $Source -and -not [string]::IsNullOrWhiteSpace([string]$Source.sha256)) {
        $details += "SHA-256: $([string]$Source.sha256)"
    }
    return ($details -join "`r`n")
}

function Update-IntalevSourceDisplay {
    if ($null -eq $intalevStatusBox) { return }
    $path = $intalevPathBox.Text.Trim()
    if (Test-UiPath $path) {
        $intalevStatusBox.Text = "Инталев: " + [System.IO.Path]::GetFileName($path.TrimEnd('\', '/'))
        $intalevStatusBox.BackColor = $greenLight
    } else {
        $intalevStatusBox.Text = "Инталев: не загружен"
        $intalevStatusBox.BackColor = $yellowLight
    }
    $sourcePathToolTip.SetToolTip($intalevStatusBox, (Format-SourceTechnicalDetails $path $null))
}

function Update-ErpJournalDisplay {
    param(
        [string]$ErpPath,
        [switch]$Force
    )
    if ([string]::IsNullOrWhiteSpace($ErpPath) -or -not (Test-UiPath $ErpPath "Leaf")) {
        $isFolder = -not [string]::IsNullOrWhiteSpace($ErpPath) -and (Test-UiPath $ErpPath "Container")
        $script:lastErpJournalInfo = [pscustomobject]@{
            status = if ($isFolder) { "NOT_CHECKED_FOLDER" } else { "MISSING" }
            severity = "warning"
            message = if ($isFolder) {
                "Выбрана папка ERP. Журнал проводок будет проверен движком по содержимому файлов."
            } else {
                "ERP-источник не найден; журнал проводок не проверен."
            }
        }
        $script:lastErpJournalPath = $ErpPath
    } elseif ($Force -or $script:lastErpJournalPath -ne $ErpPath -or $null -eq $script:lastErpJournalInfo) {
        try {
            $script:lastErpJournalInfo = Get-ErpJournalInfo $ErpPath
            $script:lastErpJournalPath = $ErpPath
        } catch {
            $script:lastErpJournalInfo = [pscustomobject]@{
                status = "UNREADABLE"
                severity = "warning"
                message = "Не удалось проверить журнал проводок: $($_.Exception.Message)"
            }
            $script:lastErpJournalPath = $ErpPath
        }
    }
    $journalReady = Test-ErpJournalReadyForEngine $script:lastErpJournalInfo
    $erpPathReady = Test-UiPath $ErpPath
    $script:erpUserStatus = if (-not $erpPathReady) {
        "ERP: не загружен"
    } elseif ($journalReady) {
        "ERP: ОПИУ + журнал"
    } else {
        "ERP: ОПИУ без журнала"
    }
    if ($null -ne $erpStatusBox) {
        $erpStatusBox.Text = $script:erpUserStatus
        $erpStatusBox.BackColor = if ($erpPathReady -and $journalReady) { $greenLight } else { $yellowLight }
        $sourcePathToolTip.SetToolTip($erpStatusBox, (Format-SourceTechnicalDetails $ErpPath $null))
    }
    if ($null -ne $erpHelp -and $null -ne $script:lastErpJournalInfo) {
        $erpHelp.Text = [string]$script:lastErpJournalInfo.message
        $erpHelp.ForeColor = if ([string]$script:lastErpJournalInfo.severity -eq "warning") {
            [System.Drawing.Color]::FromArgb(156, 87, 0)
        } else {
            [System.Drawing.Color]::FromArgb(0, 97, 0)
        }
    }
    return $script:lastErpJournalInfo
}

function Get-RunDisabledReason {
    if (-not [string]::IsNullOrWhiteSpace([string]$script:externalBlockReason)) {
        return "Запуск недоступен: $([string]$script:externalBlockReason)"
    }
    if (-not (Test-UiPath $intalevPathBox.Text)) {
        return "Запуск недоступен: загрузите Инталев."
    }
    if (-not (Test-UiPath $erpPathBox.Text)) {
        return "Запуск недоступен: загрузите годовой ERP ОПИУ."
    }
    if ($null -eq $modeBox.SelectedItem) {
        return "Запуск недоступен: выберите режим сверки."
    }
    $mode = Get-ModeCode $modeBox.SelectedItem.ToString()
    $period = $periodBox.Text.Trim().ToUpperInvariant()
    if (-not (Test-Period $mode $period)) {
        return "Запуск недоступен: укажите период в формате $(Get-PeriodExample $mode)."
    }
    return ""
}

function Update-RunButtonPresentation {
    if ($null -eq $runButton -or $null -ne $script:activeProcess) { return }
    $reason = Get-RunDisabledReason
    $runButton.Enabled = [string]::IsNullOrWhiteSpace($reason)
    $runButton.Text = "Сформировать сверку"
    $runButton.BackColor = $blue
    $runButton.ForeColor = $white
    $sourcePathToolTip.SetToolTip($runButton, $reason)
    if (-not [string]::IsNullOrWhiteSpace($reason)) {
        $statusLabel.Text = $reason
        $statusLabel.ForeColor = [System.Drawing.Color]::DarkRed
        $logBox.Text = $reason
        return
    }

    if (Test-ErpJournalReadyForEngine $script:lastErpJournalInfo) {
        $statusLabel.Text = "Готово к запуску: Инталев и ERP подтверждены. ERP: ОПИУ + журнал."
        $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(0, 97, 0)
        $logBox.Clear()
    } else {
        $statusLabel.Text = "Готово к запуску: Инталев и ERP подтверждены. ERP: ОПИУ без журнала; расшифровка до проводок недоступна."
        $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(156, 87, 0)
        if ($null -ne $script:lastErpJournalInfo) {
            $logBox.Text = [string]$script:lastErpJournalInfo.message
        }
    }
}

function New-AnnualUploadTransport {
    param(
        [ValidateSet("intalev", "erp")]
        [string]$Kind,
        [string]$Year,
        [string]$UploadPath,
        [string]$UniqueId = [Guid]::NewGuid().ToString("N")
    )

    $safeName = [IO.Path]::GetFileName($UploadPath)
    if ([string]::IsNullOrWhiteSpace($safeName)) {
        throw "Не удалось определить имя загружаемого годового источника."
    }
    $relativePath = "annual-source-uploads/$Year/$Kind/${UniqueId}_$safeName"
    return [pscustomobject]@{
        RelativePath = $relativePath
        HeaderValue = [Uri]::EscapeDataString($relativePath)
    }
}

function Invoke-AnnualSourceReload {
    param(
        [ValidateSet("intalev", "erp")]
        [string]$Kind,
        [string]$SelectedPath
    )

    if ([string]::IsNullOrWhiteSpace($script:serviceApiBaseUrl)) {
        throw "Локальный сервис не передал адрес API для годовых источников."
    }
    if (-not (Test-UiPath $SelectedPath)) {
        throw "Выбранный источник не найден: $SelectedPath"
    }
    $period = $periodBox.Text.Trim().ToUpperInvariant()
    $yearMatch = [regex]::Match($period, "^(20\d{2})")
    if (-not $yearMatch.Success) {
        throw "Сначала укажите период с годом в формате YYYY-MM, YYYY-QN или YYYY."
    }
    $year = $yearMatch.Groups[1].Value
    $temporaryArchive = $null
    $uploadPath = $SelectedPath
    try {
        if (Test-UiPath $SelectedPath "Container") {
            $temporaryArchive = Join-Path ([IO.Path]::GetTempPath()) ("OPIU_annual_{0}_{1}.zip" -f $Kind, [Guid]::NewGuid().ToString("N"))
            Compress-Archive -Path (Join-Path $SelectedPath "*") -DestinationPath $temporaryArchive -CompressionLevel Optimal -Force
            $uploadPath = $temporaryArchive
        }
        $extension = [IO.Path]::GetExtension($uploadPath).ToLowerInvariant()
        if ($extension -ne ".xlsx" -and $extension -ne ".zip") {
            throw "Годовой источник для закрепления должен быть XLSX, ZIP или папкой с XLSX."
        }
        $uploadTransport = New-AnnualUploadTransport $Kind $year $uploadPath
        $uploadRelative = $uploadTransport.RelativePath
        $uploadUri = "$($script:serviceApiBaseUrl)/api/files/upload?kind=input"
        $statusLabel.Text = "Загружаю новую годовую версию $Kind…"
        $statusLabel.ForeColor = $grayText
        $form.UseWaitCursor = $true
        [System.Windows.Forms.Application]::DoEvents()
        Invoke-WebRequest -UseBasicParsing -Method Post -Uri $uploadUri -InFile $uploadPath -ContentType "application/octet-stream" -Headers @{
            "X-Relative-Path" = $uploadTransport.HeaderValue
        } | Out-Null
        $request = [ordered]@{
            kind = $Kind
            organization_id = $script:serviceOrganizationId
            organization_name = $organizationBox.SelectedItem.ToString()
            year = $year
            paths = @($uploadRelative)
            reload = $true
        }
        $result = Invoke-RestMethod -Method Post -Uri "$($script:serviceApiBaseUrl)/api/annual-sources/finalize" -ContentType "application/json; charset=utf-8" -Body ($request | ConvertTo-Json -Depth 5)
        $source = $result.source
        if ($Kind -eq "intalev") {
            $script:serviceAnnualIntalevPath = [string]$source.source_path
            $script:fixedIntalevSourcePath = $script:serviceAnnualIntalevPath
            $script:lastIntalevAvailablePeriods = @($source.available_periods | ForEach-Object { [string]$_ })
            $script:hasFixedSnapshot = $true
            $script:intalevSelectionIsPending = $false
            $script:updatingIntalevPathBox = $true
            try { $intalevPathBox.Text = $script:serviceAnnualIntalevPath } finally { $script:updatingIntalevPathBox = $false }
            $script:fixedSnapshotText = Format-AnnualSourceText "Инталев" $source
            $snapshotPanel.BackColor = $greenLight
            $snapshotLabel.Text = "✓ " + $script:fixedSnapshotText
            $intalevHelp.Text = "Годовой источник сохранён. Для замены выберите новый файл или папку и нажмите «Загрузить заново»."
            $intalevPathBox.BackColor = $greenLight
            $fixIntalevButton.Text = "Загрузить заново"
            $fixIntalevButton.Enabled = $false
            $useFixedIntalevButton.Text = "Вернуть текущий"
            $useFixedIntalevButton.Enabled = $true
            Update-IntalevSourceDisplay
            $sourcePathToolTip.SetToolTip($intalevStatusBox, (Format-SourceTechnicalDetails $script:serviceAnnualIntalevPath $source))
        } else {
            $script:serviceAnnualERPPath = [string]$source.source_path
            $script:lastErpPeriodPath = $script:serviceAnnualERPPath
            $script:lastErpAvailablePeriods = @($source.available_periods | ForEach-Object { [string]$_ })
            $erpPathBox.Text = $script:serviceAnnualERPPath
            $erpPathBox.BackColor = $greenLight
            $script:erpSourceSummary = Format-AnnualSourceText "ERP" $source
            [void](Update-ErpJournalDisplay $script:serviceAnnualERPPath -Force)
            $selectFileButton.Text = "Загрузить заново"
            $sourcePathToolTip.SetToolTip($erpStatusBox, (Format-SourceTechnicalDetails $script:serviceAnnualERPPath $source))
        }
        Update-RequestedSourceReadiness
        $logBox.Text = "Новая версия закреплена. Source ID: $([string]$source.source_id). Предыдущая версия сохранена в истории."
        return $source
    } finally {
        $form.UseWaitCursor = $false
        if ($temporaryArchive -and (Test-Path -LiteralPath $temporaryArchive -PathType Leaf)) {
            Remove-Item -LiteralPath $temporaryArchive -Force -ErrorAction SilentlyContinue
        }
    }
}

function Update-ErpPeriodFromReport {
    param(
        [switch]$ThrowOnError,
        [switch]$ForceRefresh
    )

    if ($script:applyingErpPeriod) {
        return $false
    }
    $erpPath = $erpPathBox.Text.Trim()
    if (-not (Test-UiPath $erpPath)) {
        return $false
    }

    try {
        $periodHint.Text = "Читаю период ERP…"
        $periodHint.ForeColor = $grayText
        $form.UseWaitCursor = $true
        [System.Windows.Forms.Application]::DoEvents()
        $mode = Get-ModeCode $modeBox.SelectedItem.ToString()
        $period = $periodBox.Text.Trim().ToUpperInvariant()
        $info = $null
        if (
            -not $ForceRefresh -and
            $script:lastErpPeriodPath -eq $erpPath -and
            @($script:lastErpAvailablePeriods).Count -gt 0
        ) {
            $info = [pscustomobject]@{ availablePeriods = $script:lastErpAvailablePeriods }
        }
        if ($null -eq $info) {
            $info = Get-ErpPeriodInfo $erpPath $mode $period
            $script:lastErpPeriodPath = $erpPath
            $script:lastErpAvailablePeriods = @($info.availablePeriods)
        }

        $decision = Get-RequestedPeriodDecision $mode $period @($info.availablePeriods)
        if (-not $decision.ready) {
            throw "В годовом источнике ERP нет выбранного периода $period. Другой месяц автоматически не выбирается."
        }
        $script:erpPeriodReady = $true
        $periodBox.BackColor = $greenLight
        $periodHint.Text = "ERP: $period доступен"
        $periodHint.ForeColor = [System.Drawing.Color]::FromArgb(0, 97, 0)
        if (Get-Command Update-RequestedSourceReadiness -ErrorAction SilentlyContinue) {
            Update-RequestedSourceReadiness
        }
        return $true
    } catch {
        $script:erpPeriodReady = $false
        $periodBox.BackColor = $redLight
        $periodHint.Text = "Нет выбранного периода в ERP"
        $periodHint.ForeColor = [System.Drawing.Color]::DarkRed
        if ($ThrowOnError) {
            throw "Сверка не запущена. $($_.Exception.Message)"
        }
        if (Get-Command Update-RequestedSourceReadiness -ErrorAction SilentlyContinue) {
            Update-RequestedSourceReadiness
        }
        return $false
    } finally {
        $script:applyingErpPeriod = $false
        $form.UseWaitCursor = $false
    }
}

function Open-CodexReview {
    param([string]$ReportPath)

    $selectedPath = $ReportPath
    if ([string]::IsNullOrWhiteSpace($selectedPath) -or -not (Test-Path -LiteralPath $selectedPath -PathType Leaf)) {
        $dialog = New-Object System.Windows.Forms.OpenFileDialog
        $dialog.Title = "Выберите готовый отчёт сверки"
        $dialog.Filter = "Отчёт сверки (*.xlsx)|*.xlsx|Данные предпросмотра (*.codex-input.json)|*.codex-input.json|Все файлы (*.*)|*.*"
        if ($dialog.ShowDialog() -ne "OK") { return }
        $selectedPath = $dialog.FileName
    }

    $powershellPath = Join-Path $PSHOME "powershell.exe"
    if (-not (Test-Path -LiteralPath $powershellPath)) {
        $powershellPath = "powershell.exe"
    }
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-STA",
        "-File", $codexUiLoaderPath,
        "-InputPath", $selectedPath
    )
    $argumentLine = ($arguments | ForEach-Object {
        ConvertTo-CommandLineArgument ([string]$_)
    }) -join " "
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $powershellPath
    $startInfo.Arguments = $argumentLine
    $startInfo.UseShellExecute = $true
    $process = [System.Diagnostics.Process]::Start($startInfo)
    if ($null -eq $process) {
        throw "Не удалось открыть предпросмотр расхождений."
    }
}

function Assert-SelfTest {
    if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
        throw "Launcher is missing: $launcherPath"
    }
    if (-not (Test-Path -LiteralPath $organizationProfilesPath -PathType Leaf)) {
        throw "Organization profiles are missing: $organizationProfilesPath"
    }
    if (-not (Test-Path -LiteralPath $xlsConverterPath -PathType Leaf)) {
        throw "XLS converter is missing: $xlsConverterPath"
    }
    if (-not (Test-Path -LiteralPath $codexUiLoaderPath -PathType Leaf)) {
        throw "Codex UI loader is missing: $codexUiLoaderPath"
    }
    if (-not (Test-Path -LiteralPath $codexUiPath -PathType Leaf)) {
        throw "Codex UI is missing: $codexUiPath"
    }
    if (-not (Test-Path -LiteralPath $codexPackageBuilderPath -PathType Leaf)) {
        throw "Codex package builder is missing: $codexPackageBuilderPath"
    }
    if (-not (Test-Period "month" "2025-01")) {
        throw "Month validation failed."
    }
    if (-not (Test-Period "quarter" "2025-Q4")) {
        throw "Quarter validation failed."
    }
    if (-not (Test-Period "year" "2025")) {
        throw "Year validation failed."
    }
    if (Test-Period "month" "2025-13") {
        throw "Invalid month was accepted."
    }
    $catalogContext = '{"sources":{"reference_catalogs":{"intalev_bdr_articles_path":"C:\\catalogs\\articles.xlsx"}}}' | ConvertFrom-Json
    if ((Get-IntalevArticlesPathFromServiceContext $catalogContext) -ne 'C:\catalogs\articles.xlsx') {
        throw "Intalev BDR article catalog was not read from service context."
    }
    $calendarDate = Get-DateForPeriodV180 'month' '2025-11'
    if ($null -eq $calendarDate -or (Get-PeriodFromCalendarV180 'month' $calendarDate) -ne '2025-11') {
        throw "Month calendar changed the requested period."
    }
    if ((Get-PeriodFromCalendarV180 'quarter' ([datetime]::new(2025, 11, 1))) -ne '2025-Q4') {
        throw "Quarter calendar conversion failed."
    }
    if ((Get-PeriodFromCalendarV180 'year' ([datetime]::new(2025, 11, 1))) -ne '2025') {
        throw "Year calendar conversion failed."
    }
    if (-not (Test-ErpPeriodAvailable "month" "2025-02" @("2025-02"))) {
        throw "ERP month availability validation failed."
    }
    if (Test-ErpPeriodAvailable "month" "2025-01" @("2025-02")) {
        throw "Wrong ERP month was accepted."
    }
    if (-not (Test-ErpPeriodAvailable "quarter" "2025-Q1" @("2025-01", "2025-02", "2025-03"))) {
        throw "ERP quarter availability validation failed."
    }
    if (-not (Test-ErpPeriodAvailable "year" "2025" @(
        "2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06",
        "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12"
    ))) {
        throw "ERP year availability validation failed."
    }
    $requestedMonth = Get-RequestedPeriodDecision "month" "2025-11" @("2025-07", "2025-11")
    if (-not $requestedMonth.ready -or $requestedMonth.selectedPeriod -ne "2025-11" -or $requestedMonth.fallbackAllowed) {
        throw "Requested 2025-11 was replaced by the first available ERP period."
    }
    $missingRequestedMonth = Get-RequestedPeriodDecision "month" "2025-11" @("2025-07")
    if ($missingRequestedMonth.ready -or $missingRequestedMonth.selectedPeriod -ne "2025-11" -or $missingRequestedMonth.fallbackAllowed) {
        throw "Missing requested month did not fail closed."
    }
    foreach ($uploadCase in @(
        @{ kind = "intalev"; name = "Инталев за 12 месяцев №9.zip" },
        @{ kind = "erp"; name = "ERP годовой отчёт Управляющая компания.xlsx" }
    )) {
        $transport = New-AnnualUploadTransport $uploadCase.kind "2025" $uploadCase.name "0123456789abcdef0123456789abcdef"
        if ($transport.HeaderValue -match '[^\x20-\x7E]' -or $transport.HeaderValue -match '[\r\n]') {
            throw "Annual upload header contains non-ASCII or control characters."
        }
        if ([Uri]::UnescapeDataString($transport.HeaderValue) -ne $transport.RelativePath) {
            throw "Annual upload header round-trip failed for $($uploadCase.kind)."
        }
    }
    if (Test-ErpJournalReadyForEngine $null) {
        throw "Missing ERP journal was presented as ready."
    }
    if (Test-ErpJournalReadyForEngine ([pscustomobject]@{ status = "NOT_CHECKED_FOLDER" })) {
        throw "Unchecked ERP folder was presented as a proven journal."
    }
    foreach ($readyStatus in @("READY", "READY_WITH_ALIAS")) {
        if (-not (Test-ErpJournalReadyForEngine ([pscustomobject]@{ status = $readyStatus }))) {
            throw "Proven ERP journal status $readyStatus was rejected."
        }
    }
    if ((Get-RunButtonLabel $false) -ne "Сформировать сверку" -or (Get-RunButtonLabel $true) -ne "Сформировать сверку") {
        throw "Run button label must stay stable while the disabled reason is shown separately."
    }
    $friendlySource = Format-AnnualSourceText "Инталев" ([pscustomobject]@{
        organization_name = "Управляющая компания"
        year = "2025"
        available_periods = @(1..12 | ForEach-Object { "2025-{0:D2}" -f $_ })
        sha256 = "ABCDEF"
    })
    if ($friendlySource -ne "Инталев: Управляющая компания, 2025, 12/12" -or $friendlySource -match "SHA-256") {
        throw "Annual source status exposes technical data or has an unexpected user format."
    }
    $technicalDetails = Format-SourceTechnicalDetails "C:\technical\source.zip" ([pscustomobject]@{ sha256 = "ABCDEF" })
    if ($technicalDetails -notmatch "C:\\technical\\source.zip" -or $technicalDetails -notmatch "SHA-256: ABCDEF") {
        throw "Technical source details are incomplete."
    }
    if (Test-UiPath "") {
        throw "Empty UI path was accepted."
    }
    Write-Output "SELF_TEST=PASS"
}

if ($SelfTest) {
    Assert-SelfTest
    exit 0
}

$blue = [System.Drawing.Color]::FromArgb(68, 114, 196)
$blueLight = [System.Drawing.Color]::FromArgb(221, 235, 247)
$greenLight = [System.Drawing.Color]::FromArgb(226, 239, 218)
$yellowLight = [System.Drawing.Color]::FromArgb(255, 242, 204)
$redLight = [System.Drawing.Color]::FromArgb(244, 204, 204)
$grayText = [System.Drawing.Color]::FromArgb(89, 89, 89)
$white = [System.Drawing.Color]::White

$form = New-Object System.Windows.Forms.Form
$form.Text = "Сверка ОПИУ — R005 · OPIU 1.9.3"
$form.ClientSize = New-Object System.Drawing.Size(940, 900)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedSingle"
$form.MaximizeBox = $false
$form.AutoScaleMode = "Dpi"
$form.BackColor = $white
$form.Font = New-Object System.Drawing.Font("Segoe UI", 10)

$sourcePathToolTip = New-Object System.Windows.Forms.ToolTip
$sourcePathToolTip.AutoPopDelay = 20000
$sourcePathToolTip.InitialDelay = 350
$sourcePathToolTip.ReshowDelay = 100
$sourcePathToolTip.ShowAlways = $true

$header = New-Object System.Windows.Forms.Panel
$header.Location = New-Object System.Drawing.Point(0, 0)
$header.Size = New-Object System.Drawing.Size(940, 88)
$header.BackColor = $blue
$form.Controls.Add($header)

$title = New-Object System.Windows.Forms.Label
$title.Text = "Автоматическая сверка ОПИУ — R005 · версия 1.9.3"
$title.Location = New-Object System.Drawing.Point(26, 16)
$title.Size = New-Object System.Drawing.Size(860, 34)
$title.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 20)
$title.ForeColor = $white
$header.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = "Месяц / квартал / год из одного ERP Excel/ZIP → отчёт с раскрытием до операций"
$subtitle.Location = New-Object System.Drawing.Point(29, 53)
$subtitle.Size = New-Object System.Drawing.Size(850, 24)
$subtitle.ForeColor = $white
$header.Controls.Add($subtitle)

$instruction = New-Object System.Windows.Forms.Label
$instruction.Text = "Источники выбраны автоматически. При необходимости замените их и нажмите «Сформировать сверку»."
$instruction.Location = New-Object System.Drawing.Point(27, 101)
$instruction.Size = New-Object System.Drawing.Size(880, 34)
$instruction.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 11)
$form.Controls.Add($instruction)

$snapshotPanel = New-Object System.Windows.Forms.Panel
$snapshotPanel.Location = New-Object System.Drawing.Point(25, 137)
$snapshotPanel.Size = New-Object System.Drawing.Size(890, 48)
$snapshotPanel.BackColor = $greenLight
$snapshotPanel.BorderStyle = "FixedSingle"
$snapshotPanel.Visible = $false
$form.Controls.Add($snapshotPanel)

$snapshotLabel = New-Object System.Windows.Forms.Label
$snapshotLabel.Location = New-Object System.Drawing.Point(14, 12)
$snapshotLabel.Size = New-Object System.Drawing.Size(855, 24)
$snapshotLabel.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 10)
$snapshotPanel.Controls.Add($snapshotLabel)

function Update-FixedIntalevDisplay {
    try {
        $snapshotPointer = Get-Content -LiteralPath $currentSnapshotPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $manifestReference = [string]$snapshotPointer.manifest_path
        if ([System.IO.Path]::IsPathRooted($manifestReference)) {
            $snapshotManifestPath = $manifestReference
        } else {
            $snapshotManifestPath = Join-Path $AppDir $manifestReference
        }
        $snapshotManifest = Get-Content -LiteralPath $snapshotManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $script:hasFixedSnapshot = $true
        $script:fixedIntalevSourcePath = [string]$snapshotManifest.source_root
        $script:lastIntalevAvailablePeriods = @($snapshotManifest.files | ForEach-Object { [string]$_.period })
        $snapshotOrganization = if ($null -ne $organizationBox.SelectedItem) { $organizationBox.SelectedItem.ToString() } else { $defaultOrganization }
        $snapshotYearMatch = [regex]::Match(([string]($script:lastIntalevAvailablePeriods | Select-Object -First 1)), "^(20\d{2})")
        $snapshotYear = if ($snapshotYearMatch.Success) { $snapshotYearMatch.Groups[1].Value } else { "год не указан" }
        $script:fixedSnapshotText = "Инталев: $snapshotOrganization, $snapshotYear, $(@($script:lastIntalevAvailablePeriods).Count)/12"
        $snapshotPanel.BackColor = $greenLight
        $snapshotLabel.Text = "✓ " + $script:fixedSnapshotText
    } catch {
        $script:hasFixedSnapshot = $false
        $script:fixedIntalevSourcePath = ""
        $script:lastIntalevAvailablePeriods = @()
        $script:fixedSnapshotText = "Выберите файл или папку Инталев, затем нажмите «Зафиксировать»."
        $snapshotPanel.BackColor = $yellowLight
        $snapshotLabel.Text = "Инталев ещё не зафиксирован. Это должен сделать пользователь."
    }

    if ($null -ne $intalevPathBox -and -not $script:intalevSelectionIsPending) {
        $script:updatingIntalevPathBox = $true
        try {
            $intalevPathBox.Text = $script:fixedIntalevSourcePath
            $intalevPathBox.BackColor = $greenLight
        } finally {
            $script:updatingIntalevPathBox = $false
        }
    }
    if ($null -ne $intalevHelp) {
        $intalevHelp.Text = if ($script:hasFixedSnapshot) {
            "Годовой источник сохранён. Для замены выберите новый файл или папку и нажмите «Загрузить заново»."
        } else {
            $script:fixedSnapshotText
        }
    }
    if ($null -ne $useFixedIntalevButton) {
        $useFixedIntalevButton.Enabled = $script:hasFixedSnapshot -and ($null -eq $script:activeProcess)
    }
    if ($null -ne $fixIntalevButton) {
        $fixIntalevButton.Text = if ($script:hasFixedSnapshot) { "Загрузить заново" } else { "Зафиксировать" }
    }
    if ($null -ne $runButton) {
        $runButton.Enabled = (
            $script:hasFixedSnapshot -and
            (-not $script:intalevSelectionIsPending) -and
            (Test-UiPath $erpPathBox.Text) -and
            (Test-RequestedSourceAvailability) -and
            ($null -eq $script:activeProcess)
        )
    }
    Update-IntalevSourceDisplay
}

function Test-RequestedSourceAvailability {
    if ($null -eq $modeBox.SelectedItem) { return $false }
    $mode = Get-ModeCode $modeBox.SelectedItem.ToString()
    $period = $periodBox.Text.Trim().ToUpperInvariant()
    return (Test-UiPath $intalevPathBox.Text) -and (Test-UiPath $erpPathBox.Text) -and (Test-Period $mode $period)
}

function Update-RequestedSourceReadiness {
    if ($null -eq $modeBox.SelectedItem) {
        return
    }
    $mode = Get-ModeCode $modeBox.SelectedItem.ToString()
    $period = $periodBox.Text.Trim().ToUpperInvariant()
    $script:sourcePeriodsReady = (Test-Period $mode $period)
    if (-not $script:sourcePeriodsReady) {
        $periodBox.BackColor = $redLight
        $periodHint.Text = "Формат: $(Get-PeriodExample $mode)"
        $periodHint.ForeColor = [System.Drawing.Color]::DarkRed
        if ($null -eq $script:activeProcess) {
            $statusLabel.Text = "Укажите период в формате $(Get-PeriodExample $mode)."
            $statusLabel.ForeColor = [System.Drawing.Color]::DarkRed
            $logBox.Text = $statusLabel.Text
        }
    } else {
        $periodBox.BackColor = $greenLight
        $periodHint.Text = "Будет проверен движком: $period"
        $periodHint.ForeColor = [System.Drawing.Color]::FromArgb(0, 97, 0)
        $journalInfo = Update-ErpJournalDisplay ($erpPathBox.Text.Trim())
        if ($null -eq $script:activeProcess) {
            $journalMessage = if ($null -ne $journalInfo -and -not [string]::IsNullOrWhiteSpace([string]$journalInfo.message)) {
                [string]$journalInfo.message
            } else {
                "Журнал проводок не проверен. Сверка ОПИУ возможна, но расшифровка до проводок будет заблокирована."
            }
            $statusLabel.Text = $journalMessage
            $logBox.Text = $journalMessage
            if (Test-ErpJournalReadyForEngine $journalInfo) {
                $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(0, 97, 0)
                $logBox.Clear()
            } else {
                $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(156, 87, 0)
            }
        }
    }
    $runButton.Enabled = (
        $script:sourcePeriodsReady -and
        (Test-UiPath $intalevPathBox.Text) -and
        (Test-UiPath $erpPathBox.Text) -and
        ($null -eq $script:activeProcess)
    )
    Update-RunButtonPresentation
}

$script:hasFixedSnapshot = $false
$script:fixedIntalevSourcePath = ""
$script:fixedSnapshotText = "Последний загруженный Инталев подставляется автоматически."
$script:lastIntalevAvailablePeriods = @()
$script:serviceAnnualIntalevPath = ""
$script:serviceAnnualERPPath = ""
$script:serviceApiBaseUrl = ""
$script:serviceOrganizationId = ""
$script:sourcePeriodsReady = $false
$script:applyingServiceContext = $false
$script:intalevSelectionIsPending = $false
$script:updatingIntalevPathBox = $false
$script:lastErpJournalPath = ""
$script:lastErpJournalInfo = $null
$script:erpSourceSummary = "Выберите Excel, ZIP или папку ERP с ОПИУ и журналом проводок."
$script:erpUserStatus = "ERP: не загружен"
$script:externalBlockReason = ""
$script:intalevArticlesPath = ""
$script:periodCalendarControl = $null
$script:updatingPeriodCalendar = $false

$intalevGroup = New-Object System.Windows.Forms.GroupBox
$intalevGroup.Text = "1. Отчёт Инталев"
$intalevGroup.Location = New-Object System.Drawing.Point(25, 198)
$intalevGroup.Size = New-Object System.Drawing.Size(890, 112)
$intalevGroup.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 10)
$form.Controls.Add($intalevGroup)

$intalevHelp = New-Object System.Windows.Forms.Label
$intalevHelp.Text = $script:fixedSnapshotText
$intalevHelp.Location = New-Object System.Drawing.Point(16, 25)
$intalevHelp.Size = New-Object System.Drawing.Size(850, 22)
$intalevHelp.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$intalevHelp.ForeColor = $grayText
$intalevGroup.Controls.Add($intalevHelp)

$intalevPathBox = New-Object System.Windows.Forms.TextBox
$intalevPathBox.Location = New-Object System.Drawing.Point(18, 57)
$intalevPathBox.Size = New-Object System.Drawing.Size(330, 28)
$intalevPathBox.BackColor = $greenLight
$intalevPathBox.Visible = $false
$intalevGroup.Controls.Add($intalevPathBox)

$intalevStatusBox = New-Object System.Windows.Forms.Label
$intalevStatusBox.Location = New-Object System.Drawing.Point(18, 57)
$intalevStatusBox.Size = New-Object System.Drawing.Size(330, 28)
$intalevStatusBox.BorderStyle = "FixedSingle"
$intalevStatusBox.TextAlign = "MiddleLeft"
$intalevStatusBox.AutoEllipsis = $true
$intalevStatusBox.BackColor = $yellowLight
$intalevStatusBox.Text = "Инталев: не загружен"
$intalevGroup.Controls.Add($intalevStatusBox)

$selectIntalevFileButton = New-Object System.Windows.Forms.Button
$selectIntalevFileButton.Text = "Заменить Инталев"
$selectIntalevFileButton.Location = New-Object System.Drawing.Point(358, 55)
$selectIntalevFileButton.Size = New-Object System.Drawing.Size(180, 32)
$intalevGroup.Controls.Add($selectIntalevFileButton)

$selectIntalevFolderButton = New-Object System.Windows.Forms.Button
$selectIntalevFolderButton.Text = "Указать папку"
$selectIntalevFolderButton.Location = New-Object System.Drawing.Point(474, 55)
$selectIntalevFolderButton.Size = New-Object System.Drawing.Size(112, 32)
$selectIntalevFolderButton.Visible = $false
$intalevGroup.Controls.Add($selectIntalevFolderButton)

$fixIntalevButton = New-Object System.Windows.Forms.Button
$fixIntalevButton.Text = "Зафиксировать"
$fixIntalevButton.Location = New-Object System.Drawing.Point(594, 55)
$fixIntalevButton.Size = New-Object System.Drawing.Size(140, 32)
$fixIntalevButton.BackColor = $blue
$fixIntalevButton.ForeColor = $white
$fixIntalevButton.FlatStyle = "Flat"
$fixIntalevButton.Enabled = $false
$fixIntalevButton.Visible = $false
$intalevGroup.Controls.Add($fixIntalevButton)

$useFixedIntalevButton = New-Object System.Windows.Forms.Button
$useFixedIntalevButton.Text = "Вернуть текущий"
$useFixedIntalevButton.Location = New-Object System.Drawing.Point(742, 55)
$useFixedIntalevButton.Size = New-Object System.Drawing.Size(128, 32)
$useFixedIntalevButton.Visible = $false
$intalevGroup.Controls.Add($useFixedIntalevButton)

$erpGroup = New-Object System.Windows.Forms.GroupBox
$erpGroup.Text = "2. Отчёт ERP"
$erpGroup.Location = New-Object System.Drawing.Point(25, 323)
$erpGroup.Size = New-Object System.Drawing.Size(890, 122)
$erpGroup.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 10)
$form.Controls.Add($erpGroup)

$erpHelp = New-Object System.Windows.Forms.Label
$erpHelp.Text = $script:erpSourceSummary
$erpHelp.Location = New-Object System.Drawing.Point(16, 25)
$erpHelp.Size = New-Object System.Drawing.Size(850, 46)
$erpHelp.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$erpHelp.ForeColor = $grayText
$erpGroup.Controls.Add($erpHelp)

$erpPathBox = New-Object System.Windows.Forms.TextBox
$erpPathBox.Location = New-Object System.Drawing.Point(18, 78)
$erpPathBox.Size = New-Object System.Drawing.Size(548, 28)
$erpPathBox.BackColor = $yellowLight
$erpPathBox.Visible = $false
$erpGroup.Controls.Add($erpPathBox)

$erpStatusBox = New-Object System.Windows.Forms.Label
$erpStatusBox.Location = New-Object System.Drawing.Point(18, 78)
$erpStatusBox.Size = New-Object System.Drawing.Size(548, 28)
$erpStatusBox.BorderStyle = "FixedSingle"
$erpStatusBox.TextAlign = "MiddleLeft"
$erpStatusBox.AutoEllipsis = $true
$erpStatusBox.BackColor = $yellowLight
$erpStatusBox.Text = $script:erpUserStatus
$erpGroup.Controls.Add($erpStatusBox)

$selectFileButton = New-Object System.Windows.Forms.Button
$selectFileButton.Text = "Заменить ERP"
$selectFileButton.Location = New-Object System.Drawing.Point(580, 76)
$selectFileButton.Size = New-Object System.Drawing.Size(190, 32)
$erpGroup.Controls.Add($selectFileButton)

$selectFolderButton = New-Object System.Windows.Forms.Button
$selectFolderButton.Text = "Указать папку ERP"
$selectFolderButton.Location = New-Object System.Drawing.Point(730, 76)
$selectFolderButton.Size = New-Object System.Drawing.Size(140, 32)
$selectFolderButton.Enabled = $false
$selectFolderButton.Visible = $false
$erpGroup.Controls.Add($selectFolderButton)

$periodGroup = New-Object System.Windows.Forms.GroupBox
$periodGroup.Text = "3. Период сверки"
$periodGroup.Location = New-Object System.Drawing.Point(25, 458)
$periodGroup.Size = New-Object System.Drawing.Size(890, 105)
$periodGroup.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 10)
$form.Controls.Add($periodGroup)

$modeLabel = New-Object System.Windows.Forms.Label
$modeLabel.Text = "Режим"
$modeLabel.Location = New-Object System.Drawing.Point(18, 28)
$modeLabel.Size = New-Object System.Drawing.Size(170, 22)
$periodGroup.Controls.Add($modeLabel)

$modeBox = New-Object System.Windows.Forms.ComboBox
$modeBox.Location = New-Object System.Drawing.Point(18, 53)
$modeBox.Size = New-Object System.Drawing.Size(190, 30)
$modeBox.DropDownStyle = "DropDownList"
[void]$modeBox.Items.AddRange(@("Месяц", "Квартал", "Год"))
$modeBox.SelectedIndex = 0
$periodGroup.Controls.Add($modeBox)

$periodLabel = New-Object System.Windows.Forms.Label
$periodLabel.Text = "Период"
$periodLabel.Location = New-Object System.Drawing.Point(245, 28)
$periodLabel.Size = New-Object System.Drawing.Size(170, 22)
$periodGroup.Controls.Add($periodLabel)

$periodCalendar = New-Object System.Windows.Forms.DateTimePicker
$periodCalendar.Location = New-Object System.Drawing.Point(245, 53)
$periodCalendar.Size = New-Object System.Drawing.Size(155, 28)
$periodCalendar.Format = [System.Windows.Forms.DateTimePickerFormat]::Custom
$periodCalendar.CustomFormat = 'MMMM yyyy'
$periodCalendar.ShowUpDown = $false
$periodCalendar.Value = [datetime]::new(2025, 1, 1)
$periodGroup.Controls.Add($periodCalendar)
$script:periodCalendarControl = $periodCalendar

$periodBox = New-Object System.Windows.Forms.TextBox
$periodBox.Location = New-Object System.Drawing.Point(410, 53)
$periodBox.Size = New-Object System.Drawing.Size(100, 28)
$periodBox.ReadOnly = $true
$periodBox.TabStop = $false
Set-PeriodChoicesV180 $periodBox 'month' '2025-01'
$periodGroup.Controls.Add($periodBox)

$periodHint = New-Object System.Windows.Forms.Label
$periodHint.Text = "Период — из ERP"
$periodHint.Location = New-Object System.Drawing.Point(515, 56)
$periodHint.Size = New-Object System.Drawing.Size(90, 24)
$periodHint.ForeColor = $grayText
$periodGroup.Controls.Add($periodHint)

$organizationLabel = New-Object System.Windows.Forms.Label
$organizationLabel.Text = "Организация"
$organizationLabel.Location = New-Object System.Drawing.Point(610, 28)
$organizationLabel.Size = New-Object System.Drawing.Size(240, 22)
$periodGroup.Controls.Add($organizationLabel)

$organizationBox = New-Object System.Windows.Forms.ComboBox
$organizationBox.Location = New-Object System.Drawing.Point(610, 53)
$organizationBox.Size = New-Object System.Drawing.Size(260, 30)
$organizationBox.DropDownStyle = "DropDownList"
[void]$organizationBox.Items.AddRange(@(
    "9 Управляющая компания",
    "Хабаровск",
    "Сахалин",
    "Владивосток — Айс Юнион",
    "Планета Запад",
    "Мега Айс",
    "Камчатка",
    "КонсалтСервис"
))
$organizationBox.SelectedIndex = 0
$defaultOrganizationIndex = $organizationBox.Items.IndexOf($defaultOrganization)
if ($defaultOrganizationIndex -ge 0) {
    $organizationBox.SelectedIndex = $defaultOrganizationIndex
}
$periodGroup.Controls.Add($organizationBox)

$outputGroup = New-Object System.Windows.Forms.GroupBox
$outputGroup.Text = "4. Куда сохранить отчёт"
$outputGroup.Location = New-Object System.Drawing.Point(25, 575)
$outputGroup.Size = New-Object System.Drawing.Size(890, 96)
$outputGroup.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 10)
$form.Controls.Add($outputGroup)

$outputPathBox = New-Object System.Windows.Forms.TextBox
$outputPathBox.Location = New-Object System.Drawing.Point(18, 39)
$outputPathBox.Size = New-Object System.Drawing.Size(718, 28)
$outputPathBox.Text = $defaultOutputPath
$outputGroup.Controls.Add($outputPathBox)

$selectOutputButton = New-Object System.Windows.Forms.Button
$selectOutputButton.Text = "Выбрать папку"
$selectOutputButton.Location = New-Object System.Drawing.Point(752, 36)
$selectOutputButton.Size = New-Object System.Drawing.Size(118, 32)
$outputGroup.Controls.Add($selectOutputButton)

$runButton = New-Object System.Windows.Forms.Button
$runButton.Text = "Сформировать сверку"
$runButton.Location = New-Object System.Drawing.Point(25, 685)
$runButton.Size = New-Object System.Drawing.Size(250, 48)
$runButton.BackColor = $blue
$runButton.ForeColor = $white
$runButton.FlatStyle = "Flat"
$runButton.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 11)
$runButton.Enabled = $false
$form.Controls.Add($runButton)

$openReportButton = New-Object System.Windows.Forms.Button
$openReportButton.Text = "Открыть отчёт"
$openReportButton.Location = New-Object System.Drawing.Point(292, 685)
$openReportButton.Size = New-Object System.Drawing.Size(150, 48)
$openReportButton.Enabled = $false
$form.Controls.Add($openReportButton)

$openFolderButton = New-Object System.Windows.Forms.Button
$openFolderButton.Text = "Открыть папку"
$openFolderButton.Location = New-Object System.Drawing.Point(458, 685)
$openFolderButton.Size = New-Object System.Drawing.Size(150, 48)
$form.Controls.Add($openFolderButton)

$codexReviewButton = New-Object System.Windows.Forms.Button
$codexReviewButton.Text = "Расхождения / Codex"
$codexReviewButton.Location = New-Object System.Drawing.Point(625, 685)
$codexReviewButton.Size = New-Object System.Drawing.Size(290, 48)
$codexReviewButton.BackColor = [System.Drawing.Color]::FromArgb(31, 78, 121)
$codexReviewButton.ForeColor = $white
$codexReviewButton.FlatStyle = "Flat"
$codexReviewButton.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 11)
$form.Controls.Add($codexReviewButton)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Location = New-Object System.Drawing.Point(25, 746)
$progress.Size = New-Object System.Drawing.Size(890, 12)
$progress.Style = "Blocks"
$form.Controls.Add($progress)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = "Готово к запуску."
$statusLabel.Location = New-Object System.Drawing.Point(27, 766)
$statusLabel.Size = New-Object System.Drawing.Size(880, 25)
$statusLabel.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 10)
$form.Controls.Add($statusLabel)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Location = New-Object System.Drawing.Point(25, 797)
$logBox.Size = New-Object System.Drawing.Size(890, 58)
$logBox.Multiline = $true
$logBox.ReadOnly = $true
$logBox.ScrollBars = "Vertical"
$logBox.BackColor = [System.Drawing.Color]::FromArgb(248, 249, 250)
$logBox.Font = New-Object System.Drawing.Font("Consolas", 9)
$form.Controls.Add($logBox)

$warning = New-Object System.Windows.Forms.Label
$warning.Text = "Отчёт только для сверки: проводки и загрузка в 1С не формируются."
$warning.Location = New-Object System.Drawing.Point(27, 868)
$warning.Size = New-Object System.Drawing.Size(880, 23)
$warning.ForeColor = [System.Drawing.Color]::FromArgb(156, 87, 0)
$warning.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9)
$form.Controls.Add($warning)

$script:activeProcess = $null
$script:activeOperation = $null
$script:lastOutputPath = $null
$script:runStartedAt = $null
$script:applyingErpPeriod = $false
$script:lastErpPeriodPath = $null
$script:lastErpAvailablePeriods = @()

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500

$selectIntalevFileButton.Add_Click({
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = "Выберите отчёт Инталев ОПИУ"
    $dialog.Filter = "Инталев: Excel или ZIP (*.xlsx;*.xls;*.zip)|*.xlsx;*.xls;*.zip|Все файлы (*.*)|*.*"
    $dialog.Multiselect = $false
    if (Test-UiPath $intalevPathBox.Text "Container") {
        $dialog.InitialDirectory = $intalevPathBox.Text
    }
    if ($dialog.ShowDialog() -eq "OK") {
        $intalevPathBox.Text = $dialog.FileName
        $intalevHelp.Text = "Выбран новый Инталев. Он будет использован при следующем запуске."
    }
    $dialog.Dispose()
})

$selectIntalevFolderButton.Add_Click({
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "Выберите папку с отчётами Инталев ОПИУ"
    $dialog.ShowNewFolderButton = $false
    if (Test-UiPath $intalevPathBox.Text "Container") {
        $dialog.SelectedPath = $intalevPathBox.Text
    }
    if ($dialog.ShowDialog() -eq "OK") {
        $intalevPathBox.Text = $dialog.SelectedPath
        $intalevHelp.Text = "Выбрана папка. Нажмите «Зафиксировать», чтобы сделать её активной."
    }
    $dialog.Dispose()
})

$fixIntalevButton.Add_Click({
    try {
        $selectedIntalevPath = $intalevPathBox.Text.Trim()
        if (-not (Test-UiPath $selectedIntalevPath)) {
            throw "Сначала укажите существующий файл или папку Инталев."
        }

        if (-not [string]::IsNullOrWhiteSpace($script:serviceApiBaseUrl)) {
            $answer = [System.Windows.Forms.MessageBox]::Show(
                "Загрузить выбранный годовой Инталев заново для этой организации и года?`r`n`r`nПредыдущая версия останется в истории.",
                "Загрузить Инталев заново?",
                "YesNo",
                "Question"
            )
            if ($answer -ne "Yes") { return }
            [void](Invoke-AnnualSourceReload "intalev" $selectedIntalevPath)
            return
        }

        if ($script:hasFixedSnapshot) {
            $confirmationText = @"
Сделать выбранный Инталев новым активным снимком?

$selectedIntalevPath

Предыдущий снимок останется в архиве и не будет удалён.
"@
            $confirmationTitle = "Заменить активный Инталев?"
        } else {
            $confirmationText = @"
Зафиксировать выбранный Инталев?

$selectedIntalevPath

Будет создана неизменяемая копия. Исходный файл не изменится.
"@
            $confirmationTitle = "Зафиксировать Инталев?"
        }
        $answer = [System.Windows.Forms.MessageBox]::Show(
            $confirmationText.Trim(),
            $confirmationTitle,
            "YesNo",
            "Question"
        )
        if ($answer -ne "Yes") {
            return
        }

        $powershellPath = Join-Path $PSHOME "powershell.exe"
        if (-not (Test-Path -LiteralPath $powershellPath)) {
            $powershellPath = "powershell.exe"
        }
        $arguments = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", $launcherPath,
            "init",
            "-Intalev", $selectedIntalevPath
        )
        $argumentLine = ($arguments | ForEach-Object {
            ConvertTo-CommandLineArgument ([string]$_)
        }) -join " "

        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $powershellPath
        $startInfo.Arguments = $argumentLine
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        try {
            $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
            $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
        } catch {
            # Encoding properties are unavailable only on very old .NET versions.
        }

        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo

        $logBox.Clear()
        $statusLabel.Text = "Фиксируем Инталев… Программа проверяет периоды и создаёт копию."
        $statusLabel.ForeColor = $grayText
        $progress.Style = "Marquee"
        $progress.MarqueeAnimationSpeed = 30
        $runButton.Enabled = $false
        $openReportButton.Enabled = $false
        $selectIntalevFileButton.Enabled = $false
        $selectIntalevFolderButton.Enabled = $false
        $fixIntalevButton.Enabled = $false
        $useFixedIntalevButton.Enabled = $false
        $selectFileButton.Enabled = $false
        $selectFolderButton.Enabled = $false
        $selectOutputButton.Enabled = $false
        $codexReviewButton.Enabled = $false
        $modeBox.Enabled = $false
        $periodBox.Enabled = $false
        $periodCalendar.Enabled = $false
        $organizationBox.Enabled = $false

        if (-not $process.Start()) {
            throw "Не удалось запустить фиксацию Инталева."
        }
        $script:activeOperation = "fix-intalev"
        $script:activeProcess = $process
        $timer.Start()
    } catch {
        $progress.Style = "Blocks"
        $progress.Value = 0
        $selectIntalevFileButton.Enabled = $true
        $selectIntalevFolderButton.Enabled = $true
        $fixIntalevButton.Enabled = (
            $script:intalevSelectionIsPending -and
            (Test-UiPath $intalevPathBox.Text)
        )
        $useFixedIntalevButton.Enabled = $script:hasFixedSnapshot
        $selectFileButton.Enabled = $true
        $selectFolderButton.Enabled = $true
        $selectOutputButton.Enabled = $true
        $codexReviewButton.Enabled = $true
        $modeBox.Enabled = $true
        $periodBox.Enabled = $true
        $periodCalendar.Enabled = $true
        $organizationBox.Enabled = $true
        $statusLabel.Text = $_.Exception.Message
        $statusLabel.ForeColor = [System.Drawing.Color]::DarkRed
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            "Не удалось зафиксировать Инталев",
            "OK",
            "Warning"
        ) | Out-Null
    }
})

$useFixedIntalevButton.Add_Click({
    $script:intalevSelectionIsPending = $false
    $script:updatingIntalevPathBox = $true
    try {
        $intalevPathBox.Text = $script:fixedIntalevSourcePath
        $intalevPathBox.BackColor = $greenLight
    } finally {
        $script:updatingIntalevPathBox = $false
    }
    $intalevHelp.Text = "Годовой источник сохранён. Для замены выберите новый файл или папку и нажмите «Загрузить заново»."
    $fixIntalevButton.Enabled = $false
    $runButton.Text = "Сформировать сверку"
    $runButton.BackColor = $blue
    $runButton.ForeColor = $white
    $runButton.Enabled = (
        $script:hasFixedSnapshot -and
        (Test-UiPath $erpPathBox.Text) -and
        (Test-RequestedSourceAvailability) -and
        ($null -eq $script:activeProcess)
    )
    if ($runButton.Enabled) {
        $statusLabel.Text = "Готово к запуску. Используется текущий зафиксированный Инталев."
        $statusLabel.ForeColor = $grayText
    }
    Update-IntalevSourceDisplay
    Update-RunButtonPresentation
})

$intalevPathBox.Add_TextChanged({
    if ($script:updatingIntalevPathBox) {
        return
    }
    $script:intalevSelectionIsPending = $false
    $script:hasFixedSnapshot = Test-UiPath $intalevPathBox.Text
    $script:serviceAnnualIntalevPath = $intalevPathBox.Text.Trim()
    if ($script:hasFixedSnapshot) {
        $intalevPathBox.BackColor = $greenLight
        $intalevHelp.Text = "Инталев загружен и будет передан движку."
    } elseif ([string]::IsNullOrWhiteSpace($intalevPathBox.Text)) {
        $intalevPathBox.BackColor = $yellowLight
        $intalevHelp.Text = "Загрузите Инталев на главном экране или выберите файл здесь."
    } else {
        $intalevPathBox.BackColor = $yellowLight
        $intalevHelp.Text = "Путь Инталев не найден. Выберите существующий файл."
    }
    Update-IntalevSourceDisplay
    Update-RequestedSourceReadiness
})

$selectFileButton.Add_Click({
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = "Выберите Excel-файл или ZIP-архив ERP ОПИУ"
    $dialog.Filter = "ERP: Excel или ZIP (*.xlsx;*.xls;*.zip)|*.xlsx;*.xls;*.zip|ZIP-архив (*.zip)|*.zip|Excel (*.xlsx;*.xls)|*.xlsx;*.xls|Все файлы (*.*)|*.*"
    $dialog.Multiselect = $false
    if (Test-UiPath $erpPathBox.Text "Container") {
        $dialog.InitialDirectory = $erpPathBox.Text
    }
    if ($dialog.ShowDialog() -eq "OK") {
        try {
            $erpPathBox.Text = $dialog.FileName
            $script:serviceAnnualERPPath = $dialog.FileName
            [void](Update-ErpJournalDisplay $dialog.FileName -Force)
            Update-RequestedSourceReadiness
        } catch {
            $statusLabel.Text = $_.Exception.Message
            $statusLabel.ForeColor = [System.Drawing.Color]::DarkRed
            [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "ERP не загружен", "OK", "Warning") | Out-Null
        }
    }
    $dialog.Dispose()
})

$selectFolderButton.Add_Click({
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "Выберите папку с Excel-файлами или ZIP-архивами ERP ОПИУ"
    $dialog.ShowNewFolderButton = $false
    if (Test-UiPath $erpPathBox.Text "Container") {
        $dialog.SelectedPath = $erpPathBox.Text
    }
    if ($dialog.ShowDialog() -eq "OK") {
        $erpPathBox.Text = $dialog.SelectedPath
        [void](Update-ErpPeriodFromReport -ForceRefresh)
    }
    $dialog.Dispose()
})

$selectOutputButton.Add_Click({
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "Выберите папку для готового отчёта"
    $dialog.ShowNewFolderButton = $true
    if (Test-UiPath $outputPathBox.Text "Container") {
        $dialog.SelectedPath = $outputPathBox.Text
    }
    if ($dialog.ShowDialog() -eq "OK") {
        $outputPathBox.Text = $dialog.SelectedPath
    }
    $dialog.Dispose()
})

$modeBox.Add_SelectedIndexChanged({
    if ($script:applyingErpPeriod -or $script:applyingServiceContext) {
        return
    }
    $mode = Get-ModeCode $modeBox.SelectedItem.ToString()
    $selectedPeriod = Get-PeriodFromCalendarV180 $mode $periodCalendar.Value
    Set-PeriodChoicesV180 $periodBox $mode $selectedPeriod
    $periodHint.Text = "Календарь"
    if ($mode -eq "month") {
        $selectIntalevFileButton.Enabled = $true
        $script:erpSourceSummary = "ERP: месячный/годовой ОПИУ; для расшифровки приложите журнал проводок."
        $selectFileButton.Enabled = $true
    } else {
        $selectIntalevFileButton.Enabled = $true
        $script:erpSourceSummary = "ERP: годовой ОПИУ; для расшифровки приложите журнал проводок."
        $selectFileButton.Enabled = $true
    }
    if (Test-UiPath $erpPathBox.Text) {
        [void](Update-ErpJournalDisplay ($erpPathBox.Text.Trim()))
    }
    Update-RequestedSourceReadiness
})

$erpPathBox.Add_TextChanged({
    $pathIsValid = Test-UiPath $erpPathBox.Text
    if ($pathIsValid) {
        $erpPathBox.BackColor = $white
        $script:serviceAnnualERPPath = $erpPathBox.Text.Trim()
    } else {
        $erpPathBox.BackColor = $yellowLight
    }
    [void](Update-ErpJournalDisplay ($erpPathBox.Text.Trim()))
    Update-RequestedSourceReadiness
})

$erpPathBox.Add_Leave({
    if (Test-UiPath $erpPathBox.Text) {
        [void](Update-ErpJournalDisplay ($erpPathBox.Text.Trim()) -Force)
    }
})

$openFolderButton.Add_Click({
    try {
        $folder = $outputPathBox.Text.Trim()
        if (-not (Test-UiPath $folder)) {
            [void](New-Item -ItemType Directory -Path $folder -Force)
        }
        Start-Process -FilePath $folder
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            "Не удалось открыть папку:`r`n$($_.Exception.Message)",
            "Ошибка",
            "OK",
            "Error"
        ) | Out-Null
    }
})

$openReportButton.Add_Click({
    if ($script:lastOutputPath -and (Test-Path -LiteralPath $script:lastOutputPath)) {
        Start-Process -FilePath $script:lastOutputPath
    }
})

$codexReviewButton.Add_Click({
    try {
        Open-CodexReview $script:lastOutputPath
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            "Не удалось открыть предпросмотр",
            "OK",
            "Error"
        ) | Out-Null
    }
})

$timer.Add_Tick({
    if ($null -eq $script:activeProcess -or -not $script:activeProcess.HasExited) {
        return
    }

    $timer.Stop()
    $stdout = $script:activeProcess.StandardOutput.ReadToEnd()
    $stderr = $script:activeProcess.StandardError.ReadToEnd()
    $combinedOutput = ($stdout + "`r`n" + $stderr).Trim()
    $exitCode = $script:activeProcess.ExitCode
    $script:activeProcess.Dispose()
    $script:activeProcess = $null
    $completedOperation = $script:activeOperation
    $script:activeOperation = $null

    $selectIntalevFileButton.Enabled = $true
    $selectIntalevFolderButton.Enabled = $true
    $fixIntalevButton.Enabled = (
        $script:intalevSelectionIsPending -and
        (Test-UiPath $intalevPathBox.Text)
    )
    $useFixedIntalevButton.Enabled = $script:hasFixedSnapshot
    $selectFileButton.Enabled = $true
    $selectFolderButton.Enabled = $true
    $selectOutputButton.Enabled = $true
    $codexReviewButton.Enabled = $true
    $modeBox.Enabled = $true
    $periodBox.Enabled = $true
    $periodCalendar.Enabled = $true
    $organizationBox.Enabled = $true
    $progress.Style = "Blocks"
    $progress.Value = 0
    $logBox.Text = $combinedOutput

    if ($completedOperation -eq "fix-intalev") {
        if ($exitCode -eq 0) {
            $script:serviceAnnualIntalevPath = ""
            $script:intalevSelectionIsPending = $false
            Update-FixedIntalevDisplay
            $runButton.Text = "Сформировать сверку"
            $runButton.BackColor = $blue
            $runButton.ForeColor = $white
            $statusLabel.Text = "✓ Инталев зафиксирован и выбран как текущий. Теперь укажите ERP."
            $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(0, 97, 0)
            $logBox.Text = $combinedOutput
            [System.Media.SystemSounds]::Asterisk.Play()
            [System.Windows.Forms.MessageBox]::Show(
                "Инталев зафиксирован и стал активным.`r`n`r`nПри необходимости выберите другой файл и снова нажмите «Зафиксировать». Предыдущие снимки сохраняются.",
                "Инталев зафиксирован",
                "OK",
                "Information"
            ) | Out-Null
        } else {
            $errorMatch = [regex]::Match(
                $combinedOutput,
                "(?m)^ОШИБКА:\s*(.+)$"
            )
            if ($errorMatch.Success) {
                $friendlyError = $errorMatch.Groups[1].Value.Trim()
            } else {
                $friendlyError = "Не удалось прочитать выбранный Инталев. Проверьте файл или папку."
            }
            $logBox.Text = $friendlyError
            $statusLabel.Text = "Инталев не зафиксирован. Активный снимок не изменён."
            $statusLabel.ForeColor = [System.Drawing.Color]::DarkRed
            [System.Media.SystemSounds]::Hand.Play()
            [System.Windows.Forms.MessageBox]::Show(
                "Инталев не зафиксирован.`r`n`r`n$friendlyError",
                "Нужна проверка",
                "OK",
                "Warning"
            ) | Out-Null
        }
        $runButton.Enabled = (
            $script:hasFixedSnapshot -and
            (-not $script:intalevSelectionIsPending) -and
            (Test-UiPath $erpPathBox.Text) -and
            (Test-RequestedSourceAvailability)
        )
        return
    }

    $runButton.Enabled = (Test-RequestedSourceAvailability)
    if ($exitCode -eq 0) {
        $outputMatch = [regex]::Match($stdout, "Отчёт создан:\s*(.+\.xlsx)")
        if ($outputMatch.Success) {
            $script:lastOutputPath = $outputMatch.Groups[1].Value.Trim()
        } else {
            $latest = Get-ChildItem -LiteralPath $outputPathBox.Text -Filter "*.xlsx" -File -ErrorAction SilentlyContinue |
                Where-Object { $_.LastWriteTime -ge $script:runStartedAt } |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 1
            if ($latest) {
                $script:lastOutputPath = $latest.FullName
            }
        }
        $statusLabel.Text = "✓ Сверка готова. Откройте отчёт или «Расхождения / Codex»."
        $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(0, 97, 0)
        $openReportButton.Enabled = [bool]$script:lastOutputPath
        [System.Media.SystemSounds]::Asterisk.Play()
    } else {
        $errorMatch = [regex]::Match(
            $combinedOutput,
            "(?m)^ОШИБКА:\s*(.+)$"
        )
        if ($errorMatch.Success) {
            $friendlyError = $errorMatch.Groups[1].Value.Trim()
        } else {
            $friendlyError = "Проверьте выбранные файлы Инталев и ERP."
        }
        $logBox.Text = $friendlyError
        $statusLabel.Text = "Сверка не создана. Посмотрите сообщение ниже."
        $statusLabel.ForeColor = [System.Drawing.Color]::DarkRed
        [System.Media.SystemSounds]::Hand.Play()
        [System.Windows.Forms.MessageBox]::Show(
            "Сверка не создана.`r`n`r`n$friendlyError",
            "Нужна проверка",
            "OK",
            "Warning"
        ) | Out-Null
    }
})

$runButton.Add_Click({
    try {
        $intalevPath = $intalevPathBox.Text.Trim()
        $erpPath = $erpPathBox.Text.Trim()
        $outputPath = $outputPathBox.Text.Trim()

        if (-not (Test-UiPath $intalevPath)) {
            throw "Не найден выбранный файл или ZIP-архив Инталев."
        }
        if (-not (Test-UiPath $erpPath)) {
            throw "Не найден выбранный Excel-файл или ZIP-архив ERP."
        }
        $mode = Get-ModeCode $modeBox.SelectedItem.ToString()
        $period = $periodBox.Text.Trim().ToUpperInvariant()
        $journalInfo = Update-ErpJournalDisplay $erpPath -Force
        if ($null -ne $journalInfo -and [string]$journalInfo.severity -eq "warning") {
            $answer = [System.Windows.Forms.MessageBox]::Show(
                ([string]$journalInfo.message + "`r`n`r`nСформировать сверку ОПИУ без гарантированной расшифровки до проводок?"),
                "Предупреждение по журналу проводок",
                "YesNo",
                "Warning"
            )
            if ($answer -ne "Yes") { return }
        }
        if (-not (Test-Period $mode $period)) {
            $example = Get-PeriodExample $mode
            throw "Период указан неверно. Используйте формат: $example"
        }
        if ([string]::IsNullOrWhiteSpace($outputPath)) {
            throw "Выберите папку для готового отчёта."
        }
        if (-not (Test-UiPath $outputPath)) {
            [void](New-Item -ItemType Directory -Path $outputPath -Force)
        }

        $powershellPath = Join-Path $PSHOME "powershell.exe"
        if (-not (Test-Path -LiteralPath $powershellPath)) {
            $powershellPath = "powershell.exe"
        }

        $arguments = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", $launcherPath,
            "run",
            "-Intalev", $intalevPath,
            "-ERP", $erpPath,
            "-Mode", $mode,
            "-Period", $period,
            "-Output", $outputPath
        )
        if (-not [string]::IsNullOrWhiteSpace($script:intalevArticlesPath)) {
            $arguments += @("-IntalevArticles", $script:intalevArticlesPath)
        }
        if ($null -eq $organizationBox.SelectedItem -or [string]::IsNullOrWhiteSpace([string]$organizationBox.SelectedItem)) {
            throw "Выберите организацию из списка. Автоопределение отключено для защиты от смешения организаций."
        }
        $selectedOrganization = $organizationBox.SelectedItem.ToString()
        $arguments += @("-Organization", $selectedOrganization)
        $argumentLine = ($arguments | ForEach-Object {
            ConvertTo-CommandLineArgument ([string]$_)
        }) -join " "

        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $powershellPath
        $startInfo.Arguments = $argumentLine
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        try {
            $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
            $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
        } catch {
            # Encoding properties are unavailable only on very old .NET versions.
        }

        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo

        $script:lastOutputPath = $null
        $script:runStartedAt = Get-Date
        $logBox.Clear()
        $statusLabel.Text = "Идёт сверка… Месяц обычно быстрее; годовой отчёт может занять несколько минут."
        $statusLabel.ForeColor = $grayText
        $progress.Style = "Marquee"
        $progress.MarqueeAnimationSpeed = 30
        $runButton.Enabled = $false
        $openReportButton.Enabled = $false
        $selectIntalevFileButton.Enabled = $false
        $selectIntalevFolderButton.Enabled = $false
        $fixIntalevButton.Enabled = $false
        $useFixedIntalevButton.Enabled = $false
        $selectFileButton.Enabled = $false
        $selectFolderButton.Enabled = $false
        $selectOutputButton.Enabled = $false
        $codexReviewButton.Enabled = $false
        $modeBox.Enabled = $false
        $periodBox.Enabled = $false
        $periodCalendar.Enabled = $false
        $organizationBox.Enabled = $false

        if (-not $process.Start()) {
            throw "Не удалось запустить расчёт."
        }
        $script:activeOperation = "reconcile"
        $script:activeProcess = $process
        $timer.Start()
    } catch {
        $progress.Style = "Blocks"
        $progress.Value = 0
        $runButton.Enabled = (
            (Test-UiPath $intalevPathBox.Text) -and
            (Test-UiPath $erpPathBox.Text) -and
            (Test-RequestedSourceAvailability)
        )
        $fixIntalevButton.Enabled = (
            $script:intalevSelectionIsPending -and
            (Test-UiPath $intalevPathBox.Text)
        )
        $codexReviewButton.Enabled = $true
        $statusLabel.Text = $_.Exception.Message
        $statusLabel.ForeColor = [System.Drawing.Color]::DarkRed
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            "Проверьте данные",
            "OK",
            "Warning"
        ) | Out-Null
    }
})

$form.Add_FormClosing({
    if ($script:activeProcess -and -not $script:activeProcess.HasExited) {
        $_.Cancel = $true
        if ($script:activeOperation -eq "fix-intalev") {
            $closingMessage = "Дождитесь окончания фиксации Инталева."
            $closingTitle = "Инталев фиксируется"
        } else {
            $closingMessage = "Дождитесь окончания сверки."
            $closingTitle = "Сверка выполняется"
        }
        [System.Windows.Forms.MessageBox]::Show(
            $closingMessage,
            $closingTitle,
            "OK",
            "Information"
        ) | Out-Null
    }
})


# Контекст передается локальной веб-оболочкой. Он только заполняет поля
# существующего рабочего окна и не меняет расчётный движок R005.
if ($ContextPath -and (Test-Path -LiteralPath $ContextPath -PathType Leaf)) {
    try {
        $script:applyingServiceContext = $true
        $serviceContext = Get-Content -LiteralPath $ContextPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $modeMap = @{
            'month' = 'Месяц'
            'quarter' = 'Квартал'
            'year' = 'Год'
        }
        $modeCode = ([string]$serviceContext.period_mode).ToLowerInvariant()
        if ($modeMap.ContainsKey($modeCode)) {
            $modeBox.SelectedItem = $modeMap[$modeCode]
        }
        if ($serviceContext.period) {
            Set-PeriodChoicesV180 $periodBox $modeCode ([string]$serviceContext.period)
        }
        if ($serviceContext.organization.name) {
            $organizationName = [string]$serviceContext.organization.name
            if ($organizationBox.Items.IndexOf($organizationName) -lt 0) {
                [void]$organizationBox.Items.Add($organizationName)
            }
            $organizationBox.SelectedItem = $organizationName
        }
        if ($serviceContext.outputs.r005_dir) {
            $outputPathBox.Text = [string]$serviceContext.outputs.r005_dir
        }

        $script:serviceOrganizationId = [string]$serviceContext.organization.id
        $script:serviceApiBaseUrl = ''
        $script:intalevArticlesPath = Get-IntalevArticlesPathFromServiceContext $serviceContext
        if ($serviceContext.sources.intalev_path) {
            $script:serviceAnnualIntalevPath = [string]$serviceContext.sources.intalev_path
            $script:fixedIntalevSourcePath = $script:serviceAnnualIntalevPath
            $script:updatingIntalevPathBox = $true
            try { $intalevPathBox.Text = $script:serviceAnnualIntalevPath } finally { $script:updatingIntalevPathBox = $false }
            $script:hasFixedSnapshot = Test-UiPath $script:serviceAnnualIntalevPath
            $script:intalevSelectionIsPending = $false
            $intalevHelp.Text = 'Инталев загружен и будет передан движку.'
            Update-IntalevSourceDisplay
        }
        if ($serviceContext.sources.erp_path) {
            $script:serviceAnnualERPPath = [string]$serviceContext.sources.erp_path
            $erpPathBox.Text = $script:serviceAnnualERPPath
            $script:erpSourceSummary = 'ERP загружен и будет передан движку.'
            [void](Update-ErpJournalDisplay $script:serviceAnnualERPPath -Force)
        }
        $script:applyingServiceContext = $false
        Update-RequestedSourceReadiness
        $script:externalBlockReason = ""
        Update-RunButtonPresentation
    } catch {
        $script:applyingServiceContext = $false
        $script:externalBlockReason = 'Контекст сервиса не прочитан: ' + $_.Exception.Message
        $statusLabel.Text = 'Контекст сервиса не прочитан: ' + $_.Exception.Message
        $statusLabel.ForeColor = [System.Drawing.Color]::DarkOrange
        Update-RunButtonPresentation
    }
}

Update-IntalevSourceDisplay
[void](Update-ErpJournalDisplay ($erpPathBox.Text.Trim()))
Update-RunButtonPresentation

if ($PreviewPath) {
    $form.Show()
    [System.Windows.Forms.Application]::DoEvents()
    $bitmap = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
    $rectangle = New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)
    $form.DrawToBitmap($bitmap, $rectangle)
    $previewDirectory = Split-Path -Parent $PreviewPath
    if ($previewDirectory -and -not (Test-Path -LiteralPath $previewDirectory)) {
        [void](New-Item -ItemType Directory -Path $previewDirectory -Force)
    }
    $bitmap.Save($PreviewPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    $form.Close()
    exit 0
}

$form.Add_Shown({
    $form.WindowState = 'Normal'
    $form.TopMost = $true
    $form.Activate()
    $form.BringToFront()
    [System.Windows.Forms.Application]::DoEvents()
    $form.TopMost = $false
    if ($ReadyPath -and $form.Visible) {
        try {
            $readyDirectory = Split-Path -Parent $ReadyPath
            if ($readyDirectory -and -not (Test-Path -LiteralPath $readyDirectory)) {
                [void](New-Item -ItemType Directory -Path $readyDirectory -Force)
            }
            [ordered]@{ status = 'READY'; module = 'R005'; visible = $true; timestamp = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $ReadyPath -Encoding UTF8
        } catch {
            # The visible engine window remains usable; loader diagnostics are available.
        }
    }
})

$periodCalendar.Add_ValueChanged({
    if ($script:updatingPeriodCalendar -or $script:applyingServiceContext) { return }
    $mode = Get-ModeCode $modeBox.SelectedItem.ToString()
    $selectedPeriod = Get-PeriodFromCalendarV180 $mode $periodCalendar.Value
    Set-PeriodChoicesV180 $periodBox $mode $selectedPeriod
    Update-RequestedSourceReadiness
})

[void]$form.ShowDialog()
