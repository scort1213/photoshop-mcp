# Windows branch usage

This Windows branch is based on the local-only `master` commit
`cf29ab654b5362759316edad1be98c4c01769779`. It retains the boundary-hardening
history, with Windows-specific repairs. Its server version is
`1.7.14-windows.2`. Keep the previously accepted Windows/Mac checkouts intact;
install lifecycle changes in a separate checkout. Do not substitute the upstream npm package.

## Build and connect

Use a persistent, local Node installation and this checkout:

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:server
```

Configure the client with absolute paths, adapting the example to the machine:

```toml
[mcp_servers.photoshop_windows]
command = 'D:\runtimes\node\node.exe'
args = ['D:\tools\photoshop-mcp-windows\dist\index.js']

[mcp_servers.photoshop_windows.env]
ANALYTICS_DISABLED = '1'
LOG_LEVEL = '2'
PHOTOSHOP_PATH = 'D:\Adobe\Adobe Photoshop 2022\Photoshop.exe'
PHOTOSHOP_MCP_HOME = 'D:\tools\photoshop-mcp-state'
```

Use one common `PHOTOSHOP_MCP_HOME` for all clients controlling the same
Photoshop instance. Do not run an older server using a different safety directory
against that instance. Restart/reload the client to discover the configured
server. An external stdio test does not prove that a running client's native
tool menu has reloaded.

## Direct calls without a native host reload

`scripts/call-local.mjs` sends one explicit request to this checkout, writes the
response to a new local JSON file, then ends stdin and waits for the server to
exit naturally. It never sends a kill signal and does not retry or recover failed
operations. It inherits the shell environment; it does not read
the client's TOML configuration. Set the same runtime paths in that shell. Use a request
file to avoid PowerShell quoting and Unicode interpolation errors:

```json
{"method":"tools/call","params":{"name":"photoshop_get_state","arguments":{}}}
```

```powershell
$env:PHOTOSHOP_PATH = 'D:\Adobe\Adobe Photoshop 2022\Photoshop.exe'
$env:PHOTOSHOP_MCP_HOME = 'D:\tools\photoshop-mcp-state'
$env:ANALYTICS_DISABLED = '1'
$env:LOG_LEVEL = '2'
node scripts/call-local.mjs --request 'D:\work\request.json' --output 'D:\work\response-001.json'
```

For discovery, use `{"method":"tools/list"}` or `{"method":"prompts/list"}`.
The output contains the original response, final status, server PID and shutdown
result. Lifecycle events are saved to `<output>.events.jsonl`; image responses
are saved alongside the JSON. The response is persisted before shutdown, so a
shutdown failure cannot hide a successful or failed tool response. Existing
outputs and evidence files are refused before starting a server. Keep this raw
evidence private; it can contain document paths and server diagnostics.

## One persistent session for a workflow

Use `scripts/local-session.mjs` for discovery, editing, preview and saving over
one server process. Its `openLocalSession(config?, onEvent?)` function (also
exported as `openPhotoshopSession`) returns `server`, `pid`, `request(body)` and
`close()`. The default command is the current Node executable with this checkout's
`dist/index.js`. Optional `command`, `entry` and `cwd` must be absolute paths;
optional `env` overrides are merged with the caller environment. Never switch
shared runtime roots to work around a lease error. Neither helper reads or changes
shared lease files, credentials, or the native client's configuration.

For example, save a workflow module at this checkout's root and supply a new
absolute evidence directory whose parent already exists:

```javascript
import { appendFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { openLocalSession, isErrorResponse } from './scripts/local-session.mjs';

const output = process.argv[2];
if (!output || !isAbsolute(output)) throw new Error('An absolute evidence directory is required.');
mkdirSync(output); // Refuse existing evidence.
const record = (name, value) => appendFileSync(join(output, name), JSON.stringify(value) + '\n');
const session = await openLocalSession({}, (event) => record('session.jsonl', event));
try {
  async function request(body) {
    record('calls.jsonl', { phase: 'request', pid: session.pid, body });
    try {
      const response = await session.request(body);
      record('calls.jsonl', { phase: 'response', pid: session.pid, response });
      if (isErrorResponse(response)) throw new Error('Tool error; inspect the recorded response.');
      return response;
    } catch (error) {
      record('calls.jsonl', { phase: 'exception', message: error.message });
      throw error;
    }
  }
  await request({ method: 'tools/list' });
  await request({ method: 'tools/call', params: { name: 'photoshop_get_state', arguments: {} } });
  // Continue the authorized workflow here after verifying the document and tool schemas.
} finally {
  try { record('session.jsonl', { type: 'closed', ...await session.close() }); }
  catch (error) {
    record('session.jsonl', { type: 'shutdown_failed', code: error.code, pid: error.pid, message: error.message });
    throw error;
  }
}
```

Requests are serialized. A tool response with `isError:true` or a JSON error
envelope containing `ok:false` is returned unchanged, then the session refuses
queued and later requests without dispatching them. A transport exception also
stops subsequent requests. Persist and inspect the original failure; do not
silently open another session to replay it. Custom JSX remains trusted local
code, not a sandbox. For image calls, save the returned image bytes and replace
base64 in long-term evidence with the local filename.

The default caller deadline is 120 seconds (`requestTimeoutMs`); this does not
extend the server's normal operation deadline (usually 30 seconds, with explicit
tool overrides where advertised). A server `outcome_unknown` response or a
caller timeout does not prove the underlying Adobe job has stopped. `close()`
first stops accepting requests and waits for the accepted queue, then sends EOF.
The repaired server drains remaining jobs before exiting. No Session startup
stderr message or observed idle window is required.

Natural shutdown has a separate 150-second reporting deadline (`closeTimeoutMs`).
If it expires, `shutdown_blocked` reports the server PID and preserves the process;
there is no signal escalation, lock cleanup, recovery, or automatic retry. Open
stdio handles can keep the caller alive until the server eventually exits. Keep
the caller, server and evidence available for inspection. Closing this MCP session
does not close a Photoshop document or quit Photoshop.

For an existing SDK-based runner, import `NaturalExitTransport` from this helper
instead of `StdioClientTransport`. It accepts `command`, `args`, `cwd`, `env` and
optional `closeTimeoutMs`, and supports `pid` and piped `stderr`. Even SDK
`client.close()` then uses EOF-only natural shutdown; it never calls the SDK's
default termination escalation. This transport alone does not supply the
persistent helper's queue or stop-after-error behavior.

## Text editing and layered PSD skills

1. Call `photoshop_get_capabilities`, `photoshop_list_documents` and
   `photoshop_get_state`. Pin subsequent edits to the returned `document_id`.
2. Work on a copy when testing existing artwork. Use `photoshop_get_layers`
   to identify a layer and `photoshop_select_layer_by_name` when its name is
   unique. For duplicate names, select the exact numeric layer ID through local
   JSX and read back the active layer before editing. Read the discovered schema
   before calling a tool.
3. For native text, use `photoshop_list_fonts`,
   `photoshop_update_text_content`, `photoshop_set_text_font` and
   `photoshop_set_text_color`. A raster text layer cannot become editable by
   calling an update-text tool.
4. For `psd-editable-rebuild`, preserve original pixels, masks, group ordering
   and shadow ownership. Its local finishing JSX can be sent through
   `photoshop_execute_script` after pinning the test document. For
   `bggg-creator-image2psd`, verify raster assembly, transparency and Multiply
   shadows separately from native text.
5. Inspect `photoshop_get_preview`, save with `photoshop_save_document`, and
   explicitly reopen the saved copy to check text, groups and masks. Photoshop
   acceptance does not establish that the artwork visually matches its reference.

`photoshop_close_document(save:true)` deliberately returns
`saved:true, closed:false`: it saves a local copy and keeps the document open.
Do not silently chain an automatic discard/close. Close only on an explicit
workflow instruction, with the intended `document_id`.

On `outcome_unknown`, stop writes, inspect `photoshop_get_state` and any reported
inspection paths, and reconcile actual changes. Only then explicitly call
`photoshop_recover_connection` with `acknowledge:true`. Recovery does not undo
changes. Never retry an uncertain edit automatically.

Cloud tools remain disabled. Select Subject and related recipes require the
user's Photoshop Device processing setting; this branch does not force or claim
to verify that preference. The Windows COM ProgID uses the registered Photoshop
instance; `PHOTOSHOP_PATH` alone does not bind an arbitrary second installation.

## Acceptance scripts

- `scripts/verify-windows-bridge.mjs`: live read-only Unicode/version bridge probe.
- `scripts/verify-windows-live.mjs`: synthetic stdio acceptance, including saved
  PSD reopen; pass a new `--output` directory. `--probe` is read-only discovery.
- `scripts/verify-windows-fixture.mjs`: copy one small local PSD, edit the copy,
  save/reopen and verify the original hash; pass `--source` and a new `--output`.
- `scripts/verify-windows-faults.mjs`: two real clients exercise timeout,
  quarantine and explicit recovery on one synthetic document. Set
  `PHOTOSHOP_SAFETY_DIR` explicitly to the common directory (normally
  `$env:PHOTOSHOP_MCP_HOME + '\tmp\safety'`) and pass a new `--output`.

Run live tests sequentially with Photoshop reserved for the test documents.
Keep originals and compact evidence. Remove only verified disposable test copies
after the documents have been closed and their source hashes checked.
