// pi-hostkit native module for macOS and Linux.
//
// Exposes only the operations Node lacks: flock on a descriptor held by the
// host process, file system locality, and (macOS) the process table. Linux
// reads the process table from /proc in JavaScript.

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
#include <libproc.h>
#include <sys/mount.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#elif defined(__linux__)
#include <sys/vfs.h>
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
static napi_value process_object(napi_env env, const struct proc_bsdinfo *p) {
  napi_value obj, v;
  char start[64];
  snprintf(start, sizeof(start), "%llu.%06llu", (unsigned long long)p->pbi_start_tvsec,
           (unsigned long long)p->pbi_start_tvusec);
  CHECK(napi_create_object(env, &obj));
  CHECK(napi_create_int32(env, (int32_t)p->pbi_pid, &v));
  CHECK(napi_set_named_property(env, obj, "pid", v));
  CHECK(napi_create_int32(env, (int32_t)p->pbi_ppid, &v));
  CHECK(napi_set_named_property(env, obj, "ppid", v));
  CHECK(napi_create_int32(env, (int32_t)p->pbi_pgid, &v));
  CHECK(napi_set_named_property(env, obj, "pgid", v));
  CHECK(napi_create_string_utf8(env, start, NAPI_AUTO_LENGTH, &v));
  CHECK(napi_set_named_property(env, obj, "startTime", v));
  CHECK(napi_get_boolean(env, p->pbi_status == SZOMB, &v));
  CHECK(napi_set_named_property(env, obj, "zombie", v));
  return obj;
}

static int read_bsdinfo(pid_t pid, struct proc_bsdinfo *out) {
  int n = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, out, sizeof(*out));
  return n == (int)sizeof(*out);
}

// processInfo(pid) -> { pid, ppid, pgid, startTime, zombie } | null
static napi_value process_info(napi_env env, napi_callback_info info) {
  int32_t pid;
  if (!get_int(env, info, 0, &pid)) return NULL;
  struct proc_bsdinfo p;
  if (pid <= 0 || !read_bsdinfo(pid, &p)) {
    napi_value null_value;
    napi_get_null(env, &null_value);
    return null_value;
  }
  return process_object(env, &p);
}

// listProcesses() -> array of processInfo objects visible to this user.
static napi_value list_processes(napi_env env, napi_callback_info info) {
  (void)info;
  int bytes = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
  if (bytes <= 0) return throw_errno(env, "proc_listpids", errno);
  int cap = bytes + 1024 * (int)sizeof(pid_t);
  pid_t *pids = calloc(1, (size_t)cap);
  if (!pids) return throw_errno(env, "proc_listpids", ENOMEM);
  bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, cap);
  if (bytes <= 0) {
    int err = errno;
    free(pids);
    return throw_errno(env, "proc_listpids", err);
  }
  napi_value array;
  if (napi_create_array(env, &array) != napi_ok) {
    free(pids);
    return NULL;
  }
  uint32_t index = 0;
  for (int i = 0; i < bytes / (int)sizeof(pid_t); i++) {
    struct proc_bsdinfo p;
    if (pids[i] > 0 && read_bsdinfo(pids[i], &p)) {
      napi_value obj = process_object(env, &p);
      if (!obj) {
        free(pids);
        return NULL;
      }
      napi_set_element(env, array, index++, obj);
    }
  }
  free(pids);
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
#endif
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
