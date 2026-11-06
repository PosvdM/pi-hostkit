# 开发

本文写给修改 pi-hostkit 代码的人。接口和行为的定义见 [design.md](design.md)。

## 环境要求

- Node.js 24 及以上和 npm。
- 编译原生模块所需的工具链，见 [node-gyp 的安装说明](https://github.com/nodejs/node-gyp#installation)：Python 3，以及 C 编译器（macOS 为 Xcode Command Line Tools，Linux 为 gcc 和 make，Windows 为带“使用 C++ 的桌面开发”的 Visual Studio Build Tools）。
- 运行测试需要 pi 1.5.0：全局安装（`npm install -g @earendil-works/pi-coding-agent@1.5.0`），或用环境变量 `PI_PACKAGE` 指向 pi 的包目录。

## 源码结构

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | 包入口，重新导出各模块的公开接口 |
| `src/locate.ts` | `locatePi`、支持的 pi 版本区间（`SUPPORTED_PI_RANGE`） |
| `src/rpc.ts` | `JsonlSplitter`（按 LF 分帧）和 `StdioRpcTransport`（命令与响应关联、事件分发、错误类） |
| `src/process.ts` | `spawnManaged`、`ManagedProcess.stop`、`stopByIdentity`、`isSameProcess`；Linux cgroup scope 的检测与终止；快照模式的记录与终止 |
| `src/gate.ts` | 启动门闩，编译为独立入口 `dist/gate.js`，由 `spawnManaged` 作为子进程的脚本运行 |
| `src/gate-protocol.ts` | 门闩放行行和拒绝退出码，宿主和 gate 共用 |
| `src/proctable.ts` | 进程表与进程身份：Linux 读 `/proc`，macOS 和 Windows 调用原生模块；后代查找、身份比较、读取命令行 |
| `src/locks.ts` | 单实例锁、会话写锁、共享记录、`recoverPreviousWriter`、`spawnWriter` |
| `src/secrets.ts` | `ensurePrivateDir`、`writePrivateFile`、`checkPrivate` |
| `src/localfs.ts` | `filesystemInfo`、`assertLocalFilesystem` |
| `src/paths.ts` | 路径规则、真实路径、比较键；也作为子路径 `pi-hostkit/paths` 导出 |
| `src/native.ts` | 第一次使用时用 `node-gyp-build` 加载原生模块；`NativeBinding` 接口列出原生模块的全部函数 |
| `src/native/hostkit_posix.c` | macOS 和 Linux 的原生模块：`flock` 锁（`flockAcquire`、`fdClose`）、`fsInfo`；仅 macOS：进程表（`processInfo`、`listProcesses`）和命令行（`processArgs`） |
| `src/native/hostkit_win.c` | Windows 的原生模块：进程表与身份、命令行、按身份终止进程、Job Object、命名 mutex、`fsInfo`、当前用户 SID、DACL 的设置与读取 |
| `binding.gyp` | 按平台选择 C 源文件；Windows 链接 `advapi32.lib`；`NAPI_VERSION=8` |
| `test/` | 测试，见“测试” |

构建产物都不提交（见 `.gitignore`）：

| 路径 | 来源 |
| --- | --- |
| `dist/` | `npm run build`（TypeScript 编译） |
| `build/Release/hostkit.node` | `npm run build:native` 或安装时的源码编译 |
| `prebuilds/<平台>-<架构>/` | `npm run prebuildify` 或 CI 的 `prebuilds` artifact |

## 构建

| 命令 | 作用 |
| --- | --- |
| `npm install` | 安装依赖；`install` 脚本运行 `node-gyp-build`：能加载 `prebuilds/` 或已有的构建产物时不编译，否则用 node-gyp 从源码编译；`prepare` 脚本随后运行 `npm run build` |
| `npm run build` | `tsc -p tsconfig.json`，输出到 `dist/` |
| `npm run build:native` | `node-gyp rebuild`，输出到 `build/Release/` |
| `npm run prebuildify` | `prebuildify --napi --strip`，为当前平台和架构输出到 `prebuilds/` |

- 运行时 `node-gyp-build` 先找 `build/Release/`，再找 `prebuilds/`。修改 C 代码后运行 `npm run build:native`，否则测试加载的是旧的构建产物。
- 交叉编译其他架构：`npx prebuildify --napi --strip --arch x64`（CI 用这种方式在 Apple 芯片的运行器上构建 darwin x64）。

## 测试

```sh
npm run build
npm test
```

`npm test` 运行 `node --test --test-concurrency=1 "test/**/*.test.mjs"`。测试从 `dist/` 导入，所以修改 TypeScript 后要先构建。测试文件逐个运行（`--test-concurrency=1`），进程类用例会启动真实的 pi 进程。

| 文件 | 内容 |
| --- | --- |
| `test/rpc.test.mjs` | 分帧和传输层，用内存流模拟 pi |
| `test/paths.test.mjs` | 路径规则；与 pi 1.5.0 内部模块 `dist/utils/paths.js`、`dist/core/tools/path-utils.js` 的差分比对 |
| `test/process.test.mjs` | `spawnManaged`、启动门闩、进程树终止、进程身份、`stopByIdentity`、Linux cgroup |
| `test/locks.test.mjs` | 单实例锁、会话写锁、跨宿主恢复和 fail closed 的各种情况 |
| `test/misc.test.mjs` | 密钥权限、本地磁盘检查、`locatePi` |
| `test/helpers.mjs` | pi 测试现场（隔离的 HOME、agent 目录、会话目录和环境变量）、pi 参数、等待工具 |
| `test/fixtures/host.mjs` | 测试用宿主进程：执行一个动作、输出一行 JSON 后等待被杀，用于强杀宿主的用例 |
| `test/fixtures/fake-provider.ts` | 按脚本回复的本地 provider，pi 以 `-e` 加载；测试不联网，也不需要模型服务的密钥 |

`test/locks.test.mjs` 把 `HOME`（Windows 上 `USERPROFILE`）指向临时目录，不碰真实的 `~/.pi/hostkit/locks`。

环境变量：

| 变量 | 作用 |
| --- | --- |
| `PI_PACKAGE` | pi 的包目录。设置后不使用全局安装，并跳过“经 `npm root -g` 查找”的用例 |
| `HOSTKIT_TEST_CONTAINMENT` | `auto`（默认）或 `snapshot`，传给 `spawnManaged` 的 `containment`；在 Linux 上用 `snapshot` 测试快照模式 |
| `HOSTKIT_TEST_REQUIRE_CGROUP` | 设为 `1` 时，Linux 上 cgroup v2 user scope 不可用则测试失败；用于防止 CI 静默退回快照模式 |
| `KEEP_FIXTURES` | 设置后保留测试的临时目录，便于排查 |

在 Linux 上本地测试 cgroup 模式，需要当前用户的 systemd 实例，且环境中有 `XDG_RUNTIME_DIR` 和 `DBUS_SESSION_BUS_ADDRESS`；可先运行 `systemd-run --user --scope true` 确认。

## CI

`.github/workflows/ci.yml` 在推送到 main、提交 PR 和手动触发时运行。

`test` 任务：

- 矩阵：ubuntu-latest、macos-latest、windows-latest 各以 `containment=auto` 运行一次，ubuntu-latest 再以 `containment=snapshot` 运行一次。
- 步骤：安装 Node 24，`npm ci`（构建原生模块和 `dist/`），全局安装 pi 1.5.0，`npm test`。
- Linux 的用户 systemd：运行器上没有登录会话，所以先 `sudo loginctl enable-linger "$USER"` 启动用户的 systemd 实例，等待 `/run/user/<uid>/bus` 出现，再把 `XDG_RUNTIME_DIR` 和 `DBUS_SESSION_BUS_ADDRESS` 写入后续步骤的环境。`auto` 模式下同时设置 `HOSTKIT_TEST_REQUIRE_CGROUP=1`。

`prebuild` 任务为六个目标构建预编译模块：

| 运行器 | 目标 |
| --- | --- |
| ubuntu-latest | linux x64 |
| ubuntu-24.04-arm | linux arm64 |
| macos-latest | darwin arm64 |
| macos-latest（`--arch x64`） | darwin x64 |
| windows-latest | win32 x64 |
| windows-11-arm | win32 arm64 |

每个任务 `npm ci --ignore-scripts` 后运行 `prebuildify --napi --strip`，非交叉编译的目标再用 `node-gyp-build` 加载一次并调用 `fsInfo`，然后上传 `prebuilds-<运行器>` artifact。`collect prebuilds` 任务把它们合并成一个 `prebuilds` artifact。预编译模块目前不随包分发，见 [README](../README.md#安装)。

## 修改约定

- **接口与行为**：修改公开接口、默认值或平台行为时，同步更新 [design.md](design.md)，并在 pi-pane、pi-agora 中检查引用它的文档。
- **支持的 pi 版本**：修改 `src/locate.ts` 的 `SUPPORTED_PI_RANGE` 之前，先用 `PI_PACKAGE` 指向新版本跑 `test/paths.test.mjs` 的差分测试，再跑全部测试；pi 的路径规则变化时同步修改 `src/paths.ts`。design.md 中“依据”引用的 pi 文件和行号也要按新版本核对。
- **会话写锁协议**：锁文件和 mutex 的名称与位置、会话 key 的算法、共享记录的格式和语义都属于协议 `v1`。修改其中任何一项都是不兼容修改，pane 和 agora 要同时升级；需要不兼容修改时改用新的协议版本名。
- **启动门闩**：`src/gate.ts` 只依赖 `src/gate-protocol.ts` 和 Node 内置模块，不加载原生模块，在 pi 加载之前不做多余的事。修改放行行或退出码时，宿主和 gate 必须来自同一版本的 pi-hostkit。
- **原生函数**：增加或修改原生函数时，同时修改对应的 C 文件和 `src/native.ts` 的 `NativeBinding`。只在部分平台存在的函数声明为可选，经 `nativeFn` 调用（不存在时抛出 `ENOTSUP`）。
- **`pi-hostkit/paths`**：`src/paths.ts` 不导入 `src/native.ts` 或其他会加载原生模块的文件，因为这个入口在 pi 进程里的扩展中使用。
- **发信号和终止进程**：一律先核对进程身份（POSIX 用 `process.ts` 的 `signalIdentity`，Windows 用按创建时间核对的 `terminateProcess`），不直接对 PID 调用 `process.kill`。例外是没有 `cgroup.kill` 的内核上逐个终止 scope 成员：发信号前核对该进程仍在这个 scope 里。
