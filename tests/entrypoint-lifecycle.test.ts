import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  events: [] as string[],
  start: vi.fn<() => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>(),
  getVersion: vi.fn<() => Promise<string | undefined>>(),
  startAnalytics: vi.fn(),
  shutdownAnalytics: vi.fn<() => Promise<void>>(),
  loggerError: vi.fn(),
}));

// The entry point must never construct a real connection, probe Adobe, or read
// runtime state. All asynchronous lifecycle boundaries are controlled below.
vi.mock('../src/core/server.js', () => ({
  PhotoshopMCPServer: class {
    start = runtime.start;
    stop = runtime.stop;
    getPhotoshopVersion = runtime.getVersion;
    isPhotoshopConnected() { return false; }
    getToolCount() { return 1; }
  },
}));
vi.mock('../src/analytics/index.js', () => ({
  capture: vi.fn(),
  captureMcpPageview: vi.fn(),
  endMcpAnalyticsSession: vi.fn(),
  ensureAnalyticsIdentity: vi.fn(),
  getAppVersion: () => '0.0.0-lifecycle-test',
  identifyAnalyticsPerson: vi.fn(),
  onMcpClientDisconnected: vi.fn(),
  shutdownAnalytics: runtime.shutdownAnalytics,
  startMcpAnalyticsSession: runtime.startAnalytics,
}));
vi.mock('../src/utils/logger.js', () => ({
  Logger: class {
    info() {}
    error = runtime.loggerError;
  },
}));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type Listener = (...args: unknown[]) => void;
const signals = new Map<string | symbol, Listener>();
const inputEvents = new Map<string | symbol, Listener>();
const releases: Array<() => void> = [];
let originalExitCode: typeof process.exitCode;
let exit: ReturnType<typeof vi.spyOn<typeof process, 'exit'>>;
let exited: ReturnType<typeof deferred<number | string | undefined>>;

// Let the entry point's fire-and-forget main()/signal handler finish one turn.
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  runtime.events.length = 0;
  signals.clear();
  inputEvents.clear();
  releases.length = 0;
  originalExitCode = process.exitCode;
  exited = deferred<number | string | undefined>();

  runtime.start.mockReset().mockImplementation(async () => {
    runtime.events.push('start');
  });
  runtime.stop.mockReset().mockImplementation(async () => {
    runtime.events.push('stop');
    runtime.events.push('drained');
  });
  runtime.getVersion.mockReset().mockResolvedValue(undefined);
  runtime.shutdownAnalytics.mockReset().mockImplementation(async () => {
    runtime.events.push('analytics-shutdown');
  });

  const processOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    if (event === 'SIGINT' || event === 'SIGTERM') {
      signals.set(event, listener);
      return process;
    }
    return processOn(event, listener);
  });
  const inputOn = process.stdin.on.bind(process.stdin);
  vi.spyOn(process.stdin, 'on').mockImplementation((event, listener) => {
    if (event === 'end') {
      inputEvents.set(event, listener);
      return process.stdin;
    }
    return inputOn(event, listener);
  });
  exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    runtime.events.push(`exit:${code}`);
    exited.resolve(code);
    return undefined as never;
  });
});

afterEach(async () => {
  // Even a failed assertion must release our gates before process.exit is restored.
  for (const release of releases) release();
  await nextTurn();
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

function pendingStop() {
  const drained = deferred();
  releases.push(() => drained.resolve());
  runtime.stop.mockImplementation(async () => {
    runtime.events.push('stop');
    await drained.promise;
    runtime.events.push('drained');
  });
  return drained;
}

function endInput() {
  const listener = inputEvents.get('end');
  expect(listener).toBeTypeOf('function');
  listener!();
}

function signal(name: 'SIGINT' | 'SIGTERM') {
  const listener = signals.get(name);
  expect(listener).toBeTypeOf('function');
  listener!();
}

describe('stdio entry point lifecycle without Adobe', () => {
  it('drains before exit when EOF arrives during delayed startup', async () => {
    const started = deferred();
    releases.push(() => started.resolve());
    runtime.start.mockImplementation(async () => {
      runtime.events.push('start');
      await started.promise;
      runtime.events.push('started');
    });
    const drained = pendingStop();
    await import('../src/index.js');

    endInput();
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(runtime.shutdownAnalytics).not.toHaveBeenCalled();

    started.resolve();
    await nextTurn();
    expect(runtime.getVersion).not.toHaveBeenCalled();
    expect(runtime.startAnalytics).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    drained.resolve();
    await expect(exited.promise).resolves.toBe(0);
    expect(runtime.events).toEqual([
      'start', 'stop', 'started', 'drained', 'analytics-shutdown', 'exit:0',
    ]);
  });

  it('shares one stop and exit across repeated EOF and shutdown signals', async () => {
    const drained = pendingStop();
    await import('../src/index.js');
    await nextTurn();

    endInput();
    signal('SIGTERM');
    endInput();
    signal('SIGINT');
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    drained.resolve();
    await expect(exited.promise).resolves.toBe(0);
    signal('SIGTERM');
    endInput();
    await nextTurn();

    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(runtime.shutdownAnalytics).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('stops and drains a rejected startup before exiting with failure', async () => {
    runtime.start.mockImplementation(async () => {
      runtime.events.push('start-rejected');
      throw new Error('injected startup failure');
    });
    const drained = pendingStop();
    await import('../src/index.js');
    await nextTurn();

    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(runtime.shutdownAnalytics).not.toHaveBeenCalled();
    expect(runtime.getVersion).not.toHaveBeenCalled();
    expect(runtime.startAnalytics).not.toHaveBeenCalled();

    drained.resolve();
    await expect(exited.promise).resolves.toBe(1);
    expect(runtime.events).toEqual([
      'start-rejected', 'stop', 'drained', 'analytics-shutdown', 'exit:1',
    ]);
  });

  it('reports a failed drain without forcing process exit or retrying stop', async () => {
    const error = new Error('injected drain failure');
    runtime.stop.mockImplementation(async () => {
      runtime.events.push('stop-rejected');
      throw error;
    });
    await import('../src/index.js');
    await nextTurn();

    endInput();
    await nextTurn();
    expect(process.exitCode).toBe(1);
    expect(exit).not.toHaveBeenCalled();
    expect(runtime.shutdownAnalytics).not.toHaveBeenCalled();
    expect(runtime.loggerError).toHaveBeenCalledWith(
      'Shutdown did not complete; inspect application and lease state:', error
    );

    signal('SIGTERM');
    endInput();
    await nextTurn();
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });
});
