import type { ToolResult } from './tool-registry.js';

/** Fixed cloud operations are unavailable in this local build. No environment override. */
export const CLOUD_DISABLED_TOOLS = new Set([
  'photoshop_generative_fill',
  'photoshop_generative_remove',
  'photoshop_generative_expand',
  'photoshop_generative_upscale',
  'photoshop_generate_image',
  'photoshop_neural_filter',
  'photoshop_sky_replacement',
]);

export function cloudDisabledResult(operation: string): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({
      ok: false,
      code: 'cloud_disabled',
      message: `${operation} is disabled in this local build. Use ordinary local Photoshop editing tools.`,
    }) }],
  };
}

export function disabledCloudOption(toolName: string, args: Record<string, unknown>): ToolResult | null {
  const option = ({
    photoshop_recipe_remove_distraction: 'use_generative',
    photoshop_recipe_remove_background: 'use_generative',
    photoshop_recipe_enhance_portrait: 'use_neural_skin',
    photoshop_recipe_sky_blend: 'use_native_sky',
  } as Record<string, string>)[toolName];
  return option && args[option] === true ? cloudDisabledResult(option) : null;
}
