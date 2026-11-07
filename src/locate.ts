import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { resolveToolPath } from "./paths.js";

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

function missingInstall(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EHOSTKIT_PI_NOT_FOUND";
}

async function readPackage(dir: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  } catch (error) {
    if (missingInstall(error) || error instanceof SyntaxError) return undefined;
    throw error;
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
  if (typeof relative !== "string" || !relative) throw hostkitError("EHOSTKIT_PI_NOT_FOUND", `${packageDir}/package.json has no bin.pi`);
  const cliEntry = path.join(packageDir, relative);
  let cliInfo;
  try {
    cliInfo = await stat(cliEntry);
  } catch (error) {
    if (!missingInstall(error)) throw error;
    throw hostkitError("EHOSTKIT_PI_NOT_FOUND", `pi entry ${cliEntry} does not exist`);
  }
  if (!cliInfo.isFile()) {
    throw hostkitError("EHOSTKIT_PI_NOT_FOUND", `pi entry ${cliEntry} is not a file`);
  }
  const version = String(pkg.version ?? "");
  return { packageDir, cliEntry, version, supported: isSupportedPiVersion(version) };
}

async function fromPiPath(piPath: string): Promise<PiInstall> {
  let info;
  try {
    info = await stat(piPath);
  } catch (error) {
    if (!missingInstall(error)) throw error;
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

function managedInstallRoots(): string[] {
  const roots: string[] = [];
  const configuredRoot = process.env.PI_MANAGED_INSTALL_ROOT?.trim();
  if (configuredRoot) roots.push(path.resolve(configuredRoot));
  const configuredAgent = process.env.PI_CODING_AGENT_DIR;
  if (configuredAgent) {
    // The base uses pi normalizePath defaults: preserve Unicode spaces and a leading @.
    const agent = resolveToolPath(".", configuredAgent);
    roots.push(path.resolve(agent, "install"));
  }
  roots.push(path.join(homedir(), ".pi", "agent", "install"));
  return [...new Set(roots)];
}

async function fromManagedInstall(root: string): Promise<PiInstall | undefined> {
  try {
    const marker = JSON.parse((await readFile(path.join(root, "managed-install.json"), "utf8")).replace(/^\uFEFF/, ""));
    if (!marker || typeof marker !== "object" || marker.kind !== "pi-managed-install" || marker.schemaVersion !== 1 || marker.layout !== "releases-v1") return undefined;
    const version = (await readFile(path.join(root, "current-version"), "utf8")).trim();
    // A release identifier is a single directory name, never a relative path.
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) return undefined;
    const install = await installAt(path.join(root, "releases", version, "node_modules", ...PI_PACKAGE_NAME.split("/")));
    return install.version === version ? install : undefined;
  } catch (error) {
    // 缺失或损坏的安装可以回退；权限和 I/O 错误不能证明候选不可用。
    if (missingInstall(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
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
 * Finds pi through `piPath`, the official managed installation, then
 * `<npm root -g>/@earendil-works/pi-coding-agent`. Managed roots come from
 * `PI_MANAGED_INSTALL_ROOT`, `PI_CODING_AGENT_DIR/install`, then `~/.pi/agent/install`.
 * The npm root is cached for the lifetime of the process. Throws
 * `EHOSTKIT_PI_NOT_FOUND` when pi is not found.
 * Callers refuse to start managed sessions when `supported` is false.
 */
export async function locatePi(opts: LocatePiOptions = {}): Promise<PiInstall> {
  if (opts.piPath) return fromPiPath(opts.piPath);
  for (const root of managedInstallRoots()) {
    const install = await fromManagedInstall(root);
    if (install) return install;
  }
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
  } catch (error) {
    if (!missingInstall(error)) throw error;
    throw hostkitError(
      "EHOSTKIT_PI_NOT_FOUND",
      `pi is not installed globally (looked in ${dir}); install ${PI_PACKAGE_NAME} or set piPath`,
    );
  }
}
