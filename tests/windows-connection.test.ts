import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const discovery = vi.hoisted(() => ({ version: 'Unknown' }));
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  platform: () => 'win32',
}));
vi.mock('../src/platform/detector.js', () => ({
  PhotoshopDetector: class {
    async detect() {
      return { version: discovery.version, path: String.raw`C:\Adobe\Photoshop.exe`, isRunning: true };
    }
  },
}));

import { PhotoshopConnection } from '../src/platform/connection.js';
import { WindowsExecutor } from '../src/platform/windows-executor.js';
import { access } from '../src/platform/operation-safety.js';

beforeEach(() => {
  vi.spyOn(WindowsExecutor.prototype, 'isPhotoshopRunning').mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe('Windows runtime version discovery', () => {
  it.each(['Unknown', '2026', '19.1', '1234'])(
    'queries the COM host instead of trusting the directory version %s',
    async (version) => {
      discovery.version = version;
      const execute = vi.spyOn(WindowsExecutor.prototype, 'execute').mockImplementation(async (script) => {
        expect(script).toBe('app.version');
        expect(access.getStore()).toBe('read');
        return '27.1.2';
      });
      const connection = new PhotoshopConnection();
      expect(await connection.getVersion()).toBe('27.1.2');
      expect(connection.getPhotoshopInfo()?.version).toBe('27.1.2');
      expect(execute).toHaveBeenCalledTimes(1);
    }
  );

  it('refreshes when the registered host changes between calls', async () => {
    discovery.version = '2026';
    vi.spyOn(WindowsExecutor.prototype, 'execute')
      .mockResolvedValueOnce('27.1.2')
      .mockResolvedValueOnce('23.0.0');
    const connection = new PhotoshopConnection();
    expect(await connection.getVersion()).toBe('27.1.2');
    expect(await connection.getVersion()).toBe('23.0.0');
  });

  it('does not return a stale version when the live host fails', async () => {
    discovery.version = '27.1';
    vi.spyOn(WindowsExecutor.prototype, 'execute').mockRejectedValue(new Error('application_busy'));
    await expect(new PhotoshopConnection().getVersion()).rejects.toThrow('application_busy');
  });

  it('rejects malformed runtime version output', async () => {
    discovery.version = 'Unknown';
    vi.spyOn(WindowsExecutor.prototype, 'execute').mockResolvedValue('2026');
    await expect(new PhotoshopConnection().getVersion()).rejects.toThrow('Unexpected Photoshop runtime version');
  });
});
