import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ exec: vi.fn(), lstat: vi.fn(), readlink: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: mocks.exec }));
vi.mock('node:fs', () => ({ lstatSync: mocks.lstat, readlinkSync: mocks.readlink }));
import { assertLocalPath, assertLocalPathSyntax, assertFixedToolPaths, assertLocalDatasetReferences, withLocalPathContext } from '../src/utils/local-path.js';

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it.each(['https://example.com/a.psd', 'file:///a.psd', 'smb://host/share', '//host/share', String.raw`\\host\share`])('rejects network path syntax %s', path => {
  expect(() => assertLocalPathSyntax(path)).toThrow('local_path_required');
});

it.each(['/Users/me/local file.psd', String.raw`C:\Users\me\local.psd`, 'local.png'])('retains ordinary path syntax %s', path => {
  expect(() => assertLocalPathSyntax(path)).not.toThrow();
});

it('rejects Windows mapped network drives before filesystem access', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  mocks.exec.mockReturnValue('4');
  expect(() => assertLocalPath(String.raw`Z:\photos\image.psd`)).toThrow('local_path_required');
  expect(mocks.lstat).not.toHaveBeenCalled();
});

it('allows local Windows drives and caches the local drive check within one tool', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  mocks.exec.mockReturnValue('3');
  mocks.lstat.mockReturnValue({ isSymbolicLink: () => false });
  withLocalPathContext(() => {
    assertLocalPath(String.raw`C:\photos\image.psd`);
    assertLocalPath(String.raw`C:\photos\other.psd`);
  });
  expect(mocks.exec).toHaveBeenCalledTimes(1);
});

it.each(['smbfs', 'autofs'])('rejects a macOS network/automount volume before filesystem access: %s', type => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  mocks.exec.mockReturnValue(`/dev/root on / (apfs, local)\n//host/share on /Volumes/Remote (${type}, nodev)\n`);
  expect(() => assertLocalPath('/Volumes/Remote/image.psd')).toThrow('local_path_required');
  expect(mocks.lstat).not.toHaveBeenCalled();
});

it('checks a symlink target mount before stat can follow it into a network share', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  mocks.exec.mockReturnValue('/dev/root on / (apfs, local)\n//host/share on /Volumes/Remote (smbfs, nodev)\n');
  mocks.lstat.mockImplementation((path: string) => {
    if (path.startsWith('/Volumes/Remote')) throw new Error('remote path must never be accessed');
    return { isSymbolicLink: () => path === '/Users/me/link' };
  });
  mocks.readlink.mockReturnValue('/Volumes/Remote');
  expect(() => assertLocalPath('/Users/me/link/image.psd')).toThrow('local_path_required');
  expect(mocks.lstat.mock.calls.map(call => call[0])).toEqual(['/Users', '/Users/me', '/Users/me/link']);
  expect(mocks.readlink).toHaveBeenCalledWith('/Users/me/link');
});

it('leaves custom script and recorded action arguments unrestricted', () => {
  expect(() => assertFixedToolPaths('photoshop_execute_script', { code: 'Socket.open("host:80")', path: 'https://example.com' })).not.toThrow();
  expect(() => assertFixedToolPaths('photoshop_play_action', { actionName: 'arbitrary', path: '//share/file' })).not.toThrow();
  expect(mocks.exec).not.toHaveBeenCalled();
  expect(mocks.lstat).not.toHaveBeenCalled();
});

it('rejects explicit and XML-encoded remote data-set asset references before filesystem access', () => {
  for (const value of ['https://example.com/photo.jpg', 'http&#115;://example.com/photo.jpg', '<![CDATA[//server/share/photo.png]]>']) {
    const xml = `<variables><variable trait="fileref"><value>${value}</value></variable></variables>`;
    expect(() => assertLocalDatasetReferences(xml, '/local/data.xml')).toThrow('local_path_required');
  }
  expect(mocks.lstat).not.toHaveBeenCalled();
});

it('rejects external XML definitions before Adobe can resolve them', () => {
  expect(() => assertLocalDatasetReferences('<!DOCTYPE variables SYSTEM "https://example.com/data.dtd"><variables/>', '/local/data.xml')).toThrow('local_path_required');
  expect(mocks.lstat).not.toHaveBeenCalled();
});
