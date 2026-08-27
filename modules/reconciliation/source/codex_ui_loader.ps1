param(
    [string]$InputPath,
    [switch]$SelfTest,
    [string]$PreviewPath
)

$ErrorActionPreference = "Stop"
$uiPath = Join-Path $PSScriptRoot "opiu_codex_ui.ps1"
$source = [System.IO.File]::ReadAllText($uiPath, [System.Text.Encoding]::UTF8)
$uiScript = [ScriptBlock]::Create($source)
& $uiScript -AppDir $PSScriptRoot -InputPath $InputPath -SelfTest:$SelfTest -PreviewPath $PreviewPath
exit $LASTEXITCODE
