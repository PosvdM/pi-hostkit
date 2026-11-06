import { statSync } from "node:fs";
import path from "node:path";
import { native, type NativeFsInfo } from "./native.js";
import { realPathOrPending } from "./paths.js";

/** 检查目标实际写入位置所在的文件系统；缺失路径取最深的已存在祖先。 */
export function filesystemInfo(target: string): NativeFsInfo & { path: string } {
  let current = realPathOrPending(path.resolve(target));
  for (;;) {
    try {
      statSync(current);
      break;
    } catch (error) {
      // 权限或 I/O 错误不能借用祖先卷的本地磁盘结论。
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  return { ...native().fsInfo(current), path: current };
}

/**
 * 网络或用户态文件系统不保证 flock 和原子改名，数据和锁目录必须在本地磁盘上。
 * 确认非本地时抛出 EHOSTKIT_REMOTE_FS；无法查询时直接传播错误。
 */
export function assertLocalFilesystem(target: string): void {
  const info = filesystemInfo(target);
  if (!info.local) {
    throw Object.assign(new Error(`${target} 位于非本地文件系统（${info.type}），请使用本地磁盘`), {
      code: "EHOSTKIT_REMOTE_FS",
      path: target,
      fsType: info.type,
    });
  }
}
