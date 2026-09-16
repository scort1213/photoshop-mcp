import { expect, it } from 'vitest';
import { getPhotoshopCapabilities } from '../src/platform/capabilities.js';
import { createGenerativeTools } from '../src/tools/generative-tools.js';
import type { PhotoshopConnection } from '../src/platform/connection.js';

it.each(['23.0.0', '25.0.0', '25.10.9', '2024', 'unknown'])(
  'rejects Generate Image on %s before any document execution', async version => {
    let executions = 0;
    const connection = {
      getVersion: async () => version,
      executeScript: async () => { executions++; throw new Error('must not execute'); },
    } as unknown as PhotoshopConnection;
    const tool = createGenerativeTools(connection).find(x => x.tool.name === 'photoshop_generate_image')!;
    const result = await tool.handler({ prompt: 'test' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('version_unsupported');
    expect(JSON.stringify(result)).toContain('generate_image');
    expect(executions).toBe(0);
  },
);

it.each(['25.11.0', '25.12.0', '26.0.0'])('recognizes Generate Image version eligibility on %s', version => {
  expect(getPhotoshopCapabilities(version).features.generate_image).toBe(true);
});

it('does not confuse earlier Generative Fill eligibility with Generate Image', () => {
  const caps = getPhotoshopCapabilities('25.10.0').features;
  expect(caps.generative_fill).toBe(true);
  expect(caps.generate_image).toBe(false);
});
