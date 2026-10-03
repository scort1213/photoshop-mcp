/** Persistent local MCP client. Shutdown is EOF + natural exit, never a kill signal. */
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function positiveTimeout(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function sessionError(code, message, fields = {}) {
  return Object.assign(new Error(`${code}: ${message}`), { code, ...fields });
}

/** Preserve tool error responses instead of converting them into transport exceptions. */
export function isErrorResponse(response) {
  if (response?.isError === true || response?.structuredContent?.ok === false) return true;
  return (response?.content ?? []).some((item) => {
    if (item.type !== 'text') return false;
    try { return JSON.parse(item.text)?.ok === false; } catch { return false; }
  });
}

export function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Request must be an object.');
  if (!['tools/list', 'prompts/list', 'tools/call'].includes(body.method)) {
    throw new Error('Supported methods: tools/list, prompts/list, tools/call.');
  }
  if (body.method === 'tools/call' &&
      (!body.params || typeof body.params.name !== 'string' || !body.params.name.trim())) {
    throw new Error('tools/call requires params.name and optional params.arguments.');
  }
  if (body.params?.arguments !== undefined &&
      (!body.params.arguments || typeof body.params.arguments !== 'object' || Array.isArray(body.params.arguments))) {
    throw new Error('params.arguments must be an object.');
  }
}

/**
 * Own the child process directly so no SDK upgrade can add termination escalation.
 * Implements the SDK Transport contract without StdioClientTransport.close().
 */
export class NaturalExitTransport {
  constructor(config, emit = () => {}) {
    this.config = {
      ...config,
      args: config.args ?? [config.entry],
      closeTimeoutMs: positiveTimeout(config.closeTimeoutMs, 150000, 'closeTimeoutMs'),
    };
    this.emit = emit;
    this.buffer = new ReadBuffer();
    this.stderrStream = new PassThrough();
    this.stderrStream.setEncoding('utf8');
    this.stderrStream.on('data', (text) => this.emit({ type: 'stderr', pid: this.pid, text }));
    this.failure = new Promise((_, reject) => { this.rejectFailure = reject; });
    this.failure.catch(() => {});
    this.exited = new Promise((resolveExit) => { this.resolveExit = resolveExit; });
  }

  get pid() { return this.child?.pid ?? null; }
  get stderr() { return this.stderrStream; }

  reportError(error) {
    this.firstFailure ??= error;
    this.emit({ type: 'transport_error', pid: this.pid, message: error.message });
    this.rejectFailure(error);
    this.onerror?.(error);
  }

  async start() {
    if (this.started) throw new Error('Transport can only be started once.');
    this.started = true;
    await new Promise((resolveStart, rejectStart) => {
      const child = spawn(this.config.command, this.config.args, {
        cwd: this.config.cwd,
        env: this.config.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      child.once('spawn', () => {
        this.emit({ type: 'spawned', pid: child.pid });
        resolveStart();
      });
      child.on('error', (error) => {
        this.reportError(error);
        rejectStart(error);
      });
      child.once('close', (code, signal) => {
        this.exit = { code, signal, pid: child.pid ?? null, forcedKill: false };
        this.emit({ type: 'process_close', ...this.exit });
        this.resolveExit(this.exit);
        this.onclose?.();
      });
      child.stdin.on('error', (error) => this.reportError(error));
      child.stdout.on('error', (error) => this.reportError(error));
      child.stderr.on('error', (error) => this.reportError(error));
      child.stderr.pipe(this.stderrStream);
      child.stdout.on('data', (chunk) => {
        try {
          this.buffer.append(chunk);
          let message;
          while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message);
        } catch (error) { this.reportError(error); }
      });
    });
  }

  async send(message) {
    if (this.firstFailure) throw this.firstFailure;
    if (!this.child?.stdin || this.eof || this.exit) throw new Error('Transport is not writable.');
    await new Promise((resolveWrite, rejectWrite) => {
      this.child.stdin.write(serializeMessage(message), (error) => error ? rejectWrite(error) : resolveWrite());
    });
  }

  async close() {
    if (!this.closing) this.closing = this.endAndWait();
    return this.closing;
  }

  async endAndWait() {
    if (!this.child) return { code: null, signal: null, pid: null, forcedKill: false };
    if (!this.exit && !this.eof) {
      this.eof = true;
      this.emit({ type: 'stdin_eof', pid: this.pid });
      this.child.stdin.end();
    }
    let timeout;
    try {
      const result = await Promise.race([
        this.exited,
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            const error = sessionError('shutdown_blocked', 'Server did not exit naturally before the shutdown deadline; preserve this process and evidence for inspection.', { pid: this.pid });
            this.emit({ type: 'shutdown_blocked', pid: this.pid, forcedKill: false, message: error.message });
            reject(error);
          }, this.config.closeTimeoutMs);
        }),
      ]);
      this.buffer.clear();
      if (result.code !== 0 || result.signal !== null) {
        throw sessionError('server_exit_failed', 'Server did not exit successfully.', {
          pid: result.pid, exitCode: result.code, signal: result.signal, forcedKill: false,
        });
      }
      return result;
    } finally { clearTimeout(timeout); }
  }
}

/**
 * config: optional absolute command/entry/cwd, env overrides, requestTimeoutMs,
 * closeTimeoutMs. Environment is inherited; configured shared safety roots stay intact.
 * onEvent is a synchronous evidence callback; it receives no configuration/environment.
 * No Photoshop initialization log, idle heuristic, or shared lease access is used.
 */
export async function openLocalSession(config = {}, onEvent = () => {}) {
  const settings = {
    command: config.command ?? process.execPath,
    entry: config.entry ?? resolve(checkout, 'dist/index.js'),
    cwd: config.cwd ?? checkout,
    env: { ...process.env, ...config.env },
    requestTimeoutMs: positiveTimeout(config.requestTimeoutMs, 120000, 'requestTimeoutMs'),
    closeTimeoutMs: positiveTimeout(config.closeTimeoutMs, 150000, 'closeTimeoutMs'),
  };
  for (const key of ['command', 'entry', 'cwd']) {
    if (!isAbsolute(settings[key])) throw new Error(`${key} must be an absolute local path.`);
  }
  let eventError;
  const emit = (event) => {
    try { onEvent({ at: new Date().toISOString(), ...event }); }
    catch (error) { eventError ??= error; }
  };
  const transport = new NaturalExitTransport(settings, emit);
  const client = new Client({ name: 'photoshop-local-persistent-client', version: '1.0.0' });
  let queue = Promise.resolve();
  let closing = false;
  let stopped;
  let requestNumber = 0;
  let closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      await queue; // Includes accepted calls, even when a caller did not await them.
      const result = await transport.close();
      if (eventError) throw sessionError('evidence_write_failed', eventError.message, { pid: transport.pid });
      return result;
    })();
    return closePromise;
  };
  try {
    await Promise.race([client.connect(transport, { timeout: settings.requestTimeoutMs }), transport.failure]);
    emit({ type: 'connected', pid: transport.pid, server: client.getServerVersion() });
    if (eventError) throw eventError;
  } catch (error) {
    emit({ type: 'connect_failed', pid: transport.pid, message: error.message });
    try { await close(); } catch (closeError) { error.shutdownError = { code: closeError.code, message: closeError.message, pid: transport.pid }; }
    throw error;
  }
  return {
    server: client.getServerVersion(),
    pid: transport.pid,
    request(body) {
      if (closing) return Promise.reject(sessionError('session_closing', 'No requests are accepted after close().'));
      if (stopped) return Promise.reject(sessionError('session_stopped', 'A previous request failed; inspect its original response or exception.'));
      if (transport.firstFailure) { stopped = transport.firstFailure; return Promise.reject(transport.firstFailure); }
      let snapshot;
      try { validateRequest(body); snapshot = JSON.parse(JSON.stringify(body)); }
      catch (error) { stopped = error; return Promise.reject(error); }
      const number = ++requestNumber;
      const task = queue.then(async () => {
        if (stopped) throw sessionError('session_stopped', 'An earlier queued request failed; this request was not dispatched.');
        if (transport.firstFailure) { stopped = transport.firstFailure; throw transport.firstFailure; }
        if (eventError) throw sessionError('evidence_write_failed', eventError.message);
        emit({ type: 'request_start', number, pid: transport.pid, method: snapshot.method, name: snapshot.params?.name });
        if (eventError) throw sessionError('evidence_write_failed', eventError.message);
        try {
          const options = { timeout: settings.requestTimeoutMs };
          const operation = snapshot.method === 'tools/list' ? client.listTools(snapshot.params, options)
            : snapshot.method === 'prompts/list' ? client.listPrompts(snapshot.params, options)
              : client.callTool(snapshot.params, undefined, options);
          const response = await Promise.race([operation, transport.failure]);
          const isError = isErrorResponse(response);
          if (isError) stopped = sessionError('tool_error', 'Original tool error response was returned unchanged.');
          emit({ type: 'request_result', number, pid: transport.pid, isError });
          // Preserve a received response even if the evidence callback subsequently failed.
          return response;
        } catch (error) {
          stopped = error;
          emit({ type: 'request_exception', number, pid: transport.pid, message: error.message });
          throw error;
        }
      });
      queue = task.catch((error) => { stopped ??= error; });
      return task;
    },
    close,
  };
}

// Compatibility with the persistent caller handoff; this implementation has no idle/lease heuristic.
export const openPhotoshopSession = openLocalSession;
