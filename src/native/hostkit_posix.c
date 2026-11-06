// pi-hostkit native module for macOS and Linux.
//
// Exposes only the operations Node lacks: flock on a descriptor held by the
// host process, file system locality, (macOS) the process table and extended
// ACLs, and (Linux) pidfd signalling. Linux reads the process table from /proc
// in JavaScript.

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#include <node_api.h>

#ifdef __APPLE__
#include <sys/acl.h>
#include <sys/mount.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#elif defined(__linux__)
#include <signal.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#ifndef SYS_pidfd_open
#define SYS_pidfd_open 434
#endif
#ifndef SYS_pidfd_send_signal
#define SYS_pidfd_send_signal 424
#endif
#ifndef PIDFD_SIGNAL_PROCESS_GROUP
#define PIDFD_SIGNAL_PROCESS_GROUP (1U << 2)
#endif
#else
#error "pi-hostkit supports macOS, Linux and Windows only"
#endif

#define CHECK(call)                                                            \
  do {                                                                         \
    if ((call) != napi_ok) {                                                   \
      napi_throw_error(env, "EHOSTKIT", "N-API call failed: " #call);          \
      return NULL;                                                             \
    }                                                                          \
  } while (0)

static const char *errno_code(int err) {
  switch (err) {
    case EACCES: return "EACCES";
    case EPERM: return "EPERM";
    case ENOENT: return "ENOENT";
    case ENOTDIR: return "ENOTDIR";
    case EISDIR: return "EISDIR";
    case EROFS: return "EROFS";
    case ENOLCK: return "ENOLCK";
    case EBADF: return "EBADF";
    case EINVAL: return "EINVAL";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case ELOOP: return "ELOOP";
    case EMFILE: return "EMFILE";
    case ENFILE: return "ENFILE";
    case ENOTSUP: return "ENOTSUP";
    case ESRCH: return "ESRCH";
    case ENOSYS: return "ENOSYS";
    case ENOMEM: return "ENOMEM";
    default: return "EUNKNOWN";
  }
}

static napi_value throw_errno(napi_env env, const char *op, int err) {
  char message[512];
  snprintf(message, sizeof(message), "%s: %s", op, strerror(err));
  napi_value code, msg, error, errno_value;
  napi_create_string_utf8(env, errno_code(err), NAPI_AUTO_LENGTH, &code);
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &msg);
  napi_create_error(env, code, msg, &error);
  napi_create_int32(env, err, &errno_value);
  napi_set_named_property(env, error, "errno", errno_value);
  napi_throw(env, error);
  return NULL;
}

// Reads argument `index` as a UTF-8 string into a heap buffer. Caller frees.
static char *get_string(napi_env env, napi_callback_info info, size_t index) {
  size_t argc = 4;
  napi_value argv[4];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc <= index) {
    napi_throw_type_error(env, "EINVAL", "string argument required");
    return NULL;
  }
  size_t len = 0;
  if (napi_get_value_string_utf8(env, argv[index], NULL, 0, &len) != napi_ok) {
    napi_throw_type_error(env, "EINVAL", "string argument required");
    return NULL;
  }
  char *buf = malloc(len + 1);
  if (!buf) {
    napi_throw_error(env, "ENOMEM", "out of memory");
    return NULL;
  }
  napi_get_value_string_utf8(env, argv[index], buf, len + 1, &len);
  if (strlen(buf) != len) {
    free(buf);
    napi_throw_type_error(env, "EINVAL", "string must not contain NUL");
    return NULL;
  }
  return buf;
}

static int get_int(napi_env env, napi_callback_info info, size_t index, int32_t *out) {
  size_t argc = 4;
  napi_value argv[4];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc <= index ||
      napi_get_value_int32(env, argv[index], out) != napi_ok) {
    napi_throw_type_error(env, "EINVAL", "integer argument required");
    return 0;
  }
  return 1;
}

// flockAcquire(path) -> fd (>= 0) when the exclusive lock is held, -1 when
// another open file description holds it. The lock file is never deleted.
static napi_value flock_acquire(napi_env env, napi_callback_info info) {
  char *path = get_string(env, info, 0);
  if (!path) return NULL;
  int fd = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
  if (fd < 0) {
    int err = errno;
    free(path);
    return throw_errno(env, "open lock file", err);
  }
  free(path);
  int rc;
  do {
    rc = flock(fd, LOCK_EX | LOCK_NB);
  } while (rc != 0 && errno == EINTR);
  napi_value result;
  if (rc == 0) {
    CHECK(napi_create_int32(env, fd, &result));
    return result;
  }
  int err = errno;
  close(fd);
  if (err == EWOULDBLOCK || err == EAGAIN) {
    CHECK(napi_create_int32(env, -1, &result));
    return result;
  }
  return throw_errno(env, "flock", err);
}

// fdClose(fd): closing the descriptor releases the flock.
static napi_value fd_close(napi_env env, napi_callback_info info) {
  int32_t fd;
  if (!get_int(env, info, 0, &fd)) return NULL;
  if (close(fd) != 0 && errno != EINTR) return throw_errno(env, "close", errno);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value make_fs_info(napi_env env, int local, const char *type) {
  napi_value obj, v;
  CHECK(napi_create_object(env, &obj));
  CHECK(napi_get_boolean(env, local, &v));
  CHECK(napi_set_named_property(env, obj, "local", v));
  CHECK(napi_create_string_utf8(env, type, NAPI_AUTO_LENGTH, &v));
  CHECK(napi_set_named_property(env, obj, "type", v));
  return obj;
}

// fsInfo(path) -> { local, type }
static napi_value fs_info(napi_env env, napi_callback_info info) {
  char *path = get_string(env, info, 0);
  if (!path) return NULL;
#ifdef __APPLE__
  struct statfs s;
  int rc = statfs(path, &s);
  int err = errno;
  free(path);
  if (rc != 0) return throw_errno(env, "statfs", err);
  return make_fs_info(env, (s.f_flags & MNT_LOCAL) != 0, s.f_fstypename);
#else
  struct statfs s;
  int rc = statfs(path, &s);
  int err = errno;
  free(path);
  if (rc != 0) return throw_errno(env, "statfs", err);
  // Network and user-space file systems where flock is unreliable or absent.
  static const struct { unsigned long magic; const char *name; } remote[] = {
    {0x6969UL, "nfs"},          {0x517BUL, "smb"},       {0xFF534D42UL, "cifs"},
    {0xFE534D42UL, "smb2"},     {0x73757245UL, "coda"},  {0x5346414FUL, "afs"},
    {0x01021997UL, "9p"},       {0x65735546UL, "fuse"},  {0x00C36400UL, "ceph"},
    {0x47504653UL, "gpfs"},     {0x0BD00BD0UL, "lustre"}, {0x6B414653UL, "kafs"},
    {0xBEEFDEADUL, "ncp"},      {0x564CUL, "ncpfs"},
  };
  unsigned long magic = (unsigned long)(unsigned int)s.f_type;
  char type[32];
  snprintf(type, sizeof(type), "0x%lx", magic);
  for (size_t i = 0; i < sizeof(remote) / sizeof(remote[0]); i++) {
    if (remote[i].magic == magic) return make_fs_info(env, 0, remote[i].name);
  }
  return make_fs_info(env, 1, type);
#endif
}

#ifdef __APPLE__
// The process table comes from sysctl(KERN_PROC): one consistent snapshot in
// which parent, group and start time belong to the same process, readable for
// processes of every user.
static napi_value process_object(napi_env env, const struct kinfo_proc *k) {
  napi_value obj, v;
  char start[64];
  snprintf(start, sizeof(start), "%llu.%06llu", (unsigned long long)k->kp_proc.p_starttime.tv_sec,
           (unsigned long long)k->kp_proc.p_starttime.tv_usec);
  CHECK(napi_create_object(env, &obj));
  CHECK(napi_create_int32(env, (int32_t)k->kp_proc.p_pid, &v));
  CHECK(napi_set_named_property(env, obj, "pid", v));
  CHECK(napi_create_int32(env, (int32_t)k->kp_eproc.e_ppid, &v));
  CHECK(napi_set_named_property(env, obj, "ppid", v));
  CHECK(napi_create_int32(env, (int32_t)k->kp_eproc.e_pgid, &v));
  CHECK(napi_set_named_property(env, obj, "pgid", v));
  CHECK(napi_create_string_utf8(env, start, NAPI_AUTO_LENGTH, &v));
  CHECK(napi_set_named_property(env, obj, "startTime", v));
  CHECK(napi_get_boolean(env, k->kp_proc.p_stat == SZOMB, &v));
  CHECK(napi_set_named_property(env, obj, "zombie", v));
  return obj;
}

// processInfo(pid) -> { pid, ppid, pgid, startTime, zombie } | null. Null only
// when the process does not exist; query failures throw.
static napi_value process_info(napi_env env, napi_callback_info info) {
  int32_t pid;
  if (!get_int(env, info, 0, &pid)) return NULL;
  napi_value null_value;
  napi_get_null(env, &null_value);
  if (pid <= 0) return null_value;
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
  struct kinfo_proc k;
  size_t len = sizeof(k);
  if (sysctl(mib, 4, &k, &len, NULL, 0) != 0) return throw_errno(env, "sysctl(KERN_PROC_PID)", errno);
  if (len < sizeof(k)) return null_value;
  return process_object(env, &k);
}

// listProcesses() -> processInfo objects for every process.
static napi_value list_processes(napi_env env, napi_callback_info info) {
  (void)info;
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0};
  struct kinfo_proc *procs = NULL;
  size_t len = 0;
  for (int attempt = 0; attempt < 8; attempt++) {
    if (sysctl(mib, 4, NULL, &len, NULL, 0) != 0) return throw_errno(env, "sysctl(KERN_PROC_ALL)", errno);
    len += len / 4 + 16 * sizeof(struct kinfo_proc);
    procs = malloc(len);
    if (!procs) return throw_errno(env, "sysctl(KERN_PROC_ALL)", ENOMEM);
    if (sysctl(mib, 4, procs, &len, NULL, 0) == 0) break;
    int err = errno;
    free(procs);
    procs = NULL;
    if (err != ENOMEM) return throw_errno(env, "sysctl(KERN_PROC_ALL)", err);
  }
  if (!procs) return throw_errno(env, "sysctl(KERN_PROC_ALL)", ENOMEM);
  napi_value array;
  if (napi_create_array(env, &array) != napi_ok) {
    free(procs);
    return NULL;
  }
  size_t count = len / sizeof(struct kinfo_proc);
  uint32_t index = 0;
  for (size_t i = 0; i < count; i++) {
    if (procs[i].kp_proc.p_pid <= 0) continue;
    napi_value obj = process_object(env, &procs[i]);
    if (!obj) {
      free(procs);
      return NULL;
    }
    napi_set_element(env, array, index++, obj);
  }
  free(procs);
  return array;
}

// processArgs(pid) -> string[] | null, from KERN_PROCARGS2.
static napi_value process_args(napi_env env, napi_callback_info info) {
  int32_t pid;
  if (!get_int(env, info, 0, &pid)) return NULL;
  napi_value null_value;
  napi_get_null(env, &null_value);
  int argmax = 0;
  size_t size = sizeof(argmax);
  int mib_max[2] = {CTL_KERN, KERN_ARGMAX};
  if (sysctl(mib_max, 2, &argmax, &size, NULL, 0) != 0 || argmax <= 0) return null_value;
  char *buf = malloc((size_t)argmax);
  if (!buf) return null_value;
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
  size = (size_t)argmax;
  if (sysctl(mib, 3, buf, &size, NULL, 0) != 0 || size < sizeof(int)) {
    free(buf);
    return null_value;
  }
  int argc;
  memcpy(&argc, buf, sizeof(argc));
  char *p = buf + sizeof(int);
  char *end = buf + size;
  // Skip the executable path and the NUL padding after it.
  while (p < end && *p) p++;
  while (p < end && !*p) p++;
  napi_value array;
  if (napi_create_array(env, &array) != napi_ok) {
    free(buf);
    return NULL;
  }
  for (int i = 0; i < argc && p < end; i++) {
    char *start = p;
    while (p < end && *p) p++;
    napi_value s;
    napi_create_string_utf8(env, start, (size_t)(p - start), &s);
    napi_set_element(env, array, (uint32_t)i, s);
    p++;
  }
  free(buf);
  return array;
}

// aclEntryCount(path) -> number of extended ACL entries (0 when none). Does
// not follow a final symbolic link.
static napi_value acl_entry_count(napi_env env, napi_callback_info info) {
  char *path = get_string(env, info, 0);
  if (!path) return NULL;
  acl_t acl = acl_get_link_np(path, ACL_TYPE_EXTENDED);
  int err = errno;
  free(path);
  napi_value result;
  if (!acl) {
    if (err == ENOENT) {
      CHECK(napi_create_int32(env, 0, &result));
      return result;
    }
    return throw_errno(env, "acl_get_link_np", err);
  }
  int count = 0;
  acl_entry_t entry;
  int id = ACL_FIRST_ENTRY;
  while (acl_get_entry(acl, id, &entry) == 0) {
    count++;
    id = ACL_NEXT_ENTRY;
  }
  acl_free(acl);
  CHECK(napi_create_int32(env, count, &result));
  return result;
}

// aclClear(path): removes every extended ACL entry.
static napi_value acl_clear(napi_env env, napi_callback_info info) {
  char *path = get_string(env, info, 0);
  if (!path) return NULL;
  acl_t acl = acl_init(0);
  if (!acl) {
    int err = errno;
    free(path);
    return throw_errno(env, "acl_init", err);
  }
  int rc = acl_set_link_np(path, ACL_TYPE_EXTENDED, acl);
  int err = errno;
  acl_free(acl);
  free(path);
  if (rc != 0) return throw_errno(env, "acl_set_link_np", err);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}
#endif

#ifdef __linux__
// pidfdOpen(pid) -> fd, or -1 when the process does not exist. Throws ENOSYS
// on kernels without pidfd (before 5.3).
static napi_value pidfd_open(napi_env env, napi_callback_info info) {
  int32_t pid;
  if (!get_int(env, info, 0, &pid)) return NULL;
  long fd = syscall(SYS_pidfd_open, (pid_t)pid, 0);
  napi_value result;
  if (fd < 0) {
    if (errno == ESRCH) {
      CHECK(napi_create_int32(env, -1, &result));
      return result;
    }
    return throw_errno(env, "pidfd_open", errno);
  }
  CHECK(napi_create_int32(env, (int32_t)fd, &result));
  return result;
}

// pidfdSignal(fd, signo, group) -> true when sent, false when the process has
// exited. `group` signals the process group of the pidfd's process (Linux
// 6.9+; older kernels throw EINVAL).
static napi_value pidfd_signal(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  int32_t fd, signo;
  bool group = false;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 3 ||
      napi_get_value_int32(env, argv[0], &fd) != napi_ok ||
      napi_get_value_int32(env, argv[1], &signo) != napi_ok ||
      napi_get_value_bool(env, argv[2], &group) != napi_ok) {
    napi_throw_type_error(env, "EINVAL", "pidfdSignal(fd, signo, group) required");
    return NULL;
  }
  long rc = syscall(SYS_pidfd_send_signal, fd, signo, NULL, group ? PIDFD_SIGNAL_PROCESS_GROUP : 0U);
  napi_value result;
  if (rc != 0) {
    if (errno == ESRCH) {
      CHECK(napi_get_boolean(env, false, &result));
      return result;
    }
    return throw_errno(env, "pidfd_send_signal", errno);
  }
  CHECK(napi_get_boolean(env, true, &result));
  return result;
}
#endif

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    {"flockAcquire", NULL, flock_acquire, NULL, NULL, NULL, napi_default, NULL},
    {"fdClose", NULL, fd_close, NULL, NULL, NULL, napi_default, NULL},
    {"fsInfo", NULL, fs_info, NULL, NULL, NULL, napi_default, NULL},
#ifdef __APPLE__
    {"processInfo", NULL, process_info, NULL, NULL, NULL, napi_default, NULL},
    {"listProcesses", NULL, list_processes, NULL, NULL, NULL, napi_default, NULL},
    {"processArgs", NULL, process_args, NULL, NULL, NULL, napi_default, NULL},
    {"aclEntryCount", NULL, acl_entry_count, NULL, NULL, NULL, napi_default, NULL},
    {"aclClear", NULL, acl_clear, NULL, NULL, NULL, napi_default, NULL},
#endif
#ifdef __linux__
    {"pidfdOpen", NULL, pidfd_open, NULL, NULL, NULL, napi_default, NULL},
    {"pidfdSignal", NULL, pidfd_signal, NULL, NULL, NULL, napi_default, NULL},
#endif
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
