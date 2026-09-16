import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readFile, writeFile, unlink, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const documentManaged = new AsyncLocalStorage<boolean>();
export const managedMutation = new AsyncLocalStorage<boolean>();
export const access = new AsyncLocalStorage<'read' | 'write'>();
export const safetyRoot = () =>
  process.env.PHOTOSHOP_SAFETY_DIR || join(tmpdir(), 'photoshop-mcp-safety');
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};
export async function quarantine(reason: string): Promise<void> {
  await mkdir(safetyRoot(), { recursive: true });
  await writeFile(
    join(safetyRoot(), 'uncertain.json'),
    JSON.stringify({ reason, at: new Date().toISOString() })
  );
}
export async function assertSafe(): Promise<void> {
  if (access.getStore() === 'read') return;
  try {
    await stat(join(safetyRoot(), 'uncertain.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(
    'outcome_unknown: writes blocked; inspect state then use photoshop_recover_connection'
  );
}
export async function clearQuarantine(): Promise<void> {
  await unlink(join(safetyRoot(), 'uncertain.json')).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e;
  });
}

/** Cross-process lease. An orphaned call is never silently treated as cancelled. */
export async function acquireLease(
  deadline: number
): Promise<{ child: (pid: number) => Promise<void>; release: () => Promise<void> }> {
  const root = safetyRoot();
  await mkdir(root, { recursive: true });
  const path = join(root, 'active.json');
  const owner = { pid: process.pid, childPid: 0, token: randomUUID() };
  while (Date.now() < deadline) {
    try {
      const file = await open(path, 'wx');
      await file.writeFile(JSON.stringify(owner));
      await file.close();
      return {
        child: async (pid) => {
          owner.childPid = pid;
          await writeFile(path, JSON.stringify(owner));
        },
        release: async () => {
          await unlink(path);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raw = await readFile(path, 'utf8').catch(() => '');
      let previous: typeof owner | undefined;
      try {
        previous = JSON.parse(raw);
      } catch {
        /* A live writer may be publishing its lease. */
      }
      if (previous && !alive(previous.pid) && (!previous.childPid || !alive(previous.childPid))) {
        let reclaimer;
        try {
          reclaimer = await open(join(root, 'reclaim.lock'), 'wx');
        } catch {
          /* Another client is reclaiming. */
        }
        if (reclaimer) {
          try {
            const current = await readFile(path, 'utf8').catch(() => '');
            if (current === raw) {
              await quarantine('MCP process exited during an Adobe call; verify application state');
              await unlink(path).catch((e: NodeJS.ErrnoException) => {
                if (e.code !== 'ENOENT') throw e;
              });
            }
          } finally {
            await reclaimer.close();
            await unlink(join(root, 'reclaim.lock'));
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  throw new Error('queue_timeout: operation was not dispatched');
}
