# Plugin contract

This describes the endpoint contract the **Tauri driver's** plugin
(`tauri-agent-plugin`) satisfies. The framework-neutral Fleet↔driver contract —
what any driver implements — is in [driver-contract.md](driver-contract.md).

The Tauri driver talks to one running application through the published direct
TypeScript `DebuggerClient`. It never uses MCP and never asks the plugin to
manage builds, instances, suites, dashboards, or model providers.

## Attach negotiation

Fleet accepts the baseline attach result and a backward-compatible capability
extension. New fields may be top-level or grouped below `capabilities`:

```json
{
  "attached": true,
  "protocolVersion": 1,
  "sessionId": "opaque-session-id",
  "platform": "linux",
  "runtime": "wry",
  "screenshotBackends": ["dom", "native"],
  "semanticStream": true,
  "ipcTrace": true,
  "methods": ["act"]
}
```

`runtime` may be `wry`, `cef`, or `unknown`. Fleet does not infer capabilities
from the selected runtime. An advertised `act` method means the plugin can
resolve a locator and perform its typed action atomically. Fleet retains the
baseline `find` plus ref-action fallback for older compatible releases.

## Incremental captures

When supported, `stream`, `logs`, `events`, `network`, and `ipc` accept a
monotonic `since` cursor and a bounded `limit`, returning new entries plus
`cursor` and `dropped`. Fleet latches observed IPC assertions and requests only
entries after its last cursor. A dropped response must contain enough current
buffer state to resynchronize.

The initial semantic observation is a full compact tree. Subsequent model turns
receive only semantic frames unless a dropped cursor requires a new snapshot.
Fleet persists full diagnostics separately and never appends the complete
transcript to each model request.
