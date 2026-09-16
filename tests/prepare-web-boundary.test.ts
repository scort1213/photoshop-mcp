import { expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { bindPrepareForWeb } from '../src/tools/recipes/prepare-for-web.js';
import type { PhotoshopConnection } from '../src/platform/connection.js';

const mocks = vi.hoisted(() => ({ executeScript: vi.fn() }));
vi.mock('../src/api/photoshop-api.js', () => ({
  PhotoshopAPIFactory: class { async createAPI() { return mocks; } },
}));
vi.mock('../src/utils/atomic-save.js', () => ({
  atomicSave: async (_p: string, _f: string, _o: boolean, write: (p: string) => Promise<void>) => write('C:/stage/output.png'),
}));

it.each(['none', 'profile', 'sharpen'])('preserves source history and reports %s export failure', async failure => {
  const suspendHistory = vi.fn(() => { throw new Error('source history must not change'); });
  const close = vi.fn();
  const saveAs = vi.fn();
  const duplicate = {
    width: { as: () => 64 }, height: { as: () => 48 },
    convertProfile: () => { if (failure === 'profile') throw new Error('profile failed'); },
    activeLayer: { applyUnSharpMask: () => { if (failure === 'sharpen') throw new Error('sharpen failed'); } },
    saveAs, close,
  };
  const source = { suspendHistory, duplicate: () => duplicate };
  mocks.executeScript.mockImplementation(async (script: string) => runInNewContext('(function(){'+script+'})()', {
    app: { activeDocument: source, documents: [source] },
    Intent: { RELATIVECOLORIMETRIC: 1 }, SaveOptions: { DONOTSAVECHANGES: 0 },
    File: class { fsName: string; constructor(p: string) { this.fsName=p; } },
    PNGSaveOptions: class {},
  }));
  const result = await bindPrepareForWeb({} as PhotoshopConnection).handler({ path: 'C:/result.png', format: 'png' });
  expect(suspendHistory).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
  if (failure === 'none') {
    expect(result.isError).not.toBe(true);
    expect(saveAs).toHaveBeenCalledTimes(1);
  } else {
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(failure+' failed');
    expect(saveAs).not.toHaveBeenCalled();
  }
});
