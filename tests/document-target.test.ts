import { describe, expect, it } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  DOCUMENT_ID_SCHEMA_EXCLUDES,
  documentGuardScript,
  parseDocumentIdArg,
  withOptionalDocumentId,
} from '../src/core/document-target.js';

function fakeTool(name: string, properties: Record<string, unknown> = {}): Tool {
  return {
    name,
    description: 'test',
    inputSchema: { type: 'object', properties },
  };
}

describe('withOptionalDocumentId', () => {
  it('injects document_id on mutating tools', () => {
    const next = withOptionalDocumentId(fakeTool('photoshop_delete_layer'));
    const schema = next.inputSchema as { properties: Record<string, { type: string }> };
    expect(schema.properties.document_id.type).toBe('integer');
  });

  it('does not inject on excluded tools', () => {
    for (const name of DOCUMENT_ID_SCHEMA_EXCLUDES) {
      const next = withOptionalDocumentId(fakeTool(name));
      const schema = next.inputSchema as { properties: Record<string, unknown> };
      expect(schema.properties.document_id).toBeUndefined();
    }
  });

  it('does not overwrite an existing document_id property', () => {
    const next = withOptionalDocumentId(
      fakeTool('photoshop_export_layers', {
        document_id: { type: 'string', description: 'already there' },
      })
    );
    const schema = next.inputSchema as { properties: Record<string, { type: string }> };
    expect(schema.properties.document_id.type).toBe('string');
  });
});

describe('parseDocumentIdArg', () => {
  it.each([12.9, -1, 0, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '1'])('rejects invalid document id %s', (document_id) => { expect(() => parseDocumentIdArg({ document_id })).toThrow('invalid_argument'); });
  it('accepts a positive integer', () => { expect(parseDocumentIdArg({ document_id: 12 })).toBe(12); });

  it('rejects non-numbers', () => {
    expect(parseDocumentIdArg({})).toBeUndefined();
    expect(() => parseDocumentIdArg({ document_id: '1' })).toThrow('invalid_argument');
  });
});

describe('documentGuardScript', () => {
  it('embeds the numeric id and document_not_found error', () => {
    const script = documentGuardScript(42);
    expect(script).toContain('var __mcp_targetDocId = 42;');
    expect(script).toContain('document_not_found');
  });
});
