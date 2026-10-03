import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalSession, NaturalExitTransport } from '../scripts/local-session.mjs';
import { runLocalCall } from '../scripts/call-local.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

// Host mount/WMI policy has its own boundary suites. Keep these lifecycle tests
// offline and usable in a sandbox without WMI privileges; production is unchanged.
vi.mock('../dist/utils/local-path.js', async () => {
  const { isAbsolute } = await import('node:path');
  return { resolveLocalPath(path: string) {
    if (!isAbsolute(path)) throw new Error('Absolute fixture path required.');
    return path;
  } };
});

// This is a protocol/lifecycle fixture, not Photoshop acceptance. No Adobe imports or calls.
const fakeServer = `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = (event) => appendFileSync(process.env.FAKE_LOG, JSON.stringify({ ...event, pid: process.pid }) + '\\n');
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
let active = 0, eof = false, finishing = false;
function finish() {
  if (!eof || active || finishing) return;
  finishing = true;
  setTimeout(() => {
    log({ event: 'drained' });
    process.exitCode = Number(process.env.FAKE_EXIT_CODE || 0);
  }, Number(process.env.FAKE_EXIT_DELAY || 0));
}
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  log({ event: 'request', method: message.method, name: message.params?.name });
  if (message.method === 'initialize') {
    if (process.env.FAKE_BAD_HANDSHAKE) {
      send(message.id, { protocolVersion: '1900-01-01', capabilities: {}, serverInfo: { name: 'offline-fixture', version: 'test' } });
    } else {
      send(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'offline-fixture', version: 'test' } });
    }
  } else if (message.method === 'tools/list') send(message.id, { tools: [] });
  else if (message.method === 'prompts/list') send(message.id, { prompts: [] });
  else if (message.method === 'tools/call') {
    const name = message.params.name;
    if (name === 'error') send(message.id, { isError: true, content: [{ type: 'text', text: '{"ok":false,"code":"queue_timeout","message":"fixture refusal"}' }] });
    else if (name === 'envelope') send(message.id, { content: [{ type: 'text', text: '{"ok":false,"code":"fixture_error"}' }] });
    else if (name === 'image') send(message.id, { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('fixture image bytes').toString('base64') }] });
    else if (name === 'malformed') process.stdout.write('not-json\\n');
    else if (name === 'idle_malformed') {
      send(message.id, { content: [{ type: 'text', text: 'ok' }] });
      setTimeout(() => process.stdout.write('not-json\\n'), 20);
    }
    else if (name === 'slow' || name === 'early_timeout') {
      active++;
      log({ event: 'job_started' });
      if (name === 'early_timeout') send(message.id, { isError: true, content: [{ type: 'text', text: '{"ok":false,"code":"outcome_unknown"}' }] });
      setTimeout(() => {
        log({ event: 'job_finished' });
        if (name === 'slow') send(message.id, { content: [{ type: 'text', text: 'finished' }] });
        active--;
        finish();
      }, Number(process.env.FAKE_WORK_DELAY || 150));
    } else send(message.id, { content: [{ type: 'text', text: 'ok' }] });
  }
});
lines.on('close', () => { eof = true; log({ event: 'eof' }); finish(); });
`;

const temporary: string[] = [];
afterEach(async () => {
  // Every path here is a unique directory created by this test, never the shared Photoshop runtime.
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture(env: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'photoshop-local-session-'));
  temporary.push(directory);
  const entry = join(directory, 'fake-server.mjs');
  const log = join(directory, 'server.jsonl');
  const runtime = join(directory, 'runtime');
  const safety = join(runtime, 'safety');
  await mkdir(safety, { recursive: true });
  // An invalid sentinel proves the caller does not inspect, clear, or bypass shared state.
  const lease = join(safety, 'active.json');
  await writeFile(lease, 'fixture sentinel: do not read or modify');
  await writeFile(entry, fakeServer);
  const config = {
    command: process.execPath, entry, cwd: directory,
    requestTimeoutMs: 3000, closeTimeoutMs: 4000,
    env: {
      FAKE_LOG: log,
      PHOTOSHOP_MCP_HOME: runtime,
      PHOTOSHOP_SAFETY_DIR: safety,
      PHOTOSHOP_RECOVERY_DIR: join(runtime, 'recovery'),
      ...env,
    },
  };
  const readLog = async () => (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  return { directory, lease, config, readLog };
}

const tool = (name: string) => ({ method: 'tools/call', params: { name, arguments: {} } });

describe('persistent local MCP lifecycle (offline fake server only)', () => {
  it('uses one handshake, serial requests, no initialization log gate, and one EOF', async () => {
    const f = await fixture();
    const events: any[] = [];
    const session = await openLocalSession(f.config, (event: any) => events.push(event));
    const first = session.request(tool('slow'));
    const second = session.request({ method: 'tools/list' });
    const third = session.request({ method: 'prompts/list' });
    const closing = session.close();
    await expect(session.request(tool('forbidden'))).rejects.toThrow('session_closing');
    expect((await first).content[0].text).toBe('finished');
    expect((await second).tools).toEqual([]);
    expect((await third).prompts).toEqual([]);
    expect(await closing).toMatchObject({ code: 0, signal: null, forcedKill: false });
    expect(await session.close()).toMatchObject({ forcedKill: false });
    const log = await f.readLog();
    expect(log.filter((event) => event.method === 'initialize')).toHaveLength(1);
    expect(log.filter((event) => event.event === 'eof')).toHaveLength(1);
    expect(log.findIndex((event) => event.event === 'job_finished')).toBeLessThan(log.findIndex((event) => event.method === 'tools/list'));
    expect(events.filter((event) => event.type === 'stdin_eof')).toHaveLength(1);
    expect(new Set(log.map((event) => event.pid))).toEqual(new Set([session.pid]));
    expect(await readFile(f.lease, 'utf8')).toBe('fixture sentinel: do not read or modify');
  });

  it.each(['error', 'envelope'])('returns the original %s response and refuses queued/later requests', async (name) => {
    const f = await fixture();
    const session = await openLocalSession(f.config);
    const failed = session.request(tool(name));
    const queued = session.request(tool('must_not_dispatch'));
    const rejected = expect(queued).rejects.toThrow('session_stopped');
    const response = await failed;
    expect(JSON.parse(response.content[0].text).ok).toBe(false);
    await rejected;
    await expect(session.request(tool('must_not_dispatch'))).rejects.toThrow('session_stopped');
    await session.close();
    expect((await f.readLog()).filter((event) => event.method === 'tools/call').map((event) => event.name)).toEqual([name]);
  });

  it('waits for the server to drain underlying work after an early timeout response', async () => {
    const f = await fixture({ FAKE_WORK_DELAY: '180' });
    const session = await openLocalSession(f.config);
    const response = await session.request(tool('early_timeout'));
    expect(response.isError).toBe(true);
    await session.close();
    const log = await f.readLog();
    expect(log.findIndex((event) => event.event === 'eof')).toBeLessThan(log.findIndex((event) => event.event === 'job_finished'));
    expect(log.at(-1).event).toBe('drained');
  });

  it('caller timeout does not replay or kill; EOF still waits for the fake job', async () => {
    const f = await fixture({ FAKE_WORK_DELAY: '1500' });
    const session = await openLocalSession({ ...f.config, requestTimeoutMs: 1000 });
    await expect(session.request(tool('slow'))).rejects.toThrow(/timed out/i);
    await expect(session.request(tool('echo'))).rejects.toThrow('session_stopped');
    expect(await session.close()).toMatchObject({ code: 0, forcedKill: false });
    const log = await f.readLog();
    expect(log.filter((event) => event.method === 'tools/call')).toHaveLength(1);
    expect(log.at(-1).event).toBe('drained');
  });

  it('transport parse failure stops the workflow without replacing the exception', async () => {
    const f = await fixture();
    const session = await openLocalSession(f.config);
    await expect(session.request(tool('malformed'))).rejects.toThrow();
    await expect(session.request(tool('echo'))).rejects.toThrow('session_stopped');
    expect(await session.close()).toMatchObject({ code: 0, forcedKill: false });
  });

  it('an asynchronous transport failure between calls prevents the next dispatch', async () => {
    const f = await fixture();
    let failed!: () => void;
    const failure = new Promise<void>((resolve) => { failed = resolve; });
    const session = await openLocalSession(f.config, (event: any) => {
      if (event.type === 'transport_error') failed();
    });
    expect((await session.request(tool('idle_malformed'))).content[0].text).toBe('ok');
    await failure;
    await expect(session.request(tool('must_not_dispatch'))).rejects.toThrow();
    await session.close();
    expect((await f.readLog()).filter((event) => event.method === 'tools/call').map((event) => event.name)).toEqual(['idle_malformed']);
  });

  it('direct SDK client.close never escalates after the SDK default two-second grace period', async () => {
    const f = await fixture({ FAKE_EXIT_DELAY: '2200' });
    const transport = new NaturalExitTransport({ command: f.config.command, args: [f.config.entry], cwd: f.config.cwd, env: { ...process.env, ...f.config.env }, stderr: 'pipe', closeTimeoutMs: 5000 });
    const client = new Client({ name: 'offline-close-adapter', version: 'test' });
    await client.connect(transport);
    await client.listTools();
    await client.close();
    expect((await f.readLog()).at(-1).event).toBe('drained');
  });

  it('shutdown deadline reports the live PID and preserves it until natural exit', async () => {
    const f = await fixture({ FAKE_EXIT_DELAY: '150' });
    const events: any[] = [];
    let closed!: () => void;
    const naturalExit = new Promise<void>((resolve) => { closed = resolve; });
    const session = await openLocalSession({ ...f.config, closeTimeoutMs: 20 }, (event: any) => {
      events.push(event);
      if (event.type === 'process_close') closed();
    });
    await expect(session.close()).rejects.toMatchObject({ code: 'shutdown_blocked', pid: session.pid });
    expect(() => process.kill(session.pid, 0)).not.toThrow(); // Existence check, not a termination signal.
    await naturalExit;
    expect(events.find((event) => event.type === 'process_close')).toMatchObject({ code: 0, signal: null, forcedKill: false });
  });

  it('failed initialization still sends EOF and records natural exit', async () => {
    const f = await fixture({ FAKE_BAD_HANDSHAKE: '1' });
    const events: any[] = [];
    await expect(openLocalSession(f.config, (event: any) => events.push(event))).rejects.toThrow(/protocol version/i);
    expect(events.find((event) => event.type === 'process_close')).toMatchObject({ code: 0, forcedKill: false });
    expect((await f.readLog()).filter((event) => event.event === 'eof')).toHaveLength(1);
  });
});

describe('one-request evidence (offline fake server only)', () => {
  it.each(['echo', 'error', 'image'])('persists the %s response and natural shutdown', async (name) => {
    const f = await fixture();
    const requestPath = join(f.directory, 'request.json');
    const outputPath = join(f.directory, 'response.json');
    await writeFile(requestPath, JSON.stringify(tool(name)));
    const result = await runLocalCall({ requestPath, outputPath, config: f.config });
    expect(result.status).toBe(name === 'error' ? 'tool_error' : 'passed');
    const saved = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(saved.shutdown).toMatchObject({ code: 0, forcedKill: false });
    expect(saved.response).toBeDefined();
    if (name === 'image') {
      expect(saved.response.content[0].data).toBeUndefined();
      expect(await readFile(saved.response.content[0].saved_image, 'utf8')).toBe('fixture image bytes');
    }
    expect(await readFile(outputPath + '.events.jsonl', 'utf8')).toContain('stdin_eof');
  });

  it('keeps a successful response when natural server exit fails', async () => {
    const f = await fixture({ FAKE_EXIT_CODE: '7' });
    const requestPath = join(f.directory, 'request.json');
    const outputPath = join(f.directory, 'response.json');
    await writeFile(requestPath, JSON.stringify(tool('echo')));
    const result = await runLocalCall({ requestPath, outputPath, config: f.config });
    expect(result.status).toBe('failed');
    expect(result.response.content[0].text).toBe('ok');
    expect(result.shutdownError.code).toBe('server_exit_failed');
    expect(JSON.parse(await readFile(outputPath, 'utf8')).response).toEqual(result.response);
  });

  it('refuses an existing output before starting any server', async () => {
    const f = await fixture();
    const requestPath = join(f.directory, 'request.json');
    const outputPath = join(f.directory, 'response.json');
    await writeFile(requestPath, JSON.stringify(tool('echo')));
    await writeFile(outputPath, 'original evidence');
    await expect(runLocalCall({ requestPath, outputPath, config: f.config })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(outputPath, 'utf8')).toBe('original evidence');
    await expect(f.readLog()).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
