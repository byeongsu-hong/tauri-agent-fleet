# Token budget

Token efficiency is a product requirement, not a later optimization. Fleet is
expected to run many low-cost model sessions concurrently, so repeated tool
schemas and full-state observations dominate cost quickly.

## Baseline

Measure the current plugin at commit
`fc773cc18e85ac4deef0c450736af323d841b9f7` before changing the protocol.

Capture at least:

- MCP `tools/list` bytes and model tokens;
- first full semantic tree bytes/tokens;
- subsequent observation bytes/tokens;
- protocol calls per successful UI action;
- capture polling bytes for logs/events/network/IPC;
- model input/output tokens per suite and per step.

Use small, medium, and large Ducktape screens. Store raw byte/character counts in
tests and provider-reported token usage in run artifacts. Do not add a tokenizer
dependency solely to estimate billing tokens.

## Current hotspots

### Repeated MCP connection schemas

The plugin currently publishes more than thirty tools and repeats `app`, `port`,
`host`, `html`, and `fromHtml` on every tool schema.

Required change in `tauri-agent-plugin`:

- support a server-scoped target such as `tauri-agent-mcp --app <id>`;
- omit connection fields from tool schemas in scoped mode;
- offer a small `core` profile and retain `full` as an explicit profile.

Proposed core tools:

```text
attach, tree, find, act, expect, state, observe, shot
```

Fleet itself must use the direct TypeScript client instead of MCP.

### Duplicate MCP results

The current MCP response includes the same result in both textual `content` and
`structuredContent`. Large trees and arrays may therefore be represented twice.

Required change:

- omit duplicated structured content for large outputs;
- use compact JSON in MCP text responses;
- continue returning screenshots as image content rather than base64 text.

### Multi-call actions

Ref actions currently refresh a tree and then perform the action. A model often
also calls `find`, producing three protocol/model steps for one click.

Required change:

- add one locator-first atomic action;
- locate, wait for actionability, and act inside the guest in one request;
- return a minimal result and updated observation cursor.

### Repeated full stream snapshots

The semantic stream currently returns the full snapshot on every incremental
pull even when no resync is necessary.

Required change:

- include a full snapshot for initial synchronization;
- return only frames and cursor for normal incremental pulls;
- include a snapshot again only after dropped frames require resynchronization.

### Full capture-buffer polling

Logs, events, network, and IPC follow operations currently fetch the entire
bounded buffer and compute a length-based difference on the client.

Required change:

- assign monotonic sequence IDs;
- accept `since` and `limit`;
- return only new entries plus cursor/dropped metadata.

## Runner context contract

Every runner turn receives only:

1. immutable objective and deterministic pass conditions;
2. current scoped observation or latest delta;
3. previous action result;
4. remaining budgets.

Do not append:

- every previous full tree;
- the complete action transcript;
- full console/network/IPC buffers;
- screenshots unless semantic inspection failed;
- base64 data;
- the MCP tool catalog.

Persist those details as artifacts. A failure-analysis model may retrieve a
bounded section later.

The provider regression fixture currently measures 160 bytes of runner input
and 1,008 bytes for the complete Responses API request, including its strict
action schema.

## Acceptance targets

Relative to the measured baseline:

- scoped/core tool schema is at most 40% of the full current schema;
- post-initial observation averages at most 30% of full-tree tokens;
- a normal locator action uses one protocol request instead of tree/find/action;
- capture polling traffic is proportional to new entries;
- every run reports input tokens, output tokens, and cost when the provider
  supplies usage data.

Targets may be adjusted only with recorded measurements and a written reason.
