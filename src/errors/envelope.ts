import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { recordMcpToolCall } from '../analytics/mcp-session.js';
import type { ToolHandler } from '../core/tool-registry.js';

export type PhotoshopErrorCode =
  | 'no_active_document'
  | 'no_active_layer'
  | 'layer_not_found'
  | 'document_not_found'
  | 'ambiguous_name'
  | 'invalid_arguments'
  | 'selection_required'
  | 'version_unsupported'
  | 'generative_unavailable'
  | 'generative_timeout'
  | 'generative_credits_exhausted'
  | 'generative_no_selection'
  | 'uxp_bridge_unavailable'
  | 'extendscript_runtime_error'
  | 'file_not_found'
  | 'font_not_found'
  | 'unsupported_color_mode'
  | 'no_base_layer_below'
  | 'not_clipping'
  | 'outcome_unknown'
  | 'queue_timeout'
  | 'application_busy'
  | 'ambiguous_document'
  | 'unknown';

export interface PhotoshopErrorEnvelope {
  ok: false;
  code: PhotoshopErrorCode;
  message: string;
  suggested_next_tool?: string;
  suggested_args?: Record<string, unknown>;
}

const ERROR_PATTERNS: Array<{
  pattern: RegExp;
  code: PhotoshopErrorCode;
  suggested_next_tool?: string;
}> = [
  { pattern: /ambiguous_name/i, code: 'ambiguous_name', suggested_next_tool: 'photoshop_get_layers' },
  { pattern: /outcome_unknown/i, code: 'outcome_unknown', suggested_next_tool: 'photoshop_get_state' },
  { pattern: /queue_timeout/i, code: 'queue_timeout' },
  { pattern: /application_busy/i, code: 'application_busy', suggested_next_tool: 'photoshop_get_state' },
  { pattern: /ambiguous_document/i, code: 'ambiguous_document', suggested_next_tool: 'photoshop_list_documents' },
  { pattern: /invalid_argument/i, code: 'invalid_arguments' },
  { pattern: /document_not_found/i, code: 'document_not_found', suggested_next_tool: 'photoshop_list_documents' },
  { pattern: /no active document/i, code: 'no_active_document', suggested_next_tool: 'photoshop_get_state' },
  { pattern: /no documents/i, code: 'no_active_document', suggested_next_tool: 'photoshop_get_state' },
  { pattern: /no active layer/i, code: 'no_active_layer', suggested_next_tool: 'photoshop_get_layers' },
  { pattern: /layer not found/i, code: 'layer_not_found', suggested_next_tool: 'photoshop_get_layers' },
  { pattern: /no base layer below|nothing to clip into/i, code: 'no_base_layer_below', suggested_next_tool: 'photoshop_get_layers' },
  { pattern: /not clipping|not a clipping mask/i, code: 'not_clipping', suggested_next_tool: 'photoshop_get_layers' },
  { pattern: /selection/i, code: 'selection_required', suggested_next_tool: 'photoshop_get_state' },
  { pattern: /version_unsupported|not supported.*version/i, code: 'version_unsupported', suggested_next_tool: 'photoshop_get_capabilities' },
  { pattern: /generative.*credit|quota|sign in/i, code: 'generative_credits_exhausted', suggested_next_tool: 'photoshop_get_capabilities' },
  { pattern: /generative.*timeout|timed out/i, code: 'generative_timeout', suggested_next_tool: 'photoshop_get_preview' },
  { pattern: /generative_no_selection|selection required for generative/i, code: 'generative_no_selection', suggested_next_tool: 'photoshop_select_rectangle' },
  { pattern: /uxp.?bridge|neural filter.*bridge/i, code: 'uxp_bridge_unavailable', suggested_next_tool: 'photoshop_get_capabilities' },
  { pattern: /generative/i, code: 'generative_unavailable', suggested_next_tool: 'photoshop_get_capabilities' },
  { pattern: /font_not_found/i, code: 'font_not_found', suggested_next_tool: 'photoshop_list_fonts' },
  { pattern: /file not found|does not exist/i, code: 'file_not_found' },
  { pattern: /color mode/i, code: 'unsupported_color_mode', suggested_next_tool: 'photoshop_get_document_info' },
];

export function classifyError(message: string): PhotoshopErrorEnvelope {
  for (const { pattern, code, suggested_next_tool } of ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return {
        ok: false,
        code,
        message,
        ...(suggested_next_tool ? { suggested_next_tool } : {}),
      };
    }
  }

  return {
    ok: false,
    code: message.includes('ERROR:') ? 'extendscript_runtime_error' : 'unknown',
    message,
    suggested_next_tool: 'photoshop_get_state',
  };
}

export function envelopeToToolResult(envelope: PhotoshopErrorEnvelope): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    isError: true,
  };
}

export function enrichErrorResult(result: CallToolResult): CallToolResult {
  const text = result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

  if (!text) return result;

  try {
    const parsed = JSON.parse(text) as { ok?: boolean; code?: string };
    if (parsed.ok === false && parsed.code) return result;
  } catch {
    // not JSON — classify plain error text
  }

  if (text.startsWith('Error:') || text.toLowerCase().includes('error')) {
    const message = text.replace(/^Error:\s*/i, '').trim();
    return envelopeToToolResult(classifyError(message));
  }

  return result;
}

export function buildEnvelopeFromError(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return envelopeToToolResult(classifyError(message));
}

function extractErrorCodeFromResult(result: CallToolResult): string {
  const text = result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

  if (!text) return 'unknown';

  try {
    const parsed = JSON.parse(text) as { ok?: boolean; code?: string };
    if (parsed.ok === false && parsed.code) return parsed.code;
  } catch {
    // not JSON — fall through
  }

  return 'unknown';
}

export function wrapToolHandler(toolName: string, handler: ToolHandler): ToolHandler {
  return async (args) => {
    const started = Date.now();
    try {
      let result = await handler(args);
      if (result.isError) {
        result = enrichErrorResult(result);
      }

      const ok = !result.isError;
      recordMcpToolCall({
        toolName,
        ok,
        errorCode: ok ? undefined : extractErrorCodeFromResult(result),
        durationMs: Date.now() - started,
      });

      return result;
    } catch (error) {
      const result = buildEnvelopeFromError(error);
      recordMcpToolCall({
        toolName,
        ok: false,
        errorCode: extractErrorCodeFromResult(result),
        durationMs: Date.now() - started,
      });
      return result;
    }
  };
}
