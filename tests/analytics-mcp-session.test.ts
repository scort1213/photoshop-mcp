import { afterEach, describe, expect, it, vi } from 'vitest';
import * as session from '../src/analytics/mcp-session.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('inert MCP session compatibility hooks', () => {
  it('never schedules batch flushes even when legacy environment settings enable analytics', async () => {
    vi.stubEnv('ANALYTICS_DISABLED', '0');
    vi.useFakeTimers();
    session.startMcpAnalyticsSession();
    session.captureMcpPageview();
    session.recordMcpToolCall({
      toolName: 'photoshop_get_state',
      ok: false,
      errorCode: 'test',
      durationMs: 1,
    });
    session.flushMcpToolBatch('debounce');
    session.flushMcpToolBatchOnClientDisconnect();
    session.captureMcpPageleave(1, 'sigint');
    session.endMcpAnalyticsSession('sigint');
    await vi.advanceTimersByTimeAsync(65_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
