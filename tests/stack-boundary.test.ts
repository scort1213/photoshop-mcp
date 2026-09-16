import { expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { ExtendScriptSnippets } from '../src/api/extendscript.js';

it('keeps multiple Unicode Windows paths flat and intact before opening', () => {
  const paths = ['C:\\中文\\one.png', 'C:\\two "quoted".png'];
  const seen: string[] = [];
  const open = vi.fn(() => { throw new Error('open reached'); });
  expect(() => runInNewContext('(function(){'+ExtendScriptSnippets.imageStackMode(paths,'stackModeMean')+'})()', {
    app: { documents: [], featureEnabled: () => true, open }, DialogModes: { NO: 0 },
    File: class { exists=true; fsName: string; constructor(p: string) { seen.push(p);this.fsName=p; } },
  })).toThrow('open reached');
  expect(seen.slice(0,2)).toEqual(paths);
  expect(open).toHaveBeenCalledTimes(1);
});

it('refuses any already-open source before opening or closing documents', () => {
  const open=vi.fn(),close=vi.fn();
  expect(() => runInNewContext('(function(){'+ExtendScriptSnippets.imageStackMode(['C:/one.png','C:/two.png'],'stackModeMean')+'})()', {
    app: { documents: [{ fullName: { fsName:'c:/TWO.png' },close }], featureEnabled: () => true, open },
    DialogModes: { NO:0 }, File: class { exists=true;fsName:string;constructor(p:string){this.fsName=p;} },
  })).toThrow('target_conflict');
  expect(open).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();
});
