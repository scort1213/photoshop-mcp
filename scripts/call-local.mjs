/** One explicit MCP request; no automatic retries or recovery. Build first. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (key) => args[args.indexOf(key) + 1];
if (!args.includes('--request') || !args.includes('--output')) {
  throw new Error('Usage: node scripts/call-local.mjs --request ABSOLUTE_REQUEST.json --output NEW_ABSOLUTE_RESPONSE.json');
}
const { resolveLocalPath } = await import('../dist/utils/local-path.js');
const requestPath = resolveLocalPath(option('--request'));
const outputPath = resolveLocalPath(option('--output'));
try { await access(outputPath); throw new Error('Output already exists; choose a new response path.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const request = JSON.parse((await readFile(requestPath, 'utf8')).replace(/^\uFEFF/, ''));
const allowed = new Set(['tools/list', 'prompts/list', 'tools/call']);
if (!allowed.has(request.method)) throw new Error('Supported methods: tools/list, prompts/list, tools/call');
if (request.method === 'tools/call' && typeof request.params?.name !== 'string') {
  throw new Error('tools/call requires params.name and optional params.arguments.');
}
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, 'dist/index.js')],
  cwd: root,
  env: { ...process.env, ANALYTICS_DISABLED: '1', LOG_LEVEL: '2' },
  stderr: 'pipe',
});
const client = new Client({ name: 'photoshop-local-file-client', version: '1.0.0' });
transport.stderr?.on('data', (chunk) => process.stderr.write(chunk));
try {
  await client.connect(transport);
  const response = request.method === 'tools/list' ? await client.listTools()
    : request.method === 'prompts/list' ? await client.listPrompts()
    : await client.callTool(request.params, undefined, { timeout: 120000 });
  await mkdir(dirname(outputPath), { recursive: true });
  for (const [index, item] of (response.content ?? []).entries()) {
    if (item.type !== 'image') continue;
    const imagePath = outputPath + '.' + index + (item.mimeType === 'image/png' ? '.png' : '.jpg');
    await writeFile(imagePath, Buffer.from(item.data, 'base64'), { flag: 'wx' });
    delete item.data;
    item.saved_image = imagePath;
  }
  await writeFile(outputPath, JSON.stringify({ server: client.getServerVersion(), response }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output: outputPath, isError: !!response.isError }));
  if (response.isError) process.exitCode = 1;
} finally {
  await client.close();
}
