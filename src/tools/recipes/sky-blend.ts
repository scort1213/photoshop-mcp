import { toAdobePath } from '../../utils/local-path.js';
import { ToolDefinition, ToolResult } from '../../core/tool-registry.js';
import { PhotoshopConnection } from '../../platform/connection.js';
import { cloudDisabledResult } from '../../core/local-policy.js';
import {
  clampInt,
  executeRecipe,
  gradientMaskAxisPercents,
  jsStringLiteral,
  toolFailure,
} from './_shared.js';

const TOOL_NAME = 'photoshop_recipe_sky_blend';

export function bindSkyBlend(connection: PhotoshopConnection): ToolDefinition {
  return {
    tool: {
      name: TOOL_NAME,
      description:
        'One-shot sky composite: places an external sky image, adds a layer mask, and applies a horizon gradient fade. Wrapped in a single undoable history step.\n' +
        '\n' +
        'Users often say: replace sky, fix blown sky, better clouds, swap sky background.\n' +
        '\n' +
        'Use when: the user provides a local sky image for layer-and-mask compositing. This is a manual blend, not the native Sky Replacement algorithm.\n' +
        'Do NOT use when: no sky_image_path is available — ask the user for an absolute file path first.\n' +
        'Do NOT use when: fading the active subject layer only — use photoshop_recipe_gradient_fade.\n' +
        '\n' +
        'Returns: { ok, summary, undo_history_states_consumed, details: { sky_image_path, layer_name, horizon_pct, feather_pct, direction } }.\n' +
        '\n' +
        'Preconditions: active document; sky image file must exist on disk.\n' +
        'Side effects: adds a placed sky layer with gradient mask; one undo reverts everything.',
      inputSchema: {
        type: 'object',
        properties: {
          sky_image_path: {
            type: 'string',
            description: 'Absolute path to the sky image file (JPEG, PNG, etc.)',
          },
          horizon_pct: {
            type: 'number',
            description: 'Document-height percentage where sky meets landscape (0-100, default 50)',
            minimum: 0,
            maximum: 100,
            default: 50,
          },
          feather_pct: {
            type: 'number',
            description: 'Half-width of the transition zone around the horizon (0-50, default 15)',
            minimum: 0,
            maximum: 50,
            default: 15,
          },
          x: {
            type: 'number',
            description: 'Placement X offset in pixels (default 0)',
            default: 0,
          },
          y: {
            type: 'number',
            description: 'Placement Y offset in pixels (default 0)',
            default: 0,
          },
          use_native_sky: {
            type: 'boolean',
            description:
              'Native Sky Replacement is disabled; true is rejected. Omit or use false for local image and mask compositing.',
          },
        },
        required: ['sky_image_path'],
      },
    },
    handler: async (args) => runSkyBlend(connection, args),
  };
}

async function runSkyBlend(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  if (args.use_native_sky === true) return cloudDisabledResult('use_native_sky');
  const skyPath = typeof args.sky_image_path === 'string' ? args.sky_image_path : '';
  if (!skyPath) {
    return toolFailure({
      ok: false,
      code: 'invalid_argument',
      message: 'sky_image_path is required',
    });
  }

  const horizonPct = clampInt(args.horizon_pct, 0, 100, 50);
  const featherPct = clampInt(args.feather_pct, 0, 50, 15);
  const x = typeof args.x === 'number' && Number.isFinite(args.x) ? Math.round(args.x) : 0;
  const y = typeof args.y === 'number' && Number.isFinite(args.y) ? Math.round(args.y) : 0;
  const startPct = Math.max(0, horizonPct - featherPct);
  const endPct = Math.min(100, horizonPct + featherPct);
  const endpoints = gradientMaskAxisPercents('top_to_bottom', startPct, endPct);
  const escapedPath = jsStringLiteral(toAdobePath(skyPath));

  const body = `
    var imageFile = new File(${escapedPath});
    if (!imageFile.exists) {
      return { ok: false, code: 'file_not_found', message: ${jsStringLiteral('Image file not found: ' + skyPath)} };
    }

    app.displayDialogs = DialogModes.NO;

    var placeDesc = new ActionDescriptor();
    placeDesc.putPath(cTID('null'), imageFile);
    placeDesc.putEnumerated(cTID('FTcs'), cTID('QCSt'), cTID('Qcsa'));
    var offsetDesc = new ActionDescriptor();
    offsetDesc.putUnitDouble(cTID('Hrzn'), cTID('#Pxl'), ${x});
    offsetDesc.putUnitDouble(cTID('Vrtc'), cTID('#Pxl'), ${y});
    placeDesc.putObject(cTID('Ofst'), cTID('Ofst'), offsetDesc);
    executeAction(cTID('Plc '), placeDesc, DialogModes.NO);

    var doc = app.activeDocument;
    var skyLayer = doc.activeLayer;
    skyLayer.name = 'Sky Blend';

    var maskCreated = false;
    if (!__mcp_hasLayerMaskAM()) {
      __mcp_makeLayerMaskAtChannel('revealAll');
      maskCreated = true;
    }

    doc.activeLayer = skyLayer;
    __mcp_selectLayerMaskChannel();

    var docW = doc.width.as('px');
    var docH = doc.height.as('px');
    var fromXPx = docW * (${endpoints.fromH} / 100.0);
    var fromYPx = docH * (${endpoints.fromV} / 100.0);
    var toXPx = docW * (${endpoints.toH} / 100.0);
    var toYPx = docH * (${endpoints.toV} / 100.0);
    // Reveal the sky above the horizon and hide it below the horizon.
    __mcp_gradientFillLayerMask(fromXPx, fromYPx, toXPx, toYPx, ${endpoints.reverse ? 'false' : 'true'});

    try {
      doc.activeChannels = doc.componentChannels;
    } catch (eRestore) {
      doc.activeLayer = skyLayer;
    }

    return {
      ok: true,
      summary: 'Sky image placed and blended at horizon (${horizonPct}%)',
      undo_history_states_consumed: 1,
      next_suggested_tool: 'photoshop_get_preview',
      details: {
        sky_image_path: ${jsStringLiteral(skyPath)},
        layer_name: skyLayer.name,
        horizon_pct: ${horizonPct},
        feather_pct: ${featherPct},
        direction: 'top_to_bottom',
        mask_created: maskCreated
      }
    };
  `;

  return executeRecipe(connection, 'Sky Blend', body);
}
