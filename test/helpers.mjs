import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { locatePi } from "../dist/index.js";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const providerPath = path.join(here, "fixtures", "fake-provider.ts");
export const isWin = process.platform === "win32";
/** CI runs the suite a second time on Linux with `snapshot` to cover the fallback. */
export const containment = process.env.HOSTKIT_TEST_CONTAINMENT || "auto";
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(fn, ms = 10_000, interval = 25) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`condition not met within ${ms} ms: ${fn}`);
    await delay(interval);
  }
}

let pi;
/** pi from PI_PACKAGE, or the global installation. */
export async function piInstall() {
  pi ??= await locatePi(process.env.PI_PACKAGE ? { piPath: process.env.PI_PACKAGE } : {});
  return pi;
}

/** Temporary directory removed by the returned cleanup unless KEEP_FIXTURES is set. */
export async function tempDir(prefix = "hostkit-") {
  // realpath: macOS tmpdir is a symbolic link (/var -> /private/var).
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  return {
    dir,
    async cleanup() {
      if (!process.env.KEEP_FIXTURES) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

/**
 * Isolated pi fixture: cwd, HOME and agent directory under one temp root, the
 * scripted provider, and a script file. `env` is the environment for pi.
 */
export async function piFixture(script = { turns: [] }) {
  const { dir: root, cleanup } = await tempDir("hostkit-pi-");
  const cwd = path.join(root, "cwd");
  const home = path.join(root, "home");
  const agentDir = path.join(root, "agent");
  const scriptPath = path.join(root, "script.json");
  const requestLog = path.join(root, "requests.jsonl");
  await Promise.all([cwd, home, agentDir, path.join(root, "tmp"), path.join(agentDir, "sessions")].map((d) => mkdir(d, { recursive: true })));
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "p0-fake",
      defaultModel: "scripted",
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
      enableInstallTelemetry: false,
      enableAnalytics: false,
      packages: [],
    }),
  );
  await writeFile(scriptPath, JSON.stringify(script));
  const env = {
    PATH: process.env.PATH ?? "",
    LANG: "en_US.UTF-8",
    TERM: "dumb",
    HOME: home,
    USERPROFILE: home,
    TMPDIR: path.join(root, "tmp"),
    TEMP: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: path.join(agentDir, "sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    FAKE_SCRIPT_PATH: scriptPath,
    FAKE_REQUEST_LOG: requestLog,
  };
  if (isWin) {
    // Windows needs these to start processes and find Git Bash.
    for (const key of ["SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "APPDATA"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  return {
    root,
    cwd,
    home,
    agentDir,
    env,
    sessionPath: (name) => path.join(agentDir, "sessions", `${name}.jsonl`),
    async setScript(value) {
      await writeFile(scriptPath, JSON.stringify(value));
    },
    cleanup,
  };
}

/** pi argv for spawnManaged: RPC mode with the scripted provider and no other resources. */
export async function piArgv(extra = []) {
  const { cliEntry } = await piInstall();
  return [cliEntry, "--mode", "rpc", "--offline", "-ne", "-ns", "-np", "--no-themes", "-e", providerPath, ...extra];
}

/** Waits for an RPC event matching `predicate`. */
export function waitForEvent(rpc, predicate, ms = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`event not seen within ${ms} ms`));
    }, ms);
    const off = rpc.onEvent((event) => {
      if (predicate(event)) {
        clearTimeout(timer);
        off();
        resolve(event);
      }
    });
  });
}

/** True when a process with this PID exists (any start time). */
export function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
