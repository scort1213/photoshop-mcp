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

`python scripts/boundary/content_cases.py` adds bounded Photoshop mask-pixel,
duplicate-layer, lock, smart-object, text and 16-bit color-mode assertions after
the smoke run. This runner has not completed real-application acceptance yet;
its current first observed result is the business-document guard refusing edits.

For real fixtures, pass only copies prepared by this helper:

```powershell
python scripts/boundary/prepare_fixtures.py 'D:\source\example.psd' 'D:\source\example.psb' 'D:\source\example.ai'
python scripts/boundary/real_fixtures.py ps
python scripts/boundary/real_fixtures.py ai
```

`fixtures.json` records original hashes. Real-fixture tests edit/save/reopen the
copies and compare structure and original hashes. Do not rerun a fixture test
against already modified fixture copies; prepare a fresh run instead.

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
