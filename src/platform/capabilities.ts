
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
    generate_image: boolean;
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

  const major = parsed.major;


  const selectSubjectV2 = major >= 23;
  const executeAsModal = major >= 25;

  return {
    version,
    features: {
      select_subject_v2: selectSubjectV2,
      // Cloud-backed operations are disabled regardless of installed version.
      generative_fill: false,
      generate_image: false,
      generative_remove: false,
      generative_expand: false,
      generative_upscale: false,
      sky_replacement_native: false,
      neural_filters: false,
      uxp_bridge_reachable: false,
      execute_as_modal_timeout: executeAsModal,
      uxp_plugin_api: false,
    },
  };
}

/** Capability reads do not probe or start a Neural Filter bridge in this build. */
export async function resolvePhotoshopCapabilities(version: string): Promise<PhotoshopCapabilities> {
  return getPhotoshopCapabilities(version);
}
