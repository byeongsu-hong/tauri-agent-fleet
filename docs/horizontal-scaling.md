# Horizontal Fleet SDD

## Goal

Run one Fleet queue across several Linux hosts without weakening the existing
single-host process, isolation, runner, or security contracts. A coordinator
owns only queue state and collected evidence. Workers continue to own builds,
displays, application process groups, plugin endpoints, models, and teardown.

Horizontal mode is additive. Existing `up`, `down`, `status`, `dashboard`, and
`test` commands keep their local behavior.

## Roles

### Coordinator

The coordinator is a small authenticated HTTP service backed by private local
JSON state. It accepts clean-revision suite jobs, leases them to workers, caps
global concurrency, requeues expired leases, collects bounded run artifacts,
and serves one read-only queue dashboard/API.

The coordinator never checks out source, builds applications, starts displays,
connects to application plugin endpoints, or runs models.

### Worker

A worker points at one coordinator and one local Fleet application config. It
claims up to its configured local job limit, resolves the requested clean commit
in its local repository, executes the existing `runSuites` path, uploads run
evidence, and completes the lease. Worker state, HOME/XDG directories, displays,
ports, VNC, endpoints, and process groups remain host-local.

### Submitter

`submit` resolves the selected revision and suites locally, rejects dirty
revisions, and sends immutable job payloads to the coordinator. The payload
contains the repository identity, commit, suite JSON, and requested runtime;
it never contains source files, credentials, model transcripts, or shell code.

## Protocol

All JSON messages use `tauri-agent-coordinator/v1`. Every `/api/v1` request
requires `Authorization: Bearer <token>`. The token is operator-provided, at
least 32 opaque characters, and is never persisted inside job or artifact
records.

### Job

```json
{
  "protocol": "tauri-agent-coordinator/v1",
  "id": "opaque-id",
  "repository": "sha256 repository identity",
  "commit": "40-character commit SHA",
  "suite": {},
  "runtime": "wry",
  "state": "queued",
  "attempt": 0,
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

States are `queued`, `leased`, `running`, `passed`, and `failed`. Terminal
jobs retain their failure class/message, run usage summary, worker ID, and
collected artifact names.

### Endpoints

- `POST /api/v1/jobs` validates and enqueues one immutable job.
- `POST /api/v1/claim` atomically expires stale leases, enforces global active
  capacity, and returns the oldest queued job plus a random lease token.
- `POST /api/v1/jobs/:id/heartbeat` authenticates the current lease, records
  `running`, and extends its expiry.
- `PUT /api/v1/jobs/:id/artifacts/:name` authenticates the current lease and
  stores one allowed, bounded artifact atomically.
- `POST /api/v1/jobs/:id/finish` authenticates the current lease and records a
  terminal result. A stale lease cannot overwrite a newer attempt.
- `GET /api/v1/fleet` returns aggregate queue/worker/run state for the dashboard.
- `GET /api/v1/jobs/:id/artifacts/:name` returns a collected artifact.

Claim and state transitions serialize through one coordinator lock. This is a
deliberate v1 ceiling: replace it with database transactions only when measured
coordinator contention matters.

## Leases and failure semantics

- Default lease duration: 30 seconds; worker heartbeat: every 10 seconds.
- Delivery is at least once. A network-partitioned worker may finish local work
  after its lease expires, but its stale token cannot publish or complete it.
- An expired lease is requeued until three attempts have started. The next
  expiry becomes `infrastructure_failure`.
- Coordinator global capacity counts `leased` and `running` jobs. A claim above
  capacity returns no job without changing queue state.
- Worker shutdown stops claiming, waits for current Fleet teardown, and sends a
  final heartbeat/finish when the lease is still current.

## Repository and build contract

- Horizontal jobs require a clean commit. Dirty fingerprints are local-only
  and cannot be reproduced safely on another host.
- A worker compares the job repository identity with its configured checkout
  before execution. It never runs a job from another repository.
- The commit must already be available to local Git. Fleet may create its
  existing detached managed worktree but does not implicitly fetch untrusted
  refs.
- Builds remain once per revision/runtime on each worker by default.
- `FLEET_ARTIFACT_CACHE` may name an absolute shared filesystem cache. Shared
  publication uses an atomic directory install and a renewable owner lock so
  two hosts cannot publish the same artifact concurrently.

## Artifact contract

Workers upload only these run basenames:

```text
run.json
actions.jsonl
model-usage.jsonl
semantic.jsonl
console.jsonl
network.jsonl
ipc.jsonl
failure.png
replay.json
```

Each file is capped at 16 MiB and a job at 64 MiB. Names containing separators,
unknown names, symlinks, and oversized bodies are rejected. The coordinator
stores artifacts below its private job directory and never extracts archives.

## Security

- Coordinator bind defaults to `127.0.0.1`; non-loopback is explicit.
- Horizontal v1 provides bearer authentication, not TLS. Use a private network
  or tunnel; do not expose it directly to the internet.
- Compare bearer and lease tokens without early-exit string comparison.
- Worker IDs are identifiers, not credentials. Lease tokens are random and
  scoped to one job attempt.
- Coordinator responses never expose lease tokens, plugin tokens, local worker
  paths, process metadata, or provider credentials.
- Existing runner restrictions remain: no arbitrary shell/eval, bounded model
  output, and deterministic assertions for pass/fail.

## Dashboard

The coordinator serves the existing static dashboard against an aggregate
projection. It shows queue state, worker ID/heartbeat, revision/runtime, suite,
attempt, elapsed time, token/cost totals, failure evidence, and collected
artifacts. Remote live VNC is deliberately unavailable until an authenticated
worker-to-coordinator tunnel exists; the UI must report it unavailable rather
than exposing worker ports.

## CLI

```text
tauri-agent-fleet coordinator [--host HOST] [--port PORT] [--max-active N]
tauri-agent-fleet submit <suite...> --coordinator URL [--revision REF]
tauri-agent-fleet worker --coordinator URL --id ID [--jobs N] [--once]
tauri-agent-fleet remote-status --coordinator URL [--json]
```

`FLEET_COORDINATOR_TOKEN` supplies authentication. CLI arguments do not accept
the token, keeping it out of process listings and shell history.

## Acceptance matrix

| ID | Requirement | Authoritative proof |
| --- | --- | --- |
| H1 | Atomic distribution | Two worker loops claim different jobs concurrently; no job has two current leases. |
| H2 | Global limit | With `max-active=1`, a second claim is empty until finish or expiry. |
| H3 | Lease recovery | Expired work requeues; stale heartbeat/upload/finish receive conflict; third expiry fails infrastructure. |
| H4 | Repository safety | Dirty submit, wrong repository, missing commit, unsafe suite, and runtime mismatch are rejected. |
| H5 | Worker isolation | Two worker state roots run the same artifact without HOME/XDG/display/port/endpoint collisions. |
| H6 | Exact teardown | Stopping one worker job leaves its sibling alive; worker interruption leaves no owned process group after repair. |
| H7 | Shared cache | Two workers requesting one revision/runtime execute the build command once and consume the same immutable artifact. |
| H8 | Evidence | Passed and failed jobs retain bounded run/action/usage/semantic/console/network/IPC/replay/screenshot evidence. |
| H9 | Aggregate view | One API/dashboard reports queued, active, passed, and failed jobs from both workers with summed usage/cost. |
| H10 | Authentication | Missing/wrong bearer and stale lease tokens cannot read or mutate coordinator state. |
| H11 | Real runtimes | At least three Wry and three CEF smokes pass through two worker processes. |
| H12 | Token accounting | Aggregate input/output/cost equals the sum of persisted worker usage without transcript duplication. |

Horizontal mode is complete only when H1-H12 have direct automated or persisted
runtime evidence. A local scheduler test or a green single-worker smoke cannot
stand in for a multi-worker acceptance item.
