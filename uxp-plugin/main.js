/**
 * Photoshop MCP UXP Bridge — polls MCP HTTP server and runs batchPlay commands.
 * Load via Adobe UXP Developer Tools (Add Plugin → uxp-plugin/manifest.json → Load or Load & Watch from ••• menu).
 */
const { entrypoints } = require('uxp');
const photoshop = require('photoshop');
const { action } = photoshop;

const BRIDGE_PORT = 38452;
const BRIDGE_BASE = `http://127.0.0.1:${BRIDGE_PORT}`;

let polling = false;

async function postResult(payload) {
  await fetch(`${BRIDGE_BASE}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function neuralDescriptors(filter, params) {
  const smoothness = params.smoothness ?? 50;
  const blur = params.blur ?? 50;

  switch (filter) {
    case 'skin_smoothing':
      return [
        {
          _obj: 'neuralGalleryFilters',
          neuralGalleryFilters: {
            _obj: 'skinSmoothing',
            smoothness,
            blur,
          },
        },
      ];
    case 'harmonize':
      return [
        {
          _obj: 'neuralGalleryFilters',
          neuralGalleryFilters: {
            _obj: 'harmonization',
          },
        },
      ];
    case 'depth_blur':
      return [
        {
          _obj: 'neuralGalleryFilters',
          neuralGalleryFilters: {
            _obj: 'depthBlur',
          },
        },
      ];
    case 'super_zoom':
      return [
        {
          _obj: 'neuralGalleryFilters',
          neuralGalleryFilters: {
            _obj: 'superZoom',
          },
        },
      ];
    case 'colorize':
      return [
        {
          _obj: 'neuralGalleryFilters',
          neuralGalleryFilters: {
            _obj: 'colorize',
          },
        },
      ];
    default:
      throw new Error(`Unknown neural filter: ${filter}`);
  }
}

async function handleCommand(cmd) {
  const { id, action: cmdAction, params = {} } = cmd;

  try {
    if (cmdAction === 'neural_filter') {
      const checkDeadline = () => {
        if (!Number.isFinite(cmd.deadline) || Date.now() >= cmd.deadline) {
          throw new Error('queue_timeout: command expired before dispatch');
        }
      };
      checkDeadline();
      const descriptors = neuralDescriptors(params.filter, params);
      if (typeof photoshop.core?.executeAsModal !== 'function') {
        throw new Error('version_unsupported: executeAsModal is required');
      }
      const result = await photoshop.core.executeAsModal(
        async () => {
          checkDeadline();
          const documents = Array.from(photoshop.app.documents);
          const requested = params.document_id;
          let target;
          if (requested !== undefined) {
            if (!Number.isSafeInteger(requested) || requested <= 0) {
              throw new Error('invalid_argument: document_id must be a positive safe integer');
            }
            target = documents.find((document) => document.id === requested);
            if (!target) throw new Error('document_not_found: target was closed');
          } else {
            if (documents.length === 0) throw new Error('no_active_document');
            if (documents.length !== 1) throw new Error('ambiguous_document: supply document_id');
            target = documents[0];
          }
          if (photoshop.app.activeDocument?.id !== target.id) {
            checkBatchResult(
              await action.batchPlay(
                [
                  {
                    _obj: 'select',
                    _target: [{ _ref: 'document', _id: target.id }],
                    _options: { dialogOptions: 'dontDisplay' },
                  },
                ],
                { synchronousExecution: true }
              )
            );
          }
          if (photoshop.app.activeDocument?.id !== target.id) {
            throw new Error('document_not_found: target activation could not be verified');
          }
          checkDeadline();
          const data = await action.batchPlay(descriptors, { synchronousExecution: true });
          checkBatchResult(data);
          return { document_id: target.id, result: data };
        },
        { commandName: 'MCP neural filter' }
      );
      await postResult({ id, ok: true, data: result });
      return;
    }

    await postResult({ id, ok: false, error: `unknown_action:${cmdAction}` });
  } catch (error) {
    await postResult({
      id,
      ok: false,
      error: error?.message || String(error),
    });
  }
}

function checkBatchResult(result) {
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error('invalid_result: missing batchPlay result');
  }
  const failure = result.find(
    (item) => item?._obj === 'error' || (typeof item?.result === 'number' && item.result < 0)
  );
  if (failure) throw new Error(failure.message || `Photoshop error ${failure.result}`);
}

async function pollOnce() {
  try {
    const res = await fetch(`${BRIDGE_BASE}/poll?protocol=2`);
    if (res.status === 204) return;
    if (!res.ok) return;
    const cmd = await res.json();
    if (cmd?.id) {
      await handleCommand(cmd);
    }
  } catch {
    // MCP server may not be running yet
  }
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  while (polling) {
    await pollOnce();
    await new Promise((r) => setTimeout(r, 400));
  }
}

entrypoints.setup({
  panels: {
    bridgePanel: {
      show() {
        pollLoop();
      },
      hide() {
        polling = false;
      },
    },
  },
});

pollLoop();
