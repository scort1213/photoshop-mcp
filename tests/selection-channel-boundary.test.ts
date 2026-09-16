import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { ExtendScriptSnippets, MCP_LAYER_MASK_HELPERS } from '../src/api/extendscript.js';

it.each([false, true])('restores component channels after saving a selection, store failure=%s', fails => {
  const rgb = [{ name: 'RGB' }];
  const alpha = { name: '', kind: 0 };
  const doc = { activeChannels: rgb,
    channels: { add: () => { doc.activeChannels = [alpha]; return alpha; } },
    selection: { store: () => { if (fails) throw new Error('store failed'); } },
  };
  const run = () => runInNewContext('(function(){' + ExtendScriptSnippets.saveSelection('中文 "选择"') +
    'function __mcp_requireSelection(){return null;} function getContextInfo(){return {};}})()', {
    app: { documents: [doc], activeDocument: doc }, ChannelType: { SELECTEDAREA: 1 }, SelectionType: { REPLACE: 1 },
  });
  if (fails) expect(run).toThrow('store failed'); else run();
  expect(doc.activeChannels).toBe(rgb);
  expect(alpha.name).toBe('中文 "选择"');
});

it('selects the layer-mask channel explicitly instead of reselecting the current RGB channel', () => {
  const refs: unknown[][] = [];
  runInNewContext(MCP_LAYER_MASK_HELPERS + '__mcp_selectLayerMaskChannel();', {
    cTID: (v: string) => v,
    ActionReference: class { putEnumerated(...args: unknown[]) { refs.push(args); } },
    ActionDescriptor: class { putReference() {} putBoolean() {} },
    executeAction() {}, DialogModes: { NO: 0 },
  });
  expect(refs).toEqual([['Chnl', 'Chnl', 'Msk ']]);
});

it.each([false, true])('restores channels after gradient painting, painting failure=%s', fails => {
  const rgb = [{ name: 'RGB' }];
  const doc = { activeLayer: {}, activeChannels: rgb, width: { as: () => 128 }, height: { as: () => 96 } };
  let selected = false, made = 0;
  const helpers = `
    function __mcp_hasLayerMaskAM(){return false;}
    function __mcp_makeLayerMaskAtChannel(){make();}
    function __mcp_selectLayerMaskChannel(){select();}
    function __mcp_gradientFillLayerMask(){paint();}
  `;
  const run = () => runInNewContext('(function(){' +
    ExtendScriptSnippets.applyGradientMask('left_to_right', 0, 100, undefined, true) + helpers + '})()', {
    app: { documents: [doc], activeDocument: doc }, DialogModes: { NO: 0 },
    make: () => { made++; },
    select: () => { selected = true; doc.activeChannels = [{ name: 'Mask' }]; },
    paint: () => { expect(selected).toBe(true); if (fails) throw new Error('paint failed'); },
  });
  if (fails) expect(run).toThrow('paint failed'); else run();
  expect(made).toBe(1);
  expect(doc.activeChannels).toBe(rgb);
});
