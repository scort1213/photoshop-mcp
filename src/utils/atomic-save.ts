import { isAbsolute, extname, dirname, join } from 'node:path';
import { access, link, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { resolveLocalPath } from './local-path.js';
import {
  assertOperationActive,
  operationNeedsInspection,
  registerInspectionPath,
} from '../platform/operation-safety.js';

/** Publish only a completed file. Existing destinations require explicit opt-in. */
export async function atomicSave(
  path: string,
  format: string,
  overwrite: boolean,
  write: (temporaryPath: string) => Promise<unknown>
): Promise<void> {
  if (!isAbsolute(path))
    throw new Error('invalid_arguments: absolute path and matching file extension required');
  path = resolveLocalPath(path);
  const extension = extname(path).toLowerCase();
  const allowed: Record<string, string[]> = {
    PSD: ['.psd'],
    PSB: ['.psb'],
    TIFF: ['.tif', '.tiff'],
    JPEG: ['.jpg', '.jpeg'],
    PNG: ['.png'],
    WEBP: ['.webp'],
    AVIF: ['.avif'],
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
  registerInspectionPath(staging);
  let uncertain = false;
  let completed = false;
  try {
    const temporary = join(staging, 'output' + extension);
    assertOperationActive();
    await write(temporary);
    assertOperationActive();
    if ((await stat(temporary)).size === 0)
      throw new Error('empty_output: save did not produce a complete file');
    completed = true;
    assertOperationActive();
    if (overwrite) await rename(temporary, path);
    else await link(temporary, path); // Atomic no-clobber publication, including competing clients.
  } catch (error) {
    uncertain =
      completed || operationNeedsInspection() || String(error).includes('outcome_unknown');
    if (uncertain)
      throw new Error(
        (error instanceof Error ? error.message : String(error)) + '; inspection_path=' + staging
      );
    throw error;
  } finally {
    if (!uncertain) await rm(staging, { recursive: true, force: true });
  }
}
