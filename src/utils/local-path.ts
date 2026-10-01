import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { lstatSync, readlinkSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { getWindowsSystemTool } from './system-tools.js';

interface Mount { root: string; type: string }
interface PathChecks {
  drives: Map<string, string>;
  mounts?: Mount[];
  volumeNames?: Set<string>;
  aliases: Set<string>;
}
const checks = new AsyncLocalStorage<PathChecks>();
const failure = (message: string): never => { throw new Error('local_path_required: ' + message); };
export function withLocalPathContext<T>(fn: () => T): T {
  return checks.getStore() ? fn() : checks.run({ drives: new Map(), aliases: new Set() }, fn);
}

/** Fixed tools accept native absolute paths; custom JSX/actions remain trusted code. */
export function assertLocalPathSyntax(path: string): void {
  // eslint-disable-next-line no-control-regex -- Reject path control characters before native/script dispatch.
  if (!path || /[\x00-\x1f\x7f]/.test(path) || /^[/\\]{2}/.test(path))
    failure('use a real native absolute path; URLs, network paths and control characters are unavailable');
  if (process.platform === 'win32') {
    if (!/^[a-z]:[\\/]/i.test(path) || path.slice(2).includes(':'))
      failure('use a native absolute local drive path, such as C:\\images\\photo.png');
    if (path.slice(3).split(/[\\/]/).some(part => /[ .]$/.test(part) || /\.lnk$/i.test(part)))
      failure('shortcuts and ambiguous Windows filename endings are unavailable; select the real file');
  } else if (!posix.isAbsolute(path) || path.includes(':')) {
    failure('use a native absolute path, such as /Users/me/images/photo.png; relative paths, ~ and volume shorthand are unavailable');
  }
}

function macMounts(): Mount[] {
  const cached = checks.getStore()?.mounts;
  if (cached) return cached;
  let output: string;
  try { output = execFileSync('/sbin/mount', [], { encoding: 'utf8', timeout: 5000 }); }
  catch { return failure('could not verify local filesystem mounts'); }
  const mounts = output.split('\n').flatMap(line => {
    const match = / on (.+) \(([^, )]+)/.exec(line);
    return match ? [{ root: match[1], type: match[2].toLowerCase() }] : [];
  });
  if (!mounts.some(mount => mount.root === '/')) failure('could not identify the startup filesystem');
  const context = checks.getStore();
  if (context) context.mounts = mounts;
  return mounts;
}

function assertMountedLocally(path: string): void {
  if (process.platform === 'win32') {
    const drive = win32.parse(path).root.slice(0, 2).toUpperCase();
    const script = `$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'"; if (!$d) { exit 2 }; [Console]::Write($d.DriveType)`;
    let type: string;
    try {
      type = checks.getStore()?.drives.get(drive) ?? execFileSync(getWindowsSystemTool('powershell'), ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
      checks.getStore()?.drives.set(drive, type);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('local_path_required:')) throw error;
      return failure('could not verify the destination drive');
    }
    if (!['2', '3', '5', '6'].includes(type)) failure('network drives are unavailable in fixed tools');
  } else if (process.platform === 'darwin') {
    const mount = macMounts().filter(entry => path === entry.root || path.startsWith(entry.root.replace(/\/$/, '') + '/'))
      .sort((a, b) => b.root.length - a.root.length)[0];
    if (!mount || !['apfs', 'hfs', 'msdos', 'exfat', 'ntfs', 'udf', 'cd9660'].includes(mount.type))
      failure('network, automount and unverified filesystem volumes are unavailable in fixed tools');
  }
}

const volumeKey = (name: string) => name.normalize('NFD').toLowerCase();
function macVolumeNames(): Set<string> {
  const cached = checks.getStore()?.volumeNames;
  if (cached) return cached;
  assertMountedLocally('/');
  let plist: string;
  try { plist = execFileSync('/usr/sbin/diskutil', ['info', '-plist', '/'], { encoding: 'utf8', timeout: 5000 }); }
  catch { return failure('could not verify the startup volume name'); }
  const name = /<key>VolumeName<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
  if (!name) return failure('could not identify the startup volume name');
  const names = new Set(macMounts().filter(mount => mount.root !== '/').map(mount => volumeKey(posix.basename(mount.root))));
  names.add(volumeKey(decodeXmlText(name)));
  // Listing this local directory does not traverse any mounted volume or alias.
  assertMountedLocally('/Volumes');
  try {
    const stats = lstatSync('/Volumes');
    if (stats.isSymbolicLink() || !stats.isDirectory()) failure('could not verify the local volume-name directory');
    for (const entry of readdirSync('/Volumes')) names.add(volumeKey(entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return failure('could not verify local volume names');
  }
  const context = checks.getStore();
  if (context) context.volumeNames = names;
  return names;
}

function rejectVolumeShorthand(path: string): void {
  if (process.platform !== 'darwin') return;
  const first = path.split('/')[1];
  if (first && macVolumeNames().has(volumeKey(first)))
    failure('this path conflicts with an Adobe volume name; select an unambiguous native absolute path');
}

function rejectFinderAlias(path: string): void {
  if (process.platform !== 'darwin' || checks.getStore()?.aliases.has(path)) return;
  try {
    const attributes = execFileSync('/usr/bin/xattr', ['-s', path], { encoding: 'utf8', timeout: 5000 }).split('\n');
    if (attributes.includes('com.apple.FinderInfo')) {
      const hex = execFileSync('/usr/bin/xattr', ['-p', '-s', '-x', 'com.apple.FinderInfo', path], { encoding: 'utf8', timeout: 5000 }).replace(/\s/g, '');
      if (!/^[\da-f]{64}$/i.test(hex)) failure('could not verify Finder file metadata');
      if (parseInt(hex.slice(16, 20), 16) & 0x8000) failure('Finder aliases are unavailable; select the original file');
    }
    checks.getStore()?.aliases.add(path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('local_path_required:')) throw error;
    failure('could not verify Finder alias metadata');
  }
}

function rejectWindowsShortcut(path: string): void {
  if (process.platform !== 'win32') return;
  try { lstatSync(path + '.lnk'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    return failure('could not verify Windows shortcut metadata');
  }
  failure('Windows shortcuts are unavailable; select the original file');
}

/** Return the exact native path that was checked, resolving only safe local symlinks. */
export function resolveLocalPath(path: string): string {
  return withLocalPathContext(() => {
    assertLocalPathSyntax(path);
    const paths = process.platform === 'win32' ? win32 : posix;
    let absolute = paths.normalize(path);
    let links = 0;
    restart: for (;;) {
      assertLocalPathSyntax(absolute);
      assertMountedLocally(absolute);
      rejectVolumeShorthand(absolute);
      const root = paths.parse(absolute).root;
      const components = absolute.slice(root.length).split(paths.sep).filter(Boolean);
      let current = root;
      for (let index = 0; index < components.length; index++) {
        current = paths.join(current, components[index]);
        let stats;
        try { stats = lstatSync(current); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') { rejectWindowsShortcut(current); return absolute; }
          return failure('could not verify the local path');
        }
        if (stats.isSymbolicLink()) {
          if (++links > 40) failure('too many filesystem links');
          const target = readlinkSync(current);
          if (/^[/\\]{2}/.test(target) || /^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target))
            failure('network filesystem links are unavailable');
          absolute = paths.resolve(paths.dirname(current), target, ...components.slice(index + 1));
          continue restart;
        }
        rejectFinderAlias(current);
      }
      return absolute;
    }
  });
}

export function assertLocalPath(path: string): void { resolveLocalPath(path); }
export function assertLocalPaths(paths: string[]): void { withLocalPathContext(() => paths.forEach(assertLocalPath)); }

/** One URI encoding pass: a literal percent in a native filename becomes %25. */
export function toAdobePath(path: string): string {
  const local = resolveLocalPath(path);
  if (process.platform === 'win32') {
    const root = local.slice(0, 2).toUpperCase();
    return root + local.slice(2).split('\\').map(encodeURIComponent).join('/');
  }
  return local.split('/').map(encodeURIComponent).join('/');
}

export function getLocalMcpHome(): string {
  const paths = process.platform === 'win32' ? win32 : posix;
  return resolveLocalPath(process.env.PHOTOSHOP_MCP_HOME || paths.join(homedir(), '.photoshop-mcp'));
}
/** Returns a checked path only; callers create the directory with mode 0700. */
export function getLocalTempRoot(): string {
  const paths = process.platform === 'win32' ? win32 : posix;
  return resolveLocalPath(paths.join(getLocalMcpHome(), 'tmp'));
}
export function validateRuntimePaths(): void {
  withLocalPathContext(() => {
    getLocalMcpHome();
    getLocalTempRoot();
    for (const name of ['PHOTOSHOP_SAFETY_DIR', 'PHOTOSHOP_RECOVERY_DIR', 'PHOTOSHOP_PATH']) {
      if (process.env[name]) process.env[name] = resolveLocalPath(process.env[name]!);
    }
    if (process.platform === 'win32') {
      for (const name of ['ProgramFiles', 'ProgramFiles(x86)', 'SystemRoot']) {
        if (process.env[name]) process.env[name] = resolveLocalPath(process.env[name]!);
      }
    }
  });
}

function decodeXmlText(value: string): string {
  return value.replace(/&([^;\s]+);/g, (_, entity: string) => {
    if (/^#(?:x[\da-f]+|\d+)$/i.test(entity)) {
      const code = parseInt(entity.slice(entity[1].toLowerCase() === 'x' ? 2 : 1), entity[1].toLowerCase() === 'x' ? 16 : 10);
      if (code > 0x10ffff || code === 0 || code >= 0xd800 && code <= 0xdfff) failure('invalid XML character reference');
      return String.fromCodePoint(code);
    }
    const decoded = ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity];
    return decoded === undefined ? failure('unknown XML entity references are unavailable') : decoded;
  });
}
const escapeXmlText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Rewrite only explicit pixel/file-reference values before Adobe imports the XML. */
export function normalizeDatasetXml(xml: string, _xmlPath?: string): string {
  if (/<!ENTITY\b|<!DOCTYPE\b/i.test(xml)) failure('XML definitions are unavailable in fixed tools');
  const prefix = '(?:[A-Za-z_][\\w.-]*:)?';
  const variable = new RegExp(`<${prefix}variable\\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\\s\\S]*?)<\\/${prefix}variable\\s*>`, 'gi');
  return withLocalPathContext(() => xml.replace(variable, (whole: string, attributes: string, body: string) => {
    const decodedAttributes = decodeXmlText(attributes);
    if (!/\b(?:trait\s*=\s*['"]fileref['"]|kind\s*=\s*['"]pixel['"])/i.test(decodedAttributes)) return whole;
    const values = new RegExp(`<(${prefix}value)\\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\\s\\S]*?)<\\/\\1\\s*>`, 'gi');
    const normalized = body.replace(values, (_value: string, tag: string, attrs: string, reference: string) => {
      // Comments/CDATA are XML text, not literal filename fragments.
      let plain = '';
      const tokens = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|([^<]+)|</g;
      for (const token of reference.matchAll(tokens)) {
        if (token[1] !== undefined) plain += token[1];
        else if (token[2] !== undefined) plain += decodeXmlText(token[2]);
        else if (token[0] === '<') failure('nested XML in a pixel-file reference is unavailable');
      }
      if (!plain.trim()) return `<${tag}${attrs}></${tag}>`;
      const uri = toAdobePath(plain);
      return `<${tag}${attrs}>${escapeXmlText(uri)}</${tag}>`;
    });
    return whole.replace(body, normalized);
  }));
}
export function assertLocalDatasetReferences(xml: string, xmlPath: string): void { normalizeDatasetXml(xml, xmlPath); }

const PATH_ARGUMENTS: Record<string, string[]> = {
  photoshop_open_image: ['filePath'], photoshop_place_image: ['filePath'],
  photoshop_save_document: ['path'], photoshop_close_document: ['path'], photoshop_export_as: ['path'],
  photoshop_replace_smart_object_contents: ['file_path'], photoshop_apply_lut: ['lut'],
  photoshop_image_stack: ['files'], photoshop_import_datasets: ['xml_path'],
  photoshop_generate_from_datasets: ['output_dir'], photoshop_recipe_csv_to_cards: ['csv_path', 'output_dir'],
  photoshop_recipe_batch_mockup_replace: ['assets_dir'], photoshop_recipe_batch_watermark: ['assets_dir', 'logo_path'],
  photoshop_recipe_sky_blend: ['sky_image_path'], photoshop_recipe_prepare_for_web: ['path'],
};
export function assertFixedToolPaths(toolName: string, args: Record<string, unknown>): void {
  for (const field of PATH_ARGUMENTS[toolName] ?? []) {
    const value = args[field];
    if (Array.isArray(value)) args[field] = value.map(path => typeof path === 'string' && path ? resolveLocalPath(path) : path);
    else if (typeof value === 'string' && value) args[field] = resolveLocalPath(value);
  }
}
