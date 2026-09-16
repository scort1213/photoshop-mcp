import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { ExtendScriptSnippets } from '../src/api/extendscript.js';
import { gradientAngleCoordinates } from '../src/utils/gradient-angle.js';

it.each([
  [0, [0, 50, 200, 50]],
  [90, [100, 100, 100, 0]],
  [180, [200, 50, 0, 50]],
  [-90, [100, 0, 100, 100]],
  [450, [100, 100, 100, 0]],
] as const)('uses actual pixel endpoints for angle %s', (angle, expected) => {
  let coordinates: number[] = [];
  const doc = { activeLayer: {}, activeChannels: [], width: { as: () => 200 }, height: { as: () => 100 } };
  const helpers = `
    function __mcp_hasLayerMaskAM(){return true;}
    function __mcp_selectLayerMaskChannel(){}
    function __mcp_gradientFillLayerMask(x,y,u,v){record([x,y,u,v]);}
  `;
  runInNewContext('(function(){' + ExtendScriptSnippets.applyGradientMask('bottom_to_top', 0, 100, angle) + helpers + '})()', {
    app: { documents: [doc], activeDocument: doc }, DialogModes: { NO: 0 },
    record: (values: number[]) => { coordinates = values; },
  });
  expect(coordinates).toEqual(expected);
});

it('preserves physical angle on a rectangular document and fractional degrees', () => {
  const context = { docW: 200, docH: 100, fromXPx: 0, fromYPx: 0, toXPx: 0, toYPx: 0 };
  runInNewContext(gradientAngleCoordinates(22.5, 20, 80), context);
  expect((context.toYPx-context.fromYPx)/(context.toXPx-context.fromXPx)).toBeCloseTo(-Math.tan(Math.PI/8));
  expect(context.toXPx+context.fromXPx).toBeCloseTo(200);
  expect(context.toYPx+context.fromYPx).toBeCloseTo(100);
});

it.each([NaN, Infinity, -Infinity])('rejects nonfinite angle %s before generating JSX', angle => {
  expect(() => gradientAngleCoordinates(angle, 0, 100)).toThrow('invalid_arguments');
});
