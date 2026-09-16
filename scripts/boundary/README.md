# Windows boundary acceptance

Run these tests only while Adobe is reserved for testing. The runner reads the
exact `photoshop` and `illustrator` stdio commands from the local Codex config.
It refuses to close documents outside the dedicated run directory. It does not
upload fixtures, screenshots or logs.

## Reproduce the checks

Build this checkout first. Python 3.12+ is required for the stdio runner.

```powershell
$env:ADOBE_BOUNDARY_RUN = 'D:\codex\Adobe-MCP-boundary-tests\new-run'
$env:PYTHONIOENCODING = 'utf-8'
# Optional: ADOBE_BOUNDARY_CONFIG overrides ~/.codex/config.toml.
python scripts/boundary/boundary_suite.py inspect
```

Close/save any business documents yourself before continuing. In a fresh run,
both applications must have no open documents. Then run in this order, for each
application (`ps`, then `ai`):

```powershell
python scripts/boundary/boundary_suite.py smoke ps
python scripts/boundary/fault_tests.py ps
python scripts/boundary/cross_client_faults.py ps
# Required for the Illustrator application-termination test only:
$env:ADOBE_BOUNDARY_ILLUSTRATOR_EXE = 'D:\path\Illustrator.exe'
python scripts/boundary/lifecycle_tests.py ps
python scripts/boundary/boundary_suite.py soak ps 3600
```

Replace `ps` with `ai` to test Illustrator. Do not run fault injection while a
soak is running: quarantine deliberately blocks all clients' subsequent writes.
The lifecycle test kills an in-flight MCP process, inspects/reconciles the
document, closes only test documents, confirms zero documents, and then stops
the exact inspected Adobe process before relaunch/reopen.

The soak checks available RAM (4 GiB), C: free space (15 GiB), and D: free space
(30 GiB) before each cycle. Crossing a threshold records an incomplete run;
it never becomes a pass. Create `ps-stop` or `ai-stop` inside the run directory
for a graceful stop before the next cycle. Remove the stop file before restarting.
The 60-minute timer starts over after an interruption.
During an Illustrator soak, the exact minimized-window `isError` response is an
expected negative capture check only when it contains no image. It increments
`minimized_refusals`; actual captures increment `preview_successes`. All other
capture failures still stop the run. Report both counters, including zero
successful captures; never describe a refusal as a successful screenshot.

`python scripts/boundary/content_cases.py` adds bounded Photoshop mask-pixel,
duplicate-layer, lock, smart-object, text and 16-bit color-mode assertions after
the smoke run. It records partial passes and failures separately, and compares
rendered text bounds for x=0 because PS 23.0 can reject the text-position getter
for multiline/emoji content. Retain each round's result separately.

For real fixtures, pass only copies prepared by this helper:

```powershell
python scripts/boundary/prepare_fixtures.py 'D:\source\example.psd' 'D:\source\example.psb' 'D:\source\example.ai'
python scripts/boundary/real_fixtures.py ps
python scripts/boundary/real_fixtures.py ai
```

`fixtures.json` records original hashes. Real-fixture tests edit/save/reopen the
copies and compare structure and original hashes. Do not rerun a fixture test
against already modified fixture copies; prepare a fresh run instead.
Artboard documents exercise explicit rejection of editing, followed by an
unchanged save/reopen check. Their `edit_boundary` is recorded as unsupported,
not as a successful edit. Non-artboard PSD/PSB files exercise editable text.

`python scripts/boundary/illustrator_content_cases.py 1` creates a fresh case
directory for editable Unicode, two artboards, clipping groups, missing fonts,
missing/restored image links and pixel-checked PNG/JPEG exports. Use distinct
round numbers for repetitions. `--skip-preview` permits document-only checks
when the application window is unavailable; preview remains explicitly unverified.
The same flag is supported by the Illustrator real-fixture check. Stored emoji
characters do not prove that the selected font renders their glyphs correctly;
inspect the exported image and supply a suitable font where needed.
`python scripts/boundary/illustrator_cleanup_cases.py` verifies three forced MCP
exits after observed Adobe dispatch, followed by state inspection, explicit
recovery and reclamation of dead owners' script directories. Do not run this
fault injection during an Illustrator soak.

## Evidence and limits

`calls.jsonl`, tool inventories, screenshots and per-stage JSON results live
only under `ADOBE_BOUNDARY_RUN`. A transport success is not a document assertion.
An interrupted soak, an untested tool, a mocked fault, and a real Adobe success
must be reported separately.

Direct stdio acceptance does not prove Codex's current task has loaded the
servers. After Codex reloads the configuration, complete read/edit/preview/save/
reopen through the actual exposed MCP tools and retain that evidence separately.

After an upgrade, use a fresh test directory and run unit/build checks, smoke,
faults, and lifecycle before the full soak. Reproduce every previously failed
case three times. The large-file test requires fresh fixture copies. Record the
commit, Adobe version and dependency-lock hash with the new results; never carry
an earlier version's pass forward automatically.

Arbitrary JSX and recorded Photoshop actions are trusted code. Target checks
are not a sandbox; such code can explicitly switch documents or access files.
No claim is made that an executing Adobe operation can be forcibly cancelled or
rolled back. An in-flight timeout requires inspection and explicit recovery.

## Authorized coexistence soak

If the operator explicitly permits running alongside business documents, use
`coexist_soak.py <test-document-id> 3600 <allowed-other-ids...>` for Photoshop.
Use `'*'` only when the authorization also covers changing work documents.
The target must already be open inside the run directory. Every edit, preview,
and save pins that ID; only the test output path is written. After a successful
call the previous tab is restored if the active tab is still the test target.
Changes in other documents' metadata during a call are logged and stop the run
for attribution in the fixed-ID mode. With explicit `'*'` authorization they are
recorded as concurrent activity and do not stop the targeted-operation soak;
foreign-document integrity is then explicitly outside the pass assertion.
No documents are closed and no Adobe processes are stopped. The ordinary
fault/lifecycle guard remains strict and does not inherit this exception.

Manual editing and clients bypassing the application mutex cannot be serialized
by this harness. Metadata equality is not proof of pixel immutability. Coexistence
results must be labeled separately from exclusive fault-injection acceptance.

`preflight_cases.py <test-document-id>` verifies that omitted/stale targets
reject before the script body without poisoning the shared write state, while
a body that modifies the test layer and then fails remains quarantined. It
requires multiple already-open documents and an existing test target inside the
run directory. It never recovers a pre-existing unknown state at startup.

`flat_export_cases.py <test-document-id>` verifies PNG transparency, JPEG pixel
comparison, and Adobe reopen/close of only the exported test copies for three
rounds. It waits up to 60 seconds on read-only `application_busy` readiness
rejections; no edit/open/save/close request is automatically retried.

On Windows, `readonly_save_case.ps1 -RunRoot <run-directory> -TargetId <id>
-PythonCommand <MCP-python-path>` creates a unique empty child directory, denies
the current account write access there, verifies three real MCP save failures
leave no partial files, and restores the original access entries/owner/group in
`finally`. A write probe verifies restoration. The OS may set its auto-inherited
ACL bookkeeping flag. No business directory permissions are changed. If local
script execution is disabled, run this reviewed script with process-scoped
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File ...`; do not change the
machine execution policy.
