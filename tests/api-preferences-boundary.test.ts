import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { PhotoshopAPIFactory } from '../src/api/photoshop-api.js';
import type { PhotoshopConnection } from '../src/platform/connection.js';

it.each([false, true])('disables quote substitution for the whole call and restores preferences after error=%s', async fails => {
  const preferences = { rulerUnits: 'inches', typeUnits: 'original', smartQuotes: true };
  const app = { preferences, displayDialogs: 'original', documents: [{}] };
  const context = { app, Units: { PIXELS: 'pixels' }, TypeUnits: { POINTS: 'points' }, DialogModes: { NO: 'none' } };
  const connection = {
    getPhotoshopInfo: () => ({ version: '23.0.0' }),
    executeScript: async (script: string) => runInNewContext(script, context),
  } as unknown as PhotoshopConnection;
  const api = await new PhotoshopAPIFactory(connection).createAPI();
  const result = await api.executeScript(`
    if (app.preferences.smartQuotes !== false) throw new Error('smart quotes still enabled');
    ${fails ? "throw new Error('expected partial failure');" : "return 'literal text preserved';"}
  `);
  expect(result).toBe(fails ? 'ERROR: expected partial failure' : 'literal text preserved');
  expect(preferences).toEqual({ rulerUnits: 'inches', typeUnits: 'original', smartQuotes: true });
  expect(app.displayDialogs).toBe('original');
});
