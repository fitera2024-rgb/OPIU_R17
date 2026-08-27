param(
    [string]$AppDir = $PSScriptRoot,
    [string]$InputPath,
    [string]$SelectedCode,
    [switch]$SelfTest,
    [string]$PreviewPath
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$catalogPath = Join-Path $AppDir "data\rule_catalog_cache.json"
$rulesPath = Join-Path $AppDir "data\reconciliation_rules.json"

function Get-OptionalProperty {
    param([object]$Object, [string]$Name, [object]$Default = $null)
    if ($null -eq $Object) { return $Default }
    if ($Object.PSObject.Properties.Name -contains $Name) { return $Object.$Name }
    return $Default
}

function Normalize-Text {
    param([object]$Value)
    return ([string]$Value).Replace([char]0x00A0, " ").Trim().ToLowerInvariant()
}

function Resolve-CodexInputPath {
    param([string]$SelectedPath)
    if ([string]::IsNullOrWhiteSpace($SelectedPath)) { return $null }
    $resolved = [System.IO.Path]::GetFullPath($SelectedPath)
    if ($resolved.EndsWith(".codex-input.json", [System.StringComparison]::OrdinalIgnoreCase)) { return $resolved }
    if ($resolved.EndsWith(".xlsx", [System.StringComparison]::OrdinalIgnoreCase)) {
        return [System.Text.RegularExpressions.Regex]::Replace($resolved, "\.xlsx$", ".codex-input.json", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    }
    return $resolved
}

function Load-RulesDocument {
    if (-not (Test-Path -LiteralPath $rulesPath -PathType Leaf)) {
        return [pscustomobject]@{ schema = "opiu-reconciliation-rules-v1"; updated_at = $null; rules = @() }
    }
    $doc = Get-Content -LiteralPath $rulesPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($doc.PSObject.Properties.Name -notcontains "rules") { $doc | Add-Member -NotePropertyName rules -NotePropertyValue @() }
    return $doc
}

function Save-RulesDocument {
    param([object[]]$Rules)
    $directory = Split-Path -Parent $rulesPath
    if (-not (Test-Path -LiteralPath $directory)) { [void](New-Item -ItemType Directory -Path $directory -Force) }
    $doc = [pscustomobject]@{
        schema = "opiu-reconciliation-rules-v1"
        updated_at = (Get-Date).ToUniversalTime().ToString("o")
        rules = @($Rules | Sort-Object organization, source_code, source_article, rule_id)
    }
    $json = $doc | ConvertTo-Json -Depth 18
    [System.IO.File]::WriteAllText($rulesPath, $json, (New-Object System.Text.UTF8Encoding -ArgumentList $true))
}

function Get-RuleKey {
    param([object]$Item)
    $org = [string](Get-OptionalProperty $inputDocument "organization_code" "")
    if ([string]::IsNullOrWhiteSpace($org)) { $org = [string](Get-OptionalProperty $inputDocument "organization" "") }
    $code = [string](Get-OptionalProperty $Item "code" "")
    $article = Normalize-Text (Get-OptionalProperty $Item "intalev_label" "")
    $path = Normalize-Text (@(Get-OptionalProperty $Item "hierarchy_path" @()) -join " / ")
    return "$org|$code|$article|$path"
}

function Find-RuleForItem {
    param([object]$Item)
    $key = Get-RuleKey $Item
    foreach ($rule in @($script:rules)) {
        if ([string](Get-OptionalProperty $rule "match_key" "") -eq $key) { return $rule }
    }
    $orgCode = [string](Get-OptionalProperty $inputDocument "organization_code" "")
    $code = [string](Get-OptionalProperty $Item "code" "")
    foreach ($rule in @($script:rules)) {
        if ([string](Get-OptionalProperty $rule "organization_code" "") -eq $orgCode -and [string](Get-OptionalProperty $rule "source_code" "") -eq $code) { return $rule }
    }
    return $null
}

function Get-TemplatesForItem {
    param([object]$Item)
    $names = @(
        Normalize-Text (Get-OptionalProperty $Item "intalev_label" ""),
        Normalize-Text (Get-OptionalProperty $Item "erp_label" "")
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    $found = @()
    foreach ($template in @($catalog.approved_templates)) {
        $candidates = @(
            Normalize-Text (Get-OptionalProperty $template "source_article" ""),
            Normalize-Text (Get-OptionalProperty $template "source_detail" ""),
            Normalize-Text (Get-OptionalProperty $template "target_group" ""),
            Normalize-Text (Get-OptionalProperty $template "target_article" "")
        )
        $matched = $false
        foreach ($name in $names) {
            if ($candidates -contains $name) { $matched = $true; break }
        }
        if ($matched) { $found += $template }
    }
    return @($found)
}

function New-DarkButton {
    param([string]$Text, [System.Drawing.Color]$BackColor, [int]$Width = 140, [int]$Height = 38)
    $button = New-Object System.Windows.Forms.Button
    $button.Text = $Text
    $button.Size = New-Object System.Drawing.Size($Width, $Height)
    $button.BackColor = $BackColor
    $button.ForeColor = [System.Drawing.Color]::White
    $button.FlatStyle = "Flat"
    $button.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(75, 104, 135)
    $button.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9)
    return $button
}

if ($SelfTest) {
    if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) { throw "Rule catalog cache is missing: $catalogPath" }
    $test = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string](Get-OptionalProperty $test "schema" "") -ne "opiu-rule-catalog-cache-v1") { throw "Rule catalog schema is invalid." }
    Write-Output "RULES_UI_SELF_TEST=PASS"
    exit 0
}

if ([string]::IsNullOrWhiteSpace($InputPath)) {
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = "Выберите отчёт сверки"
    $dialog.Filter = "Отчёт сверки или данные (*.xlsx;*.codex-input.json)|*.xlsx;*.codex-input.json|Все файлы (*.*)|*.*"
    if ($dialog.ShowDialog() -ne "OK") { exit 0 }
    $InputPath = $dialog.FileName
}

$resolvedInputPath = Resolve-CodexInputPath $InputPath
if (-not (Test-Path -LiteralPath $resolvedInputPath -PathType Leaf)) {
    [System.Windows.Forms.MessageBox]::Show("Не найден файл данных сверки:`r`n$resolvedInputPath", "Настройки правил", "OK", "Warning") | Out-Null
    exit 1
}
if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) {
    [System.Windows.Forms.MessageBox]::Show("Не найден кэш справочников:`r`n$catalogPath", "Настройки правил", "OK", "Warning") | Out-Null
    exit 1
}

$inputDocument = Get-Content -LiteralPath $resolvedInputPath -Raw -Encoding UTF8 | ConvertFrom-Json
$catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
$rulesDocument = Load-RulesDocument
$script:rules = @($rulesDocument.rules)
$inputRows = @($inputDocument.rows | Where-Object { [bool](Get-OptionalProperty $_ "is_discrepancy" $true) } | Sort-Object { [int](Get-OptionalProperty $_ "display_order" 0) })
$script:selectedItem = $null
$script:selectedRule = $null
$script:suppressEditor = $false
$script:initialSelectedCode = $SelectedCode

$dark = [System.Drawing.Color]::FromArgb(9, 28, 47)
$dark2 = [System.Drawing.Color]::FromArgb(16, 43, 67)
$dark3 = [System.Drawing.Color]::FromArgb(27, 58, 86)
$blue = [System.Drawing.Color]::FromArgb(13, 110, 231)
$green = [System.Drawing.Color]::FromArgb(78, 204, 116)
$orange = [System.Drawing.Color]::FromArgb(255, 157, 47)
$red = [System.Drawing.Color]::FromArgb(235, 87, 87)
$light = [System.Drawing.Color]::FromArgb(239, 245, 252)
$muted = [System.Drawing.Color]::FromArgb(169, 191, 214)
$gridLine = [System.Drawing.Color]::FromArgb(54, 83, 112)
$selected = [System.Drawing.Color]::FromArgb(38, 98, 144)

$form = New-Object System.Windows.Forms.Form
$form.Text = "Настройки правил сверки и корректировок"
$form.StartPosition = "CenterScreen"
$form.WindowState = "Maximized"
$form.MinimumSize = New-Object System.Drawing.Size(1200, 760)
$form.BackColor = $dark
$form.Font = New-Object System.Drawing.Font("Segoe UI", 9)

$header = New-Object System.Windows.Forms.Panel
$header.Dock = "Top"
$header.Height = 92
$header.BackColor = $dark2
$form.Controls.Add($header)

$title = New-Object System.Windows.Forms.Label
$title.Text = "Настройки правил: статьи, иерархия и Дт / Кт"
$title.Location = New-Object System.Drawing.Point(24, 15)
$title.Size = New-Object System.Drawing.Size(900, 34)
$title.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 18)
$title.ForeColor = $light
$header.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = "Правила задаются для организации и статьи ОПИУ. Подразделение в ключ правила не входит."
$subtitle.Location = New-Object System.Drawing.Point(26, 52)
$subtitle.Size = New-Object System.Drawing.Size(950, 24)
$subtitle.ForeColor = $muted
$header.Controls.Add($subtitle)

$sourceInfo = New-Object System.Windows.Forms.Label
$sourceInfo.Anchor = "Top,Right"
$sourceInfo.TextAlign = "MiddleRight"
$sourceInfo.Location = New-Object System.Drawing.Point(950, 18)
$sourceInfo.Size = New-Object System.Drawing.Size(500, 52)
$sourceInfo.ForeColor = $muted
$sourceInfo.Text = "ERP-статей: $(@($catalog.erp_articles).Count)   Счетов: $(@($catalog.accounts).Count)`r`nУтвержденных шаблонов: $(@($catalog.approved_templates).Count)"
$header.Controls.Add($sourceInfo)

$body = New-Object System.Windows.Forms.SplitContainer
$body.Dock = "Fill"
$body.Orientation = "Vertical"
$body.SplitterDistance = 610
$body.SplitterWidth = 6
$body.BackColor = $dark
$form.Controls.Add($body)
$body.BringToFront()
$header.BringToFront()

# Левая панель: статьи текущей сверки.
$leftLayout = New-Object System.Windows.Forms.TableLayoutPanel
$leftLayout.Dock = "Fill"
$leftLayout.Padding = New-Object System.Windows.Forms.Padding(12)
$leftLayout.ColumnCount = 1
$leftLayout.RowCount = 3
$leftLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Absolute", 46)))
$leftLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Absolute", 48)))
$leftLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Percent", 100)))
$body.Panel1.Controls.Add($leftLayout)

$leftTitle = New-Object System.Windows.Forms.Label
$leftTitle.Text = "Статьи текущей сверки"
$leftTitle.Dock = "Fill"
$leftTitle.TextAlign = "MiddleLeft"
$leftTitle.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 13)
$leftTitle.ForeColor = $light
$leftLayout.Controls.Add($leftTitle, 0, 0)

$leftToolbar = New-Object System.Windows.Forms.FlowLayoutPanel
$leftToolbar.Dock = "Fill"
$leftToolbar.WrapContents = $false
$leftToolbar.BackColor = $dark2
$leftToolbar.Padding = New-Object System.Windows.Forms.Padding(6, 7, 6, 4)
$leftLayout.Controls.Add($leftToolbar, 0, 1)

$searchBox = New-Object System.Windows.Forms.TextBox
$searchBox.Size = New-Object System.Drawing.Size(285, 30)
$searchBox.BackColor = $dark3
$searchBox.ForeColor = $light
$searchBox.BorderStyle = "FixedSingle"
$leftToolbar.Controls.Add($searchBox)

$ruleFilter = New-Object System.Windows.Forms.ComboBox
$ruleFilter.Size = New-Object System.Drawing.Size(180, 30)
$ruleFilter.DropDownStyle = "DropDownList"
$ruleFilter.BackColor = $dark3
$ruleFilter.ForeColor = $light
[void]$ruleFilter.Items.AddRange(@("Все статьи", "Правило настроено", "Правило не настроено"))
$ruleFilter.SelectedIndex = 0
$leftToolbar.Controls.Add($ruleFilter)

$grid = New-Object System.Windows.Forms.DataGridView
$grid.Dock = "Fill"
$grid.BackgroundColor = $dark
$grid.BorderStyle = "None"
$grid.GridColor = $gridLine
$grid.EnableHeadersVisualStyles = $false
$grid.ColumnHeadersDefaultCellStyle.BackColor = $dark3
$grid.ColumnHeadersDefaultCellStyle.ForeColor = $light
$grid.ColumnHeadersHeight = 42
$grid.RowHeadersVisible = $false
$grid.DefaultCellStyle.BackColor = $dark2
$grid.DefaultCellStyle.ForeColor = $light
$grid.DefaultCellStyle.SelectionBackColor = $selected
$grid.DefaultCellStyle.SelectionForeColor = [System.Drawing.Color]::White
$grid.AutoGenerateColumns = $false
$grid.AllowUserToAddRows = $false
$grid.AllowUserToDeleteRows = $false
$grid.ReadOnly = $true
$grid.SelectionMode = "FullRowSelect"
$grid.MultiSelect = $false
$leftLayout.Controls.Add($grid, 0, 2)

function Add-LeftColumn {
    param([string]$Name, [string]$Header, [int]$Width, [string]$AutoSizeMode = "None")
    $column = New-Object System.Windows.Forms.DataGridViewTextBoxColumn
    $column.Name = $Name; $column.HeaderText = $Header; $column.Width = $Width; $column.AutoSizeMode = $AutoSizeMode
    $column.SortMode = "NotSortable"
    [void]$grid.Columns.Add($column)
}
Add-LeftColumn "rule_status" "Правило" 112
Add-LeftColumn "code" "Код" 68
Add-LeftColumn "article" "Статья ОПИУ" 250 "Fill"
Add-LeftColumn "erp" "Статья ERP в сверке" 210 "Fill"
Add-LeftColumn "delta" "Расхождение" 120
Add-LeftColumn "key" "Ключ" 40
$grid.Columns["key"].Visible = $false
$grid.Columns["delta"].DefaultCellStyle.Alignment = "MiddleRight"
$grid.Columns["delta"].DefaultCellStyle.Format = "N2"

# Правая панель: раскрытая карточка правила.
$right = New-Object System.Windows.Forms.Panel
$right.Dock = "Fill"
$right.Padding = New-Object System.Windows.Forms.Padding(14)
$right.BackColor = $dark
$body.Panel2.Controls.Add($right)

$editor = New-Object System.Windows.Forms.TableLayoutPanel
$editor.Dock = "Fill"
$editor.ColumnCount = 4
$editor.RowCount = 15
$editor.BackColor = $dark2
$editor.Padding = New-Object System.Windows.Forms.Padding(14)
$editor.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle("Absolute", 190)))
$editor.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle("Percent", 50)))
$editor.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle("Absolute", 180)))
$editor.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle("Percent", 50)))
$editor.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Absolute", 48)))
for ($i = 1; $i -le 12; $i++) { $editor.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Absolute", 48))) }
$editor.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Percent", 100)))
$editor.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Absolute", 56)))
$right.Controls.Add($editor)

$editorTitle = New-Object System.Windows.Forms.Label
$editorTitle.Text = "Выберите статью слева"
$editorTitle.Dock = "Fill"
$editorTitle.TextAlign = "MiddleLeft"
$editorTitle.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 14)
$editorTitle.ForeColor = $light
$editor.Controls.Add($editorTitle, 0, 0)
$editor.SetColumnSpan($editorTitle, 4)

function Add-Label {
    param([string]$Text, [int]$Row, [int]$Column)
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $Text
    $label.Dock = "Fill"
    $label.TextAlign = "MiddleLeft"
    $label.ForeColor = $muted
    $editor.Controls.Add($label, $Column, $Row)
    return $label
}
function New-RuleTextBox {
    param([bool]$ReadOnly = $false, [bool]$Multiline = $false)
    $box = New-Object System.Windows.Forms.TextBox
    $box.Dock = "Fill"
    $box.ReadOnly = $ReadOnly
    $box.Multiline = $Multiline
    $box.BackColor = if ($ReadOnly) { $dark } else { $dark3 }
    $box.ForeColor = $light
    $box.BorderStyle = "FixedSingle"
    return $box
}
function New-RuleCombo {
    param([bool]$Editable = $true)
    $combo = New-Object System.Windows.Forms.ComboBox
    $combo.Dock = "Fill"
    $combo.DropDownStyle = if ($Editable) { "DropDown" } else { "DropDownList" }
    $combo.BackColor = $dark3
    $combo.ForeColor = $light
    if ($Editable) { $combo.AutoCompleteMode = "SuggestAppend"; $combo.AutoCompleteSource = "ListItems" }
    return $combo
}

Add-Label "Статья Инталев по справочнику" 1 0 | Out-Null
$intalevArticleCombo = New-RuleCombo $true
$intalevArticleCombo.DisplayMember = "display"
$editor.Controls.Add($intalevArticleCombo, 1, 1)
$editor.SetColumnSpan($intalevArticleCombo, 3)
foreach ($article in @($catalog.intalev_articles | Sort-Object name, code)) { [void]$intalevArticleCombo.Items.Add($article) }

Add-Label "Иерархия Инталев" 2 0 | Out-Null
$sourcePathBox = New-RuleTextBox $true
$editor.Controls.Add($sourcePathBox, 1, 2)
$editor.SetColumnSpan($sourcePathBox, 3)

Add-Label "Шаблон из утвержденного справочника" 3 0 | Out-Null
$templateCombo = New-RuleCombo $false
$templateCombo.DisplayMember = "_display"
$editor.Controls.Add($templateCombo, 1, 3)
$editor.SetColumnSpan($templateCombo, 2)
$applyTemplateButton = New-DarkButton "Применить шаблон" $blue 165 36
$applyTemplateButton.Dock = "Fill"
$editor.Controls.Add($applyTemplateButton, 3, 3)

Add-Label "Статья ERP" 4 0 | Out-Null
$erpArticleCombo = New-RuleCombo $true
$erpArticleCombo.DisplayMember = "display"
$editor.Controls.Add($erpArticleCombo, 1, 4)
$editor.SetColumnSpan($erpArticleCombo, 3)
foreach ($article in @($catalog.erp_articles | Sort-Object name, code)) { [void]$erpArticleCombo.Items.Add($article) }

Add-Label "Код ERP" 5 0 | Out-Null
$erpCodeBox = New-RuleTextBox $true
$editor.Controls.Add($erpCodeBox, 1, 5)
Add-Label "Группа раскрытия" 5 2 | Out-Null
$groupBox = New-RuleTextBox $true
$editor.Controls.Add($groupBox, 3, 5)

Add-Label "Иерархическая папка ERP" 6 0 | Out-Null
$hierarchyBox = New-RuleTextBox $true
$editor.Controls.Add($hierarchyBox, 1, 6)
$editor.SetColumnSpan($hierarchyBox, 3)

Add-Label "Вариант корректировки" 7 0 | Out-Null
$methodCombo = New-RuleCombo $false
[void]$methodCombo.Items.AddRange(@("Начисление", "Подотчет", "Передача по сверке (ВГО)", "Ручное правило"))
$methodCombo.SelectedIndex = 3
$editor.Controls.Add($methodCombo, 1, 7)
Add-Label "Правило активно" 7 2 | Out-Null
$activeCheck = New-Object System.Windows.Forms.CheckBox
$activeCheck.Text = "Использовать при формировании модели"
$activeCheck.Dock = "Fill"
$activeCheck.Checked = $true
$activeCheck.ForeColor = $light
$editor.Controls.Add($activeCheck, 3, 7)

Add-Label "Дебет" 8 0 | Out-Null
$debitCombo = New-RuleCombo $true
$debitCombo.DisplayMember = "display"
$editor.Controls.Add($debitCombo, 1, 8)
Add-Label "Кредит" 8 2 | Out-Null
$creditCombo = New-RuleCombo $true
$creditCombo.DisplayMember = "display"
$editor.Controls.Add($creditCombo, 3, 8)
foreach ($account in @($catalog.accounts | Sort-Object code)) { [void]$debitCombo.Items.Add($account); [void]$creditCombo.Items.Add($account) }

Add-Label "Аналитика 1" 9 0 | Out-Null
$analytic1Box = New-RuleTextBox $false
$editor.Controls.Add($analytic1Box, 1, 9)
Add-Label "Аналитика 2" 9 2 | Out-Null
$analytic2Box = New-RuleTextBox $false
$editor.Controls.Add($analytic2Box, 3, 9)

Add-Label "Функциональное направление" 10 0 | Out-Null
$functionalBox = New-RuleTextBox $true
$editor.Controls.Add($functionalBox, 1, 10)
Add-Label "Статья ДДС" 10 2 | Out-Null
$cashFlowBox = New-RuleTextBox $true
$editor.Controls.Add($cashFlowBox, 3, 10)

Add-Label "Комментарий к правилу" 11 0 | Out-Null
$commentBox = New-RuleTextBox $false $true
$editor.Controls.Add($commentBox, 1, 11)
$editor.SetColumnSpan($commentBox, 3)

Add-Label "Источник и область действия" 12 0 | Out-Null
$scopeBox = New-RuleTextBox $true
$editor.Controls.Add($scopeBox, 1, 12)
$editor.SetColumnSpan($scopeBox, 3)

$detailHint = New-Object System.Windows.Forms.Label
$detailHint.Dock = "Fill"
$detailHint.ForeColor = $muted
$detailHint.Text = "Выберите статью Инталев и соответствующую статью ERP из справочников. Для ERP автоматически показываются группа раскрытия и полный путь. Дт и Кт можно выбрать из плана счетов или ввести вручную. Правило применяется ко всем периодам выбранной организации."
$editor.Controls.Add($detailHint, 0, 13)
$editor.SetColumnSpan($detailHint, 4)

$buttons = New-Object System.Windows.Forms.FlowLayoutPanel
$buttons.Dock = "Fill"
$buttons.FlowDirection = "RightToLeft"
$buttons.WrapContents = $false
$editor.Controls.Add($buttons, 0, 14)
$editor.SetColumnSpan($buttons, 4)
$saveRuleButton = New-DarkButton "Сохранить правило" $blue 180 40
$deleteRuleButton = New-DarkButton "Удалить правило" $red 160 40
$clearRuleButton = New-DarkButton "Очистить форму" $dark3 150 40
$buttons.Controls.Add($saveRuleButton)
$buttons.Controls.Add($deleteRuleButton)
$buttons.Controls.Add($clearRuleButton)

function Get-SelectedComboObject {
    param([System.Windows.Forms.ComboBox]$Combo)
    if ($null -ne $Combo.SelectedItem) { return $Combo.SelectedItem }
    $typed = Normalize-Text $Combo.Text
    foreach ($item in @($Combo.Items)) {
        $display = Normalize-Text (Get-OptionalProperty $item "display" "")
        $code = Normalize-Text (Get-OptionalProperty $item "code" "")
        $name = Normalize-Text (Get-OptionalProperty $item "name" "")
        if ($typed -eq $display -or $typed -eq $code -or $typed -eq $name) { return $item }
    }
    return $null
}

function Set-AccountComboValue {
    param([System.Windows.Forms.ComboBox]$Combo, [string]$AccountCode)
    $Combo.SelectedIndex = -1
    $Combo.Text = $AccountCode
    $target = Normalize-Text $AccountCode
    foreach ($item in @($Combo.Items)) {
        if ((Normalize-Text (Get-OptionalProperty $item "code" "")) -eq $target) { $Combo.SelectedItem = $item; return }
    }
}


function Set-IntalevArticleValue {
    param([string]$Code, [string]$Name)
    $intalevArticleCombo.SelectedIndex = -1
    $targetCode = Normalize-Text $Code
    $targetName = Normalize-Text $Name
    foreach ($item in @($intalevArticleCombo.Items)) {
        if (($targetCode -and (Normalize-Text (Get-OptionalProperty $item "code" "")) -eq $targetCode) -or ($targetName -and (Normalize-Text (Get-OptionalProperty $item "name" "")) -eq $targetName)) {
            $intalevArticleCombo.SelectedItem = $item
            return
        }
    }
    $intalevArticleCombo.Text = $Name
}

function Update-IntalevDetails {
    $article = Get-SelectedComboObject $intalevArticleCombo
    if ($null -eq $article) {
        if ($null -ne $script:selectedItem) {
            $sourcePathBox.Text = @(Get-OptionalProperty $script:selectedItem "hierarchy_path" @()) -join " / "
        } else {
            $sourcePathBox.Text = ""
        }
        return
    }
    $sourcePathBox.Text = [string](Get-OptionalProperty $article "hierarchy_path" "")
}

function Set-ErpArticleValue {
    param([string]$Code, [string]$Name)
    $erpArticleCombo.SelectedIndex = -1
    $targetCode = Normalize-Text $Code
    $targetName = Normalize-Text $Name
    foreach ($item in @($erpArticleCombo.Items)) {
        if (($targetCode -and (Normalize-Text (Get-OptionalProperty $item "code" "")) -eq $targetCode) -or ($targetName -and (Normalize-Text (Get-OptionalProperty $item "name" "")) -eq $targetName)) {
            $erpArticleCombo.SelectedItem = $item
            return
        }
    }
    $erpArticleCombo.Text = $Name
}

function Update-ErpDetails {
    $article = Get-SelectedComboObject $erpArticleCombo
    if ($null -eq $article) {
        $erpCodeBox.Text = ""
        $groupBox.Text = ""
        $hierarchyBox.Text = ""
        $functionalBox.Text = ""
        $cashFlowBox.Text = ""
        return
    }
    $erpCodeBox.Text = [string](Get-OptionalProperty $article "code" "")
    $groupBox.Text = [string](Get-OptionalProperty $article "group_disclosure" "")
    $hierarchyBox.Text = [string](Get-OptionalProperty $article "hierarchy_path" "")
    $functionalBox.Text = [string](Get-OptionalProperty $article "functional_direction" "")
    $cashFlowBox.Text = [string](Get-OptionalProperty $article "cash_flow_article" "")
}

function Apply-Template {
    param([object]$Template)
    if ($null -eq $Template) { return }
    Set-ErpArticleValue ([string](Get-OptionalProperty $Template "erp_article_code" "")) ([string](Get-OptionalProperty $Template "target_article" ""))
    Update-ErpDetails
    $analytic1Box.Text = [string](Get-OptionalProperty $Template "analytic_1" "")
    $analytic2Box.Text = [string](Get-OptionalProperty $Template "analytic_2" "")
    $commentBox.Text = [string](Get-OptionalProperty $Template "comment" "")
    $pairs = Get-OptionalProperty $Template "account_pairs" $null
    $chosenMethod = "Ручное правило"
    $debit = ""; $credit = ""
    if ($null -ne $pairs) {
        $accrual = Get-OptionalProperty $pairs "accrual" $null
        $advance = Get-OptionalProperty $pairs "advance_report" $null
        $intercompany = Get-OptionalProperty $pairs "intercompany" $null
        if (-not [string]::IsNullOrWhiteSpace([string](Get-OptionalProperty $accrual "debit" "")) -or -not [string]::IsNullOrWhiteSpace([string](Get-OptionalProperty $accrual "credit" ""))) {
            $chosenMethod = "Начисление"; $debit = [string]$accrual.debit; $credit = [string]$accrual.credit
        } elseif (-not [string]::IsNullOrWhiteSpace([string](Get-OptionalProperty $advance "debit" "")) -or -not [string]::IsNullOrWhiteSpace([string](Get-OptionalProperty $advance "credit" ""))) {
            $chosenMethod = "Подотчет"; $debit = [string]$advance.debit; $credit = [string]$advance.credit
        } elseif (-not [string]::IsNullOrWhiteSpace([string](Get-OptionalProperty $intercompany "debit" "")) -or -not [string]::IsNullOrWhiteSpace([string](Get-OptionalProperty $intercompany "credit" ""))) {
            $chosenMethod = "Передача по сверке (ВГО)"; $debit = [string]$intercompany.debit; $credit = [string]$intercompany.credit
        }
    }
    $methodCombo.SelectedItem = $chosenMethod
    Set-AccountComboValue $debitCombo $debit
    Set-AccountComboValue $creditCombo $credit
}

function Clear-Editor {
    $script:suppressEditor = $true
    try {
        $script:selectedRule = $null
        $intalevArticleCombo.SelectedIndex = -1; $intalevArticleCombo.Text = ""
        $sourcePathBox.Text = ""
        $templateCombo.Items.Clear()
        $erpArticleCombo.SelectedIndex = -1; $erpArticleCombo.Text = ""
        $erpCodeBox.Text = ""; $groupBox.Text = ""; $hierarchyBox.Text = ""
        $functionalBox.Text = ""; $cashFlowBox.Text = ""
        $methodCombo.SelectedIndex = 3
        Set-AccountComboValue $debitCombo ""
        Set-AccountComboValue $creditCombo ""
        $analytic1Box.Text = ""; $analytic2Box.Text = ""; $commentBox.Text = ""
        $activeCheck.Checked = $true
        $scopeBox.Text = ""
        $editorTitle.Text = "Выберите статью слева"
    } finally { $script:suppressEditor = $false }
}

function Load-ItemIntoEditor {
    param([object]$Item)
    if ($null -eq $Item) { Clear-Editor; return }
    $script:suppressEditor = $true
    try {
        $script:selectedItem = $Item
        $script:selectedRule = Find-RuleForItem $Item
        $editorTitle.Text = "[$([string](Get-OptionalProperty $Item 'code' ''))] $([string](Get-OptionalProperty $Item 'intalev_label' ''))"
        $scopeBox.Text = "Строка сверки: $([string](Get-OptionalProperty $Item 'intalev_label' '')) | Организация: $([string](Get-OptionalProperty $inputDocument 'organization' '')) | Все периоды | Подразделения игнорируются"
        $templateCombo.Items.Clear()
        foreach ($template in @(Get-TemplatesForItem $Item)) {
            $display = "$([string](Get-OptionalProperty $template 'target_group' '')) → $([string](Get-OptionalProperty $template 'target_article' ''))"
            if (-not [string]::IsNullOrWhiteSpace([string](Get-OptionalProperty $template "erp_article_code" ""))) { $display += " [$([string]$template.erp_article_code)]" }
            $template | Add-Member -Force -NotePropertyName _display -NotePropertyValue $display
            [void]$templateCombo.Items.Add($template)
        }
        if ($templateCombo.Items.Count -gt 0) { $templateCombo.SelectedIndex = 0 }

        Set-IntalevArticleValue "" ([string](Get-OptionalProperty $Item "intalev_label" ""))
        Update-IntalevDetails
        if ($null -ne $script:selectedRule) {
            $storedIntalevName = [string](Get-OptionalProperty $script:selectedRule "intalev_article_name" "")
            if ([string]::IsNullOrWhiteSpace($storedIntalevName)) { $storedIntalevName = [string](Get-OptionalProperty $Item "intalev_label" "") }
            Set-IntalevArticleValue ([string](Get-OptionalProperty $script:selectedRule "intalev_article_code" "")) $storedIntalevName
            Update-IntalevDetails
            Set-ErpArticleValue ([string](Get-OptionalProperty $script:selectedRule "erp_article_code" "")) ([string](Get-OptionalProperty $script:selectedRule "erp_article_name" ""))
            Update-ErpDetails
            $methodCombo.SelectedItem = [string](Get-OptionalProperty $script:selectedRule "correction_method" "Ручное правило")
            Set-AccountComboValue $debitCombo ([string](Get-OptionalProperty $script:selectedRule "debit_account" ""))
            Set-AccountComboValue $creditCombo ([string](Get-OptionalProperty $script:selectedRule "credit_account" ""))
            $analytic1Box.Text = [string](Get-OptionalProperty $script:selectedRule "analytic_1" "")
            $analytic2Box.Text = [string](Get-OptionalProperty $script:selectedRule "analytic_2" "")
            $commentBox.Text = [string](Get-OptionalProperty $script:selectedRule "comment" "")
            $activeCheck.Checked = [bool](Get-OptionalProperty $script:selectedRule "active" $true)
        } elseif ($templateCombo.Items.Count -gt 0) {
            Apply-Template $templateCombo.Items[0]
        } else {
            Set-ErpArticleValue "" ([string](Get-OptionalProperty $Item "erp_label" ""))
            Update-ErpDetails
            $methodCombo.SelectedIndex = 3
            Set-AccountComboValue $debitCombo ""
            Set-AccountComboValue $creditCombo ""
            $analytic1Box.Text = ""; $analytic2Box.Text = ""; $commentBox.Text = ""; $activeCheck.Checked = $true
        }
    } finally { $script:suppressEditor = $false }
}

function Refresh-Grid {
    $remember = if ($null -ne $script:selectedItem) { Get-RuleKey $script:selectedItem } else { "" }
    $grid.Rows.Clear()
    $query = Normalize-Text $searchBox.Text
    foreach ($item in $inputRows) {
        $rule = Find-RuleForItem $item
        $hasRule = $null -ne $rule
        if ($ruleFilter.SelectedItem -eq "Правило настроено" -and -not $hasRule) { continue }
        if ($ruleFilter.SelectedItem -eq "Правило не настроено" -and $hasRule) { continue }
        $haystack = Normalize-Text (([string](Get-OptionalProperty $item "code" "")) + " " + ([string](Get-OptionalProperty $item "intalev_label" "")) + " " + ([string](Get-OptionalProperty $item "erp_label" "")))
        if ($query -and -not $haystack.Contains($query)) { continue }
        $status = if ($hasRule) { "Настроено" } else { "Нет правила" }
        $index = $grid.Rows.Add($status, [string]$item.code, [string]$item.intalev_label, [string]$item.erp_label, (Get-OptionalProperty $item "delta" $null), (Get-RuleKey $item))
        $row = $grid.Rows[$index]; $row.Tag = $item
        $row.Cells["rule_status"].Style.ForeColor = if ($hasRule) { $green } else { $orange }
        $row.Cells["delta"].Style.ForeColor = $red
    }
    if ($grid.Rows.Count -gt 0) {
        $selectedRow = $null
        if (-not [string]::IsNullOrWhiteSpace($script:initialSelectedCode)) {
            foreach ($row in $grid.Rows) { if ([string]$row.Cells["code"].Value -eq $script:initialSelectedCode) { $selectedRow = $row; break } }
            $script:initialSelectedCode = ""
        }
        if ($null -eq $selectedRow) {
            foreach ($row in $grid.Rows) { if ([string]$row.Cells["key"].Value -eq $remember) { $selectedRow = $row; break } }
        }
        if ($null -eq $selectedRow) { $selectedRow = $grid.Rows[0] }
        $selectedRow.Selected = $true; $grid.CurrentCell = $selectedRow.Cells["article"]
        Load-ItemIntoEditor $selectedRow.Tag
    } else { Clear-Editor }
}

$grid.Add_SelectionChanged({
    if ($grid.SelectedRows.Count -gt 0) { Load-ItemIntoEditor $grid.SelectedRows[0].Tag }
})
$searchBox.Add_TextChanged({ Refresh-Grid })
$ruleFilter.Add_SelectedIndexChanged({ Refresh-Grid })
$intalevArticleCombo.Add_SelectedIndexChanged({ if (-not $script:suppressEditor) { Update-IntalevDetails } })
$intalevArticleCombo.Add_Leave({ if (-not $script:suppressEditor) { Update-IntalevDetails } })
$erpArticleCombo.Add_SelectedIndexChanged({ if (-not $script:suppressEditor) { Update-ErpDetails } })
$erpArticleCombo.Add_Leave({ if (-not $script:suppressEditor) { Update-ErpDetails } })
$applyTemplateButton.Add_Click({ if ($null -ne $templateCombo.SelectedItem) { Apply-Template $templateCombo.SelectedItem } })
$clearRuleButton.Add_Click({ if ($null -ne $script:selectedItem) { $script:selectedRule = $null; Load-ItemIntoEditor $script:selectedItem } })

$saveRuleButton.Add_Click({
    try {
        if ($null -eq $script:selectedItem) { throw "Сначала выберите статью ОПИУ слева." }
        $intalevArticle = Get-SelectedComboObject $intalevArticleCombo
        $erpArticle = Get-SelectedComboObject $erpArticleCombo
        if ($null -eq $intalevArticle) { throw "Выберите статью Инталев из справочника." }
        if ($null -eq $erpArticle) { throw "Выберите статью ERP из справочника, чтобы программа сохранила код, группу раскрытия и иерархическую папку." }
        $ruleId = if ($null -ne $script:selectedRule) { [string](Get-OptionalProperty $script:selectedRule "rule_id" "") } else { [guid]::NewGuid().ToString() }
        $now = (Get-Date).ToUniversalTime().ToString("o")
        $createdAt = if ($null -ne $script:selectedRule) { [string](Get-OptionalProperty $script:selectedRule "created_at" $now) } else { $now }
        $rule = [pscustomobject]@{
            rule_id = $ruleId
            match_key = Get-RuleKey $script:selectedItem
            organization = [string](Get-OptionalProperty $inputDocument "organization" "")
            organization_code = [string](Get-OptionalProperty $inputDocument "organization_code" "")
            scope = "ORGANIZATION_ALL_PERIODS"
            ignore_departments = $true
            source_code = [string](Get-OptionalProperty $script:selectedItem "code" "")
            source_article = [string](Get-OptionalProperty $script:selectedItem "intalev_label" "")
            source_hierarchy_path = @(Get-OptionalProperty $script:selectedItem "hierarchy_path" @()) -join " / "
            intalev_article_code = if ($null -ne $intalevArticle) { [string](Get-OptionalProperty $intalevArticle "code" "") } else { "" }
            intalev_article_name = if ($null -ne $intalevArticle) { [string](Get-OptionalProperty $intalevArticle "name" $intalevArticleCombo.Text) } else { $intalevArticleCombo.Text }
            intalev_hierarchy_path = if ($null -ne $intalevArticle) { [string](Get-OptionalProperty $intalevArticle "hierarchy_path" $sourcePathBox.Text) } else { $sourcePathBox.Text }
            erp_article_code = if ($null -ne $erpArticle) { [string](Get-OptionalProperty $erpArticle "code" $erpCodeBox.Text) } else { $erpCodeBox.Text }
            erp_article_name = if ($null -ne $erpArticle) { [string](Get-OptionalProperty $erpArticle "name" $erpArticleCombo.Text) } else { $erpArticleCombo.Text }
            erp_group_disclosure = $groupBox.Text
            erp_hierarchy_path = $hierarchyBox.Text
            correction_method = [string]$methodCombo.SelectedItem
            debit_account = if ($null -ne (Get-SelectedComboObject $debitCombo)) { [string](Get-OptionalProperty (Get-SelectedComboObject $debitCombo) "code" $debitCombo.Text) } else { $debitCombo.Text }
            credit_account = if ($null -ne (Get-SelectedComboObject $creditCombo)) { [string](Get-OptionalProperty (Get-SelectedComboObject $creditCombo) "code" $creditCombo.Text) } else { $creditCombo.Text }
            analytic_1 = $analytic1Box.Text
            analytic_2 = $analytic2Box.Text
            functional_direction = $functionalBox.Text
            cash_flow_article = $cashFlowBox.Text
            comment = $commentBox.Text
            active = [bool]$activeCheck.Checked
            created_at = $createdAt
            updated_at = $now
        }
        $remaining = @($script:rules | Where-Object { [string](Get-OptionalProperty $_ "rule_id" "") -ne $ruleId -and [string](Get-OptionalProperty $_ "match_key" "") -ne $rule.match_key })
        $script:rules = @($remaining + $rule)
        Save-RulesDocument $script:rules
        $script:selectedRule = $rule
        Refresh-Grid
        [System.Windows.Forms.MessageBox]::Show("Правило сохранено. Оно будет подставляться в корректировочную модель для всех периодов этой организации.", "Правило сохранено", "OK", "Information") | Out-Null
    } catch {
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Правило не сохранено", "OK", "Error") | Out-Null
    }
})

$deleteRuleButton.Add_Click({
    if ($null -eq $script:selectedRule) { return }
    $answer = [System.Windows.Forms.MessageBox]::Show("Удалить правило для выбранной статьи?", "Удаление правила", "YesNo", "Question")
    if ($answer -ne "Yes") { return }
    $id = [string](Get-OptionalProperty $script:selectedRule "rule_id" "")
    $script:rules = @($script:rules | Where-Object { [string](Get-OptionalProperty $_ "rule_id" "") -ne $id })
    Save-RulesDocument $script:rules
    $script:selectedRule = $null
    Refresh-Grid
})

Refresh-Grid

if ($PreviewPath) {
    $form.WindowState = "Normal"
    $form.Size = New-Object System.Drawing.Size(1500, 900)
    $form.Show()
    [System.Windows.Forms.Application]::DoEvents()
    $bitmap = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
    $form.DrawToBitmap($bitmap, (New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
    $directory = Split-Path -Parent $PreviewPath
    if ($directory -and -not (Test-Path -LiteralPath $directory)) { [void](New-Item -ItemType Directory -Path $directory -Force) }
    $bitmap.Save($PreviewPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose(); $form.Close(); exit 0
}

[void]$form.ShowDialog()
