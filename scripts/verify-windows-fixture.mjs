/**
 * Real Photoshop acceptance on ONE private PSD copy. Build this checkout first.
 * node scripts/verify-windows-fixture.mjs --source C:\\assets\\source.psd --output D:\\private\\new-run
 * Optional: --no-preview. The output directory must not exist. Do not publish it.
 * Never closes existing documents or recovers/retries an uncertain operation.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, createReadStream, appendFileSync } from 'node:fs';
import { access, copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { freemem } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_TEXT = 'Windows MCP 中文改字验收';
const LOG_LIMIT = 64 * 1024;
const STDERR_LIMIT = 16 * 1024;
const REQUEST_TIMEOUT = 150000;
const usage = 'Usage: node scripts/verify-windows-fixture.mjs --source ABSOLUTE.psd --output ABSOLUTE_NEW_DIRECTORY [--no-preview]';

function options(argv) {
  const parsed = { preview: true };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--no-preview') parsed.preview = false;
    else if (key === '--source' || key === '--output') {
      assert(!parsed[key.slice(2)] && argv[i + 1] && !argv[i + 1].startsWith('--'), usage);
      parsed[key.slice(2)] = argv[++i];
    } else throw new Error(usage);
  }
  assert(parsed.source && parsed.output, usage);
  return parsed;
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// ASCII JSX avoids legacy COM source encoding ambiguities; the fixed text tool
// still receives the literal Unicode string through the real MCP JSON transport.
function jsxString(value) {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, character =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}

function resultText(result) {
  return (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
}

function resultData(result) {
  const text = resultText(result);
  const marker = text.indexOf('\nResult: ');
  let value = JSON.parse(marker < 0 ? text : text.slice(marker + 9));
  // Explicit JSON strings are also legitimate JSX return values. Never eval a
  // legacy toSource string, including its unsupported shared-reference syntax.
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { /* Reject below without logging content. */ }
  }
  assert(value !== null && typeof value === 'object' && !Array.isArray(value),
    'Expected object metadata; refusing an unparsed or scalar Photoshop response.');
  return value;
}

function samePath(left, right) {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

const LAYER_HELPERS = `
  function findLayer(layers, id) {
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      if (layer.id === id) return layer;
      if (layer.typename === 'LayerSet') {
        var nested = findLayer(layer.layers, id);
        if (nested) return nested;
      }
    }
    return null;
  }
  function bounds(layer) {
    var b = layer.bounds;
    return [b[0].as('px'), b[1].as('px'), b[2].as('px'), b[3].as('px')];
  }
`;

const INSPECT = `
  ${LAYER_HELPERS}
  var d = app.activeDocument;
  var counts = { layers: 0, text: 0, groups: 0, masks: 0, userMasks: 0, vectorMasks: 0, filterMasks: 0 };
  var rows = [], groups = [], firstText = null, firstGroup = null;
  function scalar(desc, name) {
    var key = stringIDToTypeID(name);
    if (!desc.hasKey(key)) return null;
    var type = desc.getType(key);
    if (type === DescValueType.BOOLEANTYPE) return desc.getBoolean(key);
    if (type === DescValueType.INTEGERTYPE) return desc.getInteger(key);
    if (type === DescValueType.DOUBLETYPE) return desc.getDouble(key);
    if (type === DescValueType.UNITDOUBLE) return desc.getUnitDoubleValue(key);
    throw new Error('Unsupported mask metadata type: ' + name);
  }
  function visit(layers, prefix, depth) {
    if (depth > 100) throw new Error('Layer depth exceeds bounded inspection');
    for (var i = 0; i < layers.length; i++) {
      if (++counts.layers > 10000) throw new Error('Layer count exceeds bounded inspection');
      var layer = layers[i], path = prefix + '/' + i;
      var isGroup = layer.typename === 'LayerSet';
      var isText = !isGroup && layer.kind === LayerKind.TEXT;
      var ref = new ActionReference();
      ref.putIdentifier(charIDToTypeID('Lyr '), layer.id);
      var desc = executeActionGet(ref);
      var mask = {};
      var keys = ['hasUserMask', 'hasVectorMask', 'hasFilterMask',
        'userMaskEnabled', 'userMaskLinked', 'userMaskDensity', 'userMaskFeather',
        'vectorMaskEnabled', 'vectorMaskLinked', 'vectorMaskDensity', 'vectorMaskFeather'];
      for (var k = 0; k < keys.length; k++) mask[keys[k]] = scalar(desc, keys[k]);
      if (mask.hasUserMask) counts.userMasks++;
      if (mask.hasVectorMask) counts.vectorMasks++;
      if (mask.hasFilterMask) counts.filterMasks++;
      if (mask.hasUserMask || mask.hasVectorMask || mask.hasFilterMask) counts.masks++;
      rows.push({ id: layer.id, path: path, type: isGroup ? 'group' : String(layer.kind), masks: mask });
      if (isText) {
        counts.text++;
        if (firstText === null) firstText = { id: layer.id, path: path, contents: layer.textItem.contents };
      }
      if (isGroup) {
        counts.groups++;
        var group = { id: layer.id, path: path, visible: layer.visible, bounds: bounds(layer) };
        groups.push(group);
        // toSource uses #n= / #n# syntax for shared object references. Return
        // distinct objects/arrays so the bridge's safe data parser can read it.
        if (firstGroup === null) firstGroup = {
          id: group.id, path: group.path, visible: group.visible, bounds: group.bounds.slice(0)
        };
        visit(layer.layers, path, depth + 1);
      }
    }
  }
  visit(d.layers, '', 0);
  return { documentId: d.id, width: d.width.as('px'), height: d.height.as('px'),
    resolution: d.resolution, mode: String(d.mode), bits: String(d.bitsPerChannel),
    counts: counts, rows: rows, groups: groups, firstText: firstText, firstGroup: firstGroup };
`;

function groupCode(id, body) {
  assert(Number.isSafeInteger(id) && id > 0, 'Invalid group id');
  return `${LAYER_HELPERS}
    var group = findLayer(app.activeDocument.layers, ${id});
    if (!group || group.typename !== 'LayerSet') throw new Error('Fixture group missing');
    ${body}
    return { id: group.id, visible: group.visible, bounds: bounds(group) };
  `;
}

function compareSnapshot(before, after) {
  for (const key of ['width', 'height', 'resolution', 'mode', 'bits', 'counts', 'rows', 'groups']) {
    assert.deepEqual(after[key], before[key], `Saved/reopened ${key} changed`);
  }
  assert.deepEqual(after.firstText, before.firstText, 'Native text changed when saved/reopened');
}

async function main(config) {
  assert.equal(process.platform, 'win32', 'This real-app fixture runner requires Windows.');
  const { resolveLocalPath } = await import('../dist/utils/local-path.js');
  const source = resolveLocalPath(config.source);
  const output = resolveLocalPath(config.output);
  assert.equal(extname(source).toLowerCase(), '.psd', 'Source must be a PSD.');
  const sourceStat = await stat(source);
  assert(sourceStat.isFile() && sourceStat.size > 0, 'Source must be a nonempty regular file.');
  assert((await stat(dirname(output))).isDirectory(), 'Output parent must already exist.');
  // No recursive creation or overwrite: every artifact belongs to this new run.
  await mkdir(output, { mode: 0o700 });
  const summary = {
    schema: 1, status: 'running', started: new Date().toISOString(), stage: 'preflight',
    sourceBytes: sourceStat.size, availableMemoryBytes: freemem(),
    checks: { text: 'not_run', groupTranslation: 'not_run', groupVisibility: 'not_run',
      masks: 'not_run', saveReopen: 'not_run', sourceUnchanged: 'not_run', preview: 'not_run' },
    privacy: 'Local test artifacts only; do not upload this directory.',
  };
  let logBytes = 0, stderrBytes = 0, client, transport, ownedId = null, input, saved;
  let sourceBefore, failure;
  const log = (event, detail = {}) => {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + '\n';
    const bytes = Buffer.byteLength(line);
    if (logBytes + bytes <= LOG_LIMIT) {
      appendFileSync(join(output, 'events.jsonl'), line, { mode: 0o600 });
      logBytes += bytes;
    }
  };
  const stage = value => { summary.stage = value; log('stage', { stage: value }); };
  async function call(name, args = {}, label = name) {
    const start = Date.now();
    log('call', { label, tool: name });
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT });
    log('result', { label, tool: name, milliseconds: Date.now() - start, error: result.isError === true });
    if (result.isError) throw new Error(resultText(result).slice(0, 2000));
    return result;
  }
  async function script(code, label, documentId = ownedId) {
    const args = { code, timeout_ms: 120000 };
    if (documentId !== null) args.document_id = documentId;
    return resultData(await call('photoshop_execute_script', args, label));
  }
  async function inspect(label) {
    const value = await script(INSPECT, label);
    assert(Number.isFinite(value.width) && value.width > 0 && Number.isFinite(value.height) && value.height > 0,
      'Inspection did not return valid dimensions.');
    assert(value.counts && Object.values(value.counts).every(count => Number.isSafeInteger(count) && count >= 0),
      'Inspection did not return valid layer/mask counts.');
    assert(Number.isSafeInteger(value.counts.layers) && Number.isSafeInteger(value.counts.text) &&
      Number.isSafeInteger(value.counts.groups) && Number.isSafeInteger(value.counts.masks),
      'Inspection omitted required counts.');
    assert(Array.isArray(value.rows) && value.rows.length === value.counts.layers &&
      Array.isArray(value.groups) && value.groups.length === value.counts.groups,
      'Inspection layer/group metadata was incomplete.');
    assert(value.counts.text > 0 ? typeof value.firstText?.contents === 'string' : value.firstText === null,
      'Inspection native text metadata was incomplete.');
    assert(value.counts.groups > 0 ? Number.isSafeInteger(value.firstGroup?.id) : value.firstGroup === null,
      'Inspection first group metadata was incomplete.');
    return value;
  }
  async function emptySession(label) {
    const state = resultData(await call('photoshop_get_state', {}, label));
    assert.equal(state.hasDocument, false, 'Refusing a Photoshop session with an already-open document.');
    const listed = resultData(await call('photoshop_list_documents', {}, label + '_all'));
    assert.equal(listed.details?.count, 0, 'Refusing a Photoshop session with already-open documents.');
  }
  async function ownDocument(expectedPath, label) {
    const state = resultData(await call('photoshop_get_state', { document_id: ownedId }, label));
    assert.equal(state.document?.id, ownedId, 'The active document is not the owned test document.');
    const details = await script(`
      if (app.documents.length !== 1) throw new Error('Other Photoshop documents appeared; stop fixture run');
      var d = app.activeDocument;
      if (d.id !== ${ownedId}) throw new Error('Owned fixture document changed');
      return { id: d.id, path: d.fullName.fsName };
    `, label + '_path');
    assert(samePath(details.path, expectedPath), 'The test document path is not the owned local copy.');
  }
  async function openOwned(path, label) {
    await emptySession(label + '_empty');
    const opened = resultData(await call('photoshop_open_image', { filePath: path }, label));
    assert(Number.isSafeInteger(opened.id) && opened.id > 0, 'Open returned no usable document id.');
    ownedId = opened.id;
    await ownDocument(path, label + '_owned');
  }
  async function closeOwned(path, label) {
    await ownDocument(path, label + '_guard');
    const closed = resultData(await call('photoshop_close_document', { document_id: ownedId, save: false }, label));
    assert.equal(closed.closed, true, 'Explicit test-document close did not succeed.');
    ownedId = null;
    await emptySession(label + '_empty');
  }
  try {
    const entry = await realpath(join(ROOT, 'dist', 'index.js'));
    assert(samePath(entry, join(ROOT, 'dist', 'index.js')), 'Use this exact checkout build.');
    await access(entry);
    summary.buildSha256 = await hashFile(entry);
    summary.serverVersion = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version;
    sourceBefore = await hashFile(source);
    summary.sourceSha256Before = sourceBefore;
    input = resolveLocalPath(join(output, 'input.psd'));
    saved = resolveLocalPath(join(output, 'tested.psd'));
    await copyFile(source, input, constants.COPYFILE_EXCL);
    assert.equal(await hashFile(input), sourceBefore, 'Copied PSD differs from the original.');
    log('copied', { bytes: sourceStat.size, sha256: sourceBefore });
    transport = new StdioClientTransport({
      command: process.execPath, args: [entry], cwd: ROOT, stderr: 'pipe',
      // Preserve all runtime-state, safety and recovery roots across clients.
      // Never isolate roots to bypass an existing lease or outcome_unknown.
      env: { ...process.env, LOG_LEVEL: '3' },
    });
    transport.stderr.on('data', chunk => {
      const bounded = Buffer.from(chunk).subarray(0, Math.max(0, STDERR_LIMIT - stderrBytes));
      if (bounded.length) {
        appendFileSync(join(output, 'stderr.log'), bounded, { mode: 0o600 });
        stderrBytes += bounded.length;
      }
    });
    client = new Client({ name: 'windows-private-fixture-verifier', version: '1.0.0' });
    stage('connect_and_discover');
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = new Set(tools.map(tool => tool.name));
    for (const name of ['photoshop_get_state', 'photoshop_list_documents', 'photoshop_get_capabilities',
      'photoshop_open_image', 'photoshop_execute_script', 'photoshop_update_text_content',
      'photoshop_save_document', 'photoshop_close_document', ...(config.preview ? ['photoshop_get_preview'] : [])]) {
      assert(names.has(name), 'Required tool missing: ' + name);
    }
    const prompts = await client.listPrompts();
    const capabilities = resultData(await call('photoshop_get_capabilities'));
    summary.photoshopVersion = capabilities.version;
    summary.discovery = { tools: tools.length, prompts: prompts.prompts.length };
    stage('open_copy');
    await openOwned(input, 'open_input');
    const baseline = await inspect('inspect_baseline');
    summary.dimensions = { width: baseline.width, height: baseline.height };
    summary.counts = baseline.counts;
    stage('native_text');
    if (baseline.firstText) {
      const originalText = baseline.firstText.contents; // In memory only; never append to logs.
      assert.equal(typeof originalText, 'string', 'Native text contents unavailable.');
      const selected = await script(`
        var ref = new ActionReference();
        ref.putIdentifier(charIDToTypeID('Lyr '), ${baseline.firstText.id});
        var desc = new ActionDescriptor();
        desc.putReference(charIDToTypeID('null'), ref);
        desc.putBoolean(charIDToTypeID('MkVs'), false);
        executeAction(charIDToTypeID('slct'), desc, DialogModes.NO);
        var l = app.activeDocument.activeLayer;
        if (l.kind !== LayerKind.TEXT) throw new Error('Selected layer is not native text');
        return { id: l.id };
      `, 'select_native_text_by_id');
      assert.equal(selected.id, baseline.firstText.id, 'Wrong text layer selected.');
      await call('photoshop_update_text_content', { document_id: ownedId, text: TEST_TEXT });
      const verified = await script(`
        ${LAYER_HELPERS}
        var l = findLayer(app.activeDocument.layers, ${baseline.firstText.id});
        return { id: l.id, nativeText: l.kind === LayerKind.TEXT, matches: l.textItem.contents === ${jsxString(TEST_TEXT)} };
      `, 'verify_native_text');
      assert(verified.nativeText && verified.matches, 'Native text update did not match the literal test text.');
      summary.checks.text = 'updated_pending_reopen';
      summary.textLayerId = baseline.firstText.id;
    } else summary.checks.text = 'no_text';
    // Editing native text can change enclosing group bounds. Capture the new
    // expected geometry before the reversible group operations.
    const edited = await inspect('inspect_after_text');
    assert.deepEqual(edited.counts, baseline.counts, 'Text update changed layer/mask counts.');
    assert.deepEqual(edited.rows, baseline.rows, 'Text update changed layer structure or mask metadata.');
    stage('group_round_trip');
    if (edited.firstGroup) {
      const group = edited.firstGroup;
      const moved = await script(groupCode(group.id, "group.translate(new UnitValue(5, 'px'), new UnitValue(0, 'px'));"), 'move_group_5px');
      assert.deepEqual(moved.bounds, group.bounds.map((number, index) => number + (index % 2 === 0 ? 5 : 0)), 'Group did not move 5px.');
      assert.equal(moved.visible, group.visible, 'Translation changed group visibility.');
      const restored = await script(groupCode(group.id, "group.translate(new UnitValue(-5, 'px'), new UnitValue(0, 'px'));"), 'restore_group_position');
      assert.deepEqual(restored.bounds, group.bounds, 'Group bounds were not restored.');
      summary.checks.groupTranslation = 'passed';
      const hidden = await script(groupCode(group.id, `group.visible = ${!group.visible};`), 'toggle_group_visibility');
      assert.equal(hidden.visible, !group.visible, 'Group visibility toggle failed.');
      const shown = await script(groupCode(group.id, `group.visible = ${group.visible};`), 'restore_group_visibility');
      assert.equal(shown.visible, group.visible, 'Group visibility was not restored.');
      assert.deepEqual(shown.bounds, group.bounds, 'Visibility round trip changed group bounds.');
      summary.checks.groupVisibility = 'passed';
    } else {
      summary.checks.groupTranslation = 'no_group';
      summary.checks.groupVisibility = 'no_group';
    }
    const expected = await inspect('inspect_before_save');
    compareSnapshot(edited, expected);
    assert.deepEqual(expected.rows, baseline.rows, 'Group operations changed layer or mask metadata.');
    summary.checks.masks = baseline.counts.masks ? 'inspected_pending_reopen' : 'no_masks';
    summary.structureSha256 = digest(expected.rows);
    summary.groupMetadataSha256 = digest(expected.groups);
    stage('save_psd');
    await ownDocument(input, 'before_save');
    await call('photoshop_save_document', { document_id: ownedId, path: saved, format: 'PSD', overwrite: false });
    assert((await stat(saved)).size > 0, 'Saved PSD is missing or empty.');
    summary.savedBytes = (await stat(saved)).size;
    summary.savedSha256 = await hashFile(saved);
    // This explicit discard is authorized only for our input copy after the
    // separate save_document operation. Never call close_document(save:true).
    await closeOwned(input, 'close_saved_input_copy');
    stage('reopen_and_verify');
    await openOwned(saved, 'reopen_tested_psd');
    const reopened = await inspect('inspect_reopened');
    compareSnapshot(expected, reopened);
    summary.checks.saveReopen = 'passed';
    if (baseline.firstText) {
      assert.equal(reopened.firstText.contents, TEST_TEXT, 'Modified native text did not persist.');
      summary.checks.text = 'passed';
    }
    if (baseline.counts.masks) summary.checks.masks = 'metadata_preserved';
    if (config.preview) {
      stage('preview');
      await ownDocument(saved, 'preview_target');
      const preview = await call('photoshop_get_preview', { document_id: ownedId, max_dimension_px: 800, quality: 7 });
      const image = preview.content?.find(item => item.type === 'image');
      assert(image?.mimeType === 'image/jpeg', 'Preview returned no JPEG.');
      assert(image.data.length <= 6 * 1024 * 1024, 'Preview exceeded bounded evidence size.');
      const buffer = Buffer.from(image.data, 'base64');
      assert(buffer.length > 0 && buffer.length <= 4 * 1024 * 1024, 'Invalid preview size.');
      await writeFile(join(output, 'preview.jpg'), buffer, { flag: 'wx', mode: 0o600 });
      summary.previewBytes = buffer.length;
      summary.checks.preview = 'generated_local_visual_review_required';
    } else summary.checks.preview = 'disabled';
    stage('close_own_copy');
    await closeOwned(saved, 'close_verified_output');
    assert.equal(await hashFile(input), sourceBefore, 'Input copy was unexpectedly overwritten.');
    summary.status = 'passed';
    stage('complete');
  } catch (error) {
    failure = error;
    summary.status = 'failed';
    summary.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    summary.ownedDocumentId = ownedId;
    summary.recovery = 'Stopped without further Photoshop calls, close, retry or recovery. Inspect application state explicitly.';
    log('failed', { stage: summary.stage });
  } finally {
    // On failure only read the original file and stop this MCP process. No
    // Photoshop cleanup or compensating mutation may run from this block.
    if (sourceBefore) {
      try {
        summary.sourceSha256After = await hashFile(source);
        summary.checks.sourceUnchanged = summary.sourceSha256After === sourceBefore ? 'passed' : 'FAILED';
        if (summary.checks.sourceUnchanged !== 'passed') {
          summary.status = 'failed';
          failure ??= new Error('Original source hash changed.');
        }
      } catch (error) {
        summary.status = 'failed';
        summary.checks.sourceUnchanged = 'unverified';
        failure ??= error;
      }
    }
    try { if (client) await client.close(); else if (transport) await transport.close(); }
    catch { summary.transportShutdown = 'failed'; }
    summary.finished = new Date().toISOString();
    summary.availableMemoryBytesAfter = freemem();
    await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    // Public console output deliberately contains no source path, layer names,
    // original text, hashes, raw tool results, or image data.
    console.log(JSON.stringify({ status: summary.status, stage: summary.stage,
      photoshopVersion: summary.photoshopVersion, dimensions: summary.dimensions,
      counts: summary.counts, checks: summary.checks }));
  }
  if (failure) process.exitCode = 1;
}

if (process.argv.slice(2).length === 1 && process.argv[2] === '--help') {
  console.log(usage);
} else {
  try { await main(options(process.argv.slice(2))); }
  catch (error) {
    // Preflight failures occur before any Photoshop connection.
    console.error(JSON.stringify({ status: 'failed', stage: 'preflight',
      error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) }));
    process.exitCode = 1;
  }
}
