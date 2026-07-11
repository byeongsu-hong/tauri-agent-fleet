# Implementation plan

## Goal

Extract Ducktape's headless multi-worktree dashboard into a standalone Fleet,
improve `tauri-agent-plugin` for reliable low-token control, then add build-once
parallel suites driven by low-cost models.

This plan deliberately separates three repositories and several releases. Avoid
a big-bang extraction.

## Repository responsibilities

| Repository | Work |
| --- | --- |
| `tauri-agent-plugin` | Single-app protocol, atomic actions, cursors, capabilities, token reductions |
| `tauri-agent-fleet` | Build cache, lifecycle, scheduler, runner, artifacts, dashboard |
| Ducktape | Fleet config, product hooks, QA suites, removal of the embedded Fleet |

## Phase 0: measurements and contracts

Deliverables:

- record token/wire baselines from the plugin commit listed in `README.md`;
- document the plugin capability/attach response Fleet needs;
- finalize v1 Fleet config and suite schemas;
- inventory active Ducktape references;
- remove the nonexistent `observe` command from the extraction contract rather
  than implementing it solely because stale metadata mentions it.

Gate:

- measurements are committed as fixtures or an auditable report;
- no production behavior has changed.

## Phase 1: plugin reliability and token budget

Land as focused PRs in `tauri-agent-plugin`.

### 1. Capability negotiation

Extend attach/session metadata with:

```text
protocol version
session ID
platform
runtime: wry | cef | unknown
supported screenshot backends
semantic stream support
IPC trace support
```

Prefer backward-compatible optional fields over a second discovery method.

### 2. Locator-first atomic action

Add one protocol action that accepts existing locator fields (`scope`, `role`,
`name`, and `text`), action type, action arguments, and timeout. Resolve the
locator, wait for actionability, and perform the action in one guest turn.

Keep existing ref actions. Fleet runners use the atomic path; humans may continue
using refs.

### 3. Cursor-based captures

Add sequence IDs and `since`/`limit` to logs, events, network, and IPC. Preserve
bounded buffers and return `dropped` when the cursor fell behind.

### 4. Lean semantic stream

Return a full snapshot only for initial synchronization or dropped-frame
recovery. Normal pulls return frames and cursor only.

### 5. Lean MCP mode

- add server-scoped target configuration;
- add `core` and `full` profiles;
- remove duplicated large structured content;
- emit compact JSON tool text;
- measure schema and response reductions.

Fleet still uses the direct client.

### 6. Replay

Add a client-side `tauri-agent replay <file>` command using existing canonical
recorded method/params. No new Rust transport is required.

Verification:

```text
bun run check
bun run check:rust
fixture live-bridge smoke
token-budget report
```

Release the resulting compatible plugin version before Fleet's runner work pins
it.

## Phase 2: Fleet foundation

Implement the smallest generic extraction that preserves the current interactive
dashboard use case.

### CLI foundation

- JSON config loader and validation;
- worktree/revision discovery;
- stable state directory layout;
- slot/display/port allocation;
- exact process-group PID records;
- `up`, `down`, `status`, `dashboard` commands.

### Linux runtime

- Xvfb lifecycle;
- x11vnc bound to loopback;
- random VNC route tokens;
- dashboard static server and VNC WebSocket router;
- process and plugin health checks instead of fixed sleeps;
- stale-state recovery that verifies PID identity before cleanup;
- an application cleanup hook for deliberately detached product process groups.

### Dashboard import

Import the existing React/noVNC console source after lifecycle contracts exist.
Do not commit generated `dist/`. Rename Ducktape branding and types to generic
Fleet concepts. Preserve grid and graph behavior initially; simplification is a
separate measured decision.

### Tests

- config validation;
- slot/port allocation;
- process ownership and exact teardown;
- exact cleanup-hook teardown without touching sibling groups;
- token router path validation and binary forwarding;
- stale PID handling;
- console unit tests;
- fake endpoint readiness.

Gate:

- generic Fleet contains no `ducktape`, `com.ducktape.app`, `app/`, or
  `remote-tauri` hardcoding;
- one interactive Wry instance can be observed and driven.

## Phase 3: Ducktape adapter and parity

- add Ducktape config and the minimum required product hooks;
- stage/seed `ducktape-node` only from Ducktape-owned hooks;
- validate two worktrees with isolated state;
- validate Wry and CEF runtimes;
- compare the old and new dashboards;
- fix active QA and upgrade runbooks;
- do not remove old Fleet yet.

Gate:

- every side-by-side condition in `docs/ducktape-migration.md` passes.

## Phase 4: build-once/run-many instances

Introduce the target data model without changing the plugin boundary.

- artifact key and cache;
- project-provided Wry/CEF build commands;
- artifact manifest containing executable and launch metadata;
- several isolated instances from one artifact;
- explicit instance IDs independent of branch names;
- bounded scheduler with queued, building, booting, ready, running, and terminal
  states.

Gate:

- two suites can run simultaneously against the same revision and runtime
  without source/build/data collisions.

## Phase 5: low-cost AI runner

### Provider

Implement one provider path first, using standard `fetch` and structured output.
Do not create a provider framework until a second provider is required.

### Loop

1. Attach and negotiate capabilities.
2. Send the objective, pass conditions, and initial compact observation.
3. Validate the model's next typed action.
4. Execute the atomic plugin action.
5. Send only the result and semantic delta/scoped observation.
6. Evaluate deterministic pass conditions.
7. Stop on pass, failure, timeout, repeated action, step limit, or token limit.

### Artifacts

Each run writes:

```text
run.json
actions.jsonl
model-usage.jsonl
tree.txt or semantic frames
console.jsonl
network.jsonl
ipc.jsonl
failure screenshot
replay.json
```

### Failure taxonomy

- `app_failure`: deterministic assertion, crash, or application timeout;
- `runner_failure`: invalid/repeated action or exhausted runner budget;
- `infrastructure_failure`: build, launch, display, endpoint, or Fleet failure.

Gate:

- a mock-model integration test is deterministic;
- one real cheap-model smoke suite passes repeatedly;
- a deliberate app failure and runner failure are classified differently.

## Phase 6: run-oriented dashboard

Extend the dashboard model from worktrees to revisions, instances, and runs.

Show:

- branch/SHA and Wry/CEF runtime;
- suite and lifecycle state;
- current step and elapsed time;
- input/output token usage and cost;
- plugin endpoint health;
- live VNC;
- failure classification and artifacts.

Keep polling initially. Add lifecycle controls or a new event transport only
after the observation-only dashboard is proven insufficient.

## Phase 7: Ducktape cutover and releases

Release order:

1. compatible `tauri-agent-plugin` release;
2. first versioned `tauri-agent-fleet` release;
3. Ducktape pins both versions;
4. Wry, CEF, same-artifact parallel, and teardown gates pass;
5. Ducktape removal PR deletes the embedded Fleet;
6. document legacy process/state cleanup.

## PR slicing

Recommended independently reviewable sequence:

1. Plugin capability negotiation.
2. Plugin atomic locator action.
3. Plugin cursor/stream token reductions.
4. Plugin scoped/core MCP and replay.
5. Fleet config, state, and process ownership.
6. Fleet Linux display/VNC/server runtime.
7. Fleet dashboard source import.
8. Ducktape adapter and side-by-side parity.
9. Fleet build artifact and multi-instance scheduler.
10. Fleet deterministic runner core.
11. Fleet cheap-model integration and token metrics.
12. Dashboard run/artifact views.
13. Ducktape embedded-Fleet removal.

## Final acceptance criteria

- Ducktape contains only config, hooks, and suites for Fleet.
- Fleet has no Ducktape-specific hardcoding.
- The plugin remains a single-application protocol and has no Fleet dependency.
- the configured default runtime and both Wry/CEF paths are tested.
- Several suites can execute against one build artifact with isolated state.
- Stopping one instance cannot terminate another.
- Pass/fail is deterministic even when navigation uses a model.
- Failures retain screenshot, semantic, console, IPC, and replay artifacts.
- Run-level token and cost data is visible.
- The targets in `docs/token-budget.md` are met or revised with measurements.

## First task for the next session

Start with Phase 0, not the dashboard:

1. create token/wire baseline fixtures in `tauri-agent-plugin`;
2. draft the backward-compatible attach capability shape;
3. create Fleet's JSON config types and validation tests;
4. implement exact process ownership tests before importing the launcher.

That sequence establishes the contracts and prevents the current prototype's
hardcoded lifecycle from becoming the new repository's architecture.
