import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connection = vi.hoisted(() => ({
  ping: vi.fn<() => Promise<boolean>>(),
  getVersion: vi.fn<() => Promise<string>>(),
}));

// Isolate every Adobe entry point: these tests exercise Session, not Photoshop.
vi.mock('../src/platform/connection.js', () => ({
  PhotoshopConnection: class {
    ping = connection.ping;
    getVersion = connection.getVersion;
  },
}));
vi.mock('../src/analytics/index.js', () => ({
  capture: vi.fn(),
  captureAnalyticsMilestoneOnce: vi.fn(),
  identifyPhotoshopVersion: vi.fn(),
}));
vi.mock('../src/utils/logger.js', () => ({
  Logger: class {
    info() {}
    debug() {}
    warn() {}
    error() {}
  },
}));

import { Session } from '../src/core/session.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  connection.ping.mockReset().mockResolvedValue(true);
  connection.getVersion.mockReset().mockResolvedValue('27.1.2');
});
afterEach(() => vi.restoreAllMocks());

describe('Session lifecycle without Adobe', () => {
  it('connects successfully without launching a background version query', async () => {
    const session = new Session();
    await session.initialize();
    await Promise.resolve();

    expect(session.getConnectionStatus()).toBe(true);
    expect(connection.ping).toHaveBeenCalledTimes(1);
    expect(connection.getVersion).not.toHaveBeenCalled();
    await session.disconnect();
    expect(session.getConnectionStatus()).toBe(false);
  });

  it('waits for a pending ping while refusing its late connection success', async () => {
    const entered = deferred();
    const finishPing = deferred<boolean>();
    connection.ping.mockImplementation(() => {
      entered.resolve();
      return finishPing.promise;
    });
    const session = new Session();
    const connecting = session.connect();
    await entered.promise;
    const disconnecting = session.disconnect();
    let disconnected = false;
    void disconnecting.then(() => { disconnected = true; });

    try {
      expect(session.disconnect()).toBe(disconnecting);
      await Promise.resolve();
      expect(disconnected).toBe(false);
      expect(session.getConnectionStatus()).toBe(false);
      await expect(session.connect()).resolves.toBe(false);
      await expect(session.reconnect()).resolves.toBe(false);
      expect(connection.ping).toHaveBeenCalledTimes(1);
    } finally {
      finishPing.resolve(true);
      await disconnecting;
    }

    await expect(connecting).resolves.toBe(false);
    expect(disconnected).toBe(true);
    expect(session.getConnectionStatus()).toBe(false);
    expect(connection.getVersion).not.toHaveBeenCalled();
  });

  it.each(['before connect', 'before ping'] as const)(
    'blocks unstarted Adobe work when disconnect happens %s',
    async (timing) => {
      const session = new Session();
      const connecting = timing === 'before ping' ? session.connect() : undefined;
      const disconnecting = session.disconnect();

      await expect(connecting ?? session.connect()).resolves.toBe(false);
      await disconnecting;
      await session.initialize();
      await expect(session.reconnect()).resolves.toBe(false);

      expect(session.getConnectionStatus()).toBe(false);
      expect(connection.ping).not.toHaveBeenCalled();
      expect(connection.getVersion).not.toHaveBeenCalled();
    }
  );
});
