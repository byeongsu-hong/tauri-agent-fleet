# Repository instructions

## Purpose

This repository owns multi-instance orchestration around `tauri-agent-plugin`.
It does not own application instrumentation or product-specific provisioning.

Read these documents before implementation work:

1. `docs/architecture.md`
2. `docs/implementation-plan.md`
3. `docs/token-budget.md`
4. `docs/ducktape-migration.md` when changing Ducktape integration

## Boundaries

- Keep `tauri-agent-plugin` focused on one running application.
- Keep Ducktape-specific node/workspace setup in Ducktape hooks.
- Fleet may depend on the plugin's published TypeScript client and protocol.
- The plugin must not depend on Fleet.
- Do not move the existing Ducktape Fleet source here unchanged. Extract behavior,
  parameterize the application boundary, and fix lifecycle ownership first.

## Delivery

- Branch from `main` using `agent/<description>`.
- Keep each PR independently reviewable and runnable.
- Prefer extraction parity before feature expansion.
- Do not remove the Ducktape implementation until the new Fleet passes the
  side-by-side cutover gates in `docs/ducktape-migration.md`.
- Publish generated dashboard assets during packaging; do not commit `dist/`.

## Implementation constraints

- Use Bun and platform tools already required by the current Linux fleet.
- Use JSON for the v1 configuration and suite formats. Do not add YAML until
  real authorship demand justifies another parser and grammar.
- Track and terminate exact process groups. Never use broad `pkill -f` patterns.
- Bind the dashboard to loopback by default.
- Use random opaque VNC route tokens; branch names are identifiers, not secrets.
- Keep state directories user-private and isolate HOME, XDG runtime, display,
  application data, and ports per instance.
- Build once per revision/runtime variant and run multiple isolated instances
  from the resulting artifact.
- Keep the dashboard read-oriented initially. Lifecycle control stays in the CLI.

## Runner rules

- Use the plugin's direct TypeScript client instead of MCP inside Fleet.
- Let the model choose actions; use deterministic assertions for pass/fail.
- Do not expose arbitrary shell or JavaScript evaluation to low-cost runners.
- Enforce step, time, token, and repetition limits.
- Persist actions and diagnostics as artifacts instead of appending the full
  transcript to every model request.
- Classify failures as `app_failure`, `runner_failure`, or
  `infrastructure_failure`.

## Verification expectations

Every non-trivial lifecycle change needs a focused test. Before a Ducktape
cutover, verify:

- two isolated instances from different worktrees;
- two isolated instances from the same build artifact;
- exact single-instance teardown;
- Wry and CEF smoke runs;
- dashboard VNC routing;
- agent endpoint isolation;
- deterministic runner assertions;
- token-budget measurements.
