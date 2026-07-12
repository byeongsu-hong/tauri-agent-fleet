# Architecture

## Product boundary

`tauri-agent-fleet` is the multi-application control plane around
`tauri-agent-plugin`. The plugin operates one Tauri application. Fleet owns the
build, process, scheduling, runner, artifact, and dashboard layers above it.

```text
SourceRevision
  `-- BuildArtifact (revision + runtime)
       |-- Instance A -- Run / Suite A
       |-- Instance B -- Run / Suite B
       `-- Instance C -- Run / Suite C
```

The current Ducktape prototype conflates a Git worktree with an application
instance. That model can show one app per branch but cannot execute several
suites concurrently against the same revision. The target model separates four
entities.

| Entity | Responsibility |
| --- | --- |
| `SourceRevision` | Repository, worktree, commit, branch, and dirty state |
| `BuildArtifact` | One reusable debug artifact keyed by revision and runtime |
| `Instance` | Isolated HOME, runtime directory, display, ports, data, and process group |
| `Run` | One suite assigned to one instance, including runner state and artifacts |

## Components

### CLI and scheduler

The CLI discovers revisions, prepares build artifacts, creates instances, queues
runs, and enforces a bounded `--jobs` concurrency limit.

Planned commands:

```text
tauri-agent-fleet up [revision...]
tauri-agent-fleet down [instance...]
tauri-agent-fleet status
tauri-agent-fleet dashboard
tauri-agent-fleet test <suite-id...> --runtime <wry|cef> --jobs <n>
```

`up` retains the current interactive worktree dashboard use case. `test` uses
build-once/run-many artifacts for parallel suites.

### Build cache

An artifact key includes at least:

```text
repository identity + commit SHA + dirty fingerprint + runtime
```

The application configuration names an explicit default runtime and owns each
runtime's build command; Fleet owns caching and reuse.

### Instance manager

Each instance receives independent values for:

- HOME
- XDG_RUNTIME_DIR
- application data
- X display
- VNC port
- application and daemon ports
- tauri-agent endpoint registry
- process group and PID metadata

Readiness requires both a live process group and a successful plugin attach.
VNC readiness is a separate human-observation capability, not proof that the app
is driveable.

### Tauri agent client

Fleet imports the published `DebuggerClient` and protocol types from
`@byeongsu-hong/tauri-agent-plugin`. Fleet runners use that direct client and do
not pay MCP tool-schema tokens.

The plugin contract needed by Fleet is documented in the implementation plan.
Fleet must negotiate protocol/capability information instead of guessing Wry,
CEF, screenshot support, or stream support.

### Runner

A low-cost model receives:

- the suite objective;
- deterministic pass conditions;
- the current scoped semantic observation or latest delta;
- the immediately preceding action result;
- remaining step/time/token budgets.

The model selects only the next typed action. Fleet validates and executes the
action through the plugin. Deterministic `expect`, state, and IPC checks decide
pass/fail.

### Dashboard

The dashboard displays one tile per active run/instance with:

- revision and runtime;
- suite and lifecycle state;
- current step and elapsed time;
- token/cost usage;
- plugin endpoint health;
- a live VNC screen;
- failure artifacts.

The first version may continue polling JSON state. A new event bus is not needed
until polling is measurably inadequate.

Dashboard health probing stays in memory; it does not rewrite lifecycle state
or terminate processes. Persisted repair and lifecycle control remain CLI-owned.

`GET /api/v1/fleet` returns `tauri-agent-console/v1`. It exposes lifecycle and
failure evidence, runtime, clean/dirty revision state, run progress, usage, health, and routed
artifact/VNC URLs; persisted directories, processes, ports, endpoint
capabilities, and cache keys remain internal.

### Horizontal coordinator and workers

Horizontal mode keeps the same instance manager and runner on each Linux host.
An authenticated coordinator owns only immutable job inputs, atomic leases,
global capacity, terminal summaries, and bounded uploaded evidence. Worker
processes own local checkout resolution, shared/private build-cache access,
host-local state with isolated instance roots, exact process groups, heartbeats, execution, upload, and
teardown.

```text
submitter -> coordinator queue <- worker A (local Fleet jobs)
                               <- worker B (local Fleet jobs)
                               <- worker N (local Fleet jobs)
```

At-least-once leases make a job eligible elsewhere after a missed heartbeat.
Random attempt-scoped lease tokens fence stale heartbeat, upload, and completion
requests. Requeued jobs discard partial evidence from the expired attempt. The
coordinator never fetches Git refs, runs application hooks, receives plugin
tokens, or proxies worker VNC ports. See `docs/horizontal-scaling.md` for the
normative protocol and acceptance matrix.

## Configuration contract

The v1 application configuration lives at `.tauri-agent/fleet.json`. Fleet
discovers it while walking upward, and command arrays are passed without shell
interpolation.

```json
{
  "protocol": "tauri-agent-fleet/v1",
  "application": {
    "id": "com.example.app",
    "root": "app"
  },
  "lifecycle": {
    "prepareBuild": ["bash", "qa/fleet/prepare-build.sh"],
    "prepareInstance": ["bash", "qa/fleet/prepare-instance.sh"],
    "cleanupInstance": ["bun", "qa/fleet/cleanup-instance.ts"]
  },
  "runtimes": {
    "default": "wry",
    "wry": {
      "build": ["bash", "qa/fleet/build-wry.sh"]
    },
    "cef": {
      "build": ["bash", "qa/fleet/build-cef.sh"]
    }
  }
}
```

Fleet provides a small, fixed environment contract to hooks:

```text
FLEET_REVISION
FLEET_RUNTIME
FLEET_INSTANCE_ID
FLEET_STATE_DIR
FLEET_HOME
FLEET_RUNTIME_DIR
FLEET_DISPLAY
FLEET_APP_PORT
FLEET_APP_DATA
FLEET_VNC_PORT
```

Build and instance hooks additionally receive `FLEET_ARTIFACT_DIR` and
`FLEET_ARTIFACT_MANIFEST`. The build command must place reusable output inside
the former and write a v1 manifest to the latter. Manifest `executable` and
optional `cwd` paths are relative to, and confined within, the artifact
directory.

The manifest declares `"protocol": "tauri-agent-artifact/v1"`. Completed run
metadata declares `tauri-agent-run/v1`; `status --json` declares
`tauri-agent-status/v1`.

Hooks may prepare product state but must not start Xvfb, VNC, the Fleet server,
or the dashboard.

Fleet terminates its recorded application, VNC, and X process groups before it
runs `cleanupInstance`. The application hook owns any additional process group
the product deliberately detached, and must identify it from private instance
state rather than process-name matching. Cleanup runs for explicit stops, suite
teardown, startup failure, and persisted crash repair. Observe-only dashboard
refreshes never invoke it. Fleet caps cleanup at 30 seconds and 1 MiB of output.
Failure marks the instance and active suite run as `infrastructure_failure`.

## Suite contract

The v1 suite format is deliberately small. Each `<id>.json` lives under
`.tauri-agent/suites/` and declares the same `id`.

```json
{
  "protocol": "tauri-agent-suite/v1",
  "id": "editor-save",
  "runtime": "wry",
  "objective": "Create a document, rename it to notes.md, and save it.",
  "pass": [
    {
      "state": {
        "key": "editor.documentName",
        "equals": "notes.md"
      }
    },
    {
      "ipc": {
        "command": "save_document",
        "ok": true
      }
    }
  ],
  "budget": {
    "steps": 25,
    "seconds": 120
  }
}
```

Conditionals, arbitrary JavaScript, retries around whole flows, cloud settings,
and a reusable subflow language are out of v1 scope.

## Security model

- Dashboard bind defaults to `127.0.0.1`.
- Remote access is an explicit operator choice; v1 has no dashboard auth and
  should be tunneled rather than exposed directly.
- Coordinator APIs require a bearer token of at least 32 opaque characters;
  horizontal v1 still relies on a private network or tunnel for TLS.
- VNC servers bind to loopback and are routed by random opaque tokens.
- State/runtime directories use user-private permissions.
- Plugin session tokens remain in the plugin endpoint registry.
- Fleet does not forward its inherited `OPENAI_API_KEY` to build hooks,
  instance hooks, or application processes.
- Application processes receive isolated HOME/XDG paths but not the global
  `FLEET_STATE_DIR` unless their artifact manifest sets it explicitly.
- Low-cost runners cannot invoke arbitrary shell or plugin `eval`.
- Fleet validates suite files and model actions at trust boundaries.
