# Windows and Codex setup

This fork's `codex/windows-setup` branch was verified on Photoshop 2022
(23.0.0), Node 24.19.0, and this project's MCP server version 1.7.14.

The newer `codex/boundary-hardening` branch adds strict target validation,
cross-process serialization, timeout quarantine and explicit recovery. It exposes
119 tools. See [the hardening contract](BOUNDARY_HARDENING.md) and
[the acceptance runner](scripts/boundary/README.md) for its separate release gates.
The historical smoke results below do not certify every tool or the stress gates.

Install and build the MCP server from this checkout:

```powershell
pnpm install --frozen-lockfile --ignore-scripts --no-optional
node scripts/clean-dist.mjs
node node_modules/typescript/bin/tsc
codex mcp add photoshop --env ANALYTICS_DISABLED=1 --env LOG_LEVEL=2 --env 'PHOTOSHOP_PATH=C:\absolute\path\Photoshop.exe' -- C:\absolute\path\node.exe C:\absolute\path\photoshop-mcp\dist\index.js
```

This installs the stdio MCP integration. The standalone chat UI and optional
UXP plugin are not built or installed by these steps. Restart Codex after
adding the server. Do not point Codex at an upstream npm package when using
the fixes in this fork.

Keep Node and the checkout in persistent installation directories, not inside
Codex's internal runtime cache. Cleaning that cache must not remove the executable
referenced by the MCP configuration. After moving an installation, verify both
the executable and `dist/index.js`, rebuild with the frozen lockfile, and test
the exact configured stdio command before reloading Codex.

Local fixes:

- Transfer COM results through a UTF-16 file instead of the console code page,
  preserving Chinese document/layer names and error messages.
- Query Photoshop's actual runtime version when Windows discovery returns a
  marketing year such as 2022; this prevents false generative-feature claims.
- Require a recent companion-plugin poll before reporting the UXP bridge as
  connected. A running local HTTP server alone is not a connected plugin.

Verified over MCP stdio: discovery of 118 tools, state and layer reads, document
creation, fill, editable text creation/update, custom JSX, Chinese PSD/PNG
filenames, preview image, and PSD reopen with three preserved layers. These
checks do not imply all 118 operations or newer AI features work on PS 2022.

Read-only regression probe (Photoshop must be installed):

```powershell
$env:ANALYTICS_DISABLED = '1'
$env:PHOTOSHOP_PATH = 'C:\absolute\path\Photoshop.exe'
$env:PHOTOSHOP_UXP_BRIDGE_PORT = '0'
node scripts/verify-windows-bridge.mjs
```

The probe checks Unicode success/error results, runtime version gates, and
absence of a plugin on a fresh bridge port.
