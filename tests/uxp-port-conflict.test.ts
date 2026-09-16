import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

it('reports an occupied fixed port instead of silently rerouting a plugin', async () => {
  const occupied = createServer();
  await new Promise<void>(done => occupied.listen(0, '127.0.0.1', done));
  const address = occupied.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const moduleUrl = pathToFileURL(resolve('src/platform/uxp-bridge-server.ts')).href;
  try {
    const script = `const bridge=await import(${JSON.stringify(moduleUrl)});
      try { await bridge.ensureUxpBridgeServer(); await bridge.shutdownUxpBridgeServer(); process.exitCode=2; }
      catch(error) { if(error.code!=='EADDRINUSE') throw error; console.log(JSON.stringify({code:error.code,port:bridge.getUxpBridgePort()})); }`;
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: { ...process.env, PHOTOSHOP_UXP_BRIDGE_PORT: String(address.port) }, timeout: 8000,
    });
    expect(JSON.parse(result.stdout)).toEqual({ code: 'EADDRINUSE', port: address.port });
  } finally {
    await new Promise<void>(done => occupied.close(() => done()));
  }
}, 10000);
