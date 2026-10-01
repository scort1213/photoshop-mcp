import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ exec: vi.fn(), lstat: vi.fn(), readlink: vi.fn(), readdir: vi.fn(), mkdir: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: mocks.exec }));
vi.mock('node:fs', () => ({ lstatSync: mocks.lstat, readlinkSync: mocks.readlink, readdirSync: mocks.readdir, mkdirSync: mocks.mkdir }));
import { resolveExportPath, resolveGeneratedExportPath } from '../src/lib/export-paths.js';
const localStats = { isSymbolicLink: () => false, isDirectory: () => true };
beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  vi.stubEnv('PHOTOSHOP_MCP_HOME', '/Users/me/mcp');
  vi.stubEnv('PHOTOSHOP_EXPORT_CHAT_ID', undefined);
  mocks.exec.mockImplementation((tool: string) => tool === '/sbin/mount'
    ? '/dev/root on / (apfs, local)\n//host/share on /Volumes/Remote (smbfs, nodev)\n'
    : tool === '/usr/sbin/diskutil' ? '<key>VolumeName</key><string>Macintosh HD</string>' : '');
  mocks.lstat.mockReturnValue(localStats);
  mocks.readdir.mockReturnValue(['Macintosh HD', 'Remote']);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

it('requires an absolute user destination without creating an unrelated default directory', () => {
  expect(() => resolveExportPath('relative.png', 'png')).toThrow('local_path_required');
  expect(mocks.mkdir).not.toHaveBeenCalled();
  expect(resolveExportPath('/Users/me/output.png', 'png')).toBe('/Users/me/output.png');
  expect(mocks.mkdir).not.toHaveBeenCalled();
});
it('creates checked default directories and returns absolute generated files', () => {
  expect(resolveExportPath(undefined, 'png')).toMatch(/^\/Users\/me\/mcp\/exports\/photoshop-export-.*\.png$/);
  expect(mocks.mkdir).toHaveBeenCalledWith('/Users/me/mcp/exports', { recursive: true, mode: 0o700 });
});
it('checks the final generated path instead of only checking the working directory', () => {
  mocks.lstat.mockImplementation((path: string) => ({ ...localStats, isSymbolicLink: () => path === '/Users/me/mcp/exports/generated.jpg' }));
  mocks.readlink.mockReturnValue('/Volumes/Remote/overwrite.jpg');
  expect(() => resolveGeneratedExportPath('generated.jpg', 'jpg')).toThrow('local_path_required');
  expect(mocks.lstat.mock.calls.some(call => String(call[0]).startsWith('/Volumes/Remote'))).toBe(false);
});
it.each(['../escape.jpg', 'folder/escape.jpg', String.raw`folder\escape.jpg`, '/escape.jpg'])('restricts internal generated names to one filename: %s', name => {
  expect(() => resolveGeneratedExportPath(name, 'jpg')).toThrow('one filename');
  expect(mocks.mkdir).not.toHaveBeenCalled();
});
it('returns a local canonical export root after resolving a safe local directory link', () => {
  mocks.lstat.mockImplementation((path: string) => ({ ...localStats, isSymbolicLink: () => path === '/Users/me/mcp' }));
  mocks.readlink.mockReturnValue('/Users/me/real-home');
  expect(resolveGeneratedExportPath("照片 O'Brien %.jpg", 'jpg')).toBe("/Users/me/real-home/exports/照片 O'Brien %.jpg");
});
