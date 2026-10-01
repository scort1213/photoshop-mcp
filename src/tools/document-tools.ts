import { atomicSave } from '../utils/atomic-save.js';
import { extname } from 'node:path';
import { resolveLocalPath } from '../utils/local-path.js';
import { getTargetDocumentId, runWithDocumentId } from '../core/document-target.js';
import { access, managedMutation } from '../platform/operation-safety.js';
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { ExtendScriptSnippets } from '../api/extendscript.js';
import {
  atomicFailure,
  atomicFailureFromError,
  atomicSuccess,
  parseSnippetResult,
  runSnippet,
} from './atomic-shared.js';

export function createDocumentTools(connection: PhotoshopConnection): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'photoshop_create_document',
        description:
          'Create a new empty Photoshop document with specified dimensions and color mode.\n\n' +
          'Use when: starting a design from scratch or no document is open.\n' +
          'Do NOT use when: opening an existing file — use photoshop_open_image.\n\n' +
          'Returns: created document id and name.\n' +
          'Preconditions: none. Side effects: creates a new document and makes it active.',
        inputSchema: {
          type: 'object',
          properties: {
            width: {
              type: 'number',
              description: 'Document width in pixels',
              minimum: 1,
              maximum: 300000,
            },
            height: {
              type: 'number',
              description: 'Document height in pixels',
              minimum: 1,
              maximum: 300000,
            },
            resolution: {
              type: 'number',
              description: 'Document resolution in DPI (default: 72)',
              default: 72,
            },
            colorMode: {
              type: 'string',
              description: 'Color mode (RGB, CMYK, Grayscale)',
              enum: ['RGB', 'CMYK', 'Grayscale'],
              default: 'RGB',
            },
          },
          required: ['width', 'height'],
        },
      },
      handler: async (args) => createDocument(connection, args),
    },
    {
      tool: {
        name: 'photoshop_get_document_info',
        description: 'Get information about the active Photoshop document',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      handler: async () => getDocumentInfo(connection),
    },
    {
      tool: {
        name: 'photoshop_list_documents',
        description:
          'List every open Photoshop document with id, dimensions, and which tab is active (read-only).\n\n' +
          'Use when: multiple documents are open and you need document_id before switching tabs or closing a specific file.\n' +
          'Do NOT use when: you only need the active document — use photoshop_get_document_info or photoshop_get_state.\n\n' +
          'Returns: JSON { ok, summary, details: { count, documents[], active_document_id, context } }.\n' +
          'Preconditions: none (safe when zero documents open). Side effects: none.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      handler: async () => listDocuments(connection),
    },
    {
      tool: {
        name: 'photoshop_set_active_document',
        description:
          'Switch the active document tab by document_id (preferred), zero-based index, or name.\n\n' +
          'Use when: working across multiple open files and mutations must target a specific document.\n' +
          'Do NOT use when: only one document is open — it is already active.\n' +
          'Do NOT use document_name when duplicate names exist — use document_id from photoshop_list_documents.\n\n' +
          'Returns: JSON { ok, summary, details: { activated: { id, name }, context } }.\n' +
          'Preconditions: target document must be open. Provide exactly one of document_id, index, or document_name. Side effects: changes active tab.',
        inputSchema: {
          type: 'object',
          properties: {
            document_id: {
              type: 'number',
              description: 'Unique internal document id from photoshop_list_documents (preferred)',
            },
            index: {
              type: 'number',
              description: 'Zero-based tab order index (leftmost tab is 0)',
              minimum: 0,
            },
            document_name: {
              type: 'string',
              description: 'Document name/title (ambiguous if multiple tabs share the same name)',
            },
          },
        },
      },
      handler: async (args) => setActiveDocument(connection, args),
    },
    {
      tool: {
        name: 'photoshop_save_document',
        description:
          'Save the active document to disk in PSD, JPEG, or PNG format.\n\n' +
          'Use when: user requests export/save with a specific path and format.\n' +
          'Do NOT use when: web-optimized resize+sharpen pipeline is needed — use photoshop_recipe_prepare_for_web.\n\n' +
          'Returns: confirmation with saved path and format.\n' +
          'Preconditions: active document; path required. Side effects: writes file to disk.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Full path where to save the document',
            },
            format: {
              type: 'string',
              description: 'File format (PSD, JPEG, PNG)',
              enum: ['PSD', 'JPEG', 'PNG'],
              default: 'PSD',
            },
            overwrite: {
              type: 'boolean',
              default: false,
              description: 'Explicitly allow replacing an existing output file.',
            },
            quality: {
              type: 'number',
              description: 'Quality for JPEG (1-12, default: 8)',
              minimum: 1,
              maximum: 12,
              default: 8,
            },
          },
          required: ['path'],
        },
      },
      handler: async (args) => saveDocument(connection, args),
    },
    {
      tool: {
        name: 'photoshop_close_document',
        description:
          'With save=true, save a local copy and keep the document open; returns saved=true and closed=false. An existing local filename is reused, otherwise provide path. With save=false, explicitly close without saving. No automatic close or retry follows a save.',
        inputSchema: {
          type: 'object',
          properties: {
            save: {
              type: 'boolean',
              description:
                'true saves a local copy and keeps the document open; false explicitly closes without saving',
              default: false,
            },
            path: {
              type: 'string',
              description:
                'Optional absolute local save path. Required when the document has no usable local filename. PSD, PSB, JPEG, PNG and TIFF supported.',
            },
            overwrite: {
              type: 'boolean',
              default: false,
              description:
                'Allow replacing an explicit path. Saving to the current document filename already implies replacement.',
            },
          },
        },
      },
      handler: async (args) => closeDocument(connection, args),
    },
  ];
}

async function createDocument(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const width = args.width as number;
  const height = args.height as number;
  const resolution = (args.resolution as number) || 72;
  const colorMode = (args.colorMode as string) || 'RGB';

  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const colorModeMap: Record<string, string> = {
      RGB: 'NewDocumentMode.RGB',
      CMYK: 'NewDocumentMode.CMYK',
      Grayscale: 'NewDocumentMode.GRAYSCALE',
    };

    const script = ExtendScriptSnippets.newDocument(
      width,
      height,
      resolution,
      colorModeMap[colorMode] || 'NewDocumentMode.RGB'
    );

    await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Document created: ${width}x${height}px at ${resolution}dpi (${colorMode})`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error creating document: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function listDocuments(connection: PhotoshopConnection): Promise<ToolResult> {
  try {
    const raw = await runSnippet(connection, ExtendScriptSnippets.listDocuments());
    const parsed = parseSnippetResult(raw);
    if (!parsed) {
      return atomicFailureFromError(
        new Error(`Snippet returned unparseable payload: ${String(raw)}`)
      );
    }

    if (parsed.ok === false) {
      return atomicFailure({
        ok: false,
        code: 'extendscript_runtime_error',
        message: String(parsed.message || 'Failed to list documents'),
        suggested_next_tool: 'photoshop_get_state',
      });
    }

    const count = typeof parsed.count === 'number' ? parsed.count : 0;
    const details: Record<string, unknown> = {
      count,
      documents: parsed.documents ?? [],
      active_document_id: parsed.active_document_id ?? null,
    };
    if (parsed.context !== undefined) {
      details.context = parsed.context;
    }

    return atomicSuccess(
      count === 0 ? 'No documents open' : `${count} open document${count === 1 ? '' : 's'}`,
      details,
      count === 0 ? 'photoshop_create_document' : 'photoshop_get_document_info'
    );
  } catch (error) {
    return atomicFailureFromError(error);
  }
}

function countSetActiveIdentifiers(args: Record<string, unknown>): number {
  let count = 0;
  if (args.document_id !== undefined && args.document_id !== null) count++;
  if (args.index !== undefined && args.index !== null) count++;
  if (typeof args.document_name === 'string' && args.document_name.length > 0) count++;
  return count;
}

async function setActiveDocument(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const identifierCount = countSetActiveIdentifiers(args);
  if (identifierCount !== 1) {
    return atomicFailure({
      ok: false,
      code: 'invalid_arguments',
      message:
        'Exactly one of document_id, index, or document_name is required to set the active document',
      suggested_next_tool: 'photoshop_list_documents',
    });
  }

  const params: { documentId?: number; documentName?: string; index?: number } = {};
  if (args.document_id !== undefined && args.document_id !== null) {
    params.documentId = args.document_id as number;
  } else if (args.index !== undefined && args.index !== null) {
    params.index = args.index as number;
  } else {
    params.documentName = args.document_name as string;
  }

  try {
    const raw = await runSnippet(connection, ExtendScriptSnippets.setActiveDocument(params));
    const parsed = parseSnippetResult(raw);
    if (!parsed) {
      return atomicFailureFromError(
        new Error(`Snippet returned unparseable payload: ${String(raw)}`)
      );
    }

    if (parsed.ok === false) {
      const code =
        parsed.code === 'document_not_found' || parsed.code === 'ambiguous_name'
          ? parsed.code
          : 'extendscript_runtime_error';
      return atomicFailure({
        ok: false,
        code,
        message: String(parsed.message || 'Failed to set active document'),
        suggested_next_tool: 'photoshop_list_documents',
        ...(parsed.matching_document_ids
          ? { suggested_args: { matching_document_ids: parsed.matching_document_ids } }
          : {}),
      });
    }

    const activated = parsed.activated as { id?: number; name?: string } | undefined;
    const details: Record<string, unknown> = {};
    if (activated) {
      details.activated = activated;
    }
    if (parsed.context !== undefined) {
      details.context = parsed.context;
    }

    return atomicSuccess(
      activated?.name ? `Active document set to "${activated.name}"` : 'Active document switched',
      details,
      'photoshop_get_document_info'
    );
  } catch (error) {
    return atomicFailureFromError(error);
  }
}

async function getDocumentInfo(connection: PhotoshopConnection): Promise<ToolResult> {
  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.getDocumentInfo();
    const result = await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Document info:\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error getting document info: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function saveDocument(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const path = args.path as string;
  const format = (args.format as string) || 'PSD';
  const quality = (args.quality as number) || 8;

  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    await connection.runTransaction(async () => {
      const metadata = parseSnippetResult(
        await access.run('read', () => api.executeScript(saveTargetMetadataScript()))
      );
      const id = verifiedSaveTargetId(metadata?.id);
      await runWithDocumentId(id, () =>
        atomicSave(path, format.toUpperCase(), args.overwrite === true, async (temporaryPath) => {
          const script =
            format === 'JPEG'
              ? ExtendScriptSnippets.saveAsJPEG(temporaryPath, quality)
              : format === 'PNG'
                ? ExtendScriptSnippets.saveAsPNG(temporaryPath)
                : ExtendScriptSnippets.saveAsPSD(temporaryPath);
          return api.executeScript(script);
        })
      );
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `Document saved as ${format} to: ${path}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error saving document: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

function saveTargetMetadataScript(): string {
  return `
    if (app.documents.length === 0) throw new Error('No active document');
    ${getTargetDocumentId() === undefined ? "if (app.documents.length > 1) throw new Error('ambiguous_document: supply document_id when multiple documents are open');" : ''}
    var doc = app.activeDocument;
    var localPath = null;
    try { localPath = doc.fullName.fsName; } catch (ePath) {}
    return { id: doc.id, path: localPath };
  `;
}

function verifiedSaveTargetId(id: unknown): number {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
    throw new Error('document_not_found: could not verify the document to save');
  return id;
}

async function closeDocument(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const save = args.save === true;
  try {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    if (!save) {
      await api.executeScript(ExtendScriptSnippets.closeDocument(false));
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, saved: false, closed: true }) }],
      };
    }
    return await connection.runTransaction(async () => {
      const metadata = parseSnippetResult(
        await access.run('read', () => api.executeScript(saveTargetMetadataScript()))
      );
      const explicit = typeof args.path === 'string' ? args.path : '';
      const selectedPath = explicit || (typeof metadata?.path === 'string' ? metadata.path : '');
      if (!selectedPath)
        throw new Error(
          'local_path_required: provide path to save a local copy; the document remains open'
        );
      const savedPath = resolveLocalPath(selectedPath);
      let currentPath: string | undefined;
      try {
        if (typeof metadata?.path === 'string' && metadata.path)
          currentPath = resolveLocalPath(metadata.path);
      } catch {
        /* An explicit local copy does not need a remote source destination. */
      }
      const format = (
        {
          '.psd': 'PSD',
          '.psb': 'PSB',
          '.jpg': 'JPEG',
          '.jpeg': 'JPEG',
          '.png': 'PNG',
          '.tif': 'TIFF',
          '.tiff': 'TIFF',
        } as Record<string, string>
      )[extname(savedPath).toLowerCase()];
      if (!format)
        throw new Error(
          'local_path_required: provide a local PSD, PSB, JPEG, PNG or TIFF path; the document remains open'
        );
      const id = verifiedSaveTargetId(metadata?.id);
      await runWithDocumentId(id, () =>
        atomicSave(
          savedPath,
          format,
          !explicit || savedPath === currentPath || args.overwrite === true,
          (temporaryPath) => {
            const script =
              format === 'JPEG'
                ? ExtendScriptSnippets.saveAsJPEG(temporaryPath)
                : format === 'PNG'
                  ? ExtendScriptSnippets.saveAsPNG(temporaryPath)
                  : format === 'PSB'
                    ? ExtendScriptSnippets.saveAsPSB(temporaryPath)
                    : format === 'TIFF'
                      ? ExtendScriptSnippets.saveAsTIFF(temporaryPath)
                      : ExtendScriptSnippets.saveAsPSD(temporaryPath);
            return managedMutation.run('photoshop_save_document', () => api.executeScript(script));
          }
        )
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              saved: true,
              closed: false,
              path: savedPath,
              document_id: id,
              message: 'Local copy saved. The document remains open.',
            }),
          },
        ],
      };
    });
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error saving/closing document: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
