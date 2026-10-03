/**
 * Real Photoshop fault acceptance, using two independent MCP stdio processes.
 * Run serially with exclusive access to Photoshop. Requires an empty session.
 * Uses only one disposable 64x64 document; no retry or failure-path close.
 * Explicit recovery occurs only after read-only reconciliation proves completion.
 * Usage: node scripts/verify-windows-faults.mjs --output ABSOLUTE_NEW_DIRECTORY
 */
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { NaturalExitTransport } from './local-session.mjs';
import { resolveLocalPath, toAdobePath } from '../dist/utils/local-path.js';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: node scripts/verify-windows-faults.mjs --output ABSOLUTE_NEW_DIRECTORY');
  console.log('Real Windows Photoshop only; empty session, shared runtime-state environment and exclusive access required.');
  process.exit(0);
}
assert.equal(process.platform, 'win32', 'This fault runner requires real Windows Photoshop.');
assert.ok(args.length === 2 && args[0] === '--output' && isAbsolute(args[1]), '--output must be one absolute new directory.');
for (const key of ['PHOTOSHOP_MCP_HOME', 'PHOTOSHOP_SAFETY_DIR'])
  assert.ok(process.env[key] && isAbsolute(process.env[key]), `${key} must point to the coordinated shared runtime state.`);
const output = resolveLocalPath(args[1]);
await mkdir(output); // Refuse existing directories, links and accidental report overwrites.
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sentinel = join(output, 'dispatch-sentinel.txt');
const callsPath = join(output, 'calls.jsonl');
const summaryPath = join(output, 'summary.json');
const report = {
  status: 'running', startedAt: new Date().toISOString(), checkout, output,
  node: process.execPath, platform: process.platform, mode: 'real-photoshop-faults',
  safetyDirectory: process.env.PHOTOSHOP_SAFETY_DIR,
  mcpHome: process.env.PHOTOSHOP_MCP_HOME,
  checks: [], calls: 0, ownedDocumentId: null, ownedDocumentClosed: false,
  shutdown: [],
  limitations: ['One synthetic 64x64 RGB document; no business documents or asset files.',
    'No automatic replay, rollback, failure-path document close, or process kill.'],
};
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const sessions = [];

async function closeSession(session) {
  if (session.closed) return session.closed;
  await session.client.close();
  // SDK forgets an already exited transport, so validate its exit explicitly.
  const result = await session.transport.close();
  session.closed = result;
  report.shutdown.push({ client: session.label, method: 'stdin EOF only', ...result });
  return result;
}

function payload(result) {
  if (result.structuredContent) return result.structuredContent;
  for (const block of result.content ?? []) {
    if (block.type !== 'text') continue;
    for (const text of [block.text, block.text.split('\nResult: ').at(-1)]) {
      try { return JSON.parse(text); } catch { /* Human-readable confirmation. */ }
    }
  }
  return undefined;
}
const responseText = (result) => (result.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
function check(name, evidence = {}) {
  report.checks.push({ name, ...evidence });
  console.log('PASS ' + name);
}
async function call(session, name, arguments_ = {}, expectedError) {
  const number = ++report.calls;
  const started = Date.now();
  await appendFile(callsPath, JSON.stringify({ phase: 'start', number, client: session.label, name,
    arguments: arguments_, startedAt: new Date(started).toISOString() }) + '\n');
  let result;
  try {
    result = await session.client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 120000 });
  } catch (error) {
    await appendFile(callsPath, JSON.stringify({ phase: 'transport-error', number, error: String(error) }) + '\n');
    throw error;
  }
  const elapsedMs = Date.now() - started;
  await appendFile(callsPath, JSON.stringify({ phase: 'result', number, elapsedMs, result }) + '\n');
  const data = payload(result);
  const failed = result.isError === true || data?.ok === false;
  if (expectedError) {
    assert.ok(failed, `${name} unexpectedly succeeded; expected ${expectedError}.`);
    assert.match(responseText(result), expectedError, `${name} returned an unexpected failure.`);
  } else {
    assert.ok(!failed, `${name} failed: ${responseText(result)}`);
  }
  return { result, data, elapsedMs };
}
async function connect(label) {
  const transport = new NaturalExitTransport({ command: process.execPath,
    args: [join(checkout, 'dist', 'index.js')], cwd: checkout,
    env: { ...process.env }, stderr: 'pipe' });
  transport.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  const client = new Client({ name: 'photoshop-windows-faults-' + label, version: '1.0.0' });
  const session = { label, client, transport };
  sessions.push(session);
  await client.connect(transport);
  assert.ok(transport.pid, 'The local transport did not record its child PID.');
  return session;
}
async function lines() {
  try { return (await readFile(sentinel, 'utf8')).replace(/\uFEFF/g, '').split(/\r?\n/).filter(Boolean); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function waitForDispatch() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if ((await lines()).includes('run')) return;
    await delay(25);
  }
  throw new Error('No real JSX dispatch sentinel within 8000ms; do not replay the operation.');
}
async function assertOnlyOwned(session, layerName) {
  const documents = (await call(session, 'photoshop_list_documents')).data?.details;
  assert.equal(documents?.count, 1, 'A foreign document appeared; stop without recovery or cleanup.');
  assert.deepEqual(documents.documents.map((doc) => doc.id), [report.ownedDocumentId]);
  const state = (await call(session, 'photoshop_get_state', { document_id: report.ownedDocumentId })).data;
  assert.equal(state?.document?.id, report.ownedDocumentId);
  assert.equal(state?.document?.width, 64);
  assert.equal(state?.document?.height, 64);
  if (layerName !== undefined) assert.equal(state?.activeLayer?.name, layerName);
  return state;
}

let firstOutcome;
try {
  const a = await connect('A');
  const b = await connect('B');
  for (const session of [a, b]) {
    const state = (await call(session, 'photoshop_get_state')).data;
    assert.equal(state?.hasDocument, false, 'Fault acceptance refuses any initially open document.');
    assert.equal((await call(session, 'photoshop_list_documents')).data?.details?.count, 0);
  }
  check('Both real MCP clients warmed up against an empty Photoshop session');
  await call(a, 'photoshop_create_document', { width: 64, height: 64, resolution: 72, colorMode: 'RGB' });
  report.ownedDocumentId = (await call(a, 'photoshop_get_state')).data?.document?.id;
  assert.ok(Number.isSafeInteger(report.ownedDocumentId) && report.ownedDocumentId > 0);
  await assertOnlyOwned(a);
  const target = { document_id: report.ownedDocumentId };
  const guard = `if (app.documents.length !== 1 || app.activeDocument.id !== ${report.ownedDocumentId}) throw new Error('fault_fixture_changed');`;
  const append = `function mark(value) { var f = new File(${JSON.stringify(toAdobePath(sentinel))}); f.encoding = 'UTF8'; if (!f.open('a')) throw new Error('sentinel_open_failed'); f.writeln(value); f.close(); }`;

  // Capture errors immediately: this promise intentionally stays pending while
  // the independent second client attempts to acquire the application lease.
  firstOutcome = call(a, 'photoshop_execute_script', { ...target, timeout_ms: 2000,
    code: `${guard}\n${append}\nmark('run'); $.sleep(4000); app.activeDocument.activeLayer.name = 'late-completion'; mark('late-completion'); return 'late-completion';`,
  }, /outcome_unknown/).then((value) => ({ value }), (error) => ({ error }));
  await waitForDispatch();
  check('Sentinel proves the first JSX body was actually dispatched');
  const queued = await call(b, 'photoshop_execute_script', { ...target, timeout_ms: 500,
    code: `${guard}\n${append}\nmark('MUST-NOT-RUN'); app.activeDocument.activeLayer.name = 'MUST-NOT-RUN'; return 'MUST-NOT-RUN';`,
  }, /queue_timeout/);
  const timedOut = await firstOutcome;
  if (timedOut.error) throw timedOut.error;
  check('Started call timed out; second client expired while queued', {
    firstElapsedMs: timedOut.value.elapsedMs, queuedElapsedMs: queued.elapsedMs,
  });

  // Deliberately close the first MCP process while its actual Adobe call is
  // still running. EOF must drain the native tail, not abandon its lease.
  assert.deepEqual(await lines(), ['run'], 'Native work already finished; this run did not exercise shutdown during the call.');
  assert.ok((await stat(join(report.safetyDirectory, 'active.json'))).size > 0);
  const closingAt = Date.now();
  const drainedExit = await closeSession(a);
  report.shutdownDuringTimeout = { elapsedMs: Date.now() - closingAt, ...drainedExit };
  assert.deepEqual(await lines(), ['run', 'late-completion']);
  await assert.rejects(stat(join(report.safetyDirectory, 'active.json')), { code: 'ENOENT' });
  assert.ok((await stat(join(report.safetyDirectory, 'uncertain.json'))).isFile());
  check('EOF waited for real late completion, released the lease, and preserved quarantine', report.shutdownDuringTimeout);

  // These read-only calls queue behind the real bridge and prove it has exited.
  report.afterTimeout = await assertOnlyOwned(b, 'late-completion');
  const completed = await lines();
  assert.deepEqual(completed, ['run', 'late-completion'], 'Late work must finish exactly once; queued work must never run.');
  const layers = await call(b, 'photoshop_get_layers', target);
  assert.doesNotMatch(responseText(layers.result), /MUST-NOT-RUN/);
  await call(b, 'photoshop_rename_layer', { ...target, name: 'MUST-NOT-RUN' }, /outcome_unknown/);
  await assertOnlyOwned(b, 'late-completion');
  check('Late completion ran exactly once, queued write never ran, quarantine blocked the next write');
  // Explicit reconciliation is complete: exactly the owned fixture remains,
  // the lease-draining reads succeeded, and the only dispatched edit completed.
  await call(b, 'photoshop_recover_connection', { acknowledge: true });
  report.afterTimeoutRecovery = await assertOnlyOwned(b, 'late-completion');
  assert.deepEqual(await lines(), completed);
  check('Explicit recovery preserved late completion and did not replay or roll it back');

  await call(b, 'photoshop_execute_script', { ...target,
    code: `${guard}\napp.activeDocument.activeLayer.name = 'partial-change'; throw new Error('intentional_fault_after_partial_change');`,
  }, /intentional_fault_after_partial_change/);
  report.afterPartialFailure = await assertOnlyOwned(b, 'partial-change');
  await call(b, 'photoshop_rename_layer', { ...target, name: 'MUST-NOT-RUN' }, /outcome_unknown/);
  await assertOnlyOwned(b, 'partial-change');
  check('Real JSX partial failure preserved its change and blocked subsequent writes');
  await call(b, 'photoshop_recover_connection', { acknowledge: true });
  report.afterPartialRecovery = await assertOnlyOwned(b, 'partial-change');
  assert.deepEqual(await lines(), completed);
  check('Explicit recovery preserved the inspected partial change without rollback');

  // The sole successful-path cleanup is specifically authorized for this fixture.
  const closed = await call(b, 'photoshop_close_document', { ...target, save: false });
  assert.equal(closed.data?.closed, true);
  report.ownedDocumentClosed = true;
  assert.equal((await call(b, 'photoshop_get_state')).data?.hasDocument, false);
  assert.equal((await call(b, 'photoshop_list_documents')).data?.details?.count, 0);
  check('Only the owned fixture was explicitly closed; Photoshop session is empty');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
  report.nextAction = 'Inspect summary, calls, shared safety state and any open fixture. Do not retry, clear locks, recover or close blindly.';
  console.error('FAULT ACCEPTANCE FAILED: ' + String(error));
  process.exitCode = 1;
} finally {
  if (firstOutcome) await firstOutcome;
  // No recovery or document close occurs here. EOF is normal MCP shutdown, not
  // a process kill; the SDK fallback that sends kill signals is never invoked.
  for (const session of sessions) {
    try { await closeSession(session); }
    catch (error) {
      report.shutdown.push({ client: session.label, error: String(error), pid: session.transport.pid });
      report.status = 'failed';
      process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(summaryPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, report: summaryPath, ownedDocumentId: report.ownedDocumentId,
    ownedDocumentClosed: report.ownedDocumentClosed }));
}
