/** Compatibility hooks only: the local-only distribution never records a session. */
export type McpShutdownReason = 'sigint' | 'sigterm' | 'error' | 'stdio_closed';
export type McpToolBatchFlushReason = 'debounce' | 'max_hold' | 'shutdown' | 'client_disconnect';

export function captureMcpPageview(): void {}
export function captureMcpPageleave(_durationMs: number, _reason: string): void {}
export function startMcpAnalyticsSession(): void {}
export function endMcpAnalyticsSession(_reason: McpShutdownReason): void {}
export function flushMcpToolBatch(_reason: McpToolBatchFlushReason): void {}
export function flushMcpToolBatchOnClientDisconnect(): void {}
export function recordMcpToolCall(_params: {
  toolName: string;
  ok: boolean;
  errorCode?: string;
  durationMs: number;
}): void {}
