import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), exec: vi.fn(), access: vi.fn(), read: vi.fn() }));
vi.mock('../src/utils/local-path.js', () => ({ resolveLocalPath: mocks.resolve }));
vi.mock('../src/utils/system-tools.js', () => ({ getWindowsSystemTool: (name: string) => `C:\\Windows\\System32\\${name}.exe` }));
vi.mock('node:child_process', () => ({ execFile: mocks.exec }));
vi.mock('node:fs/promises', () => ({ access: mocks.access, constants: { F_OK: 0 }, readFile: mocks.read }));
import { MacOSDetector } from '../src/platform/macos-detector.js';
import { WindowsDetector } from '../src/platform/windows-detector.js';

beforeEach(() => {
  mocks.resolve.mockImplementation((path: string) => {
    if (path.startsWith('//') || path.startsWith('\\\\') || path.startsWith('/Volumes/Remote') || path.startsWith('Z:'))
      throw new Error('local_path_required: remote path');
    return path.replace('/Users/me/link.app', '/Applications/Local.app');
  });
  mocks.access.mockResolvedValue(undefined);
  mocks.exec.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: unknown, output: unknown) => void) => callback(null, { stdout: '26.0', stderr: '' }));
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

it.each(['/Volumes/Remote/Photoshop.app', '//host/share/Photoshop.app'])('rejects remote macOS installation probes before filesystem access: %s', async path => {
  const detector = new MacOSDetector() as unknown as { checkPath(path: string): Promise<unknown> };
  expect(await detector.checkPath(path)).toBeNull();
  expect(mocks.access).not.toHaveBeenCalled();
  expect(mocks.exec).not.toHaveBeenCalled();
});
it.each([String.raw`\\host\share\Photoshop.exe`, String.raw`Z:\Photoshop.exe`])('rejects remote Windows installation probes before filesystem access: %s', async path => {
  const detector = new WindowsDetector() as unknown as { checkPath(path: string): Promise<unknown> };
  expect(await detector.checkPath(path)).toBeNull();
  expect(mocks.access).not.toHaveBeenCalled();
  expect(mocks.exec).not.toHaveBeenCalled();
});
it('checks the configured installation before discovery and never falls back from an unsafe path', async () => {
  vi.stubEnv('PHOTOSHOP_PATH', '//host/share/Photoshop.app');
  await expect(new MacOSDetector().detect()).rejects.toThrow('local_path_required');
  await expect(new WindowsDetector().detect()).rejects.toThrow('local_path_required');
  expect(mocks.access).not.toHaveBeenCalled();
  expect(mocks.exec).not.toHaveBeenCalled();
});
it('uses the checked canonical app path for installation and metadata reads', async () => {
  const detector = new MacOSDetector() as unknown as { checkPath(path: string): Promise<{ path: string }> };
  const info = await detector.checkPath('/Users/me/link.app');
  expect(info.path).toBe('/Applications/Local.app');
  expect(mocks.access).toHaveBeenCalledWith('/Applications/Local.app', 0);
  expect(mocks.resolve).toHaveBeenCalledWith('/Applications/Local.app/Contents/Info.plist');
});
it('passes shell metacharacters as literal process arguments', async () => {
  const path = '/Applications/Photoshop $(printf SENTINEL).app';
  const detector = new MacOSDetector() as unknown as { checkPath(path: string): Promise<unknown> };
  await detector.checkPath(path);
  expect(mocks.exec.mock.calls[0].slice(0, 2)).toEqual([
    '/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path + '/Contents/Info.plist'],
  ]);
  expect(mocks.exec.mock.calls[1][0]).toBe('/usr/bin/pgrep');
  expect(mocks.exec.mock.calls[1][1]).toEqual(['-f', 'Photoshop \\$\\(printf SENTINEL\\)']);
});
it('refuses a remote Info.plist symlink target before a command or read', async () => {
  mocks.resolve.mockImplementation(() => { throw new Error('local_path_required: remote metadata'); });
  expect(await new MacOSDetector().getAppBundleId('/Applications/Local.app')).toBeNull();
  expect(mocks.exec).not.toHaveBeenCalled();
  expect(mocks.read).not.toHaveBeenCalled();
});
it('passes the checked Windows exe to access and uses an absolute system tool', async () => {
  const detector = new WindowsDetector() as unknown as { checkPath(path: string): Promise<unknown> };
  await detector.checkPath(String.raw`C:\Program Files\Photoshop.exe`);
  expect(mocks.access).toHaveBeenCalledWith(String.raw`C:\Program Files\Photoshop.exe`, 0);
  expect(mocks.exec.mock.calls[0].slice(0, 2)).toEqual([String.raw`C:\Windows\System32\tasklist.exe`, ['/FI', 'IMAGENAME eq Photoshop.exe']]);
});
it('scopes Spotlight to a checked local installation root', async () => {
  const detector = new MacOSDetector() as unknown as { detectUsingSpotlight(): Promise<unknown> };
  await detector.detectUsingSpotlight();
  expect(mocks.resolve).toHaveBeenCalledWith('/Applications');
  expect(mocks.exec.mock.calls[0].slice(0, 2)).toEqual([
    '/usr/bin/mdfind', ['-onlyin', '/Applications', 'kMDItemCFBundleIdentifier == com.adobe.Photoshop'],
  ]);
});
it('does not query Spotlight when its installation root cannot be verified as local', async () => {
  mocks.resolve.mockImplementation(() => { throw new Error('local_path_required: remote applications root'); });
  const detector = new MacOSDetector() as unknown as { detectUsingSpotlight(): Promise<unknown> };
  expect(await detector.detectUsingSpotlight()).toBeNull();
  expect(mocks.exec).not.toHaveBeenCalled();
});
