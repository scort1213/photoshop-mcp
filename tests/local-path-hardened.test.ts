import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ exec: vi.fn(), lstat: vi.fn(), readlink: vi.fn(), readdir: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: mocks.exec }));
vi.mock('node:fs', () => ({ lstatSync: mocks.lstat, readlinkSync: mocks.readlink, readdirSync: mocks.readdir }));
import {
  assertLocalPath, assertLocalPathSyntax, assertFixedToolPaths, assertLocalDatasetReferences,
  getLocalTempRoot, normalizeDatasetXml, resolveLocalPath, toAdobePath, validateRuntimePaths, withLocalPathContext,
} from '../src/utils/local-path.js';
import { getWindowsSystemTool } from '../src/utils/system-tools.js';

const localStats = { isSymbolicLink: () => false, isDirectory: () => true };
const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
const mounts = '/dev/root on / (apfs, local)\n//host/share on /Volumes/Remote (smbfs, nodev)\n';
beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  vi.spyOn(process, 'execPath', 'get').mockReturnValue(String.raw`C:\Node\node.exe`);
  vi.stubEnv('SystemRoot', String.raw`C:\Windows`);
  for (const name of ['PHOTOSHOP_MCP_HOME', 'PHOTOSHOP_PATH', 'PHOTOSHOP_SAFETY_DIR', 'PHOTOSHOP_RECOVERY_DIR', 'ProgramFiles', 'ProgramFiles(x86)']) vi.stubEnv(name, undefined);
  mocks.exec.mockImplementation((tool: string) => {
    if (tool === '/sbin/mount') return mounts;
    if (tool === '/usr/sbin/diskutil') return '<plist><key>VolumeName</key><string>Macintosh HD</string></plist>';
    if (tool === '/usr/bin/xattr') return '';
    if (tool.endsWith('powershell.exe')) return '3';
    throw new Error('unexpected system tool ' + tool);
  });
  mocks.lstat.mockReturnValue(localStats);
  mocks.readdir.mockReturnValue(['Macintosh HD', 'Remote']);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

it.each(['https://example.com/a.psd', 'file:///a.psd', 'smb://host/share', '//host/share', String.raw`\\host\share`, 'local.png', '~/photo.png', 'Macintosh HD:photo.png'])('rejects ambiguous/nonlocal syntax before filesystem access: %s', path => {
  expect(() => assertLocalPathSyntax(path)).toThrow('local_path_required');
  expect(mocks.lstat).not.toHaveBeenCalled();
});
it('retains normal native filenames without decoding percent notation', () => {
  const path = "/Users/me/照片 O'Brien %52 & #?.png";
  expect(resolveLocalPath(path)).toBe(path);
  const uri = toAdobePath(path);
  expect(decodeURIComponent(uri)).toBe(path);
  expect(uri).toContain('%2552');
});
it('rejects Windows URI-drive shorthand, drive-relative paths and shortcuts', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  for (const path of ['/C/images/photo.png', 'C:photo.png', 'C:\\images\\photo.png.lnk', 'C:\\images\\photo.png.'])
    expect(() => assertLocalPathSyntax(path)).toThrow('local_path_required');
});
it('rejects mapped network drives before probing that drive', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  mocks.exec.mockReturnValue('4');
  expect(() => assertLocalPath(String.raw`Z:\photos\image.psd`)).toThrow('local_path_required');
  expect(mocks.lstat.mock.calls.some(call => String(call[0]).startsWith('Z:'))).toBe(false);
});
it('encodes Windows filenames with an explicit native drive and caches the drive check', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  withLocalPathContext(() => {
    expect(toAdobePath(String.raw`C:\photos\a %25#.png`)).toBe('C:/photos/a%20%2525%23.png');
    assertLocalPath(String.raw`C:\photos\other.psd`);
  });
  expect(mocks.exec).toHaveBeenCalledTimes(1);
  expect(mocks.exec.mock.calls[0][0]).toBe(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
});
it.each(['smbfs', 'autofs', 'macfuse'])('rejects a macOS remote/unverified mount before probing it: %s', type => {
  mocks.exec.mockImplementation((tool: string) => tool === '/sbin/mount' ? `/dev/root on / (apfs, local)\n//host/share on /Volumes/Remote (${type}, nodev)\n` : '');
  expect(() => assertLocalPath('/Volumes/Remote/image.psd')).toThrow('local_path_required');
  expect(mocks.lstat).not.toHaveBeenCalled();
});
it.each(['/Remote/photo.png', '/remote/photo.png', '/Macintosh HD/Volumes/Remote/photo.png'])('rejects Adobe volume-name reinterpretation: %s', path => {
  expect(() => resolveLocalPath(path)).toThrow('conflicts with an Adobe volume name');
  expect(mocks.lstat.mock.calls).toEqual([['/Volumes']]);
});
it('rejects volume conflicts named in /Volumes even without a mount record', () => {
  mocks.readdir.mockReturnValue(['Remote', 'Special']);
  expect(() => resolveLocalPath('/Special/photo.png')).toThrow('conflicts with an Adobe volume name');
});
it('fails closed when startup-volume information cannot be verified', () => {
  mocks.exec.mockImplementation((tool: string) => tool === '/sbin/mount' ? mounts : '');
  expect(() => resolveLocalPath('/Users/me/photo.png')).toThrow('startup volume name');
  expect(mocks.lstat).not.toHaveBeenCalled();
});
it('checks a symlink destination mount before following it and returns local canonical targets', () => {
  mocks.lstat.mockImplementation((path: string) => ({ ...localStats, isSymbolicLink: () => path === '/Users/me/link' }));
  mocks.readlink.mockReturnValue('/Volumes/Remote');
  expect(() => resolveLocalPath('/Users/me/link/photo.png')).toThrow('local_path_required');
  expect(mocks.lstat.mock.calls.some(call => String(call[0]).startsWith('/Volumes/Remote'))).toBe(false);
  mocks.readlink.mockReturnValue('../photos');
  expect(resolveLocalPath('/Users/me/link/photo.png')).toBe('/Users/photos/photo.png');
});
it('rejects a Finder alias of any filename before resolving its destination', () => {
  mocks.exec.mockImplementation((tool: string, args: string[]) => {
    if (tool === '/sbin/mount') return mounts;
    if (tool === '/usr/sbin/diskutil') return '<key>VolumeName</key><string>Macintosh HD</string>';
    if (tool === '/usr/bin/xattr' && args.at(-1) === '/Users/me/photo.png')
      return args.includes('-p') ? '0'.repeat(16) + '8000' + '0'.repeat(44) : 'com.apple.FinderInfo\n';
    return '';
  });
  expect(() => resolveLocalPath('/Users/me/photo.png')).toThrow('Finder aliases');
  expect(mocks.readlink).not.toHaveBeenCalled();
});
it('does not interpret failed alias metadata reads as a safe file', () => {
  mocks.exec.mockImplementation((tool: string) => {
    if (tool === '/sbin/mount') return mounts;
    if (tool === '/usr/sbin/diskutil') return '<key>VolumeName</key><string>Macintosh HD</string>';
    throw new Error('metadata denied');
  });
  expect(() => resolveLocalPath('/Users/me/photo.png')).toThrow('Finder alias metadata');
});
it('rejects the hidden Windows .lnk fallback for an absent basename', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  mocks.lstat.mockImplementation((path: string) => path === String.raw`C:\photos\photo.png` ? missing() : localStats);
  expect(() => resolveLocalPath(String.raw`C:\photos\photo.png`)).toThrow('Windows shortcuts');
  expect(mocks.lstat).toHaveBeenCalledWith(String.raw`C:\photos\photo.png.lnk`);
});
it('normalizes every registered path argument while keeping custom scripts/actions unrestricted', () => {
  mocks.lstat.mockImplementation((path: string) => ({ ...localStats, isSymbolicLink: () => path === '/Users/me/link' }));
  mocks.readlink.mockReturnValue('/Users/me/images');
  const args = { files: ['/Users/me/link/a.png', '/Users/me/link/b.png'] };
  assertFixedToolPaths('photoshop_image_stack', args);
  expect(args.files).toEqual(['/Users/me/images/a.png', '/Users/me/images/b.png']);
  mocks.exec.mockClear(); mocks.lstat.mockClear();
  assertFixedToolPaths('photoshop_execute_script', { code: 'trusted code', path: 'https://example.com' });
  assertFixedToolPaths('photoshop_play_action', { path: '//share/file' });
  expect(mocks.exec).not.toHaveBeenCalled(); expect(mocks.lstat).not.toHaveBeenCalled();
});
it.each(['https://example.com/photo.jpg', 'http&#115;://example.com/photo.jpg', '<![CDATA[//server/share/photo.png]]>', 'relative.jpg', '<!--local-->//server/share/photo.png'])('rejects nonlocal XML references: %s', value => {
  const xml = `<variables><v-x:variable trait="fileref"><v-x:value>${value}</v-x:value></v-x:variable></variables>`;
  expect(() => assertLocalDatasetReferences(xml, '/local/data.xml')).toThrow('local_path_required');
  expect(mocks.lstat).not.toHaveBeenCalled();
});
it('rewrites actual XML pixel values to single-encoded URI paths and retains ordinary text', () => {
  const xml = '<variables><variable kind="text"><value>%52 &amp; literal</value></variable><variable kind="pixel"><value><![CDATA[/Users/me/photo %52&#.png]]></value></variable></variables>';
  const normalized = normalizeDatasetXml(xml, '/Users/me/data.xml');
  expect(normalized).toContain('<variable kind="text"><value>%52 &amp; literal</value></variable>');
  expect(normalized).toContain('/Users/me/photo%20%2552%26%23.png');
});
it('preserves trailing spaces in an actual native XML asset filename', () => {
  const xml = '<variables><variable trait="fileref"><value>/Users/me/photo.png </value></variable></variables>';
  expect(normalizeDatasetXml(xml)).toContain('<value>/Users/me/photo.png%20</value>');
  expect(mocks.lstat).toHaveBeenCalledWith('/Users/me/photo.png ');
});
it('rejects external XML definitions before any asset access', () => {
  expect(() => normalizeDatasetXml('<!DOCTYPE variables SYSTEM "https://example.com/data.dtd"><variables/>')).toThrow('local_path_required');
  expect(mocks.lstat).not.toHaveBeenCalled();
});
it('uses only a canonical MCP home for temporary jobs and validates environment roots', () => {
  vi.stubEnv('PHOTOSHOP_MCP_HOME', '/Users/me/mcp');
  vi.stubEnv('TMPDIR', '//host/share');
  expect(getLocalTempRoot()).toBe('/Users/me/mcp/tmp');
  vi.stubEnv('PHOTOSHOP_PATH', '//host/share/Photoshop.app');
  expect(() => validateRuntimePaths()).toThrow('local_path_required');
  expect(mocks.lstat.mock.calls.some(call => String(call[0]).startsWith('//host'))).toBe(false);
});
it('requires trusted native Windows system tools without PATH or cross-drive fallback', () => {
  vi.stubEnv('SystemRoot', '//host/share/Windows');
  expect(() => getWindowsSystemTool('cscript')).toThrow('no PATH or remote fallback');
  vi.stubEnv('SystemRoot', String.raw`D:\Windows`);
  expect(() => getWindowsSystemTool('powershell')).toThrow('same system drive');
  expect(mocks.exec).not.toHaveBeenCalled();
});
it.each([String.raw`C:\Windows\System32`, String.raw`C:\Windows\System32\cscript.exe`])('refuses a filesystem link anywhere in the actual system tool path: %s', path => {
  mocks.lstat.mockImplementation((current: string) => ({ ...localStats, isSymbolicLink: () => current === path }));
  expect(() => getWindowsSystemTool('cscript')).toThrow('system tool paths cannot contain filesystem links');
  expect(mocks.exec).not.toHaveBeenCalled();
});
