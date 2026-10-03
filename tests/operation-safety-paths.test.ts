import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLease,
  assertSafe,
  clearQuarantine,
  quarantine,
} from '../src/platform/operation-safety.js';

vi.mock('../src/utils/local-path.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/local-path.js')>()),
  resolveLocalPath: (path: string) => path,
}));
const io = vi.hoisted(() => ({
  accessed: [] as string[],
  symbolicLinks: new Set<string>(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      if (io.symbolicLinks.has(String(args[0]))) return { isSymbolicLink: () => true };
      return actual.lstatSync(...args);
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      io.accessed.push('read:' + args[0]);
      return actual.readFile(...args);
    },
    writeFile: (...args: Parameters<typeof actual.writeFile>) => {
      io.accessed.push('write:' + args[0]);
      return actual.writeFile(...args);
    },
    stat: (...args: Parameters<typeof actual.stat>) => {
      io.accessed.push('stat:' + args[0]);
      return actual.stat(...args);
    },
    open: (...args: Parameters<typeof actual.open>) => {
      io.accessed.push('open:' + args[0]);
      return actual.open(...args);
    },
    unlink: (...args: Parameters<typeof actual.unlink>) => {
      io.accessed.push('unlink:' + args[0]);
      return actual.unlink(...args);
    },
  };
});
async function createSymlinkFixture(target: string, path: string): Promise<void> {
  try {
    await symlink(target, path);
  } catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM')
      throw error;
    // Windows may require Developer Mode/admin rights to create file symlinks.
    // Model only this link's lstat result; real I/O remains tracked so bypassing
    // the link rejection still fails the safety assertions below.
    io.symbolicLinks.add(path);
  }
}
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ps-safety-path-'));
  process.env.PHOTOSHOP_SAFETY_DIR = root;
  io.accessed = [];
  io.symbolicLinks.clear();
});
afterEach(async () => {
  delete process.env.PHOTOSHOP_SAFETY_DIR;
  io.symbolicLinks.clear();
  await rm(root, { recursive: true, force: true });
});

it('rejects a pre-existing active lease symlink before reading or opening its target', async () => {
  await createSymlinkFixture('/Volumes/MCPNetwork/credentials.json', join(root, 'active.json'));
  await expect(acquireLease(Date.now() + 1000)).rejects.toThrow('operation_state_invalid');
  expect(io.accessed).toEqual([]);
});

it('rejects marker symlinks before reading, writing or following them', async () => {
  await createSymlinkFixture('/Volumes/MCPNetwork/marker.json', join(root, 'uncertain.json'));
  await expect(assertSafe()).rejects.toThrow('operation_state_invalid');
  await expect(quarantine('must not follow')).rejects.toThrow('operation_state_invalid');
  await expect(clearQuarantine()).rejects.toThrow('operation_state_invalid');
  expect(io.accessed).toEqual([]);
});

it('leaves a local redirected file untouched as well', async () => {
  const local = join(root, 'user-file');
  await writeFile(local, 'preserve');
  await createSymlinkFixture(local, join(root, 'uncertain.json'));
  io.accessed = [];
  await expect(quarantine('must not replace user file')).rejects.toThrow('operation_state_invalid');
  expect(io.accessed).toEqual([]);
  expect(await readFile(local, 'utf8')).toBe('preserve');
});

it('does not follow a symlink placed in the orphan reclamation path', async () => {
  await writeFile(
    join(root, 'active.json'),
    JSON.stringify({ pid: 2147483647, childPid: 0, token: 'orphan' })
  );
  await createSymlinkFixture('/Volumes/MCPNetwork/lock', join(root, 'reclaim.lock'));
  io.accessed = [];
  await expect(acquireLease(Date.now() + 1000)).rejects.toThrow('operation_state_invalid');
  expect(io.accessed.some((path) => path.includes('reclaim.lock'))).toBe(false);
  expect(io.accessed.some((path) => path.includes('/Volumes'))).toBe(false);
});
