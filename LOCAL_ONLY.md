# Local-only MCP build

This fork controls local Photoshop through MCP stdio. Install dependencies explicitly once, build the server, then run the resulting local executable. Runtime startup does not install packages, open a browser, validate an account, or send usage analytics.

## Enforced built-in behavior

- Analytics and beta content sharing are permanently disabled. Old analytics environment variables cannot enable them.
- The standalone cloud chat UI, provider/API-key validation and CLI account checks are disabled. Its old entry point exits with an explanation before starting a server or opening a browser.
- Firefly generation, generative fill/remove/expand/upscale, Neural Filters and the native-sky tool are not advertised. Direct requests fail with `cloud_disabled` before an Adobe operation.
- Distraction removal uses content-aware fill immediately. Portrait enhancement uses ordinary local retouching. Sky blending uses an existing local image and a gradient mask.
- Explicit requests for the removed cloud/native branches fail rather than silently attempting them.
- Fixed file tools require native absolute paths, including image references inside XML/CSV. URLs, relative paths, `~`, network/unknown mounts, Finder aliases, Windows shortcuts and Adobe volume-name ambiguities are rejected before accessing their targets. Valid local symlinks are resolved first; literal percent signs, spaces, quotes and Unicode names are encoded once for Adobe.
- `photoshop_close_document(save:true)` saves a verified local copy and **keeps the document open**, returning `saved:true, closed:false` with its path and document ID. It reuses existing PSD/PSB/JPEG/PNG/TIFF filenames; otherwise provide a supported local destination. Failures also leave the document open. Do not automatically follow with `save:false` or custom close code; the user decides when to close/discard.
- Both platforms serialize calls across MCP clients. Save operations hold one lease through target selection, Adobe save, file verification and publication. A timed-out write blocks subsequent writes until explicit state inspection and recovery; no automatic retry or uncertain-file cleanup occurs.
- Scripts, previews and CSV/XML staging use unique directories under the verified local MCP home. Preview reads/cleanup use the server's allocated path, never an arbitrary path returned by Adobe. Unsafe configuration fails before discovery or file creation; runtime does not consult Adobe `Folder.temp`.
- Historical live-cloud probe commands are removed. Cloud tests assert refusal instead of attempting a cloud feature.

## Preserved flexibility and its limit

`photoshop_execute_script` and `photoshop_play_action` remain available with their existing scripting freedom. They are trusted code, not a sandbox. The server instructions and tool descriptions require the calling assistant to avoid cloud operations, online assets/fonts, network requests, external login commands and cloud fallbacks.

This guidance does not technically prevent a custom script or recorded action from ignoring the policy. Do not describe this build as an unbypassable offline sandbox. Adobe's own licensing/background processes, third-party filesystem sync and the AI host's model processing are outside this guarantee.

## Photoshop setting required for automatic selection

Select Subject, background removal and passport-photo tools are retained. Before using them, choose **Device** for **Select Subject and Remove Background**:

- Windows: Edit → Preferences → Image Processing.
- macOS: Photoshop → Settings → Image Processing.

Keep this setting on Device. The integration does not have a verified API to force or attest that preference; it is a documented setup and acceptance prerequisite. If the setting is unconfirmed, use a manual selection or local Color Range instead. Do not use a cloud fallback.

## Install and run

Install Node.js and the pinned pnpm version first. Initial dependency installation requires the package registry; ordinary execution does not.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:server
node /absolute/path/photoshop-mcp/dist/index.js
```

Configure the MCP client with the absolute path of Node and this checkout's `dist/index.js`. Do not use `npx @alisaitteke/photoshop-mcp`: that is the upstream published package and is not this modified checkout. `ANALYTICS_DISABLED=1` may remain in old configurations but is no longer necessary.

The compatibility command `photoshop-mcp-ui` reports that standalone cloud chat is disabled. Use the stdio entry point above.

## Validation contract

Check both Windows and macOS independently:

1. Initialize and list tools/prompts, perform ordinary local operations, exercise errors/reconnect and shut down. No MCP-owned external network request or account validation should occur.
2. Directly call every blocked tool and every explicit cloud option. The result must be `cloud_disabled`, without dispatching that operation to Adobe.
3. With Device processing selected, create/edit a synthetic document, change text and layers, preview, save/export locally, close and reopen it. Test real file and document targeting errors without modifying business documents.
4. Inspect custom scripts generated by the AI client during representative tasks for compliance with the guidance. This is behavioral validation, not proof that arbitrary scripts cannot bypass the policy.
5. Record automated tests, real-application checks and client checks separately. Never claim a platform passed without its actual result.

See [acceptance evidence](LOCAL_ONLY_ACCEPTANCE.md) for the current verification status.

## Path configuration

The default home is the user's local `.photoshop-mcp` directory. `PHOTOSHOP_MCP_HOME`, `PHOTOSHOP_SAFETY_DIR`, `PHOTOSHOP_RECOVERY_DIR` and `PHOTOSHOP_PATH` overrides must be unambiguous native absolute local paths. Internal temporary files do not use `TMPDIR`, `TEMP` or `TMP`. Every new job rechecks its roots.

On Windows, Node may reside on a different local drive from Windows. System executables are resolved through the real `SystemRoot` anchored to `SystemDrive`; linked system directories are rejected without a PATH/network fallback. Windows real-app acceptance is recorded separately.

On macOS, automatic installation discovery is restricted to the verified local `/Applications` directory. For a different local installation, set `PHOTOSHOP_PATH` explicitly.

When upgrading from a build that used the system temporary directory for its safety files, let all outstanding operations finish, inspect Photoshop state, and stop/reload **every MCP client together**. Old and new clients must not run concurrently with different lock roots. Old quarantine files are not automatically cleared or migrated; resolve any uncertain operation before changing the root. The local launcher continues to point to this checkout's `dist/index.js`.
