import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicSave } from '../src/utils/atomic-save.js';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ps-save-test-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it('never replaces an existing file without explicit overwrite', async () => {
  const path = join(root, '原件.png');
  await writeFile(path, 'original');
  let called = false;
  await expect(
    atomicSave(path, 'PNG', false, async () => {
      called = true;
    })
  ).rejects.toThrow('output_exists');
  expect(called).toBe(false);
  expect(await readFile(path, 'utf8')).toBe('original');
});
it.each(['ENOSPC', 'ENOMEM', 'EACCES'])('does not publish partial output after simulated %s', async errorCode => {
  const path = join(root, 'output.png');
  await expect(
    atomicSave(path, 'PNG', false, async (temp) => {
      await writeFile(temp, 'partial');
      throw new Error(errorCode);
    })
  ).rejects.toThrow(errorCode);
  expect(await readdir(root)).toEqual([]);
});
it('publishes complete output and removes staging files', async () => {
  const path = join(root, 'output.png');
  await atomicSave(path, 'PNG', false, async (temp) => {
    await writeFile(temp, 'complete');
  });
  expect(await readFile(path, 'utf8')).toBe('complete');
  expect(await readdir(root)).toEqual(['output.png']);
});
it('rejects extension mismatch before invoking Adobe', async () => {
  await expect(
    atomicSave(join(root, 'output.jpg'), 'PNG', false, async () => {
      throw new Error('must not call');
    })
  ).rejects.toThrow('matching file extension');
});
it('does not delete staging files while timed-out Adobe may still be writing', async () => {
  await expect(
    atomicSave(join(root, 'output.png'), 'PNG', false, async (temp) => {
      await writeFile(temp, 'partial');
      throw new Error('outcome_unknown');
    })
  ).rejects.toThrow('outcome_unknown');
  const names = await readdir(root);
  expect(names).toHaveLength(1);
  expect(names[0]).toContain('.photoshop-mcp-save-');
});
