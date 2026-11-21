param(
    [switch]$Yes,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'GrigDesk')
)

$ErrorActionPreference = 'Stop'
$architecture = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) {
    $architecture = $env:PROCESSOR_ARCHITEW6432
}
if ($architecture -ne '@@ARCH@@') {
    throw 'Этот комплект предназначен для другой архитектуры Windows.'
}
if (-not $Yes) {
    $answer = Read-Host "Установить окно, локальный сервер и фабрику GrigDesk в $InstallDir? [y/N]"
    if ($answer -notmatch '^(y|yes|д|да)$') {
        exit 1
    }
}

$temporary = Join-Path $env:LOCALAPPDATA ('GrigDesk-setup-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $temporary
try {
    $helper = Join-Path $temporary 'grigdesk-maintenance.exe'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'grigdesk-maintenance.exe') -Destination $helper
    if ((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash -ne '@@HELPER_SHA@@') {
        throw 'Контрольная сумма установщика GrigDesk не совпала.'
    }
    & $helper install $PSScriptRoot $InstallDir
    if ($LASTEXITCODE -ne 0) {
        throw "Установка GrigDesk завершилась с кодом $LASTEXITCODE."
    }
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
