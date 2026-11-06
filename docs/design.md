# pi-hostkit 设计

> 版本 0.x：接口可能调整。会话写锁协议（`v1`）的兼容规则见“外部写者与协议版本”。

pi-hostkit 封装托管 pi 子进程时与操作系统相关的能力。pi-agora 的 daemon 和 pi-pane 的服务端都依赖它，两者彼此不依赖。

**本文是 pi-hostkit 的权威定义。** pi-pane 和 pi-agora 的文档只引用本文，不另行定义这些接口。修改本文中的共享协议（尤其是“会话写锁”）时，pane 和 agora 必须同时升级到兼容版本。

接口以 `src/*.ts` 的导出为准，本文的代码块是其摘录。源码结构、构建和测试见 [development.md](development.md)。

## 范围

| 模块 | 源码 | 内容 |
| --- | --- | --- |
| 定位 pi | `src/locate.ts` | 定位 pi 安装、检查版本 |
| RPC 传输 | `src/rpc.ts` | pi RPC 的 JSONL 传输 |
| 受管进程 | `src/process.ts`、`src/gate.ts`、`src/proctable.ts` | 启动受管进程（经启动门闩）、记录进程身份、终止整棵进程树 |
| 锁 | `src/locks.ts` | 单实例锁、会话写锁 |
| 密钥权限 | `src/secrets.ts` | 密钥目录与文件的权限 |
| 本地磁盘 | `src/localfs.ts` | 拒绝网络文件系统 |
| 路径 | `src/paths.ts` | 路径规范化与包含关系判断 |

不在范围内：业务概念（任务、会议、聊天视图）、HTTP 服务、鉴权协议。

## 支持的平台

- Windows、macOS、Linux 同时支持。三个平台的行为在本文逐项写明；同一功能在不同平台上的结果一致，实现方式可以不同。各平台的覆盖范围不同之处（进程树终止）在 `StopReport.coverage` 中标明。
- Node.js 24 及以上（`package.json` 的 `engines`）。
- pi 1.5.x（`>=1.5.0 <1.6.0`），见“定位 pi”。

### 原生模块

Node 没有内置命名 mutex、`flock`、Job Object、进程创建时间查询、Windows ACL 和文件系统类型查询，这些能力由 pi-hostkit 自带的 N-API 模块提供（`src/native/hostkit_posix.c` 用于 macOS 和 Linux，`src/native/hostkit_win.c` 用于 Windows）。

- **选型理由**：锁的文件描述符或 mutex 句柄直接由宿主进程持有。宿主存活则锁在，宿主崩溃或被强杀则内核自动释放，符合会话写锁的语义。若由单独的辅助程序持锁，辅助程序单独崩溃时锁被释放，宿主和它的 pi 却仍在写，就会出现两个写者。
- **加载**：用 `node-gyp-build` 加载：有 `build/Release/`（node-gyp 从源码编译的产物）时用它，否则用 `prebuilds/<平台>-<架构>/` 中的预编译模块。安装时只在没有可用的预编译模块时才从源码编译。模块在第一次用到原生功能时才加载。
- **不需要原生模块的入口**：子路径 `pi-hostkit/paths` 只包含路径规则，不加载原生模块，供在 pi 进程里运行的扩展使用。
- Linux 的进程表从 `/proc` 读取，由 JavaScript 实现，不经原生模块。

### 本地磁盘

锁目录必须在本地磁盘上：网络文件系统上的 `flock` 和原子改名不可靠。

```ts
export function filesystemInfo(target: string): { local: boolean; type: string; path: string };
export function assertLocalFilesystem(target: string): void; // 非本地时抛出 EHOSTKIT_REMOTE_FS
```

- `target` 不存在时检查最深的已存在祖先，`path` 是实际检查的路径。
- macOS：`statfs` 的 `MNT_LOCAL` 标志；`type` 为 `f_fstypename`。
- Linux：按 `statfs` 的魔数把 nfs、smb、cifs、smb2、coda、afs、9p、fuse、ceph、gpfs、lustre、kafs、ncp、ncpfs 视为非本地，其余视为本地；`type` 为文件系统名或十六进制魔数。
- Windows：卷的驱动器类型为 remote、cdrom 或无法识别，或卷根是 UNC 路径（不含 `\\?\`、`\\.\` 设备路径）时视为非本地。
- `acquireInstanceLock` 检查 `scopeDir`，会话写锁检查共享锁目录。使用方的数据目录（如 agora 的 `AGORA_HOME`）由使用方自己调用 `assertLocalFilesystem`。

## 定位 pi

本文和其他文档中对 pi 行为的依据都以 pi 1.5.0 的文件为准，路径相对于 pi 包目录。

```ts
export function locatePi(opts?: { piPath?: string }): Promise<PiInstall>;
export function isSupportedPiVersion(version: string): boolean;
export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

export interface PiInstall {
  packageDir: string;   // pi 包目录（真实路径）
  cliEntry: string;     // package.json 的 bin.pi，1.5.0 中为 dist/bundle/cli.js
  version: string;      // package.json 的 version
  supported: boolean;   // version 是否在支持区间内
}
```

查找顺序：

1. 配置项 `piPath`（pane 与 agora 各自的配置文件里同名）：可以是包目录，也可以是包内的文件（通常是 `cli.js`）；指向文件时向上最多查 6 层找到包目录。
2. 全局 npm 根目录：执行 `npm root -g`，取 `<root>/@earendil-works/pi-coding-agent`。Windows 上 `npm` 是 `.cmd` 脚本，经 `%SystemRoot%\System32\cmd.exe /d /s /c "npm root -g"` 调用，参数固定，不拼接任何外部输入。结果缓存到进程退出（失败时不缓存）。
3. 都找不到时抛出 `EHOSTKIT_PI_NOT_FOUND`，提示安装 pi 或设置 `piPath`。

- 包目录的 `package.json` 的 `name` 必须是 `@earendil-works/pi-coding-agent`，`bin.pi` 指向的文件必须存在。
- 只有 `x.y.z` 形式且在 `>=1.5.0 <1.6.0` 内的版本算支持；带预发布后缀（如 `1.5.1-beta.1`）的版本不算。`supported` 为 false 时，使用方拒绝启动受管会话，提示改用支持的 pi 版本。
- 启动 pi 时用 `process.execPath`（Node）经启动门闩运行 `cliEntry`，不经 shell、`pi.cmd` 或 Git Bash，见“启动门闩”。

## RPC 传输

pi RPC 是严格的 JSONL：每条记录是一个完整的 JSON 对象，以 LF 结尾（依据：`docs/rpc.md` 的 Framing 一节）。

```ts
export interface RpcTransport {
  send(cmd: RpcCommand, opts?: { timeoutMs?: number }): Promise<RpcResponse>; // 按 id 关联响应
  onEvent(listener: (ev: RpcEvent) => void): () => void;                    // 会话事件
  onUiRequest(listener: (req: ExtensionUiRequest) => void): () => void;     // extension_ui_request
  respondUi(res: ExtensionUiResponse): void;                                 // 写 extension_ui_response
  closeInput(): void;                                                        // 关闭子进程 stdin
  onError(listener: (error: Error) => void): () => void;                    // 协议错误与流错误
  onDiagnostic(listener: (d: RpcDiagnostic) => void): () => void;          // 被丢弃的响应
  readonly closed: Promise<void>;                                            // stdout 结束时 resolve
}

export type RpcDiagnostic =
  | { kind: "late_response"; response: RpcResponse }       // 超时之后才到的响应
  | { kind: "unmatched_response"; response: RpcResponse }; // 没有对应命令的响应

export class StdioRpcTransport implements RpcTransport {
  constructor(stdin: Writable, stdout: Readable, opts?: { maxRecordBytes?: number });
}
export class JsonlSplitter { /* 按 LF 切分字节流，供测试和其他传输复用 */ }
```

- **只按 LF 切分**：stdout 按字节流读，遇到 `\n` 切出一条记录，去掉末尾一个可选的 `\r`，再按 UTF-8 解码（LF 不会出现在多字节 UTF-8 序列中间）。不用 Node 的 `readline`：它还会在 `U+2028`、`U+2029` 处切分，而这两个字符可以合法出现在 JSON 字符串里。
- **写入**：每条命令写 `JSON.stringify(cmd) + "\n"`，按调用顺序写入。没有 `id` 的命令由传输层分配 `hk-<序号>`；同一 `id` 已在等待响应时拒绝发送。
- **分发**：`type` 为 `response` 的记录按 `id` 交给等待中的 `send`；`extension_ui_request` 交给 `onUiRequest`；其余交给 `onEvent`。
- **单条记录上限**：默认 64 MiB（`DEFAULT_MAX_RECORD_BYTES`，含图片的消息可能很大）。
- **协议错误**：记录超过上限、不是合法 JSON、不是带字符串 `type` 的对象，或 stdout 结束时留有不以 LF 结尾的半条记录，都是协议错误（`RpcProtocolError`，`EHOSTKIT_RPC_PROTOCOL`）。传输层随即失效：通过 `onError` 报告，未完成的命令以该错误拒绝，之后的 `send` 也被拒绝。使用方应终止该次运行。
- **关闭**：stdout 结束时 `closed` resolve，未完成的命令以 `RpcClosedError`（`EHOSTKIT_RPC_CLOSED`）拒绝。
- **id**：写到 pi 的 `id` 一律由传输层生成（`hk-<序号>`），同一个传输对象内不重复；调用方在 `cmd.id` 里给的 id 不发给 pi，只在返回的响应里替换回去。所以调用方重复使用自己的 id 也不会让响应错配。
- **超时**：`send` 默认不设超时。设置 `timeoutMs` 时，到期后以 `RpcTimeoutError`（`EHOSTKIT_RPC_TIMEOUT`）拒绝；之后到达的响应作为 `late_response` 诊断报告。传输层只记住最近 1024 个超时的 id，更早的迟到响应报告为 `unmatched_response`；wire id 不重复，所以迟到响应不会交给新的命令。`abort` 必须设超时，见“进程树终止”。
- **监听器异常**：监听器抛出的异常不算协议错误，传输层继续工作；异常在微任务中重新抛出，由进程的未捕获异常处理。
- 不用 pi 自带的 `RpcClient`：它的公开声明里没有回应扩展 UI 请求的接口（依据：`dist/modes/rpc/rpc-client.d.ts`）。

## 受管进程与进程身份

```ts
export function spawnManaged(spec: SpawnSpec): Promise<ManagedProcess>;

export interface SpawnSpec {
  argv: string[];               // [cliEntry, ...pi 参数]，以 process.execPath 经启动门闩执行
  cwd: string;                  // 作为 spawn 参数，不调用 process.chdir()
  env: Record<string, string>;  // pi 的完整环境变量，不与宿主的环境合并
  runId: string;                // 使用方分配
  instanceId: string;           // 使用方（daemon 或 pane 服务端）本次启动的实例 id
  startHeld?: boolean;          // 停在启动门闩直到 release()，默认 false
  containment?: "auto" | "snapshot"; // Linux：auto 在可用时使用 cgroup v2，snapshot 强制快照模式
  maxRecordBytes?: number;      // RPC 单条记录上限，默认 64 MiB
  snapshotIntervalMs?: number;  // 快照模式下工具执行期间的快照间隔，默认 5000
}

export interface ProcessIdentity {
  pid: number;
  startTime: string;            // 操作系统记录的进程创建时间，格式因平台而异，只比较相等
  runId: string;
  instanceId: string;
  cgroup?: string;              // Linux cgroup v2：所在 scope 目录的绝对路径
}

export interface ManagedProcess {
  readonly identity: ProcessIdentity;
  readonly rpc: RpcTransport;
  readonly coverage: StopCoverage;   // stop 将报告的覆盖范围
  readonly held: boolean;            // release() 之前为 true
  release(): void;                   // 放行启动门闩，可重复调用
  stop(opts?: StopOptions): Promise<StopReport>; // 并发和重复调用共享同一结果
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  onStderr(listener: (chunk: string) => void): () => void;
  stderrTail(): string;              // stderr 的最后 64 KiB
}

export function isSameProcess(id: Pick<ProcessIdentity, "pid" | "startTime">): Promise<"alive" | "gone">;
export function stopByIdentity(id: ProcessIdentity, opts?: StopOptions): Promise<StopReport>;
export function readIdentity(pid: number, runId: string, instanceId: string): ProcessIdentity | null;
export function currentProcessIdentity(instanceId: string, runId?: string): ProcessIdentity; // 宿主自身，用于 LockHost
export function linuxCgroupSupport(): Promise<string | null>; // 可用时返回 systemd-run 的路径
export function listProcesses(): ProcessRow[];
export function processInfo(pid: number): ProcessRow | null;
```

- 使用方把 `ProcessIdentity` 持久化（agora 写入 `process_runs` 表，pane 写入自己的运行记录；会话写锁的共享记录也保存它）。
- `spawnManaged` 在进程身份已读出、Windows 上已加入 Job Object、Linux cgroup 模式下已进入自己的 scope 之后才返回。启动失败时杀掉已启动的进程并抛出错误：进程在启动中退出或没有进入 scope 时为 `EHOSTKIT_SPAWN`，加入 Job 失败时为原生模块报告的错误。
- POSIX 上进程以 `detached` 方式启动，自成进程组（pgid 等于它的 pid）；Windows 上 `windowsHide: true`。
- stderr 一直被读取（避免管道塞满），最后 64 KiB 保存在 `stderrTail()` 里，供退出诊断使用。

### 启动门闩

宿主必须在 pi 打开会话文件、启动任何子进程之前记下它的进程身份（会话写锁的 `writer`），Windows 上还要先把它加入 Job Object。pi-hostkit 用一个启动门闩做到这一点，三个平台的做法相同：

1. `spawnManaged` 运行 `process.execPath dist/gate.js <cliEntry> <pi 参数…>`。
2. gate 从 stdin 逐字节读一行（最多 256 字节）。逐字节读取保证放行行之后的 RPC 输入不被 gate 消耗。
3. 这一行等于 `pi-hostkit-gate-release-v1`（`GATE_RELEASE_LINE`）时，gate 把 `process.argv` 设为 `[node, cliEntry, ...pi 参数]`，再 `import(cliEntry)` 加载 pi。pi 与 gate 是同一个进程，PID 和创建时间不变。
4. stdin 结束或内容不符时，gate 以退出码 75（`GATE_REFUSED_EXIT_CODE`）退出，不加载 pi。

放行规则：

- `startHeld` 为 false（默认）时，`spawnManaged` 在返回前放行。
- `startHeld` 为 true 时，进程停在 gate，直到调用 `release()`。放行前 `rpc.send` 和 `rpc.respondUi` 抛出 `RpcClosedError`。
- 放行前调用 `stop()` 会关闭 stdin，gate 以退出码 75 退出。宿主被杀时 stdin 的管道关闭，gate 同样自行退出，不会在宿主不在的情况下加载 pi。
- 会话写锁的 `spawnWriter` 按“停在 gate → 写入 `writer` → 放行”的顺序使用门闩，见“取得锁之后”。

pi 启动后用扩展在 `session_start` 中握手、宿主写入记录后再放行的办法不能作为门闩：到达握手点之前，pi 已经可能改写会话文件（见“取得锁的时机”）。

### 进程身份

判断一个记录中的进程是否还活着，必须 PID 存在、创建时间相同，且不是僵尸进程；只有 PID 相同不算。任何终止操作之前都先做这项检查，身份不符时不发信号。能把目标固定住时（见“快照模式”中的 pidfd 和 Windows 句柄），检查之后 PID 被复用也不会误发；固定不住的情况在检查和发送之间仍有复用的可能，见“剩余风险”。

查询进程表失败（权限、I/O 错误等）时抛出错误，不返回“不存在”：`processInfo` 只在进程确实不存在时返回 `null`，`isSameProcess` 只在确实不存在或身份不符时返回 `gone`。所以“无法判断”不会被当成“已退出”。

| 平台 | `startTime` 的取法 |
| --- | --- |
| Linux | `<boot_id>:<ticks>`：`/proc/sys/kernel/random/boot_id` 加 `/proc/<pid>/stat` 第 22 字段（开机后的时钟滴答数）。boot_id 每次开机都变，所以机器重启后记录的身份不再匹配。不用 `/proc/stat` 的 `btime` 换算绝对时间：两次读取之间它可能相差 1 秒。 |
| macOS | `sysctl(KERN_PROC)` 中的启动时间（`p_starttime`），格式 `秒.微秒`（微秒 6 位） |
| Windows | `NtQuerySystemInformation(SystemProcessInformation)` 中的创建时间（FILETIME，100 纳秒单位）的十进制数，与 `GetProcessTimes` 的值相同 |

进程表的父进程、进程组和创建时间必须来自同一个进程：macOS 用 `sysctl(KERN_PROC_ALL)`，Windows 用 `NtQuerySystemInformation`，两者都一次返回整张表。不用 Windows 的 Toolhelp 快照：它只给父 PID，再按 PID 打开进程读创建时间时，PID 可能已经属于另一个进程，会把无关进程误认为后代。

- 只比较相等，不跨平台解析。按创建时间排序只用于“子进程不能早于父进程”的检查（见“快照模式”）。
- 僵尸进程（POSIX 上已退出未回收）视为已退出；Windows 上已退出但句柄未关闭的进程同样视为已退出。

## 进程树终止

目标：停止一个受管 pi 后，它启动的命令进程（包括 `bash` 工具的后台进程和孙进程）都不留下。能否保证取决于平台，由 `coverage` 标明。

```ts
export interface StopOptions {
  abortTimeoutMs?: number;      // RPC abort 的等待上限，默认 10000
  graceMs?: number;             // 关闭 stdin 后等待自行退出，默认 5000
  termGraceMs?: number;         // POSIX：SIGTERM 后等待，默认 3000
}

export type StopCoverage = "job_object" | "cgroup" | "snapshot_visible";

export interface StopReport {
  steps: { step: string; at: string; ok: boolean; detail?: string }[];
  coverage: StopCoverage;       // 最终终止能覆盖的范围；snapshot_visible 只覆盖快照见过的进程
  leftovers: { pid: number; startTime: string; exe?: string }[]; // 覆盖范围内复查后仍存活的进程，正常为空
}
```

| `coverage` | 平台 | 含义 |
| --- | --- | --- |
| `job_object` | Windows | Job 内的所有进程 |
| `cgroup` | Linux（cgroup v2 可用） | scope 内的所有进程 |
| `snapshot_visible` | macOS；Linux 无 cgroup 或 `containment: "snapshot"` | 只覆盖快照见过的进程，`leftovers` 为空不证明没有残留 |

pi 1.5.0 的 `bash` 工具在 POSIX 上以 `detached` 方式启动每条命令（新会话、新进程组，依据：`dist/core/tools/bash.js:65`），只对 pi 自己的进程组发信号杀不到这些命令。pi 在 RPC 模式下收到 SIGTERM 或 SIGHUP 时会先终止它记录的命令进程树（依据：`dist/modes/rpc/rpc-mode.js:276–283`），但被 SIGKILL 时来不及清理。

### 停止步骤

调用方在调用 `stop` 之前，按自己的语义决定是否先发 `clear_queue`（见 pi `docs/rpc-commands.md` 的 `clear_queue`）。`stop` 的步骤如下，每一步写入 `StopReport.steps`：

| 步骤（`step`） | 平台 | 做法 |
| --- | --- | --- |
| `abort` | 全部 | 发 RPC `abort`，等待 `abortTimeoutMs`。进程已退出或仍停在 gate 时跳过（`ok: false`，`detail` 说明原因）。超时不中止停止流程。 |
| `closeInput`、`grace` | 全部 | 关闭 stdin，等待 `graceMs` 让 pi 自行退出 |
| `SIGTERM` | macOS、Linux | pi 仍在运行时，检查身份后向 pi 发 SIGTERM，让 pi 清理它记录的命令，等待 `termGraceMs`。pi 是宿主尚未回收的子进程，它的 PID 在这期间不会被复用 |
| 最终终止 | 按平台 | 见下面各节 |
| `verify` | 全部 | 在 2 秒内复查覆盖范围内的进程；pi 本身仍存活时也计入 `leftovers` |

`stop` 的并发调用和重复调用共享同一个结果。`StopOptions` 逐项取默认值，显式传 `undefined` 也用默认值；值必须是 0 到 2³¹−1 之间的有限毫秒数，否则以 `EINVAL` 拒绝，保证每一步的等待都有上限。

### Windows

- 启动：每个受管 pi 放进一个独立的 Job Object，设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，不允许 breakaway。加入 Job 前再次核对进程身份。加入发生在 gate 等待放行期间，pi 尚未加载，所以不会有子进程在加入 Job 之前启动。
- 最终终止：`TerminateJobObject`（`step` 为 `TerminateJobObject`），然后复查 Job 内进程数为 0。
- Job 内的后代进程不论父进程是否已退出都在 Job 里，所以“pi 主进程先退出、孙进程还在”的情况同样能清理。
- Job 句柄不可继承，只由宿主持有。宿主（daemon 或 pane 服务端）退出或被强杀时句柄关闭，Job 内所有进程随之终止。

### Linux

有 cgroup v2 时默认把受管进程放进独立的 systemd scope（`containment: "auto"`）：

- 检测：第一次需要时检测一次并缓存结果。条件是 `/sys/fs/cgroup/cgroup.controllers` 存在，并且 `systemd-run --user --scope` 能实际运行一个命令并进入 `.scope`。这需要当前用户的 systemd 实例（用户已登录，或开启了 lingering），并且宿主进程的环境能连到这个实例（通常靠 `XDG_RUNTIME_DIR` 和 `DBUS_SESSION_BUS_ADDRESS`）。
- 启动：`systemd-run --user --scope --quiet --collect --unit=pi-hostkit-<runId>-<8 位十六进制随机数> -- node gate.js …`。`runId` 中 `[A-Za-z0-9_.-]` 以外的字符换成 `_`，最长 64 个字符。systemd-run 把自己移入 scope 后 exec node，PID 不变。宿主环境中的 `XDG_RUNTIME_DIR` 和 `DBUS_SESSION_BUS_ADDRESS` 会传给 systemd-run（`spec.env` 中同名变量优先），因此 pi 也能看到这两个变量。宿主等待进程进入 `<unit>.scope` 后，把 scope 目录记入 `ProcessIdentity.cgroup`。
- 最终终止：向 scope 的 `cgroup.kill` 写 `1`（`step` 为 `kill cgroup`），它作用于整棵子树。写入报 `ENOENT` 时，只有 scope 目录确实已不存在才算已清空；目录还在说明内核没有 `cgroup.kill`，按下面的旧内核方式处理。内核早于 5.14 没有 `cgroup.kill` 时，逐个向 scope 及其子 cgroup 中的进程发 SIGKILL，每次发信号前确认该进程仍在这个 scope 里且身份一致。
- 复查：读 `cgroup.events` 的 `populated`，它反映整棵子树；为 0 或 scope 目录已被回收即为清空。`cgroup.events` 读不到或无法解析时不算清空。没有清空时，`leftovers` 列出子树中仍存活的进程；进程表里找不到对应进程时，以 `pid: 0`、`exe: "cgroup <目录>"` 的一项表示 scope 未清空。
- `containment: "snapshot"` 时不使用 scope，按快照模式处理。检测不通过（没有 cgroup v2、没有 `systemd-run` 或没有用户 systemd 实例）时同样退回快照模式。

### 快照模式

用于 macOS，以及没有 cgroup v2 或指定 `containment: "snapshot"` 的 Linux。进程表在 Linux 上读 `/proc`，在 macOS 上用原生模块调用 `sysctl(KERN_PROC_ALL)`。

- 记录内容：pi 的全部后代，以及与 pi 同一进程组（pgid 等于 pi 的 pid）的成员，按 PID 和创建时间记录。沿父子关系查找后代时，创建时间早于父进程的记录被跳过，以免把父 PID 被复用的进程误认为后代；Linux 上不同 boot_id 的记录也被跳过。
- 读完进程表后重新核对用来归属后代的每个父进程（以及 pi 本身）是否还是同一个进程，不是的就丢掉经由它找到的行。Linux 逐个读 `/proc`，读的过程中父进程可能退出、PID 被无关进程复用，它的子进程就会被误认为后代。
- 只在 pi 本身仍以记录的身份存活时添加记录。pi 退出后它的 PID（也就是进程组号）可能被无关进程复用，这时按 PID 或进程组号新找到的进程都不可信，只使用之前已经核对过的记录。
- 快照时机：收到 `tool_execution_start` 事件时立即快照，之后在有工具执行期间每 `snapshotIntervalMs`（默认 5000）一次，最后一个 `tool_execution_end` 后停止定时快照；`stop` 开始时、发 SIGTERM 前、最终 SIGKILL 前各再快照一次。pi 先退出、后代被系统收养后，仍能按记录找到它们。
- 最终终止（`step` 为 `SIGKILL descendants` 和 `SIGKILL pi group`）：
  1. 对每个仍存活（身份一致）的记录：若它当前所在的进程组不是 pi 的进程组，经由这个记录向该进程组发 SIGKILL；再向它本身发 SIGKILL。
  2. pi 或某个记录仍存活且当前就在 pi 的进程组里时，经由它向 pi 的进程组发 SIGKILL。
  3. 复查记录中的进程都已不在，仍存活的写进 `leftovers`。
- 每次发信号前都重新检查身份（PID 和创建时间），进程组只经由一个身份一致、当前就在该组里的成员去发。该成员存在期间组号不会被复用。
- Linux 用 pidfd 发信号：先 `pidfd_open`，再核对身份，再 `pidfd_send_signal`。pidfd 固定指向打开时的进程，核对之后 PID 即使被复用，信号也不会发给新进程。发给进程组时，先核对成员身份，再打开组长（PID 等于组号、且当前在该组的进程）的 pidfd，然后重新核对该成员仍是同一进程且仍在这个组，最后以 `PIDFD_SIGNAL_PROCESS_GROUP`（Linux 6.9 起）经由组长的 pidfd 发送：这个标志按 pidfd 所指进程的 PID 寻址进程组，所以只能用组长的 pidfd。组长已退出或内核更早时，重新核对成员后退回 `kill(-pgid)`。没有 pidfd 的内核（5.3 之前）退回检查后 `kill`。macOS 没有 pidfd，检查后 `kill`（见“剩余风险”）。

### 停止遗留进程

`stopByIdentity` 供宿主停止一个没有 RPC 连接的进程，通常是上一个宿主实例留下的 pi（见“场景”中的“宿主被强杀”和“取得锁之后”）。没有 RPC 连接，所以不发 `abort`、不关闭 stdin，`abortTimeoutMs` 和 `graceMs` 不起作用。

- macOS、Linux：进程身份一致时检查后发 SIGTERM，等待 `termGraceMs`；然后按下面两种情况最终终止。
  - 记录中有 `cgroup`，路径形如 `/sys/fs/cgroup/…/pi-hostkit-<…>-<8 位十六进制>.scope` 且目录存在：整体终止该 scope（与 `stop` 相同），即使 pi 本身已退出也终止，因为这个 scope 只装着这一次运行的进程。其他形式的 `cgroup` 路径（例如上级 slice）被忽略，按快照处理。`coverage` 为 `cgroup`。
  - 否则在 pi 仍存活时当场快照它的后代和进程组成员，按快照模式的步骤终止。没有运行期间的快照记录，覆盖范围只是此刻能看到的进程；pi 已退出时不按 PID 或进程组号查找任何进程。`coverage` 为 `snapshot_visible`。
- Windows：宿主退出时 Job 已终止受管进程，所以通常已无事可做。进程仍存活时，对 pi 及此刻快照中的后代逐个 `TerminateProcess`（终止前在打开的句柄上核对创建时间）。`coverage` 为 `snapshot_visible`。
- 身份不一致的进程不会收到任何信号；`steps` 中 `identity` 一步记录 `alive` 或 `gone`。

### 场景

| 场景 | 处理 |
| --- | --- |
| 正常停止 | 按“停止步骤” |
| pi 不响应 `abort` | `abortTimeoutMs` 到期后继续后面的步骤，`StopReport` 记录 abort 失败 |
| pi 主进程先退出，后代仍在 | Windows：Job 内仍可终止；Linux cgroup：scope 内仍可终止；快照模式：用运行期间的记录和当前快照清理 |
| 进程仍停在 gate | 跳过 `abort`，关闭 stdin 后 gate 以退出码 75 退出 |
| 宿主被强杀 | Windows：Job 关闭，受管进程随之终止。macOS、Linux：已放行的 pi 可能仍在运行（Linux 上仍在自己的 scope 里），停在 gate 的进程因 stdin 关闭而退出。宿主重启后读出持久化的 `ProcessIdentity`，对仍存活（身份一致）的进程调用 `stopByIdentity` 并确认退出后，才允许再次打开同一会话文件。另一个宿主先取得该文件的写锁时，按“取得锁之后”清理同一个进程 |
| 宿主所在机器重启 | 所有记录的进程身份都不再匹配，按“已退出”处理 |

## 锁

两种锁都由操作系统在持有进程退出时自动释放，不依赖锁文件是否被删除。不使用“排他创建锁文件 + 发现残留时改名”的方案：判断残留和改名之间存在 ABA 竞态，两个进程可能同时认为自己拿到了锁。

```ts
export function acquireInstanceLock(name: string, scopeDir: string): Promise<HeldLock | null>; // null：已被占用

export function acquireSessionWriterLock(sessionFile: string, host: LockHost): Promise<SessionWriterLock | SessionLockBusy>;
export function isSessionWriterLock(value: SessionWriterLock | SessionLockBusy): value is SessionWriterLock;
export function probeSessionWriterLock(sessionFile: string): Promise<{ held: boolean; record?: SessionLockRecord }>;
export function sessionLocksDir(): string; // ~/.pi/hostkit/locks

export interface HeldLock { release(): Promise<void> }
export interface SessionLockBusy { heldBy?: SessionLockRecord }

export interface LockHost {
  app: "pi-pane" | "pi-agora";      // 只用于显示持有者，不影响协议
  identity: ProcessIdentity;        // 持锁的宿主进程，见 currentProcessIdentity
}

export interface RecoverOptions extends StopOptions {
  assumeNoWriter?: boolean;         // 只在用户确认没有遗留 pi 后使用，见“取得锁之后”
}

export interface SessionWriterLock extends HeldLock {
  readonly sessionFile: string;                       // 规范化后的会话文件路径
  readonly previous?: SessionLockRecord;              // 取得锁时读到的上一份记录
  readonly recoveryReports: readonly StopReport[];    // recoverPreviousWriter 停止遗留写者的报告
  recoverPreviousWriter(opts?: RecoverOptions): Promise<"none" | "stopped" | "failed">;
  update(patch: Partial<Pick<SessionLockRecord, "writer" | "state">>): Promise<void>;
  spawnWriter(spec: Omit<SpawnSpec, "startHeld">): Promise<ManagedProcess>;
}

/** 与锁放在一起的共享记录，两个宿主都读写同一格式 */
export interface SessionLockRecord {
  version: 1;
  sessionFile: string;              // 规范化后的会话文件路径
  host: LockHost;                   // 当前（或最后一个）持锁宿主
  writer?: ProcessIdentity;         // 实际写这个文件的 pi 进程；尚未拉起时为空
  state: "starting" | "running" | "stopping" | "released";
  updatedAt: string;                // ISO 8601
}
```

### 实现

| 平台 | 实现 |
| --- | --- |
| Windows | 命名 mutex，名称见下文。持有进程退出后 mutex 变为 abandoned，下一个获取者得到所有权（`WAIT_ABANDONED` 视为取得锁）。mutex 的所有权属于线程，线程退出时就会变为 abandoned，所以只能在主线程上获取和释放；在 Worker 线程调用时抛出 `EHOSTKIT_THREAD`。 |
| macOS、Linux | 打开（必要时以 `0600` 创建）锁文件，`flock(LOCK_EX \| LOCK_NB)`，文件描述符由宿主进程持有（`O_CLOEXEC`，不传给子进程）。锁文件永不删除：删除会让两个进程分别锁住新旧两个文件。 |

- 获取都不等待：已被占用时立即返回。
- 同一进程内重复获取同一把锁视为已被占用，与 `flock` 在不同打开文件描述之间互斥的语义一致；Windows 的 mutex 本身允许同一线程重复获取，由 pi-hostkit 在进程内拒绝。这项检查只在同一份 pi-hostkit 模块内有效：一个进程加载了两份 pi-hostkit 时，Windows 上两份可以重复取得同一把锁。宿主进程只应加载一份。

### 单实例锁

- 用于 agora daemon 和 pane 服务端，`scopeDir` 为各自的数据目录或其子目录。
- `name` 限 `[A-Za-z0-9._-]{1,64}`，否则抛出 `EINVAL`。`scopeDir` 不存在时创建，并检查在本地磁盘上。
- POSIX 锁文件：`<scopeDir 的真实路径>/<name>.lock`。
- Windows mutex：`Local\pi-hostkit-v1-instance-<sha256("instance\n" + comparisonKey(scopeDir 的真实路径) + "\n" + name)>`。
- 拿到锁后，使用方才写自己的发现信息文件（如 agora 的 `run/daemon.json`）。发现信息只用于找到对方，不作为互斥依据。

### 会话写锁

同一个 pi 会话文件同一时间只能有一个托管写者。pi-pane 和 pi-agora 使用同一协议，所以两者不会同时托管同一个会话。

- 锁目录：`~/.pi/hostkit/locks`（`sessionLocksDir()`，三个平台相同）。每次获取或探测时用 `ensurePrivateDir` 创建或收紧它，并检查在本地磁盘上。
- 会话文件也必须在本地磁盘上，`acquireSessionWriterLock` 检查它（不存在时检查最深的已存在祖先），否则抛出 `EHOSTKIT_REMOTE_FS`。锁只在一台机器内互斥；网络文件系统上的会话可能被另一台机器上的宿主用它自己的锁目录同时打开。
- 会话 key：`k = sha256(comparisonKey(会话文件的真实路径))` 的十六进制。会话文件不存在时，取最深的已存在祖先的真实路径，再接上其余部分（`realPathOrPending`，见“路径规范化”）。
- POSIX 锁文件：`<锁目录>/session-<k>.lock`。
- Windows mutex：`Local\pi-hostkit-v1-session-<sha256("session\n" + k)>`。
- 共享记录：`<锁目录>/session-<k>.json`（三个平台都有；Windows 上锁本身是 mutex，目录里只有记录）。
- 持锁方是宿主进程（daemon 或 pane 服务端），不是 pi。
- `probeSessionWriterLock` 尝试获取后立即释放，用于显示“由谁托管”，不保留锁。

#### 共享记录

记录是恢复协议的一部分：它告诉下一个持锁方，上一个写者是哪个 pi 进程、停在什么状态。

- 只有持锁方写记录。写法为写同目录的临时文件（`0600`，排他创建）后改名替换；Windows 上目标文件正被其他进程短暂打开时，改名最多重试 20 次、每次间隔 25 毫秒。
- 内容为 `SessionLockRecord` 的 JSON。以下任一情况视为记录损坏：无法读取、不是合法 JSON、`version` 不是 1、`state` 不是四个取值之一、`sessionFile` 的 key 与这把锁不符、`host.app` 不是 `pi-pane` 或 `pi-agora`、`host.identity` 或 `writer` 不是完整的进程身份（正整数 `pid`、非空 `startTime`、字符串 `runId` 和 `instanceId`）、`updatedAt` 不是字符串。
- 持锁方依次写入：`recoverPreviousWriter` 成功后 `starting`（不带 `writer`）；pi 拉起后、加载前写入 `writer` 并改为 `running`（`spawnWriter` 自动完成）；停止时 `stopping`；确认 pi 及其进程树已退出后调用 `release()`，写 `released` 并释放锁。
- `release()` 只有在本宿主写过记录（`recoverPreviousWriter` 成功）时才写 `released`；`recoverPreviousWriter` 返回 `failed` 后记录保持原样。
- 宿主崩溃时不会写 `released`，记录停在最后一个状态，供下一个持锁方恢复。

#### 取得锁的时机

pi 在打开已有会话文件时就可能改写它：文件为空时写入会话头，旧格式时迁移后整体重写（依据：`dist/core/session-manager.js` 的 `_setSessionFile`、`_loadEntries`）。进程内切换会话时，这一步发生在旧会话的 `session_shutdown` 之前（依据：`dist/core/agent-session-runtime.js:128–143`）。所以写锁必须在 pi 打开文件之前取得：

| 情况 | 取锁时机 | 失败时 |
| --- | --- | --- |
| ① 拉起 pi 打开已有文件（`--session <文件>`） | 宿主在拉起 pi 之前 | 不拉起，告诉使用方“已被 <host> 托管” |
| ② 拉起 pi 新建会话 | 宿主预先分配一个确定的路径（会话目录下的新文件名），取得该路径的锁后用 `--session <该路径>` 拉起。路径含 `/` 或以 `.jsonl` 结尾时，pi 把参数当作路径；文件不存在时 pi 新建会话并沿用这个路径（依据：`dist/main.js` 的 `resolveSessionPath`、`dist/core/session-manager.js` 的 `_setSessionFile` 的 else 分支）。不用 `--session-id` 让 pi 自己生成路径 | 换一个路径重试 |
| ③ 进程内切换到已有会话（RPC `switch_session`，或扩展调用 `switchSession`，即 `reason = "resume"`） | 宿主自己发 RPC 时，在发送之前取得目标文件的锁；由扩展发起时，宿主放在 pi 里的桥接扩展在 `session_before_switch`（带 `targetSessionFile`）里同步请求宿主取锁 | 桥接扩展返回 `{ cancel: true }`，切换不发生 |
| ④ 进程内新建或分叉（RPC `new_session`、`fork`、`clone`，或扩展调用 `newSession`、`fork`） | 新文件的路径由 pi 生成（会话目录下的 `<时间>_<新会话 id>.jsonl`），`session_before_switch`（`reason = "new"`）和 `session_before_fork` 都不带这个路径；最早在 `session_shutdown` 的 `targetSessionFile` 里出现。宿主（经桥接扩展）在 `session_shutdown` 时取得新路径的锁 | 见下文 |
| ⑤ 宿主在自己进程内预先建文件，再拉起 pi 打开它（如 pi-pane 只读视图的“Fork 为新会话”用 `SessionManager.forkFrom()` 复制出新文件，依据：`dist/core/session-manager.js` 的 `forkFrom`。`forkFrom()` 会改动源文件（见 earendil-works/pi#11867），所以 pi-pane 对源文件的临时副本调用它，并在取锁前把新文件会话头的 `parentSession` 修正为原始源文件路径，细节见 pi-pane [`docs/architecture.md` 的“拉起”](https://github.com/PosvdM/pi-pane/blob/main/docs/architecture.md#拉起)） | 先写后锁：`forkFrom` 以新生成的会话 id 命名并用排他方式创建新文件，宿主在它返回后取得新文件的锁，再按①拉起 pi。理由同④中带叶子的 fork：新文件名是新生成的，其他宿主不会预先持有它的锁 | 不拉起，删除刚建的文件或保留并告诉使用方 |

关于④：

- `new` 和不带叶子的 `fork`：新文件要等会话里出现第一条 user 或 assistant 消息才写入（依据：`dist/core/session-manager.js` 的 `_persist`、`_hasConversation`），这发生在新会话的 `session_start` 之后，所以在 `session_shutdown` 时取锁仍早于第一次写入。
- 带叶子的 `fork` 和 `clone`：分支上已有对话时，pi 在 `session_shutdown` 之前就写出新文件（依据：`dist/core/session-manager.js` 的 `createBranchedSession`、`dist/core/agent-session-runtime.js` 的 `fork`），宿主只能在写入之后取锁。新文件名带新生成的会话 id，其他宿主不会预先持有它的锁，所以实际不会冲突。
- 取锁失败时（理论上只有路径冲突），新会话已经无法取消。宿主停止向该进程发送任何输入，终止该进程（按“进程树终止”），把会话标为中断并告诉使用方。不论切换由宿主的 RPC 还是扩展命令发起，处理都一样。

切换成功后，旧文件的锁在新会话的 `session_start` 之后释放（记录写为 `released`），不必等 pi 退出：`session_start` 之前 pi 已对旧实例发出 `session_shutdown` 并拆除旧运行时，不会再写旧文件。切换失败时（没有等到新会话的 `session_start`，且 RPC `get_state` 的 `sessionFile` 仍是旧文件），宿主释放已取得的目标锁。agora 的协作会话禁止会话替换：daemon 不发这几种 RPC，agora 扩展注册 `session_before_switch` 和 `session_before_fork`，一律返回 `{ cancel: true }`。pi 只要有一个处理器返回取消，就不再执行后面的处理器并取消替换（依据：`dist/core/extensions/runner.js:813–825`），所以 implement 档位按白名单加载的其他扩展也无法发起替换。

宿主与桥接扩展还要遵守：

- **`session_start` 幂等**：RPC 替换会话（new、resume、fork、clone）时，runtimeHost 替换完成后和 RPC 自身重新绑定时各触发一次 `session_start`（依据：`dist/modes/rpc/rpc-mode.js` 与 `dist/core/agent-session-runtime.js`）。宿主及桥接扩展必须对 `session_start` 做幂等处理（复用同一个就绪 Promise，每个实例只绑定一次监听）。
- **启动阶段的退出码**：ticket 被抢先兑换、ticket 失效或扩展加载失败时，pi 会在响应 `get_state` 之前以退出码 1 退出。宿主遇到启动阶段的退出码 1，按 ticket 或扩展启动故障处理，记下诊断（`stderrTail()`），不自动重试。退出码 75 表示进程停在 gate 时被拒绝放行，pi 没有加载。

#### 取得锁之后

锁被释放只说明上一个**宿主**已经退出或放手，不说明它的 pi 已经退出（POSIX 上宿主被强杀时 pi 可能仍在运行）。任何宿主取得会话写锁后、启动新写者之前，都要调用 `recoverPreviousWriter`。它按以下步骤判断：

1. 记录损坏（见“共享记录”）→ `failed`。
2. 没有记录，或 `state = "released"` → `none`，没有遗留写者。
3. 有 `writer` → 用 `isSameProcess` 判断。已退出，且（Linux）它记录的 scope 里也没有进程 → `none`。否则调用 `stopByIdentity` 停止整棵进程树（pi 已退出时也会清空它自己的 scope），然后检查：`StopReport.leftovers` 为空、`writer` 已退出、scope 已清空 → `stopped`；否则 `failed`。
4. 状态不是 `released` 且没有 `writer`（上一个宿主在拉起 pi 和写入记录之间退出）→ 在进程表里查找候选进程。候选必须同时满足：
   - 命令行的第一或第二个参数是 pi-hostkit 的 gate（绝对路径、文件名 `gate.js`，同一目录下有 `gate-protocol.js`），其后是 pi 的入口和 pi 参数；
   - 按 pi 自己的参数规则（见下文“pi 参数规则”），pi 会以 RPC 模式把 `--session` 给出的路径作为会话文件打开，且这个路径规范化后与该会话文件相同。

   Windows 用 `NtQueryInformationProcess` 读出命令行，再用 `CommandLineToArgvW` 拆成参数；macOS 和 Linux 直接读参数。`--session` 的值的含义取决于那个进程时（相对路径、`~` 开头、Windows 上没有盘符的 `\…` 或 Git Bash 形式的 `/c/…`），无法得知它的工作目录和环境，视为“无法判断”，不代入宿主自己的目录和环境。找到的候选按第 3 步停止。**没找到，或有无法判断的进程，都不能排除遗留写者**，返回 `failed`。

结果的处理：

- `none` 或 `stopped`：把记录改写为本宿主的 `starting`（不带 `writer`）。之后才能调用 `update` 和 `spawnWriter`；在此之前调用它们抛出 `EHOSTKIT_LOCK_STATE`。`recoverPreviousWriter` 每把锁只能调用一次。
- `failed`：锁被自动释放，记录保持原样，不拉起新写者。使用方告诉用户“上一个写者状态不明”，用户人工确认没有遗留的 pi 进程后，使用方重新取锁并以 `assumeNoWriter: true` 调用，此时第 1 步和第 4 步中无法判断的部分按 `none` 处理（agora 中这是用户级操作）。找到的候选仍会被停止，停止失败仍是 `failed`。
- 恢复过程中抛出错误（例如进程表无法读取，或写入 `starting` 记录失败）时，锁同样被释放，错误抛给调用方。
- 停止遗留写者产生的 `StopReport` 保存在 `recoveryReports` 里。

同一把锁上的 `recoverPreviousWriter`、`update`、`spawnWriter`、`release` 按调用顺序逐个执行，后一个等前一个完成。所以在恢复进行中调用 `release()`，释放会排在恢复之后，恢复不会在锁已释放后再写记录；`release()` 之后其他操作抛出 `EHOSTKIT_LOCK_STATE`。`update` 不接受 `state: "released"`（用 `release()`），`writer` 必须是完整的进程身份；值为 `undefined` 的字段保持不变。

恢复成功后，用 `spawnWriter` 拉起新写者。它按协议顺序执行：以 `startHeld` 启动（停在 gate）→ `update({ writer, state: "running" })` → `release()`。所以 pi 加载、打开会话文件之前，它的身份已经在记录里。写记录失败时停止该进程并抛出错误。

- 按 pi 自己的参数规则，`spec.argv`（`[cliEntry, ...pi 参数]`）必须让 pi 以 RPC 模式打开这把锁的会话文件，并且不带 `--continue`、`--resume`、`--session-id`、`--print` 等会另选会话的选项，否则抛出 `EINVAL`。
- `--session` 的值必须是不依赖 pi 的环境和工作目录的绝对路径：POSIX 上以 `/` 开头，Windows 上带盘符（`C:\…`、`C:/…`）或是服务器名和共享名都不为空的 UNC 路径（`\\server\share\…`）。`~`、相对路径、Windows 上没有盘符的路径都被拒绝：pi 按自己的 `HOME`（`spec.env`）、工作目录（`spec.cwd`）或当前盘解析它们，与宿主校验时看到的可能不是同一个文件。

#### pi 参数规则

判断“pi 实际打开哪个会话文件”时，不能只在参数里找字符串：`--` 之后的参数都是消息，`--session=…` 和 `--mode=rpc` 在 pi 1.5.0 里只是未知选项，很多选项会吃掉下一个参数。`src/piargs.ts` 照搬 pi 1.5.0 `parseArgs`（`dist/cli/args.js`）的规则，包括 `--tools` 的写法检查（`getToolListError`），再按 `main` 和 `createSessionManager`（`dist/main.js`）在打开会话之前的退出条件判断。pi 以 `--session` 的路径为会话文件，需要同时满足：没有解析错误；不是 `--version`、`--export`；RPC 模式；RPC 模式下没有 `@file` 参数；没有 `--fork`；`--session-id` 不与 `--session` 同时出现；没有 `--no-session`、`--help`、`--list-models`；`--session` 的值像路径（含 `/` 或 `\`，或以 `.jsonl` 结尾；否则 pi 把它当会话 id）。`test/piargs.test.mjs` 把这套规则与 pi 的 `parseArgs` 逐项比对。
- 同一把锁一次只能有一个经 `spawnWriter` 拉起、仍在运行的写者；前一个退出之前再次调用抛出 `EHOSTKIT_LOCK_STATE`。

第 4 步只在宿主在“拉起 pi”和“写入 `writer`”之间退出时出现。配合启动门闩，这个窗口里的 pi 还停在 gate，宿主退出后 gate 读到 stdin 结束而自行退出，不会加载 pi。下一个持锁方查找时，gate 进程通常已经退出，结果是 `failed`，需要用户确认后以 `assumeNoWriter` 继续；仍停在 gate 的进程按命令行能找到并停止。pi 加载后会设置 `process.title`，在 macOS 和 Linux 上这会覆盖进程的命令行，所以第 4 步实际只能找到仍停在 gate 的进程；不按协议放行、又没有记录的 pi 找不到，结果仍是 `failed`（fail closed）。只认 pi-hostkit 的 gate 并精确比较 `--session`，是为了不停止无关的进程：例如恢复 `a.jsonl` 时，打开 `a.jsonl.bak` 的进程，或参数里碰巧带有这个路径的其他程序。

这样不论上一个写者属于 pi-pane 还是 pi-agora，新持锁方都会先清理它。

#### 外部写者与协议版本

- 终端里直接运行的 pi 不参与这个协议，pi-hostkit 无法发现它。如何处理这种外部写者由使用方决定（pi-pane 见其 `docs/architecture.md`）。
- 协议版本体现在名称中（`v1`）。改变锁文件或 mutex 的名称和位置、会话 key 的算法、共享记录的格式或语义，都属于不兼容修改，pane 和 agora 必须同时升级。

## 密钥目录权限

```ts
export function ensurePrivateDir(dir: string): Promise<void>;                      // 创建或收紧，失败时抛出 EHOSTKIT_NOT_PRIVATE
export function writePrivateFile(file: string, data: Uint8Array): Promise<void>; // 排他创建，仅当前用户可读写
export function checkPrivate(path: string): Promise<{ ok: boolean; problem?: string }>;
```

| 平台 | 做法 |
| --- | --- |
| Windows | 原生调用 `SetNamedSecurityInfoW` 设置受保护的 DACL（不继承上级目录的权限），其中只有一项：当前用户 SID 完全控制；目录的这一项可继承到子目录和文件。用 SID，不依赖本地化的账户名，也不调用 `icacls`。 |
| macOS | 目录 `0700`、文件 `0600`，并且没有扩展 ACL。扩展 ACL 可以在权限位之外给其他用户授权，`chmod` 不会清除它。 |
| Linux | 目录 `0700`、文件 `0600`。POSIX ACL 不需要另外检查：组权限位为 0 时 ACL 的 mask 为 0，命名用户和组的条目不生效。 |

- `ensurePrivateDir`：创建目录（含缺失的上级目录）。已存在时：POSIX 上属主必须是当前用户，权限宽于 `0700` 时收紧为 `0700`，macOS 上清除扩展 ACL；Windows 上重新设置 DACL。路径是符号链接或不是目录时抛出。最后用 `checkPrivate` 复查，不满足时抛出 `EHOSTKIT_NOT_PRIVATE`。
- `writePrivateFile`：父目录必须已经私密（`checkPrivate` 通过），否则抛出 `EHOSTKIT_NOT_PRIVATE`。文件排他创建（已存在时以 `EEXIST` 失败）：Windows 上由原生 `createPrivateFile` 以带受保护 DACL（只有当前用户）的安全描述符调用 `CreateFileW(CREATE_NEW)`，权限在创建的同一步生效，没有别人能打开它的间隙（只靠私密的父目录不够：拥有“绕过遍历检查”特权的用户可以不经父目录的检查直接打开文件，而事后收紧权限撤销不了别人已经拿到的句柄）；POSIX 上以 `0600` 创建，macOS 上再清除扩展 ACL（父目录没有可继承的 ACL）。然后写入数据并 `fsync`。失败时删除该文件。最后用 `checkPrivate` 复查。
- `checkPrivate` 的条件：
  - POSIX：不是符号链接；属主是当前用户；目录权限不宽于 `0700`、文件不宽于 `0600`；macOS 上没有扩展 ACL。
  - Windows：不是符号链接；DACL 存在且受保护；allow 项只有当前用户 SID；属主是当前用户、Administrators（`S-1-5-32-544`）或 SYSTEM（`S-1-5-18`）。后两者本来就能读所有文件，以管理员身份创建的文件属主是 Administrators。

这一层只防其他操作系统用户。与用户同为一个系统用户的进程（包括 Agent 启动的命令）仍能读这些文件，相应的安全设计见 pi-agora 的 [`docs/security.md`](https://github.com/PosvdM/pi-agora/blob/main/docs/security.md)。

## 路径规范化

用于路径校验（agora 的受保护目录、只读根目录）、会话写锁的 key、会话文件的比较。

```ts
export function canonicalPath(input: string, cwd: string, mode: "read" | "write"): Promise<string>;
export function canonicalPathSync(input: string, cwd: string, mode: "read" | "write"): string;
export function resolveToolPath(input: string, cwd: string): string;      // pi 的 resolveToCwd，不访问文件系统
export function resolveReadToolPath(input: string, cwd: string): string;  // pi 的 resolveReadPath
export function normalizeWindowsShellPath(filePath: string): string;      // /c/...、/mnt/c/... → C:\...
export function realPathOrPending(target: string): string;
export function comparisonKey(canonical: string): string;
export function isWithin(root: string, target: string): boolean;     // target 是 root 或在其下
export function isAncestorOf(dir: string, target: string): boolean;  // dir 是 target 的祖先（或相同）
```

这些函数也从子路径 `pi-hostkit/paths` 导出，该入口不加载原生模块。

`canonicalPath` 的步骤：

1. **与 pi 解析工具路径的规则一致**，确保校验的是 pi 实际会打开的文件（`resolveToolPath`）：把 Unicode 空格（`U+00A0`、`U+2000–U+200A`、`U+202F`、`U+205F`、`U+3000`）换成普通空格，去掉开头的一个 `@`；Windows 上把 Git Bash、MSYS、Cygwin、WSL 形式的盘符路径（`/c/...`、`/mnt/c/...`、`/cygdrive/c/...`）转成 `C:\...`；展开 `~`；`file://` URL 转路径；再相对 `cwd` 解析（依据：`dist/utils/paths.js` 的 `normalizePath`、`resolvePath`，`dist/core/tools/path-utils.js` 的 `resolveToCwd`）。
2. `mode = "read"` 时还按 pi 的 `resolveReadPath` 依次尝试 macOS 截图名的窄不换行空格变体、NFD 变体、弯引号变体及 NFD 加弯引号变体，取第一个存在的文件（`resolveReadToolPath`，依据：`dist/core/tools/path-utils.js`）。
3. **真实路径**（`realPathOrPending`）：`fs.realpathSync.native` 解析符号链接和 Windows junction。目标不存在时（如 `write` 新文件），对最深的已存在祖先取真实路径，再拼上其余部分。悬空的符号链接被跟随到它指向的位置，即写入实际创建文件的位置；超过 40 层链接时抛出 `ELOOP`。比较路径前两方都必须是真实路径（macOS 上同一个临时目录可能表现为 `/private/var` 或 `/var`）。
4. **比较键**（`comparisonKey`）：
   - Windows：分隔符统一为 `\`，去掉 `\\?\` 前缀（`\\?\UNC\` 转为 `\\`），折叠大小写（与 pi 的 `getPathComparisonKey` 一致，忽略 NTFS 按目录开启的大小写敏感）。
   - macOS：转为 NFC 并折叠大小写（默认 APFS 卷不区分大小写，对 Unicode 规范化不敏感）。
   - Linux：不变。

`isWithin` 和 `isAncestorOf` 比较两个真实路径的比较键，按路径分隔符判断，`/a/bc` 不在 `/a/b` 之下。

pi 的这些函数位于内部模块，不在包的公开导出里，所以 pi-hostkit 自行实现同样的规则。`test/paths.test.mjs` 直接导入 pi 1.5.0 的内部模块逐项比对；升级支持的 pi 版本时先跑这组测试。

## 平台差异汇总

| 能力 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 启动门闩 | gate 等待期间加入 Job | gate | gate（cgroup 模式下在 systemd scope 内） |
| 进程树终止 | Job Object（`job_object`） | 进程组 + 进程表快照（`snapshot_visible`） | cgroup v2 scope（`cgroup`）；不可用时同 macOS |
| 宿主被强杀后 | 受管进程随 Job 终止 | 已放行的 pi 可能存活，重启后按身份停止 | 同 macOS（pi 仍在自己的 scope 里） |
| 单实例锁、会话写锁 | 命名 mutex | `flock` | `flock` |
| 进程表与创建时间 | `NtQuerySystemInformation` | `sysctl(KERN_PROC)` | boot_id + `/proc/<pid>/stat` 第 22 字段 |
| 发信号 | `TerminateProcess`（已核对身份的句柄） | 检查身份后 `kill` | pidfd |
| 读取命令行 | `NtQueryInformationProcess` + `CommandLineToArgvW` | `KERN_PROCARGS2` | `/proc/<pid>/cmdline` |
| 密钥权限 | 受保护 DACL | `0700/0600`，无扩展 ACL | `0700/0600` |
| 本地磁盘检查 | 驱动器类型、UNC | `MNT_LOCAL` | `statfs` 魔数 |
| 路径比较 | 折叠大小写、统一分隔符 | 折叠大小写、NFC | 原样 |

## 验证状态

### 自动测试覆盖

CI（`.github/workflows/ci.yml`）在 ubuntu-latest（cgroup 模式和快照模式各一次）、macos-latest、windows-latest 上用 pi 1.5.0 运行全部测试。测试用本地假 provider（`test/fixtures/fake-provider.ts`）驱动真实的 pi 进程，不联网。覆盖：

- **锁**：单实例锁在同一进程内重复获取被拒、持有进程被强杀后由操作系统释放；会话写锁的获取、记录、占用结果和释放；`recoverPreviousWriter` 之前 `update` 被拒；恢复与释放并发时按调用顺序执行、释放后不能再拉起写者；`spawnWriter` 按 pi 的参数规则校验（`--` 之后的 `--session`、`--session=…`、带 `--continue` 都被拒）并限制同时一个写者。
- **pi 参数规则**：`parsePiArgs` 与 pi 1.5.0 的 `parseArgs` 差分比对，覆盖 `--`、取值选项吃掉下一个参数、未知选项、`-p`、`--list-models`、`--tools` 写法错误、`@file` 等情况；依赖 pi 环境的路径（相对、`~`、Windows 无盘符）判为无法判断，`spawnWriter` 拒绝它们。
- **跨宿主恢复**：宿主进程用 `spawnWriter` 拉起 pi 后被强杀，另一个宿主取锁并停止遗留写者（用例以 pi-pane 为前者、pi-agora 为后者；`app` 字段只是标签，两个方向走同一代码路径）。Windows 上 pi 随 Job 终止，结果为 `none` 或 `stopped`（Job 结束可能略晚于 mutex 被释放）。
- **fail closed**：宿主在 pi 停在 gate 时被杀，gate 自行退出，下一个持锁方得到 `failed`，`assumeNoWriter` 后为 `none`；仍停在 gate 的未记录进程按命令行找到并停止；打开 `<会话>.bak` 的 gate、`--session <会话>` 出现在 `--` 之后（只是消息）的 gate、`--session` 为相对路径的 gate 都不被停止，结果为 `failed`；不按协议放行的未记录 pi 无法排除时返回 `failed`；记录不是合法 JSON 或内容不完整时返回 `failed` 且记录不变。
- **启动门闩**：用已存在的空会话文件验证放行前 pi 没有加载（pi 加载后立即写入会话头），放行前 RPC 发送被拒；直接测试 gate：stdin 结束、内容不符、超长无换行时以退出码 75 退出且不加载入口，放行行与第一条 RPC 在同一次写入中到达时入口拿到完整的参数和下一行，CRLF 放行行被接受；停在 gate 的进程被 `stop` 时以退出码 75 退出（POSIX；Windows 上可能先被 Job 终止）。
- **进程树终止**：`bash` 工具及脱离 pi 进程组（POSIX 用 `setsid`）的后台进程都被清理，除 `leftovers` 为空外还在测试进程里独立确认该后台进程已不存在（三个平台）；pi 先被 SIGKILL、后代仍在时，`stop` 仍清理后代（三种覆盖方式）；`abort` 超时仍完成停止；`stop` 重复调用返回同一结果；`StopOptions` 显式 `undefined` 用默认值、`NaN` 和 `Infinity` 被拒；`coverage` 与平台和模式相符。
- **进程身份**：创建时间不符的身份判为 `gone`；`stopByIdentity` 不对创建时间不符的身份发信号，并能停止被强杀宿主留下的 pi（macOS、Linux；Windows 上验证 pi 随 Job 终止）；记录的 PID 已成为另一个进程组的组长时，该组不会收到信号（macOS、Linux）；读进程表期间父进程的 PID 换了进程时，经由它找到的行被丢掉（用构造的进程表测试）；不是 pi-hostkit 创建的 cgroup 路径不会被整体终止（Linux）。
- **Linux cgroup**：CI 开启用户 systemd 实例并要求 cgroup 可用；另一轮以 `containment: "snapshot"` 覆盖快照模式。
- **密钥权限**：`ensurePrivateDir` 创建与收紧、`writePrivateFile` 排他且私有、父目录不私密时拒绝写入、Windows 上带私密 DACL 创建文件、`checkPrivate` 报告过宽的权限；macOS 上扩展 ACL 被报告并被 `ensurePrivateDir` 清除。
- **本地磁盘**：系统临时目录被判为本地，不存在的路径按最深的已存在祖先检查。
- **定位 pi**：版本区间与预发布后缀、`piPath` 的两种写法、非 pi 目录被拒、经 `npm root -g` 找到全局安装。
- **路径**：与 pi 1.5.0 内部函数的差分比对（`resolveToolPath`、`resolveReadToolPath`、`normalizeWindowsShellPath`）、符号链接与不存在的部分、悬空链接、链接循环、`isWithin` 的前缀边界、三个平台的比较键；macOS 上大小写不同的路径共用一把会话写锁。
- **RPC 分帧**：只按 LF 切分（`U+2028`、`U+2029` 保留）、CR 去除、跨块拼接与多字节字符、记录上限、末尾半条记录、乱序响应、事件与 UI 请求分发、超时与迟到响应、超过 1024 次超时后迟到响应也不会交给复用了调用方 id 的新命令、非法 JSON、stdout 结束、监听器异常。

CI 还为 linux x64/arm64、darwin arm64/x64、win32 x64/arm64 构建预编译模块，并在非交叉编译的平台上加载一次。

### 尚未验证

- 真实的 PID 复用和机器重启后的身份判断（测了伪造创建时间的记录，以及记录的 PID 属于另一个进程组组长的情况）。
- 身份检查与发信号之间的竞态（见“剩余风险”），以及 Linux pidfd 的进程组信号在 6.9 之前的内核上的退回路径。
- Windows 进程表快照之后 PID 被复用的故障注入；cgroup 子树（scope 下另建子 cgroup）中的残留；进程表查询失败（权限、I/O 错误）的故障注入。
- macOS 快照模式的两种盲窗：已收窄承诺并以 `coverage` 标明，没有消除，也没有测试。
- 网络文件系统的实际拒绝：只测了本地磁盘被接受，没有在 NFS、SMB 等挂载上测试。
- Windows 原生 PowerShell 和 junction 的路径校验。
- NTFS 按目录开启的大小写敏感（比较键会把这类目录中只有大小写不同的两个文件视为同一路径）。
- Linux 没有用户 systemd 实例时自动退回快照模式（快照模式本身已用 `containment: "snapshot"` 测试）。
- 预编译模块随包分发后的安装体验。

## 剩余风险

- **快照盲窗**：在 macOS 上（及不用 cgroup 的 Linux 上），以下两种情况会留下孤儿进程，且复查无法发现（`leftovers` 仍为空，所以必须以 `coverage: "snapshot_visible"` 标明覆盖边界）：
  1. 两次快照之间，后代进程 `setsid` 后其父进程退出，接着 pi 被 SIGKILL；
  2. `bash` 用 `nohup … &` 起了后台进程，而该命令在第一次快照之前就结束了（pi 正常停止时也会遗漏）。

  可以调研的办法：在 pi 里用扩展包住 `bash` 工具，命令一启动就把进程组上报给宿主，以兜住早退的后台进程（视 pi 扩展接口能力而定，目前不承诺）。
- **身份检查到发信号的竞态**：每次发信号前都核对进程身份，但只有能把目标固定住时，核对和发送之间才没有空当。固定得住的情况：Windows（在已核对身份的句柄上 `TerminateProcess`）、Linux 的单个进程（pidfd）、Linux 6.9 起组长仍在的进程组（组长的 pidfd，打开后再核对已记录的成员仍在组内）、宿主停止自己尚未回收的子进程 pi。固定不住、存在“检查后再 `kill`”空当的情况：macOS 上终止 pi 以外的进程（pi 的后代、进程组），Linux 上组长已退出或内核早于 6.9 时的进程组信号（`kill(-pgid)`，发送前重新核对已记录的成员仍在组内），以及没有 pidfd 的 Linux 内核（5.3 之前）。要在其间发错信号，目标必须恰好退出、它的 PID（或组号）又被新进程用上；两个系统都按顺序分配 PID，需要在这段时间里把 PID 空间用完一圈。正常执行时这段时间很短，但宿主进程可能在核对之后被系统调度暂停，所以没有时间上限的保证。这项风险已确认接受，没有消除。
- **写者已退出、后代仍在（无 cgroup）**：macOS 和不用 cgroup 的 Linux 上，`recoverPreviousWriter` 判断记录的 `writer` 已退出时返回 `none`，不清理它可能留下的后代进程（这些进程不写会话文件，但可能占用资源）：pi 已退出后，按 PID 或进程组号找到的进程无法确认属于它。Linux cgroup 模式下会清空它的 scope；Windows 上 Job 已终止这些进程。
- **非受管进程**：不是由受管进程启动的进程（如通过计划任务、系统服务、`launchd`、`systemd` 启动的）不在 Job、scope、进程组或进程树里，无法清理。
- **未记录的已放行 pi**：不按协议（不经 `spawnWriter` 或不写 `writer`）放行的 pi，在 macOS 和 Linux 上无法按命令行找到，恢复只能返回 `failed`，由用户确认。
- **路径校验的时间差**：校验与 pi 实际打开文件之间存在时间差，期间链接被替换会绕过校验（TOCTOU）。路径校验只是工具层的限制，不是沙箱。
- **Linux 环境变量**：cgroup 模式下 pi 能看到宿主的 `XDG_RUNTIME_DIR` 和 `DBUS_SESSION_BUS_ADDRESS`（`spec.env` 中未指定时），可经用户会话总线访问用户的 systemd 实例。pi 本来就以同一系统用户运行，这不扩大权限边界。
