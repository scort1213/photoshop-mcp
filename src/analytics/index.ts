/** Permanently disabled in the local-only distribution. No IDs, storage, timers or network. */
import { NoopAnalyticsProvider } from './noop.js';
import type { AnalyticsRuntimeConfig, BetaTelemetryState } from './types.js';

const provider = new NoopAnalyticsProvider();

export { getAppVersion } from './app-version.js';
export {
  captureMcpPageleave,
  captureMcpPageview,
  endMcpAnalyticsSession,
  recordMcpToolCall,
  startMcpAnalyticsSession,
} from './mcp-session.js';
export type { McpShutdownReason } from './mcp-session.js';
export type {
  AnalyticsEvent,
  AnalyticsProvider,
  AnalyticsRuntimeConfig,
  BetaTelemetryState,
  UsageSurface,
} from './types.js';

export type AnalyticsMilestone = 'mcp_first_tool_success' | 'mcp_photoshop_first_connected';

export function ensureAnalyticsIdentity(): void {}
export function capture(
  _name: string,
  _properties?: Record<string, unknown>,
  _options?: { insertId?: string }
): void {}
export function identifyAnalyticsPerson(_properties?: Record<string, unknown>): void {}
export function identifyPhotoshopVersion(_version: string): void {}
export function identifyUiModelSelection(_providerId: string, _model: string): void {}
export function onMcpClientConnected(
  _client: { name: string; version: string } | undefined
): void {}
export function onMcpClientDisconnected(): void {}
export function resetAnalyticsProvider(): void {}
export function setBetaTelemetryChoice(_optedIn: boolean): void {}
export function captureBetaChatTurn(_input: {
  providerId: string;
  model: string;
  authMethod: string;
  userPrompt: string;
  assistantText: string;
  assistantReasoning?: string;
  toolNames: string[];
}): void {}
export function captureAnalyticsMilestoneOnce(
  _milestone: AnalyticsMilestone,
  _properties: Record<string, unknown> = {}
): boolean {
  return false;
}
export function getAnalytics(): NoopAnalyticsProvider {
  return provider;
}
export async function shutdownAnalytics(): Promise<void> {}
export function getBetaTelemetryState(): BetaTelemetryState {
  return { betaTelemetryOptIn: false, betaTelemetryPromptAnswered: true };
}
export function getAnalyticsRuntimeConfig(): AnalyticsRuntimeConfig {
  return {
    enabled: false,
    provider: 'none',
    siteId: '',
    analyticsHost: '',
    distinctId: '',
    ...getBetaTelemetryState(),
  };
}
