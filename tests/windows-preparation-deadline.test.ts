import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowsExecutor } from '../src/platform/windows-executor.js';
import { assertSafe } from '../src/platform/operation-safety.js';

const probe = vi.hoisted(() => ({ spawns: 0, directory: '', preparationFinished: false }));
vi.mock('fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real,
    mkdtemp: async (...args: Parameters<typeof real.mkdtemp>) => {
      const directory = await real.mkdtemp(...args);
      if (String(args[0]).includes('photoshop-mcp-')) probe.directory = String(directory);
      return directory;
    },
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      await real.writeFile(...args);
      if (String(args[0]).endsWith('bridge.vbs')) {
        await new Promise(resolve => setTimeout(resolve, 180));
        probe.preparationFinished = true;
      }
    },
  };
});
vi.mock('child_process', async importOriginal => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return { ...real, execFile: (...args: unknown[]) => {
    probe.spawns++;
    const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void;
    callback(new Error('Unexpected COM dispatch'), '', '');
    return { pid: 12345 };
  } };
});
let safetyDirectory: string;
afterEach(async () => {
  delete process.env.PHOTOSHOP_SAFETY_DIR;
  if (safetyDirectory) await rm(safetyDirectory, { recursive: true, force: true });
});

it('checks the deadline after actual bridge file preparation and never spawns COM late', async () => {
  safetyDirectory = await mkdtemp(join(tmpdir(), 'ps-preparation-unit-'));
  process.env.PHOTOSHOP_SAFETY_DIR = safetyDirectory;
  const executor = new WindowsExecutor();
  await expect(executor.execute('must-not-execute', 60)).rejects.toThrow('outcome_unknown');
  await new Promise(resolve => setTimeout(resolve, 230));
  expect(probe.preparationFinished).toBe(true);
  expect(probe.spawns).toBe(0);
  expect(probe.directory).not.toBe('');
  await expect(stat(probe.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(assertSafe()).rejects.toThrow('outcome_unknown');
});
