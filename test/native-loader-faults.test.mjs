import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function loaderFor(require) {
  const key = `native-loader-${Math.random()}`;
  globalThis[key] = require;
  try {
    const source = `const testRequire = globalThis[${JSON.stringify(key)}];\n` +
      (await readFile(new URL("../dist/native.js", import.meta.url), "utf8"))
        .replace("const require = createRequire(import.meta.url);", "const require = testRequire;")
        .replace('load(join(dirname(fileURLToPath(import.meta.url)), ".."))', 'load("isolated-native-root")');
    return await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  } finally {
    delete globalThis[key];
  }
}

for (const phase of ["require", "load"]) {
  test(`原生加载 ${phase} 失败不缓存半成品，后续可重试`, async () => {
    let first = true;
    const binding = { fsInfo: () => ({ local: true, type: "test" }) };
    const mod = await loaderFor((name) => {
      assert.equal(name, "node-gyp-build");
      if (phase === "require" && first) { first = false; throw new Error("注入 require 失败"); }
      return (dir) => {
        assert.equal(dir, "isolated-native-root");
        if (phase === "load" && first) { first = false; throw new Error("注入加载失败"); }
        return binding;
      };
    });
    assert.throws(() => mod.native(), /注入/);
    assert.equal(mod.native(), binding);
    assert.equal(mod.native(), binding);
  });
}

test("原生函数缺失时明确 ENOTSUP，存在时保留绑定上下文", async () => {
  const binding = { value: 7, fsInfo() { return this.value; } };
  const mod = await loaderFor(() => () => binding);
  assert.throws(() => mod.nativeFn("pidfdOpen"), { code: "ENOTSUP" });
  assert.equal(mod.nativeFn("fsInfo")(), 7);
});
