import { expect, it, vi } from 'vitest';
import { runWithDocumentId } from '../src/core/document-target.js';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => ({ id: 'test', ok: true })) }));
vi.mock('../src/platform/uxp-bridge-server.js', () => ({
  invokeUxpBridge: mocks.invoke,
  ensureUxpBridgeServer: vi.fn(),
}));
import { invokeNeuralFilter } from '../src/platform/uxp-bridge-client.js';
it('carries the scoped target across the UXP transport', async () => {
  await runWithDocumentId(42, () => invokeNeuralFilter('colorize'));
  expect(mocks.invoke).toHaveBeenLastCalledWith(
    'neural_filter',
    { filter: 'colorize', document_id: 42 },
    90000
  );
});
it('leaves single-document resolution to the guarded plugin when no id was supplied', async () => {
  await invokeNeuralFilter('colorize');
  expect(mocks.invoke).toHaveBeenLastCalledWith('neural_filter', { filter: 'colorize' }, 90000);
});
