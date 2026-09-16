import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { ExtendScriptSnippets } from '../src/api/extendscript.js';

it.each([false, true])('places at the lowest legal position, background=%s', background => {
  const moves: string[] = [];
  const bottom = { id: 3, isBackgroundLayer: background };
  const selected = { id: 1, name: 'Selected', isBackgroundLayer: false,
    move: (target: unknown, placement: string) => { expect(target).toBe(bottom); moves.push(placement); } };
  const doc = { layers: [selected, { id: 2 }, bottom], activeLayer: selected };
  runInNewContext('(function(){' + ExtendScriptSnippets.moveLayerToBottom() +
    'function getContextInfo(){ return {}; }})()', {
    app: { documents: [doc], activeDocument: doc },
    ElementPlacement: { PLACEBEFORE: 'before', PLACEAFTER: 'after' },
  });
  expect(moves).toEqual([background ? 'before' : 'after']);
});

it('leaves an already bottommost layer in place', () => {
  const selected = { id: 1, name: 'Only', isBackgroundLayer: false,
    move: () => { throw new Error('must not move a layer relative to itself'); } };
  const doc = { layers: [selected], activeLayer: selected };
  expect(() => runInNewContext('(function(){' + ExtendScriptSnippets.moveLayerToBottom() +
    'function getContextInfo(){ return {}; }})()', {
    app: { documents: [doc], activeDocument: doc }, ElementPlacement: {},
  })).not.toThrow();
});
