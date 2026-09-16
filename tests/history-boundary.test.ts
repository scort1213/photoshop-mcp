import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { ExtendScriptSnippets } from '../src/api/extendscript.js';

it.each(['undo', 'redo'] as const)('rejects excess %s without partially moving history', method => {
  const states = [{ name: 'initial' }, { name: 'edit' }, { name: 'last' }];
  const doc = { historyStates: states, activeHistoryState: states[1] };
  expect(() => runInNewContext('(function(){' + ExtendScriptSnippets[method](10) + '})()', {
    app: { documents: [doc], activeDocument: doc },
  })).toThrow('exceed available history');
  expect(doc.activeHistoryState).toBe(states[1]);
});
