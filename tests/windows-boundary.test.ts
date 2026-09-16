import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowsExecutor, AdobeDispatchRejectedError, isComDispatchRejection } from '../src/platform/windows-executor.js';
import { access, clearQuarantine, assertSafe } from '../src/platform/operation-safety.js';
import { parseExtendScriptPayload } from '../src/utils/extendscript-result.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
class FakeAdobe extends WindowsExecutor {
  calls: string[] = [];
  protected override async executeScript(script: string): Promise<unknown> {
    this.calls.push(script);
    if (script === 'slow') await delay(180);
    if (script === 'partial-error') throw new Error('changed a layer, then failed');
    if (script === 'com-rejected') throw new AdobeDispatchRejectedError();
    return script;
  }
}
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ps-boundary-unit-'));
  process.env.PHOTOSHOP_SAFETY_DIR = directory;
});
afterEach(async () => {
  delete process.env.PHOTOSHOP_SAFETY_DIR;
  await rm(directory, { recursive: true, force: true });
});

describe('Windows Adobe dispatch boundaries', () => {
  it('does not quarantine a transport-proven COM rejection or silently retry it', async () => {
    const adobe = new FakeAdobe();
    await expect(adobe.execute('com-rejected')).rejects.toThrow('application_busy');
    expect(adobe.calls).toEqual(['com-rejected']);
    await expect(assertSafe()).resolves.toBeUndefined();
    expect(await adobe.execute('next')).toBe('next');
  });
  it('requires both the transport exit code and the specific COM HRESULT', () => {
    const message = 'ERROR: COM -2147417846 (): ';
    expect(isComDispatchRejection({ code: 1 }, message)).toBe(true);
    expect(isComDispatchRejection({ code: 0 }, message)).toBe(false);
    expect(isComDispatchRejection({ code: 1 }, 'ERROR: COM -2147467259 (): ')).toBe(false);
    expect(isComDispatchRejection({ code: 'ENOENT' }, message)).toBe(false);
    expect(isComDispatchRejection(null, message)).toBe(false);
  });
  it('fails closed even if an interrupted quarantine write left an empty marker', async () => {
    await writeFile(join(directory, 'uncertain.json'), '');
    await expect(assertSafe()).rejects.toThrow('outcome_unknown');
  });
  it('never dispatches an expired queued write, even after the first call finishes', async () => {
    const adobe = new FakeAdobe();
    const first = adobe.execute('slow', 60).catch((e: Error) => e.message);
    const queued = adobe.execute('must-not-run', 30).catch((e: Error) => e.message);
    expect(await queued).toContain('queue_timeout');
    expect(await first).toContain('outcome_unknown');
    await delay(230);
    expect(adobe.calls).toEqual(['slow']);
    await expect(adobe.execute('write')).rejects.toThrow('outcome_unknown');
    expect(await access.run('read', () => adobe.execute('read'))).toBe('read');
    await clearQuarantine();
    expect(await adobe.execute('recovered')).toBe('recovered');
  });
  it('serializes different executor instances against the same Adobe application', async () => {
    const a = new FakeAdobe();
    const b = new FakeAdobe();
    const first = a.execute('slow', 1000);
    await delay(25);
    await expect(b.execute('late-write', 35)).rejects.toThrow('queue_timeout');
    await first;
    expect(b.calls).toEqual([]);
    expect(await b.execute('next')).toBe('next');
  });
  it('leaves partial failures quarantined and read-only inspection available', async () => {
    const adobe = new FakeAdobe();
    await expect(adobe.execute('partial-error')).rejects.toThrow('changed a layer');
    await expect(adobe.execute('retry')).rejects.toThrow('outcome_unknown');
    expect(await access.run('read', () => adobe.execute('state'))).toBe('state');
    expect(await readFile(join(directory, 'uncertain.json'), 'utf8')).toContain(
      'Write in progress'
    );
  });
  it.each([0, -1, NaN, Infinity])(
    'rejects invalid timeout %s before execution',
    async (timeout) => {
      const adobe = new FakeAdobe();
      await expect(adobe.execute('write', timeout)).rejects.toThrow('invalid_timeout');
      expect(adobe.calls).toEqual([]);
    }
  );
});
describe('data-only ExtendScript result parsing', () => {
  it('round-trips legacy objects, escapes, nested arrays and Unicode', () => {
    expect(
      parseExtendScriptPayload(
        '({ok:true,name:"中文\\n文字",list:[1,-2.5,null,false,{x:"\\u4e2d"}]})'
      )
    ).toEqual({ ok: true, name: '中文\n文字', list: [1, -2.5, null, false, { x: '中' }] });
  });
  it('does not evaluate expressions or prototype setters', () => {
    const source = '({x:(globalThis.__unexpectedExecution=true)})';
    expect(parseExtendScriptPayload(source)).toBe(source);
    expect((globalThis as Record<string, unknown>).__unexpectedExecution).toBeUndefined();
    const parsed = parseExtendScriptPayload('({__proto__:{polluted:true}})') as object;
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
