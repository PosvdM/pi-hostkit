# pi-hostkit

pi-hostkit 封装托管 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 子进程时与操作系统相关的能力：定位 pi、RPC 传输、启动和停止受管 pi 及其整棵进程树、单实例锁和会话写锁、密钥目录权限、路径规范化。

> 版本 0.x：接口可能调整。

## 使用方

- [pi-pane](https://github.com/PosvdM/pi-pane)：pi 的 Web 界面，服务端用 pi-hostkit 托管主会话。
- [pi-agora](https://github.com/PosvdM/pi-agora)：pi 的协作引擎，daemon 用 pi-hostkit 托管协作会话。

两者都依赖 pi-hostkit，彼此不依赖。它们通过会话写锁协议保证同一个会话文件同一时间只有一个托管写者，所以两者必须使用协议兼容的 pi-hostkit 版本。

## 模块

| 模块 | 主要接口 | 内容 |
| --- | --- | --- |
| 定位 pi | `locatePi` | 按 `piPath`、官方安装目录、全局 npm 目录的顺序找到 pi，检查版本 |
| RPC 传输 | `StdioRpcTransport` | pi RPC 的 JSONL 传输：只按 LF 分帧、按 `id` 关联响应、超时、扩展 UI 请求 |
| 受管进程 | `spawnManaged`、`stopByIdentity`、`isSameProcess` | 经启动门闩拉起 pi、记录进程身份（PID + 创建时间）、停止 pi 及其后代进程 |
| 锁 | `acquireInstanceLock`、`acquireSessionWriterLock` | 单实例锁；跨 pi-pane 和 pi-agora 的会话写锁及遗留写者的恢复 |
| 密钥权限 | `ensurePrivateDir`、`writePrivateFile`、`checkPrivate` | 只允许当前用户访问的目录和文件 |
| 本地磁盘 | `assertLocalFilesystem` | 拒绝网络文件系统上的数据和锁目录 |
| 路径 | `canonicalPath`、`comparisonKey`、`isWithin` | 与 pi 一致的路径解析、真实路径、跨平台比较；子路径 `pi-hostkit/paths` 不加载原生模块 |

停止进程树的保证因平台而异：Windows 用 Job Object，Linux 有 cgroup v2 时用 systemd scope，macOS 和没有 cgroup 的 Linux 用进程表快照，只能保证清理快照见过的进程。每次停止的结果在 `StopReport.coverage` 中标明。细节见 [docs/design.md](docs/design.md#进程树终止)。

## 环境要求

- Windows、macOS、Linux。CI 测试的是 x64 的 Linux、Windows 和 Apple 芯片的 macOS；预编译模块覆盖 linux x64/arm64、darwin arm64/x64、win32 x64/arm64。
- Node.js 24 及以上。
- pi 1.5.x（`>=1.5.0 <1.6.0`，不含预发布版本）。
- Linux 上使用 cgroup 模式需要 cgroup v2 和当前用户的 systemd 实例（`systemd-run --user --scope` 可用）；不满足时自动使用快照模式。

## 安装

pi-hostkit 不发布到 npm（`package.json` 中为 `private: true`）。使用方以 git 依赖或本地路径安装。

安装时 `node-gyp-build` 先找 `prebuilds/` 中与当前平台和架构匹配的预编译模块，没有时用 node-gyp 从源码编译，这需要 Python 3 和 C 编译器（见 [node-gyp 的安装说明](https://github.com/nodejs/node-gyp#installation)）。CI 产出的预编译模块在 GitHub Actions 运行结果的 `prebuilds` artifact 里，尚未随包分发；仓库里没有 `prebuilds/` 目录。

**git 依赖**（安装时从源码编译）：

```sh
npm install "github:PosvdM/pi-hostkit#<提交或标签>"
```

**本地路径**：

```sh
git clone https://github.com/PosvdM/pi-hostkit.git
cd pi-hostkit
npm install                      # 编译原生模块，构建 dist/
cd ../my-host
npm install ../pi-hostkit
```

不想在本机编译时，在 `npm install` 之前从 CI 运行结果下载 `prebuilds` artifact，解压到 pi-hostkit 的 `prebuilds/` 目录（其下为 `<平台>-<架构>/` 子目录）。

## 用法

以 pi-pane 打开一个会话为例：取得会话写锁、清理上一个写者、拉起 pi、停止后释放锁。

```js
import {
  acquireSessionWriterLock,
  currentProcessIdentity,
  isSessionWriterLock,
  isSameProcess,
  locatePi,
} from "pi-hostkit";

const pi = await locatePi({ piPath: config.piPath });
if (!pi.supported) throw new Error(`不支持的 pi 版本：${pi.version}`);

const host = { app: "pi-pane", identity: currentProcessIdentity(instanceId) };
const lock = await acquireSessionWriterLock(sessionFile, host);
if (!isSessionWriterLock(lock)) {
  // 已被另一个宿主托管：lock.heldBy 是共享记录，可显示持有者
  return;
}
if ((await lock.recoverPreviousWriter()) === "failed") {
  // 上一个写者状态不明，锁已释放；请用户确认没有遗留的 pi 后，重新取锁并传 { assumeNoWriter: true }
  return;
}

// pi 加载、打开会话文件之前，它的进程身份已写入共享记录
const proc = await lock.spawnWriter({
  argv: [pi.cliEntry, "--mode", "rpc", "--session", sessionFile],
  cwd,
  env,
  runId,
  instanceId,
});
proc.rpc.onEvent((event) => {
  /* 会话事件 */
});
const state = await proc.rpc.send({ type: "get_state" }, { timeoutMs: 10_000 });

// 关闭会话
await lock.update({ state: "stopping" });
const report = await proc.stop(); // abort → 关闭 stdin → 终止进程树 → 复查
if (report.leftovers.some((p) => p.pid === proc.identity.pid && p.startTime === proc.identity.startTime)
    || (await isSameProcess(proc.identity)) !== "gone") {
  console.error("pi 未确认退出，保留会话写锁", report);
  return;
}
if (report.leftovers.length) console.error("pi 已退出，但仍有后代存活或状态不明", report);
await lock.release(); // 再次核对 pi 已退出；核对或写记录失败时保留锁，可重试
```

进程内切换会话时，先取得目标会话的锁；确认新会话的 `session_start` 后，用 `await oldLock.release({ writerSwitchedAway: true })` 释放旧文件的锁。该选项由调用方确认 pi 已切走，具体时机和切换失败的处理见[会话写锁协议](docs/design.md#取得锁的时机)。

`release()` 只要求写会话文件的 pi 已退出；残留后代由调用方根据 `StopReport` 报告。`snapshot_visible` 即使 `leftovers` 为空，也不能证明整棵进程树没有残留。

完整接口和各平台行为见 [docs/design.md](docs/design.md)。

## 开发

```sh
npm install      # 依赖、原生模块、dist/
npm run build    # 只重新编译 TypeScript
npm test         # 需要通过官方脚本或全局 npm 安装 pi 1.5.0，或用 PI_PACKAGE 指向 pi 的包目录
```

源码结构、原生模块的构建、测试的环境变量和 CI 见 [docs/development.md](docs/development.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/design.md](docs/design.md) | 权威设计：接口、启动门闩、进程身份、进程树终止、锁与会话写锁协议、密钥权限、路径规范化、平台差异、验证状态、剩余风险 |
| [docs/development.md](docs/development.md) | 源码结构、构建、测试、CI、修改约定 |
