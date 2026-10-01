# Standalone chat disabled

This local-only fork supplies a stdio MCP integration. The historical standalone cloud chat UI, provider/API-key validation and CLI account checks are unavailable. Running its compatibility CLI exits with a local explanation before opening a browser, starting a listener or checking any account.

Configure your existing MCP client with the local Node executable and this checkout's `dist/index.js`. No model key or separate account is required by the MCP. Your client's own model processing is outside the MCP's local operation policy.

See [LOCAL_ONLY.md](../LOCAL_ONLY.md).
