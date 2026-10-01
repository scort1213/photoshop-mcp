/**
 * Client for the MCP-hosted UXP bridge (health check + neural filter invoke).
 */
import { ensureUxpBridgeServer } from './uxp-bridge-server.js';

const HEALTH_TIMEOUT_MS = 800;

export async function isUxpBridgeReachable(): Promise<boolean> {
  try {
    const port = await ensureUxpBridgeServer();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; pluginConnected?: boolean };
    return body.ok === true && body.pluginConnected === true;
  } catch {
    return false;
  }
}

export type NeuralFilterKind =
  'skin_smoothing' | 'harmonize' | 'depth_blur' | 'super_zoom' | 'colorize';

export interface NeuralFilterParams {
  smoothness?: number;
  blur?: number;
  reference_layer_id?: number;
}

export async function invokeNeuralFilter(
  _filter: NeuralFilterKind,
  _params: NeuralFilterParams = {}
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return { ok: false, error: 'cloud_disabled: Neural Filters are disabled in this local build' };
}
