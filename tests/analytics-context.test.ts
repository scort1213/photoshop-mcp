import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as analytics from '../src/analytics/index.js';

const previousHome = process.env.PHOTOSHOP_MCP_HOME;
let home: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (previousHome === undefined) delete process.env.PHOTOSHOP_MCP_HOME;
  else process.env.PHOTOSHOP_MCP_HOME = previousHome;
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

describe('permanently disabled analytics', () => {
  it('cannot be enabled by old environment variables, provider resets or beta opt-in', async () => {
    home = await mkdtemp(join(tmpdir(), 'psmcp-no-analytics-'));
    process.env.PHOTOSHOP_MCP_HOME = home;
    vi.stubEnv('ANALYTICS_DISABLED', '0');
    vi.stubEnv('POSTHOG_DISABLED', '0');
    vi.stubEnv('RYBBIT_HOST', 'https://must-never-contact.invalid');
    vi.stubEnv('RYBBIT_SITE_ID', 'test-site');
    vi.stubEnv('RYBBIT_API_KEY', 'test-key');
    vi.useFakeTimers();
    const fetch = vi.fn(() => {
      throw new Error('analytics must never use the network');
    });
    vi.stubGlobal('fetch', fetch);

    analytics.ensureAnalyticsIdentity();
    analytics.identifyAnalyticsPerson({ email: 'private@example.invalid' });
    analytics.identifyPhotoshopVersion('27.0');
    analytics.identifyUiModelSelection('anthropic', 'test-model');
    analytics.onMcpClientConnected({ name: 'test-client', version: '1' });
    analytics.startMcpAnalyticsSession();
    analytics.captureMcpPageview();
    analytics.capture('test-event', { prompt: 'private content' });
    analytics.recordMcpToolCall({ toolName: 'test-tool', ok: true, durationMs: 3 });
    analytics.setBetaTelemetryChoice(true);
    analytics.captureBetaChatTurn({
      providerId: 'anthropic',
      model: 'test-model',
      authMethod: 'cli_account',
      userPrompt: 'private prompt',
      assistantText: 'private answer',
      toolNames: ['test-tool'],
    });
    expect(analytics.captureAnalyticsMilestoneOnce('mcp_first_tool_success')).toBe(false);
    analytics.getAnalytics().capture({ name: 'direct-provider-call' });
    analytics.getAnalytics().identify({ private: 'content' });
    analytics.getAnalytics().setPersonOnce({ first_install_at: 'now' });
    await analytics.getAnalytics().flush();
    analytics.resetAnalyticsProvider();
    expect(analytics.getAnalyticsRuntimeConfig()).toEqual({
      enabled: false,
      provider: 'none',
      siteId: '',
      analyticsHost: '',
      distinctId: '',
      betaTelemetryOptIn: false,
      betaTelemetryPromptAnswered: true,
    });
    analytics.captureMcpPageleave(1, 'sigint');
    analytics.onMcpClientDisconnected();
    analytics.endMcpAnalyticsSession('sigint');
    await analytics.shutdownAnalytics();
    await analytics.getAnalytics().shutdown();
    await vi.advanceTimersByTimeAsync(65_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(await readdir(home)).toEqual([]);
  });
});
