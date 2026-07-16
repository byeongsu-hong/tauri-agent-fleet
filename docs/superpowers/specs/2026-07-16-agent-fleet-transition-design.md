# agent-fleet transition design

## Context

`tauri-agent-fleet` orchestrates parallel headless QA of Tauri apps by driving
each app through `@byeongsu-hong/tauri-agent-plugin`. Ducktape (the driving use
case) is being ported from Tauri to [iced](https://github.com/iced-rs/iced), a
Rust-native GUI with no webview and no Tauri IPC. Fleet must therefore stop
being Tauri-specific: it needs a **driver-abstracted harness** where the app
framework is a pluggable module, not a hard dependency.

The Tauri coupling is thin. Only `src/agent.ts` imports the plugin; `runner.ts`
imports its types. Everything else is naming (`tauri-agent-*/v1` protocols,
`.tauri-agent/` config dir, `wry|cef` runtime union) or generic GUI process
isolation.

## Decisions (settled with the owner)

1. **Same wire protocol reused.** iced ships its own agent endpoint speaking the
   existing socket JSON-RPC protocol (attach/find/act/state/expect/tree/stream).
   Fleet depends on the *protocol*, not the concrete package.
2. **Out-of-tree dynamic driver plugins.** Drivers are importable modules loaded
   via `await import(spec)`, registered by an import specifier in config. A
   third party can add a driver (Qt, GTK, …) without forking Fleet.
3. **ipc → event.** The Tauri-flavored `ipc` vocabulary is renamed to `event`
   (suite condition `{ event: { name, ok } }`, capture `events.jsonl`). Each
   driver maps the semantic operation to its own wire method, so no plugin
   release is forced.
4. **Hard-cut rename.** `agent-fleet` everywhere: package, CLI, `.agent/` config
   dir, `agent-*/v1` protocols. No back-compat aliases; ducktape adapts its
   config in the same coordinated migration.
5. **High abstraction, no on-demand branching.** No `switch(runtime)` scattered
   across the code. Runtime name is an open string; each runtime entry names a
   `driver`. Core dispatches only through the driver interface.

## Deliverable scope

Ships now:

- Driver-abstracted Fleet core (tauri-free): `Driver` / `AgentClient` /
  `AgentSession` interfaces, a shared `ProtocolSession` helper, a registry, and
  a dynamic loader with driver-protocol version negotiation.
- The **tauri driver** as the first implementation, extracted from `agent.ts`,
  proving the seam: the existing wry/cef unit + e2e paths run through it.
- Hard-cut rename + `ipc`→`event`.
- `docs/driver-contract.md` — the interface an out-of-tree driver author (e.g.
  the future iced driver) implements.

Deferred:

- The actual **iced driver** — a separate out-of-tree package authored against
  `driver-contract.md`, blocked on the iced-side agent endpoint that does not
  exist yet. Not buildable/testable now.

## Packaging (pragmatic, still ideal abstraction)

A single package `@byeongsu-hong/agent-fleet`. Core (`src/`) never statically
imports Tauri. The tauri driver lives at `src/drivers/tauri.ts` and is exposed
as a package subpath export `@byeongsu-hong/agent-fleet/driver-tauri`; it is the
only code that imports `@byeongsu-hong/tauri-agent-plugin` (moved to
`optionalDependencies` + peer). The loader treats first-party subpaths and
third-party packages identically — both are `await import(spec)`.

> A full monorepo workspace split (a standalone `agent-fleet-driver-tauri`
> package) is a mechanical follow-up if third-party publishing needs it. It adds
> packaging blast radius without changing the abstraction, and the local e2e
> harness here (no x11vnc/CEF) cannot verify a restructure, so it is out of this
> change. The subpath export is import-specifier-compatible with a future
> extraction: only the specifier string in config changes.

## Driver contract

```ts
// Generic RPC client to one app instance. Drivers construct it; core never
// sees wire method names.
interface AgentClient {
  call<T>(method: string, params?: unknown): Promise<T>
  close(): void
}

// Everything framework-specific about driving one live app instance.
interface AgentSession {
  readonly capabilities: DriverCapabilities
  execute(action: RunnerAction): Promise<unknown>            // action → wire
  observe(cursor: number | undefined): Promise<{ value: unknown; cursor?: number }>
  evaluate(conditions: SuccessCondition[], state: AssertionState): Promise<boolean>
  startRecording(): Promise<void>
  stopRecording(): Promise<void>
  persistCaptures(dir: string): Promise<void>
  screenshot(path: string): Promise<void>
  close(): void
}

interface AttachContext {
  appId: string
  runtimeDir: string
  app: ProcessRecord
  deadline: number
}

interface Driver {
  readonly name: string                          // 'tauri'
  readonly driverProtocol: string                // 'agent-fleet-driver/v1'
  attach(ctx: AttachContext): Promise<AgentSession>
}

interface DriverCapabilities {
  atomicAct: boolean      // supports the atomic `act` call vs find-then-act
  stream: boolean         // supports incremental `stream` observation
  event: boolean          // supports the event/command log
  screenshot: boolean
}
```

- **`ProtocolSession`** (core, exported for driver reuse) implements every
  `AgentSession` method from an `AgentClient` + a `DriverCapabilities` + a small
  method-name map (`{ event: 'ipc' }` for tauri). Same-wire-protocol drivers
  (tauri, iced) are thin: they only implement `attach` (discovery + connect →
  `AgentClient`) and declare capabilities + method map. This replaces the
  `canAtomicAct()` 7-branch capability sniffing with an explicit declaration.
- **Loader.** `loadDriver(spec)` → `await import(spec)` → read `default` export
  → check `driverProtocol` is in Fleet's supported set (else fail fast) → cache
  by spec. Failures (import error, missing default, protocol mismatch, attach
  failure) surface as `infrastructure_failure` through the existing lifecycle.
- **Injection.** `runSuite` / `runSuites` accept an optional `driver` /
  `loadDriver` override so tests bind a driver directly (as they already inject
  `nextAction`), avoiding self-referencing import resolution in the dev repo.

## Config change

`runtime` (build variant) is decoupled from `driver` (how to drive):

```jsonc
"runtimes": {
  "default": "wry",
  "wry": { "driver": "@byeongsu-hong/agent-fleet/driver-tauri", "build": ["bash", "..."] },
  "cef": { "driver": "@byeongsu-hong/agent-fleet/driver-tauri", "build": ["bash", "..."] }
}
// iced app later:
"runtimes": { "default": "native",
  "native": { "driver": "@byeongsu-hong/agent-fleet-driver-iced", "build": ["bash", "..."] } }
```

- `RuntimeVariant = 'wry' | 'cef'` union is removed; runtime is an open string.
- `schema.ts` drops the `wry|cef` enum checks; validates each
  `runtimes.<name>.driver` (import specifier) + `build`, and that `default`
  names a configured runtime.
- `cli.ts --runtime` accepts any configured runtime name.

## Rename map (hard cut)

| current | new |
| --- | --- |
| `@byeongsu-hong/tauri-agent-fleet`, bin `tauri-agent-fleet` | `@byeongsu-hong/agent-fleet`, bin `agent-fleet` |
| `.tauri-agent/fleet.json`, `.tauri-agent/suites/` | `.agent/fleet.json`, `.agent/suites/` |
| `tauri-agent-{fleet,suite,artifact,run,status,console}/v1` | `agent-{fleet,suite,artifact,run,status,console}/v1` |
| state root `tauri-agent-fleet/<id>`, codex tmp `tauri-agent-fleet-codex-` | `agent-fleet/<id>`, `agent-fleet-codex-` |
| suite `{ ipc: { command, ok } }`, `ipc.jsonl` | `{ event: { name, ok } }`, `events.jsonl` |

Kept unchanged (Tauri plugin territory, not Fleet):
`@byeongsu-hong/tauri-agent-plugin`, the bare `tauri-agent/<appId>` endpoint
registry dir, and the fixture's `src-tauri/` Tauri app.

## File impact

- `src/agent.ts` → deleted; logic moves to `src/drivers/tauri.ts`.
- `src/driver.ts` → new: interfaces + `ProtocolSession` + registry + loader.
- `src/runner.ts` → drives an `AgentSession`, not `DebuggerClient`; obtains it
  from the driver.
- `src/types.ts` / `schema.ts` / `cli.ts` / `scheduler.ts` / `build.ts` →
  open-string runtime, `driver` field, `event` condition.
- `src/storage.ts` / `provider.ts` / `server.ts` → renamed strings/dirs.
- docs (all) + `README.md` + `.github/workflows/ci.yml` + `test/fleet.test.ts`
  + fixture config → renamed; new `docs/driver-contract.md`.

## Verification

Local gate: `bun run typecheck` + `bun test` (29) + `bun run build`. The full
`test:e2e:runtimes` (real Tauri build in parallel wry/cef instances) needs
x11vnc + CEF and runs in CI, not locally here.

## Non-goals

- Building or testing the iced driver (blocked on the iced agent endpoint).
- Full monorepo workspace split (follow-up, packaging-only).
- Back-compat with `tauri-agent-*` names or `.tauri-agent/`.
