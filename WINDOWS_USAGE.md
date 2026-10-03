# Windows branch usage

This Windows branch is based on the local-only `master` commit
`cf29ab654b5362759316edad1be98c4c01769779`. It retains the boundary-hardening
history, with Windows-specific repairs. Its server version is
`1.7.14-windows.1`. Do not substitute the upstream npm package.

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
response to a new local JSON file, and closes the client. It does not retry or
recover failed operations. It inherits the shell environment; it does not read
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
Image responses are saved alongside the JSON. Only pass trusted local JSX,
local assets/fonts and local output filenames. These scripts are not a sandbox.

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
