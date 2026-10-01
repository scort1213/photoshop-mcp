process.stderr.write(
  'Standalone chat UI is unavailable in this local-only build. Connect your existing MCP client to dist/index.js instead.\n'
);
process.exitCode = 1;
