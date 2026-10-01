# AGENTS.md — local-only photoshop-mcp

Start with [LOCAL_ONLY.md](LOCAL_ONLY.md) and [llms.txt](llms.txt).

## Runtime and tool policy

- Configure the MCP client to run the local Node executable with this checkout's `dist/index.js`. Never substitute the upstream npm package.
- This fork permanently disables usage statistics, standalone cloud chat, model/account validation, Firefly tools, Neural Filters and native sky automation. Do not restore them or suggest login/credits as a recovery step.
- Use local content-aware fill for removal, local frequency separation for retouching and local images/masks for compositing.
- Select Subject, background removal and passport photos require Photoshop Image Processing set to Device. Do not switch to Cloud or invent an unverified descriptor to force Device.
- Keep `photoshop_execute_script` and `photoshop_play_action` available. Use only local editing, local assets/fonts and local file destinations in custom JSX and recorded actions. Do not issue network requests, cloud operations, online font activation, browser/login commands or a cloud fallback.
- Scripts/actions are trusted code with instruction-only restrictions, not a sandbox. Do not claim an unbypassable offline guarantee.
- Adobe's own licensing/background services and the AI host's cloud processing are out of scope.

## Workflow

1. Discover current tools/prompts and read capabilities.
2. Read `photoshop_get_state`; pin mutating tools to the target `document_id`.
3. Prefer a matching local recipe, otherwise ordinary tools or local JSX.
4. Inspect a preview after meaningful edits. Never automatically retry `outcome_unknown`; inspect state and explicitly recover.

## Development

Install dependencies explicitly with `pnpm install --frozen-lockfile --ignore-scripts`, then `pnpm run build:server`. Runtime startup must not download packages. Keep analytics permanently disabled even when old environment variables ask to enable them.

Before delivery run lint, build:server, test:unit, verify:photoshop-prompts and verify:pack. Record real-app and client checks separately for Windows/macOS; untested platforms remain unverified.

Canonical code/comments/commits/PRs are English. Do not add AI-attribution footers. Preserve the existing targeting, mutex, timeout and recovery safeguards.
