#!/usr/bin/env node

import {
  capture,
  captureMcpPageview,
  endMcpAnalyticsSession,
  ensureAnalyticsIdentity,
  getAppVersion,
  identifyAnalyticsPerson,
  onMcpClientDisconnected,
  shutdownAnalytics,
  startMcpAnalyticsSession,
} from './analytics/index.js';
import type { McpShutdownReason } from './analytics/mcp-session.js';
import { PhotoshopMCPServer } from './core/server.js';
import { Logger } from './utils/logger.js';

const logger = new Logger('Main');

let mcpServer: PhotoshopMCPServer | null = null;
let shuttingDown = false;
let shutdownPromise: Promise<void> | undefined;
let shutdownExitCode = 0;

async function main() {
  try {
    logger.info('Starting Photoshop MCP Server...');

    ensureAnalyticsIdentity();

    mcpServer = new PhotoshopMCPServer({ serverVersion: getAppVersion() });
    await mcpServer.start();
    if (shuttingDown) return;

    const photoshopVersion = await mcpServer.getPhotoshopVersion();
    if (shuttingDown) return;
    identifyAnalyticsPerson({
      usage_surface: 'mcp',
      event_source: 'mcp',
      ...(photoshopVersion ? { photoshop_version: photoshopVersion } : {}),
    });

    startMcpAnalyticsSession();
    captureMcpPageview();
    capture('mcp_session_started', {
      photoshop_detected: mcpServer.isPhotoshopConnected(),
      tools_registered_count: mcpServer.getToolCount(),
      event_source: 'mcp',
    });

    logger.info('Photoshop MCP Server is running');
  } catch (error) {
    logger.error('Failed to start server:', error);
    capture('mcp_session_startup_failed', {
      ok: false,
      error_code: 'startup_failed',
      event_source: 'mcp',
    });
    await handleShutdown('error', 1);
  }
}

function handleShutdown(signal: string, exitCode = 0): Promise<void> {
  if (exitCode !== 0) shutdownExitCode = exitCode;
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = finishShutdown(signal);
  return shutdownPromise;
}

async function finishShutdown(signal: string): Promise<void> {

  logger.info(`Received ${signal}, shutting down`);

  const reason: McpShutdownReason =
    signal === 'SIGTERM'
      ? 'sigterm'
      : signal === 'stdio_closed'
        ? 'stdio_closed'
        : signal === 'SIGINT'
          ? 'sigint'
          : 'error';

  try {
    if (mcpServer) {
      await mcpServer.stop();
      mcpServer = null;
    }

    onMcpClientDisconnected();
    endMcpAnalyticsSession(reason);
    await shutdownAnalytics();
  } catch (error) {
    // A failed drain is not permission to force an exit while Adobe may still
    // be running. Preserve state and report failure; never kill the bridge.
    process.exitCode = 1;
    logger.error('Shutdown did not complete; inspect application and lease state:', error);
    return;
  }
  process.exit(shutdownExitCode);
}

process.on('SIGINT', () => {
  void handleShutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void handleShutdown('SIGTERM');
});

process.stdin.on('end', () => {
  void handleShutdown('stdio_closed');
});

main();
