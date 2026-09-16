# Boundary hardening contract

Branch: `codex/boundary-hardening`, based on the Windows installation baseline.

- Windows COM work is serialized across MCP processes. A queued deadline
  expires without dispatch. A started write that times out or fails leaves a
  persistent quarantine; disconnecting/restarting MCP does not silently retry it.
  All clients must use this hardened build and the same safety directory. Old
  clients, direct scripts and manual Adobe edits do not participate in its lock.
- Read `photoshop_get_state` and `photoshop_list_documents` after an uncertain
  outcome. Inspect any partial change, then call
  `photoshop_recover_connection({"acknowledge":true})`. This does not undo work.
  Recovery fails while another bridge call still holds the application lease.
- `document_id` must be a positive safe integer. Missing targets are rejected;
  multiple open documents require an explicit target for document edits.
  Document creation/open/switch tools manage their own target. Name-based layer
  lookup rejects duplicates. State now includes paths, saved flags and layer IDs.
- Custom JSX accepts `timeout_ms` (1–120000). Scripts remain trusted code.
- Managed edits reject artboard documents before mutation. In a real PS 23.0
  file, adding an empty layer changed the document canvas width from 3394 to
  1346 even though every original layer and artboard rectangle remained intact.
  Read, preview, save, close and document-management tools remain available.
  Arbitrary JSX is still trusted execution and is not a safe workaround for
  this restriction. Recipes which open new documents internally are not
  certified for artboard content; use verified non-artboard copies only.
- `photoshop_save_document` stages PSD/PNG/JPEG outputs before publication,
  checks extension compatibility, and requires `overwrite:true` to replace an
  existing file. If a write times out, staging is retained for inspection while
  Adobe may still be using it. Other raw-script/recipe export paths do not inherit
  this file-publication guarantee.
- Legacy ExtendScript values are parsed as data, never evaluated as Node code.
  Unicode transport uses unique temporary directories and Unicode result files.
- Text calls preserve literal quotes and verify the characters after assignment.
  Smart-quote substitution is disabled for the entire ExtendScript call because
  position/font setters can also recompose text, then the original preference is
  restored alongside units/dialog settings in `finally`.
- Preview export strips XMP metadata only from its disposable duplicate,
  flattens before sizing, converts that duplicate to RGB/8-bit and validates the
  JPEG's encoded dimensions. Large document ancestry metadata previously made a
  tiny preview exceed 30 MB. Source metadata and document state are preserved.
- UXP availability requires a recent poll. Expired undelivered commands are
  removed; delivered timeouts retain their application lease until a real reply.
  A fixed-port collision is reported instead of silently incrementing ports.
  If a plugin never replies, stop its operation/restart the test application,
  restart its MCP server, then inspect state before acknowledging recovery.
  The server now requires plugin protocol 2; old plugins receive HTTP 426 and
  cannot consume commands. Reload the updated plugin when upgrading the bridge.
  Commands carry their deadline and scoped document id. The plugin checks the
  deadline before and after acquiring modal access, selects/verifies the exact
  target inside that modal scope, and rejects ambiguous or stale targets.
  Returned batchPlay error descriptors are failures, not successful results.
  Failed delivered operations remain quarantined for state inspection.
  A reply received after its deadline cannot become success even when the
  event loop has not yet run the timeout callback.

These UXP guards have regression tests with mocked Photoshop APIs and real local
HTTP transport. They are not certification of an installed Adobe UXP plugin.
API references: [modal execution](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/executeasmodal)
and [batchPlay result handling](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/batchplay).

If an interrupted filesystem write leaves a malformed lease or a stale
`reclaim.lock`, automatic recovery fails closed. Stop all MCP clients, wait for
their `cscript.exe` children to exit, and inspect the application without edits.
Only after confirming no operation remains, archive the safety directory and
restart the clients. Do not remove live locks to force a write through.

## Reproducible installation

Use Node 24.19.0 and the pnpm version in `package.json` for the tested Windows
baseline. `pnpm-lock.yaml` is tracked. For the stdio runtime only:

```powershell
pnpm install --frozen-lockfile --ignore-scripts --no-optional
node scripts/clean-dist.mjs
node node_modules/typescript/bin/tsc
```

Unit tests require platform-native optional development packages. Install with
`pnpm install --frozen-lockfile --ignore-scripts` before running
`node node_modules/vitest/vitest.mjs run`. Skipping optional packages can make
Vitest fail at startup even while the stdio server builds successfully.

Run lint, build, unit tests, prompt coverage and `scripts/verify-pack.mjs` after
changes. The read-only Windows probe is `scripts/verify-windows-bridge.mjs`.
See `scripts/boundary/README.md` for real-application tests. These commands do not
install the optional UI or Adobe UXP plugin.

## Release gate

The hardening code is not evidence that every advertised Photoshop operation
works. Record actual host versions and results per tool. In particular, PS 23.0
does not pass the project's generative-feature gates. A completed 60-minute run,
large PSD/PSB acceptance and a real Codex-host tool invocation remain separate
gates; incomplete/blocked gates must be reported, not inferred from unit tests.
