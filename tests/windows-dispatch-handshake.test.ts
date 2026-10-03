import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WindowsExecutor } from '../src/platform/windows-executor.js';
import { assertSafe, runOperationBridge } from '../src/platform/operation-safety.js';
import { getWindowsSystemTool } from '../src/utils/system-tools.js';

// These tests run the real Windows Script Host with a synthetic COM body.
// They never create a Photoshop COM object or claim Photoshop functionality.
const probe = vi.hoisted(() => ({ root: '', failReadyWrite: false, skipReadyWrite: false }));
vi.mock('../src/utils/local-path.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/local-path.js')>()),
  resolveLocalPath: (path: string) => path,
  getLocalTempRoot: () => probe.root,
  toAdobePath: (path: string) => path,
}));
vi.mock('fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      if (probe.skipReadyWrite && String(args[0]).endsWith('dispatch.ready')) return;
      await real.writeFile(...args);
      if (probe.failReadyWrite && String(args[0]).endsWith('dispatch.ready'))
        throw new Error('Synthetic error after readiness file creation');
    },
  };
});

type Internals = {
  createVBSWrapper(jsx: string, result: string, ready?: string, timeout?: number): string;
  executeScript(script: string, onChild: (pid: number) => Promise<void>, dispatch: () => void): Promise<unknown>;
};
function syntheticBridge() {
  const executor = new WindowsExecutor();
  const bridge = executor as unknown as Internals;
  const wrap = bridge.createVBSWrapper.bind(executor);
  bridge.createVBSWrapper = (...args) => {
    if (probe.skipReadyWrite) args[3] = 100;
    return wrap(...args).replace(
    'Set photoshopApp = CreateObject("Photoshop.Application")',
    'WScript.Sleep 150\nEmit "synthetic authorized body"\nWScript.Quit 0'
    );
  };
  return { executor, bridge };
}

beforeEach(async () => {
  probe.root = await mkdtemp(join(tmpdir(), 'ps-handshake-unit-'));
  probe.failReadyWrite = false;
  probe.skipReadyWrite = false;
  vi.stubEnv('PHOTOSHOP_SAFETY_DIR', join(probe.root, 'safety'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(probe.root, { recursive: true, force: true });
});

describe.runIf(process.platform === 'win32')('Windows bridge dispatch authorization', () => {
  it('exits without reaching the COM body when its parent never publishes readiness', async () => {
    const { bridge } = syntheticBridge();
    const result = join(probe.root, 'result.txt');
    const script = join(probe.root, 'bridge.vbs');
    const source = bridge.createVBSWrapper(join(probe.root, 'unused.jsx'), result,
      join(probe.root, 'never-ready'), 100);
    await writeFile(script, '\uFEFF' + source, 'utf16le');
    await expect(promisify(execFile)(getWindowsSystemTool('cscript'), ['//nologo', script], { windowsHide: true }))
      .rejects.toMatchObject({ code: 1 });
    const payload = await readFile(result, 'utf16le');
    expect(payload).toContain('outcome_unknown: Adobe bridge dispatch authorization was not received');
    expect(payload).not.toContain('synthetic authorized body');
  });

  it('waits until child PID registration completes before authorizing its body', async () => {
    const { executor, bridge } = syntheticBridge();
    let registered = false;
    const result = await executor.runTransaction(() => runOperationBridge((onChild, dispatch) =>
      bridge.executeScript('synthetic script', async (pid) => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const directory = (await readdir(probe.root)).find((name) => name.startsWith('photoshop-mcp-'))!;
        await expect(stat(join(probe.root, directory, 'dispatch.ready'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(join(probe.root, directory, 'bridge.vbs.result'))).rejects.toMatchObject({ code: 'ENOENT' });
        await onChild(pid);
        registered = true;
      }, dispatch)
    ), 5000);
    expect(registered).toBe(true);
    expect(result).toBe('synthetic authorized body');
    await expect(assertSafe()).resolves.toBeUndefined();
  });

  it('never authorizes a child whose PID registration fails, and preserves quarantine', async () => {
    const { executor, bridge } = syntheticBridge();
    await expect(executor.runTransaction(() => runOperationBridge((_onChild, dispatch) =>
      bridge.executeScript('synthetic script', async () => { throw new Error('Synthetic lease write failure'); }, dispatch)
    ), 5000)).rejects.toThrow('outcome_unknown: failed to record Adobe bridge process');
    const directory = (await readdir(probe.root)).find((name) => name.startsWith('photoshop-mcp-'))!;
    expect(directory).toBeTruthy();
    await expect(stat(join(probe.root, directory, 'dispatch.ready'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(probe.root, directory, 'bridge.vbs.result'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(assertSafe()).rejects.toThrow('outcome_unknown');
  });

  it('waits for natural bridge completion when a failed ready write may already have authorized it', async () => {
    probe.failReadyWrite = true;
    const { executor } = syntheticBridge();
    await expect(executor.execute('synthetic script', 5000))
      .rejects.toThrow('outcome_unknown: failed to record Adobe bridge process');
    const directory = (await readdir(probe.root)).find((name) => name.startsWith('photoshop-mcp-'))!;
    expect(await readFile(join(probe.root, directory, 'bridge.vbs.result'), 'utf16le'))
      .toContain('synthetic authorized body');
    await expect(assertSafe()).rejects.toThrow('outcome_unknown');
  });

  it('keeps a real gate timeout quarantined when readiness never reaches the child', async () => {
    probe.skipReadyWrite = true;
    const { executor } = syntheticBridge();
    await expect(executor.execute('synthetic script', 5000))
      .rejects.toThrow('outcome_unknown: Adobe bridge dispatch authorization was not received');
    const directory = (await readdir(probe.root)).find((name) => name.startsWith('photoshop-mcp-'))!;
    expect(await readFile(join(probe.root, directory, 'bridge.vbs.result'), 'utf16le'))
      .not.toContain('synthetic authorized body');
    await expect(assertSafe()).rejects.toThrow('outcome_unknown');
  });
});
