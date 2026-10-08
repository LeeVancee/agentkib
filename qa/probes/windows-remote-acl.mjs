// Temporary CI diagnostic: synthetic files only; no key material or user paths are printed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") {
  console.log("Windows remote ACL diagnostic requires Windows.");
  process.exit(0);
}
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "agentkib-acl-")));
const nativePackage = path.resolve("apps/desktop/dist-electron/native/koffi");
const ffi = createRequire(import.meta.url)(nativePackage);
const advapi = ffi.load("advapi32.dll");
const kernel = ffi.load("kernel32.dll");
const convert = advapi.func(
  "__stdcall",
  "ConvertStringSecurityDescriptorToSecurityDescriptorW",
  "int",
  ["str16", "uint", ffi.out(ffi.pointer("void", 2)), "void *"],
);
const set = advapi.func("__stdcall", "SetFileSecurityW", "int", ["str16", "uint", "void *"]);
const free = kernel.func("__stdcall", "LocalFree", "void *", ["void *"]);
const lastError = kernel.func("__stdcall", "GetLastError", "uint", []);
const powershell = path.join(
  process.env.SystemRoot,
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
const script = String.raw`
$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
function Principal-Kind($sid) {
  if ($sid.Value -eq $identity.User.Value) { return 'token-user' }
  if ($sid.Value -eq 'S-1-5-32-544') { return 'administrators' }
  if ($sid.Value -eq 'S-1-5-18') { return 'system' }
  if ($sid.Value -eq 'S-1-3-4') { return 'owner-rights' }
  if ($sid.Value -eq $identity.Owner.Value) { return 'token-default-owner' }
  return 'other'
}
function Inspect-Target {
  try {
    $acl = if ([System.IO.Directory]::Exists($env:AGENTKIB_ACL_TARGET)) {
      [System.IO.Directory]::GetAccessControl($env:AGENTKIB_ACL_TARGET)
    } else {
      [System.IO.File]::GetAccessControl($env:AGENTKIB_ACL_TARGET)
    }
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
    return @{
      ok = $true
      owner = (Principal-Kind $owner)
      ownerMatchesUser = ($owner.Value -eq $identity.User.Value)
      ownerMatchesTokenDefaultOwner = ($owner.Value -eq $identity.Owner.Value)
      protected = $acl.AreAccessRulesProtected
      rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
        @{ principal = (Principal-Kind $_.IdentityReference); rights = [string]$_.FileSystemRights; type = [string]$_.AccessControlType; inherited = $_.IsInherited }
      })
    }
  } catch { return @{ok = $false; errorType = $_.Exception.GetType().Name; hresult = $_.Exception.HResult} }
}
$result = @{
  processArchitecture = $env:PROCESSOR_ARCHITECTURE
  tokenDefaultOwner = (Principal-Kind $identity.Owner)
  administratorEnabled = ([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
  before = (Inspect-Target)
}
if ($env:AGENTKIB_ACL_SET -eq 'true') {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AgentKibAclProbe {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s, uint revision, out IntPtr descriptor, IntPtr size);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool SetFileSecurityW(string file, uint information, IntPtr descriptor);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr value);
}
'@
  $descriptor = [IntPtr]::Zero
  $converted = [AgentKibAclProbe]::ConvertStringSecurityDescriptorToSecurityDescriptorW($env:AGENTKIB_ACL_SDDL, 1, [ref]$descriptor, [IntPtr]::Zero)
  $conversionError = if ($converted) {0} else {[Runtime.InteropServices.Marshal]::GetLastWin32Error()}
  $result.converted = $converted
  $result.conversionError = $conversionError
  if ($converted) {
    try {
      $result.applied = [AgentKibAclProbe]::SetFileSecurityW($env:AGENTKIB_ACL_TARGET, [uint32]2147483652, $descriptor)
      $result.setError = if ($result.applied) {0} else {[Runtime.InteropServices.Marshal]::GetLastWin32Error()}
    } finally { [void][AgentKibAclProbe]::LocalFree($descriptor) }
  }
  $result.after = Inspect-Target
}
$result | ConvertTo-Json -Depth 6 -Compress
`;
function inspect(file, environment, sddl) {
  const result = spawnSync(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: {
        ...environment,
        AGENTKIB_ACL_TARGET: file,
        AGENTKIB_ACL_SET: sddl ? "true" : "false",
        AGENTKIB_ACL_SDDL: sddl ?? "",
      },
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    },
  );
  if (result.status !== 0)
    return { probeFailed: true, status: result.status, code: result.error?.code };
  try {
    return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
  } catch {
    return { probeFailed: true, reason: "non-json-output" };
  }
}
function apply(file, directory, information) {
  const descriptor = [null];
  const converted = convert(
    directory ? "D:P(A;OICI;FA;;;OW)" : "D:P(A;;FA;;;OW)",
    1,
    descriptor,
    null,
  );
  const conversionError = converted ? 0 : lastError();
  if (!converted || !descriptor[0]) return { converted, conversionError };
  const applied = set(file, information, descriptor[0]);
  const setError = applied ? 0 : lastError();
  free(descriptor[0]);
  return { information, converted, applied, setError, errorAfterFree: applied ? 0 : lastError() };
}
const results = [];
try {
  for (const environmentName of ["original", "isolated-home"]) {
    const environment =
      environmentName === "original"
        ? process.env
        : { ...process.env, HOME: root, USERPROFILE: root };
    for (const api of ["koffi", "koffi-unsigned", "pinvoke"]) {
      const isKoffi = api.startsWith("koffi");
      const information = api === "koffi-unsigned" ? 0x80000004 : 0x00000004 | 0x80000000;
      const directory = path.join(root, `${environmentName}-${api}`);
      fs.mkdirSync(directory, { mode: 0o700 });
      const before = inspect(directory, environment);
      const first = isKoffi
        ? apply(directory, true, information)
        : inspect(directory, environment, "D:P(A;OICI;FA;;;OW)");
      const after = inspect(directory, environment);
      const second = isKoffi
        ? apply(directory, true, information)
        : inspect(directory, environment, "D:P(A;OICI;FA;;;OW)");
      const file = path.join(directory, "synthetic.txt");
      let descriptor;
      let opened, closed, fileBefore;
      try {
        descriptor = fs.openSync(file, "wx", 0o600);
        fs.writeSync(descriptor, "synthetic");
        fileBefore = inspect(file, environment);
        opened = isKoffi
          ? apply(file, false, information)
          : inspect(file, environment, "D:P(A;;FA;;;OW)");
        fs.closeSync(descriptor);
        descriptor = undefined;
        closed = isKoffi
          ? apply(file, false, information)
          : inspect(file, environment, "D:P(A;;FA;;;OW)");
      } catch (error) {
        opened = { fsError: error.code };
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
      results.push({
        api,
        environmentName,
        before,
        first,
        after,
        second,
        fileBefore,
        opened,
        closed,
      });
    }
  }
  console.log(
    JSON.stringify(
      { platform: process.platform, arch: process.arch, node: process.version, results },
      null,
      2,
    ),
  );
} finally {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (error) {
    console.log(JSON.stringify({ cleanupError: error.code }));
  }
}
// A diagnostic never replaces the normal native smoke or changes a product assertion.
