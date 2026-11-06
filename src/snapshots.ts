import type { ProcessIdentity, StopReport } from "./process.js";
import { listProcesses, matches, processInfo, signalProcess, verifiedDescendants, type ProcessRow } from "./proctable.js";

// Internal dependency seam for deterministic fault tests; not a package export.
const system = { listProcesses, processInfo, signalProcess, verifiedDescendants };

export class SnapshotRecords {
  readonly records = new Map<string, ProcessRow>();
  readonly failures: string[] = [];
  readonly captureFailures: string[] = [];

  constructor(private readonly root: ProcessIdentity, private readonly ops = system) {}

  remember(row: ProcessRow): void {
    this.records.set(`${row.pid}:${row.startTime}`, row);
  }

  capture(): void {
    const failed = (error: unknown, pid?: number) => {
      const detail = `${pid === undefined ? "process table" : pid}: ${(error as Error).message}`;
      if (!this.captureFailures.includes(detail)) this.captureFailures.push(detail);
    };
    try {
      const table = this.ops.listProcesses();
      if (!table.some((row) => matches(row, this.root))) return;
      // Confirm the root after reading the table, before attributing any new rows.
      if (!matches(this.ops.processInfo(this.root.pid), this.root)) return;
      const tree = this.ops.verifiedDescendants(table, this.root, (id) => {
        try {
          return matches(this.ops.processInfo(id.pid), id);
        } catch (error) {
          // Only this parent's chain is uncertain; independently checked branches survive.
          failed(error, id.pid);
          return false;
        }
      });
      for (const row of tree) this.remember(row);
      for (const row of table) {
        if (row.pgid === this.root.pid && row.pid !== this.root.pid) this.remember(row);
      }
    } catch (error) {
      failed(error);
    }
  }

  private failed(row: Pick<ProcessRow, "pid">, error: unknown): void {
    const detail = `${row.pid}: ${(error as Error).message}`;
    if (!this.failures.includes(detail)) this.failures.push(detail);
  }

  /** Unknown state stays in leftovers until a successful query proves exit. */
  alive(): ProcessRow[] {
    return [...this.records.values()].filter((row) => {
      try {
        return matches(this.ops.processInfo(row.pid), row);
      } catch (error) {
        this.failed(row, error);
        return true;
      }
    });
  }

  killDescendants(): number[] {
    const groups = new Set<number>();
    for (const row of this.records.values()) {
      try {
        const current = this.ops.processInfo(row.pid);
        if (!matches(current, row)) continue;
        const pgid = current!.pgid;
        if (pgid !== undefined && pgid !== this.root.pid && pgid > 1 && !groups.has(pgid)) {
          try {
            if (this.ops.signalProcess(row, "SIGKILL", pgid)) groups.add(pgid);
          } catch (error) {
            this.failed(row, error);
          }
        }
        // Failure to signal a group must not skip its individual member.
        this.ops.signalProcess(row, "SIGKILL");
      } catch (error) {
        this.failed(row, error);
      }
    }
    return [...groups];
  }

  rootAlive(): boolean {
    try {
      return matches(this.ops.processInfo(this.root.pid), this.root);
    } catch (error) {
      this.failed(this.root, error);
      return true;
    }
  }

  remaining(): { pid: number; startTime: string }[] {
    return [...this.alive(), ...(this.rootAlive() ? [this.root] : [])];
  }

  killRootGroup(): boolean {
    for (const member of [this.root, ...this.records.values()]) {
      try {
        if (this.ops.signalProcess(member, "SIGKILL", this.root.pid)) return true;
      } catch (error) {
        this.failed(member, error);
      }
    }
    return false;
  }
}

/** Shared final snapshot cleanup; dependency injection stays in this internal module. */
export async function stopSnapshot(
  records: SnapshotRecords,
  settle: (empty: () => boolean) => Promise<unknown>,
): Promise<StopReport> {
  const steps: StopReport["steps"] = [];
  const add = (step: string, ok: boolean, detail?: string) =>
    steps.push({ step, ok, at: new Date().toISOString(), ...(detail !== undefined ? { detail } : {}) });
  const groups = records.killDescendants();
  add("SIGKILL descendants", records.failures.length === 0, groups.length ? `process groups ${groups.join(",")}` : "none");
  const beforeRoot = records.failures.length;
  const rootSent = records.killRootGroup();
  add("SIGKILL pi group", records.failures.length === beforeRoot, rootSent ? "sent" : "no live member");
  await settle(() => records.remaining().length === 0);
  const leftovers = records.remaining().map(({ pid, startTime }) => ({ pid, startTime }));
  for (const failure of records.captureFailures) add("snapshot", false, failure);
  for (const failure of records.failures) add("snapshot cleanup", false, failure);
  return { steps, coverage: "snapshot_visible", leftovers };
}
