param(
    [Parameter(Mandatory = $true)]
    [string]$Source,

    [Parameter(Mandatory = $true)]
    [string]$Target
)

$ErrorActionPreference = "Stop"

$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$targetPath = [System.IO.Path]::GetFullPath($Target)
$targetDirectory = [System.IO.Path]::GetDirectoryName($targetPath)

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "Не найден исходный XLS: $sourcePath"
}

if (-not (Test-Path -LiteralPath $targetDirectory -PathType Container)) {
    [void](New-Item -ItemType Directory -Path $targetDirectory -Force)
}

$excel = $null
$workbook = $null
try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $workbook = $excel.Workbooks.Open($sourcePath, 0, $true)
    $workbook.SaveAs($targetPath, 51)
} finally {
    if ($null -ne $workbook) {
        $workbook.Close($false)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($workbook)
    }
    if ($null -ne $excel) {
        $excel.Quit()
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}

Write-Output $targetPath
