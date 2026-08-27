param(
    [Parameter(Mandatory = $true)]
    [string]$AppDir,
    [string]$InputPath,
    [switch]$SelfTest,
    [string]$PreviewPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$launcherPath = Join-Path $AppDir "Запуск_сверки.ps1"
$packageBuilderPath = Join-Path $AppDir "opiu_codex_package.mjs"
$decisionsPath = Join-Path $AppDir "data\reconciliation_decisions.json"
$rulesPath = Join-Path $AppDir "data\reconciliation_rules.json"
$rulesUiPath = Join-Path $AppDir "opiu_rules_ui.ps1"

function Get-OptionalProperty {
    param(
        [object]$Object,
        [string]$Name,
        [object]$Default = $null
    )
    if ($null -eq $Object) { return $Default }
    if ($Object.PSObject.Properties.Name -contains $Name) { return $Object.$Name }
    return $Default
}

function Resolve-CodexInputPath {
    param([string]$SelectedPath)
    if ([string]::IsNullOrWhiteSpace($SelectedPath)) { return $null }
    $resolved = [System.IO.Path]::GetFullPath($SelectedPath)
    if ($resolved.EndsWith(".codex-input.json", [System.StringComparison]::OrdinalIgnoreCase)) {
        return $resolved
    }
    if ($resolved.EndsWith(".xlsx", [System.StringComparison]::OrdinalIgnoreCase)) {
        return [System.Text.RegularExpressions.Regex]::Replace(
            $resolved,
            "\.xlsx$",
            ".codex-input.json",
            [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
        )
    }
    if ($resolved.EndsWith(".manifest.json", [System.StringComparison]::OrdinalIgnoreCase)) {
        $manifest = Get-Content -LiteralPath $resolved -Raw -Encoding UTF8 | ConvertFrom-Json
        return [string](Get-OptionalProperty $manifest "codex_input_path" "")
    }
    return $resolved
}

function ConvertTo-CommandLineArgument {
    param([string]$Value)
    if ($null -eq $Value -or $Value.Length -eq 0) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }

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
    if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Get-SafeFileName {
    param([string]$Value)
    $result = [string]$Value
    foreach ($character in [System.IO.Path]::GetInvalidFileNameChars()) {
        $result = $result.Replace([string]$character, "_")
    }
    return $result.Trim()
}

function Get-NumberText {
    param([object]$Value)
    if ($null -eq $Value -or $Value -eq "") { return "—" }
    try { return ([double]$Value).ToString("N2") } catch { return [string]$Value }
}

function Get-NumberValue {
    param([object]$Value)
    if ($null -eq $Value -or $Value -eq "") { return 0.0 }
    try { return [double]$Value } catch { return 0.0 }
}

function Load-DecisionsDocument {
    if (-not (Test-Path -LiteralPath $decisionsPath -PathType Leaf)) {
        return [pscustomobject]@{
            schema = "opiu-reconciliation-decisions-v1"
            updated_at = $null
            decisions = @()
        }
    }
    $document = Get-Content -LiteralPath $decisionsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($document.PSObject.Properties.Name -notcontains "decisions") {
        $document | Add-Member -NotePropertyName decisions -NotePropertyValue @()
    }
    return $document
}

function Save-DecisionsDocument {
    param([object[]]$CurrentDecisions)

    $dataDirectory = Split-Path -Parent $decisionsPath
    if (-not (Test-Path -LiteralPath $dataDirectory)) {
        [void](New-Item -ItemType Directory -Path $dataDirectory -Force)
    }

    $existing = Load-DecisionsDocument
    $replaceKeys = @{}
    foreach ($decision in @($CurrentDecisions)) {
        $replaceKeys[[string]$decision.decision_key] = $true
    }

    $merged = @()
    foreach ($decision in @($existing.decisions)) {
        $key = [string](Get-OptionalProperty $decision "decision_key" "")
        if (-not $replaceKeys.ContainsKey($key)) { $merged += $decision }
    }
    $merged += @($CurrentDecisions)
    $merged = @($merged | Sort-Object organization, period, code, decision_key)

    $output = [pscustomobject]@{
        schema = "opiu-reconciliation-decisions-v1"
        updated_at = (Get-Date).ToUniversalTime().ToString("o")
        decisions = $merged
    }
    $json = $output | ConvertTo-Json -Depth 14
    [System.IO.File]::WriteAllText(
        $decisionsPath,
        $json,
        (New-Object System.Text.UTF8Encoding -ArgumentList $true)
    )
}


function Normalize-RuleText {
    param([object]$Value)
    return ([string]$Value).Replace([char]0x00A0, " ").Trim().ToLowerInvariant()
}

function Load-RulesDocument {
    if (-not (Test-Path -LiteralPath $rulesPath -PathType Leaf)) {
        return [pscustomobject]@{
            schema = "opiu-reconciliation-rules-v1"
            updated_at = $null
            rules = @()
        }
    }
    $document = Get-Content -LiteralPath $rulesPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($document.PSObject.Properties.Name -notcontains "rules") {
        $document | Add-Member -NotePropertyName rules -NotePropertyValue @()
    }
    return $document
}

function Get-RuleMatchKey {
    param([object]$Item)
    $organization = [string](Get-OptionalProperty $inputDocument "organization_code" "")
    if ([string]::IsNullOrWhiteSpace($organization)) {
        $organization = [string](Get-OptionalProperty $inputDocument "organization" "")
    }
    $code = [string](Get-OptionalProperty $Item "code" "")
    $article = Normalize-RuleText (Get-OptionalProperty $Item "intalev_label" "")
    $pathText = Normalize-RuleText (@(Get-OptionalProperty $Item "hierarchy_path" @()) -join " / ")
    return "$organization|$code|$article|$pathText"
}

function Refresh-ConfiguredRules {
    $script:rulesDocument = Load-RulesDocument
    $script:configuredRules = @($script:rulesDocument.rules | Where-Object { [bool](Get-OptionalProperty $_ "active" $true) })
}

function Find-ConfiguredRule {
    param([object]$Item)
    if ($null -eq $Item) { return $null }
    $exactKey = Get-RuleMatchKey $Item
    foreach ($rule in @($script:configuredRules)) {
        if ([string](Get-OptionalProperty $rule "match_key" "") -eq $exactKey) { return $rule }
    }

    $organizationCode = [string](Get-OptionalProperty $inputDocument "organization_code" "")
    $organizationName = [string](Get-OptionalProperty $inputDocument "organization" "")
    $sourceCode = [string](Get-OptionalProperty $Item "code" "")
    foreach ($rule in @($script:configuredRules)) {
        if ([string](Get-OptionalProperty $rule "source_code" "") -ne $sourceCode) { continue }
        $ruleOrganizationCode = [string](Get-OptionalProperty $rule "organization_code" "")
        $ruleOrganizationName = [string](Get-OptionalProperty $rule "organization" "")
        if (-not [string]::IsNullOrWhiteSpace($organizationCode) -and $ruleOrganizationCode -eq $organizationCode) { return $rule }
        if ([string]::IsNullOrWhiteSpace($organizationCode) -and $ruleOrganizationName -eq $organizationName) { return $rule }
    }
    return $null
}

function Get-ConfiguredRuleSummary {
    param([object]$Rule)
    if ($null -eq $Rule) { return "Не настроено" }
    $article = [string](Get-OptionalProperty $Rule "erp_article_name" "")
    $code = [string](Get-OptionalProperty $Rule "erp_article_code" "")
    $debit = [string](Get-OptionalProperty $Rule "debit_account" "")
    $credit = [string](Get-OptionalProperty $Rule "credit_account" "")
    $summary = "Настроено"
    if (-not [string]::IsNullOrWhiteSpace($article)) { $summary += ": $article" }
    if (-not [string]::IsNullOrWhiteSpace($code)) { $summary += " [$code]" }
    if (-not [string]::IsNullOrWhiteSpace($debit) -or -not [string]::IsNullOrWhiteSpace($credit)) {
        $summary += " | Дт $debit Кт $credit"
    }
    return $summary
}

function Assert-SelfTest {
    if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
        throw "Launcher is missing: $launcherPath"
    }
    if (-not (Test-Path -LiteralPath $packageBuilderPath -PathType Leaf)) {
        throw "Codex package builder is missing: $packageBuilderPath"
    }
    if (-not (Test-Path -LiteralPath $rulesUiPath -PathType Leaf)) {
        throw "Rules UI is missing: $rulesUiPath"
    }
    $testPath = Resolve-CodexInputPath "C:\Temp\Report.xlsx"
    if ($testPath -ne "C:\Temp\Report.codex-input.json") {
        throw "Codex input path resolution failed."
    }
    Write-Output "CODEX_UI_SELF_TEST=PASS"
}

if ($SelfTest) {
    Assert-SelfTest
    exit 0
}

if ([string]::IsNullOrWhiteSpace($InputPath)) {
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = "Выберите отчёт сверки или данные предпросмотра"
    $dialog.Filter = "Отчёт сверки или данные Codex (*.xlsx;*.codex-input.json)|*.xlsx;*.codex-input.json|Все файлы (*.*)|*.*"
    if ($dialog.ShowDialog() -ne "OK") { exit 0 }
    $InputPath = $dialog.FileName
}

$resolvedInputPath = Resolve-CodexInputPath $InputPath
if ([string]::IsNullOrWhiteSpace($resolvedInputPath) -or -not (Test-Path -LiteralPath $resolvedInputPath -PathType Leaf)) {
    [System.Windows.Forms.MessageBox]::Show(
        "Не найден файл данных предпросмотра:`r`n$resolvedInputPath`r`n`r`nСначала сформируйте сверку новой версией программы.",
        "Нет данных для предпросмотра",
        "OK",
        "Warning"
    ) | Out-Null
    exit 1
}

$inputDocument = Get-Content -LiteralPath $resolvedInputPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string](Get-OptionalProperty $inputDocument "schema" "") -ne "opiu-codex-review-input-v1") {
    throw "Неподдерживаемый формат данных предпросмотра."
}

$inputRows = @($inputDocument.rows | Sort-Object { [int](Get-OptionalProperty $_ "display_order" 0) })
$rowByKey = @{}
$rowByCode = @{}
foreach ($item in $inputRows) {
    $key = [string](Get-OptionalProperty $item "decision_key" "")
    $code = [string](Get-OptionalProperty $item "code" "")
    if (-not [string]::IsNullOrWhiteSpace($key)) { $rowByKey[$key] = $item }
    if (-not [string]::IsNullOrWhiteSpace($code)) { $rowByCode[$code] = $item }
}

function Test-RequiresClarification {
    param([string]$TechnicalStatus)
    return (
        $TechnicalStatus -eq "REQUIRES_CLARIFICATION" -or
        $TechnicalStatus -eq "BLOCKED_MAPPING_OR_VALUE" -or
        $TechnicalStatus -eq "ТРЕБУЕТ УТОЧНЕНИЯ"
    )
}

function Get-IsDiscrepancy {
    param([object]$Item)
    $stored = Get-OptionalProperty $Item "is_discrepancy" $null
    if ($null -ne $stored) { return [bool]$stored }
    $delta = Get-OptionalProperty $Item "delta" $null
    if ($null -eq $delta) { return $true }
    if ([math]::Abs((Get-NumberValue $delta)) -gt 0.009) { return $true }
    return (Test-RequiresClarification ([string](Get-OptionalProperty $Item "technical_status" "")))
}

# Нормализуем иерархию. Новые отчёты передают её из outlineLevel шаблона.
$rawLevels = @($inputRows | ForEach-Object { [int](Get-OptionalProperty $_ "hierarchy_level" 0) })
$allLegacyLevelOne = ($rawLevels.Count -gt 0 -and @($rawLevels | Where-Object { $_ -ne 1 }).Count -eq 0)
$stackByLevel = @{}
$previousLevel = 0
foreach ($item in $inputRows) {
    $level = [int](Get-OptionalProperty $item "hierarchy_level" 0)
    $parentCode = [string](Get-OptionalProperty $item "hierarchy_parent_code" "")
    if ($allLegacyLevelOne -and [string]::IsNullOrWhiteSpace($parentCode)) { $level = 0 }
    if ($level -lt 0) { $level = 0 }
    if ($level -gt ($previousLevel + 1)) { $level = $previousLevel + 1 }
    if ([string]::IsNullOrWhiteSpace($parentCode) -and $level -gt 0 -and $stackByLevel.ContainsKey($level - 1)) {
        $parentCode = [string]$stackByLevel[$level - 1]
    }
    $item | Add-Member -Force -NotePropertyName _ui_level -NotePropertyValue $level
    $item | Add-Member -Force -NotePropertyName _ui_parent_code -NotePropertyValue $parentCode
    $stackByLevel[$level] = [string](Get-OptionalProperty $item "code" "")
    foreach ($stackKey in @($stackByLevel.Keys)) {
        if ([int]$stackKey -gt $level) { $stackByLevel.Remove($stackKey) }
    }
    $previousLevel = $level
}
$parentCodes = @{}
foreach ($item in $inputRows) {
    $parentCode = [string](Get-OptionalProperty $item "_ui_parent_code" "")
    if (-not [string]::IsNullOrWhiteSpace($parentCode)) { $parentCodes[$parentCode] = $true }
}
foreach ($item in $inputRows) {
    $code = [string](Get-OptionalProperty $item "code" "")
    $hasChildren = $parentCodes.ContainsKey($code)
    $item | Add-Member -Force -NotePropertyName _ui_has_children -NotePropertyValue $hasChildren
}

$decisionsDocument = Load-DecisionsDocument
Refresh-ConfiguredRules
$decisionByKey = @{}
foreach ($item in @($decisionsDocument.decisions)) {
    $key = [string](Get-OptionalProperty $item "decision_key" "")
    if (-not [string]::IsNullOrWhiteSpace($key)) { $decisionByKey[$key] = $item }
}

$stateByKey = @{}
$expandedByCode = @{}
foreach ($item in $inputRows) {
    $key = [string]$item.decision_key
    $isDiscrepancy = Get-IsDiscrepancy $item
    $saved = $null
    if ($decisionByKey.ContainsKey($key)) { $saved = $decisionByKey[$key] }
    $include = $isDiscrepancy
    if ($null -ne $saved) { $include = [bool](Get-OptionalProperty $saved "include_in_task" $include) }
    if (-not $isDiscrepancy) { $include = $false }
    $stateByKey[$key] = [pscustomobject]@{
        include_in_task = $include
        user_comment = [string](Get-OptionalProperty $saved "user_comment" "")
        codex_comment = [string](Get-OptionalProperty $saved "codex_comment" "")
    }
    $code = [string](Get-OptionalProperty $item "code" "")
    if ([bool](Get-OptionalProperty $item "_ui_has_children" $false)) { $expandedByCode[$code] = $true }
}

$dark = [System.Drawing.Color]::FromArgb(12, 27, 43)
$dark2 = [System.Drawing.Color]::FromArgb(16, 36, 56)
$dark3 = [System.Drawing.Color]::FromArgb(22, 47, 70)
$dark4 = [System.Drawing.Color]::FromArgb(30, 59, 85)
$blue = [System.Drawing.Color]::FromArgb(20, 105, 230)
$blueHover = [System.Drawing.Color]::FromArgb(36, 125, 245)
$green = [System.Drawing.Color]::FromArgb(93, 204, 111)
$orange = [System.Drawing.Color]::FromArgb(243, 146, 46)
$red = [System.Drawing.Color]::FromArgb(238, 82, 78)
$lightText = [System.Drawing.Color]::FromArgb(235, 241, 247)
$mutedText = [System.Drawing.Color]::FromArgb(163, 182, 201)
$gridLine = [System.Drawing.Color]::FromArgb(52, 76, 98)
$selected = [System.Drawing.Color]::FromArgb(38, 88, 132)

function New-DarkButton {
    param(
        [string]$Text,
        [System.Drawing.Color]$BackColor,
        [int]$Width = 160,
        [int]$Height = 36
    )
    $button = New-Object System.Windows.Forms.Button
    $button.Text = $Text
    $button.Size = New-Object System.Drawing.Size($Width, $Height)
    $button.BackColor = $BackColor
    $button.ForeColor = [System.Drawing.Color]::White
    $button.FlatStyle = "Flat"
    $button.FlatAppearance.BorderSize = 1
    $button.FlatAppearance.BorderColor = $gridLine
    $button.Cursor = [System.Windows.Forms.Cursors]::Hand
    return $button
}

function New-MetricCard {
    param([string]$Caption, [System.Drawing.Color]$ValueColor)
    $panel = New-Object System.Windows.Forms.Panel
    $panel.Size = New-Object System.Drawing.Size(198, 82)
    $panel.Margin = New-Object System.Windows.Forms.Padding -ArgumentList 8, 10, 0, 8
    $panel.BackColor = $dark2
    $panel.BorderStyle = "FixedSingle"

    $captionLabel = New-Object System.Windows.Forms.Label
    $captionLabel.Text = $Caption
    $captionLabel.Location = New-Object System.Drawing.Point(8, 8)
    $captionLabel.Size = New-Object System.Drawing.Size(180, 22)
    $captionLabel.TextAlign = "MiddleCenter"
    $captionLabel.ForeColor = $mutedText
    $panel.Controls.Add($captionLabel)

    $valueLabel = New-Object System.Windows.Forms.Label
    $valueLabel.Text = "0"
    $valueLabel.Location = New-Object System.Drawing.Point(6, 31)
    $valueLabel.Size = New-Object System.Drawing.Size(184, 38)
    $valueLabel.TextAlign = "MiddleCenter"
    $valueLabel.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 16)
    $valueLabel.ForeColor = $ValueColor
    $panel.Controls.Add($valueLabel)

    return [pscustomobject]@{ Panel = $panel; ValueLabel = $valueLabel }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Сверка ОПИУ — настройка статей и промпта ChatGPT / Codex"
$form.ClientSize = New-Object System.Drawing.Size(1500, 900)
$form.MinimumSize = New-Object System.Drawing.Size(1120, 700)
$form.StartPosition = "CenterScreen"
$form.BackColor = $dark
$form.ForeColor = $lightText
$form.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$form.AutoScaleMode = "Dpi"
if ([string]::IsNullOrWhiteSpace($PreviewPath)) { $form.WindowState = "Maximized" }

$header = New-Object System.Windows.Forms.Panel
$header.Dock = "Top"
$header.Height = 88
$header.BackColor = $dark2
$form.Controls.Add($header)

$logo = New-Object System.Windows.Forms.Label
$logo.Text = "ОПИУ"
$logo.Location = New-Object System.Drawing.Point(18, 19)
$logo.Size = New-Object System.Drawing.Size(54, 42)
$logo.TextAlign = "MiddleCenter"
$logo.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 10)
$logo.BackColor = $blue
$logo.ForeColor = [System.Drawing.Color]::White
$header.Controls.Add($logo)

$title = New-Object System.Windows.Forms.Label
$title.Text = "Сверка ОПИУ: иерархия, принятые расхождения и задание для Codex"
$title.Location = New-Object System.Drawing.Point(86, 13)
$title.Size = New-Object System.Drawing.Size(820, 32)
$title.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 17)
$title.ForeColor = $lightText
$header.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = "По умолчанию каждое расхождение обрабатывается. Принятые расхождения запоминаются; оба комментария необязательны."
$subtitle.Location = New-Object System.Drawing.Point(88, 49)
$subtitle.Size = New-Object System.Drawing.Size(850, 23)
$subtitle.ForeColor = $mutedText
$header.Controls.Add($subtitle)

$resetButton = New-DarkButton "Сбросить настройки" $dark3 176 40
$resetButton.Anchor = "Top,Right"
$resetButton.Location = New-Object System.Drawing.Point(1090, 22)
$header.Controls.Add($resetButton)

$saveButton = New-DarkButton "Сохранить настройки" $blue 190 40
$saveButton.Anchor = "Top,Right"
$saveButton.Location = New-Object System.Drawing.Point(1280, 22)
$saveButton.FlatAppearance.BorderSize = 0
$header.Controls.Add($saveButton)

$body = New-Object System.Windows.Forms.Panel
$body.Dock = "Fill"
$body.BackColor = $dark
$form.Controls.Add($body)
$body.BringToFront()
$header.BringToFront()

$sidebar = New-Object System.Windows.Forms.Panel
$sidebar.Dock = "Left"
$sidebar.Width = 252
$sidebar.Padding = New-Object System.Windows.Forms.Padding -ArgumentList 12
$sidebar.BackColor = $dark2
$body.Controls.Add($sidebar)

$contextTitle = New-Object System.Windows.Forms.Label
$contextTitle.Text = "ПАРАМЕТРЫ СВЕРКИ"
$contextTitle.Location = New-Object System.Drawing.Point(16, 16)
$contextTitle.Size = New-Object System.Drawing.Size(214, 22)
$contextTitle.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9)
$contextTitle.ForeColor = [System.Drawing.Color]::FromArgb(170, 199, 237)
$sidebar.Controls.Add($contextTitle)

function Add-SideValue {
    param([string]$Caption, [string]$Value, [int]$Top)
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $Caption
    $label.Location = New-Object System.Drawing.Point(16, $Top)
    $label.Size = New-Object System.Drawing.Size(214, 18)
    $label.ForeColor = $mutedText
    $sidebar.Controls.Add($label)

    $box = New-Object System.Windows.Forms.TextBox
    $box.Text = $Value
    $box.Location = New-Object System.Drawing.Point(16, ($Top + 20))
    $box.Size = New-Object System.Drawing.Size(214, 28)
    $box.ReadOnly = $true
    $box.BackColor = $dark3
    $box.ForeColor = $lightText
    $box.BorderStyle = "FixedSingle"
    $sidebar.Controls.Add($box)
}

Add-SideValue "Организация" ([string]$inputDocument.organization) 48
Add-SideValue "Период" ([string]$inputDocument.period) 104
Add-SideValue "Режим" ([string](Get-OptionalProperty $inputDocument "mode" "")) 160

$navTitle = New-Object System.Windows.Forms.Label
$navTitle.Text = "НАВИГАЦИЯ"
$navTitle.Location = New-Object System.Drawing.Point(16, 230)
$navTitle.Size = New-Object System.Drawing.Size(214, 22)
$navTitle.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9)
$navTitle.ForeColor = [System.Drawing.Color]::FromArgb(170, 199, 237)
$sidebar.Controls.Add($navTitle)

$hierarchyNav = New-DarkButton "Иерархия ОПИУ" $blue 214 38
$hierarchyNav.Location = New-Object System.Drawing.Point(16, 256)
$hierarchyNav.TextAlign = "MiddleLeft"
$sidebar.Controls.Add($hierarchyNav)

$rulesNav = New-DarkButton "Настройки правил" $dark2 214 38
$rulesNav.Location = New-Object System.Drawing.Point(16, 298)
$rulesNav.TextAlign = "MiddleLeft"
$sidebar.Controls.Add($rulesNav)

$memoryNav = New-DarkButton "Память решений" $dark2 214 38
$memoryNav.Location = New-Object System.Drawing.Point(16, 340)
$memoryNav.TextAlign = "MiddleLeft"
$sidebar.Controls.Add($memoryNav)

$promptNav = New-DarkButton "Промпт и пакет Codex" $dark2 214 38
$promptNav.Location = New-Object System.Drawing.Point(16, 382)
$promptNav.TextAlign = "MiddleLeft"
$sidebar.Controls.Add($promptNav)

$helpPanel = New-Object System.Windows.Forms.Panel
$helpPanel.Anchor = "Left,Right,Bottom"
$helpPanel.Location = New-Object System.Drawing.Point(16, 545)
$helpPanel.Size = New-Object System.Drawing.Size(214, 230)
$helpPanel.BackColor = $dark3
$helpPanel.BorderStyle = "FixedSingle"
$sidebar.Controls.Add($helpPanel)

$helpTitle = New-Object System.Windows.Forms.Label
$helpTitle.Text = "Как обрабатывать?"
$helpTitle.Location = New-Object System.Drawing.Point(10, 10)
$helpTitle.Size = New-Object System.Drawing.Size(190, 22)
$helpTitle.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9)
$helpTitle.ForeColor = $lightText
$helpPanel.Controls.Add($helpTitle)

$helpText = New-Object System.Windows.Forms.Label
$helpText.Text = "1. Откройте ветку ОПИУ.`r`n`r`n2. Оставьте «Обрабатывать», если расхождение нужно анализировать.`r`n`r`n3. Нажмите «Принято», если расхождение обосновано.`r`n`r`n4. Комментарии необязательны.`r`n`r`nРежим «Скрыть сведённые» сохраняет родительские строки для понимания структуры."
$helpText.Location = New-Object System.Drawing.Point(10, 38)
$helpText.Size = New-Object System.Drawing.Size(190, 180)
$helpText.ForeColor = $mutedText
$helpPanel.Controls.Add($helpText)

$pageHost = New-Object System.Windows.Forms.Panel
$pageHost.Dock = "Fill"
$pageHost.Padding = New-Object System.Windows.Forms.Padding -ArgumentList 14
$pageHost.BackColor = $dark
$body.Controls.Add($pageHost)
$sidebar.BringToFront()

$hierarchyPage = New-Object System.Windows.Forms.Panel
$hierarchyPage.Dock = "Fill"
$hierarchyPage.BackColor = $dark
$pageHost.Controls.Add($hierarchyPage)

$memoryPage = New-Object System.Windows.Forms.Panel
$memoryPage.Dock = "Fill"
$memoryPage.BackColor = $dark
$memoryPage.Visible = $false
$pageHost.Controls.Add($memoryPage)

$promptPage = New-Object System.Windows.Forms.Panel
$promptPage.Dock = "Fill"
$promptPage.BackColor = $dark
$promptPage.Visible = $false
$pageHost.Controls.Add($promptPage)

$hierarchyLayout = New-Object System.Windows.Forms.TableLayoutPanel
$hierarchyLayout.Dock = "Fill"
$hierarchyLayout.ColumnCount = 1
$hierarchyLayout.RowCount = 5
$hierarchyLayout.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle("Percent", 100)))
$hierarchyLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Absolute", 44)))
$hierarchyLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Absolute", 106)))
$hierarchyLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Absolute", 54)))
$hierarchyLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Percent", 100)))
$hierarchyLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Absolute", 180)))
$hierarchyPage.Controls.Add($hierarchyLayout)

$pageTitle = New-Object System.Windows.Forms.Label
$pageTitle.Text = "Предпросмотр расхождений в иерархии ОПИУ"
$pageTitle.Dock = "Fill"
$pageTitle.TextAlign = "MiddleLeft"
$pageTitle.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 14)
$pageTitle.ForeColor = $lightText
$hierarchyLayout.Controls.Add($pageTitle, 0, 0)

$metrics = New-Object System.Windows.Forms.FlowLayoutPanel
$metrics.Dock = "Fill"
$metrics.WrapContents = $false
$metrics.AutoScroll = $true
$metrics.BackColor = $dark
$hierarchyLayout.Controls.Add($metrics, 0, 1)

$totalCard = New-MetricCard "Всего расхождений" $blue
$processCard = New-MetricCard "Обрабатывать" $green
$acceptedCard = New-MetricCard "Принято" $orange
$processAmountCard = New-MetricCard "|Дельта| к анализу" $green
$acceptedAmountCard = New-MetricCard "|Дельта| принято" $orange
foreach ($card in @($totalCard, $processCard, $acceptedCard, $processAmountCard, $acceptedAmountCard)) {
    $metrics.Controls.Add($card.Panel)
}

$toolbar = New-Object System.Windows.Forms.FlowLayoutPanel
$toolbar.Dock = "Fill"
$toolbar.WrapContents = $false
$toolbar.AutoScroll = $true
$toolbar.Padding = New-Object System.Windows.Forms.Padding -ArgumentList 6, 8, 0, 5
$toolbar.BackColor = $dark2
$hierarchyLayout.Controls.Add($toolbar, 0, 2)

$searchBox = New-Object System.Windows.Forms.TextBox
$searchBox.Size = New-Object System.Drawing.Size(250, 30)
$searchBox.Margin = New-Object System.Windows.Forms.Padding -ArgumentList 4, 4, 8, 0
$searchBox.BackColor = $dark3
$searchBox.ForeColor = $lightText
$searchBox.BorderStyle = "FixedSingle"
$searchBox.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$toolbar.Controls.Add($searchBox)

$statusFilter = New-Object System.Windows.Forms.ComboBox
$statusFilter.Size = New-Object System.Drawing.Size(155, 30)
$statusFilter.Margin = New-Object System.Windows.Forms.Padding -ArgumentList 0, 4, 8, 0
$statusFilter.DropDownStyle = "DropDownList"
$statusFilter.BackColor = $dark3
$statusFilter.ForeColor = $lightText
[void]$statusFilter.Items.AddRange(@("Все статусы", "Обрабатывать", "Принято", "Сведено", "Требует уточнения"))
$statusFilter.SelectedIndex = 0
$toolbar.Controls.Add($statusFilter)

$onlyDiffButton = New-DarkButton "Скрыть сведённые" $blue 170 34
$onlyDiffButton.Margin = New-Object System.Windows.Forms.Padding -ArgumentList 0, 2, 6, 0
$toolbar.Controls.Add($onlyDiffButton)

$allRowsButton = New-DarkButton "Вся иерархия ОПИУ" $dark3 180 34
$allRowsButton.Margin = New-Object System.Windows.Forms.Padding -ArgumentList 0, 2, 12, 0
$toolbar.Controls.Add($allRowsButton)

$expandButton = New-DarkButton "Развернуть всё" $dark3 128 34
$expandButton.Margin = New-Object System.Windows.Forms.Padding -ArgumentList 0, 2, 6, 0
$toolbar.Controls.Add($expandButton)

$collapseButton = New-DarkButton "Свернуть всё" $dark3 120 34
$collapseButton.Margin = New-Object System.Windows.Forms.Padding -ArgumentList 0, 2, 0, 0
$toolbar.Controls.Add($collapseButton)

$grid = New-Object System.Windows.Forms.DataGridView
$grid.Dock = "Fill"
$grid.BackgroundColor = $dark
$grid.BorderStyle = "None"
$grid.GridColor = $gridLine
$grid.EnableHeadersVisualStyles = $false
$grid.ColumnHeadersDefaultCellStyle.BackColor = $dark3
$grid.ColumnHeadersDefaultCellStyle.ForeColor = $lightText
$grid.ColumnHeadersDefaultCellStyle.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9)
$grid.ColumnHeadersHeight = 42
$grid.RowTemplate.Height = 30
$grid.RowHeadersVisible = $false
$grid.DefaultCellStyle.BackColor = $dark2
$grid.DefaultCellStyle.ForeColor = $lightText
$grid.DefaultCellStyle.SelectionBackColor = $selected
$grid.DefaultCellStyle.SelectionForeColor = [System.Drawing.Color]::White
$grid.AlternatingRowsDefaultCellStyle.BackColor = [System.Drawing.Color]::FromArgb(18, 40, 61)
$grid.AutoGenerateColumns = $false
$grid.AllowUserToAddRows = $false
$grid.AllowUserToDeleteRows = $false
$grid.AllowUserToResizeRows = $false
$grid.MultiSelect = $true
$grid.SelectionMode = "FullRowSelect"
$grid.EditMode = "EditOnEnter"
$hierarchyLayout.Controls.Add($grid, 0, 3)

function Add-GridTextColumn {
    param(
        [string]$Name,
        [string]$Header,
        [int]$Width,
        [bool]$ReadOnly = $true,
        [string]$AutoSizeMode = "None"
    )
    $column = New-Object System.Windows.Forms.DataGridViewTextBoxColumn
    $column.Name = $Name
    $column.HeaderText = $Header
    $column.Width = $Width
    $column.MinimumWidth = [math]::Min($Width, 70)
    $column.ReadOnly = $ReadOnly
    $column.SortMode = "NotSortable"
    $column.AutoSizeMode = $AutoSizeMode
    [void]$grid.Columns.Add($column)
}

Add-GridTextColumn "tree_toggle" "" 34 $true
$processColumn = New-Object System.Windows.Forms.DataGridViewCheckBoxColumn
$processColumn.Name = "include_in_task"
$processColumn.HeaderText = "В ТЗ"
$processColumn.Width = 52
$processColumn.FalseValue = $false
$processColumn.TrueValue = $true
$processColumn.SortMode = "NotSortable"
[void]$grid.Columns.Add($processColumn)
Add-GridTextColumn "decision_status" "Статус" 112 $true
Add-GridTextColumn "code" "Код" 66 $true
Add-GridTextColumn "intalev_label" "Иерархия ОПИУ / статья Инталев" 310 $true "Fill"
Add-GridTextColumn "erp_label" "Статья ERP" 250 $true "Fill"
Add-GridTextColumn "intalev_amount" "Инталев" 112 $true
Add-GridTextColumn "erp_amount" "ERP" 112 $true
Add-GridTextColumn "delta" "Расхождение" 120 $true
Add-GridTextColumn "technical_status" "Примечание" 150 $true
Add-GridTextColumn "rule_status" "Правило корректировки" 210 $true
Add-GridTextColumn "decision_key" "Ключ" 50 $true
Add-GridTextColumn "parent_code" "Родитель" 50 $true
Add-GridTextColumn "level" "Уровень" 50 $true
Add-GridTextColumn "is_discrepancy" "Расхождение?" 50 $true
foreach ($name in @("decision_key", "parent_code", "level", "is_discrepancy")) { $grid.Columns[$name].Visible = $false }
foreach ($name in @("intalev_amount", "erp_amount", "delta")) {
    $grid.Columns[$name].DefaultCellStyle.Alignment = "MiddleRight"
    $grid.Columns[$name].DefaultCellStyle.Format = "N2"
}
$grid.Columns["tree_toggle"].DefaultCellStyle.Alignment = "MiddleCenter"
$grid.Columns["decision_status"].DefaultCellStyle.Alignment = "MiddleCenter"
$grid.Columns["include_in_task"].DefaultCellStyle.Alignment = "MiddleCenter"

$editor = New-Object System.Windows.Forms.TableLayoutPanel
$editor.Dock = "Fill"
$editor.BackColor = $dark2
$editor.Padding = New-Object System.Windows.Forms.Padding -ArgumentList 10, 6, 10, 6
$editor.ColumnCount = 4
$editor.RowCount = 5
$editor.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle("Percent", 40)))
$editor.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle("Percent", 40)))
$editor.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle("Percent", 10)))
$editor.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle("Percent", 10)))
$editor.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Absolute", 28)))
$editor.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Absolute", 24)))
$editor.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Absolute", 22)))
$editor.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Percent", 100)))
$editor.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Absolute", 44)))
$hierarchyLayout.Controls.Add($editor, 0, 4)

$selectedTitle = New-Object System.Windows.Forms.Label
$selectedTitle.Text = "Выберите строку ОПИУ"
$selectedTitle.Dock = "Fill"
$selectedTitle.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 10)
$selectedTitle.ForeColor = $lightText
$editor.Controls.Add($selectedTitle, 0, 0)
$editor.SetColumnSpan($selectedTitle, 4)

$selectedMeta = New-Object System.Windows.Forms.Label
$selectedMeta.Text = ""
$selectedMeta.Dock = "Fill"
$selectedMeta.ForeColor = $mutedText
$editor.Controls.Add($selectedMeta, 0, 1)
$editor.SetColumnSpan($selectedMeta, 4)

$userCommentLabel = New-Object System.Windows.Forms.Label
$userCommentLabel.Text = "Комментарий пользователя (необязательно)"
$userCommentLabel.Dock = "Fill"
$userCommentLabel.ForeColor = $mutedText
$editor.Controls.Add($userCommentLabel, 0, 2)

$codexCommentLabel = New-Object System.Windows.Forms.Label
$codexCommentLabel.Text = "Комментарий для Codex (необязательно)"
$codexCommentLabel.Dock = "Fill"
$codexCommentLabel.ForeColor = $mutedText
$editor.Controls.Add($codexCommentLabel, 1, 2)

$userCommentBox = New-Object System.Windows.Forms.TextBox
$userCommentBox.Dock = "Fill"
$userCommentBox.Multiline = $true
$userCommentBox.ScrollBars = "Vertical"
$userCommentBox.BackColor = $dark3
$userCommentBox.ForeColor = $lightText
$userCommentBox.BorderStyle = "FixedSingle"
$editor.Controls.Add($userCommentBox, 0, 3)

$codexCommentBox = New-Object System.Windows.Forms.TextBox
$codexCommentBox.Dock = "Fill"
$codexCommentBox.Multiline = $true
$codexCommentBox.ScrollBars = "Vertical"
$codexCommentBox.BackColor = $dark3
$codexCommentBox.ForeColor = $lightText
$codexCommentBox.BorderStyle = "FixedSingle"
$editor.Controls.Add($codexCommentBox, 1, 3)

$processSelectedButton = New-DarkButton "Обрабатывать" $green 120 52
$processSelectedButton.Dock = "Fill"
$processSelectedButton.ForeColor = [System.Drawing.Color]::FromArgb(0, 55, 12)
$editor.Controls.Add($processSelectedButton, 2, 3)

$acceptSelectedButton = New-DarkButton "Принято" $orange 105 52
$acceptSelectedButton.Dock = "Fill"
$acceptSelectedButton.ForeColor = [System.Drawing.Color]::FromArgb(74, 34, 0)
$editor.Controls.Add($acceptSelectedButton, 3, 3)

$detailsLabel = New-Object System.Windows.Forms.Label
$detailsLabel.Text = "Полные пути и технические данные появятся после выбора строки."
$detailsLabel.Dock = "Fill"
$detailsLabel.ForeColor = $mutedText
$detailsLabel.AutoEllipsis = $true
$editor.Controls.Add($detailsLabel, 0, 4)
$editor.SetColumnSpan($detailsLabel, 2)

$configureRuleButton = New-DarkButton "Создать правило: статьи и Дт / Кт" $blue 250 36
$configureRuleButton.Dock = "Fill"
$configureRuleButton.Enabled = $false
$editor.Controls.Add($configureRuleButton, 2, 4)
$editor.SetColumnSpan($configureRuleButton, 2)

# Страница памяти решений.
$memoryLayout = New-Object System.Windows.Forms.TableLayoutPanel
$memoryLayout.Dock = "Fill"
$memoryLayout.ColumnCount = 1
$memoryLayout.RowCount = 3
$memoryLayout.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle("Percent", 100)))
$memoryLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Absolute", 54)))
$memoryLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Absolute", 52)))
$memoryLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Percent", 100)))
$memoryPage.Controls.Add($memoryLayout)

$memoryTitle = New-Object System.Windows.Forms.Label
$memoryTitle.Text = "Память принятых расхождений"
$memoryTitle.Dock = "Fill"
$memoryTitle.TextAlign = "MiddleLeft"
$memoryTitle.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 14)
$memoryTitle.ForeColor = $lightText
$memoryLayout.Controls.Add($memoryTitle, 0, 0)

$memoryToolbar = New-Object System.Windows.Forms.FlowLayoutPanel
$memoryToolbar.Dock = "Fill"
$memoryToolbar.Padding = New-Object System.Windows.Forms.Padding -ArgumentList 6, 8, 0, 5
$memoryToolbar.BackColor = $dark2
$memoryLayout.Controls.Add($memoryToolbar, 0, 1)

$returnToProcessButton = New-DarkButton "Вернуть выбранное в обработку" $blue 240 34
$memoryToolbar.Controls.Add($returnToProcessButton)

$memoryHint = New-Object System.Windows.Forms.Label
$memoryHint.Text = "Здесь видны решения по всем ранее сохранённым организациям и периодам."
$memoryHint.Size = New-Object System.Drawing.Size(600, 30)
$memoryHint.Margin = New-Object System.Windows.Forms.Padding -ArgumentList 14, 7, 0, 0
$memoryHint.ForeColor = $mutedText
$memoryToolbar.Controls.Add($memoryHint)

$memoryGrid = New-Object System.Windows.Forms.DataGridView
$memoryGrid.Dock = "Fill"
$memoryGrid.BackgroundColor = $dark
$memoryGrid.BorderStyle = "None"
$memoryGrid.GridColor = $gridLine
$memoryGrid.EnableHeadersVisualStyles = $false
$memoryGrid.ColumnHeadersDefaultCellStyle.BackColor = $dark3
$memoryGrid.ColumnHeadersDefaultCellStyle.ForeColor = $lightText
$memoryGrid.ColumnHeadersDefaultCellStyle.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9)
$memoryGrid.ColumnHeadersHeight = 40
$memoryGrid.RowHeadersVisible = $false
$memoryGrid.DefaultCellStyle.BackColor = $dark2
$memoryGrid.DefaultCellStyle.ForeColor = $lightText
$memoryGrid.DefaultCellStyle.SelectionBackColor = $selected
$memoryGrid.DefaultCellStyle.SelectionForeColor = [System.Drawing.Color]::White
$memoryGrid.AutoGenerateColumns = $false
$memoryGrid.AllowUserToAddRows = $false
$memoryGrid.AllowUserToDeleteRows = $false
$memoryGrid.ReadOnly = $true
$memoryGrid.SelectionMode = "FullRowSelect"
$memoryGrid.MultiSelect = $true
$memoryLayout.Controls.Add($memoryGrid, 0, 2)

function Add-MemoryColumn {
    param([string]$Name, [string]$Header, [int]$Width, [string]$AutoSizeMode = "None")
    $column = New-Object System.Windows.Forms.DataGridViewTextBoxColumn
    $column.Name = $Name
    $column.HeaderText = $Header
    $column.Width = $Width
    $column.AutoSizeMode = $AutoSizeMode
    $column.SortMode = "Automatic"
    [void]$memoryGrid.Columns.Add($column)
}
Add-MemoryColumn "organization" "Организация" 210
Add-MemoryColumn "period" "Период" 100
Add-MemoryColumn "code" "Код" 70
Add-MemoryColumn "article" "Статья ОПИУ" 280 "Fill"
Add-MemoryColumn "delta" "Расхождение" 120
Add-MemoryColumn "user_comment" "Комментарий пользователя" 260 "Fill"
Add-MemoryColumn "codex_comment" "Комментарий Codex" 260 "Fill"
Add-MemoryColumn "updated_at" "Дата решения" 165
Add-MemoryColumn "decision_key" "Ключ" 40
$memoryGrid.Columns["decision_key"].Visible = $false
$memoryGrid.Columns["delta"].DefaultCellStyle.Alignment = "MiddleRight"
$memoryGrid.Columns["delta"].DefaultCellStyle.Format = "N2"

# Страница промпта и формирования пакета.
$promptLayout = New-Object System.Windows.Forms.TableLayoutPanel
$promptLayout.Dock = "Fill"
$promptLayout.ColumnCount = 1
$promptLayout.RowCount = 3
$promptLayout.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle("Percent", 100)))
$promptLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Absolute", 54)))
$promptLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Percent", 100)))
$promptLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Absolute", 58)))
$promptPage.Controls.Add($promptLayout)

$promptTitle = New-Object System.Windows.Forms.Label
$promptTitle.Text = "Промпт для ChatGPT / Codex"
$promptTitle.Dock = "Fill"
$promptTitle.TextAlign = "MiddleLeft"
$promptTitle.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 14)
$promptTitle.ForeColor = $lightText
$promptLayout.Controls.Add($promptTitle, 0, 0)

$promptBox = New-Object System.Windows.Forms.TextBox
$promptBox.Dock = "Fill"
$promptBox.Multiline = $true
$promptBox.ScrollBars = "Both"
$promptBox.WordWrap = $false
$promptBox.ReadOnly = $true
$promptBox.BackColor = $dark2
$promptBox.ForeColor = $lightText
$promptBox.Font = New-Object System.Drawing.Font("Consolas", 10)
$promptBox.BorderStyle = "FixedSingle"
$promptLayout.Controls.Add($promptBox, 0, 1)

$promptButtons = New-Object System.Windows.Forms.FlowLayoutPanel
$promptButtons.Dock = "Fill"
$promptButtons.FlowDirection = "RightToLeft"
$promptButtons.Padding = New-Object System.Windows.Forms.Padding -ArgumentList 6, 8, 6, 6
$promptButtons.BackColor = $dark2
$promptLayout.Controls.Add($promptButtons, 0, 2)

$packageButton = New-DarkButton "Сформировать пакет Codex" $blue 250 38
$packageButton.FlatAppearance.BorderSize = 0
$promptButtons.Controls.Add($packageButton)

$copyPromptButton = New-DarkButton "Копировать промпт" $dark3 180 38
$promptButtons.Controls.Add($copyPromptButton)

$script:showAllRows = $false
$script:suppressGridEvents = $false
$script:suppressEditorEvents = $false
$script:selectedDecisionKey = ""

function Get-DecisionStatus {
    param([object]$Item, [object]$State)
    if (-not (Get-IsDiscrepancy $Item)) { return "Сведено" }
    if ([bool]$State.include_in_task) { return "Обрабатывать" }
    return "Принято"
}

function Get-AncestorCodes {
    param([object]$Item)
    $result = @()
    $parentCode = [string](Get-OptionalProperty $Item "_ui_parent_code" "")
    $guard = 0
    while (-not [string]::IsNullOrWhiteSpace($parentCode) -and $guard -lt 100) {
        $result += $parentCode
        if (-not $rowByCode.ContainsKey($parentCode)) { break }
        $parent = $rowByCode[$parentCode]
        $parentCode = [string](Get-OptionalProperty $parent "_ui_parent_code" "")
        $guard++
    }
    return $result
}

function Test-HasCollapsedAncestor {
    param([object]$Item)
    foreach ($ancestorCode in @(Get-AncestorCodes $Item)) {
        if ($expandedByCode.ContainsKey($ancestorCode) -and -not [bool]$expandedByCode[$ancestorCode]) {
            return $true
        }
    }
    return $false
}

function Add-ItemAndAncestors {
    param([hashtable]$Map, [object]$Item)
    $code = [string](Get-OptionalProperty $Item "code" "")
    if (-not [string]::IsNullOrWhiteSpace($code)) { $Map[$code] = $true }
    foreach ($ancestorCode in @(Get-AncestorCodes $Item)) { $Map[$ancestorCode] = $true }
}

function Get-VisibleItems {
    $baseKeep = @{}
    if ($script:showAllRows) {
        foreach ($item in $inputRows) { $baseKeep[[string]$item.code] = $true }
    } else {
        foreach ($item in $inputRows) {
            if (Get-IsDiscrepancy $item) { Add-ItemAndAncestors $baseKeep $item }
        }
    }

    $filterKeep = $null
    $selectedStatus = [string]$statusFilter.SelectedItem
    if (-not [string]::IsNullOrWhiteSpace($selectedStatus) -and $selectedStatus -ne "Все статусы") {
        $filterKeep = @{}
        foreach ($item in $inputRows) {
            $key = [string]$item.decision_key
            $state = $stateByKey[$key]
            $status = Get-DecisionStatus $item $state
            $match = ($status -eq $selectedStatus)
            if ($selectedStatus -eq "Требует уточнения") {
                $match = Test-RequiresClarification ([string](Get-OptionalProperty $item "technical_status" ""))
            }
            if ($match) { Add-ItemAndAncestors $filterKeep $item }
        }
    }

    $searchKeep = $null
    $query = $searchBox.Text.Trim().ToLowerInvariant()
    if (-not [string]::IsNullOrWhiteSpace($query)) {
        $searchKeep = @{}
        foreach ($item in $inputRows) {
            $key = [string]$item.decision_key
            $state = $stateByKey[$key]
            $haystack = @(
                [string](Get-OptionalProperty $item "code" ""),
                [string](Get-OptionalProperty $item "intalev_label" ""),
                [string](Get-OptionalProperty $item "erp_label" ""),
                [string](Get-OptionalProperty $item "group" ""),
                [string]$state.user_comment,
                [string]$state.codex_comment,
                (@(Get-OptionalProperty $item "intalev_paths" @()) -join " "),
                (@(Get-OptionalProperty $item "erp_paths" @()) -join " ")
            ) -join " "
            if ($haystack.ToLowerInvariant().Contains($query)) { Add-ItemAndAncestors $searchKeep $item }
        }
    }

    $result = @()
    foreach ($item in $inputRows) {
        $code = [string]$item.code
        if (-not $baseKeep.ContainsKey($code)) { continue }
        if ($null -ne $filterKeep -and -not $filterKeep.ContainsKey($code)) { continue }
        if ($null -ne $searchKeep -and -not $searchKeep.ContainsKey($code)) { continue }
        if (Test-HasCollapsedAncestor $item) { continue }
        $result += $item
    }
    return $result
}

function Set-GridRowStyle {
    param([System.Windows.Forms.DataGridViewRow]$GridRow, [object]$Item)
    $key = [string]$item.decision_key
    $state = $stateByKey[$key]
    $isDiscrepancy = Get-IsDiscrepancy $item
    $status = Get-DecisionStatus $item $state
    $hasChildren = [bool](Get-OptionalProperty $item "_ui_has_children" $false)
    $level = [int](Get-OptionalProperty $item "_ui_level" 0)

    $GridRow.Cells["decision_status"].Value = $status
    $GridRow.Cells["intalev_label"].Style.Padding = New-Object System.Windows.Forms.Padding -ArgumentList (($level * 18) + 5), 0, 0, 0

    if ($hasChildren -or $level -eq 0) {
        $GridRow.DefaultCellStyle.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9)
        $GridRow.DefaultCellStyle.BackColor = $dark3
    }
    if (-not $isDiscrepancy) {
        $GridRow.DefaultCellStyle.ForeColor = $mutedText
        $GridRow.Cells["include_in_task"].ReadOnly = $true
        $GridRow.Cells["include_in_task"].Value = $false
        $GridRow.Cells["decision_status"].Style.ForeColor = $mutedText
    } elseif ($status -eq "Принято") {
        $GridRow.Cells["decision_status"].Style.ForeColor = $orange
        $GridRow.Cells["delta"].Style.ForeColor = $orange
    } else {
        $GridRow.Cells["decision_status"].Style.ForeColor = $green
        $GridRow.Cells["delta"].Style.ForeColor = $red
    }

    if (Test-RequiresClarification ([string](Get-OptionalProperty $item "technical_status" ""))) {
        $GridRow.Cells["technical_status"].Style.ForeColor = $orange
    } else {
        $GridRow.Cells["technical_status"].Style.ForeColor = $mutedText
    }

    $configuredRule = Find-ConfiguredRule $item
    if (-not $isDiscrepancy) {
        $GridRow.Cells["rule_status"].Style.ForeColor = $mutedText
    } elseif ($null -ne $configuredRule) {
        $GridRow.Cells["rule_status"].Style.ForeColor = $green
    } else {
        $GridRow.Cells["rule_status"].Style.ForeColor = $orange
    }
}

function Update-Summary {
    $total = 0
    $process = 0
    $accepted = 0
    $processAmount = 0.0
    $acceptedAmount = 0.0
    foreach ($item in $inputRows) {
        if (-not (Get-IsDiscrepancy $item)) { continue }
        $total++
        $state = $stateByKey[[string]$item.decision_key]
        $absoluteDelta = [math]::Abs((Get-NumberValue (Get-OptionalProperty $item "delta" 0)))
        if ([bool]$state.include_in_task) {
            $process++
            $processAmount += $absoluteDelta
        } else {
            $accepted++
            $acceptedAmount += $absoluteDelta
        }
    }
    $totalCard.ValueLabel.Text = $total.ToString("N0")
    $processCard.ValueLabel.Text = $process.ToString("N0")
    $acceptedCard.ValueLabel.Text = $accepted.ToString("N0")
    $processAmountCard.ValueLabel.Text = $processAmount.ToString("N2")
    $acceptedAmountCard.ValueLabel.Text = $acceptedAmount.ToString("N2")
}

function Rebuild-HierarchyGrid {
    $rememberKey = $script:selectedDecisionKey
    $script:suppressGridEvents = $true
    try {
        $grid.Rows.Clear()
        foreach ($item in @(Get-VisibleItems)) {
            $key = [string]$item.decision_key
            $state = $stateByKey[$key]
            $hasChildren = [bool](Get-OptionalProperty $item "_ui_has_children" $false)
            $code = [string]$item.code
            $toggle = ""
            if ($hasChildren) {
                if ($expandedByCode.ContainsKey($code) -and [bool]$expandedByCode[$code]) { $toggle = "▼" } else { $toggle = "▶" }
            }
            $technical = ""
            if (Test-RequiresClarification ([string](Get-OptionalProperty $item "technical_status" ""))) { $technical = "Требует уточнения" }
            $configuredRule = Find-ConfiguredRule $item
            $ruleStatus = if (Get-IsDiscrepancy $item) { Get-ConfiguredRuleSummary $configuredRule } else { "—" }
            $rowIndex = $grid.Rows.Add(
                $toggle,
                [bool]$state.include_in_task,
                "",
                $code,
                [string](Get-OptionalProperty $item "intalev_label" ""),
                [string](Get-OptionalProperty $item "erp_label" ""),
                (Get-OptionalProperty $item "intalev_amount" $null),
                (Get-OptionalProperty $item "erp_amount" $null),
                (Get-OptionalProperty $item "delta" $null),
                $technical,
                $ruleStatus,
                $key,
                [string](Get-OptionalProperty $item "_ui_parent_code" ""),
                [int](Get-OptionalProperty $item "_ui_level" 0),
                (Get-IsDiscrepancy $item)
            )
            $gridRow = $grid.Rows[$rowIndex]
            $gridRow.Tag = $item
            Set-GridRowStyle $gridRow $item
        }
    } finally {
        $script:suppressGridEvents = $false
    }

    $selected = $false
    if (-not [string]::IsNullOrWhiteSpace($rememberKey)) {
        foreach ($row in $grid.Rows) {
            if ([string]$row.Cells["decision_key"].Value -eq $rememberKey) {
                $row.Selected = $true
                $grid.CurrentCell = $row.Cells["intalev_label"]
                $selected = $true
                break
            }
        }
    }
    if (-not $selected -and $grid.Rows.Count -gt 0) {
        $grid.Rows[0].Selected = $true
        $grid.CurrentCell = $grid.Rows[0].Cells["intalev_label"]
    }
    Update-Summary
}

function Update-SelectedEditor {
    if ($grid.SelectedRows.Count -eq 0) {
        $script:selectedDecisionKey = ""
        $selectedTitle.Text = "Выберите строку ОПИУ"
        $selectedMeta.Text = ""
        $detailsLabel.Text = "Полные пути и технические данные появятся после выбора строки."
        $userCommentBox.Text = ""
        $codexCommentBox.Text = ""
        $userCommentBox.Enabled = $false
        $codexCommentBox.Enabled = $false
        $processSelectedButton.Enabled = $false
        $acceptSelectedButton.Enabled = $false
        $configureRuleButton.Enabled = $false
        $configureRuleButton.Text = "Создать правило: статьи и Дт / Кт"
        $configureRuleButton.BackColor = $blue
        return
    }

    $row = $grid.SelectedRows[0]
    $key = [string]$row.Cells["decision_key"].Value
    if (-not $rowByKey.ContainsKey($key)) { return }
    $script:selectedDecisionKey = $key
    $item = $rowByKey[$key]
    $state = $stateByKey[$key]
    $isDiscrepancy = Get-IsDiscrepancy $item
    $status = Get-DecisionStatus $item $state

    $script:suppressEditorEvents = $true
    try {
        $configuredRule = Find-ConfiguredRule $item
        $ruleShortStatus = if ($null -ne $configuredRule) { "Настроено" } else { "Не настроено" }
        $selectedTitle.Text = "[$($item.code)] $($item.intalev_label)"
        $selectedMeta.Text = "Статус: $status    Правило: $ruleShortStatus    Инталев: $(Get-NumberText $item.intalev_amount)    ERP: $(Get-NumberText $item.erp_amount)    Расхождение: $(Get-NumberText $item.delta)"
        $userCommentBox.Text = [string]$state.user_comment
        $codexCommentBox.Text = [string]$state.codex_comment
        $userCommentBox.Enabled = $isDiscrepancy
        $codexCommentBox.Enabled = $isDiscrepancy
        $processSelectedButton.Enabled = $isDiscrepancy
        $acceptSelectedButton.Enabled = $isDiscrepancy
        $configureRuleButton.Enabled = $isDiscrepancy
        if ($null -ne $configuredRule) {
            $configureRuleButton.Text = "Изменить правило: статьи и Дт / Кт"
            $configureRuleButton.BackColor = $green
            $configureRuleButton.ForeColor = [System.Drawing.Color]::FromArgb(0, 55, 12)
        } else {
            $configureRuleButton.Text = "Создать правило: статьи и Дт / Кт"
            $configureRuleButton.BackColor = $blue
            $configureRuleButton.ForeColor = [System.Drawing.Color]::White
        }
        $intalevPaths = @(Get-OptionalProperty $item "intalev_paths" @()) -join " | "
        $erpPaths = @(Get-OptionalProperty $item "erp_paths" @()) -join " | "
        $cfo = @(Get-OptionalProperty $item "cfo" @()) -join " | "
        $accounts = @(Get-OptionalProperty $item "accounts" @()) -join " | "
        $detailsLabel.Text = "Инталев: $intalevPaths     ERP: $erpPaths     Подразделения (схлопнуты, справочно): $cfo     Счета: $accounts"
    } finally {
        $script:suppressEditorEvents = $false
    }
}

function Get-CurrentDecisions {
    $items = @()
    foreach ($item in $inputRows) {
        if (-not (Get-IsDiscrepancy $item)) { continue }
        $key = [string]$item.decision_key
        $state = $stateByKey[$key]
        $decisionValue = "ACCEPTED"
        if ([bool]$state.include_in_task) { $decisionValue = "PROCESS" }
        $items += [pscustomobject]@{
            decision_key = $key
            organization = [string]$inputDocument.organization
            organization_code = [string]$inputDocument.organization_code
            period = [string]$inputDocument.period
            periods = @($inputDocument.periods)
            mode = [string]$inputDocument.mode
            code = [string]$item.code
            group = [string]$item.group
            intalev_label = [string]$item.intalev_label
            erp_label = [string]$item.erp_label
            intalev_paths = @($item.intalev_paths)
            erp_paths = @($item.erp_paths)
            cfo = @($item.cfo)
            departments = @(Get-OptionalProperty $item "departments" @())
            dimensions_ignored_for_reconciliation = $true
            include_in_task = [bool]$state.include_in_task
            decision = $decisionValue
            user_comment = [string]$state.user_comment
            codex_comment = [string]$state.codex_comment
            updated_at = (Get-Date).ToUniversalTime().ToString("o")
        }
    }
    return $items
}

function Save-CurrentSettings {
    $current = @(Get-CurrentDecisions)
    Save-DecisionsDocument $current
    foreach ($decision in $current) { $decisionByKey[[string]$decision.decision_key] = $decision }
    $decisionsDocument = Load-DecisionsDocument
    Refresh-MemoryGrid
}


function Open-RulesEditorForItem {
    param([object]$Item)
    try {
        if ($null -eq $Item) { throw "Сначала выберите строку расхождения." }
        if (-not (Get-IsDiscrepancy $Item)) { throw "Для сведённой строки правило корректировки не требуется." }
        if (-not (Test-Path -LiteralPath $rulesUiPath -PathType Leaf)) { throw "Не найден файл формы правил: $rulesUiPath" }
        $powershellPath = Join-Path $PSHOME "powershell.exe"
        if (-not (Test-Path -LiteralPath $powershellPath)) { $powershellPath = "powershell.exe" }
        $arguments = @(
            "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", $rulesUiPath,
            "-AppDir", $AppDir,
            "-InputPath", $resolvedInputPath,
            "-SelectedCode", ([string](Get-OptionalProperty $Item "code" ""))
        )
        Start-Process -FilePath $powershellPath -ArgumentList (($arguments | ForEach-Object { ConvertTo-CommandLineArgument ([string]$_) }) -join " ") -Wait
        Refresh-ConfiguredRules
        Rebuild-HierarchyGrid
        Update-SelectedEditor
    } catch {
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Настройки правил", "OK", "Error") | Out-Null
    }
}

function Build-PromptPreview {
    $processRows = @()
    $acceptedRows = @()
    foreach ($item in $inputRows) {
        if (-not (Get-IsDiscrepancy $item)) { continue }
        $state = $stateByKey[[string]$item.decision_key]
        if ([bool]$state.include_in_task) { $processRows += $item } else { $acceptedRows += $item }
    }

    $lines = @(
        "# Задание для Codex: анализ расхождений ОПИУ и корректировочная модель",
        "",
        "Организация: $($inputDocument.organization)",
        "Период: $($inputDocument.period)",
        "Правила: $($inputDocument.project_rules)",
        "",
        "Обрабатывать строк: $($processRows.Count). Принято пользователем: $($acceptedRows.Count).",
        "Строки со статусом «Принято» не корректировать.",
        "Пометка «Требует уточнения» не исключает строку из анализа: сначала нужно уточнить сопоставление или исходное значение.",
        "Не изменять исходные файлы и не загружать данные в 1С.",
        "ready_to_upload=false; release_allowed=false.",
        "",
        "## Строки в обработке"
    )
    foreach ($item in $processRows) {
        $state = $stateByKey[[string]$item.decision_key]
        $pathText = @(Get-OptionalProperty $item "hierarchy_path" @()) -join " / "
        $lines += ""
        $lines += "[$($item.code)] $($item.intalev_label)"
        if (-not [string]::IsNullOrWhiteSpace($pathText)) { $lines += "Иерархия: $pathText" }
        $lines += "Инталев: $(Get-NumberText $item.intalev_amount); ERP: $(Get-NumberText $item.erp_amount); дельта: $(Get-NumberText $item.delta)"
        if (Test-RequiresClarification ([string](Get-OptionalProperty $item "technical_status" ""))) { $lines += "Примечание: требует уточнения сопоставления или значения." }
        if (-not [string]::IsNullOrWhiteSpace([string]$state.user_comment)) { $lines += "Комментарий пользователя: $($state.user_comment)" }
        if (-not [string]::IsNullOrWhiteSpace([string]$state.codex_comment)) { $lines += "Указание Codex: $($state.codex_comment)" }
    }
    return ($lines -join "`r`n")
}

function Refresh-Prompt {
    $promptBox.Text = Build-PromptPreview
}

function Refresh-MemoryGrid {
    $memoryGrid.Rows.Clear()
    $memoryMap = @{}
    foreach ($decision in @((Load-DecisionsDocument).decisions)) {
        $key = [string](Get-OptionalProperty $decision "decision_key" "")
        if (-not [string]::IsNullOrWhiteSpace($key)) { $memoryMap[$key] = $decision }
    }
    foreach ($item in $inputRows) {
        if (-not (Get-IsDiscrepancy $item)) { continue }
        $key = [string]$item.decision_key
        $state = $stateByKey[$key]
        $memoryMap[$key] = [pscustomobject]@{
            decision_key = $key
            organization = [string]$inputDocument.organization
            period = [string]$inputDocument.period
            code = [string]$item.code
            intalev_label = [string]$item.intalev_label
            include_in_task = [bool]$state.include_in_task
            user_comment = [string]$state.user_comment
            codex_comment = [string]$state.codex_comment
            updated_at = [string](Get-OptionalProperty $decisionByKey[$key] "updated_at" "")
        }
    }

    $accepted = @($memoryMap.Values | Where-Object { (Get-OptionalProperty $_ "include_in_task" $true) -eq $false } | Sort-Object organization, period, code)
    foreach ($decision in $accepted) {
        $key = [string]$decision.decision_key
        $currentItem = $null
        if ($rowByKey.ContainsKey($key)) { $currentItem = $rowByKey[$key] }
        $article = [string](Get-OptionalProperty $decision "intalev_label" "")
        $delta = $null
        if ($null -ne $currentItem) {
            $article = [string]$currentItem.intalev_label
            $delta = Get-OptionalProperty $currentItem "delta" $null
        }
        [void]$memoryGrid.Rows.Add(
            [string](Get-OptionalProperty $decision "organization" ""),
            [string](Get-OptionalProperty $decision "period" ""),
            [string](Get-OptionalProperty $decision "code" ""),
            $article,
            $delta,
            [string](Get-OptionalProperty $decision "user_comment" ""),
            [string](Get-OptionalProperty $decision "codex_comment" ""),
            [string](Get-OptionalProperty $decision "updated_at" ""),
            $key
        )
    }
}

function Show-Page {
    param([string]$PageName)
    $hierarchyPage.Visible = ($PageName -eq "hierarchy")
    $memoryPage.Visible = ($PageName -eq "memory")
    $promptPage.Visible = ($PageName -eq "prompt")
    $hierarchyNav.BackColor = $dark2
    $memoryNav.BackColor = $dark2
    $promptNav.BackColor = $dark2
    if ($PageName -eq "hierarchy") {
        $hierarchyNav.BackColor = $blue
        $hierarchyPage.BringToFront()
    } elseif ($PageName -eq "memory") {
        Refresh-MemoryGrid
        $memoryNav.BackColor = $blue
        $memoryPage.BringToFront()
    } else {
        Refresh-Prompt
        $promptNav.BackColor = $blue
        $promptPage.BringToFront()
    }
}

function Set-SelectedDecision {
    param([bool]$Include)
    if ($grid.SelectedRows.Count -eq 0) { return }
    foreach ($row in @($grid.SelectedRows)) {
        $key = [string]$row.Cells["decision_key"].Value
        if (-not $rowByKey.ContainsKey($key)) { continue }
        $item = $rowByKey[$key]
        if (-not (Get-IsDiscrepancy $item)) { continue }
        $stateByKey[$key].include_in_task = $Include
    }
    Rebuild-HierarchyGrid
    Update-SelectedEditor
}

$grid.Add_CurrentCellDirtyStateChanged({
    if ($grid.IsCurrentCellDirty) {
        [void]$grid.CommitEdit([System.Windows.Forms.DataGridViewDataErrorContexts]::Commit)
    }
})

$grid.Add_CellValueChanged({
    param($sender, $eventArgs)
    if ($script:suppressGridEvents -or $eventArgs.RowIndex -lt 0 -or $eventArgs.ColumnIndex -lt 0) { return }
    if ($grid.Columns[$eventArgs.ColumnIndex].Name -ne "include_in_task") { return }
    $row = $grid.Rows[$eventArgs.RowIndex]
    $key = [string]$row.Cells["decision_key"].Value
    if (-not $rowByKey.ContainsKey($key)) { return }
    $item = $rowByKey[$key]
    if (-not (Get-IsDiscrepancy $item)) { return }
    $stateByKey[$key].include_in_task = [bool]$row.Cells["include_in_task"].Value
    Set-GridRowStyle $row $item
    Update-Summary
    Update-SelectedEditor
})

$grid.Add_CellContentClick({
    param($sender, $eventArgs)
    if ($eventArgs.RowIndex -lt 0 -or $eventArgs.ColumnIndex -lt 0) { return }
    if ($grid.Columns[$eventArgs.ColumnIndex].Name -ne "tree_toggle") { return }
    $row = $grid.Rows[$eventArgs.RowIndex]
    $code = [string]$row.Cells["code"].Value
    if (-not $parentCodes.ContainsKey($code)) { return }
    if ($expandedByCode.ContainsKey($code)) { $expandedByCode[$code] = -not [bool]$expandedByCode[$code] } else { $expandedByCode[$code] = $false }
    Rebuild-HierarchyGrid
})

$grid.Add_SelectionChanged({ Update-SelectedEditor })
$searchBox.Add_TextChanged({ Rebuild-HierarchyGrid })
$statusFilter.Add_SelectedIndexChanged({ Rebuild-HierarchyGrid })

$onlyDiffButton.Add_Click({
    $script:showAllRows = $false
    $onlyDiffButton.BackColor = $blue
    $allRowsButton.BackColor = $dark3
    Rebuild-HierarchyGrid
})

$allRowsButton.Add_Click({
    $script:showAllRows = $true
    $allRowsButton.BackColor = $blue
    $onlyDiffButton.BackColor = $dark3
    Rebuild-HierarchyGrid
})

$expandButton.Add_Click({
    foreach ($code in @($parentCodes.Keys)) { $expandedByCode[$code] = $true }
    Rebuild-HierarchyGrid
})

$collapseButton.Add_Click({
    foreach ($code in @($parentCodes.Keys)) { $expandedByCode[$code] = $false }
    Rebuild-HierarchyGrid
})

$processSelectedButton.Add_Click({ Set-SelectedDecision $true })
$acceptSelectedButton.Add_Click({ Set-SelectedDecision $false })
$configureRuleButton.Add_Click({
    if ([string]::IsNullOrWhiteSpace($script:selectedDecisionKey) -or -not $rowByKey.ContainsKey($script:selectedDecisionKey)) { return }
    Open-RulesEditorForItem $rowByKey[$script:selectedDecisionKey]
})

$userCommentBox.Add_TextChanged({
    if ($script:suppressEditorEvents -or [string]::IsNullOrWhiteSpace($script:selectedDecisionKey)) { return }
    if ($stateByKey.ContainsKey($script:selectedDecisionKey)) { $stateByKey[$script:selectedDecisionKey].user_comment = $userCommentBox.Text }
})

$codexCommentBox.Add_TextChanged({
    if ($script:suppressEditorEvents -or [string]::IsNullOrWhiteSpace($script:selectedDecisionKey)) { return }
    if ($stateByKey.ContainsKey($script:selectedDecisionKey)) { $stateByKey[$script:selectedDecisionKey].codex_comment = $codexCommentBox.Text }
})

$hierarchyNav.Add_Click({ Show-Page "hierarchy" })
$rulesNav.Add_Click({
    try {
        if (-not (Test-Path -LiteralPath $rulesUiPath -PathType Leaf)) { throw "Не найден файл формы правил: $rulesUiPath" }
        $powershellPath = Join-Path $PSHOME "powershell.exe"
        if (-not (Test-Path -LiteralPath $powershellPath)) { $powershellPath = "powershell.exe" }
        $arguments = @(
            "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", $rulesUiPath,
            "-AppDir", $AppDir,
            "-InputPath", $resolvedInputPath
        )
        Start-Process -FilePath $powershellPath -ArgumentList (($arguments | ForEach-Object { ConvertTo-CommandLineArgument ([string]$_) }) -join " ") -Wait
        Refresh-ConfiguredRules
        Rebuild-HierarchyGrid
        Update-SelectedEditor
    } catch {
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Настройки правил", "OK", "Error") | Out-Null
    }
})
$memoryNav.Add_Click({ Show-Page "memory" })
$promptNav.Add_Click({ Show-Page "prompt" })

$returnToProcessButton.Add_Click({
    foreach ($row in @($memoryGrid.SelectedRows)) {
        $key = [string]$row.Cells["decision_key"].Value
        if ($stateByKey.ContainsKey($key)) {
            $stateByKey[$key].include_in_task = $true
        } elseif ($decisionByKey.ContainsKey($key)) {
            $decision = $decisionByKey[$key]
            $updated = [pscustomobject]@{}
            foreach ($property in $decision.PSObject.Properties) { $updated | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value }
            $updated.include_in_task = $true
            $updated.decision = "PROCESS"
            $updated.updated_at = (Get-Date).ToUniversalTime().ToString("o")
            Save-DecisionsDocument @($updated)
            $decisionByKey[$key] = $updated
        }
    }
    Refresh-MemoryGrid
    Rebuild-HierarchyGrid
})

$saveButton.Add_Click({
    try {
        Save-CurrentSettings
        [System.Media.SystemSounds]::Asterisk.Play()
        [System.Windows.Forms.MessageBox]::Show(
            "Настройки сохранены. Они применятся при повторном открытии этой организации, периода и статьи.",
            "Настройки сохранены",
            "OK",
            "Information"
        ) | Out-Null
    } catch {
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Ошибка сохранения", "OK", "Error") | Out-Null
    }
})

$resetButton.Add_Click({
    $answer = [System.Windows.Forms.MessageBox]::Show(
        "Вернуть все расхождения текущей сверки в обработку и очистить оба комментария?",
        "Сбросить настройки",
        "YesNo",
        "Question"
    )
    if ($answer -ne "Yes") { return }
    foreach ($item in $inputRows) {
        if (-not (Get-IsDiscrepancy $item)) { continue }
        $state = $stateByKey[[string]$item.decision_key]
        $state.include_in_task = $true
        $state.user_comment = ""
        $state.codex_comment = ""
    }
    Save-CurrentSettings
    Rebuild-HierarchyGrid
    Update-SelectedEditor
})

$copyPromptButton.Add_Click({
    Refresh-Prompt
    [System.Windows.Forms.Clipboard]::SetText($promptBox.Text)
    [System.Media.SystemSounds]::Asterisk.Play()
})

$packageButton.Add_Click({
    try {
        Save-CurrentSettings
        $reportPath = [string]$inputDocument.report_path
        $baseDirectory = Split-Path -Parent $reportPath
        if ([string]::IsNullOrWhiteSpace($baseDirectory) -or -not (Test-Path -LiteralPath $baseDirectory)) {
            $baseDirectory = Split-Path -Parent $resolvedInputPath
        }
        $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
        $organizationSafe = Get-SafeFileName ([string]$inputDocument.organization)
        $periodSafe = Get-SafeFileName ([string]$inputDocument.period)
        $folderName = "Codex_Пакет_{0}_{1}_{2}" -f $organizationSafe, $periodSafe, $stamp
        $packageDirectory = Join-Path $baseDirectory $folderName

        $powershellPath = Join-Path $PSHOME "powershell.exe"
        if (-not (Test-Path -LiteralPath $powershellPath)) { $powershellPath = "powershell.exe" }
        $arguments = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", $launcherPath,
            "build-codex-package",
            "-CodexInput", $resolvedInputPath,
            "-Decisions", $decisionsPath,
            "-Rules", $rulesPath,
            "-PackageOutput", $packageDirectory
        )
        $argumentLine = ($arguments | ForEach-Object { ConvertTo-CommandLineArgument ([string]$_) }) -join " "
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
        } catch { }
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo
        $form.UseWaitCursor = $true
        $packageButton.Enabled = $false
        [System.Windows.Forms.Application]::DoEvents()
        if (-not $process.Start()) { throw "Не удалось запустить формирование пакета." }
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        $exitCode = $process.ExitCode
        $process.Dispose()
        if ($exitCode -ne 0) {
            $detail = ($stderr + "`r`n" + $stdout).Trim()
            throw $detail
        }
        Start-Process -FilePath $packageDirectory
        [System.Media.SystemSounds]::Asterisk.Play()
        [System.Windows.Forms.MessageBox]::Show(
            "Пакет Codex создан:`r`n$packageDirectory`r`n`r`nВнутри: промпт, JSON расхождений и Excel-модель корректировок.",
            "Пакет готов",
            "OK",
            "Information"
        ) | Out-Null
    } catch {
        [System.Media.SystemSounds]::Hand.Play()
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Пакет не создан", "OK", "Error") | Out-Null
    } finally {
        $form.UseWaitCursor = $false
        $packageButton.Enabled = $true
    }
})

$form.Add_FormClosing({
    try { Save-CurrentSettings } catch { }
})

Rebuild-HierarchyGrid
Update-SelectedEditor
Refresh-MemoryGrid
Refresh-Prompt
Show-Page "hierarchy"

if ($PreviewPath) {
    $form.WindowState = "Normal"
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

[void]$form.ShowDialog()
