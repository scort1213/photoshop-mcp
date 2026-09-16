import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WindowsExecutor } from '../src/platform/windows-executor.js';

type BridgeInternals = {
  createVBSWrapper(script: string, result: string): string;
  parseResult(output: string): unknown;
};

it.runIf(process.platform === 'win32')('preserves COM failure numbers when the description is empty', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ps-com-diagnostics-'));
  try {
    const bridge = new WindowsExecutor() as unknown as BridgeInternals;
    const result = join(directory, 'result.txt');
    // Execute the real VBScript error branch without connecting to Adobe.
    const source = bridge.createVBSWrapper(join(directory, 'unused.jsx'), result)
      .replace('Set photoshopApp = CreateObject("Photoshop.Application")',
        'Err.Raise -2147467259, "SyntheticCOM", ""');
    const script = join(directory, 'bridge.vbs');
    await writeFile(script, '\uFEFF' + source, 'utf16le');
    await expect(promisify(execFile)('cscript.exe', ['//nologo', script], { windowsHide: true }))
      .rejects.toMatchObject({ code: 1 });
    const payload = await readFile(result, 'utf16le');
    expect(() => bridge.parseResult(payload)).toThrow('COM -2147467259 (SyntheticCOM)');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('gives an actionable error for legacy bridges returning an empty description', () => {
  const bridge = new WindowsExecutor() as unknown as BridgeInternals;
  expect(() => bridge.parseResult('ERROR: ')).toThrow('inspect document state before recovery');
});
