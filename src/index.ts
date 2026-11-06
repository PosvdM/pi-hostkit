export { locatePi, isSupportedPiVersion, PI_PACKAGE_NAME, SUPPORTED_PI_RANGE } from "./locate.js";
export type { PiInstall, LocatePiOptions } from "./locate.js";

export { StdioRpcTransport, JsonlSplitter, RpcTimeoutError, RpcProtocolError, RpcClosedError, DEFAULT_MAX_RECORD_BYTES } from "./rpc.js";
export type {
  RpcTransport,
  RpcTransportOptions,
  RpcCommand,
  RpcResponse,
  RpcEvent,
  ExtensionUiRequest,
  ExtensionUiResponse,
  RpcDiagnostic,
} from "./rpc.js";

export {
  spawnManaged,
  stopByIdentity,
  isSameProcess,
  readIdentity,
  currentProcessIdentity,
  linuxCgroupSupport,
} from "./process.js";
export type {
  ProcessIdentity,
  ManagedProcess,
  SpawnSpec,
  StopOptions,
  StopReport,
  StopCoverage,
  Containment,
} from "./process.js";

export { listProcesses, processInfo } from "./proctable.js";
export type { ProcessRow } from "./proctable.js";

export {
  acquireInstanceLock,
  acquireSessionWriterLock,
  probeSessionWriterLock,
  isSessionWriterLock,
  sessionLocksDir,
} from "./locks.js";
export type {
  HeldLock,
  LockHost,
  SessionLockRecord,
  SessionWriterLock,
  SessionLockBusy,
  RecoverOptions,
  RecoverResult,
} from "./locks.js";

export { ensurePrivateDir, writePrivateFile, checkPrivate } from "./secrets.js";
export type { PrivateCheck } from "./secrets.js";

export { assertLocalFilesystem, filesystemInfo } from "./localfs.js";

export {
  canonicalPath,
  canonicalPathSync,
  comparisonKey,
  isWithin,
  isAncestorOf,
  resolveToolPath,
  resolveReadToolPath,
  normalizeWindowsShellPath,
  realPathOrPending,
} from "./paths.js";
export type { PathMode } from "./paths.js";

export { GATE_RELEASE_LINE, GATE_REFUSED_EXIT_CODE } from "./gate-protocol.js";
