import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { artboardMutationGuard } from '../src/core/artboard-guard.js';

it.each([true, false])('rejects artboards before executing a mutation: %s', artboard => {
  let changed = false;
  const context = {
    app: { documents: [{}], activeDocument: { layerSets: [{ id: 9 }] } },
    ActionReference: class { putIdentifier() {} },
    charIDToTypeID: (s: string) => s,
    stringIDToTypeID: (s: string) => s,
    executeActionGet: () => ({ hasKey: () => artboard }),
    mutate: () => { changed = true; },
  };
  const run = () => runInNewContext(artboardMutationGuard + 'mutate();', context);
  if (artboard) expect(run).toThrow('unsupported_artboard_mutation');
  else run();
  expect(changed).toBe(!artboard);
});

it('does not mistake an empty application for an artboard document', () => {
  expect(() => runInNewContext(artboardMutationGuard, { app: { documents: [] } })).not.toThrow();
});
