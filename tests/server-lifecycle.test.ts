import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhotoshopMCPServer } from '../src/core/server.js';
import { Session } from '../src/core/session.js';
import type { ToolRegistry, ToolHandler } from '../src/core/tool-registry.js';
import { PhotoshopConnection } from '../src/platform/connection.js';
import { WindowsExecutor } from '../src/platform/windows-executor.js';
import { drainOperationRunners } from '../src/platform/operation-safety.js';

// Mount policy is independently covered. These fixtures use only their own
// temporary directory and never start an Adobe process or native bridge.
vi.mock('../src/utils/local-path.js', async (original) => ({
  ...(await original<typeof import('../src/utils/local-path.js')>()),
  resolveLocalPath: (path: string) => path,
  getLocalTempRoot: () => process.env.PHOTOSHOP_MCP_HOME!,
  validateRuntimePaths: vi.fn(),
}));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
let root: string;
const releases: Array<() => void> = [];
const servers: PhotoshopMCPServer[] = [];
const clients: Client[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ps-server-lifecycle-'));
  vi.stubEnv('PHOTOSHOP_MCP_HOME', root);
  vi.stubEnv('PHOTOSHOP_SAFETY_DIR', join(root, 'safety'));
  vi.stubEnv('LOG_LEVEL', '3');
  for (const method of ['ping', 'getVersion', 'executeScript', 'ensurePhotoshopRunning'] as const)
    vi.spyOn(PhotoshopConnection.prototype, method).mockRejectedValue(new Error('Unexpected Adobe call'));
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(servers.splice(0).map(server => server.stop()));
  await Promise.allSettled(clients.splice(0).map(client => client.close()));
  await drainOperationRunners();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function makeServer() {
  const server = new PhotoshopMCPServer({ serverVersion: '0.0.0-test' });
  servers.push(server);
  return server;
}
async function connectedServer(handler?: ToolHandler) {
  const server = makeServer();
  if (handler) {
    const registry = (server as unknown as { toolRegistry: ToolRegistry }).toolRegistry;
    registry.register('lifecycle_probe', {
      tool: { name: 'lifecycle_probe', inputSchema: { type: 'object' } }, handler,
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'offline-lifecycle', version: '1' });
  clients.push(client);
  await server.start(serverTransport);
  await client.connect(clientTransport);
  return { server, client, serverTransport };
}

it('serves discovery and cached metadata without any detached Adobe initialization', async () => {
  const initialize = vi.spyOn(Session.prototype, 'initialize').mockRejectedValue(new Error('Unexpected startup initialization'));
  const { server, client } = await connectedServer();
  expect((await client.listTools()).tools.some(tool => tool.name === 'photoshop_get_state')).toBe(true);
  expect((await client.listPrompts()).prompts.length).toBeGreaterThan(0);
  expect(await server.getPhotoshopVersion()).toBeUndefined();
  vi.spyOn(PhotoshopConnection.prototype, 'getPhotoshopInfo').mockReturnValue({ version: '23.0.0', path: 'fixture', isRunning: true });
  expect(await server.getPhotoshopVersion()).toBe('23.0.0');
  await tick();
  expect(initialize).not.toHaveBeenCalled();
  for (const method of ['ping', 'getVersion', 'executeScript', 'ensurePhotoshopRunning'] as const)
    expect(PhotoshopConnection.prototype[method]).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});

it('waits for accepted work before its first runner and rejects newly arriving tools', async () => {
  const entered = deferred();
  const gate = deferred();
  releases.push(gate.resolve);
  const handler = vi.fn(async () => {
    entered.resolve();
    await gate.promise;
    return { content: [{ type: 'text' as const, text: 'finished' }] };
  });
  const { server, client } = await connectedServer(handler);
  const close = vi.spyOn((server as unknown as { server: { close(): Promise<void> } }).server, 'close');
  const accepted = client.callTool({ name: 'lifecycle_probe', arguments: {} }).catch(error => error);
  await entered.promise;
  const stopping = server.stop();
  expect(server.stop()).toBe(stopping);
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await tick();
  expect(stopped).toBe(false);
  expect(close).not.toHaveBeenCalled();
  await expect(client.callTool({ name: 'lifecycle_probe', arguments: {} })).rejects.toThrow('server_stopping');
  expect(handler).toHaveBeenCalledTimes(1);
  gate.resolve();
  await stopping;
  await accepted;
  expect(close).toHaveBeenCalledTimes(1);
});

it('waits for the actual bridge and lease cleanup after the client received outcome_unknown', async () => {
  const entered = deferred();
  const gate = deferred();
  releases.push(gate.resolve);
  class OfflineExecutor extends WindowsExecutor {
    protected override async executeScript(_script: string, _child: (pid: number) => Promise<void>, dispatch: () => void) {
      dispatch();
      entered.resolve();
      await gate.promise;
      return 'late completion';
    }
  }
  const executor = new OfflineExecutor();
  const { server, client } = await connectedServer(async () => {
    try {
      await executor.execute('offline fixture', 100);
      return { content: [] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: String(error) }] };
    }
  });
  const call = client.callTool({ name: 'lifecycle_probe', arguments: {} });
  await entered.promise;
  expect(JSON.stringify(await call)).toContain('outcome_unknown');
  expect((await stat(join(root, 'safety', 'active.json'))).isFile()).toBe(true);
  const close = vi.spyOn((server as unknown as { server: { close(): Promise<void> } }).server, 'close');
  const stopping = server.stop();
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await tick();
  expect(stopped).toBe(false);
  expect(close).not.toHaveBeenCalled();
  gate.resolve();
  await stopping;
  await expect(stat(join(root, 'safety', 'active.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readdir(join(root, 'safety'))).some(name => name.startsWith('uncertain'))).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);
});

it('handles closure during transport startup without closing before start has settled', async () => {
  const gate = deferred();
  const entered = deferred();
  releases.push(gate.resolve);
  const transport: Transport = {
    start: vi.fn(async () => {
      // A transport can report EOF synchronously before returning its pending start.
      transport.onclose?.();
      entered.resolve();
      await gate.promise;
    }),
    close: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
  };
  const server = makeServer();
  const starting = server.start(transport);
  await entered.promise;
  const stopping = server.stop();
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await tick();
  expect(stopped).toBe(false);
  expect(transport.close).not.toHaveBeenCalled();
  gate.resolve();
  await starting;
  await stopping;
  // The SDK forgets an already closed transport; no second close is required.
  expect(PhotoshopConnection.prototype.ping).not.toHaveBeenCalled();
  await expect(server.start(transport)).rejects.toThrow('server_stopping');
});
