import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const win = process.platform === "win32";

// 故障开关和资源计数只编入临时副本，不进入生产模块或环境变量。
export function buildFaultBinding() {
  const dir = mkdtempSync(path.join(tmpdir(), "hostkit-native-fault-"));
  const wrappers = [];
  const names = [];
  function wrap(ret, name, params, args, fail, after = "", before = "") {
    names.push(name);
    wrappers.push(`static ${ret} hk_${name}(${params}) {
      ${before}
      if (hk_hit("${name}")) { ${win ? "SetLastError(hk_error);" : "errno = (int)hk_error;"} ${fail} }
      ${ret} result = ${name}(${args}); ${after} return result;
    }`);
  }
  wrap("void *", "malloc", "size_t size", "size", "return NULL;", "if (result) hk_heap++;");
  wrappers.push("static void hk_free(void *p) { if (p) hk_heap--; free(p); }");
  names.push("free");
  if (win) {
    wrap("HANDLE", "OpenProcess", "DWORD a, BOOL b, DWORD c", "a,b,c", "return NULL;", "if (result) hk_handles++;");
    wrap("BOOL", "CloseHandle", "HANDLE h", "h", "BOOL closed = CloseHandle(h); if (closed) hk_handles--; return FALSE;", "if (result) hk_handles--;");
    wrap("DWORD", "WaitForSingleObject", "HANDLE h, DWORD t", "h,t", "return WAIT_FAILED;");
    wrap("BOOL", "GetProcessTimes", "HANDLE h, LPFILETIME a, LPFILETIME b, LPFILETIME c, LPFILETIME d", "h,a,b,c,d", "return FALSE;");
    wrap("BOOL", "TerminateProcess", "HANDLE h, UINT c", "h,c", "return FALSE;");
    wrap("HANDLE", "CreateJobObjectW", "LPSECURITY_ATTRIBUTES a, LPCWSTR b", "a,b", "return NULL;", "if (result) hk_handles++;");
    wrap("BOOL", "SetInformationJobObject", "HANDLE h, JOBOBJECTINFOCLASS c, LPVOID p, DWORD n", "h,c,p,n", "return FALSE;");
    wrap("BOOL", "AssignProcessToJobObject", "HANDLE j, HANDLE p", "j,p", "return FALSE;");
    wrap("BOOL", "TerminateJobObject", "HANDLE j, UINT c", "j,c", "return FALSE;");
    wrap("BOOL", "QueryInformationJobObject", "HANDLE h, JOBOBJECTINFOCLASS c, LPVOID p, DWORD n, LPDWORD r", "h,c,p,n,r", "return FALSE;", "", `if (hk_hit("jobTruncated")) { JOBOBJECT_BASIC_PROCESS_ID_LIST *list = p; list->NumberOfAssignedProcesses = 70000; list->NumberOfProcessIdsInList = 0; return TRUE; }`);
    wrap("BOOL", "OpenProcessToken", "HANDLE h, DWORD a, PHANDLE t", "h,a,t", "return FALSE;", "if (result) hk_handles++;");
    wrap("BOOL", "GetTokenInformation", "HANDLE h, TOKEN_INFORMATION_CLASS c, LPVOID p, DWORD n, PDWORD r", "h,c,p,n,r", "return FALSE;");
    wrap("BOOL", "CopySid", "DWORD n, PSID a, PSID b", "n,a,b", "return FALSE;");
    wrap("BOOL", "ConvertSidToStringSidW", "PSID sid, LPWSTR *s", "sid,s", "return FALSE;", "if (result) hk_local++;");
    wrap("DWORD", "SetEntriesInAclW", "ULONG n, PEXPLICIT_ACCESSW e, PACL a, PACL *p", "n,e,a,p", "return hk_error;", "if (result == ERROR_SUCCESS && *p) hk_local++;");
    wrap("BOOL", "InitializeSecurityDescriptor", "PSECURITY_DESCRIPTOR p, DWORD r", "p,r", "return FALSE;");
    wrap("BOOL", "SetSecurityDescriptorOwner", "PSECURITY_DESCRIPTOR p, PSID s, BOOL b", "p,s,b", "return FALSE;");
    wrap("BOOL", "SetSecurityDescriptorDacl", "PSECURITY_DESCRIPTOR p, BOOL a, PACL d, BOOL b", "p,a,d,b", "return FALSE;");
    wrap("BOOL", "SetSecurityDescriptorControl", "PSECURITY_DESCRIPTOR p, SECURITY_DESCRIPTOR_CONTROL a, SECURITY_DESCRIPTOR_CONTROL b", "p,a,b", "return FALSE;");
    wrap("HANDLE", "CreateMutexW", "LPSECURITY_ATTRIBUTES a, BOOL b, LPCWSTR n", "a,b,n", "return NULL;", "if (result) hk_handles++;");
    wrap("DWORD", "GetSecurityInfo", "HANDLE h, SE_OBJECT_TYPE t, SECURITY_INFORMATION i, PSID *o, PSID *g, PACL *d, PACL *s, PSECURITY_DESCRIPTOR *p", "h,t,i,o,g,d,s,p", "return hk_error;", "if (result == ERROR_SUCCESS && *p) hk_local++;");
    wrap("BOOL", "ReleaseMutex", "HANDLE h", "h", "ReleaseMutex(h); return FALSE;");
    wrap("BOOL", "GetVolumePathNameW", "LPCWSTR p, LPWSTR r, DWORD n", "p,r,n", "return FALSE;");
    wrap("UINT", "GetDriveTypeW", "LPCWSTR p", "p", "return DRIVE_UNKNOWN;");
    wrap("DWORD", "SetNamedSecurityInfoW", "LPWSTR p, SE_OBJECT_TYPE t, SECURITY_INFORMATION i, PSID o, PSID g, PACL d, PACL s", "p,t,i,o,g,d,s", "return hk_error;");
    wrap("HANDLE", "CreateFileW", "LPCWSTR p, DWORD a, DWORD s, LPSECURITY_ATTRIBUTES sa, DWORD c, DWORD f, HANDLE h", "p,a,s,sa,c,f,h", "return INVALID_HANDLE_VALUE;", "if (result != INVALID_HANDLE_VALUE) hk_handles++;");
    wrap("DWORD", "GetNamedSecurityInfoW", "LPWSTR p, SE_OBJECT_TYPE t, SECURITY_INFORMATION i, PSID *o, PSID *g, PACL *d, PACL *s, PSECURITY_DESCRIPTOR *sd", "p,t,i,o,g,d,s,sd", "return hk_error;", "if (result == ERROR_SUCCESS && *sd) hk_local++;");
    wrap("BOOL", "GetSecurityDescriptorControl", "PSECURITY_DESCRIPTOR sd, PSECURITY_DESCRIPTOR_CONTROL c, LPDWORD r", "sd,c,r", "return FALSE;");
    wrap("BOOL", "GetAce", "PACL a, DWORD i, LPVOID *p", "a,i,p", "return FALSE;");
    wrap("LPWSTR *", "CommandLineToArgvW", "LPCWSTR s, int *n", "s,n", "return NULL;", "if (result) hk_local++;");
    wrappers.push("static HLOCAL hk_LocalFree(HLOCAL p) { if (p) hk_local--; return LocalFree(p); }");
    names.push("LocalFree");
    // 动态解析的 NT 查询也在副本中拦截，保留真实的成功路径。
    wrappers.push(`static LONG NTAPI hk_nt_system(ULONG c, PVOID p, ULONG n, PULONG r) {
      if (hk_hit("NtQuerySystemInformation")) return (LONG)hk_error;
      typedef LONG (NTAPI *F)(ULONG,PVOID,ULONG,PULONG);
      LONG status = ((F)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQuerySystemInformation"))(c,p,n,r);
      if (status >= 0 && hk_hit("snapshotMalformed")) ((SYSTEM_PROCESS_INFORMATION *)p)->NextEntryOffset = 1;
      return status;
    }
    static LONG NTAPI hk_nt_process(HANDLE h, ULONG c, PVOID p, ULONG n, PULONG r) {
      if (hk_hit("NtQueryInformationProcess")) return (LONG)hk_error;
      typedef LONG (NTAPI *F)(HANDLE,ULONG,PVOID,ULONG,PULONG);
      LONG status = ((F)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"))(h,c,p,n,r);
      if (p && status >= 0 && hk_hit("commandMalformed")) ((USHORT *)p)[0] = 65535;
      return status;
    }
    static FARPROC hk_GetProcAddress(HMODULE m, LPCSTR n) {
      if (hk_hit("GetProcAddress")) { SetLastError(hk_error); return NULL; }
      if (!strcmp(n,"NtQuerySystemInformation")) return (FARPROC)hk_nt_system;
      if (!strcmp(n,"NtQueryInformationProcess")) return (FARPROC)hk_nt_process;
      return GetProcAddress(m,n);
    }`);
    names.push("GetProcAddress");
  } else {
    wrap("int", "open", "const char *p, int f, mode_t m", "p,f,m", "return -1;", "if (result >= 0) hk_handles++;");
    wrap("int", "flock", "int fd, int op", "fd,op", "return -1;");
    wrap("int", "close", "int fd", "fd", "int rc = close(fd); if (!rc) hk_handles--; return -1;", "if (!result) hk_handles--;");
    wrap("int", "statfs", "const char *p, struct statfs *s", "p,s", "return -1;");
    if (process.platform === "linux") {
      wrappers.push(`static long hk_syscall(long op, ...) {
        va_list args; va_start(args,op);
        if (op == SYS_pidfd_open) {
          pid_t pid = va_arg(args,int); int flags = va_arg(args,int); va_end(args);
          if (hk_hit("pidfd_open")) { errno = hk_error; return -1; }
          long fd = syscall(op,pid,flags); if (fd >= 0) hk_handles++; return fd;
        }
        int fd = va_arg(args,int), signo = va_arg(args,int); void *p = va_arg(args,void *);
        unsigned int flags = va_arg(args,unsigned int); va_end(args);
        if (hk_hit("pidfd_send_signal")) { errno = hk_error; return -1; }
        return syscall(op,fd,signo,p,flags);
      }`);
      names.push("syscall");
    } else {
      wrap("int", "sysctl", "int *m, u_int n, void *p, size_t *l, void *v, size_t s", "m,n,p,l,v,s", "return -1;", "", `if (p && hk_hit("sysctlPartial")) { *l = 1; return 0; }`);
      wrap("acl_t", "acl_get_link_np", "const char *p, acl_type_t t", "p,t", "return NULL;", "if (result) hk_local++;");
      wrap("int", "acl_get_entry", "acl_t a, int i, acl_entry_t *e", "a,i,e", "return -1;");
      wrap("int", "acl_free", "void *p", "p", "acl_free(p); if (p) hk_local--; return -1;", "if (!result && p) hk_local--;");
      wrap("acl_t", "acl_init", "int n", "n", "return NULL;", "if (result) hk_local++;");
      wrap("int", "acl_set_link_np", "const char *p, acl_type_t t, acl_t a", "p,t,a", "return -1;");
    }
  }
  for (const [name, params, args] of [
    ["napi_create_int32", "napi_env e, int32_t i, napi_value *v", "e,i,v"],
    ["napi_create_int64", "napi_env e, int64_t i, napi_value *v", "e,i,v"],
    ["napi_create_object", "napi_env e, napi_value *v", "e,v"],
    ["napi_create_array", "napi_env e, napi_value *v", "e,v"],
    ["napi_set_element", "napi_env e, napi_value a, uint32_t i, napi_value v", "e,a,i,v"],
    ["napi_set_named_property", "napi_env e, napi_value o, const char *n, napi_value v", "e,o,n,v"],
  ]) wrap("napi_status", name, params, args, "return napi_generic_failure;");

  const header = `
#include <stdint.h>
#include <stdarg.h>
static char hk_target[128] = "";
static int hk_nth = 0, hk_calls = 0, hk_heap = 0, hk_handles = 0, hk_local = 0;
static uint32_t hk_error = 0;
static int hk_hit(const char *name) {
  if (strcmp(hk_target,name)) return 0;
  return ++hk_calls == hk_nth || hk_nth == 0;
}
static napi_value hk_fault(napi_env e, napi_callback_info i) {
  napi_value a[3], u; size_t n=3, len;
  napi_get_cb_info(e,i,&n,a,NULL,NULL);
  napi_get_value_string_utf8(e,a[0],hk_target,sizeof(hk_target),&len);
  napi_get_value_int32(e,a[1],&hk_nth); napi_get_value_uint32(e,a[2],&hk_error);
  hk_calls=0; napi_get_undefined(e,&u); return u;
}
static napi_value hk_stats(napi_env e, napi_callback_info i) {
  (void)i; napi_value a,v; napi_create_array(e,&a);
  int counts[4]={hk_heap,hk_handles,hk_local,hk_calls};
  for (int k=0;k<4;k++) { napi_create_int32(e,counts[k],&v); napi_set_element(e,a,k,v); }
  return a;
}
${wrappers.join("\n")}
${names.map(n => `#define ${n} hk_${n}`).join("\n")}
`;
  try {
    const filename = win ? "hostkit_win.c" : "hostkit_posix.c";
    let source = readFileSync(path.join(root, "src/native", filename), "utf8");
    source = source.replace("#define CHECK(call)", `${header}\n#define CHECK(call)`);
    source = source.replace("napi_property_descriptor props[] = {", `napi_property_descriptor props[] = {
      {"_fault",NULL,hk_fault,NULL,NULL,NULL,napi_default,NULL},
      {"_stats",NULL,hk_stats,NULL,NULL,NULL,napi_default,NULL},`);
    writeFileSync(path.join(dir, "hostkit.c"), source);
    const gyp = JSON.parse(readFileSync(path.join(root, "binding.gyp"), "utf8"));
    for (const condition of gyp.targets[0].conditions) condition[1].sources = ["hostkit.c"];
    writeFileSync(path.join(dir, "binding.gyp"), JSON.stringify(gyp));
    execFileSync(process.execPath, [path.join(root, "node_modules/node-gyp/bin/node-gyp.js"), "rebuild", "--directory", dir], {
      cwd: root, timeout: 120_000, stdio: "pipe", windowsHide: true,
    });
    return { addonPath: path.join(dir, "build/Release/hostkit.node"), cleanup() {
      // 加载 DLL 的测试子进程退出后再删除整个副本。
      rmSync(dir, { recursive: true, force: true, maxRetries: 1 });
    }, dir };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`专用原生测试构建失败：${error.stdout ?? ""}\n${error.stderr ?? ""}`, { cause: error });
  }
}
