import { statSync } from "node:fs";

/** Internal existence check: only a confirmed missing path is false. */
export function pathExistsStrict(target: string): boolean {
  try {
    statSync(target);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENODEV") return false;
    throw error;
  }
}
