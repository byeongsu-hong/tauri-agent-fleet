# Ducktape migration

## Cutover status

The cutover completed in
[`orthory/ducktape#419`](https://github.com/orthory/ducktape/pull/419). Ducktape
now owns only its Fleet configuration, CEF hooks, and suites; the embedded
scripts and dashboard listed below were removed. Rollback is a revert of that
PR, not a second live Fleet implementation.

## Source baseline

Plan the extraction from Ducktape `origin/dev` commit:

```text
0f2e40c18bfe37e6ef77840d6b10b2d287bd6fe9
```

The primary local Ducktape checkout was dirty and behind `origin/dev` when this
repository was bootstrapped. Perform migration work from a fresh isolated
worktree based on the latest `origin/dev`. Do not touch or clean the primary
checkout's unrelated changes.

## Source inventory at extraction

Generic Fleet source originally lived at:

```text
ops/fleet.sh
ops/fleet.mjs
ops/fleet.test.mjs
ops/fleet-console/
```

Active integration references include:

```text
ops/README.md
skills/qa/SKILL.md
skills/upgrade/SKILL.md
ops/callbed/README.md
```

Completed historical plans/specifications may retain their original paths. They
describe what happened at the time and should not be rewritten as active docs.

## Coupling to remove

The extracted prototype assumed:

- a project directory named `app`;
- base branch `dev`;
- app ID `com.ducktape.app`;
- a staged `ducktape-node` binary;
- Ducktape workspace registry JSON;
- fixed remote-tauri tool locations;
- branch slug as instance identity and VNC route token;
- one instance per worktree;
- `tauri dev` and Vite per instance;
- Tailscale for dashboard exposure.

All application-specific preparation moves to Ducktape hooks. Fleet owns only
the generic lifecycle and passes a fixed environment contract.

## Lifecycle defects to fix before cutover

Do not preserve these behaviors during extraction:

1. `down <branch>` currently uses a broad `pkill -f` pattern that can terminate
   every Ducktape desktop instance.
2. Readiness is inferred from endpoint-file/VNC-port existence rather than an
   owned live process and successful plugin attach.
3. VNC route tokens are predictable branch slugs.
4. Fixed sleeps substitute for readiness checks.
5. Fleet metadata advertises a `tauri-agent observe` command that does not exist.
6. Manual `fleet.json` refresh can leave dashboard state stale.

## Cutover sequence

### 1. Extract without deleting

- Bootstrap the generic Fleet repository.
- Import behavior in small PRs rather than copying the shell wholesale.
- Add JSON configuration and project hooks.
- Implement exact PID/process-group ownership.
- Keep the old Ducktape Fleet available for comparison.

### 2. Add Ducktape integration

Ducktape should retain only:

```text
tauri-agent-fleet.json
qa/fleet/prepare-build.sh
qa/fleet/prepare-instance.sh
qa/fleet/build-wry.sh
qa/fleet/build-cef.sh
qa/suites/*.json
```

The exact hook count may shrink during implementation. Do not create an empty
hook merely to match this sketch.

### 3. Side-by-side gates

Verify with the new Fleet:

- two worktrees simultaneously;
- two instances from the same build artifact;
- distinct HOME, XDG runtime, display, ports, endpoints, and app data;
- an action against one endpoint cannot affect another instance;
- Wry smoke suite;
- CEF smoke suite;
- live dashboard VNC for every instance;
- stopping one instance leaves all others alive;
- failed runs retain replayable artifacts.

### 4. Remove the old system

Only after all gates pass, submit a Ducktape PR that removes:

```text
ops/fleet.sh
ops/fleet.mjs
ops/fleet.test.mjs
ops/fleet-console/
```

Update active QA/upgrade/callbed documentation to invoke the versioned
`tauri-agent-fleet` CLI. Keep the PR based on Ducktape `dev`, review it from a
clean context, and merge only when the Wry/CEF and isolation gates are green.

## Rollback

Revert Ducktape PR #419 and restore its previous pinned Fleet invocation. No
plugin release needs to be reverted while protocol compatibility is maintained.
