import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createStateTools } from '../src/tools/state-tools.js';
import type { PhotoshopConnection } from '../src/platform/connection.js';

let home: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

async function fixture(uncertain = false) {
  home = await mkdtemp(join(tmpdir(), 'owned-preview-'));
  vi.stubEnv('PHOTOSHOP_MCP_HOME', home);
  let ownedPath = '';
  const connection = {
    getPhotoshopInfo: () => ({ version: '27.0.0' }),
    executeScript: async (script: string) => {
      const literal = /tmpFile = new File\(("(?:[^"\\]|\\.)*")\)/.exec(script)?.[1];
      if (!literal) throw new Error('Preview did not receive an owned destination');
      ownedPath = decodeURIComponent(JSON.parse(literal));
      // A minimal JPEG header is sufficient for dimension validation.
      await writeFile(ownedPath, Buffer.from([255,216,255,192,0,8,8,0,120,1,224,0,255,217]));
      if (uncertain) throw new Error('outcome_unknown: bridge timeout');
      return { path: '//untrusted-server/share/preview.jpg', width: 480, height: 120, mimeType: 'image/jpeg' };
    },
  } as unknown as PhotoshopConnection;
  const tool = createStateTools(connection).find(item => item.tool.name === 'photoshop_get_preview')!;
  return { tool, path: () => ownedPath };
}

it('reads and cleans only its own preview, ignoring a remote path returned by the bridge', async () => {
  const { tool, path } = await fixture();
  const result = await tool.handler({ max_dimension_px: 480 });
  expect(result.isError).not.toBe(true);
  expect(result.content.some(item => item.type === 'image')).toBe(true);
  await expect(stat(dirname(path()))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('retains the owned preview directory when execution is uncertain', async () => {
  const { tool, path } = await fixture(true);
  const result = await tool.handler({ max_dimension_px: 480 });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('outcome_unknown');
  expect(JSON.stringify(result)).toContain(dirname(path()));
  expect((await readFile(path())).byteLength).toBeGreaterThan(0);
});
