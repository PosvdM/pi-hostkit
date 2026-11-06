import { existsSync } from "node:fs";
import path from "node:path";
import { native, type NativeFsInfo } from "./native.js";

/** File system of `target` (or of its deepest existing ancestor). */
export function filesystemInfo(target: string): NativeFsInfo & { path: string } {
  let current = path.resolve(target);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { ...native().fsInfo(current), path: current };
}

/**
 * Throws `EHOSTKIT_REMOTE_FS` when `target` is on a network or user-space file
 * system, where `flock` and atomic rename are not reliable. Data and lock
 * directories must be on local disk.
 */
export function assertLocalFilesystem(target: string): void {
  const info = filesystemInfo(target);
  if (!info.local) {
    throw Object.assign(new Error(`${target} is on a non-local file system (${info.type}); use a local disk`), {
      code: "EHOSTKIT_REMOTE_FS",
      path: target,
      fsType: info.type,
    });
  }
}
