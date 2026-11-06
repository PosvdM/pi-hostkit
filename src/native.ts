import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Process table row returned by the native module (macOS, Windows). */
export interface NativeProcessRow {
  pid: number;
  ppid: number;
  pgid?: number; // macOS only
  startTime: string;
  zombie: boolean;
}

export interface NativeFsInfo {
  local: boolean;
  type: string;
}

export interface NativeAcl {
  owner: string | null;
  protected: boolean;
  nullDacl: boolean;
  aces: { type: "allow" | "deny" | "other"; sid: string | null; mask: number }[];
}

/** Functions exported by `src/native/hostkit_posix.c` and `src/native/hostkit_win.c`. */
export interface NativeBinding {
  fsInfo(path: string): NativeFsInfo;
  // POSIX
  flockAcquire?(path: string): number;
  fdClose?(fd: number): void;
  // macOS and Windows
  processInfo?(pid: number): NativeProcessRow | null;
  listProcesses?(): NativeProcessRow[];
  // macOS
  processArgs?(pid: number): string[] | null;
  aclEntryCount?(path: string): number;
  aclClear?(path: string): void;
  // Linux
  pidfdOpen?(pid: number): number;
  pidfdSignal?(fd: number, signo: number, group: boolean): boolean;
  // Windows
  processCommandLine?(pid: number): string[] | null;
  terminateProcess?(pid: number, startTime: string): boolean;
  jobCreate?(): number;
  jobAssign?(job: number, pid: number, startTime: string): void;
  jobTerminate?(job: number): void;
  jobProcessIds?(job: number): number[];
  handleClose?(handle: number): void;
  mutexAcquire?(name: string): number;
  mutexRelease?(handle: number): void;
  userSid?(): string;
  setPrivateAcl?(path: string, isDirectory: boolean): void;
  readAcl?(path: string): NativeAcl;
  createPrivateFile?(path: string): void;
}

let binding: NativeBinding | undefined;

/** Loads the native module on first use, so pure modules such as `paths` work without it. */
export function native(): NativeBinding {
  if (!binding) {
    const require = createRequire(import.meta.url);
    const load = require("node-gyp-build") as (dir: string) => NativeBinding;
    binding = load(join(dirname(fileURLToPath(import.meta.url)), ".."));
  }
  return binding;
}

/** Returns a native function or throws when this platform's module lacks it. */
export function nativeFn<K extends keyof NativeBinding>(name: K): NonNullable<NativeBinding[K]> {
  const fn = native()[name];
  if (typeof fn !== "function") {
    throw Object.assign(new Error(`pi-hostkit native function ${String(name)} is not available on ${process.platform}`), {
      code: "ENOTSUP",
    });
  }
  return (fn as Function).bind(native()) as NonNullable<NativeBinding[K]>;
}
