$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName Microsoft.VisualBasic

$engineDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$engineFile = Join-Path $engineDir 'correction_engine_r001.mjs'
$nodeExe = [string]$env:OPIU_NODE_EXE
if ([string]::IsNullOrWhiteSpace($nodeExe)) {
    $nodeExe = Join-Path $engineDir '..\..\..\runtime\node\node.exe'
}

if (-not (Test-Path -LiteralPath $nodeExe)) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) {
        [System.Windows.Forms.MessageBox]::Show('Встроенный Node.js не найден. Повторно распакуйте полный portable-пакет.', 'Движок корректировок', 'OK', 'Error') | Out-Null
        exit 1
    }
    $nodeExe = $nodeCommand.Source
}

function New-NodeEntrypointContext {
    param([string]$Path)
    $resolved = [IO.Path]::GetFullPath($Path)
    $target = Split-Path -Parent $resolved
    $windowsRoot = [string]$env:SystemRoot
    if ([string]::IsNullOrWhiteSpace($windowsRoot)) { $windowsRoot = 'C:\Windows' }
    $junction = Join-Path (Join-Path $windowsRoot 'Temp') ('OPIU_R001_' + [Guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Junction -Path $junction -Target $target)
    return [pscustomobject]@{ Path = Join-Path $junction ([IO.Path]::GetFileName($resolved)); Junction = $junction }
}

function Remove-NodeEntrypointContext {
    param($Context)
    if ($null -eq $Context) { return }
    $item = Get-Item -LiteralPath ([string]$Context.Junction) -Force -ErrorAction SilentlyContinue
    if ($null -ne $item -and $item.LinkType -eq 'Junction') { [IO.Directory]::Delete([string]$Context.Junction) }
}

$reconciliationDialog = New-Object System.Windows.Forms.OpenFileDialog
$reconciliationDialog.Title = 'Выберите готовую сверку ОПИУ с листом доказанных операций'
$reconciliationDialog.Filter = 'Excel (*.xlsx)|*.xlsx'
$reconciliationDialog.Multiselect = $false
if ($reconciliationDialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
$reconciliationPath = $reconciliationDialog.FileName

$period = [Microsoft.VisualBasic.Interaction]::InputBox('Укажите период в формате ГГГГ-ММ', 'Движок корректировок', '2025-07')
if ([string]::IsNullOrWhiteSpace($period)) { exit 0 }
if ($period -notmatch '^\d{4}-\d{2}$') {
    [System.Windows.Forms.MessageBox]::Show('Период должен иметь формат ГГГГ-ММ, например 2025-07.', 'Движок корректировок', 'OK', 'Warning') | Out-Null
    exit 1
}

$useDecisions = [System.Windows.Forms.MessageBox]::Show(
    'Есть уже проверенный файл «Решения_корректировок_ввод_R001.xlsx»?`r`n`r`nДа — выбрать его.`r`nНет — создать новую форму кандидатов.',
    'Движок корректировок',
    [System.Windows.Forms.MessageBoxButtons]::YesNoCancel,
    [System.Windows.Forms.MessageBoxIcon]::Question
)
if ($useDecisions -eq [System.Windows.Forms.DialogResult]::Cancel) { exit 0 }

$decisionPath = $null
if ($useDecisions -eq [System.Windows.Forms.DialogResult]::Yes) {
    $decisionDialog = New-Object System.Windows.Forms.OpenFileDialog
    $decisionDialog.Title = 'Выберите заполненный файл решений'
    $decisionDialog.Filter = 'Excel или JSON (*.xlsx;*.json)|*.xlsx;*.json'
    $decisionDialog.Multiselect = $false
    if ($decisionDialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
    $decisionPath = $decisionDialog.FileName
}

$outputDialog = New-Object System.Windows.Forms.FolderBrowserDialog
$outputDialog.Description = 'Выберите папку для нового комплекта корректировок'
$suggestedOutput = if (-not [string]::IsNullOrWhiteSpace([string]$env:OPIU_SERVICE_ROOT)) {
    Join-Path $env:OPIU_SERVICE_ROOT 'data\outputs\КОРРЕКТИРОВКИ_R001'
} else {
    Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'OPIU\КОРРЕКТИРОВКИ_R001'
}
if (Test-Path -LiteralPath $suggestedOutput) { $outputDialog.SelectedPath = $suggestedOutput }
if ($outputDialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
$outputPath = $outputDialog.SelectedPath

$entryContext = New-NodeEntrypointContext $engineFile
$arguments = @(
    '--preserve-symlinks-main', $entryContext.Path,
    '--reconciliation', $reconciliationPath,
    '--output', $outputPath,
    '--period', $period
)
if ($null -ne $decisionPath) { $arguments += @('--decisions', $decisionPath) }

try {
    & $nodeExe @arguments
    if ($LASTEXITCODE -ne 0) { throw "Движок завершился с кодом $LASTEXITCODE" }
    [System.Windows.Forms.MessageBox]::Show(
        'Комплект сформирован. Он остается DRAFT/REPORT_ONLY: загрузка в 1С и удаление запрещены до отдельных live-проверок.',
        'Движок корректировок',
        'OK',
        'Information'
    ) | Out-Null
    Start-Process explorer.exe -ArgumentList @($outputPath)
}
catch {
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Ошибка движка корректировок', 'OK', 'Error') | Out-Null
    throw
}
finally { Remove-NodeEntrypointContext $entryContext }
