import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { WindowsExecutor } from '../src/platform/windows-executor.js';
import { PhotoshopAPIFactory } from '../src/api/photoshop-api.js';
import type { PhotoshopConnection } from '../src/platform/connection.js';
import { runWithDocumentId } from '../src/core/document-target.js';
import { assertSafe } from '../src/platform/operation-safety.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ps-preflight-unit-'));
  process.env.PHOTOSHOP_SAFETY_DIR = directory;
});
afterEach(async () => {
  delete process.env.PHOTOSHOP_SAFETY_DIR;
  await rm(directory, { recursive: true, force: true });
});

async function setup() {
  const documents = [{ id: 1 }, { id: 2 }];
  const context = {
    app: { documents, activeDocument: documents[1], preferences: {}, displayDialogs: 1 },
    Units: { PIXELS: 1 },
    TypeUnits: { POINTS: 1 },
    DialogModes: { NO: 0 },
    writes: 0,
  };
  class VMAdobe extends WindowsExecutor {
    protected override async executeScript(
      script: string,
      _onChild: (pid: number) => Promise<void>,
      beforeDispatch: () => void
    ): Promise<unknown> {
      beforeDispatch();
      const result = runInNewContext(script, context);
      if (typeof result === 'string' && result.startsWith('ERROR:'))
        throw new Error(result.slice(6));
      return result;
    }
  }
  const executor = new VMAdobe();
  const connection = {
    getPhotoshopInfo: () => ({ version: '23.0.0' }),
    executeScript: (script: string) => executor.execute(script),
  } as unknown as PhotoshopConnection;
  return { context, executor, api: await new PhotoshopAPIFactory(connection).createAPI() };
}

it.each([undefined, 999])(
  'rejects target %s before editing without poisoning the shared write state',
  async (target) => {
    const { context, api } = await setup();
    await expect(
      runWithDocumentId(target, () => api.executeScript('writes++; return "changed";'))
    ).rejects.toThrow(target === undefined ? 'ambiguous_document' : 'document_not_found');
    expect(context.writes).toBe(0);
    await expect(assertSafe()).resolves.toBeUndefined();
    expect(await runWithDocumentId(1, () => api.executeScript('writes++; return "changed";'))).toBe(
      'changed'
    );
    expect(context.writes).toBe(1);
  }
);

it('keeps a body failure quarantined even when its text resembles a preflight error', async () => {
  const { context, api } = await setup();
  await expect(
    runWithDocumentId(1, () =>
      api.executeScript('writes++; throw new Error("ambiguous_document: body failed");')
    )
  ).rejects.toThrow('body failed');
  expect(context.writes).toBe(1);
  await expect(assertSafe()).rejects.toThrow('outcome_unknown');
});

it('does not quarantine a transaction rejected by a definite preflight marker', async () => {
  const { context, executor, api } = await setup();
  await expect(
    executor.runTransaction(() => api.executeScript('writes++; return "changed";'))
  ).rejects.toThrow('ambiguous_document');
  expect(context.writes).toBe(0);
  await expect(assertSafe()).resolves.toBeUndefined();
});

it('a read preflight rejection never clears a transaction with an earlier completed write', async () => {
  const { context, executor, api } = await setup();
  await expect(
    executor.runTransaction(async () => {
      await runWithDocumentId(1, () => api.executeScript('writes++; return "changed";'));
      const { access } = await import('../src/platform/operation-safety.js');
      return access.run('read', () =>
        runWithDocumentId(999, () => api.executeScript('return "state";'))
      );
    })
  ).rejects.toThrow('document_not_found');
  expect(context.writes).toBe(1);
  await expect(assertSafe()).rejects.toThrow('outcome_unknown');
});
