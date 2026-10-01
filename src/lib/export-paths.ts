import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { getLocalMcpHome, resolveLocalPath } from '../utils/local-path.js';

const EXPORTS_SUBDIR = 'exports';

/** Set by the UI chat runner so default exports land under ~/.photoshop-mcp/exports/<id>/. */
export const PHOTOSHOP_EXPORT_CHAT_ID_ENV = 'PHOTOSHOP_EXPORT_CHAT_ID';

export function sanitizeExportChatSegment(raw: string | undefined | null): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(t)) return null;
  if (t === '.' || t === '..') return null;
  return t;
}

export function getPhotoshopMcpHomeDir(): string {
  return getLocalMcpHome();
}

export function getPhotoshopExportsDir(): string {
  const dir = resolveLocalPath(join(getPhotoshopMcpHomeDir(), EXPORTS_SUBDIR));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return resolveLocalPath(dir);
}

export function getPhotoshopExportsWorkingDir(): string {
  const root = getPhotoshopExportsDir();
  const seg = sanitizeExportChatSegment(process.env[PHOTOSHOP_EXPORT_CHAT_ID_ENV]);
  if (!seg) return root;
  const dir = resolveLocalPath(join(root, seg));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return resolveLocalPath(dir);
}

function normalizeExt(ext: string): string {
  const e = ext.replace(/^\.+/, '').toLowerCase();
  if (e && !/^[a-z0-9]+$/.test(e)) throw new Error('invalid_arguments: invalid export extension');
  return e || 'bin';
}

/**
 * Resolve a save/export path: optional user path, default file under
 * ~/.photoshop-mcp/exports (or ~/.photoshop-mcp/exports/<chatId> in UI mode).
 */
export function resolveExportPath(userPath: string | undefined, ext: string): string {
  if (userPath?.trim()) return resolveLocalPath(userPath);
  const base = `photoshop-export-${Date.now()}-${randomBytes(4).toString('hex')}.${normalizeExt(ext)}`;
  return resolveGeneratedExportPath(base, ext);
}

/** Internal recipe filenames only; explicit user paths use resolveExportPath. */
export function resolveGeneratedExportPath(name: string, ext: string): string {
  normalizeExt(ext);
  // eslint-disable-next-line no-control-regex -- Internal filenames must remain one native filename.
  if (!name || name === '.' || name === '..' || posix.basename(name) !== name || win32.basename(name) !== name || /[\x00-\x1f]/.test(name))
    throw new Error('invalid_arguments: generated export name must be one filename');
  return resolveLocalPath(join(getPhotoshopExportsWorkingDir(), name));
}
