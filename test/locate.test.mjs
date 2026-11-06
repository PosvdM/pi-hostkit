import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const packageParts = ["@earendil-works", "pi-coding-agent"];
const marker = { kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" };
const locateUrl = new URL("../dist/locate.js", import.meta.url).href;

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "hostkit-locate-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  await mkdir(home);
  return { root, home, defaultRoot: path.join(home, ".pi", "agent", "install") };
}

async function packageAt(dir, version = "1.5.0", { cli = true } = {}) {
  await mkdir(path.join(dir, "dist", "bundle"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({
    name: packageParts.join("/"), version, bin: { pi: "dist/bundle/cli.js" },
  }));
  if (cli) await writeFile(path.join(dir, "dist", "bundle", "cli.js"), "// fixture\n");
  return dir;
}

async function managedAt(root, version = "1.5.0", options = {}) {
  const dir = await packageAt(path.join(root, "releases", version, "node_modules", ...packageParts), options.packageVersion ?? version, options);
  await writeFile(path.join(root, "managed-install.json"), `\uFEFF${JSON.stringify(options.marker ?? marker)}`);
  await writeFile(path.join(root, "current-version"), options.currentVersion ?? `${version}\r\n`);
  return dir;
}

// The child has a temporary HOME and an isolated npm stub. It never invokes the installed npm.
async function locateIn(home, env = {}, actions = [{}]) {
  const script = `
    import { readFile, writeFile } from "node:fs/promises";
    import path from "node:path";
    let source = await readFile(new URL(${JSON.stringify(locateUrl)}), "utf8");
    source += '\\nlet testNpmCalls = 0; npmRootGlobal = async () => { testNpmCalls++; if (!process.env.HOSTKIT_TEST_NPM_ROOT) throw Object.assign(new Error("npm unavailable"), { code: "EHOSTKIT_PI_NOT_FOUND" }); return process.env.HOSTKIT_TEST_NPM_ROOT; }; export function npmCalls() { return testNpmCalls; }';
    const mod = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
    const results = [];
    for (const action of JSON.parse(process.env.HOSTKIT_TEST_ACTIONS)) {
      if (action.env) Object.assign(process.env, action.env);
      if (action.activate) await writeFile(path.join(action.activate.root, "current-version"), action.activate.version + "\\n");
      try { results.push({ install: await mod.locatePi(action.piPath ? { piPath: action.piPath } : {}) }); }
      catch (error) { results.push({ error: error.code }); }
    }
    console.log(JSON.stringify({ results, npmCalls: mod.npmCalls() }));
  `;
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PI_MANAGED_INSTALL_ROOT: "",
      PI_CODING_AGENT_DIR: "",
      HOSTKIT_TEST_NPM_ROOT: "",
      ...env,
      HOSTKIT_TEST_ACTIONS: JSON.stringify(actions),
    },
    timeout: 10_000,
  });
  return JSON.parse(stdout);
}

test("explicit piPath wins over managed installs and invalid explicit paths never fall back", async (t) => {
  const f = await fixture(t);
  await managedAt(f.defaultRoot, "1.5.1");
  const explicit = await packageAt(path.join(f.root, "explicit"));
  const cli = path.join(explicit, "dist", "bundle", "cli.js");
  const result = await locateIn(f.home, {}, [{ piPath: explicit }, { piPath: cli }, { piPath: path.join(f.root, "missing") }]);
  assert.equal(result.npmCalls, 0);
  assert.equal(result.results[0].install.packageDir, explicit);
  assert.deepEqual(result.results[0], result.results[1]);
  assert.deepEqual(result.results[2], { error: "EHOSTKIT_PI_NOT_FOUND" });
});

test("default official layout is found without npm and only current-version selects the release", async (t) => {
  const f = await fixture(t);
  const active = await managedAt(f.defaultRoot, "1.5.0");
  await packageAt(path.join(f.defaultRoot, "releases", "1.5.9", "node_modules", ...packageParts), "1.5.9");
  const result = await locateIn(f.home);
  assert.equal(result.npmCalls, 0);
  assert.equal(result.results[0].install.packageDir, active);
  assert.equal(result.results[0].install.supported, true);
});

test("managed root env, agent env, and default HOME layout are tried in order", async (t) => {
  const f = await fixture(t);
  const managedRoot = path.join(f.root, "managed override");
  const agent = path.join(f.home, "custom-agent");
  const configured = await managedAt(managedRoot, "1.5.1");
  const byAgent = await managedAt(path.join(agent, "install"), "1.5.2");
  const byHome = await managedAt(f.defaultRoot, "1.5.3");
  const result = await locateIn(f.home, { PI_MANAGED_INSTALL_ROOT: ` ${managedRoot} `, PI_CODING_AGENT_DIR: "~/custom-agent" }, [
    {}, { env: { PI_MANAGED_INSTALL_ROOT: "" } }, { env: { PI_CODING_AGENT_DIR: "" } },
  ]);
  assert.equal(result.npmCalls, 0);
  assert.deepEqual(result.results.map((r) => r.install.packageDir), [configured, byAgent, byHome]);
});

test("managed activation is reread and an unsupported active release is not hidden by npm", async (t) => {
  const f = await fixture(t);
  const first = await managedAt(f.defaultRoot, "1.5.0");
  const second = await packageAt(path.join(f.defaultRoot, "releases", "1.6.0", "node_modules", ...packageParts), "1.6.0");
  const result = await locateIn(f.home, {}, [{}, { activate: { root: f.defaultRoot, version: "1.6.0" } }]);
  assert.equal(result.npmCalls, 0);
  assert.deepEqual(result.results.map((r) => r.install.packageDir), [first, second]);
  assert.equal(result.results[1].install.supported, false);
});

test("invalid or incomplete managed installs fall back to the npm root", async (t) => {
  for (const [name, options] of Object.entries({
    "wrong marker": { marker: { ...marker, layout: "unknown" } },
    "wrong kind": { marker: { ...marker, kind: "other" } },
    "wrong schema": { marker: { ...marker, schemaVersion: 2 } },
    "traversal version": { currentVersion: "../../outside" },
    "absolute version": { currentVersion: "/outside" },
    "missing release": { currentVersion: "1.5.8" },
    "version mismatch": { packageVersion: "1.5.2" },
    "missing CLI": { cli: false },
  })) {
    await t.test(name, async (t) => {
      const f = await fixture(t);
      await managedAt(f.defaultRoot, "1.5.0", options);
      const npmRoot = path.join(f.root, "npm", "node_modules");
      const global = await packageAt(path.join(npmRoot, ...packageParts), "1.5.4");
      const result = await locateIn(f.home, { HOSTKIT_TEST_NPM_ROOT: npmRoot }, [{}, {}]);
      assert.equal(result.npmCalls, 1, "the npm root remains cached");
      assert.deepEqual(result.results.map((r) => r.install.packageDir), [global, global]);
    });
  }
});

test("missing official installs use npm and a missing npm install reports EHOSTKIT_PI_NOT_FOUND", async (t) => {
  const f = await fixture(t);
  const npmRoot = path.join(f.root, "npm", "node_modules");
  const absent = await locateIn(f.home, { HOSTKIT_TEST_NPM_ROOT: npmRoot });
  assert.deepEqual(absent.results, [{ error: "EHOSTKIT_PI_NOT_FOUND" }]);
  assert.equal(absent.npmCalls, 1);
  const unavailable = await locateIn(f.home, {}, [{}, {}]);
  assert.deepEqual(unavailable.results, [{ error: "EHOSTKIT_PI_NOT_FOUND" }, { error: "EHOSTKIT_PI_NOT_FOUND" }]);
  assert.equal(unavailable.npmCalls, 2, "a failed npm-root lookup can be retried");
});
