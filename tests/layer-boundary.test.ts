import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { ExtendScriptSnippets, MCP_SMART_OBJECT_HELPERS } from '../src/api/extendscript.js';

it('rejects duplicate names across nested groups before selecting either layer', () => {
  const first = { name: '同名', typename: 'ArtLayer' };
  const second = { name: '同名', typename: 'ArtLayer' };
  const root = { layers: [first, { name: 'group', typename: 'LayerSet', layers: [second] }] };
  expect(() =>
    runInNewContext(MCP_SMART_OBJECT_HELPERS + ';__mcp_findLayer(root,"同名");', { root })
  ).toThrow('ambiguous_name');
});
it('finds a unique nested layer without changing the active layer', () => {
  const layer = { name: '目标', typename: 'ArtLayer' };
  const root = { layers: [{ name: 'group', typename: 'LayerSet', layers: [layer] }] };
  expect(
    runInNewContext(MCP_SMART_OBJECT_HELPERS + ';__mcp_findLayer(root,"目标");', { root })
  ).toBe(layer);
});
it('creates text inside the active group and resolves missing fonts before adding a layer', () => {
  let rootAdds = 0;
  let groupAdds = 0;
  const group = {
    typename: 'LayerSet',
    allLocked: false,
    parent: { typename: 'Document' },
    artLayers: {
      add: () => {
        groupAdds++;
        return { kind: 'normal', textItem: {}, name: 'text' };
      },
    },
  };
  const doc = {
    activeLayer: { typename: 'ArtLayer', parent: group },
    artLayers: {
      add: () => {
        rootAdds++;
        throw new Error('root cannot contain text');
      },
    },
  };
  const app = { documents: [doc], activeDocument: doc, fonts: [] };
  const context = { app, LayerKind: { TEXT: 'text' } };
  const run = (script: string) => runInNewContext('(function(){' + script + '})()', context);
  expect(() => run(ExtendScriptSnippets.createTextLayer('test', 0, 0, 24, 'missing-font'))).toThrow(
    'font_not_found'
  );
  expect(groupAdds).toBe(0);
  const result = run(ExtendScriptSnippets.createTextLayer('中文', 0, 0, 24));
  expect(result.created).toBe(true);
  expect(groupAdds).toBe(1);
  expect(rootAdds).toBe(0);
  expect(result.position).toEqual({ x: 0, y: 0 });
});
