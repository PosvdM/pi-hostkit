# 系统边界与故障测试

本清单按调用位置列出系统查询、发信号、记录与私密文件的读写。每一行对应[故障处理不变式](design.md#故障处理不变式)；同一操作的多个平台实现分别列出。测试文件路径相对于仓库根目录。

测试使用独立进程的模块 mock、内部依赖替换或临时源码副本。原生故障测试在临时目录编译带系统调用包装器的副本，逐项注入失败并核对堆内存、句柄/描述符和 ACL/LocalFree 资源的净变化。故障开关与计数器不进入生产构建或包入口。

## TypeScript 边界

| 位置 | 查询或副作用 | 故障预期与测试 |
| --- | --- | --- |
| `localfs.ts:filesystemInfo` | 真实路径解析、逐层 `statSync`、原生 `fsInfo` | 仅 `ENOENT` 上溯；其他错误直接失败，不跨挂载边界借用本地祖先；`test/localfs-faults.test.mjs`。 |
| `paths.ts:resolveReadToolPath` | 依次查询读取路径与拼写变体 | 未知查询不换成另一个文件；`test/paths-faults.test.mjs`。 |
| `paths.ts:realPathOrPending` | `realpathSync.native`、`lstatSync`、`readlinkSync` | 权限、I/O 与链接查询错误直接传播，不当成缺失；悬空链接跟随实际目标；`test/paths-faults.test.mjs`、`test/paths.test.mjs`。 |
| `paths.ts:detectCaseSensitivity` | `statSync`、真实路径、`readdirSync`、原始及大小写别名 `lstatSync` | 无法证明不区分大小写就拒绝；不跨设备推断；`test/paths-faults.test.mjs`、`test/paths-case.test.mjs`。 |
| `fs-probe.ts:pathExistsStrict` | 严格 `statSync` 存在性查询 | 仅 `ENOENT`/`ENODEV` 算缺失；`test/existence-faults.test.mjs`。此规则服务 cgroup 与 gate 恢复，不用于本地磁盘祖先上溯。 |
| `locate.ts:readPackage`、`installAt` | 包记录读取与 JSON、`realpath`、入口 `stat` | 损坏或缺失候选按定位规则处理；系统查询错误不能伪装成不存在；`test/locate-faults.test.mjs`、`test/locate.test.mjs`。 |
| `locate.ts:fromPiPath` | 显式路径 `stat`、`realpath`、逐层包查询 | 显式失败不回退，查询错误可见；`test/locate-faults.test.mjs`。 |
| `locate.ts:fromManagedInstall` | `managed-install.json`、`current-version`、激活包查询 | 损坏元数据可继续候选，权限/I/O 错误保留；`test/locate-faults.test.mjs`。 |
| `locate.ts:npmRootGlobal`、`locatePi` | `execFile` 调用 npm；失败缓存清理 | 命令失败可重试，不留下拒绝的缓存；`test/locate-faults.test.mjs`。 |
| `native.ts:native`、`nativeFn` | `node-gyp-build` 加载、原生函数存在性 | 加载失败不缓存半成品；函数缺失抛出 `ENOTSUP`；`test/native-loader.test.mjs`。 |
| `locks.ts:acquireInstanceLock`、会话锁入口 | 创建目录、真实路径、本地卷与私密目录检查 | 前置查询失败不取得原生锁；`test/locks-faults.test.mjs`。 |
| `locks.ts:acquireRaw` | `flockAcquire` 或 `userSid`/`mutexAcquire` | 只在确实竞争时返回占用；获取后校验异常回收；`test/locks-faults.test.mjs`、`test/locks.test.mjs`、`test/windows-mutex.test.mjs`。 |
| `locks.ts:RawLock.release` | `fdClose` 或 `mutexRelease`、进程内 held key | 释放失败不能宣布已释放，也不能重放可能已关闭或复用的资源编号；`test/locks-faults.test.mjs`。 |
| `locks.ts:readRecord`、`recordProblem` | 记录读取、JSON、记录路径比较与卷探测 | 非 `ENOENT` 读取失败和路径校验异常属于损坏/未知；不得当成没有前任；`test/locks-faults.test.mjs`、`test/locks.test.mjs`。 |
| `locks.ts:writeRecord` | `openSync(wx)`、`writeFileSync(fd)`、`closeSync`、`renameSync`、失败 `unlinkSync` | 创建/部分写/改名失败回收本次临时文件；清理错误可见；更新与释放提交失败保持旧记录和占用；`test/locks-faults.test.mjs`、`test/locks.test.mjs`。 |
| `locks.ts:probeSessionWriterLock`、获取后的记录读取 | 原生锁取得后的记录读取与临时释放 | 任意异常都走回收路径；`test/locks.test.mjs`、`test/locks-faults.test.mjs`。 |
| `locks.ts:findWritersByCommandLine`、`gateIndex` | 进程列表、命令行、gate 协议文件存在性、路径比较 | 不可读候选属于未知，不能被另一已停止候选掩盖；部分进程表仍清理可读候选，之后保留枚举失败和停止失败；`test/existence-faults.test.mjs`、`test/locks.test.mjs`、`test/locks-faults.test.mjs`。 |
| `locks.ts:recoverPreviousWriter` | 写者身份、scope 人口、停止前任、提交 `starting` | 查询失败释放取得的锁且保留旧记录；停止报告保留；原始故障与释放故障同时可见；`test/locks-faults.test.mjs`、`test/locks.test.mjs`。 |
| `locks.ts:spawnWriter` | 查询已有写者、启动 gate、提交 writer、放行；异常停止 | 登记失败不能放行；登记/放行与停止同时失败保留原因和占用；`test/locks-faults.test.mjs`、`test/locks.test.mjs`。 |
| `locks.ts:SessionWriterLock.release` | 写者退出查询、提交 `released`、原生释放 | 未确认退出不释放；提交失败可重试；`test/locks.test.mjs`、`test/locks-faults.test.mjs`、`test/fixtures/release-query-fault.mjs`。 |
| `secrets.ts:checkPrivate` | `lstat`、Windows SID/DACL、macOS ACL | 查询失败不得返回 `ok: true`；`test/secrets-faults.test.mjs`。 |
| `secrets.ts:ensurePrivateDir` | `mkdir`、`lstat`、`chmod`、ACL 修改与最终复查 | 任一步失败拒绝，不声称已私密；`test/secrets-faults.test.mjs`、`test/misc.test.mjs`。 |
| `secrets.ts:writePrivateFile` | 父目录检查、排他创建/重新打开、ACL、写入、`sync`、`close`、最终复查、失败删除 | 仅清理本次创建文件；关闭、删除与原故障保留；最终复查失败也清理；`test/secrets-faults.test.mjs`。 |
| `gate.ts:readLine` | `readSync` 读取放行行 | `EAGAIN` 有界间隔重试；EOF、EPIPE、权限与 I/O 错误拒绝加载入口；`test/gate-faults.test.mjs`、`test/gate.test.mjs`。 |
| `rpc.ts` | stdin `write`/回调/`drain`/`end`，stdout data/error/end/close | 失败清理队列、pending、计时器和监听器，收尾失败不能覆盖首错；`test/rpc-faults.test.mjs`、`test/rpc.test.mjs`。 |
| `proctable.ts:linuxRow`、`bootId` | `/proc/<pid>/stat`、`boot_id` | 只有确认缺失返回 null；截断、格式和 boot 查询失败可见且不缓存失败；`test/process-faults.test.mjs` 的 `proctable-faults.mjs`。 |
| `proctable.ts:listProcesses` | `/proc` 列举与逐 PID 查询；原生整表查询 | 单 PID 失败保留可读行及错误，快照继续独立分支；`test/process-faults.test.mjs`、`test/snapshot-faults.test.mjs`。 |
| `proctable.ts:processCommandLine` | `/proc/<pid>/cmdline` 或原生命令行 | 不可读返回未知或抛错，由恢复 fail closed；`test/process-faults.test.mjs`、`test/existence-faults.test.mjs`、原生故障 worker。 |
| `proctable.ts:signalProcess`、`signalGroupLinux` | pidfd 打开、成员/组长身份复查、pidfd 发信号、`process.kill`、fd 关闭 | 只对身份一致目标发送；只为已约定的不支持错误退路；原始与关闭失败同时保留；`test/process-faults.test.mjs` 的 `proctable-faults.mjs`。 |
| `snapshots.ts:SnapshotRecords` | 进程表、父身份、逐目标身份、组和单进程信号、退出复查 | 局部失败不取消独立分支或 pi；已知未知身份留在报告；`test/snapshot-faults.test.mjs`、`test/process-faults.test.mjs`、`test/fixtures/capture-fault.mjs`。 |
| `process.ts` 的 Linux 能力与启动查询 | 控制器/可执行文件探测、`execFile(systemd-run)`、`/proc/<pid>/cgroup` | 不可用只选择有限覆盖的快照模式；启动失败不得放行 gate，不能用能力探测推断进程已退出；`test/process-faults.test.mjs`、`test/process.test.mjs`。 |
| `process.ts:spawnManaged` | `spawn`、初始身份、Job 创建与分配、RPC/Managed 构造、门闩放行及失败回收 | 启动失败关闭 gate/Job，清理错误不覆盖首错；`test/process-faults.test.mjs`、`test/process.test.mjs`。 |
| `process.ts:Managed.runStop` | abort、关闭输入、SIGTERM、Job 终止/列举/逐成员身份/关闭、最终 pi 复查 | 每阶段故障进入报告，Job 查询未知使用容器哨兵；句柄始终进入关闭路径；`test/process-faults.test.mjs`。 |
| `process.ts:stopByIdentity` | 根身份、Windows 快照/逐目标终止、recorded scope 查询、SIGTERM、最终停止 | 单目标失败不跳过其余目标；未知身份与快照失败可见；`test/process-faults.test.mjs`、`test/existence-faults.test.mjs`。 |
| `cgroups.ts:cgroupPopulated` | `cgroup.events`、目录严格存在性 | 文件缺失须确认整个目录已回收才算空；格式与查询失败均未知；`test/cgroup-faults.test.mjs`。 |
| `cgroups.ts:stopCgroup` 的列举 | 各层 `cgroup.procs`、`readdir`、缺失目录查询、逐 PID 身份 | 一棵子树失败不丢其他子树或已知身份；未知范围加哨兵；`test/cgroup-faults.test.mjs`、`test/cgroup-subtree.test.mjs`。 |
| `cgroups.ts:stopCgroup` 的终止与复查 | `cgroup.kill`、人口、成员资格、逐 PID 信号、独立 pi 信号、settle/最终查询 | 有界退路；单失败不中断独立清理；最终失败仍返回报告；`test/cgroup-faults.test.mjs`、`test/fixtures/cgroup-verify-fault.mjs`、`test/cgroup-subtree.test.mjs`。 |

## POSIX 原生边界

以下各行由 `test/native-faults.test.mjs` 编译临时模块，再在 `test/fixtures/native-fault-worker.mjs` 中执行；worker 的逐用例结果写入父测试诊断。内存分配、结果数组和 N-API 构造失败也核对临时资源净变化。

| 原生入口 | 系统边界 | 故障检查 |
| --- | --- | --- |
| `flockAcquire` | `open`、`flock`、失败关闭；返回 fd 构造 | 打开或加锁失败抛错，只有确认竞争返回 -1；后续失败回收 fd。 |
| `fdClose` | `close` | 失败可见，`EINTR` 不重试可能已复用的 fd 编号。 |
| `fsInfo` | `statfs` | 查询错误不返回本地结论；NUL 路径拒绝。 |
| Linux `pidfdOpen` | `syscall(pidfd_open)`、返回 fd 构造 | 只有 ESRCH 返回 -1，失败不泄漏 fd。 |
| Linux `pidfdSignal` | `syscall(pidfd_send_signal)` | ESRCH 才返回 false；EPERM/EINVAL/ENOSYS 交给调用方决定是否退路。 |
| macOS `processInfo` | `sysctl(KERN_PROC_PID)` | 查询失败及不完整结构抛错，不返回不存在。 |
| macOS `listProcesses` | `sysctl(KERN_PROC_ALL)` 的长度/填充与扩容 | 首次、填充、持续扩容、部分记录失败均可见并回收缓冲。 |
| macOS `processArgs` | `sysctl(KERN_ARGMAX)`、`KERN_PROCARGS2`、参数缓冲解析 | 两阶段查询、分配、截断和结果构造失败不返回可用参数；只有确认退出才返回 null。 |
| macOS `aclEntryCount` | `acl_get_link_np`、逐项 `acl_get_entry`、`acl_free` | 任一查询或释放失败可见，不能把迭代失败当成没有 ACL。 |
| macOS `aclClear` | `acl_init`、`acl_set_link_np`、`acl_free` | 创建、设置或释放失败可见，释放路径不漏 ACL。 |

## Windows 原生边界

同样由原生故障 worker 执行。Windows 真实 mutex 的 owner、DACL 与异主对象拒绝还由 `test/windows-mutex.test.mjs` 验证；CI 必须执行需提权的异主对象用例。

| 原生入口/内部步骤 | 系统边界 | 故障检查 |
| --- | --- | --- |
| `process_snapshot`、`processInfo`、`listProcesses` | 动态 NT 入口、`NtQuerySystemInformation`、缓冲扩容、快照转换 | NT 查询失败不能返回空表/不存在；持续扩容与数组构造失败回收缓冲。 |
| `processInfo` 的再次核对 | `OpenProcess`、`GetProcessTimes`、`WaitForSingleObject` | 访问或等待失败不能沿用旧快照，只有确认退出或身份变化才返回 null。 |
| `open_live`（命令行、终止、Job 分配共用） | `OpenProcess`、`WaitForSingleObject`、`GetProcessTimes`、失败关闭 | 查询失败传播，不能归类为已退出；失败释放临时进程句柄。 |
| `processCommandLine` | 动态 NT 入口、`NtQueryInformationProcess` 的长度/填充、UNICODE_STRING 范围、`CommandLineToArgvW`、缓冲/LocalFree | 两阶段查询、坏长度、解析、内存与 N-API 失败不能返回可用命令行，临时资源回收。 |
| `terminateProcess` | 固定身份的进程句柄、`TerminateProcess`、失败后的退出确认 | EPERM/访问拒绝不能直接当成 gone；身份不同不终止。 |
| `jobCreate` | `CreateJobObjectW`、`SetInformationJobObject`、返回句柄构造 | 配置或结果构造失败关闭 Job。 |
| `jobAssign` | `open_live`、身份比较、`AssignProcessToJobObject` | 任一查询、身份或分配失败拒绝并关闭临时句柄。 |
| `jobTerminate` | `TerminateJobObject` | 系统失败交给停止报告。 |
| `jobProcessIds` | `QueryInformationJobObject`、MORE_DATA 扩容、已分配数与返回数核对 | 持续扩容或成功但截断的结果不能当作完整或空 Job。 |
| `handleClose` | `CloseHandle` | 关闭错误可见。 |
| `current_user_sid`、`userSid` | `OpenProcessToken`、两阶段 `GetTokenInformation`、SID 复制、`ConvertSidToStringSidW` | 各查询与分配失败抛错，token、SID 与转换缓冲回收，不能返回 null SID。 |
| `user_mutex`、`mutexAcquire` | SID、`SetEntriesInAclW`、安全描述符初始化/owner/DACL/control、`CreateMutexW`、`GetSecurityInfo`、owner 验证、`WaitForSingleObject` | 任一步失败拒绝，清理 ACL/SD/SID/句柄；取得所有权后结果构造失败也释放所有权。 |
| `mutexRelease` | `ReleaseMutex`、`CloseHandle` | 释放与关闭失败可见；释放失败仍进入关闭路径；双失败保留两项原因。 |
| `fsInfo` | `GetVolumePathNameW`、`GetDriveTypeW` | 卷查询失败与未知卷类型不得返回可靠的本地结论；明确 UNC/remote 被拒绝。 |
| `setPrivateAcl` | SID、`SetEntriesInAclW`、`SetNamedSecurityInfoW` | ACL 构造/设置失败抛错，释放临时资源。 |
| `createPrivateFile` | SID、ACL、安全描述符初始化/DACL/control、`CreateFileW(CREATE_NEW)`、`CloseHandle` | 原子私密创建失败可见，不覆盖既有文件；关闭失败后尝试删除本次文件，删除失败与关闭失败同时可见。 |
| `readAcl` | `GetNamedSecurityInfoW`、`GetSecurityDescriptorControl`、逐项 `GetAce`、SID 转换、LocalFree 与返回结构构造 | 权限查询和结果构造失败不能返回不完整的安全结论，安全描述符和转换缓冲回收。 |

## 真实平台场景与边界

| 场景 | 运行位置与测试 | 未覆盖的部分 |
| --- | --- | --- |
| 大小写敏感 APFS | macOS CI：`hdiutil -fs "Case-sensitive APFS"` 磁盘映像，`test/platform-mounts.test.mjs` | 不等于测试所有 APFS 卷配置或外部设备。 |
| 子 cgroup 残留与局部失败 | Linux auto CI：真实 `Delegate=yes` scope 的两个子 cgroup，`test/cgroup-subtree.test.mjs` | 旧内核缺少 `cgroup.kill` 由注入模拟，不是旧内核实测。 |
| 远程挂载与查询失败 | Linux auto CI：SSHFS 连接本机 SSH server，`test/platform-mounts.test.mjs` | 未实测 NFS、SMB；SSH 服务运行在同一 runner，未测真实网络中断。 |
| Windows Global mutex | Windows CI：跨进程、owner/DACL、提权异主对象，`test/windows-mutex.test.mjs` | 没有两个真实登录会话。 |
| 原生查询/信号失败 | 三平台测试专用构建与原生故障 worker | 故障注入不代表真实内核异常、资源耗尽或 PID 复用已实测；真实竞态见设计文档“剩余风险”。 |

### 注入覆盖限制

- 资源释放的故障包装器先执行真实释放，再返回失败，用于检查错误可见、退出路径和不重复关闭。它不能证明操作系统真正拒绝释放后资源已经不存在；生产代码把这类结果视为未知。
- 原生模块尚未注入 `LocalFree` 失败、主操作与资源回收同时失败的完整组合，以及全部 N-API/错误构造的内存耗尽分支。系统查询、信号与记录的主要边界已有逐入口注入，不等于穷尽所有失败组合。
- SID 非法、罕见等待返回值、NT 缓冲的全部极端布局、所有 Windows 驱动器类型仍不具备完整矩阵；异主 mutex 有真实提权测试。

完整的未实测项以 [design.md 的验证状态](design.md#验证状态) 为准；issue #3 在真实 Windows 双登录会话与旧内核仍未验证时保持打开。
