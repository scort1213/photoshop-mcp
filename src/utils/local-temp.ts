import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getLocalTempRoot, resolveLocalPath } from './local-path.js';

/** Own a unique, locally verified directory; never use Adobe's temp location. */
export async function createLocalTempDirectory(prefix: string): Promise<string> {
  const root = getLocalTempRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  return resolveLocalPath(await mkdtemp(join(root, prefix)));
}

export async function removeLocalTempDirectory(directory: string): Promise<void> {
  if (resolveLocalPath(directory) !== directory) throw new Error('unsafe_temporary_directory: ownership path changed');
  await rm(directory, { recursive: true, force: true });
}
