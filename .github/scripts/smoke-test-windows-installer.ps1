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

function Find-AgentKibExecutable {
  $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  $candidateRoots = @(
    $installLocation,
    (Join-Path $env:ProgramFiles "AgentKib")
  )
  if ($programFilesX86) {
    $candidateRoots += (Join-Path $programFilesX86 "AgentKib")
  }

  # A 32-bit NSIS installer running under the Windows ARM64 system profile can
  # redirect System32\config\systemprofile to SysWOW64\config\systemprofile.
  $localAppDataRoots = @($env:LOCALAPPDATA)
  $redirectedLocalAppData = $env:LOCALAPPDATA -replace '(?i)\\System32\\config\\systemprofile\\', '\SysWOW64\config\systemprofile\'
  if ($redirectedLocalAppData -and $redirectedLocalAppData -ne $env:LOCALAPPDATA) {
    $localAppDataRoots += $redirectedLocalAppData
  }
  foreach ($localAppDataRoot in ($localAppDataRoots | Select-Object -Unique)) {
    if ($localAppDataRoot) {
      $candidateRoots += Join-Path $localAppDataRoot "Programs\AgentKib"
      $candidateRoots += Join-Path $localAppDataRoot "AgentKib"
    }
  }

  $uninstallRoots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )
  foreach ($uninstallRoot in $uninstallRoots) {
    $registryLocations = Get-ItemProperty -Path $uninstallRoot -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -eq "AgentKib" -and $_.InstallLocation } |
      Select-Object -ExpandProperty InstallLocation
    foreach ($registryLocation in $registryLocations) {
      $normalizedLocation = $registryLocation.Trim().Trim('"')
      $candidateRoots += $normalizedLocation
      $candidateRoots += $normalizedLocation -replace '(?i)\\System32\\config\\systemprofile\\', '\SysWOW64\config\systemprofile\'
    }
  }

  foreach ($root in ($candidateRoots | Select-Object -Unique)) {
    if ($root -and (Test-Path -LiteralPath $root)) {
      $found = Get-ChildItem -LiteralPath $root -Filter "AgentKib.exe" -File -Recurse |
        Select-Object -First 1
      if ($found) {
        return $found
      }
    }
  }
  return $null
}

function Stop-AgentKibProcesses {
  $stopDeadline = (Get-Date).AddSeconds(15)
  do {
    $runningProcesses = @(Get-Process -Name "AgentKib" -ErrorAction SilentlyContinue)
    if ($runningProcesses.Count -eq 0) {
      return
    }
    $runningProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $stopDeadline)

  $remainingProcessIds = @(Get-Process -Name "AgentKib" -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Id)
  throw "AgentKib processes remained after termination: $($remainingProcessIds -join ', ')"
}

Install-AgentKib
$executable = Find-AgentKibExecutable
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
  $app = Start-Process -FilePath $executable.FullName -PassThru
  Start-Sleep -Seconds 8
  if ($app.HasExited) {
    throw "Installed AgentKib exited during startup with code $($app.ExitCode)"
  }
  Stop-AgentKibProcesses
}

$dataDirectory = Join-Path $env:LOCALAPPDATA "ai.agentkib"
$sentinel = Join-Path $dataDirectory "ci-upgrade-sentinel"
New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
Set-Content -LiteralPath $sentinel -Value "preserve"

Install-AgentKib
if (-not (Test-Path -LiteralPath $sentinel)) {
  throw "User data was removed by an overwrite installation"
}
Stop-AgentKibProcesses

$installationRoot = Split-Path -Parent $executable.FullName
$uninstaller = Get-ChildItem -LiteralPath $installationRoot -Filter "Uninstall*.exe" -File |
  Select-Object -First 1
if (-not $uninstaller) {
  throw "AgentKib uninstaller was not found"
}
$uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -Wait -PassThru
if ($uninstall.ExitCode -ne 0) {
  throw "AgentKib uninstaller failed with exit code $($uninstall.ExitCode)"
}
$uninstallDeadline = (Get-Date).AddSeconds(30)
while ((Test-Path -LiteralPath $executable.FullName) -and (Get-Date) -lt $uninstallDeadline) {
  Start-Sleep -Milliseconds 500
}
if (Test-Path -LiteralPath $executable.FullName) {
  throw "AgentKib.exe remained after uninstall"
}
if (-not (Test-Path -LiteralPath $sentinel)) {
  throw "Uninstall unexpectedly removed user data"
}
Remove-Item -LiteralPath $sentinel -Force
Write-Output "AgentKib installer smoke test passed."
