# Architecture

The local-only fork connects an MCP host to the installed Photoshop application:

```
MCP host → stdio → Node MCP server → local AppleScript (macOS) / COM (Windows) → Photoshop
```

The server registers ordinary editing tools and local recipes. It provides state/preview/capability tools, targeting guards, cross-process serialization, timeout quarantine and explicit recovery. See [BOUNDARY_HARDENING.md](../BOUNDARY_HARDENING.md).

Cloud/native-sky tools are omitted from discovery and blocked before Adobe dispatch. Recipes use their local implementations. The analytics compatibility surface is a no-op. Historical cloud UI modules are excluded from the local build; the remaining UI entry points are disabled stubs. No companion Neural Filter bridge is started.

Custom scripts and recorded actions remain trusted, unsandboxed code, governed by server/tool instructions. Select Subject depends on the user's Device preference. This architecture does not firewall Adobe or the AI host, and does not claim isolation from arbitrary scripts.

The advertised tool list, rather than historical upstream tool counts, is authoritative. See [LOCAL_ONLY.md](../LOCAL_ONLY.md) and [acceptance evidence](../LOCAL_ONLY_ACCEPTANCE.md).
