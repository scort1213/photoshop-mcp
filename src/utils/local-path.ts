import { execFileSync } from 'node:child_process';
import { lstatSync, readlinkSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const checks = new AsyncLocalStorage<{ drives: Map<string, string>; mounts?: string }>();
export function withLocalPathContext<T>(fn: () => T): T {
  return checks.getStore() ? fn() : checks.run({ drives: new Map() }, fn);
}

/** Checks fixed-tool paths, not arbitrary user JSX or recorded actions. */
export function assertLocalPathSyntax(path: string): void {
  const value = path.trim();
  if (!value || /^[/\\]{2}/.test(value) || /^(?![a-z]:[\\/])[a-z][a-z\d+.-]*:/i.test(value)) {
    throw new Error('local_path_required: URLs and UNC/network paths are unavailable in fixed tools');
  }
}

function assertMountedLocally(path: string): void {
  if (process.platform === 'win32') {
    const drive = win32.parse(path).root.slice(0, 2);
    if (!/^[a-z]:$/i.test(drive)) throw new Error('local_path_required: a local drive path is required');
    const script = `$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'"; if (!$d) { exit 2 }; [Console]::Write($d.DriveType)`;
    let type: string;
    try {
      type = checks.getStore()?.drives.get(drive) ?? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
      checks.getStore()?.drives.set(drive, type);
    } catch {
      throw new Error('local_path_required: could not verify the destination drive');
    }
    if (!['2', '3', '5', '6'].includes(type)) throw new Error('local_path_required: network drives are unavailable in fixed tools');
  } else if (process.platform === 'darwin') {
    let mounts: string;
    try {
      mounts = checks.getStore()?.mounts ?? execFileSync('/sbin/mount', [], { encoding: 'utf8', timeout: 5000 });
      const context = checks.getStore();
      if (context) context.mounts = mounts;
    }
    catch { throw new Error('local_path_required: could not verify local filesystem mounts'); }
    const entries = mounts.split('\n').flatMap(line => {
      const match = / on (.+) \(([^, )]+)/.exec(line);
      return match ? [{ root: match[1], type: match[2] }] : [];
    }).filter(entry => path === entry.root || path.startsWith(entry.root.replace(/\/$/, '') + '/'))
      .sort((a, b) => b.root.length - a.root.length);
    if (!entries.length) throw new Error('local_path_required: could not identify the filesystem mount');
    if (/^(nfs|smbfs|cifs|afpfs|webdav|sshfs|autofs)$/i.test(entries[0].type)) {
      throw new Error('local_path_required: network volumes are unavailable in fixed tools');
    }
  }
}

export function assertLocalPath(path: string): void {
  assertLocalPathSyntax(path);
  const paths = process.platform === 'win32' ? win32 : posix;
  let absolute = paths.resolve(path);
  let links = 0;
  // Inspect one component at a time. stat/exists/realpath on the complete path
  // would follow an intermediate symlink before its remote target was rejected.
  restart: for (;;) {
    assertLocalPathSyntax(absolute);
    assertMountedLocally(absolute);
    const root = paths.parse(absolute).root;
    const components = absolute.slice(root.length).split(paths.sep).filter(Boolean);
    let current = root;
    for (let index = 0; index < components.length; index++) {
      current = paths.join(current, components[index]);
      let stats;
      try { stats = lstatSync(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw new Error('local_path_required: could not verify the local path');
      }
      if (stats.isSymbolicLink()) {
        if (++links > 40) throw new Error('local_path_required: too many filesystem links');
        const target = readlinkSync(current);
        assertLocalPathSyntax(target);
        absolute = paths.resolve(paths.dirname(current), target, ...components.slice(index + 1));
        // Restart checks the destination mount/drive before lstat reaches it.
        continue restart;
      }
    }
    return;
  }
}

export function assertLocalPaths(paths: string[]): void {
  withLocalPathContext(() => paths.forEach(assertLocalPath));
}

/** Photoshop data-set XML has explicit pixel-file references in variable values. */
export function assertLocalDatasetReferences(xml: string, xmlPath: string): void {
  if (/<!ENTITY\b|<!DOCTYPE[^>]*\b(?:SYSTEM|PUBLIC)\b/i.test(xml)) {
    throw new Error('local_path_required: external XML definitions are unavailable in fixed tools');
  }
  const decode = (value: string): string => value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity[0] === '#') return String.fromCodePoint(parseInt(entity.slice(entity[1].toLowerCase() === 'x' ? 2 : 1), entity[1].toLowerCase() === 'x' ? 16 : 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()];
  });
  const paths = process.platform === 'win32' ? win32 : posix;
  withLocalPathContext(() => {
    for (const variable of xml.matchAll(/<(?:\w+:)?variable\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?variable\s*>/gi)) {
      const attributes = decode(variable[1]);
      if (!/\b(?:trait\s*=\s*['"]fileref['"]|kind\s*=\s*['"]pixel['"])/i.test(attributes)) continue;
      for (const value of variable[2].matchAll(/<(?:\w+:)?value\b[^>]*>([\s\S]*?)<\/(?:\w+:)?value\s*>/gi)) {
        const reference = value[1].trim();
        const path = reference.startsWith('<![CDATA[') && reference.endsWith(']]>')
          ? reference.slice(9, -3) : decode(reference);
        if (!path.trim()) continue;
        assertLocalPathSyntax(path);
        assertLocalPath(paths.resolve(paths.dirname(xmlPath), path));
      }
    }
  });
}

const PATH_ARGUMENTS: Record<string, string[]> = {
  photoshop_open_image: ['filePath'], photoshop_place_image: ['filePath'],
  photoshop_save_document: ['path'], photoshop_close_document: ['path'], photoshop_export_as: ['path'],
  photoshop_replace_smart_object_contents: ['file_path'], photoshop_apply_lut: ['lut'],
  photoshop_image_stack: ['files'], photoshop_import_datasets: ['xml_path'],
  photoshop_generate_from_datasets: ['output_dir'], photoshop_recipe_csv_to_cards: ['csv_path', 'output_dir'],
  photoshop_recipe_batch_mockup_replace: ['assets_dir'],
  photoshop_recipe_batch_watermark: ['assets_dir', 'logo_path'],
  photoshop_recipe_sky_blend: ['sky_image_path'], photoshop_recipe_prepare_for_web: ['path'],
};

export function assertFixedToolPaths(toolName: string, args: Record<string, unknown>): void {
  for (const field of PATH_ARGUMENTS[toolName] ?? []) {
    const value = args[field];
    for (const path of Array.isArray(value) ? value : [value]) {
      if (typeof path === 'string' && path.trim()) assertLocalPath(path);
    }
  }
}
