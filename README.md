# Photoshop MCP — local-only fork

Control local Adobe Photoshop through MCP on Windows and macOS. This fork keeps ordinary editing, recipes, custom ExtendScript and recorded actions while disabling built-in cloud generation, usage telemetry and standalone cloud chat.

- [Local-only behavior, setup and limits](LOCAL_ONLY.md)
- [中文说明](README.zh-CN.md)
- [Windows setup](WINDOWS_CODEX_SETUP.md)
- [Validation status](LOCAL_ONLY_ACCEPTANCE.md)
- [Tool reference](docs/available-tools.md)
- [Boundary and recovery behavior](BOUNDARY_HARDENING.md)

## Install this checkout

Node.js 18+ and pnpm 10.33.0 are required. Install dependencies explicitly, then build:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:server
```

Configure your MCP client with local absolute paths:

```json
{
  "mcpServers": {
    "photoshop": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/photoshop-mcp/dist/index.js"],
      "env": { "LOG_LEVEL": "2" }
    }
  }
}
```

The client starts the server automatically. Use `photoshop_get_state` before editing and preview after meaningful changes. On Windows use the equivalent full `.exe`/checkout paths. macOS may require Automation permission to control Photoshop; that is an OS permission, not a cloud account login.

Use this fork's compiled checkout, not the upstream npm package. Initial installation downloads dependencies; runtime startup performs no package installation or account validation. Statistics are permanently disabled regardless of environment variables.

## Editing behavior

Ordinary layers, text, selections, masks, transforms, local file operations and recipes remain available. Object removal uses local content-aware fill. Skin retouching uses ordinary frequency separation. Sky compositing uses a local sky image.

Built-in Firefly and Neural Filter tools return `cloud_disabled` and are omitted from tool discovery. The standalone chat UI is disabled. The current tool list returned by MCP is authoritative.

For Select Subject, automatic background removal and passport photos, first set Photoshop **Settings/Preferences → Image Processing → Select Subject and Remove Background → Device**. This setting is a prerequisite, not something this MCP can reliably force.

Custom scripts and recorded actions remain flexible, trusted code. Instructions prohibit cloud/network/login operations, but there is no script sandbox or enforcement parser. Adobe's own licensing/background processes and your AI client's model processing are outside this project's guarantee.

Fixed tools take real local absolute paths; relative paths, `~`, aliases and shortcuts are rejected. Normal Unicode, quotes, spaces and percent signs in filenames work. Default exports still go to the local MCP exports folder.

`photoshop_close_document({save:true})` now saves and keeps the document open. Its result explicitly says `saved:true, closed:false`; closing is a separate user decision. Timeouts never trigger an automatic retry.

## Validation

```sh
pnpm run lint
pnpm run build:server
pnpm run test:unit
pnpm run verify:photoshop-prompts
pnpm run verify:pack
```

Real Photoshop and MCP-client checks are recorded separately in [LOCAL_ONLY_ACCEPTANCE.md](LOCAL_ONLY_ACCEPTANCE.md).

Based on [alisaitteke/photoshop-mcp](https://github.com/alisaitteke/photoshop-mcp), licensed under MIT. This project is unofficial and is not affiliated with Adobe.
