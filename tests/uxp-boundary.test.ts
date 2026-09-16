import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let bridge: typeof import('../src/platform/uxp-bridge-server.js');
let root: string;
let port: number;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'uxp-boundary-'));
  process.env.PHOTOSHOP_SAFETY_DIR = root;
  process.env.PHOTOSHOP_UXP_BRIDGE_PORT = '0';
  bridge = await import('../src/platform/uxp-bridge-server.js');
  const ports = await Promise.all([bridge.ensureUxpBridgeServer(), bridge.ensureUxpBridgeServer()]);
  expect(ports[0]).toBe(ports[1]);
  port = ports[0];
});
afterAll(async () => {
  await bridge.shutdownUxpBridgeServer();
  delete process.env.PHOTOSHOP_SAFETY_DIR;
  delete process.env.PHOTOSHOP_UXP_BRIDGE_PORT;
  await rm(root, { recursive: true, force: true });
});
it('does not confuse a listening HTTP server with a connected plugin', async () => {
  const state = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  expect(state.pluginConnected).toBe(false);
});
it('removes timed-out undelivered commands before a plugin reconnects', async () => {
  const result = await bridge.invokeUxpBridge('must-not-run', {}, 50);
  expect(result.error).toBe('uxp_queue_timeout');
  expect((await fetch(`http://127.0.0.1:${port}/poll`)).status).toBe(204);
  const state = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  expect(state.pending).toBe(0);
});
it('rejects unknown results and malformed JSON instead of retaining them forever', async () => {
  for (const body of ['{', '{"id":"unknown","ok":true}'])
    expect((await fetch(`http://127.0.0.1:${port}/result`, { method: 'POST', body })).status).toBe(
      400
    );
});
it('retains exclusivity after a delivered timeout until the actual plugin reply', async () => {
  const safety = await import('../src/platform/operation-safety.js');
  const operation = bridge.invokeUxpBridge('slow', {}, 120);
  let command: { id: string } | undefined;
  for (let i = 0; i < 20 && !command; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/poll`);
    if (response.status === 200) command = await response.json();
    else await new Promise((r) => setTimeout(r, 5));
  }
  expect(command).toBeDefined();
  expect((await operation).error).toContain('outcome_unknown');
  await expect(safety.acquireLease(Date.now() + 40)).rejects.toThrow('queue_timeout');
  await expect(safety.assertSafe()).rejects.toThrow('outcome_unknown');
  expect(
    (
      await fetch(`http://127.0.0.1:${port}/result`, {
        method: 'POST',
        body: JSON.stringify({ id: command!.id, ok: true }),
      })
    ).status
  ).toBe(200);
  const lease = await safety.acquireLease(Date.now() + 1000);
  await lease.release();
  await expect(safety.assertSafe()).rejects.toThrow('outcome_unknown');
  await safety.clearQuarantine();
});
it('expires plugin heartbeat instead of reporting a stale connection', async () => {
  await fetch(`http://127.0.0.1:${port}/poll`);
  const now = Date.now();
  const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 16000);
  try {
    expect((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).pluginConnected).toBe(
      false
    );
  } finally {
    spy.mockRestore();
  }
});
