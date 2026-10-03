import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { mkdir, readFile, writeFile, unlink, open, stat } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getLocalTempRoot, resolveLocalPath } from '../utils/local-path.js';

export const documentManaged = new AsyncLocalStorage<boolean>();
export const managedMutation = new AsyncLocalStorage<boolean | string>();
export const operationContext = new AsyncLocalStorage<{
  args: Record<string, unknown>;
  recoveryBackup?: string;
}>();
export const access = new AsyncLocalStorage<'read' | 'write'>();

export class DispatchNotStartedError extends Error {}

interface OperationScope {
  lease: Awaited<ReturnType<typeof acquireLease>>;
  deadline: number;
  mode: 'read' | 'write';
  expired: boolean;
  uncertain: boolean;
  dispatched: boolean;
  writeStarted: boolean;
  writeDispatches: number;
  bridgeTail: Promise<unknown>;
  pending: Set<Promise<unknown>>;
  inspectionPaths: Set<string>;
}
const operationLease = new AsyncLocalStorage<OperationScope>();

// Public operation promises can reject on deadline while their native bridge
// and lease cleanup are still running. Shutdown must await these job tails.
const operationCompletions = new Set<Promise<void>>();

/** Drain this process's accepted jobs only; never inspect or alter another client's lease. */
export async function drainOperationRunners(): Promise<void> {
  while (operationCompletions.size) await Promise.all([...operationCompletions]);
}

function timeoutError(scope?: OperationScope): Error {
  const paths = scope?.inspectionPaths.size
    ? '; inspection_paths=' + JSON.stringify([...scope.inspectionPaths])
    : '';
  return new Error(
    (scope?.dispatched
      ? 'outcome_unknown: execution deadline exceeded; inspect state before recovery'
      : 'queue_timeout: operation was not dispatched') + paths
  );
}

export function assertOperationActive(): void {
  const scope = operationLease.getStore();
  if (scope && (scope.expired || Date.now() >= scope.deadline)) {
    scope.expired = true;
    throw timeoutError(scope);
  }
}

export function registerInspectionPath(path: string): void {
  operationLease.getStore()?.inspectionPaths.add(path);
}

/** Only the API's per-call preflight marker proves that its edit body was not entered. */
export function confirmOperationBodyNotEntered(): void {
  const scope = operationLease.getStore();
  if (scope && (access.getStore() || scope.mode) === 'write') {
    scope.writeDispatches = Math.max(0, scope.writeDispatches - 1);
    scope.writeStarted = scope.writeDispatches > 0;
  }
}

export function operationNeedsInspection(): boolean {
  const scope = operationLease.getStore();
  return !!scope && (scope.uncertain || (scope.expired && scope.dispatched));
}

/** A bridge callback must call beforeDispatch immediately before starting its child. */
export function runOperationBridge<T>(
  body: (
    onChild: (pid: number) => Promise<void>,
    beforeDispatch: () => void,
    remainingMs: number
  ) => Promise<T>
): Promise<T> {
  const scope = operationLease.getStore();
  if (!scope) throw new Error('operation_scope_required');
  const mode = access.getStore() || scope.mode;
  const bound = AsyncResource.bind(async () => {
    assertOperationActive();
    let started = false;
    try {
      const value = await body(
        scope.lease.child,
        () => {
          assertOperationActive();
          started = true;
          scope.dispatched = true;
          if (mode === 'write') {
            scope.writeDispatches++;
            scope.writeStarted = true;
          }
        },
        Math.max(1, scope.deadline - Date.now())
      );
      return value;
    } catch (error) {
      if (error instanceof DispatchNotStartedError && started && mode === 'write') {
        scope.writeDispatches--;
        scope.writeStarted = scope.writeDispatches > 0;
      }
      if (String(error).includes('outcome_unknown')) scope.uncertain = true;
      throw error;
    }
  });
  const execution = scope.bridgeTail.then(bound);
  scope.bridgeTail = execution.catch(() => undefined);
  scope.pending.add(execution);
  void execution.then(
    () => scope.pending.delete(execution),
    () => scope.pending.delete(execution)
  );
  return execution;
}

/** Queue the whole operation before locking; nested calls reuse its lease. */
export class OperationRunner {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;

  run<T>(body: () => Promise<T>, timeoutMs = 30000, recovery = false): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      return Promise.reject(new Error('invalid_timeout'));
    if (operationLease.getStore()) {
      assertOperationActive();
      return body();
    }
    const deadline = Date.now() + timeoutMs;
    const mode = recovery ? 'read' : access.getStore() || 'write';
    return new Promise<T>((resolve, reject) => {
      let expired = false;
      let scope: OperationScope | undefined;
      let timeoutWork: Promise<void> | undefined;
      const timer = setTimeout(() => {
        expired = true;
        if (scope) scope.expired = true;
        timeoutWork = (async () => {
          if (scope?.writeStarted)
            await quarantine('Script exceeded deadline; execution may still be running');
          reject(timeoutError(scope));
        })().catch(reject);
      }, timeoutMs);
      const job = AsyncResource.bind(async () => {
        let lease: Awaited<ReturnType<typeof acquireLease>> | undefined;
        let result: T | undefined;
        let failure: unknown;
        let marked = false;
        try {
          if (expired || Date.now() >= deadline) throw timeoutError();
          lease = await acquireLease(deadline);
          if (expired || Date.now() >= deadline) throw timeoutError();
          if (!recovery) await access.run(mode, assertSafe);
          if (expired || Date.now() >= deadline) throw timeoutError();
          scope = {
            lease,
            deadline,
            mode,
            expired: false,
            uncertain: false,
            dispatched: false,
            writeStarted: false,
            writeDispatches: 0,
            bridgeTail: Promise.resolve(),
            pending: new Set(),
            inspectionPaths: new Set(),
          };
          if (mode === 'write') {
            await quarantine('Write in progress; inspect state if interrupted');
            marked = true;
          }
          if (expired || Date.now() >= deadline) throw timeoutError(scope);
          result = await operationLease.run(scope, () => access.run(mode, body));
          await Promise.allSettled([...scope.pending]);
          if (expired || Date.now() >= deadline) throw timeoutError(scope);
        } catch (error) {
          failure = error;
        } finally {
          if (scope) await Promise.allSettled([...scope.pending]);
          clearTimeout(timer);
          await timeoutWork;
          try {
            if (marked && ((!failure && !expired) || !scope?.writeStarted)) await clearQuarantine();
          } catch (error) {
            failure = error;
          } finally {
            if (lease)
              await lease.release().catch((error) => {
                failure = error;
              });
          }
        }
        if (failure) reject(failure);
        else if (!expired) resolve(result as T);
      });
      let complete!: () => void;
      const completion = new Promise<void>((done) => { complete = done; });
      operationCompletions.add(completion);
      this.queue.push(async () => {
        try {
          await job();
        } finally {
          operationCompletions.delete(completion);
          complete();
        }
      });
      void this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length) await this.queue.shift()!();
    } finally {
      this.processing = false;
    }
  }
}

const recoveryRunner = new OperationRunner();
/** Recovery holds the same lease while checking state and clearing quarantine. */
export function runRecoveryOperation<T>(body: () => Promise<T>, timeoutMs = 30000): Promise<T> {
  return recoveryRunner.run(body, timeoutMs, true);
}
export const safetyRoot = () => {
  return resolveLocalPath(process.env.PHOTOSHOP_SAFETY_DIR || join(getLocalTempRoot(), 'safety'));
};
/** Internal lease/marker files are owned by MCP and must never be redirected. */
function statePath(root: string, name: string): string {
  if (resolveLocalPath(root) !== root)
    throw new Error('operation_state_invalid: safety directory changed');
  const path = join(root, name);
  try {
    if (lstatSync(path).isSymbolicLink())
      throw new Error('operation_state_invalid: symbolic link in safety files');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return path;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};
export async function quarantine(reason: string): Promise<void> {
  const root = safetyRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(
    statePath(root, 'uncertain.json'),
    JSON.stringify({ reason, at: new Date().toISOString() })
  );
}
export async function assertSafe(): Promise<void> {
  if (access.getStore() === 'read') return;
  try {
    await stat(statePath(safetyRoot(), 'uncertain.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(
    'outcome_unknown: writes blocked; inspect state then use photoshop_recover_connection'
  );
}
export async function clearQuarantine(): Promise<void> {
  await unlink(statePath(safetyRoot(), 'uncertain.json')).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e;
  });
}

/** Cross-process lease. An orphaned call is never silently treated as cancelled. */
export async function acquireLease(
  deadline: number
): Promise<{ child: (pid: number) => Promise<void>; release: () => Promise<void> }> {
  const root = safetyRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const owner = { pid: process.pid, childPid: 0, token: randomUUID() };
  while (Date.now() < deadline) {
    try {
      const file = await open(statePath(root, 'active.json'), 'wx');
      await file.writeFile(JSON.stringify(owner));
      await file.close();
      return {
        child: async (pid) => {
          owner.childPid = pid;
          await writeFile(statePath(root, 'active.json'), JSON.stringify(owner));
        },
        release: async () => {
          await unlink(statePath(root, 'active.json'));
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raw = await readFile(statePath(root, 'active.json'), 'utf8').catch(() => '');
      let previous: typeof owner | undefined;
      try {
        previous = JSON.parse(raw);
      } catch {
        /* A live writer may be publishing its lease. */
      }
      if (previous && !alive(previous.pid) && (!previous.childPid || !alive(previous.childPid))) {
        let reclaimer;
        try {
          reclaimer = await open(statePath(root, 'reclaim.lock'), 'wx');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          /* Another client is reclaiming. */
        }
        if (reclaimer) {
          try {
            const current = await readFile(statePath(root, 'active.json'), 'utf8').catch(() => '');
            if (current === raw) {
              await quarantine('MCP process exited during an Adobe call; verify application state');
              await unlink(statePath(root, 'active.json')).catch((e: NodeJS.ErrnoException) => {
                if (e.code !== 'ENOENT') throw e;
              });
            }
          } finally {
            await reclaimer.close();
            await unlink(statePath(root, 'reclaim.lock'));
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  throw new Error('queue_timeout: operation was not dispatched');
}
