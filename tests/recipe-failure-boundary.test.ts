import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { wrapInStandaloneScript, wrapInSuspendHistory } from '../src/tools/recipes/_shared.js';

it.each(['explicit', 'throw', 'partial-batch'])('propagates %s recipe failure through the bridge error path', failure => {
  const body = failure === 'throw' ? 'throw new Error("failed after edit");'
    : failure === 'explicit' ? 'return {ok:false,code:"bad",message:"failed after edit"};'
    : 'return {ok:true, output_paths:["completed.png"], details:{failed:[{file:"bad.png"}]}};';
  expect(() => runInNewContext('(function(){'+wrapInStandaloneScript(body)+'})()', {}))
    .toThrow('partial_completion');
});

it('does not convert a suspended-history error into a successful bridge completion', () => {
  const context: Record<string, unknown> = {};
  const doc = { suspendHistory: (_name: string, code: string) => runInNewContext(code, context) };
  context.app = { documents: [doc], activeDocument: doc };
  // Execute at script scope so the mock history evaluator shares the variables.
  const script = wrapInSuspendHistory('Test', 'return {ok:false,message:"partial"};')
    .replace('return __mcp_json_stringify(__mcp_recipe_result);', '__mcp_json_stringify(__mcp_recipe_result);');
  expect(() => runInNewContext(script, context)).toThrow('partial_completion');
});
