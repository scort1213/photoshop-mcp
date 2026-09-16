import { PhotoshopDetector } from './detector.js';
import { isUxpBridgeReachable } from './uxp-bridge-client.js';

export interface ParsedPhotoshopVersion {
  major: number;
  minor: number;
  year?: number;
  raw: string;
}

export interface PhotoshopCapabilities {
  version: string;
  features: {
    select_subject_v2: boolean;
    generative_fill: boolean;
    generative_remove: boolean;
    generative_expand: boolean;
    generative_upscale: boolean;
    sky_replacement_native: boolean;
    neural_filters: boolean;
    uxp_bridge_reachable: boolean;
    execute_as_modal_timeout: boolean;
    uxp_plugin_api: boolean;
  };
}

export function parsePhotoshopVersion(version: string): ParsedPhotoshopVersion {
  const numeric = version.trim().match(/^(\d{1,2})(?:\.(\d+))?(?:\.\d+)*$/);
  if (numeric) return { major: Number(numeric[1]), minor: Number(numeric[2] || 0), raw: version };
  // Marketing years are not runtime versions; report unknown until queried from Adobe.

  return { major: 0, minor: 0, raw: version };
}

export function getPhotoshopCapabilities(version: string): PhotoshopCapabilities {
  const parsed = parsePhotoshopVersion(version);
  const detector = new PhotoshopDetector();

  const major = parsed.major;


  const selectSubjectV2 = major >= 23;
  const generativeFill = major >= 25;
  const generativeRemove = generativeFill;
  const generativeExpand = generativeFill;
  const generativeUpscale = major >= 27;
  const skyReplacementNative = generativeFill;
  const executeAsModal = generativeFill;

  return {
    version,
    features: {
      select_subject_v2: selectSubjectV2,
      generative_fill: generativeFill,
      generative_remove: generativeRemove,
      generative_expand: generativeExpand,
      generative_upscale: generativeUpscale,
      sky_replacement_native: skyReplacementNative,
      neural_filters: false,
      uxp_bridge_reachable: false,
      execute_as_modal_timeout: executeAsModal,
      uxp_plugin_api: major > 0 && detector.supportsUXP(version),
    },
  };
}

/** Merge runtime UXP bridge reachability into version-derived capabilities. */
export async function resolvePhotoshopCapabilities(version: string): Promise<PhotoshopCapabilities> {
  const base = getPhotoshopCapabilities(version);
  const bridgeUp = await isUxpBridgeReachable();
  return {
    ...base,
    features: {
      ...base.features,
      uxp_bridge_reachable: bridgeUp,
      neural_filters: bridgeUp && base.features.uxp_plugin_api,
    },
  };
}
