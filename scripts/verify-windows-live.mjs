/**
 * Real Photoshop acceptance through this checkout's MCP stdio server.
 * Run only after coordinating access to Photoshop and stopping other MCP clients.
 * Never retries, recovers a quarantined operation, or closes documents on failure.
 * Explicit successful-path closes apply only to documents created by this run.
 * Usage: node scripts/verify-windows-live.mjs --output D:\\absolute\\new-directory [--probe]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { NaturalExitTransport as StdioClientTransport } from './local-session.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('Usage: node scripts/verify-windows-live.mjs --output ABSOLUTE_NEW_DIRECTORY [--probe]');
  console.log('Requires exclusive MCP access. --probe still starts/connects to real Photoshop.');
  process.exit(0);
}
let outputArgument;
let probe = false;
for (let index = 0; index < argv.length; index++) {
  if (argv[index] === '--output' && outputArgument === undefined) outputArgument = argv[++index];
  else if (argv[index] === '--probe' && !probe) probe = true;
  else throw new Error(`Unknown or duplicate argument: ${argv[index]}`);
}
assert.equal(process.platform, 'win32', 'This acceptance runner requires real Windows Photoshop.');
assert.ok(outputArgument && isAbsolute(outputArgument), '--output must be an absolute new directory.');
const { resolveLocalPath } = await import('../dist/utils/local-path.js');
const output = resolveLocalPath(outputArgument);
// Deliberately not recursive: an existing output, including a link, must fail.
await mkdir(output);
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = join(output, 'artifacts');
const mcpHome = process.env.PHOTOSHOP_MCP_HOME || join(output, 'mcp-home');
await mkdir(artifacts);
if (!process.env.PHOTOSHOP_MCP_HOME) await mkdir(mcpHome);
const callsPath = join(output, 'calls.jsonl');
const summaryPath = join(output, 'summary.json');
const summary = {
  status: 'running',
  mode: probe ? 'probe' : 'full',
  startedAt: new Date().toISOString(),
  checkout,
  server: join(checkout, 'dist', 'index.js'),
  node: process.execPath,
  platform: process.platform,
  output,
  mcpHome,
  calls: 0,
  checks: [],
  artifacts: [],
  ownedOpenDocumentIds: [],
  limitations: [
    'Synthetic documents only; no business assets are read.',
    'No fault injection, recovery, or automatic retry.',
    'PNG signature and dimensions are checked; pixel and visual review are separate.',
    'No claim about Adobe background network activity or an offline sandbox.',
  ],
};
const owned = new Set();
let sequence = 0;
const client = new Client({ name: 'photoshop-windows-live-acceptance', version: '1.0.0' });
// SDK default environment filtering omits SystemRoot/SystemDrive. Keep the real environment.
// Preserve configured shared lock/recovery roots. Never log the environment or credentials.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [summary.server],
  cwd: checkout,
  env: {
    ...process.env,
    PHOTOSHOP_MCP_HOME: mcpHome,
  },
  stderr: 'pipe',
});
transport.stderr?.on('data', (chunk) => process.stderr.write(chunk));

function check(name, evidence = {}) {
  summary.checks.push({ name, ...evidence });
  console.log(`PASS ${name}`);
}

function payload(result) {
  if (result.structuredContent) return result.structuredContent;
  for (const block of result.content ?? []) {
    if (block.type !== 'text') continue;
    const text = block.text;
    const candidates = [text, text.includes('\nResult: ') ? text.split('\nResult: ').at(-1) : ''];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        let value = JSON.parse(candidate);
        if (typeof value === 'string') {
          try { value = JSON.parse(value); } catch { /* Ordinary string return. */ }
        }
        return value;
      } catch { /* This text block is a human-readable confirmation. */ }
    }
  }
  return undefined;
}

async function compactResult(result, callNumber) {
  const saved = { ...result };
  if (!Array.isArray(result.content)) return saved;
  saved.content = [];
  for (const [index, block] of result.content.entries()) {
    if (block.type !== 'image') {
      saved.content.push(block);
      continue;
    }
    const bytes = Buffer.from(block.data, 'base64');
    const extension = block.mimeType === 'image/png' ? 'png' : 'jpg';
    const path = join(artifacts, `preview-${String(callNumber).padStart(3, '0')}-${index}.${extension}`);
    await writeFile(path, bytes, { flag: 'wx' });
    const file = { path, bytes: bytes.length, sha256: digest(bytes), mimeType: block.mimeType };
    summary.artifacts.push(file);
    saved.content.push({ type: 'image', ...file });
  }
  return saved;
}

async function request(method, args, operation) {
  const callNumber = ++sequence;
  summary.calls = sequence;
  const startedAt = new Date().toISOString();
  console.log(`CALL ${callNumber} ${method}${args?.name ? ` ${args.name}` : ''}`);
  await appendFile(callsPath, JSON.stringify({ phase: 'start', callNumber, startedAt, method, args }) + '\n');
  try {
    const result = await operation();
    const recorded = await compactResult(result, callNumber);
    await appendFile(callsPath, JSON.stringify({ phase: 'result', callNumber, finishedAt: new Date().toISOString(), result: recorded }) + '\n');
    return result;
  } catch (error) {
    await appendFile(callsPath, JSON.stringify({ phase: 'exception', callNumber, finishedAt: new Date().toISOString(), error: String(error) }) + '\n');
    throw error;
  }
}

async function call(name, args = {}, expectedError) {
  const result = await request('tools/call', { name, arguments: args }, () =>
    client.callTool({ name, arguments: args }, undefined, { timeout: 150000 })
  );
  const data = payload(result);
  const responseText = (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  const failed = result.isError === true || data?.ok === false;
  // An uncertain outcome must stop even if a rejection was expected.
  assert.doesNotMatch(responseText, /outcome_unknown/, `${name} has an uncertain outcome; inspect manually.`);
  if (expectedError) {
    assert.ok(failed, `${name} unexpectedly succeeded; expected ${expectedError}.`);
    assert.match(responseText, expectedError, `${name} returned a different error.`);
  } else {
    assert.ok(!failed, `${name} failed: ${responseText}`);
  }
  return { result, data };
}

async function script(documentId, code) {
  return (await call('photoshop_execute_script', { document_id: documentId, code })).data;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function inspectFile(path, format) {
  const bytes = await readFile(path);
  assert.ok(bytes.length > 32, `${format} output is empty/truncated.`);
  if (format === 'PSD') {
    assert.equal(bytes.subarray(0, 4).toString('ascii'), '8BPS');
    assert.equal(bytes.readUInt16BE(4), 1);
    assert.equal(bytes.readUInt32BE(14), 360);
    assert.equal(bytes.readUInt32BE(18), 640);
    assert.equal(bytes.readUInt16BE(24), 3, 'PSD color mode must be RGB.');
  } else {
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR');
    assert.equal(bytes.readUInt32BE(16), 640);
    assert.equal(bytes.readUInt32BE(20), 360);
  }
  const evidence = { path, format, bytes: bytes.length, sha256: digest(bytes), width: 640, height: 360 };
  summary.artifacts.push(evidence);
  return evidence;
}

const auditCode = `
  var doc = app.activeDocument;
  function walk(container) {
    var rows = [];
    for (var i = 0; i < container.layers.length; i++) {
      var layer = container.layers[i];
      var row = { id: layer.id, name: layer.name, type: layer.typename, visible: layer.visible, opacity: layer.opacity, blendMode: String(layer.blendMode) };
      var ref = new ActionReference();
      ref.putIdentifier(stringIDToTypeID('layer'), layer.id);
      var desc = executeActionGet(ref);
      var key = stringIDToTypeID('hasUserMask');
      row.hasMask = desc.hasKey(key) && desc.getBoolean(key);
      if (layer.typename === 'LayerSet') row.children = walk(layer);
      else if (layer.kind === LayerKind.TEXT) {
        row.text = layer.textItem.contents;
        row.font = layer.textItem.font;
        row.fontSize = layer.textItem.size.as('pt');
      }
      rows.push(row);
    }
    return rows;
  }
  return { documentId: doc.id, width: doc.width.as('px'), height: doc.height.as('px'), mode: String(doc.mode), layers: walk(doc) };
`;

function verifyAudit(audit, expectedText, font) {
  assert.equal(audit.width, 640);
  assert.equal(audit.height, 360);
  assert.match(audit.mode, /RGB/);
  const text = audit.layers.find((layer) => layer.name === 'Editable Chinese title');
  assert.ok(text, 'Editable text layer is missing.');
  assert.equal(text.text, expectedText);
  assert.equal(text.font, font);
  assert.equal(text.fontSize, 28);
  const group = audit.layers.find((layer) => layer.name === 'Local composition');
  assert.equal(group?.type, 'LayerSet');
  const masked = group.children.find((layer) => layer.name === 'Multiply masked rectangle');
  assert.ok(masked, 'Grouped raster layer is missing.');
  assert.match(masked.blendMode, /MULTIPLY/i);
  assert.equal(masked.hasMask, true);
  assert.ok(audit.layers.some((layer) => layer.name === 'RGB background'));
}

async function closeOwned(documentId) {
  assert.ok(owned.has(documentId), 'Refusing to close a document not created/opened by this runner.');
  const { data } = await call('photoshop_close_document', { document_id: documentId, save: false });
  assert.equal(data?.closed, true);
  owned.delete(documentId);
}

async function run() {
  await request('initialize', undefined, async () => {
    await client.connect(transport, { timeout: 150000 });
    return { serverVersion: client.getServerVersion(), capabilities: client.getServerCapabilities() };
  });
  const tools = await request('tools/list', {}, () => client.listTools());
  const prompts = await request('prompts/list', {}, () => client.listPrompts());
  assert.equal(tools.tools.length, 112);
  assert.equal(prompts.prompts.length, 20);
  const blocked = ['generative_fill', 'generative_remove', 'generative_expand', 'generative_upscale', 'generate_image', 'neural_filter', 'sky_replacement'].map((name) => `photoshop_${name}`);
  for (const name of blocked) assert.ok(!tools.tools.some((tool) => tool.name === name));
  check('112 tools, 20 prompts, cloud tools absent');
  summary.capabilities = (await call('photoshop_get_capabilities')).data;
  summary.initialState = (await call('photoshop_get_state')).data;
  assert.equal(typeof summary.initialState?.hasDocument, 'boolean');
  check('Real Photoshop capabilities and state received');
  if (probe) return;

  assert.equal(summary.initialState.hasDocument, false, 'Existing document detected; full acceptance stops without modifying it.');
  const initialDocuments = (await call('photoshop_list_documents')).data;
  assert.equal(initialDocuments?.details?.count, 0, 'Full acceptance requires an empty Photoshop session.');
  for (const name of blocked) await call(name, {}, /cloud_disabled/);
  for (const [name, option] of [
    ['remove_distraction', 'use_generative'], ['remove_background', 'use_generative'],
    ['enhance_portrait', 'use_neural_skin'], ['sky_blend', 'use_native_sky'],
  ]) await call(`photoshop_recipe_${name}`, { [option]: true }, /cloud_disabled/);
  check('Seven cloud tools and four explicit cloud branches refused');
  await call('photoshop_rename_layer', { document_id: -1, name: 'Must not be applied' }, /invalid_argument/);
  check('Negative document_id refused');

  await call('photoshop_create_document', { width: 640, height: 360, resolution: 72, colorMode: 'RGB' });
  const created = (await call('photoshop_get_state')).data;
  const documentId = created?.document?.id;
  assert.ok(Number.isSafeInteger(documentId) && documentId > 0, 'Created document id is missing.');
  owned.add(documentId);
  const target = { document_id: documentId };
  await call('photoshop_fill_layer', { ...target, red: 238, green: 242, blue: 249 });
  await call('photoshop_rename_layer', { ...target, name: 'RGB background' });
  await call('photoshop_create_layer', { ...target, name: 'Multiply masked rectangle' });
  await call('photoshop_fill_layer', { ...target, red: 120, green: 170, blue: 210 });
  await call('photoshop_set_layer_blend_mode', { ...target, blendMode: 'MULTIPLY' });
  await call('photoshop_select_rectangle', { ...target, left: 40, top: 140, right: 280, bottom: 280 });
  await call('photoshop_create_layer_mask', target);
  await call('photoshop_deselect', target);
  await script(documentId, `
    var doc = app.activeDocument;
    doc.activeChannels = doc.componentChannels;
    var layer = doc.activeLayer;
    var group = doc.layerSets.add();
    group.name = 'Local composition';
    layer.move(group, ElementPlacement.INSIDE);
    doc.activeLayer = group;
    return { groupId: group.id, layerId: layer.id };
  `);
  let font;
  for (const query of ['YaHei', 'SimHei', 'SimSun']) {
    const fonts = (await call('photoshop_list_fonts', { query, limit: 100 })).data;
    font = fonts?.fonts?.find((item) => typeof item.postScriptName === 'string')?.postScriptName;
    if (font) break;
  }
  assert.ok(font, 'No tested local Chinese font found (YaHei, SimHei, SimSun); no online font fallback.');
  summary.font = font;
  const firstText = "Windows 中文验收 50% '原稿'";
  const finalText = "中文修改已验证 50% '保留'";
  await call('photoshop_create_text_layer', { ...target, text: firstText, x: 40, y: 75, fontSize: 28, fontName: font });
  await call('photoshop_rename_layer', { ...target, name: 'Editable Chinese title' });
  assert.equal((await script(documentId, 'return { text: app.activeDocument.activeLayer.textItem.contents };')).text, firstText);
  await call('photoshop_update_text_content', { ...target, text: finalText });
  await call('photoshop_set_text_font', { ...target, fontName: font, fontSize: 28 });
  await call('photoshop_set_text_color', { ...target, red: 24, green: 44, blue: 70 });
  // Move the title out of the active group to make its editable position explicit.
  await script(documentId, `
    var doc = app.activeDocument;
    var title = doc.activeLayer;
    title.move(doc.layerSets.getByName('Local composition'), ElementPlacement.PLACEBEFORE);
    return { titleId: title.id, parentType: title.parent.typename };
  `);
  summary.beforeSave = await script(documentId, auditCode);
  verifyAudit(summary.beforeSave, finalText, font);
  check('RGB fill, local Chinese text create/edit/font, group, Multiply and layer mask');
  const preview = await call('photoshop_get_preview', { ...target, max_dimension_px: 640, quality: 8 });
  assert.ok(preview.result.content.some((block) => block.type === 'image'));
  check('Real document preview returned');

  const psdPath = join(artifacts, "中文 Windows '验收' 50%.psd");
  const pngPath = join(artifacts, "中文 Windows '验收' 50%.png");
  await call('photoshop_save_document', { ...target, path: psdPath, format: 'PSD' });
  await inspectFile(psdPath, 'PSD');
  await call('photoshop_save_document', { ...target, path: pngPath, format: 'PNG' });
  await inspectFile(pngPath, 'PNG');
  check('PSD and PNG signatures/dimensions, Unicode/space/quote/percent paths');
  const previousHash = digest(await readFile(psdPath));
  await call('photoshop_save_document', { ...target, path: psdPath, format: 'PSD' }, /output_exists/);
  assert.equal(digest(await readFile(psdPath)), previousHash);
  check('Existing output refused without overwrite; SHA-256 unchanged');

  const saved = (await call('photoshop_close_document', { ...target, save: true, path: psdPath, overwrite: true })).data;
  assert.equal(saved?.saved, true);
  assert.equal(saved?.closed, false);
  assert.equal(saved?.document_id, documentId);
  const stillOpen = (await call('photoshop_list_documents')).data;
  assert.ok(stillOpen?.details?.documents?.some((doc) => doc.id === documentId));
  check('close(save:true) returned saved:true/closed:false and kept the same document open');
  // This separately authorized acceptance step explicitly closes only its own fixture.
  await closeOwned(documentId);
  await call('photoshop_open_image', { filePath: psdPath });
  const reopened = (await call('photoshop_get_state')).data;
  const reopenedId = reopened?.document?.id;
  assert.ok(Number.isSafeInteger(reopenedId) && reopenedId > 0);
  owned.add(reopenedId);
  summary.afterReopen = await script(reopenedId, auditCode);
  verifyAudit(summary.afterReopen, finalText, font);
  await call('photoshop_get_layers', { document_id: reopenedId });
  await call('photoshop_get_preview', { document_id: reopenedId, max_dimension_px: 640, quality: 8 });
  check('Reopened PSD preserved editable Chinese text/font, dimensions, group, Multiply and mask');

  await call('photoshop_create_document', { width: 64, height: 64, resolution: 72, colorMode: 'RGB' });
  const second = (await call('photoshop_get_state')).data;
  const secondId = second?.document?.id;
  assert.ok(Number.isSafeInteger(secondId) && secondId > 0 && secondId !== reopenedId);
  owned.add(secondId);
  const secondLayerName = second.activeLayer?.name;
  await call('photoshop_rename_layer', { name: 'Must not be applied' }, /ambiguous_document/);
  const afterRefusal = (await call('photoshop_get_state', { document_id: secondId })).data;
  assert.equal(afterRefusal.activeLayer?.name, secondLayerName);
  verifyAudit(await script(reopenedId, auditCode), finalText, font);
  check('Untargeted mutation with two documents refused; both fixtures unchanged');
  await closeOwned(secondId);
  await closeOwned(reopenedId);
  summary.finalState = (await call('photoshop_get_state')).data;
  assert.equal(summary.finalState?.hasDocument, false);
  await inspectFile(psdPath, 'PSD');
  summary.pixelReview = { pngPath, expectedBackground: { point: [10, 10], rgb: [238, 242, 249] }, maskedRectangle: [40, 140, 280, 280] };
  check('All owned fixture documents explicitly closed; final session empty');
}

try {
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
  await run();
  summary.status = 'passed';
} catch (error) {
  summary.status = 'failed';
  summary.error = { name: error?.name, message: String(error?.message ?? error), stack: error?.stack };
  console.error(`STOP: ${summary.error.message}`);
  console.error('No retry, recovery, document close, or file cleanup is performed after failure.');
  process.exitCode = 1;
} finally {
  // Disconnect only. Do not infer success or discard any failed Photoshop document.
  try {
    await client.close();
    // The SDK forgets a transport that already closed; still validate its exit.
    await transport.close();
    if (transport.exit) summary.shutdown = { ...transport.exit };
  } catch (error) {
    summary.closeError = String(error);
    summary.shutdownError = { code: error?.code, message: String(error?.message ?? error), pid: error?.pid ?? transport.pid };
    summary.status = 'failed';
    process.exitCode = 1;
  }
  summary.finishedAt = new Date().toISOString();
  summary.ownedOpenDocumentIds = [...owned];
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  console.log(`Report: ${summaryPath}`);
}
