import { isAbsolute, extname, dirname, join } from 'node:path';
import { access, link, mkdtemp, rename, rm, stat } from 'node:fs/promises';

/** Publish only a completed file. Existing destinations require explicit opt-in. */
export async function atomicSave(
  path: string,
  format: string,
  overwrite: boolean,
  write: (temporaryPath: string) => Promise<unknown>
): Promise<void> {
  const extension = extname(path).toLowerCase();
  const allowed: Record<string, string[]> = {
    PSD: ['.psd'],
    JPEG: ['.jpg', '.jpeg'],
    PNG: ['.png'],
  };
  if (!isAbsolute(path) || !allowed[format]?.includes(extension))
    throw new Error('invalid_arguments: absolute path and matching file extension required');
  if (
    !overwrite &&
    (await access(path).then(
      () => true,
      () => false
    ))
  )
    throw new Error('output_exists: specify overwrite=true to replace this file');
  const staging = await mkdtemp(join(dirname(path), '.photoshop-mcp-save-'));
  let uncertain = false;
  try {
    const temporary = join(staging, 'output' + extension);
    await write(temporary);
    if ((await stat(temporary)).size === 0)
      throw new Error('empty_output: save did not produce a complete file');
    if (overwrite) await rename(temporary, path);
    else await link(temporary, path); // Atomic no-clobber publication, including competing clients.
  } catch (error) {
    uncertain = String(error).includes('outcome_unknown');
    throw error;
  } finally {
    if (!uncertain) await rm(staging, { recursive: true, force: true });
  }
}
