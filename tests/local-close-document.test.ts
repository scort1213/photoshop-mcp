import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDocumentTools } from '../src/tools/document-tools.js';
import type { PhotoshopConnection } from '../src/platform/connection.js';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'local-close-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fixture(currentPath: string | null, saveError?: string) {
  const scripts: string[] = [];
  const connection = {
    runTransaction: async <T>(body: () => Promise<T>) => body(),
    getPhotoshopInfo: () => ({ version: '27.0.0' }),
    executeScript: async (script: string) => {
      scripts.push(script);
      if (script.includes('var localPath = null')) return { id: 42, path: currentPath };
      if (script.includes('.saveAs(')) {
        if (saveError) throw new Error(saveError);
        const matched = /new File\(("(?:[^"\\]|\\.)*")\)/.exec(script);
        if (!matched) throw new Error('missing explicit save destination');
        const path = (JSON.parse(matched[1]) as string)
          .split('/')
          .map((segment) => decodeURIComponent(segment))
          .join('/');
        await writeFile(path, 'saved locally');
        return { path };
      }
      return { closed: true };
    },
  } as unknown as PhotoshopConnection;
  const tool = createDocumentTools(connection).find(
    (tool) => tool.tool.name === 'photoshop_close_document'
  )!;
  return { tool, scripts, connection };
}

it('save=true reuses a verified local current filename and explicitly keeps the document open', async () => {
  const path = join(root, 'current.psd');
  await writeFile(path, 'old');
  const { tool, scripts } = fixture(path);
  const result = await tool.handler({ save: true });
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.content[0].text as string)).toMatchObject({
    saved: true,
    closed: false,
    path,
    document_id: 42,
  });
  expect(await readFile(path, 'utf8')).toBe('saved locally');
  expect(scripts[1]).toContain('.saveAs(');
  expect(scripts[1]).not.toContain('doc.save()');
  expect(scripts).toHaveLength(2);
  expect(scripts.join('\n')).not.toContain('doc.close(');
});

it('allows an explicit current filename without requiring overwrite again', async () => {
  const path = join(root, 'current.tiff');
  await writeFile(path, 'old');
  const { tool } = fixture(path);
  expect((await tool.handler({ save: true, path })).isError).not.toBe(true);
  expect(await readFile(path, 'utf8')).toBe('saved locally');
});

it('saves an unsaved document to an explicit local destination', async () => {
  const path = join(root, 'new.psb');
  const { tool, scripts } = fixture(null);
  expect((await tool.handler({ save: true, path })).isError).not.toBe(true);
  expect(await readFile(path, 'utf8')).toBe('saved locally');
  expect(scripts[1]).toContain('LargeDocumentFormatSaveOptions');
});

it.each([null, 'https://example.com/cloud.psd', '//server/share/current.psd'])(
  'keeps a document open when its current destination is unavailable or remote: %s',
  async (current) => {
    const { tool, scripts } = fixture(current);
    const result = await tool.handler({ save: true });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('local_path_required');
    expect(scripts).toHaveLength(1);
  }
);

it('never closes after refusing to overwrite a different existing output', async () => {
  const path = join(root, 'other.psd');
  await writeFile(path, 'preserved');
  const { tool, scripts } = fixture(null);
  expect((await tool.handler({ save: true, path })).isError).toBe(true);
  expect(await readFile(path, 'utf8')).toBe('preserved');
  expect(scripts).toHaveLength(1);
});

it('close without saving does not inspect any file destination', async () => {
  const { tool, scripts } = fixture('https://example.com/cloud.psd');
  expect((await tool.handler({ save: false })).isError).not.toBe(true);
  expect(scripts).toHaveLength(1);
  expect(scripts[0]).toContain('DONOTSAVECHANGES');
  expect(scripts[0]).not.toContain('doc.fullName');
});

it('retains artboard protection and does not close when save reports a geometry failure', async () => {
  const path = join(root, 'current.psd');
  await writeFile(path, 'preserved');
  const { tool, scripts } = fixture(path, 'artboard_geometry_changed: geometry drift');
  const result = await tool.handler({ save: true });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('artboard_geometry_changed');
  expect(scripts).toHaveLength(2);
  expect(scripts[1]).toContain('var __mcpArtboardAllowed = true');
  expect(scripts[1]).toContain('__mcpArtboardScope.verify()');
  expect(await readFile(path, 'utf8')).toBe('preserved');
});

it('saves an explicit local copy even when the source document destination is remote', async () => {
  const path = join(root, 'local-copy.psd');
  const { tool, scripts } = fixture('https://example.com/cloud.psd');
  const result = await tool.handler({ save: true, path });
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.content[0].text as string)).toMatchObject({
    saved: true,
    closed: false,
  });
  expect(await readFile(path, 'utf8')).toBe('saved locally');
  expect(scripts).toHaveLength(2);
});

it('pins the document id returned by metadata before saving', async () => {
  const path = join(root, 'id.psd');
  const { tool, scripts } = fixture(null);
  expect((await tool.handler({ save: true, path })).isError).not.toBe(true);
  expect(scripts[1]).toContain('var __mcp_targetDocId = 42');
});

it.each(['photoshop_close_document', 'photoshop_save_document'])(
  'encodes a native path only once for %s, including Unicode, percent, hash and spaces',
  async (name) => {
    const directory = join(root, '中文 空%#');
    await mkdir(directory);
    const path = join(directory, 'local.psd');
    const { connection, scripts } = fixture(null);
    const tool = createDocumentTools(connection).find((tool) => tool.tool.name === name)!;
    const result = await tool.handler({ save: true, path, format: 'PSD' });
    expect(result.isError).not.toBe(true);
    expect(await readFile(path, 'utf8')).toBe('saved locally');
    expect(scripts[1]).toContain('%E4%B8%AD%E6%96%87%20%E7%A9%BA%25%23');
    expect(scripts[1]).not.toContain('%25E4');
  }
);
