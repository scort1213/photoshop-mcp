import { expect, it, vi } from 'vitest';
import { getPhotoshopCapabilities, resolvePhotoshopCapabilities } from '../src/platform/capabilities.js';
import { createGenerativeTools } from '../src/tools/generative-tools.js';
import type { PhotoshopConnection } from '../src/platform/connection.js';

it.each(['23.0.0', '25.0.0', '25.11.0', '27.0.0', '2026', 'unknown'])(
  'never advertises cloud features on %s', async version => {
    const caps = getPhotoshopCapabilities(version);
    for (const feature of ['generative_fill', 'generate_image', 'generative_remove', 'generative_expand', 'generative_upscale', 'sky_replacement_native', 'neural_filters', 'uxp_bridge_reachable', 'uxp_plugin_api'] as const) {
      expect(caps.features[feature]).toBe(false);
    }
    expect(await resolvePhotoshopCapabilities(version)).toEqual(caps);
  },
);

it('refuses every exported legacy cloud handler before any Adobe call', async () => {
  const getVersion = vi.fn(() => { throw new Error('must not detect Adobe'); });
  const executeScript = vi.fn(() => { throw new Error('must not execute Adobe'); });
  const connection = { getVersion, executeScript } as unknown as PhotoshopConnection;
  for (const definition of createGenerativeTools(connection)) {
    const result = await definition.handler({ prompt: 'test' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('cloud_disabled');
  }
  expect(getVersion).not.toHaveBeenCalled();
  expect(executeScript).not.toHaveBeenCalled();
});
