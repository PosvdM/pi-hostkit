import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const isWin = process.platform === "win32";
const addonPath = fileURLToPath(new URL("../build/Release/hostkit.node", import.meta.url));
const binding = isWin ? createRequire(import.meta.url)(addonPath) : undefined;
const mutexName = () => `Global\\pi-hostkit-mutex-test-${randomUUID()}`;

function powershell(script, env = {}) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
${script}
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
`, "utf16le").toString("base64")],
    {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, ...env },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

function childNode(code, name) {
  const result = spawnSync(process.execPath, ["-e", code], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, HOSTKIT_TEST_MUTEX: name, HOSTKIT_TEST_ADDON: addonPath },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

describe("Windows native mutex security", { skip: !isWin }, () => {
  test("creation pins the owner to the current user and grants only that SID full control", () => {
    const name = mutexName();
    const handle = binding.mutexAcquire(name);
    assert.ok(handle > 0);
    try {
      const actual = powershell(`
$m = [Threading.Mutex]::OpenExisting($env:HOSTKIT_TEST_MUTEX, [Security.AccessControl.MutexRights]::ReadPermissions)
try {
  $acl = $m.GetAccessControl()
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
    @{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); mask = [int]$_.MutexRights; inherited = $_.IsInherited }
  })
  @{ owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; protected = $acl.AreAccessRulesProtected; rules = $rules } | ConvertTo-Json -Depth 5 -Compress
} finally { $m.Dispose() }
`, { HOSTKIT_TEST_MUTEX: name });
      assert.equal(actual.owner, binding.userSid());
      assert.equal(actual.protected, true);
      assert.deepEqual(actual.rules, [{ sid: binding.userSid(), type: "Allow", mask: 0x1f0001, inherited: false }]);
    } finally {
      binding.mutexRelease(handle);
    }
  });

  test("same-user processes observe contention and can acquire after release", () => {
    const name = mutexName();
    const handle = binding.mutexAcquire(name);
    assert.ok(handle > 0);
    const acquire = `
const binding = require(process.env.HOSTKIT_TEST_ADDON);
const handle = binding.mutexAcquire(process.env.HOSTKIT_TEST_MUTEX);
if (handle > 0) binding.mutexRelease(handle);
console.log(JSON.stringify({ acquired: handle > 0, busy: handle === -1 }));
`;
    try {
      assert.deepEqual(childNode(acquire, name), { acquired: false, busy: true });
    } finally {
      binding.mutexRelease(handle);
    }
    assert.deepEqual(childNode(acquire, name), { acquired: true, busy: false });
  });

  test("an accessible mutex with a real foreign owner is rejected before waiting", (t) => {
    const name = mutexName();
    const challenger = `
const binding = require(process.env.HOSTKIT_TEST_ADDON);
const results = [];
for (let i = 0; i < 16; i++) {
  try {
    const handle = binding.mutexAcquire(process.env.HOSTKIT_TEST_MUTEX);
    if (handle > 0) binding.mutexRelease(handle);
    results.push({ handle });
  } catch (error) {
    results.push({ code: error.code, errno: error.errno, message: error.message });
  }
}
console.log(JSON.stringify(results));
`;
    const actual = powershell(`
# SeRestorePrivilege permits assigning SYSTEM as owner when available. The
# Administrators group can also be a valid owner in an elevated user token.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MutexTestPrivilege {
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct Privileges { public uint Count; public Luid Id; public uint Attributes; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool LookupPrivilegeValue(string system, string name, out Luid id);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref Privileges privileges, uint length, IntPtr previous, IntPtr required);
  public static bool EnableRestore() {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token)) return false;
    try {
      Luid id;
      if (!LookupPrivilegeValue(null, "SeRestorePrivilege", out id)) return false;
      Privileges privileges = new Privileges { Count = 1, Id = id, Attributes = 2 };
      return AdjustTokenPrivileges(token, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero) && Marshal.GetLastWin32Error() == 0;
    } finally { CloseHandle(token); }
  }
}
'@
$restore = [MutexTestPrivilege]::EnableRestore()
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$failures = @()
$m = $null
$owner = $null
foreach ($candidate in @('S-1-5-18', 'S-1-5-32-544')) {
  if ($candidate -eq $current.Value) { continue }
  $security = [Security.AccessControl.MutexSecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner([Security.Principal.SecurityIdentifier]::new($candidate))
  $security.AddAccessRule([Security.AccessControl.MutexAccessRule]::new($current, [Security.AccessControl.MutexRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
  try {
    $created = $false
    $m = [Threading.Mutex]::new($false, $env:HOSTKIT_TEST_MUTEX, [ref]$created, $security)
    if (!$created) { throw 'Test mutex name unexpectedly exists' }
    $owner = $m.GetAccessControl().GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -ne $candidate) { throw "Unexpected owner: $owner" }
    break
  } catch {
    if ($m) { $m.Dispose(); $m = $null }
    $exception = $_.Exception.GetBaseException()
    if ($exception -isnot [UnauthorizedAccessException] -and $exception -isnot [Security.SecurityException] -and $exception.HResult -ne -2147023589) { throw }
    $failures += "$candidate : $($exception.Message)"
  }
}
if (!$m) {
  @{ unavailable = $true; restorePrivilege = $restore; failures = $failures } | ConvertTo-Json -Depth 5 -Compress
} else {
  try {
    # Prove full access independently so EACCES cannot be explained by the DACL.
    $probe = [Threading.Mutex]::OpenExisting($env:HOSTKIT_TEST_MUTEX, [Security.AccessControl.MutexRights]::FullControl)
    $probe.Dispose()
    $reply = & $env:HOSTKIT_TEST_NODE -e $env:HOSTKIT_TEST_CODE
    if ($LASTEXITCODE -ne 0) { throw "Challenger exited with $LASTEXITCODE" }
    $acquired = $m.WaitOne(0)
    if ($acquired) { $m.ReleaseMutex() }
    @{ unavailable = $false; owner = $owner; current = $current.Value; acquiredAfterRejection = $acquired; resultsJson = [string]($reply -join [Environment]::NewLine) } | ConvertTo-Json -Depth 5 -Compress
  } finally { $m.Dispose() }
}
`, {
      HOSTKIT_TEST_MUTEX: name,
      HOSTKIT_TEST_ADDON: addonPath,
      HOSTKIT_TEST_NODE: process.execPath,
      HOSTKIT_TEST_CODE: challenger,
    });
    if (actual.unavailable) {
      const reason = `Cannot assign a foreign mutex owner without an elevated owner-capable token; SeRestorePrivilege=${actual.restorePrivilege}; ${actual.failures.join("; ")}`;
      assert.ok(!process.env.CI, `CI must exercise the real foreign-owner rejection: ${reason}`);
      t.skip(reason);
      return;
    }
    assert.notEqual(actual.owner, actual.current);
    assert.equal(actual.acquiredAfterRejection, true, "rejection must leave the mutex unowned");
    const results = JSON.parse(actual.resultsJson);
    assert.ok(Array.isArray(results), actual.resultsJson);
    assert.equal(results.length, 16);
    for (const result of results) {
      assert.equal(result.code, "EACCES", JSON.stringify(result));
      assert.equal(result.errno, 5);
      assert.match(result.message, /owner verification/);
    }
    // Both peer processes have exited, so the name can be created with our SID.
    const handle = binding.mutexAcquire(name);
    assert.ok(handle > 0);
    binding.mutexRelease(handle);
  });
});
