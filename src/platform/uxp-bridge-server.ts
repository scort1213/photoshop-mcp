import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { acquireLease, assertSafe, quarantine } from './operation-safety.js';

export interface UxpBridgeCommand {
  id: string;
  action: string;
  params: Record<string, unknown>;
}
export interface UxpBridgeResult {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}
type Pending = {
  command: UxpBridgeCommand;
  deadline: number;
  delivered: boolean;
  expired: boolean;
  timer: ReturnType<typeof setTimeout>;
  quarantineWork?: Promise<void>;
  resolve: (result: UxpBridgeResult) => void;
  release: () => Promise<void>;
};
const pending = new Map<string, Pending>();
let server: Server | null = null;
let starting: Promise<number> | null = null;
let listenPort = Number.parseInt(process.env.PHOTOSHOP_UXP_BRIDGE_PORT ?? '38452', 10);
let lastPluginPollAt = 0;
export const getUxpBridgePort = () => listenPort;

async function uncertain(task: Pending, reason: string): Promise<void> {
  task.expired = true;
  task.quarantineWork ??= quarantine(reason);
  try {
    await task.quarantineWork;
  } finally {
    task.resolve({ id: task.command.id, ok: false, error: 'outcome_unknown: ' + reason });
  }
}

export async function ensureUxpBridgeServer(): Promise<number> {
  if (server) return listenPort;
  if (starting) return starting;
  starting = new Promise<number>((resolve, reject) => {
    const s = createServer((req, res) => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        json(200, {
          ok: true,
          pending: pending.size,
          pluginConnected: lastPluginPollAt > 0 && Date.now() - lastPluginPollAt < 15000,
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/poll') {
        lastPluginPollAt = Date.now();
        const next = [...pending.values()].find(
          (p) => !p.delivered && !p.expired && p.deadline > Date.now()
        );
        if (!next) {
          res.writeHead(204);
          res.end();
          return;
        }
        next.delivered = true;
        json(200, next.command);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/result') {
        let body = '';
        let oversized = false;
        req.on('data', (chunk) => {
          if (oversized) return;
          body += chunk;
          if (Buffer.byteLength(body) > 1048576) {
            oversized = true;
            json(413, { error: 'body_too_large' });
          }
        });
        req.on('end', () => {
          if (oversized) return;
          let result: UxpBridgeResult;
          try {
            result = JSON.parse(body) as UxpBridgeResult;
          } catch {
            json(400, { error: 'invalid_json' });
            return;
          }
          const task = result && pending.get(result.id);
          if (!task || !task.delivered || typeof result.ok !== 'boolean') {
            json(400, { error: 'unknown_or_invalid_result' });
            return;
          }
          clearTimeout(task.timer);
          pending.delete(result.id);
          void (async () => {
            // A late reply must not race timeout quarantine or convert failure into success.
            await task.quarantineWork;
            await task.release();
            if (!task.expired) task.resolve(result);
            json(200, { ok: true });
          })().catch(() => {
            task.resolve({
              id: result.id,
              ok: false,
              error: 'outcome_unknown: bridge_cleanup_failed',
            });
            json(500, { error: 'bridge_cleanup_failed' });
          });
        });
        return;
      }
      json(404, { error: 'not_found' });
    });
    s.once('error', (error) => {
      starting = null;
      reject(error);
    });
    // Never silently reroute a fixed-port plugin to another MCP process.
    s.listen(listenPort, '127.0.0.1', () => {
      server = s;
      const address = s.address();
      if (address && typeof address === 'object') listenPort = address.port;
      resolve(listenPort);
    });
  });
  return starting;
}

export async function invokeUxpBridge(
  action: string,
  params: Record<string, unknown>,
  timeoutMs = 60000
): Promise<UxpBridgeResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('invalid_timeout');
  await ensureUxpBridgeServer();
  const id = randomUUID();
  const deadline = Date.now() + timeoutMs;
  const lease = await acquireLease(deadline);
  try {
    await assertSafe();
    if (Date.now() >= deadline) throw new Error('queue_timeout: operation was not dispatched');
  } catch (error) {
    await lease.release();
    throw error;
  }
  return new Promise<UxpBridgeResult>((resolve) => {
    const task: Pending = {
      command: { id, action, params },
      deadline,
      delivered: false,
      expired: false,
      resolve,
      release: lease.release,
      timer: setTimeout(
        () => {
          if (task.delivered) {
            void uncertain(task, 'uxp_bridge_timeout').catch(() => {
              /* Keep the lease if quarantine storage fails. */
            });
          } else {
            pending.delete(id);
            void lease.release().then(
              () => resolve({ id, ok: false, error: 'uxp_queue_timeout' }),
              () => resolve({ id, ok: false, error: 'bridge_cleanup_failed' })
            );
          }
        },
        Math.max(1, deadline - Date.now())
      ),
    };
    pending.set(id, task);
  });
}

export async function shutdownUxpBridgeServer(): Promise<void> {
  if (!server) return;
  for (const [id, task] of pending) {
    clearTimeout(task.timer);
    if (task.delivered) {
      // Retain the lease and pending id: a plugin may still be executing this command.
      // Reopening the bridge can accept its final reply; never claim it was cancelled.
      await uncertain(task, 'bridge_shutdown');
    } else {
      pending.delete(id);
      await task.release();
      task.resolve({ id, ok: false, error: 'bridge_shutdown' });
    }
  }
  const previous = server;
  await new Promise<void>((resolve) => previous.close(() => resolve()));
  server = null;
  starting = null;
  lastPluginPollAt = 0;
}
