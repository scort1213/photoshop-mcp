/** One explicit local MCP request, with durable evidence and EOF-only shutdown. */
import { appendFileSync, closeSync, openSync } from 'node:fs';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isErrorResponse, openLocalSession, validateRequest } from './local-session.mjs';

function errorRecord(error) {
  return { name: error.name, code: error.code, message: error.message, pid: error.pid, exitCode: error.exitCode, signal: error.signal, shutdownError: error.shutdownError };
}

/** config is an optional explicit local server configuration, used by offline tests. */
export async function runLocalCall({ requestPath, outputPath, config = {} }) {
  const { resolveLocalPath } = await import('../dist/utils/local-path.js');
  requestPath = resolveLocalPath(requestPath);
  outputPath = resolveLocalPath(outputPath);
  const request = JSON.parse((await readFile(requestPath, 'utf8')).replace(/^\uFEFF/, ''));
  validateRequest(request);
  await mkdir(dirname(outputPath), { recursive: true });
  // Reserve before starting the server. Existing response/evidence files are never replaced.
  const outputFile = await open(outputPath, 'wx');
  const eventsPath = outputPath + '.events.jsonl';
  let events;
  const record = {
    status: 'starting', startedAt: new Date().toISOString(), request,
    output: outputPath, events: eventsPath,
  };
  const persist = async () => {
    const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n');
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await outputFile.write(bytes, offset, bytes.length - offset, offset);
      if (bytesWritten === 0) throw new Error('Evidence write made no progress.');
      offset += bytesWritten;
    }
    await outputFile.truncate(bytes.length);
    await outputFile.sync();
  };
  let session;
  try {
    events = openSync(eventsPath, 'wx');
    await persist();
    session = await openLocalSession({
      ...config,
      env: { ANALYTICS_DISABLED: '1', LOG_LEVEL: '2', ...config.env },
    }, (event) => appendFileSync(events, JSON.stringify(event) + '\n'));
    record.server = session.server;
    record.pid = session.pid;
    record.status = 'requesting';
    await persist();
    const response = await session.request(request);
    // Keep the original response even if image export or shutdown subsequently fails.
    record.response = response;
    record.status = isErrorResponse(response) ? 'tool_error' : 'response_received';
    await persist();
    for (const [index, item] of (response.content ?? []).entries()) {
      if (item.type !== 'image') continue;
      const imagePath = outputPath + '.' + index + (item.mimeType === 'image/png' ? '.png' : '.jpg');
      await writeFile(imagePath, Buffer.from(item.data, 'base64'), { flag: 'wx' });
      delete item.data;
      item.saved_image = imagePath;
    }
    await persist();
  } catch (error) {
    record.status = 'failed';
    record.error = errorRecord(error);
  } finally {
    if (session) {
      try { record.shutdown = await session.close(); }
      catch (error) { record.shutdownError = errorRecord(error); record.status = 'failed'; }
    }
    if (record.status === 'response_received') record.status = 'passed';
    record.finishedAt = new Date().toISOString();
    try { await persist(); }
    finally {
      await outputFile.close();
      if (events !== undefined) closeSync(events);
    }
  }
  return record;
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (!['--request', '--output'].includes(name) || options[name] || !args[index + 1]) {
      throw new Error('Usage: node scripts/call-local.mjs --request ABSOLUTE_REQUEST.json --output NEW_ABSOLUTE_RESPONSE.json');
    }
    options[name] = args[++index];
  }
  if (!options['--request'] || !options['--output']) throw new Error('Both --request and --output are required.');
  const result = await runLocalCall({ requestPath: options['--request'], outputPath: options['--output'] });
  console.log(JSON.stringify({ output: result.output, events: result.events, status: result.status, pid: result.pid }));
  if (result.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
