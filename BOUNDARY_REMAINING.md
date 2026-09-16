# Remaining boundary acceptance checkpoint

This is a development checkpoint, not a completed release acceptance.

## Resumed acceptance (2026-09-16)

The current private ledger records **58 prior scoped passes, 57 additional limited passes, nine outstanding tools and four previously unsupported tools** (128 total). The resumed session added 28 tools with three real-app rounds. It also reran the artboard geometry cases and completed history rejection, hidden-descendant refusal and artboard close-with-save checks. The earlier checkpoint below is retained as history and its counts are superseded by this section.

Real rendering checks exposed and fixed source-history pollution in duplicate-only exports, visual reordering during layer organization, an incorrect recipe mask target, reversed sky blending, malformed stack input arrays and stack renderer calls, and passport sheet document targeting. Batch watermark failure now stops subsequent jobs; duplicate basenames receive distinct output paths. The actual output pixels, document IDs, source hashes and reopen results are recorded in the private run directory.

Dataset DOM calls are unavailable in the tested PS23 bridge. They now refuse explicitly instead of claiming an empty successful list; refusal and cleanup passed three rounds. LUT loading still failed to change pixels; an empty adjustment now raises partial_completion and keeps subsequent writes blocked. Neither refusal-only path counts as working functionality.

The installed default grayscale action timed out on a synthetic document, after which Photoshop rejected read-only COM calls as application_busy. No replay or blind recovery was performed. A user-facing recovery request is pending because the official Computer Use runtime still fails during kernel asset creation. Real UXP, native Codex tool entrypoints and the uninterrupted 60-minute Photoshop soak remain incomplete.

168 automated tests passed three rounds; TypeScript, lint, prompt coverage and pack checks passed. The three private original source hashes remained unchanged. Additional real runners cover exports, styles, guards, dataset rejection, LUT refusal, recipe layers, organization, stacks, remaining content tools, sky blending, recipe exports, batch recipes, enhancement and actions. The action runner is currently a reproducer of an unresolved timeout; `lut_cases.py --expect-refusal` only verifies failure containment.

The full CMYK/16-bit matrix, all gradient angles, textured frequency separation, batch output publication under disk/write faults, real portrait quality and remaining plugin/API blockers still require acceptance. Do not treat scoped happy-path passes as a complete release gate.

## Earlier checkpoint

## Changes

- Artboard crop, image resize, merge-visible and flatten create a unique PSB recovery copy, reopen it, compare geometry and layer/text structure, and only then execute the edit. The tool response includes the verified backup path. `PHOTOSHOP_RECOVERY_DIR` selects the local backup directory.
- Freeze artboard auto-expand/nest/position before saving the recovery copy: Photoshop 23 can otherwise change the original canvas while saving. Restore settings in success and failure paths. Managed save and save-on-close also protect artboard geometry.
- Verify operation-specific dimensions/coordinates. Merge-visible checks hidden root-layer structure; hidden descendants inside visible groups remain refused until certified. Recovery copies are never automatically applied to the original.
- Move-to-bottom now uses the lowest legal position, preserving a Background layer. History step counts must be integers; oversized undo/redo requests fail instead of silently performing fewer steps.
- Saving a selection restores component channels. Mask deletion uses Action Manager mask detection instead of an unavailable DOM property. Mask apply/delete address the layer mask explicitly; gradient painting selects the mask explicitly and restores channel selection. Automatic mask creation and painting execute in one script, with no error-triggered retry.
- Export-as and prepare-for-web stage outputs and refuse collisions. Recipe failures and partial-batch failures propagate through the bridge error path so partial writes cannot silently clear quarantine.
- UXP includes read-only diagnostics and generation-scoped polling. A command delivered to a hidden/stale polling loop is refused. The production minimum host remains Photoshop 24; a separate Photoshop 23 diagnostic manifest was tested locally and failed to load, so compatibility is not claimed.

## Evidence boundaries

The baseline contains 128 tools: 58 scoped real-app passes, 66 unverified and four unsupported. This checkpoint adds three real-app rounds for 14 RGB8 filter/color tools and 15 image/smart-object/history/ordering tools: **58 prior passes, 29 additional limited passes, 37 still unverified, four unsupported**.

Four artboard geometry operations completed three rounds on two-artboard synthetic files, including recovery-copy reopening, unsaved content, pixel checks and output reopening. These tools already existed among the baseline passes. Additional hidden-layer guards added afterward still need a final real-app regression.

Mask/selection regression exposed real channel/targeting defects. Fixes pass automated tests; the final three-round real-app run is incomplete because Photoshop began rejecting read-only COM requests. The last interrupted call was a read-only postcondition script. Do not automatically replay it as a write or clear quarantine without inspecting application state.

Photographic-filter rendering can differ by one RGB level after reopening; the regression records the maximum difference rather than claiming byte identity.

Still outstanding: full RGB/CMYK and bit-depth matrix, remaining tools and recipes, mask final regression, new output/recipe failure-path real-app tests, final artboard additions, real UXP plugin lifecycle/editing, native Codex entrypoint acceptance and a separate uninterrupted Photoshop 60-minute soak. Existing Illustrator results are unchanged.

## Repeatable local commands

Set `ADOBE_BOUNDARY_RUN` to a new private evidence directory and `PHOTOSHOP_RECOVERY_DIR` to its recovery subdirectory. The runners use the current user's Codex MCP configuration. Run one Photoshop real-app runner at a time:

```text
python scripts/boundary/artboard_geometry_cases.py
python scripts/boundary/filter_color_cases.py
python scripts/boundary/object_history_cases.py
python scripts/boundary/selection_mask_cases.py
```

The runners stop on unexpected results and retain evidence. A failed run may leave its synthetic test document open for inspection. Never close documents by name alone; use the recorded IDs and paths. Do not restart Adobe while business documents remain open.

After updates run the unit suite, TypeScript build, lint, prompt-coverage and package checks, then rerun the exact formerly failing real-app cases three times. Mocked plugin tests do not establish a real UXP connection. Stdio test clients do not establish native Codex tool acceptance.

Private images, PSB recovery copies, original hashes and detailed call logs stay outside the repository.
# Follow-up: angle geometry and version eligibility

The follow-up fixes Generate Image's separate Photoshop 25.11 version floor and
the previously ignored angle override in both gradient-mask tools. Explicit angles
use pixel-space geometry (0 degrees right, 90 degrees up); omitted angles retain
existing directional behavior. Unconfirmed gradient results are errors.

193 unit tests passed in each of three consecutive runs; TypeScript, ESLint,
prompt coverage and package checks passed. These are not new real-app passes.
The new `scripts/boundary/gradient_angle_cases.py` acceptance runner stopped on
`application_busy` at document enumeration before any edit. Generate Image's live
rejection check was likewise blocked before its version gate. Computer Use still
fails during kernel asset creation, including after a kernel reset. Persistent
quarantine was not cleared and the timed-out action was not replayed.

The recorded count remains 115 scoped passes, 9 outstanding, and 4 deferred.
Angle overrides require real alpha-pixel and PSD-reopen acceptance before claiming
them as verified. Private evidence is in the local `20260916-execution` run.
# Restart acceptance supersedes the previous busy state

Photoshop responded after restart. Both gradient tools passed 36 real RGB8 cases
(six angles, three rounds) with alpha geometry and exact PSD-reopen verification.
The initial acceptance assumed linear alpha incorrectly; the final oracle uses
Photoshop's measured monotonic horizontal tone curve as a spatial reference.
Ten fresh stdio MCP read connections passed. Five generative tools rejected PS23
with `version_unsupported` in three rounds without changing inspected state.
Generate Image is now classified as version-unsupported: 115 scoped passes,
8 outstanding tools, and 5 unsupported tools (128 total).

The LUT filename experiment did not load data and was reverted. LUT quarantine,
explicit recovery, unchanged pixels and PSD reopen passed three refusal rounds;
LUT rendering is still outstanding. The 13 restored documents were preserved.
Computer Use initialization, native Codex tool acceptance, real UXP and the
uninterrupted 60-minute PS soak remain outstanding. Ten read reconnections do
not substitute for the mixed-write soak. Private evidence: `20260916-restart`.
