param([Parameter(Mandatory = $true)] [string] $Scenario)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-uninstall.ps1")
$root = Join-Path ([IO.Path]::GetTempPath()) ("agentkib uninstall test " + [Guid]::NewGuid().ToString("N"))
$installation = Join-Path $root "installed app"
$temporary = Join-Path $root "temporary copies"
$executable = Join-Path $installation "AgentKib.exe"
$source = Join-Path $installation "Uninstall AgentKib.exe"
$sentinel = Join-Path $root "user-data-sentinel"
$script:state = @{ now = 0; killed = $false; disposed = $false; launches = @(); snapshots = @(); probes = 0 }
$diagnostics = [ordered]@{}

function Assert-True($Condition, [string] $Message) {
  if (-not $Condition) { throw $Message }
}
function Get-Date { return [DateTime]::UnixEpoch.AddMilliseconds($script:state.now) }
function Start-Sleep { param([int] $Milliseconds) $script:state.now += $Milliseconds }
function Get-AgentKibFileRemovalDiagnostic {
  param([string] $Path)
  $script:state.probes++
  Assert-True ($Path -eq $executable) "The diagnostic must target only the application executable"
  if ($Scenario -eq "diagnostic-failure") { throw "synthetic diagnostic failure" }
  return @{ exists = (Test-Path -LiteralPath $Path); deleteAccessProbe = @{ win32ErrorCode = 32 } }
}
function Start-Process {
  [CmdletBinding()]
  param([string] $FilePath, [string[]] $ArgumentList, [string] $WorkingDirectory, [switch] $PassThru)
  Assert-True (Test-Path -LiteralPath $FilePath) "The copied uninstaller must exist before launch"
  Assert-True ((Get-Content -LiteralPath $FilePath -Raw).Trim() -eq "fixture-uninstaller") "Copy bytes changed"
  $script:state.launches += @{ file = $FilePath; arguments = $ArgumentList; cwd = $WorkingDirectory }
  $process = [pscustomobject]@{ Id = 321; ExitCode = $(if ($Scenario -eq "actual-failure") { 23 } else { 0 }) }
  $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
    param([int] $Timeout)
    if ($script:state.killed) { return $true }
    if ($Scenario -in @("running-timeout", "removed-before-exit", "delayed-termination")) {
      if ($Scenario -eq "removed-before-exit" -and (Test-Path -LiteralPath $executable)) {
        Remove-Item -LiteralPath $executable
      }
      return $false
    }
    if ($script:state.now -lt 1000) { return $false }
    if ($Scenario -notin @("residual", "actual-failure", "diagnostic-failure")) {
      Remove-Item -LiteralPath $executable -ErrorAction SilentlyContinue
    }
    if ($Scenario -eq "user-data-loss") { Remove-Item -LiteralPath $sentinel }
    return $true
  }
  $process | Add-Member -MemberType ScriptProperty -Name HasExited -Value {
    if ($Scenario -eq "delayed-termination") { return $false }
    return $script:state.killed -or ($script:state.now -ge 1000 -and $Scenario -notin @("running-timeout", "removed-before-exit"))
  }
  $process | Add-Member -MemberType ScriptMethod -Name Kill -Value { $script:state.killed = $true }
  $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $script:state.disposed = $true }
  return $process
}

try {
  New-Item -ItemType Directory -Path $installation, $temporary | Out-Null
  Set-Content -LiteralPath $source -Value "fixture-uninstaller"
  Set-Content -LiteralPath $executable -Value "fixture-application"
  Set-Content -LiteralPath $sentinel -Value "preserve"
  if ($Scenario -eq "copy-failure") { Remove-Item -LiteralPath $source }
  if ($Scenario -eq "unsafe-copy-location") { $temporary = $installation }
  $failure = $null
  try {
    Invoke-AgentKibUninstall -UninstallerPath $source -InstallationRoot $installation `
      -ExecutablePath $executable -SentinelPath $sentinel -TemporaryRoot $temporary `
      -Diagnostics $diagnostics -OnSnapshot { param($Stage) $script:state.snapshots += $Stage }
  } catch { $failure = $_.Exception.Message }

  switch ($Scenario) {
    "success" {
      Assert-True (-not $failure) "Successful real uninstaller was rejected: $failure"
      Assert-True (-not (Test-Path -LiteralPath $executable)) "Executable was not removed by the fixture uninstaller"
      Assert-True ((Get-Content -LiteralPath $sentinel).Trim() -eq "preserve") "User data changed"
      Assert-True ($diagnostics.uninstallExitCode -eq 0) "Real exit code was not recorded"
      Assert-True ($script:state.now -eq 1000) "Successful exit should not consume the remaining budget"
      Assert-True ($script:state.probes -eq 0) "A successful uninstall does not require a failure probe"
    }
    "actual-failure" {
      Assert-True ($failure -match "exit code 23") "The actual nonzero exit code was lost: $failure"
      Assert-True ($diagnostics.uninstallExitCode -eq 23) "Exit code must be the real uninstaller's"
      Assert-True ($script:state.now -eq 1000) "A known failure must not wait for file disappearance"
    }
    { $_ -in @("residual", "diagnostic-failure") } {
      Assert-True ($failure -eq "AgentKib.exe remained after uninstall") "The residual executable must still fail: $failure"
      Assert-True ($script:state.now -eq 120000) "The original two-minute budget changed"
      Assert-True (Test-Path -LiteralPath $executable) "The probe must not delete the residual executable to pass"
      if ($Scenario -eq "diagnostic-failure") {
        Assert-True $diagnostics.fileRemovalCollectionFailed "Missing explicit diagnostic failure"
      }
    }
    { $_ -in @("running-timeout", "removed-before-exit", "delayed-termination") } {
      Assert-True ($failure -match "two-minute budget") "The real process must finish within the budget: $failure"
      Assert-True ($script:state.now -eq 120000) "The process budget changed"
      Assert-True $script:state.killed "An owned hanging uninstaller was not terminated"
      Assert-True (-not $diagnostics.Contains("uninstallExitCode")) "A running process has no confirmed exit result"
    }
    "user-data-loss" { Assert-True ($failure -eq "Uninstall unexpectedly removed user data") "User data loss was accepted: $failure" }
    { $_ -in @("copy-failure", "unsafe-copy-location") } {
      Assert-True ($null -ne $failure) "Invalid preparation was accepted"
      Assert-True ($script:state.launches.Count -eq 0) "Unsafe or absent copy was launched"
    }
    default { throw "Unknown test scenario" }
  }
  if ($script:state.launches.Count -gt 0) {
    $launch = $script:state.launches[0]
    Assert-True ($script:state.launches.Count -eq 1) "The launcher was executed more than once"
    Assert-True ($launch.file -ne $source) "The self-copying launcher was used"
    Assert-True ($launch.cwd -eq (Split-Path -Parent $launch.file)) "The uninstaller cwd is not the external scratch directory"
    Assert-True ($launch.arguments.Count -eq 2 -and $launch.arguments[0] -eq "/S" -and $launch.arguments[1] -ceq "_?=$installation") "The final NSIS argument was quoted, split or reordered"
    if ($Scenario -eq "delayed-termination") {
      Assert-True $diagnostics.uninstallerCleanupPending "Asynchronous termination was reported as confirmed cleanup"
      Assert-True $diagnostics.uninstallerCleanupFailed "Unconfirmed cleanup was not marked incomplete"
      Assert-True (Test-Path -LiteralPath $launch.cwd) "An unconfirmed executable was removed before exit"
    } else {
      Assert-True (-not (Test-Path -LiteralPath $launch.cwd)) "Owned temporary copy was not cleaned"
    }
    Assert-True $script:state.disposed "The actual process handle was not disposed"
  }
  Write-Output "passed: $Scenario"
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
