# Remaining boundary acceptance checkpoint

This is a development checkpoint, not a completed release acceptance.

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
