import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../uxp-plugin/main.js', import.meta.url), 'utf8').replace(
  /\npollLoop\(\);\s*$/,
  '\n'
);

async function command(
  params: Record<string, unknown>,
  options: {
    ids?: number[];
    batchError?: boolean;
    missingModal?: boolean;
    selectionFails?: boolean;
    deadline?: number;
    expireWhileWaiting?: boolean;
  } = {}
) {
  const docs = (options.ids || [11, 22]).map((id) => ({ id }));
  const app = { documents: docs, activeDocument: docs[docs.length - 1] };
  const writes: Array<{ id: number; modal: boolean }> = [];
  const replies: Array<{ ok: boolean; error?: string }> = [];
  let modal = false;
  const cmd = {
    id: 'test',
    action: 'neural_filter',
    deadline: options.deadline ?? Date.now() + 60000,
    params: { filter: 'skin_smoothing', ...params },
  };
  const photoshop = {
    app,
    core: options.missingModal
      ? {}
      : {
          executeAsModal: async (fn: () => unknown) => {
            if (options.expireWhileWaiting) cmd.deadline = 0;
            modal = true;
            try {
              return await fn();
            } finally {
              modal = false;
            }
          },
        },
    action: {
      batchPlay: async (descriptors: Array<{ _obj: string; _target?: Array<{ _id: number }> }>) => {
        if (descriptors[0]._obj === 'select') {
          if (!options.selectionFails)
            app.activeDocument = docs.find((d) => d.id === descriptors[0]._target![0]._id)!;
          return [{}];
        }
        writes.push({ id: app.activeDocument.id, modal });
        return options.batchError
          ? [{ _obj: 'error', result: -25922, message: 'simulated Photoshop failure' }]
          : [{}];
      },
    },
  };
  const context = vm.createContext({
    require: (name: string) => (name === 'photoshop' ? photoshop : { entrypoints: { setup() {} } }),
    fetch: async (_url: string, init: { body: string }) => {
      replies.push(JSON.parse(init.body));
      return { ok: true };
    },
    setTimeout,
    cmd,
  });
  vm.runInContext(source, context);
  await vm.runInContext('handleCommand(cmd)', context);
  return { writes, replies };
}

it('pins the explicit document within modal execution instead of editing the active tab', async () => {
  const result = await command({ document_id: 11 });
  expect(result.writes).toEqual([{ id: 11, modal: true }]);
  expect(result.replies[0].ok).toBe(true);
});
it.each([
  {},
  { document_id: 99 },
  { document_id: 0 },
  { document_id: -1 },
  { document_id: 1.5 },
  { document_id: '11' },
  { document_id: null },
])('rejects ambiguous/stale/invalid target %j without any filter write', async (params) => {
  const result = await command(params);
  expect(result.writes).toEqual([]);
  expect(result.replies[0].ok).toBe(false);
});
it('permits a single unambiguous document without an explicit id', async () => {
  expect((await command({}, { ids: [11] })).writes).toEqual([{ id: 11, modal: true }]);
});
it('reports returned batchPlay error descriptors as failure', async () => {
  const result = await command({ document_id: 11 }, { batchError: true });
  expect(result.replies[0].ok).toBe(false);
  expect(result.replies[0].error).toContain('simulated Photoshop failure');
});
it('refuses execution without the modal API', async () => {
  const result = await command({ document_id: 11 }, { missingModal: true });
  expect(result.writes).toEqual([]);
  expect(result.replies[0].ok).toBe(false);
});
it('checks that document selection actually succeeded before applying a filter', async () => {
  const result = await command({ document_id: 11 }, { selectionFails: true });
  expect(result.writes).toEqual([]);
  expect(result.replies[0].ok).toBe(false);
});
it.each([{ deadline: 0 }, { expireWhileWaiting: true }])(
  'never starts an expired command, including after waiting for modal access',
  async (options) => {
    const result = await command({ document_id: 11 }, options);
    expect(result.writes).toEqual([]);
    expect(result.replies[0].ok).toBe(false);
    expect(result.replies[0].error).toContain('queue_timeout');
  }
);
