# tauri-agent-fleet

Parallel, headless QA orchestration for Tauri applications instrumented with
[`tauri-agent-plugin`](https://github.com/byeongsu-hong/tauri-agent-plugin).

`tauri-agent-fleet` will build an application once per revision/runtime variant,
launch isolated instances for test suites, drive each instance with a low-cost AI
runner, and expose every live screen and run state in one dashboard.

## Status

This repository is a documentation-first bootstrap. It is not runnable yet.
The current prototype still lives in Ducktape under `ops/fleet.sh`,
`ops/fleet.mjs`, and `ops/fleet-console/`. Do not copy that implementation
unchanged: it contains Ducktape-specific provisioning and lifecycle assumptions
that this repository must remove.

Extraction baselines:

- Ducktape: `0f2e40c18bfe37e6ef77840d6b10b2d287bd6fe9`
- tauri-agent-plugin: `fc773cc18e85ac4deef0c450736af323d841b9f7`

## Ownership boundary

```text
application repository
  config + app-specific hooks + QA suites
                    |
tauri-agent-fleet
  build cache + isolated instances + scheduler + runner + dashboard
                    |
tauri-agent-plugin
  one live Tauri application: observe, act, assert, capture
```

The dependency direction is one-way:

```text
application -> fleet -> plugin
```

The plugin must never learn about Fleet, worktrees, test suites, dashboards, or
AI providers.

## Documentation

- [Architecture](docs/architecture.md)
- [Implementation plan](docs/implementation-plan.md)
- [Ducktape migration](docs/ducktape-migration.md)
- [Token budget](docs/token-budget.md)

## Initial scope

- Linux/X11 headless execution with Xvfb and x11vnc
- Git worktree/revision discovery
- Wry and CEF runtime variants
- Build-once, run-many isolated application instances
- Bounded parallel suite scheduling
- Low-cost model runners with deterministic success checks
- A read-oriented dashboard with VNC tiles and run artifacts

## Explicit non-goals

- A Maestro-compatible DSL
- A cloud execution service
- Kubernetes or distributed scheduling
- Native Appium-style controls
- Reimplementing Chrome DevTools Protocol
- Unbounded parallel execution
- A provider abstraction before a second provider is actually needed

## License

MIT OR Apache-2.0.
