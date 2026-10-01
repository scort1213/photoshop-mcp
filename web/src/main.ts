// Historical web assets are not part of the local-only distribution.
// Keep this entry inert even if someone starts the old Vite development server.
document.body.textContent =
  'Standalone chat UI is unavailable in this local-only build. Connect your existing MCP client to dist/index.js instead.';
