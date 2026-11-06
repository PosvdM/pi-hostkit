// 在真实委派 scope 中创建两个子 cgroup；测试进程留在 scope 外执行停止。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const line = fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").find((row) => row.startsWith("0::"));
if (!line) throw new Error("无法读取 cgroup v2 路径");
const dir = path.posix.join("/sys/fs/cgroup", line.slice(3));
const children = [];
for (const name of ["blocked", "readable"]) {
  const childDir = path.join(dir, name);
  fs.mkdirSync(childDir);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(path.join(childDir, "cgroup.procs"), String(child.pid));
  children.push({ pid: child.pid, dir: childDir });
}
console.log(JSON.stringify({ pid: process.pid, dir, children }));
setInterval(() => {}, 1000);
