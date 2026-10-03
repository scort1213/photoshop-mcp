import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';

// The SDK's default close escalates to process signals after two seconds. This
// fixture verifies actual EOF shutdown and must never hide a failed drain.
class EofOnlyTransport extends StdioClientTransport {
  override async close(): Promise<void> {
    const child = (this as unknown as { _process?: ChildProcess })._process;
    if (!child || child.exitCode !== null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolveClose, reject) => {
        child.once('close', () => resolveClose());
        timer = setTimeout(() => reject(new Error('Fixture did not exit after stdin EOF')), 8000);
        child.stdin?.end();
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

it.each(['pending', 'throws'])('serves discovery without invoking an Adobe initializer that %s', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ps-startup-handshake-'));
  const marker = join(root, 'unexpected-adobe-call.txt');
  const sessionUrl = pathToFileURL(resolve('src/core/session.ts')).href;
  const connectionUrl = pathToFileURL(resolve('src/platform/connection.ts')).href;
  const entrypointUrl = pathToFileURL(resolve('src/index.ts')).href;
  const code = `
    const {appendFileSync}=await import('node:fs');
    const unexpected=(name)=>appendFileSync(${JSON.stringify(marker)},name+'\\n');
    const {PhotoshopConnection}=await import(${JSON.stringify(connectionUrl)});
    for(const name of ['ping','getVersion','executeScript','ensurePhotoshopRunning'])
      PhotoshopConnection.prototype[name]=async function(){unexpected(name);throw new Error('Unexpected Adobe call');};
    const {Session}=await import(${JSON.stringify(sessionUrl)});
    Session.prototype.initialize=async function(){
      unexpected('initialize');
      ${mode === 'pending' ? 'await new Promise(()=>{});' : 'throw new Error("injected Adobe startup failure");'}
    };
    await import(${JSON.stringify(entrypointUrl)});
  `;
  const transport = new EofOnlyTransport({command:process.execPath,
    args:['--import','tsx','--input-type=module','-e',code],
    env:{...process.env, ANALYTICS_DISABLED:'1', LOG_LEVEL:'3',
      PHOTOSHOP_MCP_HOME:root, PHOTOSHOP_SAFETY_DIR:join(root,'safety'),
      PHOTOSHOP_RECOVERY_DIR:join(root,'recovery')} as Record<string,string>,
    stderr:'pipe'});
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({name:'startup-regression',version:'1.0.0'});
  try {
    await client.connect(transport, {timeout:5000});
    const listed = await client.listTools({}, {timeout:3000});
    expect(listed.tools.some(t=>t.name==='photoshop_get_state')).toBe(true);
    expect(listed.tools.some(t=>t.name==='photoshop_create_layer')).toBe(true);
    expect((await client.listPrompts({}, {timeout:3000})).prompts.length).toBeGreaterThan(0);
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({code:'ENOENT'});
  } catch (error) {
    throw new Error(`${String(error)}\nFixture stderr: ${stderr}`);
  } finally {
    await client.close();
    // Startup and discovery never acquire an execution lease or create a
    // quarantine. Assert again after the entrypoint completed its EOF drain.
    expect(await readdir(root)).toEqual([]);
    await rm(root, {recursive:true, force:true});
  }
}, 15000);
