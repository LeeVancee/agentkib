param(
  [Parameter(Mandatory = $true)]
  [string] $SearchRoot,
  [switch] $SkipLaunch,
  [switch] $SkipQuota
)

$ErrorActionPreference = "Stop"
$installer = Get-ChildItem -LiteralPath $SearchRoot -Filter "*.exe" -File -Recurse |
  Where-Object { $_.Name -notlike "*.blockmap" -and $_.Name -notlike "uninstaller*.exe" } |
  Select-Object -First 1
if (-not $installer) {
  throw "No NSIS installer was found under $SearchRoot"
}

function Install-AgentKib {
  $process = Start-Process -FilePath $installer.FullName -ArgumentList "/S" -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "AgentKib installer failed with exit code $($process.ExitCode)"
  }
}

function Get-AgentKibInstallLocation {
  $entry = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq "AgentKib" } |
    Select-Object -First 1
  if ($entry.InstallLocation) {
    $installLocation = $entry.InstallLocation.Trim().Trim('"')
    if (Test-Path -LiteralPath $installLocation) {
      return $installLocation
    }
    # A 32-bit NSIS installer launched from a SYSTEM session on Windows ARM64
    # redirects systemprofile from System32 to SysWOW64. Normal user installs
    # do not hit this path, but headless VM smoke tests must follow the redirect.
    $redirected = $installLocation -replace '(?i)\\System32\\config\\systemprofile\\', '\SysWOW64\config\systemprofile\'
    if (Test-Path -LiteralPath $redirected) {
      return $redirected
    }
    return $installLocation
  }
  foreach ($candidate in @(
    (Join-Path $env:LOCALAPPDATA "AgentKib"),
    (Join-Path $env:LOCALAPPDATA "Programs\AgentKib")
  )) {
    if (Test-Path -LiteralPath (Join-Path $candidate "AgentKib.exe")) {
      return $candidate
    }
  }
  throw "AgentKib installation location was not found"
}

Install-AgentKib
$installLocation = Get-AgentKibInstallLocation
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

$uninstaller = Join-Path $installLocation "uninstall.exe"
if (-not (Test-Path -LiteralPath $uninstaller)) {
  throw "AgentKib uninstaller was not found"
}
$uninstall = Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -PassThru
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
