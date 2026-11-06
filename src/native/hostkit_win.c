// pi-hostkit native module for Windows.
//
// Named mutexes, Job Objects, process identity (creation time), the process
// table, command lines, termination pinned to a verified process handle, drive
// type, and private ACLs. All handles returned to JavaScript are plain numbers;
// handles are never inheritable, so a Job closes when the host process exits.

#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <shellapi.h>
#include <winternl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#include <node_api.h>

#define CHECK(call)                                                            \
  do {                                                                         \
    if ((call) != napi_ok) {                                                   \
      napi_throw_error(env, "EHOSTKIT", "N-API call failed: " #call);          \
      return NULL;                                                             \
    }                                                                          \
  } while (0)

// 持有临时资源时，N-API 失败也必须经过释放路径。
#define CHECK_RELEASE(call, cleanup)                                            \
  do {                                                                         \
    if ((call) != napi_ok) {                                                    \
      cleanup;                                                                 \
      napi_throw_error(env, "EHOSTKIT", "N-API call failed: " #call);           \
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
    case ERROR_FILE_EXISTS:
    case ERROR_ALREADY_EXISTS: code = "EEXIST"; break;
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
  if (napi_get_value_string_utf16(env, value, (char16_t *)buf, len + 1, &len) != napi_ok ||
      wcslen(buf) != len) {
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
  if (napi_get_value_string_utf8(env, value, buf, len + 1, &len) != napi_ok || strlen(buf) != len) {
    free(buf);
    napi_throw_type_error(env, "EINVAL", "string must not contain NUL");
    return NULL;
  }
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
  if (napi_create_int64(env, (int64_t)(intptr_t)h, &v) != napi_ok) {
    CloseHandle(h);
    napi_throw_error(env, "EHOSTKIT", "cannot return native handle");
    return NULL;
  }
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

// 只有确认不存在或已退出时才令 err 为零；访问和查询失败必须交给调用方。
static HANDLE open_live(DWORD pid, DWORD extra_access, char *start, size_t size, DWORD *err) {
  *err = ERROR_SUCCESS;
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE | extra_access, FALSE, pid);
  if (!h) {
    DWORD code = GetLastError();
    if (code != ERROR_INVALID_PARAMETER) *err = code;
    return NULL;
  }
  DWORD wait = WaitForSingleObject(h, 0);
  if (wait != WAIT_TIMEOUT) {
    if (wait != WAIT_OBJECT_0) *err = wait == WAIT_FAILED ? GetLastError() : ERROR_INVALID_DATA;
    if (!CloseHandle(h) && !*err) *err = GetLastError();
    return NULL;
  }
  FILETIME created, exited, kernel, user;
  if (!GetProcessTimes(h, &created, &exited, &kernel, &user)) {
    *err = GetLastError();
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

typedef LONG(NTAPI *NtQuerySystemInformationFn)(ULONG, PVOID, ULONG, PULONG);

// One snapshot of every process from NtQuerySystemInformation(
// SystemProcessInformation). Parent PID and creation time in an entry belong
// to the same process object, unlike a Toolhelp parent PID combined with a
// creation time read later through a PID that may have been reused.
// Returns a malloc'd buffer or NULL (error in *err).
static BYTE *process_snapshot(DWORD *err, size_t *length) {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  NtQuerySystemInformationFn query =
      ntdll ? (NtQuerySystemInformationFn)(void *)GetProcAddress(ntdll, "NtQuerySystemInformation") : NULL;
  if (!query) {
    *err = ERROR_PROC_NOT_FOUND;
    return NULL;
  }
  ULONG size = 1 << 20;
  for (int attempt = 0; attempt < 8; attempt++) {
    BYTE *buf = malloc(size);
    if (!buf) {
      *err = ERROR_NOT_ENOUGH_MEMORY;
      return NULL;
    }
    ULONG needed = 0;
    LONG status = query(5 /* SystemProcessInformation */, buf, size, &needed);
    if (status >= 0) {
      if (needed < sizeof(SYSTEM_PROCESS_INFORMATION) || needed > size) {
        free(buf);
        *err = ERROR_INVALID_DATA;
        return NULL;
      }
      *length = needed;
      return buf;
    }
    free(buf);
    if (status != (LONG)0xC0000004L /* STATUS_INFO_LENGTH_MISMATCH */) {
      *err = (DWORD)status;
      return NULL;
    }
    ULONG next = needed > size ? needed : size;
    if (next > MAXDWORD - (1 << 16)) {
      *err = ERROR_INSUFFICIENT_BUFFER;
      return NULL;
    }
    size = next + (1 << 16);
  }
  *err = ERROR_INSUFFICIENT_BUFFER;
  return NULL;
}

typedef struct {
  DWORD pid;
  DWORD ppid;
  char start[32];
} proc_entry;

// 返回 1 表示一项，0 表示结束，-1 表示系统快照不完整。
static int next_entry(BYTE *buf, size_t length, size_t *offset, int *done, proc_entry *out) {
  if (*done) return 0;
  if (*offset > length || length - *offset < sizeof(SYSTEM_PROCESS_INFORMATION)) return -1;
  SYSTEM_PROCESS_INFORMATION *info = (SYSTEM_PROCESS_INFORMATION *)(buf + *offset);
  if (info->NextEntryOffset && (info->NextEntryOffset < sizeof(*info) ||
      info->NextEntryOffset > length - *offset || info->NextEntryOffset % sizeof(void *) != 0)) return -1;
  // winternl.h names InheritedFromUniqueProcessId "Reserved2"; CreateTime is
  // at byte 24 of Reserved1 (after WorkingSetPrivateSize, HardFaultCount,
  // NumberOfThreadsHighWatermark and CycleTime).
  LARGE_INTEGER created;
  memcpy(&created, info->Reserved1 + 24, sizeof(created));
  FILETIME ft;
  ft.dwLowDateTime = created.LowPart;
  ft.dwHighDateTime = (DWORD)created.HighPart;
  out->pid = (DWORD)(ULONG_PTR)info->UniqueProcessId;
  out->ppid = (DWORD)(ULONG_PTR)info->Reserved2;
  format_start(&ft, out->start, sizeof(out->start));
  if (info->NextEntryOffset == 0) *done = 1;
  else *offset += info->NextEntryOffset;
  return 1;
}

// processInfo(pid) -> { pid, ppid, startTime, zombie } | null (not running).
static napi_value process_info(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  DWORD pid;
  if (!get_args(env, info, 1, argv) || !get_pid(env, argv[0], &pid)) return NULL;
  DWORD err = 0;
  size_t length = 0;
  BYTE *buf = process_snapshot(&err, &length);
  if (!buf) return throw_win(env, "NtQuerySystemInformation", err);
  size_t offset = 0;
  int done = 0, rc;
  proc_entry e;
  napi_value result = NULL;
  int found = 0;
  while ((rc = next_entry(buf, length, &offset, &done, &e)) > 0) {
    if (e.pid == pid) {
      found = 1;
      break;
    }
  }
  free(buf);
  if (rc < 0) return throw_win(env, "process snapshot entry", ERROR_INVALID_DATA);
  if (!found) return js_null(env);
  // 持有句柄的已退出进程可能仍在快照内；查询失败不能作为存活或退出结论。
  int exited = 0;
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  if (h) {
    FILETIME created, exit_time, kernel, user;
    char start[32];
    if (!GetProcessTimes(h, &created, &exit_time, &kernel, &user)) {
      err = GetLastError();
      CloseHandle(h);
      return throw_win(env, "GetProcessTimes", err);
    }
    format_start(&created, start, sizeof(start));
    if (strcmp(start, e.start) != 0) {
      if (!CloseHandle(h)) return throw_win(env, "CloseHandle(process)", GetLastError());
      return js_null(env);
    }
    DWORD wait = WaitForSingleObject(h, 0);
    err = GetLastError();
    BOOL closed = CloseHandle(h);
    DWORD close_err = GetLastError();
    if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT)
      return throw_win(env, "WaitForSingleObject", wait == WAIT_FAILED ? err : ERROR_INVALID_DATA);
    if (!closed) return throw_win(env, "CloseHandle(process)", close_err);
    exited = wait == WAIT_OBJECT_0;
  } else {
    err = GetLastError();
    if (err == ERROR_INVALID_PARAMETER) return js_null(env);
    return throw_win(env, "OpenProcess", err);
  }
  result = process_object(env, e.pid, e.ppid, e.start);
  if (result && exited) {
    napi_value v;
    napi_get_boolean(env, true, &v);
    napi_set_named_property(env, result, "zombie", v);
  }
  return result ? result : NULL;
}

// listProcesses() -> processInfo objects for every process (PID 0 excluded).
static napi_value list_processes(napi_env env, napi_callback_info info) {
  (void)info;
  DWORD err = 0;
  size_t length = 0;
  BYTE *buf = process_snapshot(&err, &length);
  if (!buf) return throw_win(env, "NtQuerySystemInformation", err);
  napi_value array;
  CHECK_RELEASE(napi_create_array(env, &array), free(buf));
  size_t offset = 0;
  int done = 0, rc;
  uint32_t index = 0;
  proc_entry e;
  while ((rc = next_entry(buf, length, &offset, &done, &e)) > 0) {
    if (e.pid == 0) continue;
    napi_value obj = process_object(env, e.pid, e.ppid, e.start);
    if (!obj) {
      free(buf);
      return NULL;
    }
    CHECK_RELEASE(napi_set_element(env, array, index++, obj), free(buf));
  }
  free(buf);
  if (rc < 0) return throw_win(env, "process snapshot entry", ERROR_INVALID_DATA);
  return array;
}

typedef LONG(NTAPI *NtQueryInformationProcessFn)(HANDLE, ULONG, PVOID, ULONG, PULONG);

typedef struct {
  USHORT Length;
  USHORT MaximumLength;
  PWSTR Buffer;
} HK_UNICODE_STRING;

// processCommandLine(pid) -> string[] | null: the command line
// (ProcessCommandLineInformation) split with CommandLineToArgvW, the rules the
// Microsoft C runtime and Node use.
static napi_value process_command_line(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  DWORD pid;
  if (!get_args(env, info, 1, argv) || !get_pid(env, argv[0], &pid)) return NULL;
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  NtQueryInformationProcessFn query =
      ntdll ? (NtQueryInformationProcessFn)(void *)GetProcAddress(ntdll, "NtQueryInformationProcess") : NULL;
  if (!query) return throw_win(env, "NtQueryInformationProcess", ERROR_PROC_NOT_FOUND);
  char start[32];
  DWORD err = ERROR_SUCCESS;
  HANDLE h = open_live(pid, 0, start, sizeof(start), &err);
  if (!h) return err ? throw_win(env, "OpenProcess/query", err) : js_null(env);
  ULONG needed = 0;
  LONG status = query(h, 60 /* ProcessCommandLineInformation */, NULL, 0, &needed);
  if (status < 0 && status != (LONG)0xC0000004L && status != (LONG)0xC0000023L) {
    CloseHandle(h);
    return throw_win(env, "NtQueryInformationProcess(size)", (DWORD)status);
  }
  if (needed < sizeof(HK_UNICODE_STRING) || needed > 1024 * 1024) {
    CloseHandle(h);
    return throw_win(env, "NtQueryInformationProcess(size)", ERROR_INVALID_DATA);
  }
  ULONG capacity = needed;
  void *buf = malloc(capacity);
  if (!buf) {
    CloseHandle(h);
    return throw_win(env, "command line allocation", ERROR_NOT_ENOUGH_MEMORY);
  }
  status = query(h, 60, buf, capacity, &needed);
  BOOL closed = CloseHandle(h);
  DWORD close_err = GetLastError();
  if (status < 0 || !closed) {
    free(buf);
    return throw_win(env, status < 0 ? "NtQueryInformationProcess" : "CloseHandle(process)",
                     status < 0 ? (DWORD)status : close_err);
  }
  HK_UNICODE_STRING *s = (HK_UNICODE_STRING *)buf;
  // 系统缓冲区中的字符串也需完整且位于本次分配内，不能返回截断的参数。
  uintptr_t base = (uintptr_t)buf, ptr = (uintptr_t)s->Buffer;
  if (needed < sizeof(*s) || needed > capacity || s->Length % sizeof(wchar_t) != 0 ||
      s->Length > s->MaximumLength || (s->Length &&
      (ptr < base + sizeof(*s) || ptr > base + needed || s->Length > base + needed - ptr))) {
    free(buf);
    return throw_win(env, "command line buffer", ERROR_INVALID_DATA);
  }
  size_t chars = s->Length / sizeof(wchar_t);
  wchar_t *line = malloc((chars + 1) * sizeof(wchar_t));
  if (!line) {
    free(buf);
    return throw_win(env, "command line allocation", ERROR_NOT_ENOUGH_MEMORY);
  }
  if (chars) memcpy(line, s->Buffer, chars * sizeof(wchar_t));
  line[chars] = 0;
  free(buf);
  int argc = 0;
  LPWSTR *args = chars ? CommandLineToArgvW(line, &argc) : NULL;
  free(line);
  if (chars && !args) return throw_win(env, "CommandLineToArgvW", GetLastError());
  napi_value array;
  if (napi_create_array(env, &array) != napi_ok) {
    if (args) LocalFree(args);
    napi_throw_error(env, "EHOSTKIT", "cannot return command line");
    return NULL;
  }
  for (int i = 0; i < argc; i++) {
    napi_value v;
    if (napi_create_string_utf16(env, (const char16_t *)args[i], wcslen(args[i]), &v) != napi_ok ||
        napi_set_element(env, array, (uint32_t)i, v) != napi_ok) {
      LocalFree(args);
      napi_throw_error(env, "EHOSTKIT", "cannot return command line argument");
      return NULL;
    }
  }
  if (args) LocalFree(args);
  return array;
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
  DWORD err = ERROR_SUCCESS;
  HANDLE h = open_live(pid, PROCESS_TERMINATE, start, sizeof(start), &err);
  napi_value result;
  if (!h && err) {
    free(expected);
    return throw_win(env, "OpenProcess/query", err);
  }
  if (!h || strcmp(start, expected) != 0) {
    BOOL closed = !h || CloseHandle(h);
    DWORD close_err = GetLastError();
    free(expected);
    if (!closed) return throw_win(env, "CloseHandle(process)", close_err);
    napi_get_boolean(env, false, &result);
    return result;
  }
  free(expected);
  BOOL ok = TerminateProcess(h, 1);
  err = GetLastError();
  // 访问拒绝也可能发生在仍活着的进程上，不能被折叠成已退出。
  if (!ok && err == ERROR_ACCESS_DENIED && WaitForSingleObject(h, 0) == WAIT_OBJECT_0) {
    if (!CloseHandle(h)) return throw_win(env, "CloseHandle(process)", GetLastError());
    napi_get_boolean(env, false, &result);
    return result;
  }
  BOOL closed = CloseHandle(h);
  DWORD close_err = GetLastError();
  if (!ok) return throw_win(env, "TerminateProcess", err);
  if (!closed) return throw_win(env, "CloseHandle(process)", close_err);
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
  DWORD err = ERROR_SUCCESS;
  HANDLE h = open_live(pid, PROCESS_SET_QUOTA | PROCESS_TERMINATE, start, sizeof(start), &err);
  if (!h) {
    free(expected);
    if (err) return throw_win(env, "OpenProcess/query", err);
    napi_throw_error(env, "ESRCH", "process exited before job assignment");
    return NULL;
  }
  if (strcmp(start, expected) != 0) {
    free(expected);
    CloseHandle(h);
    napi_throw_error(env, "ESRCH", "process identity changed before job assignment");
    return NULL;
  }
  free(expected);
  BOOL ok = AssignProcessToJobObject(job, h);
  err = GetLastError();
  BOOL closed = CloseHandle(h);
  DWORD close_err = GetLastError();
  if (!ok) return throw_win(env, "AssignProcessToJobObject", err);
  if (!closed) return throw_win(env, "CloseHandle(process)", close_err);
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
    if (list->NumberOfProcessIdsInList > capacity) {
      free(list);
      return throw_win(env, "QueryInformationJobObject", ERROR_INVALID_DATA);
    }
    if (list->NumberOfAssignedProcesses > list->NumberOfProcessIdsInList) {
      free(list);
      if (capacity >= 65536)
        return throw_win(env, "QueryInformationJobObject", ERROR_MORE_DATA);
      capacity = capacity > 16384 ? 65536 : capacity * 4;
      continue;
    }
    napi_value array;
    CHECK_RELEASE(napi_create_array(env, &array), free(list));
    for (DWORD i = 0; i < list->NumberOfProcessIdsInList; i++) {
      napi_value v;
      CHECK_RELEASE(napi_create_uint32(env, (uint32_t)list->ProcessIdList[i], &v), free(list));
      CHECK_RELEASE(napi_set_element(env, array, i, v), free(list));
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

static PSID current_user_sid(DWORD *err);

// Creation applies the user-only DACL and explicit owner atomically. Existing
// objects ignore this descriptor, so verify their owner on the opened handle.
static HANDLE user_mutex(const wchar_t *name, DWORD *err) {
  PSID sid = current_user_sid(err);
  if (!sid) {
    if (*err == ERROR_SUCCESS) *err = ERROR_NOT_ENOUGH_MEMORY;
    return NULL;
  }
  EXPLICIT_ACCESSW ea;
  ZeroMemory(&ea, sizeof(ea));
  ea.grfAccessPermissions = MUTEX_ALL_ACCESS;
  ea.grfAccessMode = SET_ACCESS;
  ea.grfInheritance = NO_INHERITANCE;
  ea.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  ea.Trustee.TrusteeType = TRUSTEE_IS_USER;
  ea.Trustee.ptstrName = (LPWSTR)sid;
  PACL acl = NULL;
  HANDLE h = NULL;
  PSECURITY_DESCRIPTOR actual_sd = NULL;
  PSID owner = NULL;
  SECURITY_DESCRIPTOR sd;
  SECURITY_ATTRIBUTES sa;
  *err = SetEntriesInAclW(1, &ea, NULL, &acl);
  if (*err != ERROR_SUCCESS) goto cleanup;
  if (!InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorOwner(&sd, sid, FALSE) ||
      !SetSecurityDescriptorDacl(&sd, TRUE, acl, FALSE) ||
      !SetSecurityDescriptorControl(&sd, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) {
    *err = GetLastError();
    goto cleanup;
  }
  sa.nLength = sizeof(sa);
  sa.lpSecurityDescriptor = &sd;
  sa.bInheritHandle = FALSE;
  h = CreateMutexW(&sa, FALSE, name);
  if (!h) {
    *err = GetLastError();
    goto cleanup;
  }
  *err = GetSecurityInfo(h, SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION, &owner,
                         NULL, NULL, NULL, &actual_sd);
  if (*err == ERROR_SUCCESS && (!owner || !IsValidSid(owner) || !EqualSid(owner, sid))) {
    *err = ERROR_ACCESS_DENIED;
  }

cleanup:
  if (actual_sd) LocalFree(actual_sd);
  if (acl) LocalFree(acl);
  free(sid);
  if (*err != ERROR_SUCCESS && h) {
    CloseHandle(h);
    h = NULL;
  }
  return h;
}

// mutexAcquire(name) -> handle, or -1 when another thread or process owns it.
// A foreign security owner is refused before waiting. An abandoned mutex counts
// as acquired. Mutex ownership is per thread: release on the same thread.
static napi_value mutex_acquire(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!get_args(env, info, 1, argv)) return NULL;
  wchar_t *name = get_wstring(env, argv[0]);
  if (!name) return NULL;
  DWORD err = ERROR_SUCCESS;
  HANDLE h = user_mutex(name, &err);
  free(name);
  if (!h) return throw_win(env, "CreateMutex/owner verification", err);
  DWORD wait = WaitForSingleObject(h, 0);
  err = GetLastError();
  if (wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED) {
    napi_value v;
    if (napi_create_int64(env, (int64_t)(intptr_t)h, &v) == napi_ok) return v;
    ReleaseMutex(h);
    CloseHandle(h);
    napi_throw_error(env, "EHOSTKIT", "cannot return mutex handle");
    return NULL;
  }
  BOOL closed = CloseHandle(h);
  DWORD close_err = GetLastError();
  if (!closed && wait == WAIT_TIMEOUT) return throw_win(env, "CloseHandle(mutex)", close_err);
  if (wait == WAIT_TIMEOUT) {
    napi_value v;
    napi_create_int32(env, -1, &v);
    return v;
  }
  return throw_win(env, "WaitForSingleObject", err);
}

static napi_value mutex_release(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  HANDLE h;
  if (!get_args(env, info, 1, argv) || !get_handle(env, argv[0], &h)) return NULL;
  BOOL released = ReleaseMutex(h);
  DWORD err = GetLastError();
  BOOL closed = CloseHandle(h);
  DWORD close_err = GetLastError();
  if (!released) return throw_win(env, "ReleaseMutex", err);
  if (!closed) return throw_win(env, "CloseHandle(mutex)", close_err);
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
    default: return throw_win(env, "GetDriveType", ERROR_NOT_READY);
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
  BOOL sized = GetTokenInformation(token, TokenUser, NULL, 0, &size);
  *err = GetLastError();
  if (sized || *err != ERROR_INSUFFICIENT_BUFFER || size < sizeof(TOKEN_USER)) {
    CloseHandle(token);
    if (sized || *err == ERROR_INSUFFICIENT_BUFFER) *err = ERROR_INVALID_DATA;
    return NULL;
  }
  TOKEN_USER *user = malloc(size);
  if (!user) {
    *err = ERROR_NOT_ENOUGH_MEMORY;
    CloseHandle(token);
    return NULL;
  }
  if (!GetTokenInformation(token, TokenUser, user, size, &size)) {
    *err = GetLastError();
    free(user);
    CloseHandle(token);
    return NULL;
  }
  if (!CloseHandle(token)) {
    *err = GetLastError();
    free(user);
    return NULL;
  }
  if (!IsValidSid(user->User.Sid)) {
    *err = ERROR_INVALID_SID;
    free(user);
    return NULL;
  }
  DWORD len = GetLengthSid(user->User.Sid);
  PSID sid = malloc(len);
  if (!sid) *err = ERROR_NOT_ENOUGH_MEMORY;
  else if (!CopySid(len, sid, user->User.Sid)) {
    *err = GetLastError();
    free(sid);
    sid = NULL;
  } else *err = ERROR_SUCCESS;
  free(user);
  return sid;
}

static napi_value sid_string(napi_env env, PSID sid) {
  LPWSTR s = NULL;
  if (!sid) return js_null(env);
  if (!ConvertSidToStringSidW(sid, &s)) return throw_win(env, "ConvertSidToStringSid", GetLastError());
  napi_value v;
  napi_status status = napi_create_string_utf16(env, (const char16_t *)s, wcslen(s), &v);
  LocalFree(s);
  if (status != napi_ok) {
    napi_throw_error(env, "EHOSTKIT", "cannot return SID");
    return NULL;
  }
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
  CHECK(napi_get_value_bool(env, argv[1], &is_dir));
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

// createPrivateFile(path): creates a new empty file (fails with EEXIST when it
// exists) whose protected DACL grants only the current user full control. The
// descriptor is applied by CreateFileW itself, so no other user can open the
// file between its creation and setting its permissions.
static napi_value create_private_file(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!get_args(env, info, 1, argv)) return NULL;
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
  ea.grfInheritance = NO_INHERITANCE;
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
  SECURITY_DESCRIPTOR sd;
  if (!InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorDacl(&sd, TRUE, acl, FALSE) ||
      !SetSecurityDescriptorControl(&sd, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) {
    err = GetLastError();
    LocalFree(acl);
    free(sid);
    free(path);
    return throw_win(env, "InitializeSecurityDescriptor", err);
  }
  SECURITY_ATTRIBUTES sa;
  sa.nLength = sizeof(sa);
  sa.lpSecurityDescriptor = &sd;
  sa.bInheritHandle = FALSE;
  HANDLE h = CreateFileW(path, GENERIC_WRITE, 0, &sa, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  err = GetLastError();
  LocalFree(acl);
  free(sid);
  free(path);
  if (h == INVALID_HANDLE_VALUE) return throw_win(env, "CreateFile", err);
  if (!CloseHandle(h)) return throw_win(env, "CloseHandle(file)", GetLastError());
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
  if (!GetSecurityDescriptorControl(sd, &control, &revision)) {
    err = GetLastError();
    LocalFree(sd);
    return throw_win(env, "GetSecurityDescriptorControl", err);
  }
  napi_value obj, v, aces;
  CHECK_RELEASE(napi_create_object(env, &obj), LocalFree(sd));
  v = sid_string(env, owner);
  if (!v) { LocalFree(sd); return NULL; }
  CHECK_RELEASE(napi_set_named_property(env, obj, "owner", v), LocalFree(sd));
  CHECK_RELEASE(napi_get_boolean(env, (control & SE_DACL_PROTECTED) != 0, &v), LocalFree(sd));
  CHECK_RELEASE(napi_set_named_property(env, obj, "protected", v), LocalFree(sd));
  CHECK_RELEASE(napi_get_boolean(env, dacl == NULL, &v), LocalFree(sd));
  CHECK_RELEASE(napi_set_named_property(env, obj, "nullDacl", v), LocalFree(sd));
  CHECK_RELEASE(napi_create_array(env, &aces), LocalFree(sd));
  if (dacl) {
    for (DWORD i = 0; i < dacl->AceCount; i++) {
      ACE_HEADER *header = NULL;
      if (!GetAce(dacl, i, (LPVOID *)&header)) {
        err = GetLastError();
        LocalFree(sd);
        return throw_win(env, "GetAce", err);
      }
      napi_value ace;
      CHECK_RELEASE(napi_create_object(env, &ace), LocalFree(sd));
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
      CHECK_RELEASE(napi_create_string_utf8(env, type, NAPI_AUTO_LENGTH, &v), LocalFree(sd));
      CHECK_RELEASE(napi_set_named_property(env, ace, "type", v), LocalFree(sd));
      v = sid_string(env, sid);
      if (!v) { LocalFree(sd); return NULL; }
      CHECK_RELEASE(napi_set_named_property(env, ace, "sid", v), LocalFree(sd));
      CHECK_RELEASE(napi_create_uint32(env, mask, &v), LocalFree(sd));
      CHECK_RELEASE(napi_set_named_property(env, ace, "mask", v), LocalFree(sd));
      CHECK_RELEASE(napi_set_element(env, aces, i, ace), LocalFree(sd));
    }
  }
  CHECK_RELEASE(napi_set_named_property(env, obj, "aces", aces), LocalFree(sd));
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
    {"createPrivateFile", NULL, create_private_file, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
