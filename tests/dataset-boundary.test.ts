import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { ExtendScriptSnippets } from '../src/api/extendscript.js';

it.each([
  ExtendScriptSnippets.listDataSets(),
  ExtendScriptSnippets.importDataSets(join(tmpdir(), 'input.xml')),
  ExtendScriptSnippets.applyDataSetsExport(join(tmpdir(), 'output'), 'PNG', ['one']),
])('refuses unavailable dataset DOM instead of claiming empty/successful output', script => {
  expect(() => runInNewContext('(function(){'+script+'})()', {
    app: { documents: [{}], activeDocument: {} },
    File: class { constructor() { throw new Error('must not open files'); } },
    Folder: class { constructor() { throw new Error('must not create output'); } },
  })).toThrow('unsupported:');
});
