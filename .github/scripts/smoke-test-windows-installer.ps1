param(
  [Parameter(Mandatory = $true)]
  [string] $SearchRoot,
  [switch] $SkipLaunch,
  [switch] $SkipQuota
)

$ErrorActionPreference = "Stop"
$installer = Get-ChildItem -LiteralPath $SearchRoot -Filter "AgentKib_*_windows-*.exe" -File |
  Select-Object -First 1
if (-not $installer) {
  throw "No NSIS installer was found under $SearchRoot"
}

$temporaryRoot = if ($env:RUNNER_TEMP) {
  $env:RUNNER_TEMP
} else {
  [System.IO.Path]::GetTempPath()
}
$installLocation = Join-Path $temporaryRoot "agentkib-installer-smoke-$PID"
if (Test-Path -LiteralPath $installLocation) {
  throw "Smoke-test installation path already exists: $installLocation"
}

function Install-AgentKib {
  $arguments = @("/S", "/D=$installLocation")
  $process = Start-Process -FilePath $installer.FullName -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "AgentKib installer failed with exit code $($process.ExitCode)"
  }
}

Install-AgentKib
$executable = @(
  (Join-Path $installLocation "AgentKib.exe"),
  (Join-Path $installLocation "agentkib.exe"),
  (Join-Path $installLocation "agentkib-desktop.exe")
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $executable) {
  throw "Installed AgentKib executable was not found under $installLocation"
}
if (-not $SkipQuota) {
  $quotaSidecar = @(
    (Join-Path $installLocation "resources\bin\agentkib-quota-sidecar.exe"),
    (Join-Path $installLocation "resources\windows\agentkib-quota-sidecar.exe"),
    (Join-Path $installLocation "windows\agentkib-quota-sidecar.exe")
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $quotaSidecar) {
    throw "The bundled Windows quota collector was not found under $installLocation"
  }
}

if (-not $SkipLaunch) {
  $app = Start-Process -FilePath $executable -PassThru
  Start-Sleep -Seconds 8
  if ($app.HasExited) {
    throw "Installed AgentKib exited during startup with code $($app.ExitCode)"
  }
  Stop-Process -Id $app.Id -Force
  $app.WaitForExit()
}

$dataDirectory = Join-Path $env:LOCALAPPDATA "ai.agentkib"
$sentinel = Join-Path $dataDirectory "ci-upgrade-sentinel"
New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
Set-Content -LiteralPath $sentinel -Value "preserve"

Install-AgentKib
if (-not (Test-Path -LiteralPath $sentinel)) {
  throw "User data was removed by an overwrite installation"
}

$uninstaller = Get-ChildItem -LiteralPath $installLocation -Filter "Uninstall*.exe" -File |
  Select-Object -First 1
if (-not $uninstaller) {
  throw "AgentKib uninstaller was not found"
}
$uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -Wait -PassThru
if ($uninstall.ExitCode -ne 0) {
  throw "AgentKib uninstaller failed with exit code $($uninstall.ExitCode)"
}
if (Test-Path -LiteralPath $executable) {
  throw "AgentKib.exe remained after uninstall"
}
if (-not (Test-Path -LiteralPath $sentinel)) {
  throw "Uninstall unexpectedly removed user data"
}
Remove-Item -LiteralPath $sentinel -Force
Write-Output "AgentKib installer smoke test passed."
