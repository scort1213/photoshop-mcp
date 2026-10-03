import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ exec: vi.fn(), access: vi.fn() }));
vi.mock('../src/utils/local-path.js', () => ({ resolveLocalPath: (path: string) => path }));
vi.mock('../src/utils/system-tools.js', () => ({
  getWindowsSystemTool: (name: string) => 'C:\\Windows\\System32\\' + name + '.exe',
}));
vi.mock('node:child_process', () => ({ execFile: mocks.exec }));
vi.mock('node:fs/promises', () => ({ access: mocks.access, constants: { F_OK: 0 } }));

import { WindowsDetector } from '../src/platform/windows-detector.js';

type Discovery = {
  detectFromRegistry(): Promise<{ path: string } | null>;
  getCommonPaths(): string[];
};
const registry = [
  String.raw`HKEY_LOCAL_MACHINE\SOFTWARE\Adobe\Photoshop\9.0`,
  String.raw`    ApplicationPath    REG_SZ    C:\Adobe\Photoshop 9.0`,
  String.raw`HKEY_LOCAL_MACHINE\SOFTWARE\Adobe\Photoshop\27.0`,
  String.raw`    ApplicationPath    REG_SZ    C:\Adobe\Photoshop 27.0`,
  String.raw`HKEY_LOCAL_MACHINE\SOFTWARE\Adobe\Photoshop\26.0`,
  String.raw`    ApplicationPath    REG_SZ    C:\Adobe\Photoshop 26.0`,
].join('\n');

beforeEach(() => {
  mocks.access.mockResolvedValue(undefined);
  mocks.exec.mockImplementation((file: string, _args: string[], _options: unknown,
    callback: (error: unknown, output: unknown) => void) => {
    callback(null, { stdout: file.endsWith('reg.exe') ? registry : 'Photoshop.exe', stderr: '' });
  });
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('prefers the highest installed numeric registry version', async () => {
  const detector = new WindowsDetector() as unknown as Discovery;
  expect((await detector.detectFromRegistry())?.path).toBe(String.raw`C:\Adobe\Photoshop 27.0\Photoshop.exe`);
});

it('falls back to the next installed registry release when the newest entry is stale', async () => {
  mocks.access.mockImplementation(async (path: string) => {
    if (path.includes('27.0')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
  const detector = new WindowsDetector() as unknown as Discovery;
  expect((await detector.detectFromRegistry())?.path).toBe(String.raw`C:\Adobe\Photoshop 26.0\Photoshop.exe`);
  expect(mocks.access.mock.calls.map(([path]) => path)).toEqual([
    String.raw`C:\Adobe\Photoshop 27.0\Photoshop.exe`,
    String.raw`C:\Adobe\Photoshop 26.0\Photoshop.exe`,
  ]);
});

it('includes current and upcoming year installation folders without a release-year code change', () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
    vi.stubEnv('ProgramFiles', String.raw`C:\Program Files`);
    const paths = (new WindowsDetector() as unknown as Discovery).getCommonPaths();
    expect(paths).toContain(String.raw`C:\Program Files\Adobe\Adobe Photoshop 2026\Photoshop.exe`);
    expect(paths).toContain(String.raw`C:\Program Files\Adobe\Adobe Photoshop 2027\Photoshop.exe`);
    expect(paths).toContain(String.raw`C:\Program Files\Adobe\Adobe Photoshop 2012\Photoshop.exe`);
  } finally {
    vi.useRealTimers();
  }
});
