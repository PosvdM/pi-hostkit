import { readFile } from "node:fs/promises";

let next = 0;

// 只在隔离源码副本中替换依赖；生产模块不暴露故障注入接口。
export async function boundaryModule(name, { imports = {}, platform, suffix = "" } = {}) {
  const url = new URL(`../../dist/${name}.js`, import.meta.url);
  const key = `hostkit-boundary-${++next}`;
  globalThis[key] = imports;
  try {
    let source = await readFile(url, "utf8");
    source = source.replace(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)";/g, (statement, names, specifier) => {
      if (!(specifier in imports)) return statement;
      return `const {${names.replace(/\bas\b/g, ":")}} = globalThis[${JSON.stringify(key)}][${JSON.stringify(specifier)}];`;
    });
    source = source.replace(/from "(\.\/[^"]+)"/g, (_, specifier) => `from ${JSON.stringify(new URL(specifier, url).href)}`);
    if (platform) source = source.replaceAll("process.platform", JSON.stringify(platform));
    return await import(`data:text/javascript;base64,${Buffer.from(source + suffix + `\n// ${key}`).toString("base64")}`);
  } finally {
    delete globalThis[key];
  }
}

export function fault(code = "EIO", operation = "边界故障") {
  return Object.assign(new Error(`${operation}: ${code}`), { code });
}
