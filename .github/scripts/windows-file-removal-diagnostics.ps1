# Read-only diagnostics for one installer-owned path. In particular, a successful
# DELETE access probe never marks the file for deletion or changes its attributes.
function Initialize-AgentKibFileRemovalNative {
  if ("AgentKib.FileRemovalDiagnosticNative" -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace AgentKib {
  [StructLayout(LayoutKind.Sequential)]
  public struct RemovalUniqueProcess {
    public uint ProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct RemovalProcessInfo {
    public RemovalUniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
    public string ApplicationName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
    public string ServiceShortName;
    public uint ApplicationType;
    public uint AppStatus;
    public uint SessionId;
    [MarshalAs(UnmanagedType.Bool)]
    public bool Restartable;
  }

  public sealed class RemovalDeleteProbe {
    public bool Succeeded;
    public int Win32ErrorCode;
    public int CloseHandleErrorCode;
  }

  public static class FileRemovalDiagnosticNative {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    public static extern uint GetFileAttributesW(string path);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr CreateFileW(string path, uint desiredAccess, uint shareMode,
      IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    public static RemovalDeleteProbe ProbeDeleteAccess(string path) {
      // DELETE, all sharing modes, OPEN_EXISTING, OPEN_REPARSE_POINT and
      // BACKUP_SEMANTICS. No DELETE_ON_CLOSE, truncate, write or delete call.
      IntPtr handle = CreateFileW(path, 0x00010000, 7, IntPtr.Zero, 3,
        0x00200000 | 0x02000000, IntPtr.Zero);
      if (handle == new IntPtr(-1)) {
        return new RemovalDeleteProbe { Win32ErrorCode = Marshal.GetLastWin32Error() };
      }
      bool closed = CloseHandle(handle);
      int closeError = closed ? 0 : Marshal.GetLastWin32Error();
      return new RemovalDeleteProbe { Succeeded = true, CloseHandleErrorCode = closeError };
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern uint RmStartSession(out uint handle, uint flags, StringBuilder key);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern uint RmRegisterResources(uint handle, uint fileCount,
      [In] string[] files, uint applicationCount, IntPtr applications,
      uint serviceCount, IntPtr services);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern uint RmGetList(uint handle, out uint needed, ref uint count,
      [In, Out] RemovalProcessInfo[] processes, out uint rebootReasons);

    [DllImport("rstrtmgr.dll", ExactSpelling = true)]
    public static extern uint RmEndSession(uint handle);
  }
}
'@ -ErrorAction Stop | Out-Null
}

function Test-AgentKibFileRemovalWindows {
  return [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
    [Runtime.InteropServices.OSPlatform]::Windows)
}

# Keep the native boundary small so the same collection/error paths can be
# exercised with deterministic API results on hosts without Win32 APIs.
function Invoke-AgentKibFileRemovalNative {
  param([string] $Operation, [hashtable] $Arguments)
  Initialize-AgentKibFileRemovalNative
  switch ($Operation) {
    "attributes" {
      $attributes = [AgentKib.FileRemovalDiagnosticNative]::GetFileAttributesW($Arguments.path)
      $errorCode = if ($attributes -eq [uint32]::MaxValue) {
        [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      } else { 0 }
      return @{ attributes = $attributes; errorCode = $errorCode }
    }
    "deleteAccess" {
      $probe = [AgentKib.FileRemovalDiagnosticNative]::ProbeDeleteAccess($Arguments.path)
      return @{
        succeeded = $probe.Succeeded
        errorCode = $probe.Win32ErrorCode
        closeErrorCode = $probe.CloseHandleErrorCode
      }
    }
    "startSession" {
      [uint32] $handle = 0
      $key = New-Object Text.StringBuilder 33
      $errorCode = [AgentKib.FileRemovalDiagnosticNative]::RmStartSession([ref] $handle, 0, $key)
      return @{ errorCode = $errorCode; handle = $handle }
    }
    "registerResource" {
      $errorCode = [AgentKib.FileRemovalDiagnosticNative]::RmRegisterResources(
        $Arguments.handle, 1, [string[]] @($Arguments.path), 0, [IntPtr]::Zero, 0, [IntPtr]::Zero)
      return @{ errorCode = $errorCode }
    }
    "getList" {
      [uint32] $needed = 0
      [uint32] $count = $Arguments.capacity
      [uint32] $rebootReasons = 0
      $processes = if ($count -gt 0) {
        ,([Array]::CreateInstance([AgentKib.RemovalProcessInfo], [int] $count))
      } else { $null }
      $errorCode = [AgentKib.FileRemovalDiagnosticNative]::RmGetList(
        $Arguments.handle, [ref] $needed, [ref] $count, $processes, [ref] $rebootReasons)
      $owners = @()
      if ($errorCode -eq 0) {
        for ($index = 0; $index -lt $count; $index++) {
          $owners += [ordered]@{
            processId = $processes[$index].Process.ProcessId
            applicationName = $processes[$index].ApplicationName
          }
        }
      }
      return @{ errorCode = $errorCode; needed = $needed; owners = $owners }
    }
    "endSession" {
      return @{ errorCode = [AgentKib.FileRemovalDiagnosticNative]::RmEndSession($Arguments.handle) }
    }
    default { throw "Unknown file-removal diagnostic operation" }
  }
}

function Get-AgentKibFileRemovalDiagnostic {
  param([Parameter(Mandatory = $true)][string] $Path)
  $result = [ordered]@{
    path = $Path
    exists = $null
    attributes = $null
    attributesErrorCode = $null
    deleteAccessProbe = [ordered]@{
      attempted = $false
      succeeded = $null
      win32ErrorCode = $null
      closeHandleErrorCode = $null
      collectionFailed = $false
    }
    restartManager = [ordered]@{
      attempted = $false
      startErrorCode = $null
      registerErrorCode = $null
      listErrorCode = $null
      endErrorCode = $null
      listAttempts = 0
      owners = @()
      collectionFailed = $false
    }
    unsupportedPlatform = $false
    collectionFailed = $false
  }
  if (-not (Test-AgentKibFileRemovalWindows)) {
    $result.unsupportedPlatform = $true
    $result.collectionFailed = $true
    return $result
  }

  try {
    $attributes = Invoke-AgentKibFileRemovalNative "attributes" @{ path = $Path }
    $result.attributesErrorCode = $attributes.errorCode
    if ($attributes.errorCode -eq 0) {
      $result.exists = $true
      $result.attributes = $attributes.attributes
    } elseif ($attributes.errorCode -in @(2, 3)) {
      $result.exists = $false
    } else {
      $result.collectionFailed = $true
    }
  } catch { $result.collectionFailed = $true }

  try {
    $result.deleteAccessProbe.attempted = $true
    $probe = Invoke-AgentKibFileRemovalNative "deleteAccess" @{ path = $Path }
    $result.deleteAccessProbe.succeeded = $probe.succeeded
    $result.deleteAccessProbe.win32ErrorCode = $probe.errorCode
    $result.deleteAccessProbe.closeHandleErrorCode = $probe.closeErrorCode
    if ($probe.closeErrorCode -ne 0) {
      $result.deleteAccessProbe.collectionFailed = $true
    }
  } catch { $result.deleteAccessProbe.collectionFailed = $true }

  $sessionStarted = $false
  $sessionHandle = 0
  try {
    $result.restartManager.attempted = $true
    $session = Invoke-AgentKibFileRemovalNative "startSession" @{}
    $result.restartManager.startErrorCode = $session.errorCode
    if ($session.errorCode -eq 0) {
      $sessionStarted = $true
      $sessionHandle = $session.handle
      $registration = Invoke-AgentKibFileRemovalNative "registerResource" @{
        handle = $sessionHandle; path = $Path
      }
      $result.restartManager.registerErrorCode = $registration.errorCode
      if ($registration.errorCode -eq 0) {
        [uint32] $capacity = 0
        # Process ownership can change between calls. Bound both growth retries
        # and allocation; a partial list is never reported as a successful one.
        for ($attempt = 0; $attempt -lt 3; $attempt++) {
          $result.restartManager.listAttempts++
          $list = Invoke-AgentKibFileRemovalNative "getList" @{
            handle = $sessionHandle; capacity = $capacity
          }
          $result.restartManager.listErrorCode = $list.errorCode
          if ($list.errorCode -eq 0) {
            $result.restartManager.owners = @($list.owners | ForEach-Object {
              [ordered]@{ processId = $_.processId; applicationName = $_.applicationName }
            })
            break
          }
          if ($list.errorCode -ne 234 -or $list.needed -le $capacity -or $list.needed -gt 256) { break }
          $capacity = $list.needed
        }
      }
    }
    if ($result.restartManager.startErrorCode -ne 0 -or
        $result.restartManager.registerErrorCode -ne 0 -or
        $result.restartManager.listErrorCode -ne 0) {
      $result.restartManager.collectionFailed = $true
    }
  } catch { $result.restartManager.collectionFailed = $true } finally {
    if ($sessionStarted) {
      try {
        $ended = Invoke-AgentKibFileRemovalNative "endSession" @{ handle = $sessionHandle }
        $result.restartManager.endErrorCode = $ended.errorCode
        if ($ended.errorCode -ne 0) { $result.restartManager.collectionFailed = $true }
      } catch { $result.restartManager.collectionFailed = $true }
    }
  }
  if ($result.deleteAccessProbe.collectionFailed -or $result.restartManager.collectionFailed) {
    $result.collectionFailed = $true
  }
  return $result
}
