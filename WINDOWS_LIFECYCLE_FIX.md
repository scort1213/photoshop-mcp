# Windows stdio shutdown repair: 1.7.14-windows.2

This revision follows `35912470b4ccd285bd30d5468ffceb005a1623f0` on the
independent Windows branch. The original accepted checkout is preserved as a
rollback point; it must not be rebuilt or replaced while another task uses it.

## Observed failure

A downstream real Photoshop exercise saved a 105,353-byte synthetic PSD,
then its next close request returned `queue_timeout: operation was not
dispatched`. Inspection recorded an empty shared `active.json`. Subsequent
persistent-client runs completed 16 continuation calls and a 24-call native-text
save/reopen workflow, but those runs were a caller mitigation, not an upstream fix.

The old server exposed stdio before detached `Session.initialize()`. A successful
session ping launched another detached version query. EOF called `stop()`, which
only changed a session flag before the entry point called `process.exit()`.
Lease acquisition creates `active.json` before writing its owner JSON. The old
client also used SDK shutdown that could escalate to process termination. This
code and the recorded timing support an interrupted lease publication; no
process trace captured the exact interrupted filesystem instruction.

## Repair

- Startup only exposes protocol discovery. Adobe detection and version queries
  belong to explicit tool requests, with no detached startup or analytics work.
- Shutdown closes admission synchronously, waits for every accepted tool handler
  including pre-dispatch detection, then drains actual queued operation jobs and
  their original lease cleanup before the process exits.
- A deadline may reject a tool promise before its native bridge finishes. The
  drain tracks the job's final completion separately, without retrying, releasing
  its lease twice, or clearing its unknown-outcome marker.
- Local callers use EOF and observed natural process exit. They never escalate
  to a kill signal. The persistent helper keeps one connection through the
  workflow and stops further dispatch after an error response or exception.
  A transport error arriving between requests is recorded synchronously, so
  the next request is refused before anything is written to stdin.
- The one-request helper writes the original response and shutdown evidence.
  Its success requires a successful natural server exit, not only a tool reply.

See [WINDOWS_USAGE.md](WINDOWS_USAGE.md) for the revised one-request and persistent
APIs. Do not copy the previous one-request caller from the rollback revision.
The downstream mitigation that waits for a startup initialization log is not
compatible with this revision, because startup intentionally performs no Adobe
initialization. Use this revision's helper and verify the server version.

## Scope

This fixes normal EOF and cooperative shutdown. It does not make lease JSON
publication crash-safe, recover a historical malformed lease, or guarantee
survival of a forced process kill or power loss. Empty/malformed lease files and
unknown outcome markers remain fail-closed for explicit inspection. No caller
or shutdown handler deletes unknown locks, switches safety roots, or silently
recovers another client's state.

The lease format and cross-process exclusion policy are unchanged. Mac source
history and the remote `master` branch are preserved; this Windows revision does
not claim new real-app acceptance on macOS.

## Validation

On Windows with Node 24.19.0 and Photoshop 23.0.0:

- All 54 test files / 359 tests passed, together with lint, server build,
  prompt coverage, package verification and the unchanged 112 tools / 20 prompts.
- Three separate one-request state reads each ended with exit code 0, no signal,
  no forced kill, and no active lease or uncertainty/reclaim marker left behind.
- The 58-call synthetic native-text/layer/mask/Multiply workflow passed through
  PSD save and reopen. Its server exited naturally and the application ended
  with no open documents.
- A 31-call real fault workflow timed out a dispatched 4-second Photoshop edit
  after 2 seconds, then immediately sent EOF to that MCP process. Shutdown took
  a further 2,864 ms and ended naturally with code 0. The edit completed exactly
  once, `active.json` disappeared, and `uncertain.json` remained present.
  The second client reconciled the owned document before explicit recovery;
  queued work never dispatched. Partial-change recovery also passed. Only the
  owned fixture was closed, and both servers exited with code 0 and no signal.

The process-drain and lease-publication tests deliberately pause synthetic
operations at precise boundaries. They are offline tests, separate from the
real Photoshop checks above. The first full helper run exposed an unrealistically
short simulated handshake deadline; only that test timing was corrected. A
separate deterministic test reproduced a transport error between requests and
verified that the repaired caller refuses the next dispatch.

Private raw responses, process IDs, sentinel files and shutdown records remain
outside the repository. The earlier broad Windows evidence remains in
[WINDOWS_ACCEPTANCE.md](WINDOWS_ACCEPTANCE.md), with its original version and scope.
