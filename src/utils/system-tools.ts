import { win32 } from 'node:path';
import { lstatSync } from 'node:fs';

const TOOLS = {
  powershell: 'WindowsPowerShell\\v1.0\\powershell.exe',
  cscript: 'cscript.exe',
  reg: 'reg.exe',
  tasklist: 'tasklist.exe',
} as const;

/** Never search PATH for Windows executables used to establish path safety. */
export function getWindowsSystemTool(name: keyof typeof TOOLS): string {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const drive = /^[a-z]:[\\/]/i.test(root) ? root.slice(0, 2).toUpperCase() : '';
  const nodeDrive = /^[a-z]:[\\/]/i.test(process.execPath) ? process.execPath.slice(0, 2).toUpperCase() : '';
  // eslint-disable-next-line no-control-regex -- System executable paths must not contain control characters.
  if (!drive || /[\x00-\x1f\x7f]/.test(root) || root.slice(2).includes(':') || drive !== nodeDrive)
    throw new Error('local_path_required: Windows system tools require native local SystemRoot and Node on the same system drive; use a local Node installation on that drive (no PATH or remote fallback)');
  const executable = win32.join(win32.normalize(root), 'System32', TOOLS[name]);
  let current = win32.parse(executable).root;
  for (const component of executable.slice(current.length).split('\\').filter(Boolean)) {
    current = win32.join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error('local_path_required: Windows system tool paths cannot contain filesystem links; use the real local system directory and executable');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('local_path_required:')) throw error;
      throw new Error('local_path_required: could not verify the real local Windows system directory; no PATH fallback is available');
    }
  }
  return executable;
}
