import { afterEach, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtendScriptSnippets } from '../src/api/extendscript.js';
import { bindSkyBlend } from '../src/tools/recipes/sky-blend.js';
import { bindCsvToCards } from '../src/tools/recipes/csv-to-cards.js';
import { resolveLocalPath } from '../src/utils/local-path.js';
import { jsStringLiteral } from '../src/utils/js-string.js';
import type { PhotoshopConnection } from '../src/platform/connection.js';

const value = join(tmpdir(), "probe' + (sentinel = 1) + '.png");
const font = "missing' + (sentinel = 1) + 'font";
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function run(source: string, fileExists = false) {
  const document = { activeLayer: { kind: 'text' }, layers: [], dataSets: [{}], importVariables() {} };
  const context = {
    sentinel: 0,
    app: { documents: [document], activeDocument: document, fonts: [] },
    LayerKind: { TEXT: 'text' },
    File: function () { return { exists: fileExists }; },
    Folder: function () { return { exists: false, create: () => false }; },
  };
  let error: unknown;
  let result: unknown;
  try { result = runInNewContext('(function(){' + source + '})()', context, { timeout: 1000 }); }
  catch (failure) { error = failure; }
  expect(context.sentinel).toBe(0);
  expect(String(error)).not.toMatch(/SyntaxError|ReferenceError/);
  return { error, result };
}

it('treats every fixed-tool error parameter as data, including formerly injectable branches', () => {
  const sources = [
    ExtendScriptSnippets.openImage(value),
    ExtendScriptSnippets.placeImage(value),
    ExtendScriptSnippets.createTextLayer('text', 1, 1, 12, font),
    ExtendScriptSnippets.setTextFont(font),
    ExtendScriptSnippets.moveLayerToPosition(font, 'ABOVE'),
    ExtendScriptSnippets.importDataSets(value),
    ExtendScriptSnippets.applyDataSetsExport(value, 'PNG', ['row']),
  ];
  for (const source of sources) expect(run(source).error).toBeDefined();
});

it('preserves names containing quotes, percent signs, controls, Chinese and emoji exactly', () => {
  const text = "中文 O'Brien 50% \\" + String.fromCharCode(0, 1, 9, 31) + '😀\u2028\u2029';
  expect(runInNewContext(jsStringLiteral(text))).toBe(text);
  const filePath = join(tmpdir(), "中文 O'Brien 50%.png");
  const { error } = run(ExtendScriptSnippets.openImage(filePath));
  expect(String(error)).toContain(filePath);
});

function captureConnection(scripts: string[]): PhotoshopConnection {
  return {
    getPhotoshopInfo: () => ({ version: '27.0.0' }),
    executeScript: async (script: string) => {
      scripts.push(script);
      return { ok: true, summary: 'captured', details: {} };
    },
  } as unknown as PhotoshopConnection;
}

it('does not evaluate a sky filename while producing an error or result message', async () => {
  const scripts: string[] = [];
  await bindSkyBlend(captureConnection(scripts)).handler({ sky_image_path: value });
  const script = scripts[0];
  const start = script.indexOf('var imageFile = new File(');
  const end = script.indexOf('app.displayDialogs = DialogModes.NO;', start);
  const { result } = run(script.slice(start, end));
  expect(result).toMatchObject({ code: 'file_not_found', message: 'Image file not found: ' + value });
  expect(script).toContain('sky_image_path: ' + jsStringLiteral(value));
});

it('keeps CSV temporary and output paths literal in both rejection branches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fixed-strings-'));
  directories.push(root);
  vi.stubEnv('PHOTOSHOP_MCP_HOME', join(root, "home' + (sentinel = 1) + '"));
  // Windows refuses ambiguous trailing spaces; POSIX still exercises literal preservation.
  const suffix = process.platform === 'win32' ? '' : ' ';
  const csvPath = join(root, 'input.csv' + suffix);
  await writeFile(csvPath, 'title\nhello\n');
  const scripts: string[] = [];
  await bindCsvToCards(captureConnection(scripts)).handler({ csv_path: csvPath, output_dir: value + suffix });
  const script = scripts[0];
  expect(script).toContain('output_dir: ' + jsStringLiteral(resolveLocalPath(value + suffix)));
  const start = script.indexOf('var xmlFile = new File(');
  const end = script.indexOf('try {\n      doc.importVariables', start);
  const body = script.slice(start, end);
  expect(run(body).result).toMatchObject({ code: 'file_not_found' });
  expect(run(body, true).result).toMatchObject({ code: 'output_dir_not_writable' });
});
