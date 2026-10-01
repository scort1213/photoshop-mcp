import { ToolDefinition, ToolResult } from '../../core/tool-registry.js';
import { PhotoshopConnection } from '../../platform/connection.js';
import { PhotoshopDetector } from '../../platform/detector.js';
import { cloudDisabledResult } from '../../core/local-policy.js';
import { clampInt, executeRecipe, toolFailure } from './_shared.js';

const TOOL_NAME = 'photoshop_recipe_remove_background';

export function bindRemoveBackground(connection: PhotoshopConnection): ToolDefinition {
  return {
    tool: {
      name: TOOL_NAME,
      description:
        'One-shot background removal: Select Subject by default, with an automatic Color Range fallback for uniform/high-key studio backgrounds (product-on-white). Attaches a layer mask (source pixels kept). Wrapped in a single undoable history step.\n' +
        '\n' +
        'Users often say: cut out, isolate subject, remove background, transparent background, arka planı sil.\n' +
        '\n' +
        'Use when: the user wants the subject isolated from the background non-destructively.\n' +
        'Do NOT use when: the subject is extremely fine-edged (hair against a busy background) — propose a manual Refine Edge pass afterwards.\n' +
        '\n' +
        'Returns: { ok, summary, undo_history_states_consumed, details.method = select_subject | color_range_fallback }.\n' +
        '\n' +
        'Preconditions: PS ≥ 23 (Select Subject v2) for the default path; Color Range fallback still runs on uniform studio shots if Select Subject is loose or empty.\n' +
        'Confirm Photoshop Settings/Preferences > Image Processing > Select Subject and Remove Background is set to Device before use; this recipe does not change that setting.\n' +
        'Side effects: attaches a pixel mask to the active layer; no pixels destroyed; one undo reverts everything.',
      inputSchema: {
        type: 'object',
        properties: {
          feather_px: {
            type: 'number',
            description:
              'Edge feather in pixels (0-20). 0 = hard edge (default for product shots), 1-3 = soft edge for portraits.',
            minimum: 0,
            maximum: 20,
            default: 0,
          },
          keep_shadow: {
            type: 'boolean',
            description:
              'Reserved for a future iteration; currently recorded in the response but no shadow layer is created yet.',
            default: false,
          },
          use_generative: {
            type: 'boolean',
            description:
              'Cloud edge cleanup is disabled; true is rejected. Omit or use false for Select Subject and a local mask.',
            default: false,
          },
        },
      },
    },
    handler: async (args) => runRemoveBackground(connection, args),
  };
}

async function runRemoveBackground(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  if (args.use_generative === true) return cloudDisabledResult('use_generative');
  const feather = clampInt(args.feather_px, 0, 20, 0);
  const keepShadow = args.keep_shadow === true;

  await connection.ping().catch(() => undefined);
  const info = connection.getPhotoshopInfo();
  if (info) {
    const detector = new PhotoshopDetector();
    if (!detector.supportsSelectSubjectV2(info.version)) {
      return toolFailure({
        ok: false,
        code: 'version_unsupported',
        message: `Select Subject v2 requires Photoshop 23.0+; detected version ${info.version}. Upgrade Photoshop or remove the background manually.`,
        suggested_next_tool: 'photoshop_get_capabilities',
      });
    }
  }

  const body = `
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    if (layer.isBackgroundLayer) {
      return { ok: false, code: 'no_active_layer', message: 'Active layer is the Background layer — convert it to a normal layer first.', suggested_next_tool: 'photoshop_rasterize_layer' };
    }

    app.displayDialogs = DialogModes.NO;

    function __mcp_sampleRgb(x, y) {
      var sampler = doc.colorSamplers.add([UnitValue(x, 'px'), UnitValue(y, 'px')]);
      try {
        var c = sampler.color.rgb;
        return { r: c.red, g: c.green, b: c.blue };
      } finally {
        sampler.remove();
      }
    }

    function __mcp_detectStudio() {
      var w = doc.width.as('px');
      var h = doc.height.as('px');
      var inset = 5;
      if (w < inset * 2 || h < inset * 2) {
        return { uniform: false, highKey: false, samples: [] };
      }
      var pts = [[inset, inset], [w - inset, inset], [inset, h - inset], [w - inset, h - inset]];
      var samples = [];
      try {
        for (var i = 0; i < pts.length; i++) {
          samples.push(__mcp_sampleRgb(pts[i][0], pts[i][1]));
        }
      } catch (eSample) {
        return { uniform: false, highKey: false, samples: samples };
      }
      var maxDelta = 0;
      var avgL = 0;
      var chroma = 0;
      for (var s = 0; s < samples.length; s++) {
        var lum = 0.2126 * samples[s].r + 0.7152 * samples[s].g + 0.0722 * samples[s].b;
        avgL += lum;
        var mean = (samples[s].r + samples[s].g + samples[s].b) / 3;
        chroma = Math.max(chroma, Math.abs(samples[s].r - mean), Math.abs(samples[s].g - mean), Math.abs(samples[s].b - mean));
        for (var t = s + 1; t < samples.length; t++) {
          maxDelta = Math.max(maxDelta, Math.abs(samples[s].r - samples[t].r), Math.abs(samples[s].g - samples[t].g), Math.abs(samples[s].b - samples[t].b));
        }
      }
      avgL = avgL / samples.length;
      return { uniform: maxDelta <= 18 && chroma <= 12, highKey: avgL >= 230, samples: samples };
    }

    function __mcp_hasSel() {
      try { return doc.selection.bounds != null; } catch (e) { return false; }
    }

    function __mcp_selectionLooksLoose() {
      try {
        var b = doc.selection.bounds;
        var left = b[0].as('px');
        var top = b[1].as('px');
        var right = b[2].as('px');
        var bottom = b[3].as('px');
        var w = doc.width.as('px');
        var h = doc.height.as('px');
        var coverage = ((right - left) * (bottom - top)) / (w * h);
        var touchesEdge = left <= 8 || top <= 8 || right >= w - 8 || bottom >= h - 8;
        return coverage >= 0.55 || touchesEdge;
      } catch (eLoose) {
        return true;
      }
    }

    function __mcp_labColorDesc(sc) {
      var cDesc = new ActionDescriptor();
      cDesc.putDouble(charIDToTypeID('Lmnc'), sc.lab.l);
      cDesc.putDouble(charIDToTypeID('A   '), sc.lab.a);
      cDesc.putDouble(charIDToTypeID('B   '), sc.lab.b);
      return cDesc;
    }

    function __mcp_colorRangeFromRgb(r, g, b, fuzziness) {
      var sc = new SolidColor();
      sc.rgb.red = r;
      sc.rgb.green = g;
      sc.rgb.blue = b;
      var desc = new ActionDescriptor();
      desc.putInteger(charIDToTypeID('Fzns'), fuzziness);
      var lab = __mcp_labColorDesc(sc);
      desc.putObject(charIDToTypeID('Mnm '), charIDToTypeID('LbCl'), lab);
      desc.putObject(charIDToTypeID('Mxm '), charIDToTypeID('LbCl'), __mcp_labColorDesc(sc));
      desc.putInteger(stringIDToTypeID('colorModel'), 0);
      executeAction(charIDToTypeID('ClrR'), desc, DialogModes.NO);
    }

    function __mcp_tryColorRange(samples) {
      if (!samples || samples.length === 0) return false;
      var r = 0, g = 0, b = 0;
      for (var i = 0; i < samples.length; i++) {
        r += samples[i].r; g += samples[i].g; b += samples[i].b;
      }
      r = r / samples.length; g = g / samples.length; b = b / samples.length;
      try { doc.selection.deselect(); } catch (eD) {}
      __mcp_colorRangeFromRgb(r, g, b, 48);
      doc.selection.invert();
      return __mcp_hasSel();
    }

    function __mcp_trySelectSubject() {
      try {
        doc.selection.selectSubject();
        return true;
      } catch (eDomSubject) {}
      try {
        var cutoutDesc = new ActionDescriptor();
        cutoutDesc.putBoolean(stringIDToTypeID('sampleAllLayers'), false);
        executeAction(stringIDToTypeID('autoCutout'), cutoutDesc, DialogModes.NO);
        return true;
      } catch (eSelectSubject) {
        return false;
      }
    }

    var studio = __mcp_detectStudio();
    var method = 'select_subject';
    var subjectOk = __mcp_trySelectSubject();
    var hasSel = subjectOk && __mcp_hasSel();

    var preferColorRange = studio.uniform && (studio.highKey || !hasSel || __mcp_selectionLooksLoose());
    if (preferColorRange) {
      var crOk = false;
      try {
        crOk = __mcp_tryColorRange(studio.samples);
      } catch (eCR) {
        crOk = false;
      }
      if (crOk) {
        method = 'color_range_fallback';
        hasSel = true;
      } else if (!hasSel) {
        subjectOk = __mcp_trySelectSubject();
        hasSel = subjectOk && __mcp_hasSel();
        method = 'select_subject';
      } else {
        try { __mcp_trySelectSubject(); } catch (eRe) {}
        hasSel = __mcp_hasSel();
        method = 'select_subject';
      }
    }

    if (!hasSel) {
      return { ok: false, code: 'selection_required', message: 'Could not isolate the subject (Select Subject empty; Color Range fallback did not produce a selection).', suggested_next_tool: 'photoshop_get_preview' };
    }

    if (${feather} > 0) {
      try { doc.selection.feather(${feather}); } catch (eF) {}
    }

    __mcp_makeLayerMaskRevealSelection();

    var methodLabel = method === 'color_range_fallback' ? 'Color Range (uniform studio fallback)' : 'Select Subject';
    return {
      ok: true,
      summary: 'Background removed via ' + methodLabel + ' + layer mask' + (${feather} > 0 ? ' (feather ' + ${feather} + 'px)' : ''),
      undo_history_states_consumed: 1,
      next_suggested_tool: 'photoshop_get_preview',
      details: {
        feather_px: ${feather},
        keep_shadow: ${keepShadow ? 'true' : 'false'},
        layer_name: layer.name,
        method: method
      }
    };
  `;

  return executeRecipe(connection, 'Remove Background', body);
}
