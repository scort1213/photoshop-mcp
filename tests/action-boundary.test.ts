import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { ExtendScriptSnippets } from '../src/api/extendscript.js';
it('roundtrips quotes and Unicode action names without breaking JSX', () => {
  const name="中文 'action' \"quoted\"\nnext", set="set's 中文";
  const calls: string[][]=[];
  const result=runInNewContext('(function(){'+ExtendScriptSnippets.playAction(name,set)+'})()', {
    app:{doAction:(a:string,b:string)=>calls.push([a,b])},
  });
  expect(calls).toEqual([[name,set]]);expect(result).toEqual({action:name,set});
});
