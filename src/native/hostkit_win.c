// pi-hostkit native module for Windows.
//
// Named mutexes, Job Objects, process identity (creation time), the process
// table, command lines, termination pinned to a verified process handle, drive
// type, and private ACLs. All handles returned to JavaScript are plain numbers;
// handles are never inheritable, so a Job closes when the host process exits.

#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <tlhelp32.h>
#include <wchar.h>

#include <node_api.h>

#define CHECK(call)                                                            \
  do {                                                                         \
    if ((call) != napi_ok) {                                                   \
      napi_throw_error(env, "EHOSTKIT", "N-API call failed: " #call);          \
      return NULL;                                                             \
    }                                                                          \
  } while (0)

static napi_value throw_win(napi_env env, const char *op, DWORD err) {
  char message[512];
  char sys[256] = "";
  FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, NULL, err, 0, sys,
                 sizeof(sys), NULL);
  size_t n = strlen(sys);
  while (n > 0 && (sys[n - 1] == '\r' || sys[n - 1] == '\n' || sys[n - 1] == ' ')) sys[--n] = 0;
  snprintf(message, sizeof(message), "%s: %s (Windows error %lu)", op, sys, (unsigned long)err);
  char code_buf[32];
  const char *code = code_buf;
  switch (err) {
    case ERROR_ACCESS_DENIED: code = "EACCES"; break;
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND: code = "ENOENT"; break;
    case ERROR_INVALID_PARAMETER: code = "EINVAL"; break;
    default: snprintf(code_buf, sizeof(code_buf), "EWIN%lu", (unsigned long)err);
  }
  napi_value code_v, msg_v, error, errno_v;
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_v);
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &msg_v);
  napi_create_error(env, code_v, msg_v, &error);
  napi_create_uint32(env, err, &errno_v);
  napi_set_named_property(env, error, "errno", errno_v);
  napi_throw(env, error);
  return NULL;
}

static napi_value js_null(napi_env env) {
  napi_value v;
  napi_get_null(env, &v);
  return v;
}

static napi_value js_undefined(napi_env env) {
  napi_value v;
  napi_get_undefined(env, &v);
  return v;
}

static int get_args(napi_env env, napi_callback_info info, size_t want, napi_value *argv) {
  size_t argc = want;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < want) {
    napi_throw_type_error(env, "EINVAL", "missing arguments");
    return 0;
  }
  return 1;
}

// UTF-16 string argument; caller frees.
static wchar_t *get_wstring(napi_env env, napi_value value) {
  size_t len = 0;
  if (napi_get_value_string_utf16(env, value, NULL, 0, &len) != napi_ok) {
    napi_throw_type_error(env, "EINVAL", "string argument required");
    return NULL;
  }
  wchar_t *buf = malloc((len + 1) * sizeof(wchar_t));
  if (!buf) {
    napi_throw_error(env, "ENOMEM", "out of memory");
    return NULL;
  }
  napi_get_value_string_utf16(env, value, (char16_t *)buf, len + 1, &len);
  if (wcslen(buf) != len) {
    free(buf);
    napi_throw_type_error(env, "EINVAL", "string must not contain NUL");
    return NULL;
  }
  return buf;
}

static char *get_utf8(napi_env env, napi_value value) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &len) != napi_ok) {
    napi_throw_type_error(env, "EINVAL", "string argument required");
    return NULL;
  }
  char *buf = malloc(len + 1);
  if (!buf) {
    napi_throw_error(env, "ENOMEM", "out of memory");
    return NULL;
  }
  napi_get_value_string_utf8(env, value, buf, len + 1, &len);
  return buf;
}

static int get_handle(napi_env env, napi_value value, HANDLE *out) {
  int64_t v;
  if (napi_get_value_int64(env, value, &v) != napi_ok || v <= 0) {
    napi_throw_type_error(env, "EINVAL", "handle required");
    return 0;
  }
  *out = (HANDLE)(intptr_t)v;
  return 1;
}

static napi_value make_handle(napi_env env, HANDLE h) {
  napi_value v;
  napi_create_int64(env, (int64_t)(intptr_t)h, &v);
  return v;
}

static int get_pid(napi_env env, napi_value value, DWORD *out) {
  int64_t v;
  if (napi_get_value_int64(env, value, &v) != napi_ok || v <= 0 || v > 0xFFFFFFFFLL) {
    napi_throw_type_error(env, "EINVAL", "pid required");
    return 0;
  }
  *out = (DWORD)v;
  return 1;
}

static void format_start(const FILETIME *ft, char *out, size_t size) {
  ULARGE_INTEGER u;
  u.LowPart = ft->dwLowDateTime;
  u.HighPart = ft->dwHighDateTime;
  snprintf(out, size, "%llu", (unsigned long long)u.QuadPart);
}

// Opens a live process and reads its creation time. Returns NULL when the
// process does not exist, has exited, or cannot be queried.
static HANDLE open_live(DWORD pid, DWORD extra_access, char *start, size_t size) {
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE | extra_access, FALSE, pid);
  if (!h) return NULL;
  if (WaitForSingleObject(h, 0) != WAIT_TIMEOUT) {
    CloseHandle(h);
    return NULL;
  }
  FILETIME created, exited, kernel, user;
  if (!GetProcessTimes(h, &created, &exited, &kernel, &user)) {
    CloseHandle(h);
    return NULL;
  }
  format_start(&created, start, size);
  return h;
}

static napi_value process_object(napi_env env, DWORD pid, DWORD ppid, const char *start) {
  napi_value obj, v;
  CHECK(napi_create_object(env, &obj));
  CHECK(napi_create_uint32(env, pid, &v));
  CHECK(napi_set_named_property(env, obj, "pid", v));
  CHECK(napi_create_uint32(env, ppid, &v));
  CHECK(napi_set_named_property(env, obj, "ppid", v));
  CHECK(napi_create_string_utf8(env, start, NAPI_AUTO_LENGTH, &v));
  CHECK(napi_set_named_property(env, obj, "startTime", v));
  CHECK(napi_get_boolean(env, false, &v));
  CHECK(napi_set_named_property(env, obj, "zombie", v));
  return obj;
}

static DWORD parent_of(DWORD pid) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return 0;
  PROCESSENTRY32W e;
  e.dwSize = sizeof(e);
  DWORD ppid = 0;
  if (Process32FirstW(snap, &e)) {
    do {
      if (e.th32ProcessID == pid) {
        ppid = e.th32ParentProcessID;
        break;
      }
    } while (Process32NextW(snap, &e));
  }
  CloseHandle(snap);
  return ppid;
}

// processInfo(pid) -> { pid, ppid, startTime, zombie } | null
static napi_value process_info(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  DWORD pid;
  if (!get_args(env, info, 1, argv) || !get_pid(env, argv[0], &pid)) return NULL;
  char start[32];
  HANDLE h = open_live(pid, 0, start, sizeof(start));
  if (!h) return js_null(env);
  CloseHandle(h);
  return process_object(env, pid, parent_of(pid), start);
}

// listProcesses() -> processInfo objects for processes this user can query.
static napi_value list_processes(napi_env env, napi_callback_info info) {
  (void)info;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return throw_win(env, "CreateToolhelp32Snapshot", GetLastError());
  napi_value array;
  if (napi_create_array(env, &array) != napi_ok) {
    CloseHandle(snap);
    return NULL;
  }
  PROCESSENTRY32W e;
  e.dwSize = sizeof(e);
  uint32_t index = 0;
  if (Process32FirstW(snap, &e)) {
    do {
      if (e.th32ProcessID == 0) continue;
      char start[32];
      HANDLE h = open_live(e.th32ProcessID, 0, start, sizeof(start));
      if (!h) continue;
      CloseHandle(h);
      napi_value obj = process_object(env, e.th32ProcessID, e.th32ParentProcessID, start);
      if (!obj) {
        CloseHandle(snap);
        return NULL;
      }
      napi_set_element(env, array, index++, obj);
    } while (Process32NextW(snap, &e));
  }
  CloseHandle(snap);
  return array;
}

typedef LONG(NTAPI *NtQueryInformationProcessFn)(HANDLE, ULONG, PVOID, ULONG, PULONG);

typedef struct {
  USHORT Length;
  USHORT MaximumLength;
  PWSTR Buffer;
} HK_UNICODE_STRING;

// processCommandLine(pid) -> string | null (ProcessCommandLineInformation).
static napi_value process_command_line(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  DWORD pid;
  if (!get_args(env, info, 1, argv) || !get_pid(env, argv[0], &pid)) return NULL;
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  NtQueryInformationProcessFn query =
      ntdll ? (NtQueryInformationProcessFn)(void *)GetProcAddress(ntdll, "NtQueryInformationProcess") : NULL;
  if (!query) return js_null(env);
  char start[32];
  HANDLE h = open_live(pid, 0, start, sizeof(start));
  if (!h) return js_null(env);
  ULONG needed = 0;
  query(h, 60 /* ProcessCommandLineInformation */, NULL, 0, &needed);
  if (needed == 0 || needed > 1024 * 1024) {
    CloseHandle(h);
    return js_null(env);
  }
  void *buf = malloc(needed);
  if (!buf) {
    CloseHandle(h);
    return js_null(env);
  }
  LONG status = query(h, 60, buf, needed, &needed);
  CloseHandle(h);
  if (status < 0) {
    free(buf);
    return js_null(env);
  }
  HK_UNICODE_STRING *s = (HK_UNICODE_STRING *)buf;
  napi_value result;
  napi_create_string_utf16(env, (const char16_t *)s->Buffer, s->Length / sizeof(wchar_t), &result);
  free(buf);
  return result;
}

// terminateProcess(pid, startTime) -> boolean. The creation time is checked on
// the same handle that is terminated, so a reused PID is never signalled.
static napi_value terminate_process(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  DWORD pid;
  if (!get_args(env, info, 2, argv) || !get_pid(env, argv[0], &pid)) return NULL;
  char *expected = get_utf8(env, argv[1]);
  if (!expected) return NULL;
  char start[32];
  HANDLE h = open_live(pid, PROCESS_TERMINATE, start, sizeof(start));
  napi_value result;
  if (!h || strcmp(start, expected) != 0) {
    if (h) CloseHandle(h);
    free(expected);
    napi_get_boolean(env, false, &result);
    return result;
  }
  free(expected);
  BOOL ok = TerminateProcess(h, 1);
  DWORD err = GetLastError();
  CloseHandle(h);
  if (!ok && err != ERROR_ACCESS_DENIED) return throw_win(env, "TerminateProcess", err);
  napi_get_boolean(env, ok != 0, &result);
  return result;
}

// jobCreate() -> handle. Processes in the job are killed when the last handle
// closes (including when the host process dies). Breakaway is not allowed.
static napi_value job_create(napi_env env, napi_callback_info info) {
  (void)info;
  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (!job) return throw_win(env, "CreateJobObject", GetLastError());
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    DWORD err = GetLastError();
    CloseHandle(job);
    return throw_win(env, "SetInformationJobObject", err);
  }
  return make_handle(env, job);
}

// jobAssign(job, pid, startTime): verifies identity on the opened handle.
static napi_value job_assign(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  HANDLE job;
  DWORD pid;
  if (!get_args(env, info, 3, argv) || !get_handle(env, argv[0], &job) || !get_pid(env, argv[1], &pid))
    return NULL;
  char *expected = get_utf8(env, argv[2]);
  if (!expected) return NULL;
  char start[32];
  HANDLE h = open_live(pid, PROCESS_SET_QUOTA | PROCESS_TERMINATE, start, sizeof(start));
  if (!h) {
    free(expected);
    return throw_win(env, "OpenProcess", GetLastError() ? GetLastError() : ERROR_INVALID_PARAMETER);
  }
  if (strcmp(start, expected) != 0) {
    free(expected);
    CloseHandle(h);
    napi_throw_error(env, "ESRCH", "process identity changed before job assignment");
    return NULL;
  }
  free(expected);
  BOOL ok = AssignProcessToJobObject(job, h);
  DWORD err = GetLastError();
  CloseHandle(h);
  if (!ok) return throw_win(env, "AssignProcessToJobObject", err);
  return js_undefined(env);
}

static napi_value job_terminate(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  HANDLE job;
  if (!get_args(env, info, 1, argv) || !get_handle(env, argv[0], &job)) return NULL;
  if (!TerminateJobObject(job, 1)) return throw_win(env, "TerminateJobObject", GetLastError());
  return js_undefined(env);
}

// jobProcessIds(job) -> number[] of processes still in the job.
static napi_value job_process_ids(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  HANDLE job;
  if (!get_args(env, info, 1, argv) || !get_handle(env, argv[0], &job)) return NULL;
  DWORD capacity = 256;
  for (;;) {
    size_t size = sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + capacity * sizeof(ULONG_PTR);
    JOBOBJECT_BASIC_PROCESS_ID_LIST *list = malloc(size);
    if (!list) return throw_win(env, "QueryInformationJobObject", ERROR_NOT_ENOUGH_MEMORY);
    if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, list, (DWORD)size, NULL)) {
      DWORD err = GetLastError();
      free(list);
      if (err == ERROR_MORE_DATA && capacity < 65536) {
        capacity *= 4;
        continue;
      }
      return throw_win(env, "QueryInformationJobObject", err);
    }
    if (list->NumberOfAssignedProcesses > list->NumberOfProcessIdsInList && capacity < 65536) {
      capacity = list->NumberOfAssignedProcesses + 16;
      free(list);
      continue;
    }
    napi_value array;
    napi_create_array(env, &array);
    for (DWORD i = 0; i < list->NumberOfProcessIdsInList; i++) {
      napi_value v;
      napi_create_uint32(env, (uint32_t)list->ProcessIdList[i], &v);
      napi_set_element(env, array, i, v);
    }
    free(list);
    return array;
  }
}

static napi_value handle_close(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  HANDLE h;
  if (!get_args(env, info, 1, argv) || !get_handle(env, argv[0], &h)) return NULL;
  if (!CloseHandle(h)) return throw_win(env, "CloseHandle", GetLastError());
  return js_undefined(env);
}

// mutexAcquire(name) -> handle, or -1 when another thread or process owns it.
// An abandoned mutex (owner died) counts as acquired. Ownership is per thread:
// release on the same thread.
static napi_value mutex_acquire(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!get_args(env, info, 1, argv)) return NULL;
  wchar_t *name = get_wstring(env, argv[0]);
  if (!name) return NULL;
  HANDLE h = CreateMutexW(NULL, FALSE, name);
  DWORD err = GetLastError();
  free(name);
  if (!h) return throw_win(env, "CreateMutex", err);
  DWORD wait = WaitForSingleObject(h, 0);
  if (wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED) return make_handle(env, h);
  CloseHandle(h);
  if (wait == WAIT_TIMEOUT) {
    napi_value v;
    napi_create_int32(env, -1, &v);
    return v;
  }
  return throw_win(env, "WaitForSingleObject", GetLastError());
}

static napi_value mutex_release(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  HANDLE h;
  if (!get_args(env, info, 1, argv) || !get_handle(env, argv[0], &h)) return NULL;
  BOOL released = ReleaseMutex(h);
  DWORD err = GetLastError();
  CloseHandle(h);
  if (!released) return throw_win(env, "ReleaseMutex", err);
  return js_undefined(env);
}

// fsInfo(path) -> { local, type } from the drive type of the volume.
static napi_value fs_info(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!get_args(env, info, 1, argv)) return NULL;
  wchar_t *path = get_wstring(env, argv[0]);
  if (!path) return NULL;
  wchar_t root[MAX_PATH + 1];
  BOOL ok = GetVolumePathNameW(path, root, MAX_PATH + 1);
  DWORD err = GetLastError();
  free(path);
  if (!ok) return throw_win(env, "GetVolumePathName", err);
  UINT type = GetDriveTypeW(root);
  const char *name;
  int local;
  switch (type) {
    case DRIVE_FIXED: name = "fixed"; local = 1; break;
    case DRIVE_REMOVABLE: name = "removable"; local = 1; break;
    case DRIVE_RAMDISK: name = "ramdisk"; local = 1; break;
    case DRIVE_REMOTE: name = "remote"; local = 0; break;
    case DRIVE_CDROM: name = "cdrom"; local = 0; break;
    default: name = "unknown"; local = 0;
  }
  // UNC paths that are not \\?\ or \\.\ device paths are network shares.
  if (root[0] == L'\\' && root[1] == L'\\' && root[2] != L'?' && root[2] != L'.') {
    name = "remote";
    local = 0;
  }
  napi_value obj, v;
  CHECK(napi_create_object(env, &obj));
  CHECK(napi_get_boolean(env, local, &v));
  CHECK(napi_set_named_property(env, obj, "local", v));
  CHECK(napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &v));
  CHECK(napi_set_named_property(env, obj, "type", v));
  return obj;
}

// Current user SID from the process token. Caller frees with free().
static PSID current_user_sid(DWORD *err) {
  HANDLE token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    *err = GetLastError();
    return NULL;
  }
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, NULL, 0, &size);
  TOKEN_USER *user = malloc(size);
  if (!user || !GetTokenInformation(token, TokenUser, user, size, &size)) {
    *err = GetLastError();
    free(user);
    CloseHandle(token);
    return NULL;
  }
  CloseHandle(token);
  DWORD len = GetLengthSid(user->User.Sid);
  PSID sid = malloc(len);
  if (sid) CopySid(len, sid, user->User.Sid);
  free(user);
  return sid;
}

static napi_value sid_string(napi_env env, PSID sid) {
  LPWSTR s = NULL;
  if (!sid || !ConvertSidToStringSidW(sid, &s)) return js_null(env);
  napi_value v;
  napi_create_string_utf16(env, (const char16_t *)s, wcslen(s), &v);
  LocalFree(s);
  return v;
}

static napi_value user_sid(napi_env env, napi_callback_info info) {
  (void)info;
  DWORD err = 0;
  PSID sid = current_user_sid(&err);
  if (!sid) return throw_win(env, "GetTokenInformation", err);
  napi_value v = sid_string(env, sid);
  free(sid);
  return v;
}

// setPrivateAcl(path, isDirectory): replaces the DACL with a single entry
// granting the current user full control, and blocks inheritance from parents.
// Directories pass the entry on to children.
static napi_value set_private_acl(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  if (!get_args(env, info, 2, argv)) return NULL;
  bool is_dir = false;
  napi_get_value_bool(env, argv[1], &is_dir);
  wchar_t *path = get_wstring(env, argv[0]);
  if (!path) return NULL;
  DWORD err = 0;
  PSID sid = current_user_sid(&err);
  if (!sid) {
    free(path);
    return throw_win(env, "GetTokenInformation", err);
  }
  EXPLICIT_ACCESSW ea;
  ZeroMemory(&ea, sizeof(ea));
  ea.grfAccessPermissions = GENERIC_ALL;
  ea.grfAccessMode = SET_ACCESS;
  ea.grfInheritance = is_dir ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE;
  ea.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  ea.Trustee.TrusteeType = TRUSTEE_IS_USER;
  ea.Trustee.ptstrName = (LPWSTR)sid;
  PACL acl = NULL;
  err = SetEntriesInAclW(1, &ea, NULL, &acl);
  if (err != ERROR_SUCCESS) {
    free(sid);
    free(path);
    return throw_win(env, "SetEntriesInAcl", err);
  }
  err = SetNamedSecurityInfoW(path, SE_FILE_OBJECT,
                              DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, NULL,
                              NULL, acl, NULL);
  LocalFree(acl);
  free(sid);
  free(path);
  if (err != ERROR_SUCCESS) return throw_win(env, "SetNamedSecurityInfo", err);
  return js_undefined(env);
}

// readAcl(path) -> { owner, protected, aces: [{ sid, type, mask }] }
static napi_value read_acl(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!get_args(env, info, 1, argv)) return NULL;
  wchar_t *path = get_wstring(env, argv[0]);
  if (!path) return NULL;
  PSID owner = NULL;
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR sd = NULL;
  DWORD err = GetNamedSecurityInfoW(path, SE_FILE_OBJECT,
                                    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner,
                                    NULL, &dacl, NULL, &sd);
  free(path);
  if (err != ERROR_SUCCESS) return throw_win(env, "GetNamedSecurityInfo", err);
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  GetSecurityDescriptorControl(sd, &control, &revision);
  napi_value obj, v, aces;
  napi_create_object(env, &obj);
  napi_set_named_property(env, obj, "owner", sid_string(env, owner));
  napi_get_boolean(env, (control & SE_DACL_PROTECTED) != 0, &v);
  napi_set_named_property(env, obj, "protected", v);
  napi_get_boolean(env, dacl == NULL, &v);
  napi_set_named_property(env, obj, "nullDacl", v);
  napi_create_array(env, &aces);
  if (dacl) {
    for (DWORD i = 0; i < dacl->AceCount; i++) {
      ACE_HEADER *header = NULL;
      if (!GetAce(dacl, i, (LPVOID *)&header)) continue;
      napi_value ace;
      napi_create_object(env, &ace);
      const char *type = "other";
      PSID sid = NULL;
      ACCESS_MASK mask = 0;
      if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
        ACCESS_ALLOWED_ACE *a = (ACCESS_ALLOWED_ACE *)header;
        type = "allow";
        sid = (PSID)&a->SidStart;
        mask = a->Mask;
      } else if (header->AceType == ACCESS_DENIED_ACE_TYPE) {
        ACCESS_DENIED_ACE *d = (ACCESS_DENIED_ACE *)header;
        type = "deny";
        sid = (PSID)&d->SidStart;
        mask = d->Mask;
      }
      napi_create_string_utf8(env, type, NAPI_AUTO_LENGTH, &v);
      napi_set_named_property(env, ace, "type", v);
      napi_set_named_property(env, ace, "sid", sid_string(env, sid));
      napi_create_uint32(env, mask, &v);
      napi_set_named_property(env, ace, "mask", v);
      napi_set_element(env, aces, i, ace);
    }
  }
  napi_set_named_property(env, obj, "aces", aces);
  LocalFree(sd);
  return obj;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    {"processInfo", NULL, process_info, NULL, NULL, NULL, napi_default, NULL},
    {"listProcesses", NULL, list_processes, NULL, NULL, NULL, napi_default, NULL},
    {"processCommandLine", NULL, process_command_line, NULL, NULL, NULL, napi_default, NULL},
    {"terminateProcess", NULL, terminate_process, NULL, NULL, NULL, napi_default, NULL},
    {"jobCreate", NULL, job_create, NULL, NULL, NULL, napi_default, NULL},
    {"jobAssign", NULL, job_assign, NULL, NULL, NULL, napi_default, NULL},
    {"jobTerminate", NULL, job_terminate, NULL, NULL, NULL, napi_default, NULL},
    {"jobProcessIds", NULL, job_process_ids, NULL, NULL, NULL, napi_default, NULL},
    {"handleClose", NULL, handle_close, NULL, NULL, NULL, napi_default, NULL},
    {"mutexAcquire", NULL, mutex_acquire, NULL, NULL, NULL, napi_default, NULL},
    {"mutexRelease", NULL, mutex_release, NULL, NULL, NULL, napi_default, NULL},
    {"fsInfo", NULL, fs_info, NULL, NULL, NULL, napi_default, NULL},
    {"userSid", NULL, user_sid, NULL, NULL, NULL, napi_default, NULL},
    {"setPrivateAcl", NULL, set_private_acl, NULL, NULL, NULL, napi_default, NULL},
    {"readAcl", NULL, read_acl, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
