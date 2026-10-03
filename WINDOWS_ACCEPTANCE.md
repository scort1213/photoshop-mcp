# Windows acceptance: 1.7.14-windows.1

Tested on 2026-10-03 UTC with Windows, Photoshop 2022 **23.0.0**, Node
**24.19.0**, MCP SDK **1.30.0**, and the local-only source baseline
`cf29ab654b5362759316edad1be98c4c01769779`.

The original `codex/boundary-hardening` local head `5176393` is an ancestor of
that baseline. The remote advertised only `master` when inspected; the new
work is isolated on `codex/windows-acceptance-20261004`. The original installation
and the Mac-validated source were preserved. No Mac implementation was changed
or merged by this work.

## Repairs

- Allow Node on a different local drive from Windows, while resolving system
  tools through absolute SystemRoot/SystemDrive paths and rejecting links.
- Read the actual Windows COM host version even for versionless/misleading
  installation paths. Sort registry versions numerically, try valid fallback
  entries, and discover current/upcoming year installation folders.
- Require a per-invocation dispatch flag after the bridge PID is recorded in
  the shared lease. An unregistered orphan cannot start a Photoshop operation.
- Parse literal CR characters emitted by Photoshop 23 `toSource()` for native
  multiline text. Preserve all characters without evaluating JavaScript. Other
  unsupported raw control characters and executable expressions remain unparsed.
- Make test fixtures portable to Windows without weakening path, targeting,
  quarantine or no-execution assertions. Add Windows/Ubuntu branch CI.

## Automated evidence

**50 test files, 331 tests passed** on the actual Windows machine. Lint,
TypeScript/server build, prompt coverage, tool counts and package verification
passed. Discovery exposes **112 tools and 20 prompts**. Windows bridge handshake
fault unit tests use real Windows Script Host with a synthetic COM body; those
tests are not Photoshop functionality evidence.

## Real Photoshop evidence

All application checks used this checkout's built `dist/index.js` over MCP
stdio and the real Photoshop COM host, sequentially. No business original was
edited or uploaded.

- A 640x360 RGB synthetic run completed **58 protocol/tool calls**. It verified
  local Chinese font selection, editable text creation/update, layers, grouping,
  Multiply, a layer mask, a JPEG preview, and PSD/PNG output with Chinese,
  spaces, apostrophes and percent signs in the filename.
- PSD signature/dimensions and PNG signature/dimensions passed. Background
  pixels were `(238,242,249)`; the masked Multiply rectangle sample was
  `(112,161,205)`. Samples outside the mask matched the background. JPEG pixels
  before and after PSD reopen were identical. The synthetic rendering was
  visually inspected and the Chinese title was legible.
- Existing-output refusal preserved the file hash. Invalid and ambiguous
  document targets did not change the fixtures. `close(save:true)` returned
  `saved:true, closed:false` and kept the same document open, as contracted.
- A private historical output of the two PSD skills had **15 layers, 2 native
  text layers, 2 groups and 9 masks**. A copy passed text update, 5px group move
  and restore, visibility toggle and restore, saved PSD reopen, and metadata
  comparison. The original SHA-256 was unchanged.
- A second private PSD copy had **201 layers and 42 masks**, with no text or
  groups. All layer/mask metadata and dimensions survived save/reopen; the
  original SHA-256 was unchanged. This case does not claim editable-text coverage.
- The historical multiline title exposed the CR parser defect. Two stopped
  runs were retained as failures. The same real response then parsed as an
  object with all **7 literal CRs preserved**, followed by the successful full
  fixture run. Failed attempts were not counted as passes.
- Two independent MCP processes passed real timeout and recovery checks using
  one 64x64 synthetic document. A disk sentinel proved the JSX body started;
  the 2s call timed out while its 4s edit later completed exactly once. The
  queued second client received `queue_timeout` and never edited. Quarantine
  blocked further writes. Read-only reconciliation preceded explicit recovery,
  which preserved the completed edit. A subsequent intentional partial-change
  error also blocked writes and recovered only after inspection.
- All owned test documents were explicitly closed on successful completion.
  Verified disposable private PSD copies were removed; originals and compact
  local evidence were retained. No recycle bin was emptied.

## Scope and reproduction

See [WINDOWS_USAGE.md](WINDOWS_USAGE.md) for the exact protocol workflow and
the three live acceptance runners. Run them sequentially, with the same shared
runtime/safety roots as every other client controlling that Photoshop instance.

These results do not certify every one of the 112 tools, every Adobe release,
long-duration stress, all business artwork pixels, or a native AI host's reloaded
tool menu. The private fixture masks were checked structurally; mask/Multiply
pixel behavior was checked separately on the synthetic image. Cloud functions
remain disabled. Original Mac acceptance remains in
[LOCAL_ONLY_ACCEPTANCE.md](LOCAL_ONLY_ACCEPTANCE.md), with its own scope.

Raw material, previews and machine-specific logs are intentionally kept outside
the Git repository. Remote branch identity, restoration and CI results are
recorded separately after publication.
