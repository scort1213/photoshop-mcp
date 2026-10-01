# Development

Use the local checkout and the versions pinned by package.json/pnpm-lock.yaml.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:server
pnpm run lint
pnpm run test:unit
pnpm run verify:photoshop-prompts
pnpm run verify:pack
```

The standard build compiles only the local server and disabled compatibility UI stubs. It does not install web dependencies or build historical cloud UI code. The clean step removes stale compiled modules before compilation; the pack check rejects cloud UI/telemetry implementations in the artifact.

Do not run legacy cloud/generative spike scripts as routine verification. No Adobe account/API-key setup is part of this fork's installation. Initial dependency installation may use the package registry; runtime startup must not install or update packages.

Real-application checks require dedicated synthetic documents and Photoshop Device processing for automatic selection. Preserve business documents and record Windows, macOS and actual MCP-client results separately. See [LOCAL_ONLY.md](../LOCAL_ONLY.md).
