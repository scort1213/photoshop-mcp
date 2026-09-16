import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

it.each(['pending', 'throws'])('serves initialize and tools/list when Adobe initialization %s', async mode => {
  const sessionUrl = pathToFileURL(resolve('src/core/session.ts')).href;
  const serverUrl = pathToFileURL(resolve('src/core/server.ts')).href;
  const code = `
    const {Session}=await import(${JSON.stringify(sessionUrl)});
    Session.prototype.initialize=async function(){
      ${mode === 'pending' ? 'await new Promise(()=>{});' : 'throw new Error("injected Adobe startup failure");'}
    };
    const {PhotoshopMCPServer}=await import(${JSON.stringify(serverUrl)});
    await new PhotoshopMCPServer({serverVersion:'0.0.0-test'}).start();
  `;
  const transport = new StdioClientTransport({command:process.execPath,
    args:['--import','tsx','--input-type=module','-e',code],
    env:{...process.env, ANALYTICS_DISABLED:'1', LOG_LEVEL:'3'} as Record<string,string>,
    stderr:'pipe'});
  const client = new Client({name:'startup-regression',version:'1.0.0'});
  try {
    await client.connect(transport, {timeout:5000});
    const listed = await client.listTools({}, {timeout:3000});
    expect(listed.tools.some(t=>t.name==='photoshop_get_state')).toBe(true);
    expect(listed.tools.some(t=>t.name==='photoshop_create_layer')).toBe(true);
  } finally { await client.close(); }
}, 10000);
