# Troubleshooting

- `cloud_disabled`: the requested built-in cloud/native operation is intentionally unavailable. Use content-aware fill, ordinary retouching, local image composition or another local tool. Do not sign in or buy credits to recover.
- Standalone UI exits: use this checkout's stdio entry point, `node /absolute/path/photoshop-mcp/dist/index.js`.
- Photoshop unavailable: open the installed application, confirm OS Automation permission on macOS, and check `PHOTOSHOP_PATH` if needed. Adobe's own licensing is outside the MCP.
- Automatic selection/background removal: select Device in Photoshop Image Processing. If unconfirmed or unavailable, use manual selection or Color Range; do not switch to Cloud.
- Non-local or missing path: choose an available file on a local disk. URLs and network volumes are not valid fixed-tool inputs. Missing destination on close: save explicitly to a local path first.
- `queue_timeout`: the operation was not dispatched. `outcome_unknown`: inspect state and partial changes; never automatically retry an executing write. Explicit recovery does not undo or replay edits.
- Old cloud tools still appear: check that the client uses this fork's `dist/index.js`, rebuild and reload the client. An upstream npm package or another checkout has different behavior.

Custom JSX/actions remain instruction-constrained, not sandboxed. See [LOCAL_ONLY.md](../LOCAL_ONLY.md).
