import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AsyncResource } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { MacOSExecutor } from '../src/platform/macos-executor.js';
import { WindowsExecutor } from '../src/platform/windows-executor.js';
import {
  access,
  acquireLease,
  assertOperationActive,
  assertSafe,
  clearQuarantine,
  drainOperationRunners,
  OperationRunner,
  runRecoveryOperation,
} from '../src/platform/operation-safety.js';
import { atomicSave } from '../src/utils/atomic-save.js';
import { getTargetDocumentId, runWithDocumentId } from '../src/core/document-target.js';
import { createDocumentTools } from '../src/tools/document-tools.js';
import type { PhotoshopConnection } from '../src/platform/connection.js';

// Mount policy has separate tests; timing here concerns the actual lease and queue.
vi.mock('../src/utils/local-path.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/local-path.js')>()),
  resolveLocalPath: (path: string) => path,
  getLocalTempRoot: () => process.env.PHOTOSHOP_SAFETY_DIR!,
}));
const verification = vi.hoisted(() => ({
  pause: undefined as undefined | (() => Promise<void>),
  pauseLeaseOwner: undefined as undefined | (() => Promise<void>),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const file = await real.open(...args);
      if (String(args[0]).endsWith('active.json') && args[1] === 'wx' && verification.pauseLeaseOwner) {
        const write = file.writeFile.bind(file);
        file.writeFile = async (...values: Parameters<typeof file.writeFile>) => {
          await verification.pauseLeaseOwner?.();
          return write(...values);
        };
      }
      return file;
    },
    stat: async (...args: Parameters<typeof real.stat>) => {
      if (
        String(args[0]).includes('.photoshop-mcp-save-') &&
        String(args[0]).endsWith('output.png')
      )
        await verification.pause?.();
      return real.stat(...args);
    },
  };
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Body = (script: string) => Promise<unknown>;
function fake(platform: 'mac' | 'windows', body: Body = async (script) => script) {
  const calls: Array<{ script: string; id: number | undefined; mode: string | undefined }> = [];
  async function invoke(script: string, dispatch: () => void) {
    dispatch();
    calls.push({ script, id: getTargetDocumentId(), mode: access.getStore() });
    return body(script);
  }
  class Mac extends MacOSExecutor {
    protected override executeScript(
      script: string,
      _timeout: number,
      _child: (pid: number) => Promise<void>,
      dispatch: () => void
    ) {
      return invoke(script, dispatch);
    }
  }
  class Windows extends WindowsExecutor {
    protected override executeScript(
      script: string,
      _child: (pid: number) => Promise<void>,
      dispatch: () => void
    ) {
      return invoke(script, dispatch);
    }
  }
  return { executor: platform === 'mac' ? new Mac() : new Windows(), calls };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ps-operation-'));
  process.env.PHOTOSHOP_SAFETY_DIR = join(root, 'safety');
});
afterEach(async () => {
  verification.pause = undefined;
  verification.pauseLeaseOwner = undefined;
  delete process.env.PHOTOSHOP_SAFETY_DIR;
  await rm(root, { recursive: true, force: true });
});
async function waitUnlocked() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      !(await stat(join(root, 'safety', 'active.json')).then(
        () => true,
        () => false
      ))
    )
      return;
    await delay(5);
  }
  throw new Error('test bridge did not release its lease');
}

it('drains a job paused between exclusive lease creation and owner publication', async () => {
  const publishing = deferred();
  const finishPublication = deferred();
  verification.pauseLeaseOwner = async () => {
    publishing.resolve();
    await finishPublication.promise;
  };
  let calls = 0;
  const operation = access.run('read', () => new OperationRunner().run(async () => ++calls));
  await publishing.promise;
  let drained = false;
  const drain = drainOperationRunners().then(() => { drained = true; });
  try {
    expect((await stat(join(root, 'safety', 'active.json'))).size).toBe(0);
    await delay(10);
    expect(drained).toBe(false);
    expect(calls).toBe(0);
  } finally {
    finishPublication.resolve();
    await operation;
    await drain;
  }
  expect(calls).toBe(1);
  expect(drained).toBe(true);
  await expect(stat(join(root, 'safety', 'active.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

describe.each(['mac', 'windows'] as const)('%s shared execution boundary', (platform) => {
  it('counts queued time toward the deadline and never dispatches expired work', async () => {
    const running = deferred();
    const finish = deferred();
    const { executor, calls } = fake(platform, async (script) => {
      if (script === 'first') {
        running.resolve();
        await finish.promise;
      }
      return script;
    });
    const first = executor.execute('first', 2000);
    await running.promise;
    const expired = executor.execute('expired', 30);
    await expect(expired).rejects.toThrow('queue_timeout');
    finish.resolve();
    await first;
    await waitUnlocked();
    expect(calls.map((call) => call.script)).toEqual(['first']);
  });

  it('keeps the lease and quarantine after timeout until the actual bridge finishes', async () => {
    const running = deferred();
    const finish = deferred();
    const { executor } = fake(platform, async (script) => {
      if (script === 'slow') {
        running.resolve();
        await finish.promise;
      }
      return script;
    });
    const first = executor.execute('slow', 120);
    const result = first.catch((error) => error as Error);
    await running.promise;
    expect(((await result) as Error).message).toContain('outcome_unknown');
    let drained = false;
    const drain = drainOperationRunners().then(() => { drained = true; });
    await delay(10);
    expect(drained).toBe(false);
    await expect(acquireLease(Date.now() + 40)).rejects.toThrow('queue_timeout');
    await expect(
      runRecoveryOperation(async () => {
        throw new Error('must not run while active');
      }, 40)
    ).rejects.toThrow('queue_timeout');
    finish.resolve();
    await drain;
    expect(drained).toBe(true);
    await expect(stat(join(root, 'safety', 'active.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(assertSafe()).rejects.toThrow('outcome_unknown');
    expect(await access.run('read', () => executor.execute('inspect'))).toBe('inspect');
    await runRecoveryOperation(async () => {
      expect(await executor.execute('inspect-recovery')).toBe('inspect-recovery');
      assertOperationActive();
      await clearQuarantine();
    });
    await expect(assertSafe()).resolves.toBeUndefined();
    expect(await executor.execute('after-recovery')).toBe('after-recovery');
  });

  it('holds one transaction through target pinning, verification and publication without nested deadlock', async () => {
    const verifyStarted = deferred();
    const finishVerification = deferred();
    verification.pause = async () => {
      verifyStarted.resolve();
      await finishVerification.promise;
    };
    const destination = join(root, 'published.png');
    const { executor, calls } = fake(platform);
    const other = fake(platform === 'mac' ? 'windows' : 'mac', async () =>
      readFile(destination, 'utf8')
    );
    // This independent client must not inherit the transaction's async scope.
    const independent = AsyncResource.bind(() => other.executor.execute('other-client', 2000));
    const transaction = runWithDocumentId(73, () =>
      executor.runTransaction(async () => {
        expect(await access.run('read', () => executor.execute('pin'))).toBe('pin');
        await atomicSave(destination, 'PNG', false, async (temporary) => {
          expect(await executor.execute('save')).toBe('save');
          await writeFile(temporary, 'complete');
        });
        return 'published';
      }, 2000)
    );
    await verifyStarted.promise;
    const competitor = independent();
    await delay(40);
    expect(other.calls).toEqual([]);
    finishVerification.resolve();
    expect(await transaction).toBe('published');
    expect(await competitor).toBe('complete');
    expect(calls).toEqual([
      { script: 'pin', id: 73, mode: 'read' },
      { script: 'save', id: 73, mode: 'write' },
    ]);
  });

  it('keeps staged output and refuses publication after an uncertain save', async () => {
    const running = deferred();
    const finish = deferred();
    let temporary = '';
    const { executor } = fake(platform, async () => {
      await writeFile(temporary, 'partial');
      running.resolve();
      await finish.promise;
      await writeFile(temporary, 'late-complete');
      return 'saved';
    });
    const output = join(root, 'destination.png');
    const transaction = executor.runTransaction(
      () =>
        atomicSave(output, 'PNG', false, async (path) => {
          temporary = path;
          await executor.execute('save');
        }),
      120
    );
    const result = transaction.catch((error) => error as Error);
    await running.promise;
    const error = (await result) as Error;
    expect(error.message).toContain('outcome_unknown');
    expect(error.message).toContain('inspection_paths=');
    expect(error.message).toContain(basename(join(temporary, '..')));
    finish.resolve();
    await waitUnlocked();
    expect(await readFile(temporary, 'utf8')).toBe('late-complete');
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(root)).some((name) => name.startsWith('.photoshop-mcp-save-'))).toBe(
      true
    );
    await expect(assertSafe()).rejects.toThrow('outcome_unknown');
  });

  it('preserves document/access async context when jobs arrive behind a transaction', async () => {
    const running = deferred();
    const finish = deferred();
    const { executor, calls } = fake(platform, async (script) => {
      if (script === 'first') {
        running.resolve();
        await finish.promise;
      }
      return script;
    });
    const first = runWithDocumentId(1, () => executor.execute('first'));
    await running.promise;
    const second = runWithDocumentId(2, () => access.run('read', () => executor.execute('second')));
    finish.resolve();
    await Promise.all([first, second]);
    expect(calls).toEqual([
      { script: 'first', id: 1, mode: 'write' },
      { script: 'second', id: 2, mode: 'read' },
    ]);
  });

  it('does not quarantine a save rejected by a remote current path after read-only metadata', async () => {
    const { executor, calls } = fake(platform, async (script) => {
      if (script.includes('var localPath = null'))
        return { id: 23, path: 'https://example.com/cloud.psd' };
      throw new Error('save must never be dispatched');
    });
    const connection = {
      getPhotoshopInfo: () => ({ version: '27.0.0' }),
      executeScript: (script: string, timeout?: number) => executor.execute(script, timeout),
      runTransaction: <T>(body: () => Promise<T>) => executor.runTransaction(body),
    } as unknown as PhotoshopConnection;
    // The path resolver mock remains strict about URLs for this one validation.
    const paths = await import('../src/utils/local-path.js');
    const original = paths.resolveLocalPath;
    const resolver = vi.spyOn(paths, 'resolveLocalPath').mockImplementation((path) => {
      if (path.startsWith('https:')) throw new Error('local_path_required: remote path');
      return original(path);
    });
    try {
      const tool = createDocumentTools(connection).find(
        (tool) => tool.tool.name === 'photoshop_close_document'
      )!;
      expect((await tool.handler({ save: true })).isError).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].mode).toBe('read');
      await expect(assertSafe()).resolves.toBeUndefined();
    } finally {
      resolver.mockRestore();
    }
  });

  it.each([0, -1, NaN, Infinity])(
    'rejects invalid deadline %s before a bridge runs',
    async (timeout) => {
      const { executor, calls } = fake(platform);
      await expect(executor.execute('never', timeout)).rejects.toThrow('invalid_timeout');
      expect(calls).toEqual([]);
    }
  );
});

it('uses the same physical lease in another MCP process', async () => {
  const moduleURL = pathToFileURL(join(process.cwd(), 'src/platform/operation-safety.ts')).href;
  const code = `import { acquireLease } from ${JSON.stringify(moduleURL)};
    const lease = await acquireLease(Date.now() + 10000);
    process.stdout.write('locked\\n');
    process.stdin.once('data', async () => { await lease.release(); process.exit(0); });`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  let diagnostics = '';
  child.stderr.on('data', (data) => {
    diagnostics += String(data);
  });
  try {
    await Promise.race([
      new Promise<void>((resolve) => child.stdout.once('data', () => resolve())),
      closed.then(() => {
        throw new Error('lease subprocess exited: ' + diagnostics);
      }),
    ]);
    for (const platform of ['mac', 'windows'] as const) {
      const { executor, calls } = fake(platform);
      await expect(executor.execute('must-wait', 40)).rejects.toThrow('queue_timeout');
      expect(calls).toEqual([]);
    }
    child.stdin.write('release');
    expect(await closed).toBe(0);
    expect(await fake('mac').executor.execute('after-other-process')).toBe('after-other-process');
  } finally {
    if (child.exitCode === null) child.kill();
    await closed;
  }
}, 15000);
