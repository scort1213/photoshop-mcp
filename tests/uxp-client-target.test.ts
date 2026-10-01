import { expect, it, vi } from 'vitest';
import { runWithDocumentId } from '../src/core/document-target.js';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), start: vi.fn() }));
vi.mock('../src/platform/uxp-bridge-server.js', () => ({
  invokeUxpBridge: mocks.invoke,
  ensureUxpBridgeServer: mocks.start,
}));
import { invokeNeuralFilter } from '../src/platform/uxp-bridge-client.js';

it.each([undefined, 42])('refuses Neural Filters before starting or invoking a bridge (target=%s)', async id => {
  const result = await runWithDocumentId(id, () => invokeNeuralFilter('colorize'));
  expect(result.ok).toBe(false);
  expect(result.error).toContain('cloud_disabled');
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
});
