import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { startUIServer } from '../src/ui/server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('disabled standalone UI', () => {
  it('rejects the server API before a listener or credential store can start', async () => {
    const fetch = vi.fn(() => {
      throw new Error('cloud calls are forbidden');
    });
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(startUIServer({ host: '127.0.0.1', port: 5174 })).rejects.toThrow(
        'local-only build'
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the historical CLI exits immediately without creating sessions or opening a browser', async () => {
    const home = await mkdtemp(join(tmpdir(), 'psmcp-no-ui-'));
    try {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', join(ROOT, 'src/ui/cli.ts'), '--host', '0.0.0.0'],
        {
          cwd: ROOT,
          env: { ...process.env, PHOTOSHOP_MCP_HOME: home, ANALYTICS_DISABLED: '0' },
          encoding: 'utf8',
          timeout: 5_000,
        }
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Standalone chat UI is unavailable');
      expect(result.stderr).toContain('dist/index.js');
      expect(result.stdout).toBe('');
      expect(await readdir(home)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
