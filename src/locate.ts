import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
/** Supported pi versions: `>=1.5.0 <1.6.0`. */
export const SUPPORTED_PI_RANGE = { min: [1, 5, 0], below: [1, 6, 0] } as const;

export interface PiInstall {
  /** `@earendil-works/pi-coding-agent` package directory (real path). */
  packageDir: string;
  /** `bin.pi` from package.json (`dist/bundle/cli.js` in 1.5.0). */
  cliEntry: string;
  version: string;
  /** Whether `version` is within `SUPPORTED_PI_RANGE`. */
  supported: boolean;
}

export interface LocatePiOptions {
  /** Package directory or the `cli.js` file inside it. */
  piPath?: string;
}

function hostkitError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** True for `x.y.z` (no prerelease) within the supported range. */
export function isSupportedPiVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const v = match.slice(1).map(Number);
  const cmp = (a: readonly number[], b: readonly number[]) => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return 0;
  };
  return cmp(v, SUPPORTED_PI_RANGE.min) >= 0 && cmp(v, SUPPORTED_PI_RANGE.below) < 0;
}

async function readPackage(dir: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

async function installAt(dir: string): Promise<PiInstall> {
  const packageDir = await realpath(dir);
  const pkg = await readPackage(packageDir);
  if (!pkg || pkg.name !== PI_PACKAGE_NAME) {
    throw hostkitError("EHOSTKIT_PI_NOT_FOUND", `${packageDir} is not the ${PI_PACKAGE_NAME} package`);
  }
  const bin = pkg.bin;
  const relative = typeof bin === "string" ? bin : (bin as Record<string, string> | undefined)?.pi;
  if (!relative) throw hostkitError("EHOSTKIT_PI_NOT_FOUND", `${packageDir}/package.json has no bin.pi`);
  const cliEntry = path.join(packageDir, relative);
  try {
    await stat(cliEntry);
  } catch {
    throw hostkitError("EHOSTKIT_PI_NOT_FOUND", `pi entry ${cliEntry} does not exist`);
  }
  const version = String(pkg.version ?? "");
  return { packageDir, cliEntry, version, supported: isSupportedPiVersion(version) };
}

async function fromPiPath(piPath: string): Promise<PiInstall> {
  let info;
  try {
    info = await stat(piPath);
  } catch {
    throw hostkitError("EHOSTKIT_PI_NOT_FOUND", `piPath ${piPath} does not exist`);
  }
  if (info.isDirectory()) return installAt(piPath);
  // A file inside the package (normally dist/bundle/cli.js): walk up to the package root.
  let dir = path.dirname(await realpath(piPath));
  for (let i = 0; i < 6; i++) {
    const pkg = await readPackage(dir);
    if (pkg?.name === PI_PACKAGE_NAME) return installAt(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw hostkitError("EHOSTKIT_PI_NOT_FOUND", `piPath ${piPath} is not inside the ${PI_PACKAGE_NAME} package`);
}

function npmRootGlobal(): Promise<string> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, stdout: string) => {
      if (error) reject(hostkitError("EHOSTKIT_PI_NOT_FOUND", `npm root -g failed: ${error.message}`));
      else resolve(stdout.trim());
    };
    if (process.platform === "win32") {
      // npm is a .cmd script on Windows. Fixed arguments, no external input.
      const cmd = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
      execFile(cmd, ["/d", "/s", "/c", "npm root -g"], { windowsVerbatimArguments: true, windowsHide: true, timeout: 30_000 }, (e, out) =>
        done(e, String(out)),
      );
    } else {
      execFile("npm", ["root", "-g"], { timeout: 30_000 }, (e, out) => done(e, String(out)));
    }
  });
}

let globalRoot: Promise<string> | undefined;

/**
 * Finds the pi installation: `piPath` when given, otherwise
 * `<npm root -g>/@earendil-works/pi-coding-agent`. The npm root is cached for
 * the lifetime of the process. Throws `EHOSTKIT_PI_NOT_FOUND` when pi is not found.
 * Callers refuse to start managed sessions when `supported` is false.
 */
export async function locatePi(opts: LocatePiOptions = {}): Promise<PiInstall> {
  if (opts.piPath) return fromPiPath(opts.piPath);
  globalRoot ??= npmRootGlobal();
  let root: string;
  try {
    root = await globalRoot;
  } catch (error) {
    globalRoot = undefined;
    throw error;
  }
  const dir = path.join(root, ...PI_PACKAGE_NAME.split("/"));
  try {
    return await installAt(dir);
  } catch {
    throw hostkitError(
      "EHOSTKIT_PI_NOT_FOUND",
      `pi is not installed globally (looked in ${dir}); install ${PI_PACKAGE_NAME} or set piPath`,
    );
  }
}
