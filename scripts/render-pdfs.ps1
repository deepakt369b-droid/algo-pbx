# Renders the operator PDF guides from the generated HTML sources.
# Usage:  powershell -File scripts\render-pdfs.ps1
# Requires: Microsoft Edge (preinstalled on Windows). No other installs.
# NOTE: keep this file ASCII-only - Windows PowerShell 5.1 misparses
# UTF-8 files without a BOM.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

$edge = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $edge) { throw "msedge.exe not found - install Edge or adjust the path list." }

$pairs = @(
    @{ html = "docs\pdf1-source.html"; pdf = "docs\1-Deploying-Algo-PBX-on-a-Linux-VM.pdf" },
    @{ html = "docs\pdf2-source.html"; pdf = "docs\2-Configuring-Credentials-Dinstar-and-Going-Live.pdf" }
)

foreach ($p in $pairs) {
    $srcHtml = Join-Path $root $p.html
    $outPdf  = Join-Path $root $p.pdf
    & $edge --headless --disable-gpu --no-pdf-header-footer `
        --print-to-pdf="$outPdf" ("file:///" + ($srcHtml -replace '\\', '/')) | Out-Null
    if (-not (Test-Path $outPdf)) { throw "PDF was not produced: $outPdf" }
    "{0} -> {1} ({2:N0} bytes)" -f $p.html, $p.pdf, (Get-Item $outPdf).Length
}
