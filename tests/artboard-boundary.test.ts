import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { artboardMutationGuard } from '../src/core/artboard-guard.js';
import { PhotoshopAPIFactory } from '../src/api/photoshop-api.js';
import { managedMutation } from '../src/platform/operation-safety.js';
import type { PhotoshopConnection } from '../src/platform/connection.js';

it('leaves non-artboard documents unchanged', () => {
  let changed = false;
  const context = {
    app: { documents: [{}], activeDocument: { layerSets: [{ id: 9 }] } },
    ActionReference: class { putIdentifier() {} },
    charIDToTypeID: (s: string) => s,
    stringIDToTypeID: (s: string) => s,
    executeActionGet: () => ({ hasKey: () => false }),
    mutate: () => { changed = true; },
  };
  const run = () => runInNewContext(artboardMutationGuard + 'mutate();', context);
  run();
  expect(changed).toBe(true);
});

function fixture(initial = true) {
  let autoSize = initial, width = 3394, failRestore = false;
  const writes: boolean[] = [];
  class Ref { kind = ''; putIdentifier(kind: string) { this.kind = kind; } putProperty() {} }
  class Descriptor {
    value = false; object?: Descriptor;
    putReference() {} putBoolean(_key: string, value: boolean) { this.value = value; }
    putObject(_key: string, _type: string, value: Descriptor) { this.object = value; }
  }
  const context = {
    app: { documents: [{}], activeDocument: { id: 1, layerSets: [{ id: 9 }], width: { as: () => width }, height: { as: () => 19252 } } },
    ActionReference: Ref, ActionDescriptor: Descriptor, DialogModes: { NO: 0 },
    charIDToTypeID: (s: string) => s, stringIDToTypeID: (s: string) => s,
    executeActionGet: (r: Ref) => r.kind === 'document'
      ? { getObjectValue: () => ({ getBoolean: () => autoSize }) }
      : { hasKey: () => true, getObjectValue: () => ({ getObjectValue: () => ({ getDouble: () => 100 }) }) },
    executeAction: (_event: string, d: Descriptor) => {
      if (failRestore && d.object!.value) throw new Error('restore failed');
      autoSize = d.object!.value; writes.push(autoSize);
    },
  };
  return { context, writes, size: () => autoSize, resize: () => { width = 123; }, fail: () => { failRestore = true; } };
}

it.each([true, false])('restores original Auto-Size Canvas on success and failure: %s', initial => {
  for (const error of [false, true]) {
    const f = fixture(initial);
    const script = artboardMutationGuard + `try { __mcpArtboardScope.begin(); ${error ? 'throw new Error("body failed");' : ''} __mcpArtboardScope.verify(); } finally { __mcpArtboardScope.restore(); }`;
    if (error) expect(() => runInNewContext(script, f.context)).toThrow('body failed');
    else runInNewContext(script, f.context);
    expect(f.writes).toEqual([false, initial]); expect(f.size()).toBe(initial);
  }
});

it('reports unexpected geometry changes instead of success', () => {
  const f = fixture();
  expect(() => runInNewContext(artboardMutationGuard + '__mcpArtboardScope.begin(); resize(); __mcpArtboardScope.restore(); __mcpArtboardScope.verify();', { ...f.context, resize: f.resize })).toThrow('artboard_geometry_changed');
  expect(f.size()).toBe(true);
});

it('surfaces restoration failures', () => {
  const f = fixture();
  expect(() => runInNewContext(artboardMutationGuard + '__mcpArtboardScope.begin(); fail(); __mcpArtboardScope.restore();', { ...f.context, fail: f.fail })).toThrow('restore failed');
});

it.each([false, true])('restores settings through the production wrapper, body failure=%s', async fails => {
  const f = fixture();
  const context = { ...f.context, app: { ...f.context.app, documents: [f.context.app.activeDocument], preferences: {} },
    Units: { PIXELS: 1 }, TypeUnits: { POINTS: 1 } };
  const connection = { getPhotoshopInfo: () => ({ version: '23.0.0' }), executeScript: async (script: string) => {
    const result = runInNewContext(script, context);
    if (String(result).startsWith('ERROR:')) throw new Error(result);
    return result;
  } } as unknown as PhotoshopConnection;
  const api = await new PhotoshopAPIFactory(connection).createAPI();
  const run = managedMutation.run('photoshop_create_layer', () => api.executeScript(fails ? 'throw new Error("partial body failure");' : 'return "changed";'));
  if (fails) await expect(run).rejects.toThrow('partial body failure');
  else expect(await run).toBe('changed');
  expect(f.size()).toBe(true); expect(f.writes).toEqual([false, true]);
});

it('rejects uncertified artboard operations before changing settings', () => {
  const f = fixture();
  expect(() => runInNewContext('var __mcpArtboardAllowed=false;' + artboardMutationGuard, f.context)).toThrow('unsupported_artboard_mutation');
  expect(f.writes).toEqual([]);
});

it('does not mistake an empty application for an artboard document', () => {
  expect(() => runInNewContext(artboardMutationGuard, { app: { documents: [] } })).not.toThrow();
});
