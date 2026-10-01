import { expect, it, vi } from 'vitest';
import type { PhotoshopConnection, PhotoshopInfo } from '../src/platform/connection.js';
import { createStateTools } from '../src/tools/state-tools.js';
import { PhotoshopAPIFactory } from '../src/api/photoshop-api.js';

it('waits for initial Photoshop detection before reading state', async () => {
  let finishDetection!: (info: PhotoshopInfo) => void;
  const initialDetection = new Promise<PhotoshopInfo>(resolve => { finishDetection = resolve; });
  let info: PhotoshopInfo | null = null;
  const getVersion = vi.fn(async () => {
    info = await initialDetection;
    return info.version;
  });
  const executeScript = vi.fn(async () => ({ hasDocument: false, documentCount: 0 }));
  const connection = {
    getPhotoshopInfo: () => info,
    getVersion,
    executeScript,
  } as unknown as PhotoshopConnection;
  const getState = createStateTools(connection).find(tool => tool.tool.name === 'photoshop_get_state')!;
  const pendingState = getState.handler({});
  expect(getVersion).toHaveBeenCalledOnce();
  expect(executeScript).not.toHaveBeenCalled();

  finishDetection({ version: '27.0.0', path: '/Applications/Adobe Photoshop.app', isRunning: true });
  const result = await pendingState;
  expect(result.isError).not.toBe(true);
  expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ hasDocument: false });
  expect(executeScript).toHaveBeenCalledOnce();
});

it('does not repeat detection when Photoshop metadata is already available', async () => {
  const getVersion = vi.fn(() => { throw new Error('must not redetect'); });
  const connection = {
    getPhotoshopInfo: () => ({ version: '27.0.0' }),
    getVersion,
  } as unknown as PhotoshopConnection;
  expect((await new PhotoshopAPIFactory(connection).createAPI()).getAPIType()).toBe('ExtendScript');
  expect(getVersion).not.toHaveBeenCalled();
});

it('surfaces a real detection failure without executing a state script', async () => {
  const executeScript = vi.fn();
  const connection = {
    getPhotoshopInfo: () => null,
    getVersion: async () => { throw new Error('Photoshop not installed'); },
    executeScript,
  } as unknown as PhotoshopConnection;
  await expect(new PhotoshopAPIFactory(connection).createAPI()).rejects.toThrow('Photoshop not installed');
  expect(executeScript).not.toHaveBeenCalled();
});
