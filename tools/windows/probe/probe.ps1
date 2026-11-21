param(
  [Parameter(Mandatory = $true)][string]$RootfsTar,
  [Parameter(Mandatory = $true)][string]$SeaExe,
  [Parameter(Mandatory = $true)][string]$ConPtyExe,
  [Parameter(Mandatory = $true)][string]$Runner,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$distro = "GrigDeskProbe-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"
$probeDirectory = Join-Path $env:RUNNER_TEMP $distro
$drive = $probeDirectory.Substring(0, 1).ToLowerInvariant()
$linuxDirectory = '/mnt/' + $drive + $probeDirectory.Substring(2).Replace('\', '/')
$lockScript = "$linuxDirectory/flock-probe.sh"
$reportedArch = if ($Runner -eq 'windows-11-arm') { 'arm64' } else { 'x64' }

New-Item -ItemType Directory -Force -Path $OutputDirectory, $probeDirectory | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'flock-probe.sh') $probeDirectory

$seaOk = $false
$seaOutput = & $SeaExe --runtime-info
if ($LASTEXITCODE -eq 0) {
  $sea = $seaOutput | ConvertFrom-Json
  $seaOk = $sea.sea -eq $true -and $sea.platform -eq 'win32' -and $sea.arch -eq $reportedArch
}
$seaOutput | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'sea.json')

$conPty = Start-Process -FilePath $ConPtyExe -PassThru -NoNewWindow
$conPtyExited = $conPty.WaitForExit(25000)
$conPtyOk = $conPtyExited -and $conPty.ExitCode -eq 0
if (!$conPtyExited) {
  Stop-Process -Id $conPty.Id -Force
}
$summary = [ordered]@{
  runner = $Runner
  windowsBuild = (Get-CimInstance Win32_OperatingSystem).Version
  wsl2Available = $false
  stage = 'import'
  seaOk = $seaOk
  conptyOk = $conPtyOk
}
$imported = $false

try {
  # Импорт и первый запуск различаются. Импорт сам по себе не подтверждает доступный WSL2.
  wsl.exe --status
  wsl.exe --version
  wsl.exe --import $distro (Join-Path $probeDirectory 'rootfs') $RootfsTar --version 2
  if ($LASTEXITCODE -ne 0) {
    return
  }
  $imported = $true
  $summary.stage = 'boot'
  $arch = (wsl.exe -d $distro --exec uname -m).Trim()
  if ($LASTEXITCODE -ne 0 -or $arch -notin @('x86_64', 'aarch64')) {
    return
  }
  $summary.wsl2Available = $true
  $summary.stage = 'setup'
  wsl.exe -d $distro --exec apt-get -qq update
  if ($LASTEXITCODE -ne 0) {
    throw 'apt-get update failed in the probe distribution'
  }
  wsl.exe -d $distro --exec env DEBIAN_FRONTEND=noninteractive apt-get -qq install -y util-linux bubblewrap
  if ($LASTEXITCODE -ne 0) {
    throw 'Failed to install probe packages'
  }
  wsl.exe -d $distro --exec useradd -m probe
  if ($LASTEXITCODE -ne 0) {
    throw 'Failed to create the probe user'
  }

  $summary.stage = 'measure'
  $bootId = (wsl.exe -d $distro -u probe --exec cat /proc/sys/kernel/random/boot_id).Trim()
  $uid = [int](wsl.exe -d $distro -u probe --exec id -u)
  wsl.exe -d $distro -u probe --exec flock -n /tmp/grigdesk-probe.lock true
  $flockOk = $LASTEXITCODE -eq 0
  wsl.exe -d $distro -u probe --exec unshare -Ur true
  $usernsOk = $LASTEXITCODE -eq 0
  wsl.exe -d $distro -u probe --exec bwrap --ro-bind / / true
  $bwrapOk = $LASTEXITCODE -eq 0
  $drvfs = wsl.exe -d $distro -u probe --exec bash $lockScript "$linuxDirectory/drvfs.lock"
  $ext4 = wsl.exe -d $distro -u probe --exec bash $lockScript /home/probe/ext4.lock

  $report = [ordered]@{
    format = 1
    runner = $Runner
    windowsBuild = $summary.windowsBuild
    arch = $arch
    wsl2Available = $summary.wsl2Available
    bootId = $bootId
    uid = $uid
    flockOk = $flockOk
    usernsOk = $usernsOk
    bwrapOk = $bwrapOk
    seaOk = $seaOk
    conptyOk = $conPtyOk
    drvfsLock = $drvfs | ConvertFrom-Json
    ext4Lock = $ext4 | ConvertFrom-Json
  }
  $report | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'wsl-report.json')
  $summary.stage = 'complete'
} finally {
  $summary | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'status.json')
  if ($imported) {
    wsl.exe --unregister $distro
  }
}
