import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { MacOSExecutor } from '../src/platform/macos-executor.js';
import { WindowsExecutor } from '../src/platform/windows-executor.js';
import { assertSafe } from '../src/platform/operation-safety.js';

const probe = vi.hoisted(() => ({
  root: '',
  directories: [] as string[],
  scripts: [] as string[],
  wrappers: [] as string[],
  commands: [] as string[],
  fail: false,
  code: 1,
  output: '',
  preparationReady: undefined as undefined | (() => void),
  preparationGate: undefined as undefined | Promise<void>,
}));
vi.mock('../src/utils/local-path.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/local-path.js')>()),
  resolveLocalPath: (path: string) => path,
  getLocalTempRoot: () => probe.root,
}));
vi.mock('../src/utils/system-tools.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/utils/system-tools.js')>();
  return {
    getWindowsSystemTool: (name: Parameters<typeof real.getWindowsSystemTool>[0]) =>
      name === 'cscript' ? '/mock/system/cscript.exe' : real.getWindowsSystemTool(name),
  };
});
vi.mock('fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      await real.writeFile(...args);
      if (String(args[0]).endsWith('bridge.scpt') || String(args[0]).endsWith('bridge.vbs')) {
        probe.preparationReady?.();
        await probe.preparationGate;
      }
    },
  };
});
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const mock = vi.fn();
  Object.defineProperty(mock, promisify.custom, {
    value: (command: string, args: string[]) => {
      probe.commands.push(command);
      const execution = (async () => {
        const bridge = args.at(-1)!;
        const windows = bridge.endsWith('.vbs');
        const wrapper = await readFile(bridge, windows ? 'utf16le' : 'utf8');
        probe.wrappers.push(wrapper);
        probe.directories.push(dirname(bridge));
        const literal = windows
          ? /DoJavaScript\("(.*)"\)/.exec(wrapper)?.[1]?.replace(/""/g, '"')
          : (JSON.parse(/do javascript (".*")/.exec(wrapper)![1]) as string);
        const uri = JSON.parse(/new File\((".*")\)/.exec(literal!)![1]) as string;
        probe.scripts.push(
          await readFile(
            uri
              .split('/')
              .map((segment) => decodeURIComponent(segment))
              .join('/'),
            'utf8'
          )
        );
        if (windows)
          await writeFile(bridge + '.result', '\uFEFF' + (probe.output || '{ok:true}'), 'utf16le');
        if (probe.fail)
          throw Object.assign(new Error('mock bridge transport ended'), { code: probe.code });
        return { stdout: probe.output || '{ok:true}', stderr: '' };
      })();
      return Object.assign(execution, { child: { pid: process.pid } });
    },
  });
  return { ...real, execFile: mock };
});

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ps-native-bridge-')));
  // Double quotes are legal POSIX filenames, but cannot be created on Windows.
  probe.root = join(root, process.platform === 'win32' ? '中文 空%#apostrophe\'' : '中文 空%#"apostrophe\'');
  await mkdir(probe.root);
  process.env.PHOTOSHOP_SAFETY_DIR = join(root, 'safety');
  probe.directories = [];
  probe.scripts = [];
  probe.wrappers = [];
  probe.commands = [];
  probe.fail = false;
  probe.output = '';
  probe.code = 1;
});
afterEach(async () => {
  probe.preparationReady = undefined;
  probe.preparationGate = undefined;
  vi.restoreAllMocks();
  delete process.env.PHOTOSHOP_SAFETY_DIR;
  await rm(root, { recursive: true, force: true });
});

describe.each(['mac', 'windows'] as const)('%s native bridge files', (platform) => {
  const create = () => (platform === 'mac' ? new MacOSExecutor() : new WindowsExecutor());
  it('uses unique invocation directories and passes encoded paths through execFile without a shell', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const first = create();
    const second = create();
    expect(await first.execute('FIRST')).toEqual({ ok: true });
    expect(await second.execute('SECOND')).toEqual({ ok: true });
    expect(probe.scripts).toEqual(['\uFEFFFIRST', '\uFEFFSECOND']);
    expect(new Set(probe.directories).size).toBe(2);
    expect(probe.commands).toEqual(
      platform === 'mac'
        ? ['/usr/bin/osascript', '/usr/bin/osascript']
        : ['/mock/system/cscript.exe', '/mock/system/cscript.exe']
    );
    for (const wrapper of probe.wrappers) {
      expect(wrapper).toContain('new File(');
      expect(wrapper).toContain(encodeURIComponent(basename(probe.root)));
      expect(wrapper).not.toContain('decodeURI');
      expect(wrapper).not.toContain('do shell script');
    }
    expect(await readdir(probe.root)).toEqual([]);
  });

  it('never dispatches after file preparation consumes the deadline', async () => {
    let ready!: () => void;
    let finish!: () => void;
    const prepared = new Promise<void>((resolve) => {
      ready = resolve;
    });
    probe.preparationReady = ready;
    probe.preparationGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const result = create()
      .execute('NEVER', 200)
      .catch((error) => error as Error);
    await prepared;
    expect(((await result) as Error).message).toContain('queue_timeout');
    finish();
    for (let attempt = 0; attempt < 100 && (await readdir(probe.root)).length; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(probe.commands).toEqual([]);
    expect(await readdir(probe.root)).toEqual([]);
    await expect(assertSafe()).resolves.toBeUndefined();
  });

  it('retains bridge files and inspection information after uncertain transport failure', async () => {
    probe.fail = true;
    if (platform === 'windows') probe.output = '{ok:true}';
    await expect(create().execute('MAYBE-CHANGED')).rejects.toThrow('inspection_path=');
    expect(probe.directories).toHaveLength(1);
    expect((await stat(probe.directories[0])).isDirectory()).toBe(true);
    await expect(assertSafe()).rejects.toThrow('outcome_unknown');
  });
});

it('only clears quarantine for a transport-proven Windows COM rejection', async () => {
  probe.fail = true;
  probe.output = 'ERROR: COM -2147417846 (): application busy';
  await expect(new WindowsExecutor().execute('REJECTED')).rejects.toThrow('application_busy');
  await expect(assertSafe()).resolves.toBeUndefined();
  expect(await readdir(probe.root)).toEqual([]);
});
