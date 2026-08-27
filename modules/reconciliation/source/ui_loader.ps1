param(
    [switch]$SelfTest,
    [string]$PreviewPath,
    [string]$ContextPath,
    [string]$ReadyPath
)

$ErrorActionPreference = "Stop"
$logPath = Join-Path $PSScriptRoot "ui_loader.log"
try {
    Add-Content -LiteralPath $logPath -Encoding UTF8 -Value ("{0:o} START Context={1}" -f [DateTime]::UtcNow, $ContextPath)
    $uiPath = Join-Path $PSScriptRoot "opiu_ui.ps1"
    if (-not (Test-Path -LiteralPath $uiPath -PathType Leaf)) {
        throw "Не найдено рабочее окно R005: $uiPath"
    }
    $source = [System.IO.File]::ReadAllText($uiPath, [System.Text.Encoding]::UTF8)
    $uiScript = [ScriptBlock]::Create($source)
    & $uiScript -AppDir $PSScriptRoot -SelfTest:$SelfTest -PreviewPath $PreviewPath -ContextPath $ContextPath -ReadyPath $ReadyPath
    Add-Content -LiteralPath $logPath -Encoding UTF8 -Value ("{0:o} EXIT Code={1}" -f [DateTime]::UtcNow, $LASTEXITCODE)
    exit $LASTEXITCODE
}
catch {
    $message = "Рабочее окно R005 не открылось.`r`n`r`n$($_.Exception.Message)`r`n`r`nДиагностика: $logPath"
    Add-Content -LiteralPath $logPath -Encoding UTF8 -Value ("{0:o} ERROR {1}`r`n{2}" -f [DateTime]::UtcNow, $_.Exception.Message, $_.ScriptStackTrace)
    if ($ReadyPath) {
        try {
            $readyDirectory = Split-Path -Parent $ReadyPath
            if ($readyDirectory -and -not (Test-Path -LiteralPath $readyDirectory)) { [void](New-Item -ItemType Directory -Path $readyDirectory -Force) }
            [ordered]@{ status = 'ERROR'; module = 'R005'; message = $_.Exception.Message; timestamp = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $ReadyPath -Encoding UTF8
        } catch { }
    }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($message, 'Сверка ОПИУ R005', 'OK', 'Error') | Out-Null
    }
    catch {
        # The log remains available even if the message box cannot be shown.
    }
    exit 1
}
