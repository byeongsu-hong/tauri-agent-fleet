# Architecture

## Product boundary

`tauri-agent-fleet` is the multi-application control plane around
`tauri-agent-plugin`. The plugin operates one Tauri application. Fleet owns the
build, process, scheduling, runner, artifact, and dashboard layers above it.

```text
SourceRevision
  `-- BuildArtifact (revision + runtime variant)
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
| `BuildArtifact` | One reusable debug artifact keyed by revision and runtime variant |
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
tauri-agent-fleet test <suite...> --variant <wry|cef> --jobs <n>
```

`up` retains the current interactive worktree dashboard use case. `test` uses
build-once/run-many artifacts for parallel suites.

### Build cache

An artifact key includes at least:

```text
repository identity + commit SHA + dirty fingerprint + runtime variant
```

Wry is the default variant. CEF is explicit. The application configuration owns
the actual build commands; Fleet owns caching and reuse.

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

- the suite goal;
- deterministic success conditions;
- the current scoped semantic observation or latest delta;
- the immediately preceding action result;
- remaining step/time/token budgets.

The model selects only the next typed action. Fleet validates and executes the
action through the plugin. Deterministic `expect`, state, and IPC checks decide
pass/fail.

### Dashboard

The dashboard displays one tile per active run/instance with:

- revision and runtime variant;
- suite and lifecycle state;
- current step and elapsed time;
- token/cost usage;
- plugin endpoint health;
- a live VNC screen;
- failure artifacts.

The first version may continue polling JSON state. A new event bus is not needed
until polling is measurably inadequate.

## Configuration contract

The v1 application configuration is JSON and command arrays are passed without
shell interpolation.

```json
{
  "schemaVersion": 1,
  "baseBranch": "dev",
  "projectDir": "app",
  "agent": {
    "appId": "com.example.app"
  },
  "hooks": {
    "prepareBuild": ["bash", "qa/fleet/prepare-build.sh"],
    "prepareInstance": ["bash", "qa/fleet/prepare-instance.sh"]
  },
  "variants": {
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
FLEET_VARIANT
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

Hooks may prepare product state but must not start Xvfb, VNC, the Fleet server,
or the dashboard.

## Suite contract

The v1 suite format is deliberately small.

```json
{
  "id": "editor-save",
  "variant": "wry",
  "goal": "Create a document, rename it to notes.md, and save it.",
  "success": [
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
  "limits": {
    "steps": 25,
    "seconds": 120
  }
}
```

Conditionals, arbitrary JavaScript, retries around whole flows, cloud settings,
and a reusable subflow language are out of v1 scope.

## Security model

- Dashboard bind defaults to `127.0.0.1`.
- Remote access is an explicit operator choice.
- VNC servers bind to loopback and are routed by random opaque tokens.
- State/runtime directories use user-private permissions.
- Plugin session tokens remain in the plugin endpoint registry.
- Low-cost runners cannot invoke arbitrary shell or plugin `eval`.
- Fleet validates suite files and model actions at trust boundaries.
