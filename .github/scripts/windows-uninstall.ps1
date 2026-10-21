# Execute the real NSIS uninstaller, rather than its self-copying launcher.
function Invoke-AgentKibUninstall {
  param(
    [Parameter(Mandatory = $true)] [string] $UninstallerPath,
    [Parameter(Mandatory = $true)] [string] $InstallationRoot,
    [Parameter(Mandatory = $true)] [string] $ExecutablePath,
    [Parameter(Mandatory = $true)] [string] $SentinelPath,
    [Parameter(Mandatory = $true)] [string] $TemporaryRoot,
    [Parameter(Mandatory = $true)] [System.Collections.IDictionary] $Diagnostics,
    [scriptblock] $OnSnapshot = { param($Stage) }
  )

  $uninstall = $null
  $scratch = $null
  $stage = "prepare-uninstaller"
  # The original two-minute budget now covers both execution and observation.
  $deadline = (Get-Date).AddMinutes(2)
  try {
    $installationPath = [IO.Path]::GetFullPath($InstallationRoot)
    $temporaryPath = [IO.Path]::GetFullPath($TemporaryRoot)
    $prefix = $installationPath.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if ($temporaryPath.Equals($installationPath, [StringComparison]::OrdinalIgnoreCase) -or
        $temporaryPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "The uninstaller copy must be outside the installation directory"
    }
    $scratch = Join-Path $temporaryPath ("agentkib-uninstaller-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $scratch -ErrorAction Stop | Out-Null
    $copy = Join-Path $scratch "uninstall.exe"
    Copy-Item -LiteralPath $UninstallerPath -Destination $copy -ErrorAction Stop
    $Diagnostics.uninstallerCopy = $copy
    $Diagnostics.uninstallStartedAt = [DateTime]::UtcNow.ToString("o")
    $stage = "execute-uninstaller"
    # NSIS consumes everything after _?= as the install path. It must be last,
    # without nested quotes, including when that path contains spaces.
    $uninstall = Start-Process -FilePath $copy -ArgumentList @("/S", "_?=$installationPath") `
      -WorkingDirectory $scratch -PassThru -ErrorAction Stop
    $Diagnostics.uninstallPid = $uninstall.Id
    & $OnSnapshot "uninstaller-started" | Out-Null
    while (-not $uninstall.WaitForExit(0)) {
      if ((Get-Date) -ge $deadline) {
        throw "AgentKib uninstaller exceeded the two-minute budget"
      }
      Start-Sleep -Milliseconds 500
    }
    $Diagnostics.uninstallExitCode = $uninstall.ExitCode
    $Diagnostics.uninstallReturnedAt = [DateTime]::UtcNow.ToString("o")
    & $OnSnapshot "uninstaller-returned" | Out-Null
    if ($uninstall.ExitCode -ne 0) {
      throw "AgentKib uninstaller failed with exit code $($uninstall.ExitCode)"
    }

    $stage = "verify-executable-removed"
    while ((Test-Path -LiteralPath $ExecutablePath) -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 500
    }
    if (Test-Path -LiteralPath $ExecutablePath) {
      throw "AgentKib.exe remained after uninstall"
    }
    $stage = "verify-user-data-preserved"
    if (-not (Test-Path -LiteralPath $SentinelPath)) {
      throw "Uninstall unexpectedly removed user data"
    }
  } catch {
    $Diagnostics.failureStage = $stage
    # This probe is read-only: retain the original failure, even if collecting
    # file attributes or the exact file's lock owners is unavailable.
    try {
      $Diagnostics.fileRemoval = Get-AgentKibFileRemovalDiagnostic -Path $ExecutablePath
    } catch {
      $Diagnostics.fileRemovalCollectionFailed = $true
    }
    & $OnSnapshot "uninstaller-failed" | Out-Null
    throw
  } finally {
    try {
      if ($uninstall -and -not $uninstall.HasExited) {
        # This is our temporary copy's process, never an unrelated application.
        $uninstall.Kill()
        $Diagnostics.uninstallerTerminated = $true
      }
      if ($scratch -and (-not $uninstall -or $uninstall.HasExited)) {
        Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction Stop
      } elseif ($scratch) {
        # Kill is asynchronous. Do not mistake a sent termination signal for
        # confirmed cleanup, or spend another wait budget after the timeout.
        $Diagnostics.uninstallerCleanupPending = $true
        $Diagnostics.uninstallerCleanupFailed = $true
      }
    } catch {
      $Diagnostics.uninstallerCleanupFailed = $true
    }
    if ($uninstall) { $uninstall.Dispose() }
  }
}
