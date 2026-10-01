# Usage analytics disabled

This local-only fork never records or sends usage analytics or beta chat content. The compatibility analytics API is a no-op: no anonymous install ID, analytics storage, timer or outbound request is created. `ANALYTICS_DISABLED`, `POSTHOG_DISABLED`, `RYBBIT_HOST`, `RYBBIT_SITE_ID` and `RYBBIT_API_KEY` cannot re-enable tracking.

Existing local configuration or analytics files from older versions are left untouched, but are no longer read for tracking. See [LOCAL_ONLY.md](../LOCAL_ONLY.md) for the runtime contract and the separate custom-script limitation.
