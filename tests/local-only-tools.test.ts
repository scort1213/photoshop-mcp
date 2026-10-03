import { expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/core/tool-registry.js';
import { CLOUD_DISABLED_TOOLS } from '../src/core/local-policy.js';
import { PhotoshopMCPServer } from '../src/core/server.js';
import { bindRemoveDistraction } from '../src/tools/recipes/remove-distraction.js';
import { bindRemoveBackground } from '../src/tools/recipes/remove-background.js';
import { bindEnhancePortrait } from '../src/tools/recipes/enhance-portrait.js';
import { bindSkyBlend } from '../src/tools/recipes/sky-blend.js';
import { createNeuralTools } from '../src/tools/neural-tools.js';
import type { PhotoshopConnection } from '../src/platform/connection.js';

function registry(server: PhotoshopMCPServer): ToolRegistry {
  return (server as unknown as { toolRegistry: ToolRegistry }).toolRegistry;
}

it('hides cloud tools and refuses even direct requests without executing a handler', async () => {
  const tools = new ToolRegistry();
  const handler = vi.fn();
  for (const name of CLOUD_DISABLED_TOOLS) {
    tools.register(name, { tool: { name, inputSchema: { type: 'object' } }, handler });
    const result = await tools.execute(name, {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('cloud_disabled');
  }
  expect(tools.list()).toEqual([]);
  expect(handler).not.toHaveBeenCalled();
});

it('preserves regular tools and rejects cloud parameters before document validation or Adobe access', async () => {
  const server = new PhotoshopMCPServer({ serverVersion: 'test' });
  const tools = registry(server);
  const names = tools.list().map(tool => tool.name);
  expect(names).toHaveLength(112);
  for (const name of CLOUD_DISABLED_TOOLS) expect(names).not.toContain(name);
  for (const name of ['photoshop_execute_script', 'photoshop_play_action', 'photoshop_select_subject', 'photoshop_recipe_remove_background', 'photoshop_recipe_passport_photo']) expect(names).toContain(name);
  for (const [name, option] of [
    ['photoshop_recipe_remove_distraction', 'use_generative'],
    ['photoshop_recipe_remove_background', 'use_generative'],
    ['photoshop_recipe_enhance_portrait', 'use_neural_skin'],
    ['photoshop_recipe_sky_blend', 'use_native_sky'],
  ]) {
    const result = await tools.execute(name, { [option]: true, document_id: -1 });
    expect(JSON.stringify(result)).toContain('cloud_disabled');
  }
  expect(tools.get('photoshop_execute_script')!.tool.description).toContain('trusted, unsandboxed');
  expect(tools.get('photoshop_play_action')!.tool.description).toContain('trusted, unsandboxed');
});

it('rejects fixed URL/UNC paths before Adobe detection', async () => {
  const tools = registry(new PhotoshopMCPServer({ serverVersion: 'test' }));
  for (const filePath of ['https://example.com/image.png', '\\\\server\\share\\image.psd']) {
    const result = await tools.execute('photoshop_open_image', { filePath });
    expect(JSON.stringify(result)).toContain('local_path_required');
  }
});

it('guards exported recipe and neural handlers before connection access too', async () => {
  const access = vi.fn(() => { throw new Error('must not access Adobe'); });
  const connection = { executeScript: access, getVersion: access, ping: access, getPhotoshopInfo: access } as unknown as PhotoshopConnection;
  for (const [tool, args] of [
    [bindRemoveDistraction(connection), { use_generative: true }],
    [bindRemoveBackground(connection), { use_generative: true }],
    [bindEnhancePortrait(connection), { use_neural_skin: true }],
    [bindSkyBlend(connection), { use_native_sky: true }],
    [createNeuralTools(connection)[0], { filter: 'colorize' }],
  ] as const) {
    expect(JSON.stringify(await tool.handler(args))).toContain('cloud_disabled');
  }
  expect(access).not.toHaveBeenCalled();
});

it('omitted cloud parameters execute only content-aware fill and local sky compositing', async () => {
  const scripts: string[] = [];
  const getVersion = vi.fn(() => { throw new Error('no cloud capability lookup'); });
  const connection = {
    getPhotoshopInfo: () => ({ version: '27.0.0' }),
    getVersion,
    executeScript: async (script: string) => { scripts.push(script); return { ok: true, summary: 'local', details: {} }; },
  } as unknown as PhotoshopConnection;
  expect((await bindRemoveDistraction(connection).handler({})).isError).not.toBe(true);
  expect(scripts[0]).toContain("sTID('contentAware')");
  expect(scripts[0]).not.toContain('generative');
  expect((await bindSkyBlend(connection).handler({ sky_image_path: join(tmpdir(), 'sky.jpg') })).isError).not.toBe(true);
  expect(scripts[1]).toContain('new File(');
  expect(scripts[1]).not.toContain('skyReplacement');
  expect(getVersion).not.toHaveBeenCalled();
});
