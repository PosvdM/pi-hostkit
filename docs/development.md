# 开发

本文写给修改 pi-hostkit 代码的人。接口和行为的定义见 [design.md](design.md)。

## 环境要求

- Node.js 24 及以上和 npm。
- 编译原生模块所需的工具链，见 [node-gyp 的安装说明](https://github.com/nodejs/node-gyp#installation)：Python 3，以及 C 编译器（macOS 为 Xcode Command Line Tools，Linux 为 gcc 和 make，Windows 为带“使用 C++ 的桌面开发”的 Visual Studio Build Tools）。
- 运行测试需要 pi 1.5.0：通过官方脚本或全局 npm 安装，或用环境变量 `PI_PACKAGE` 指向 pi 的包目录。未设置 `PI_PACKAGE` 时按 `locatePi` 的顺序定位，见 [design.md](design.md#定位-pi)。

## 源码结构

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | 包入口，重新导出各模块的公开接口 |
| `src/locate.ts` | `locatePi`、支持的 pi 版本区间（`SUPPORTED_PI_RANGE`） |
| `src/rpc.ts` | `JsonlSplitter`（按 LF 分帧）和 `StdioRpcTransport`（命令与响应关联、事件分发、错误类） |
| `src/process.ts` | `spawnManaged`、`ManagedProcess.stop`、`stopByIdentity`、`isSameProcess`；Linux cgroup scope 的检测与终止；快照模式的记录与终止 |
| `src/snapshots.ts` | 快照记录及逐目标停止、错误收集、退出复查；父身份查询失败只丢弃相关分支，快照错误写入报告；不作为包入口导出 |
| `src/fs-probe.ts` | 内部严格存在性检查，只有 ENOENT/ENODEV 返回不存在；cgroup 选择、人口检查和 gate 恢复探测共用 |
| `src/cgroups.ts` | cgroup 整体终止及旧内核逐 PID 退回、pi 身份保底、部分列举与未知残留报告；内部依赖注入用于确定性故障测试；人口检查供恢复路径复用 |
| `src/gate.ts` | 启动门闩，编译为独立入口 `dist/gate.js`，由 `spawnManaged` 作为子进程的脚本运行 |
| `src/gate-protocol.ts` | 门闩放行行和拒绝退出码，宿主和 gate 共用 |
| `src/proctable.ts` | 进程表与进程身份：Linux 读 `/proc`，macOS 和 Windows 调用原生模块；后代查找、身份比较、读取命令行 |
| `src/locks.ts` | 单实例锁、会话写锁、共享记录、`recoverPreviousWriter`、`spawnWriter` |
| `src/secrets.ts` | `ensurePrivateDir`、`writePrivateFile`、`checkPrivate` |
| `src/localfs.ts` | `filesystemInfo`、`assertLocalFilesystem` |
| `src/paths.ts` | 路径规则、真实路径、比较键；也作为子路径 `pi-hostkit/paths` 导出 |
| `src/native.ts` | 第一次使用时用 `node-gyp-build` 加载原生模块；`NativeBinding` 接口列出原生模块的全部函数 |
| `src/native/hostkit_posix.c` | macOS 和 Linux 的原生模块：`flock` 锁（`flockAcquire`、`fdClose`）、`fsInfo`；仅 macOS：进程表（`processInfo`、`listProcesses`，用 `sysctl(KERN_PROC)`）、命令行（`processArgs`）、扩展 ACL（`aclEntryCount`、`aclClear`）；仅 Linux：pidfd（`pidfdOpen`、`pidfdSignal`） |
| `src/native/hostkit_win.c` | Windows 的原生模块：进程表与身份（`NtQuerySystemInformation`）、命令行（拆成参数）、按身份终止进程、Job Object、命名 mutex、`fsInfo`、当前用户 SID、DACL 的设置与读取、带私密 DACL 创建文件（`createPrivateFile`） |
| `src/piargs.ts` | 按 pi 1.5.0 `parseArgs` 的规则解析 pi 参数，判断 pi 实际以 RPC 模式打开哪个会话文件（`spawnWriter` 校验和恢复时的候选判断） |
| `binding.gyp` | 按平台选择 C 源文件；Windows 链接 `advapi32.lib`（ACL、令牌）和 `shell32.lib`（`CommandLineToArgvW`）；`NAPI_VERSION=8` |
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

- 运行时 `node-gyp-build` 先找 `build/Release/`，再找 `prebuilds/`。`npm test` 之前的 `pretest` 脚本会重新构建 `dist/` 和原生模块，所以测试不会用到旧的构建产物；直接用 `node --test` 运行单个文件时，先运行 `npm run build` 和 `npm run build:native`。
- 交叉编译其他架构：`npx prebuildify --napi --strip --arch x64`（CI 用这种方式在 Apple 芯片的运行器上构建 darwin x64）。

## 测试

```sh
npm run build
npm test
```

`npm test` 先由 `pretest` 运行 `npm run build` 和 `npm run build:native`，再运行 `node --test --test-concurrency=1 "test/**/*.test.mjs"`。测试从 `dist/` 导入。测试文件逐个运行（`--test-concurrency=1`），进程类用例会启动真实的 pi 进程。

| 文件 | 内容 |
| --- | --- |
| `test/rpc.test.mjs` | 分帧和传输层，用内存流模拟 pi |
| `test/locate.test.mjs` | 临时 HOME 的官方安装布局、环境变量优先级、激活切换、npm 回退；只在隔离模块副本中替换 npm 查询 |
| `test/locate-faults.test.mjs` | 显式、官方、npm 候选的系统查询失败分类与失败缓存重试 |
| `test/locks-faults.test.mjs` | 获取/释放与恢复查询、临时记录创建/写入/提交/删除、候选之间的独立清理、启动写者及回收双失败 |
| `test/secrets-faults.test.mjs` | 私密目录与文件的查询、ACL、创建/写入/sync/关闭、最终复查与失败删除 |
| `test/paths-faults.test.mjs` | 读取变体、真实路径/链接和 macOS 卷探测的失败分类；真实路径首次缺失后并发创建文件/目录，以及重试次数与原始错误传播 |
| `test/rpc-faults.test.mjs` | 输出流错误/关闭、挂起请求与背压队列清理、关闭输入时首错与收尾错误同时保留 |
| `test/process-faults.test.mjs` | 独立模块 mock 进程的 Windows Job/恢复停止/启动回收与 Linux 进程表、pidfd/进程组退路故障；Job 列表与退出可见性的时间差，坏 stat 的有界重读与有界诊断 |
| `test/native-faults.test.mjs` | 临时编译带系统调用包装器的原生副本；原生查询、信号、截断、资源回收与结果构造故障 |
| `test/native-loader.test.mjs` | 原生模块懒加载、加载失败后重试、函数缺失与调用错误 |
| `test/paths-case.test.mjs` | macOS 大小写敏感/不明/跨设备检测、只读探测边界、无 native 加载；注入仅存在于隔离测试副本 |
| `test/snapshot-faults.test.mjs` | 内部快照模块的后代 `EPERM`、查询失败、部分分支保留、最后快照失败与 `StopReport` |
| `test/existence-faults.test.mjs` | 严格存在性错误分类、记录 scope 查询失败的覆盖保留、gate 协议查询不明不能被其他候选掩盖 |
| `test/localfs-faults.test.mjs` | 本地磁盘探测的严格上溯、跨挂载边界、原生查询失败与悬空链接目标 |
| `test/gate-faults.test.mjs` | 门闩读取的暂不可读、管道结束、权限与 I/O 错误；失败不能加载入口 |
| `test/platform-mounts.test.mjs` | 真实大小写敏感 APFS 的路径与锁拒绝、真实 SSHFS 远程挂载及其中的权限查询失败 |
| `test/cgroup-subtree.test.mjs` | 真实委派 scope 的两棵子 cgroup；整体清理与部分查询失败时独立清理 |
| `test/cgroup-faults.test.mjs` | cgroup 旧内核退回、逐 PID 信号与查询错误、部分/最终列举失败、已知身份及未知哨兵、独立 pi 保底 |
| `test/windows-mutex.test.mjs` | Windows mutex 的 owner、DACL、跨进程互斥、真实异主对象拒绝；CI 不允许异主测试跳过 |
| `test/piargs.test.mjs` | pi 参数解析；与 pi 1.5.0 内部模块 `dist/cli/args.js` 的 `parseArgs` 差分比对 |
| `test/gate.test.mjs` | 启动门闩本身：用 `test/fixtures/marker-entry.mjs` 代替 pi 的入口，检查拒绝放行时入口没有加载、放行后入口拿到的参数和下一行输入 |
| `test/paths.test.mjs` | 路径规则；与 pi 1.5.0 内部模块 `dist/utils/paths.js`、`dist/core/tools/path-utils.js` 的差分比对 |
| `test/process.test.mjs` | `spawnManaged`、启动门闩、进程树终止、进程身份、`stopByIdentity`、Linux cgroup |
| `test/locks.test.mjs` | 单实例锁、会话写锁、跨宿主恢复和 fail closed 的各种情况 |
| `test/misc.test.mjs` | 密钥权限、本地磁盘检查、`locatePi` |
| `test/helpers.mjs` | pi 测试现场（隔离的 HOME、agent 目录、会话目录和环境变量）、pi 参数、等待工具 |
| `test/fixtures/host.mjs` | 测试用宿主进程：执行一个动作、输出一行 JSON 后等待被杀，用于强杀宿主的用例 |
| `test/fixtures/scope-selection-fault.mjs`、`test/fixtures/gate-probe-fault.mjs` | 独立测试进程中的存在性与进程表模拟；分别验证 scope 选择及 fail closed 恢复，不发送真实信号 |
| `test/fixtures/capture-fault.mjs` | POSIX 子进程用 Node 模块 mock 注入快照失败，验证真实 `Managed.stop` 返回报告并缓存成功结果 |
| `test/fixtures/cgroup-verify-fault.mjs` | Linux 真实 user scope 启动后临时替换内置 fs 调用，验证最终检查失败也返回带未知 scope 的可重复报告 |
| `test/fixtures/marker-entry.mjs` | gate 测试用的入口：被加载时写一个标记文件，记下参数和收到的第一行输入 |
| `test/fixtures/boundary-module.mjs` | 隔离源码副本的模块依赖替换；不改变生产导出 |
| `test/fixtures/process-faults.mjs`、`test/fixtures/proctable-faults.mjs` | 独立 Node 模块 mock 子进程中的逐进程查询、信号和回收故障 |
| `test/fixtures/native-fault-build.mjs`、`test/fixtures/native-fault-worker.mjs` | 在临时目录构建/加载原生故障副本，按系统调用注入并核对资源净变化；子进程退出后删除 DLL 和目录 |
| `test/fixtures/cgroup-subtree.mjs` | 进入真实委派 scope 后创建两棵子 cgroup 并放入实际子进程 |
| `test/fixtures/fake-provider.ts` | 按脚本回复的本地 provider，pi 以 `-e` 加载；测试不联网，也不需要模型服务的密钥 |

`test/locks.test.mjs` 把 `HOME`（Windows 上 `USERPROFILE`）指向临时目录，不碰真实的 `~/.pi/hostkit/locks`。释放记录失败通过测试进程临时替换内置 fs 调用注入，并在 `finally` 恢复；写者查询错误在 `test/fixtures/release-query-fault.mjs` 的独立子进程中用 `--experimental-test-module-mocks` 注入，不改变生产 API。Windows 异主 mutex 测试需要可指定其他 owner 的提权令牌，本机未提权时明确跳过；CI 要求真正执行。

环境变量：

| 变量 | 作用 |
| --- | --- |
| `PI_PACKAGE` | pi 的包目录。设置后测试使用该安装，并跳过自动定位 smoke 用例；隔离 HOME 的定位测试仍执行 |
| `HOSTKIT_TEST_CONTAINMENT` | `auto`（默认）或 `snapshot`，传给 `spawnManaged` 的 `containment`；在 Linux 上用 `snapshot` 测试快照模式 |
| `HOSTKIT_TEST_REQUIRE_CGROUP` | 设为 `1` 时，Linux 上 cgroup v2 user scope 不可用则测试失败；用于防止 CI 静默退回快照模式 |
| `HOSTKIT_TEST_APFS` | CI 用 `hdiutil` 创建并挂载的大小写敏感 APFS 测试卷；未设置时只跳过该真实挂载用例 |
| `HOSTKIT_TEST_REMOTE` | Linux auto CI 用 SSHFS 挂载的远程目录；未设置时只跳过该真实挂载用例 |
| `KEEP_FIXTURES` | 设置后保留测试的临时目录，便于排查 |

在 Linux 上本地测试 cgroup 模式，需要当前用户的 systemd 实例，且环境中有 `XDG_RUNTIME_DIR` 和 `DBUS_SESSION_BUS_ADDRESS`；可先运行 `systemd-run --user --scope true` 确认。

## CI

`.github/workflows/ci.yml` 在推送到 main、提交 PR 和手动触发时运行。

`test` 任务：

- 矩阵：ubuntu-latest、macos-latest、windows-latest 各以 `containment=auto` 运行一次，ubuntu-latest 再以 `containment=snapshot` 运行一次。
- 步骤：安装 Node 24，`npm ci`（构建原生模块和 `dist/`），全局安装 pi 1.5.0，`npm test`。
- Linux 的用户 systemd：运行器上没有登录会话，所以先 `sudo loginctl enable-linger "$USER"` 启动用户的 systemd 实例，等待 `/run/user/<uid>/bus` 出现，再把 `XDG_RUNTIME_DIR` 和 `DBUS_SESSION_BUS_ADDRESS` 写入后续步骤的环境。`auto` 模式下同时设置 `HOSTKIT_TEST_REQUIRE_CGROUP=1`。子树用例另建带 `Delegate=yes` 的 scope，创建两个实际子 cgroup；CI 不允许因缺少 cgroup 支持跳过。
- macOS 用 `hdiutil create -fs "Case-sensitive APFS"` 创建 256 MiB 的大小写敏感 APFS 磁盘映像并挂载，在其中验证路径比较与会话锁拒绝；测试结束后卸载。
- Linux auto 安装 SSHFS 与 OpenSSH server，用运行器临时目录中的专用密钥启动本机端口 2222 的 SSH 服务并挂载 SFTP 目录。远程卷用例同时检查明确非本地和无法遍历目录的 `EACCES`，不改宿主真实 HOME 下的 SSH 配置；测试结束后卸载并停止该 SSH 服务。

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

系统边界的逐检查点、故障注入与真实平台测试映射见 [failure-boundaries.md](failure-boundaries.md)；[设计不变式](design.md#故障处理不变式)约束测试预期。

## 修改约定

- **接口与行为**：修改公开接口、默认值或平台行为时，同步更新 [design.md](design.md)，并在 pi-pane、pi-agora 中检查引用它的文档。
- **支持的 pi 版本**：修改 `src/locate.ts` 的 `SUPPORTED_PI_RANGE` 之前，先用 `PI_PACKAGE` 指向新版本跑 `test/paths.test.mjs` 和 `test/piargs.test.mjs` 的差分测试，再跑全部测试；pi 的路径规则变化时同步修改 `src/paths.ts`。design.md 中“依据”引用的 pi 文件和行号也要按新版本核对。
- **会话写锁协议**：锁文件和 mutex 的名称与位置、会话 key 的算法、共享记录的格式和语义都属于协议 `v1`。修改其中任何一项都是不兼容修改，pane 和 agora 要同时升级；接入方使用后需要不兼容修改时改用新的协议版本名；现有 Global/SID 名称与释放语义使用 `v1`，见 design.md。
- **启动门闩**：`src/gate.ts` 只依赖 `src/gate-protocol.ts` 和 Node 内置模块，不加载原生模块，在 pi 加载之前不做多余的事。修改放行行或退出码时，宿主和 gate 必须来自同一版本的 pi-hostkit。
- **原生函数**：增加或修改原生函数时，同时修改对应的 C 文件和 `src/native.ts` 的 `NativeBinding`。只在部分平台存在的函数声明为可选，经 `nativeFn` 调用（不存在时抛出 `ENOTSUP`）。
- **`pi-hostkit/paths`**：`src/paths.ts` 不导入 `src/native.ts` 或其他会加载原生模块的文件，因为这个入口在 pi 进程里的扩展中使用。
- **发信号和终止进程**：一律经过核对进程身份的函数（POSIX 用 `src/proctable.ts` 的 `signalProcess`，Linux 上经 pidfd；Windows 用按创建时间核对的 `terminateProcess`），不直接对 PID 调用 `process.kill`。没有 `cgroup.kill` 的内核上逐个终止 scope 成员时，同样经 `signalProcess`，并在发信号前核对该进程仍在这个 scope 里。
- **进程表遍历**：按父子关系找后代用内部 `verifiedDescendants`，它在读完进程表后重新核对每个父进程，丢掉经由已换了进程的 PID 找到的行。快照提供逐父核对函数，将查询错误记入报告并只否决相关分支。`stopCgroup` 的调用方必须确认是 hostkit 自己的 scope，并提供有界的 settle 等待。
- **pi 参数规则**：`src/piargs.ts` 照搬 pi 1.5.0 的 `parseArgs`，`test/piargs.test.mjs` 与 pi 的实现做差分比对。升级支持的 pi 版本时先跑这组测试，pi 增减选项时同步修改。
