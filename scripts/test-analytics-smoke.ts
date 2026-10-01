/** Offline verification only; never starts Photoshop, the MCP server or a telemetry client. */
import { strict as assert } from 'node:assert';
import {
  getAnalyticsRuntimeConfig,
  ensureAnalyticsIdentity,
  setBetaTelemetryChoice,
} from '../src/analytics/index.js';

process.env.ANALYTICS_DISABLED = '0';
process.env.RYBBIT_SITE_ID = 'legacy-enable-attempt';
ensureAnalyticsIdentity();
setBetaTelemetryChoice(true);
assert.equal(getAnalyticsRuntimeConfig().enabled, false);
assert.equal(getAnalyticsRuntimeConfig().distinctId, '');
console.log('Analytics remain permanently disabled.');
