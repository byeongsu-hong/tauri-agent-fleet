# Driver contract

Fleet drives one app framework through a **driver** — a module it loads by
import specifier and talks to only through the interfaces below. Fleet core
imports no framework SDK. The bundled Tauri driver
(`@byeongsu-hong/agent-fleet/driver-tauri`) is the reference implementation; an
iced, Qt, or GTK driver is an independent package that satisfies the same
contract.

## Interfaces

From `src/driver.ts`:

```ts
interface Driver {
  readonly name: string                 // 'tauri', 'iced'
  readonly driverProtocol: string       // 'agent-fleet-driver/v1'
  attach(context: AttachContext): Promise<AgentSession>
  probe(context: AttachContext): Promise<unknown>
}

interface AttachContext {
  appId: string        // application.id from config
  runtimeDir: string   // per-instance XDG_RUNTIME_DIR; endpoint discovery is scoped here
  app: ProcessRecord   // the live app process (pid/pgid), for identity checks
  deadline: number     // epoch-ms budget; attach/probe must give up by then
}

interface AgentSession {
  readonly capabilities: DriverCapabilities
  execute(action: RunnerAction): Promise<unknown>   // typed UI action -> wire
  observe(): Promise<unknown>                        // semantic snapshot/delta; cursor is the session's own
  evaluate(conditions: SuccessCondition[]): Promise<boolean>  // deterministic pass check
  startRecording(): Promise<void>
  stopRecording(): Promise<void>
  persistCaptures(dir: string): Promise<void>        // write diagnostics (logs, events, …) under dir
  screenshot(path: string): Promise<void>
  close(): Promise<void>
}

interface DriverCapabilities {
  atomicAct: boolean   // single atomic act call vs find-then-act
  stream: boolean      // incremental observation vs full snapshot each step
  event: boolean       // app command/event log is queryable (suite `event` conditions)
  screenshot: boolean
}
```

The driver owns everything framework-specific: the wire envelope, method names,
`@ref` handling, param shapes, capability set, and capture format. The runner
only ever calls the semantic operations above; it never sees a wire method name.

## Failure classification

A session method that hits transport loss (endpoint gone, socket closed) must
throw `InfrastructureError` (exported from `src/driver.ts`). The runner treats it
as `infrastructure_failure`; any other thrown error during an action is a
`runner_failure`. Do not classify by framework-specific error strings inside the
runner — that is the driver's job.

## Loading and negotiation

`loadDriver(spec)` does `await import(spec)`, reads the default export, and
requires `driverProtocol` to be in Fleet's supported set (currently
`agent-fleet-driver/v1`). `spec` is any import specifier:

- a third-party package — `@acme/agent-fleet-driver-qt`;
- a first-party subpath — `@byeongsu-hong/agent-fleet/driver-tauri` (resolves to
  the bundled driver via package `exports`; when Fleet runs from source with no
  `dist` build, it falls back to the in-tree module).

Config selects the driver per runtime, decoupled from the build variant:

```jsonc
"runtimes": {
  "default": "wry",
  "wry": { "driver": "@byeongsu-hong/agent-fleet/driver-tauri", "build": ["bash", "..."] },
  "cef": { "driver": "@byeongsu-hong/agent-fleet/driver-tauri", "build": ["bash", "..."] }
}
```

## Endpoint discovery

`probe`/`attach` locate the app's agent endpoint under the instance's
`runtimeDir` and confirm the endpoint's pid shares the app's process group
before trusting it. Discovery shape is the driver's own; Fleet only guarantees a
private per-instance `XDG_RUNTIME_DIR`, which is what makes parallel instances of
the same app isolate cleanly.

## Reference target: the iced driver

The native iced shell exposes an agent endpoint
([ducktape `feat/iced-agent-plugin`](https://github.com/orthory/ducktape)) that a
future `agent-fleet-driver-iced` package wraps. It shares the *semantic* model
with Tauri (role/name `find` → `@ref` → act, a semantic tree, `expect`/`state`),
so it implements the same `AgentSession`, but its wire differs — which is exactly
what the driver boundary absorbs:

| aspect | tauri driver | iced driver |
| --- | --- | --- |
| discovery | `tauri-agent/<appId>/endpoint.json` (unix or tcp) | `iced-agent/<appId>/endpoint.json` (tcp) |
| envelope | JSON-RPC `{method, params}` → `{result}` | `{id, cmd:{cmd, …}}` → `{id, ok, result, error}` |
| act | `find` → `{ref}` then `click/fill/…` | `find` → `{target:{ref}}` then `click/…` |
| `event` capability | `true` (Tauri IPC log, wire method `ipc`) | `false` (no IPC/event log) |
| `stream` capability | `true` | `false` (poll `tree` each step) |
| extras | `record` replay | AccessKit tree, curated intents/state |

`event` is Fleet's framework-neutral name for an app command/event log. The
tauri driver maps it to the plugin's `ipc` wire method; a driver whose framework
has no such log declares `event: false`, and suites that assert `event`
conditions simply cannot pass on it.
