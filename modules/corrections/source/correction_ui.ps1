param(
    [Parameter(Mandatory = $true)]
    [string]$AppDir,
    [switch]$SelfTest,
    [string]$PreviewPath,
    [string]$ContextPath,
    [string]$ReadyPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$enginePath = Join-Path $AppDir 'correction_engine_r001.mjs'
$rulesPath = Join-Path $AppDir 'correction_rules.r001.json'
$routingPath = Join-Path $AppDir 'r005_review_routing.mjs'
$nodePath = [string]$env:OPIU_NODE_EXE
if ([string]::IsNullOrWhiteSpace($nodePath)) {
    $nodePath = Join-Path $AppDir '..\..\..\runtime\node\node.exe'
}
$defaultOutput = if (-not [string]::IsNullOrWhiteSpace([string]$env:OPIU_SERVICE_ROOT)) {
    Join-Path $env:OPIU_SERVICE_ROOT 'data\outputs\КОРРЕКТИРОВКИ_R001'
} else {
    Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'OPIU\КОРРЕКТИРОВКИ_R001'
}
$script:lastRunDir = $null
$script:lastRegistry = $null
$script:lastArchive = $null

function Test-CorrectionPeriod {
    param([string]$Value)
    return $Value -match '^20\d{2}-(0[1-9]|1[0-2])$'
}

function Get-CorrectionPeriodFromDate {
    param([datetime]$Value)
    return ('{0:yyyy-MM}' -f $Value)
}

function Get-CorrectionDateFromPeriod {
    param([string]$Period)
    $match = [regex]::Match([string]$Period, '^(20\d{2})-(0[1-9]|1[0-2])$')
    if (-not $match.Success) { return $null }
    return [datetime]::new([int]$match.Groups[1].Value, [int]$match.Groups[2].Value, 1)
}

function ConvertTo-CommandLineArgument {
    param([string]$Value)
    if ($null -eq $Value -or $Value.Length -eq 0) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + $Value.Replace('\', '\').Replace('"', '\"') + '"'
}

function Get-NodePath {
    if (Test-Path -LiteralPath $nodePath -PathType Leaf) { return $nodePath }
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($null -ne $nodeCommand) { return $nodeCommand.Source }
    return $null
}

function Get-PeriodFromPath {
    param([string]$Value)
    $match = [regex]::Match([string]$Value, '20\d{2}-(0[1-9]|1[0-2])')
    if ($match.Success) { return $match.Value }
    return ''
}

function New-NodeEntrypointContext {
    param([string]$Path)
    $resolved = [IO.Path]::GetFullPath($Path)
    $target = Split-Path -Parent $resolved
    $windowsRoot = [string]$env:SystemRoot
    if ([string]::IsNullOrWhiteSpace($windowsRoot)) { $windowsRoot = 'C:\Windows' }
    $temporaryRoot = Join-Path $windowsRoot 'Temp'
    $junction = Join-Path $temporaryRoot ('OPIU_R001_' + [Guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Junction -Path $junction -Target $target)
    return [pscustomobject]@{
        Path = Join-Path $junction ([IO.Path]::GetFileName($resolved))
        Junction = $junction
        Target = $target
    }
}

function Remove-NodeEntrypointContext {
    param($Context)
    if ($null -eq $Context -or [string]::IsNullOrWhiteSpace([string]$Context.Junction)) { return }
    $item = Get-Item -LiteralPath ([string]$Context.Junction) -Force -ErrorAction SilentlyContinue
    if ($null -ne $item -and $item.LinkType -eq 'Junction') {
        [IO.Directory]::Delete([string]$Context.Junction)
    }
}

function Get-R001ResultExplanation {
    param($Result)
    $blockerCount = [int]$Result.blockers
    $disputedFiles = [int]$Result.disputed_files
    $pairCandidates = [int]$Result.disputed_pair_candidates
    $provenRows = 0
    $candidateRows = 0
    $manifestPath = [string]$Result.manifestPath
    if ($manifestPath -and (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        try {
            $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $provenRows = [int]$manifest.inputs.reconciliation.proven_source_rows
            $candidateRows = [int]$manifest.inputs.reconciliation.candidate_operation_rows
        } catch {}
    }

    if ($blockerCount -eq ($candidateRows + 1) -and $candidateRows -gt 0 -and $provenRows -eq 0) {
        $blockerText = "Причин остановки: $blockerCount. Из них предложений без подтверждения: $candidateRows; проверка входной сверки также не завершена."
    } else {
        $blockerText = "Причин остановки: $blockerCount. Подтверждённых операций: $provenRows; предложений для проверки: $candidateRows."
    }
    $disputedText = if ($disputedFiles -eq 0) {
        "Черновики «СПОРНО» не созданы. Парных предложений: $pairCandidates. Это не означает, что проверка завершена."
    } else {
        "Черновиков «СПОРНО»: $disputedFiles; парных предложений: $pairCandidates."
    }
    return "$blockerText`r`n$disputedText"
}

function Assert-SelfTest {
    if (-not (Test-Path -LiteralPath $enginePath -PathType Leaf)) { throw 'Engine file is missing.' }
    if (-not (Test-Path -LiteralPath $rulesPath -PathType Leaf)) { throw 'Rules file is missing.' }
    if (-not (Test-Path -LiteralPath $routingPath -PathType Leaf)) { throw 'R005 review routing module is missing.' }
    if ($null -eq (Get-NodePath)) { throw 'Node.js is missing.' }
    if (-not (Test-CorrectionPeriod '2025-07')) { throw 'Valid period rejected.' }
    if (Test-CorrectionPeriod '2025-13') { throw 'Invalid period accepted.' }
    if ((Get-CorrectionPeriodFromDate ([datetime]::new(2025, 11, 1))) -ne '2025-11') { throw 'Calendar changed the selected month.' }
    if ((Get-CorrectionDateFromPeriod '2025-11').Month -ne 11) { throw 'Context period was not restored in the calendar.' }
    Write-Output 'SELF_TEST=PASS'
}

if ($SelfTest) {
    Assert-SelfTest
    exit 0
}

$blue = [System.Drawing.Color]::FromArgb(68, 114, 196)
$navy = [System.Drawing.Color]::FromArgb(31, 78, 121)
$teal = [System.Drawing.Color]::FromArgb(15, 107, 120)
$blueLight = [System.Drawing.Color]::FromArgb(221, 235, 247)
$greenLight = [System.Drawing.Color]::FromArgb(226, 239, 218)
$yellowLight = [System.Drawing.Color]::FromArgb(255, 242, 204)
$redLight = [System.Drawing.Color]::FromArgb(244, 204, 204)
$grayLight = [System.Drawing.Color]::FromArgb(242, 242, 242)
$grayText = [System.Drawing.Color]::FromArgb(89, 89, 89)
$white = [System.Drawing.Color]::White
$red = [System.Drawing.Color]::FromArgb(192, 0, 0)
$green = [System.Drawing.Color]::FromArgb(0, 97, 0)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Движок корректировок ОПИУ — обновление 1.9.4'
$form.ClientSize = New-Object System.Drawing.Size(980, 820)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.ShowInTaskbar = $true
$form.AutoScaleMode = 'Dpi'
$form.BackColor = $white
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

$header = New-Object System.Windows.Forms.Panel
$header.Location = New-Object System.Drawing.Point(0, 0)
$header.Size = New-Object System.Drawing.Size(980, 92)
$header.BackColor = $blue
$form.Controls.Add($header)

$title = New-Object System.Windows.Forms.Label
$title.Text = 'Движок корректировок ОПИУ — 1.9.4'
$title.Location = New-Object System.Drawing.Point(26, 14)
$title.Size = New-Object System.Drawing.Size(900, 38)
$title.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 21)
$title.ForeColor = $white
$header.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = 'Проверка корректировок: подтверждённые операции отдельно, неподтверждённые — только СПОРНО'
$subtitle.Location = New-Object System.Drawing.Point(29, 55)
$subtitle.Size = New-Object System.Drawing.Size(910, 24)
$subtitle.ForeColor = $white
$header.Controls.Add($subtitle)

$contractPanel = New-Object System.Windows.Forms.Panel
$contractPanel.Location = New-Object System.Drawing.Point(25, 108)
$contractPanel.Size = New-Object System.Drawing.Size(930, 52)
$contractPanel.BackColor = $greenLight
$contractPanel.BorderStyle = 'FixedSingle'
$form.Controls.Add($contractPanel)

$contractLabel = New-Object System.Windows.Forms.Label
$contractLabel.Text = 'Неподтверждённые предложения остаются черновиками «СПОРНО»; загрузка в 1С запрещена.'
$contractLabel.Location = New-Object System.Drawing.Point(14, 13)
$contractLabel.Size = New-Object System.Drawing.Size(900, 25)
$contractLabel.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 10)
$contractLabel.ForeColor = $green
$contractPanel.Controls.Add($contractLabel)

$sourceGroup = New-Object System.Windows.Forms.GroupBox
$sourceGroup.Text = '1. Готовая сверка ОПИУ'
$sourceGroup.Location = New-Object System.Drawing.Point(25, 176)
$sourceGroup.Size = New-Object System.Drawing.Size(930, 112)
$form.Controls.Add($sourceGroup)

$sourceBox = New-Object System.Windows.Forms.TextBox
$sourceBox.Location = New-Object System.Drawing.Point(17, 31)
$sourceBox.Size = New-Object System.Drawing.Size(735, 28)
$sourceBox.ReadOnly = $true
$sourceBox.BackColor = $white
$sourceGroup.Controls.Add($sourceBox)

$sourceButton = New-Object System.Windows.Forms.Button
$sourceButton.Text = 'Выбрать сверку'
$sourceButton.Location = New-Object System.Drawing.Point(765, 28)
$sourceButton.Size = New-Object System.Drawing.Size(145, 34)
$sourceGroup.Controls.Add($sourceButton)

$sourceHint = New-Object System.Windows.Forms.Label
$sourceHint.Text = 'Выберите актуальную сверку R005. Подтверждённые и спорные операции будут разделены.'
$sourceHint.Location = New-Object System.Drawing.Point(18, 70)
$sourceHint.Size = New-Object System.Drawing.Size(665, 28)
$sourceHint.ForeColor = $grayText
$sourceGroup.Controls.Add($sourceHint)

$proofLink = New-Object System.Windows.Forms.LinkLabel
$proofLink.Text = 'Почему строка может быть СПОРНО?'
$proofLink.Location = New-Object System.Drawing.Point(700, 70)
$proofLink.Size = New-Object System.Drawing.Size(210, 28)
$proofLink.LinkColor = $navy
$sourceGroup.Controls.Add($proofLink)
$proofLink.Add_LinkClicked({
    $message = "Строка подтверждена, когда согласованы организация, период, место в иерархии и связанная операция ERP со счетами и аналитиками.`r`n`r`nЕсли данных недостаточно, предложение остаётся черновиком «СПОРНО». Оно не включает правило и не разрешает загрузку в 1С."
    [System.Windows.Forms.MessageBox]::Show($message, 'Почему строка может быть СПОРНО', 'OK', 'Information') | Out-Null
})

$settingsGroup = New-Object System.Windows.Forms.GroupBox
$settingsGroup.Text = '2. Период и папка результата'
$settingsGroup.Location = New-Object System.Drawing.Point(25, 302)
$settingsGroup.Size = New-Object System.Drawing.Size(930, 124)
$form.Controls.Add($settingsGroup)

$periodLabel = New-Object System.Windows.Forms.Label
$periodLabel.Text = 'Период'
$periodLabel.Location = New-Object System.Drawing.Point(18, 31)
$periodLabel.Size = New-Object System.Drawing.Size(90, 24)
$settingsGroup.Controls.Add($periodLabel)

$periodCalendar = New-Object System.Windows.Forms.DateTimePicker
$periodCalendar.Location = New-Object System.Drawing.Point(112, 28)
$periodCalendar.Size = New-Object System.Drawing.Size(170, 28)
$periodCalendar.Format = [System.Windows.Forms.DateTimePickerFormat]::Custom
$periodCalendar.CustomFormat = 'MMMM yyyy'
$periodCalendar.ShowUpDown = $false
$periodCalendar.Value = [datetime]::new((Get-Date).Year, (Get-Date).Month, 1)
$settingsGroup.Controls.Add($periodCalendar)

$periodBox = New-Object System.Windows.Forms.TextBox
$periodBox.Location = New-Object System.Drawing.Point(292, 28)
$periodBox.Size = New-Object System.Drawing.Size(95, 28)
$periodBox.ReadOnly = $true
$periodBox.TabStop = $false
$periodBox.Text = Get-CorrectionPeriodFromDate $periodCalendar.Value
$settingsGroup.Controls.Add($periodBox)

$periodHint = New-Object System.Windows.Forms.Label
$periodHint.Text = 'Тип: месяц'
$periodHint.Location = New-Object System.Drawing.Point(397, 31)
$periodHint.Size = New-Object System.Drawing.Size(105, 24)
$periodHint.ForeColor = $grayText
$settingsGroup.Controls.Add($periodHint)

$archiveCheck = New-Object System.Windows.Forms.CheckBox
$archiveCheck.Text = 'Выгрузить весь комплект в ZIP-архив'
$archiveCheck.Location = New-Object System.Drawing.Point(515, 28)
$archiveCheck.Size = New-Object System.Drawing.Size(395, 28)
$archiveCheck.Checked = $true
$settingsGroup.Controls.Add($archiveCheck)

$outputLabel = New-Object System.Windows.Forms.Label
$outputLabel.Text = 'Куда сохранить'
$outputLabel.Location = New-Object System.Drawing.Point(18, 76)
$outputLabel.Size = New-Object System.Drawing.Size(125, 24)
$settingsGroup.Controls.Add($outputLabel)

$outputBox = New-Object System.Windows.Forms.TextBox
$outputBox.Text = $defaultOutput
$outputBox.Location = New-Object System.Drawing.Point(147, 73)
$outputBox.Size = New-Object System.Drawing.Size(605, 28)
$settingsGroup.Controls.Add($outputBox)

$outputButton = New-Object System.Windows.Forms.Button
$outputButton.Text = 'Выбрать папку'
$outputButton.Location = New-Object System.Drawing.Point(765, 70)
$outputButton.Size = New-Object System.Drawing.Size(145, 34)
$settingsGroup.Controls.Add($outputButton)

$contoursLabel = New-Object System.Windows.Forms.Label
$contoursLabel.Text = '3. Что будет сформировано'
$contoursLabel.Location = New-Object System.Drawing.Point(27, 440)
$contoursLabel.Size = New-Object System.Drawing.Size(400, 28)
$contoursLabel.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 11)
$form.Controls.Add($contoursLabel)

function New-ContourPanel {
    param(
        [int]$X,
        [string]$Heading,
        [string]$Description,
        [System.Drawing.Color]$BackColor
    )
    $panel = New-Object System.Windows.Forms.Panel
    $panel.Location = New-Object System.Drawing.Point($X, 474)
    $panel.Size = New-Object System.Drawing.Size(298, 102)
    $panel.BackColor = $BackColor
    $panel.BorderStyle = 'FixedSingle'
    $form.Controls.Add($panel)

    $headingLabel = New-Object System.Windows.Forms.Label
    $headingLabel.Text = $Heading
    $headingLabel.Location = New-Object System.Drawing.Point(12, 10)
    $headingLabel.Size = New-Object System.Drawing.Size(270, 26)
    $headingLabel.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 11)
    $panel.Controls.Add($headingLabel)

    $descriptionLabel = New-Object System.Windows.Forms.Label
    $descriptionLabel.Text = $Description
    $descriptionLabel.Location = New-Object System.Drawing.Point(12, 38)
    $descriptionLabel.Size = New-Object System.Drawing.Size(270, 26)
    $descriptionLabel.ForeColor = $grayText
    $panel.Controls.Add($descriptionLabel)

    $countLabel = New-Object System.Windows.Forms.Label
    $countLabel.Text = 'ожидает запуска'
    $countLabel.Location = New-Object System.Drawing.Point(12, 69)
    $countLabel.Size = New-Object System.Drawing.Size(270, 22)
    $countLabel.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 9)
    $panel.Controls.Add($countLabel)
    return $countLabel
}

$pairCount = New-ContourPanel -X 25 -Heading 'Парные корректировки' -Description 'Перенос между статьями и аналитиками' -BackColor $blueLight
$oneSideCount = New-ContourPanel -X 341 -Heading 'Односторонние' -Description 'Закрытие доказанной отсутствующей стороны' -BackColor $yellowLight
$deleteCount = New-ContourPanel -X 657 -Heading 'Удаление МСФО' -Description 'Операции и отдельные проводки' -BackColor $redLight

$runButton = New-Object System.Windows.Forms.Button
$runButton.Text = 'Сформировать комплект корректировок'
$runButton.Location = New-Object System.Drawing.Point(25, 594)
$runButton.Size = New-Object System.Drawing.Size(390, 48)
$runButton.BackColor = $blue
$runButton.ForeColor = $white
$runButton.FlatStyle = 'Flat'
$runButton.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 11)
$form.Controls.Add($runButton)

$openFolderButton = New-Object System.Windows.Forms.Button
$openFolderButton.Text = 'Открыть результат'
$openFolderButton.Location = New-Object System.Drawing.Point(431, 594)
$openFolderButton.Size = New-Object System.Drawing.Size(185, 48)
$openFolderButton.Enabled = $false
$form.Controls.Add($openFolderButton)

$openRegistryButton = New-Object System.Windows.Forms.Button
$openRegistryButton.Text = 'Открыть реестр'
$openRegistryButton.Location = New-Object System.Drawing.Point(632, 594)
$openRegistryButton.Size = New-Object System.Drawing.Size(185, 48)
$openRegistryButton.Enabled = $false
$form.Controls.Add($openRegistryButton)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Location = New-Object System.Drawing.Point(833, 594)
$progress.Size = New-Object System.Drawing.Size(122, 48)
$progress.Style = 'Blocks'
$form.Controls.Add($progress)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Location = New-Object System.Drawing.Point(25, 658)
$logBox.Size = New-Object System.Drawing.Size(930, 98)
$logBox.Multiline = $true
$logBox.ReadOnly = $true
$logBox.ScrollBars = 'Vertical'
$logBox.BackColor = $grayLight
$logBox.Text = 'Выберите сверку и нажмите «Сформировать комплект корректировок».'
$form.Controls.Add($logBox)

$gateLabel = New-Object System.Windows.Forms.Label
$gateLabel.Text = 'Только проверка • черновики не загружаются в 1С • публикация запрещена'
$gateLabel.Location = New-Object System.Drawing.Point(25, 775)
$gateLabel.Size = New-Object System.Drawing.Size(930, 26)
$gateLabel.TextAlign = 'MiddleCenter'
$gateLabel.BackColor = $redLight
$gateLabel.ForeColor = $red
$gateLabel.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 9)
$form.Controls.Add($gateLabel)

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
            [ordered]@{ status = 'READY'; module = 'R001'; visible = $true; timestamp = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $ReadyPath -Encoding UTF8
        } catch {
            # The visible engine window remains usable; loader diagnostics are available.
        }
    }
})

$sourceButton.Add_Click({
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = 'Выберите готовую сверку ОПИУ'
    $dialog.Filter = 'Excel (*.xlsx)|*.xlsx'
    $dialog.Multiselect = $false
    if ($dialog.ShowDialog() -eq 'OK') {
        $sourceBox.Text = $dialog.FileName
        $sourceHint.Text = 'Файл выбран. R001 проверит организацию, период и связанные операции ERP.'
        $sourceHint.ForeColor = $green
    }
})

$outputButton.Add_Click({
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Выберите папку для комплектов корректировок'
    if (Test-Path -LiteralPath $outputBox.Text -PathType Container) { $dialog.SelectedPath = $outputBox.Text }
    if ($dialog.ShowDialog() -eq 'OK') { $outputBox.Text = $dialog.SelectedPath }
})

$openFolderButton.Add_Click({
    if ($script:lastRunDir -and (Test-Path -LiteralPath $script:lastRunDir -PathType Container)) {
        Start-Process explorer.exe -ArgumentList @($script:lastRunDir)
    }
})

$openRegistryButton.Add_Click({
    if ($script:lastRegistry -and (Test-Path -LiteralPath $script:lastRegistry -PathType Leaf)) {
        Start-Process $script:lastRegistry
    }
})

$runButton.Add_Click({
    $sourcePath = $sourceBox.Text.Trim()
    $period = $periodBox.Text.Trim()
    $outputPath = $outputBox.Text.Trim()
    $nodeExe = Get-NodePath

    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        [System.Windows.Forms.MessageBox]::Show('Выберите существующий файл сверки.', 'Движок корректировок', 'OK', 'Warning') | Out-Null
        return
    }
    if (-not (Test-CorrectionPeriod $period)) {
        [System.Windows.Forms.MessageBox]::Show('Период должен иметь формат ГГГГ-ММ, например 2025-07.', 'Движок корректировок', 'OK', 'Warning') | Out-Null
        return
    }
    if ([string]::IsNullOrWhiteSpace($outputPath)) {
        [System.Windows.Forms.MessageBox]::Show('Выберите папку результата.', 'Движок корректировок', 'OK', 'Warning') | Out-Null
        return
    }
    if ($null -eq $nodeExe) {
        [System.Windows.Forms.MessageBox]::Show('Не найден Node.js.', 'Движок корректировок', 'OK', 'Error') | Out-Null
        return
    }

    $entryContext = $null
    try {
        if (-not (Test-Path -LiteralPath $outputPath)) { [void](New-Item -ItemType Directory -Path $outputPath -Force) }
        $runButton.Enabled = $false
        $sourceButton.Enabled = $false
        $outputButton.Enabled = $false
        $archiveCheck.Enabled = $false
        $periodCalendar.Enabled = $false
        $openFolderButton.Enabled = $false
        $openRegistryButton.Enabled = $false
        $progress.Style = 'Marquee'
        $progress.MarqueeAnimationSpeed = 25
        $logBox.Text = 'Читаю доказательства сверки и формирую три контура…'
        [System.Windows.Forms.Application]::DoEvents()

        $entryContext = New-NodeEntrypointContext $enginePath
        $arguments = @('--preserve-symlinks-main', $entryContext.Path, '--reconciliation', $sourcePath, '--output', $outputPath, '--period', $period)
        if ($archiveCheck.Checked) { $arguments += '--archive' }
        $argumentLine = ($arguments | ForEach-Object { ConvertTo-CommandLineArgument ([string]$_) }) -join ' '
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $nodeExe
        $startInfo.Arguments = $argumentLine
        $startInfo.WorkingDirectory = $AppDir
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
        if (-not $process.Start()) { throw 'Не удалось запустить движок.' }
        # Drain both redirected pipes while Node is running. Waiting first and
        # reading afterwards deadlocks as soon as artifact-tool fills a pipe.
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        while (-not $process.HasExited) {
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 120
        }
        $process.WaitForExit()
        $stdout = $stdoutTask.Result
        $stderr = $stderrTask.Result
        $exitCode = $process.ExitCode
        $process.Dispose()
        if ($exitCode -ne 0) { throw (($stderr + "`r`n" + $stdout).Trim()) }

        $jsonMatch = [regex]::Match($stdout, '(?s)\{\s*"runDir".*\}\s*$')
        if (-not $jsonMatch.Success) { throw 'Не удалось получить итог запуска R001.' }
        $result = $jsonMatch.Value | ConvertFrom-Json
        $script:lastRunDir = [string]$result.runDir
        $script:lastArchive = [string]$result.archivePath
        $registryDir = Join-Path $script:lastRunDir 'РЕЕСТР'
        $script:lastRegistry = Get-ChildItem -LiteralPath $registryDir -Filter '*.xlsx' -File -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName

        $pairRows = [int]$result.draft_posting_rows
        $pairCount.Text = if ($pairRows -gt 0) { "Сформировано строк: $pairRows" } else { 'Доказанных пар нет' }
        $oneSideCount.Text = if ([int]$result.draft_posting_rows -gt 0) { 'См. лист «03_Односторонние»' } else { 'Доказанных строк нет' }
        $deleteTotal = [int]$result.deletion_operations + [int]$result.deletion_postings
        $deleteCount.Text = if ($deleteTotal -gt 0) { "Кандидатов: $deleteTotal" } else { 'Доказанных удалений нет' }

        if ([int]$result.blockers -gt 0) {
            $explanation = Get-R001ResultExplanation $result
            $logBox.Text = "Комплект создан только для проверки.`r`n$explanation`r`nЗагрузка в 1С запрещена. Результат можно открыть кнопкой ниже."
            $logBox.BackColor = $yellowLight
        } else {
            $logBox.Text = "Комплект сформирован только для проверки.`r`nПарных корректировок: $pairRows; черновиков «СПОРНО»: $($result.disputed_posting_rows); кандидатов на удаление: $deleteTotal.`r`nЗагрузка в 1С запрещена. Результат можно открыть кнопкой ниже."
            $logBox.BackColor = $greenLight
        }
        $openFolderButton.Enabled = $true
        $openRegistryButton.Enabled = [bool]$script:lastRegistry
    }
    catch {
        $logBox.Text = $_.Exception.Message
        $logBox.BackColor = $redLight
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Ошибка движка корректировок', 'OK', 'Error') | Out-Null
    }
    finally {
        Remove-NodeEntrypointContext $entryContext
        $progress.MarqueeAnimationSpeed = 0
        $progress.Style = 'Blocks'
        $progress.Value = 0
        $runButton.Enabled = $true
        $sourceButton.Enabled = $true
        $outputButton.Enabled = $true
        $archiveCheck.Enabled = $true
        $periodCalendar.Enabled = $true
    }
})


# Контекст передается локальной веб-оболочкой. Он только заполняет поля
# существующего рабочего окна и не меняет расчётный движок R001.
if ($ContextPath -and (Test-Path -LiteralPath $ContextPath -PathType Leaf)) {
    try {
        $serviceContext = Get-Content -LiteralPath $ContextPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($serviceContext.sources.reconciliation_path) {
            $sourceBox.Text = [string]$serviceContext.sources.reconciliation_path
			$sourceHint.Text = 'Выбрано автоматически: последний зарегистрированный отчёт R005 активного запуска.'
			$sourceHint.ForeColor = $green
        }
        if ($serviceContext.period) {
            $contextPeriod = [string]$serviceContext.period
            if ($contextPeriod -match '^20\d{2}-(0[1-9]|1[0-2])$') {
                $periodBox.Text = $contextPeriod
                $contextDate = Get-CorrectionDateFromPeriod $contextPeriod
                if ($null -ne $contextDate) { $periodCalendar.Value = $contextDate }
            }
        }
        if ($serviceContext.outputs.r001_dir) {
            $outputBox.Text = [string]$serviceContext.outputs.r001_dir
        }
		$logBox.Text = 'Поля заполнены из активного запуска. Период берётся из контекста сервиса; R001 не выбирает другой месяц самостоятельно.'
        $logBox.BackColor = $greenLight
    } catch {
        $logBox.Text = 'Контекст сервиса не прочитан: ' + $_.Exception.Message
        $logBox.BackColor = $yellowLight
    }
}

$periodCalendar.Add_ValueChanged({
    $periodBox.Text = Get-CorrectionPeriodFromDate $periodCalendar.Value
})

if ($PreviewPath) {
    $sourceBox.Text = ''
    $sourceHint.Text = '✓ Сверка распознана: 54 подтверждённые операции ERP.'
    $sourceHint.ForeColor = $green
    $pairCount.Text = '54 пары / 108 строк'
    $oneSideCount.Text = '0 доказанных строк'
    $deleteCount.Text = '0 доказанных удалений'
    $logBox.Text = 'Готово к формированию чернового комплекта. Загрузка в 1С остаётся запрещена.'
    $form.Show()
    [System.Windows.Forms.Application]::DoEvents()
    $bitmap = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
    $rectangle = New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)
    $form.DrawToBitmap($bitmap, $rectangle)
    $previewDirectory = Split-Path -Parent $PreviewPath
    if ($previewDirectory -and -not (Test-Path -LiteralPath $previewDirectory)) { [void](New-Item -ItemType Directory -Path $previewDirectory -Force) }
    $bitmap.Save($PreviewPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    $form.Close()
    exit 0
}

[void]$form.ShowDialog()
