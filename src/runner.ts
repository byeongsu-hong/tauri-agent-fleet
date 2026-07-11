import type { DebuggerClient } from '@byeongsu-hong/tauri-agent-plugin/daemon'
import type { IpcEntry, ScreenshotResult, StreamResult, TreeResult } from '@byeongsu-hong/tauri-agent-plugin/protocol'
import { attachAgent, executeAction } from './agent.ts'
import type { ModelDecision, ModelUsage, RunnerContext } from './provider.ts'
import { appendJsonLine, atomicJson, privateDir, saveInstance } from './storage.ts'
import { processOwned } from './process.ts'
import type { FailureClass, InstanceRecord, Suite, SuccessCondition } from './types.ts'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { writeFile } from 'node:fs/promises'

export type NextAction = (context: RunnerContext) => Promise<ModelDecision>

async function conditionMet(client: DebuggerClient, condition: SuccessCondition): Promise<boolean> {
  if ('state' in condition) {
    const value = await client.call('state', { key: condition.state.key })
    return isDeepStrictEqual(value, condition.state.equals)
  }
  if ('ipc' in condition) throw new Error('IPC conditions are evaluated together')
  try { await client.call('expect', { ...condition.expect }); return true } catch { return false }
}

interface AssertionState { ipcCursor?: number; ipcMatches: Set<number> }

function validateUsage(usage: ModelUsage): void {
  for (const [name, value] of [['inputTokens', usage.inputTokens], ['outputTokens', usage.outputTokens]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`model usage ${name} must be a non-negative safe integer`)
  }
  if (usage.cost !== undefined && (!Number.isFinite(usage.cost) || usage.cost < 0)) throw new Error('model usage cost must be a non-negative finite number')
}

async function passed(client: DebuggerClient, conditions: SuccessCondition[], state: AssertionState): Promise<boolean> {
  const ipcConditions = conditions.map((condition, index) => ({ condition, index })).filter((entry) => 'ipc' in entry.condition)
  if (ipcConditions.length) {
    const raw = await client.call<unknown>('ipc', { ...(state.ipcCursor === undefined ? {} : { since: state.ipcCursor }), limit: 1000 })
    const result = Array.isArray(raw) ? undefined : raw as { entries?: unknown[]; cursor?: number }
    const entries = (Array.isArray(raw) ? raw : result?.entries ?? []) as IpcEntry[]
    if (typeof result?.cursor === 'number') state.ipcCursor = result.cursor
    for (const { condition, index } of ipcConditions) {
      if ('ipc' in condition && entries.some((entry) => entry.command === condition.ipc.command && (condition.ipc.ok === undefined || entry.ok === condition.ipc.ok))) {
        state.ipcMatches.add(index)
      }
    }
  }
  const results = await Promise.all(conditions.map((condition, index) => 'ipc' in condition ? state.ipcMatches.has(index) : conditionMet(client, condition)))
  return results.every(Boolean)
}

async function observation(client: DebuggerClient, cursor: number | undefined): Promise<{ value: unknown; cursor?: number }> {
  if (cursor === undefined) {
    const tree = await client.call<TreeResult>('tree', { mode: 'compact' })
    return { value: { snapshot: tree.text } }
  }
  try {
    const stream = await client.call<StreamResult>('stream', { since: cursor })
    return { value: stream.dropped ? { snapshot: stream.snapshot, dropped: true } : { frames: stream.frames }, cursor: stream.cursor }
  } catch {
    const tree = await client.call<TreeResult>('tree', { mode: 'compact' })
    return { value: { snapshot: tree.text } }
  }
}

async function persistCaptures(client: DebuggerClient, dir: string): Promise<void> {
  const captures: Array<[string, 'logs' | 'network' | 'ipc']> = [
    ['console.jsonl', 'logs'], ['network.jsonl', 'network'], ['ipc.jsonl', 'ipc']
  ]
  for (const [file, method] of captures) {
    try {
      const raw = await client.call<unknown>(method)
      const entries = Array.isArray(raw) ? raw : ((raw as { entries?: unknown[] })?.entries ?? [])
      for (const entry of entries) await appendJsonLine(join(dir, file), entry)
    } catch { /* preserve the other diagnostics */ }
  }
  try {
    const replay = await client.call('record', { action: 'get' })
    await atomicJson(join(dir, 'replay.json'), replay)
  } catch { /* older clients may not record */ }
}

export async function runSuite(
  root: string,
  appId: string,
  instance: InstanceRecord,
  suite: Suite,
  nextAction: NextAction
): Promise<InstanceRecord> {
  if (instance.state !== 'ready') throw new Error(`instance is not ready: ${instance.id}`)
  const app = instance.processes.find((process) => process.name === 'app')
  if (!app) throw new Error('instance has no application process')
  const runId = `${suite.id}-${crypto.randomUUID()}`
  const dir = join(instance.directories.artifacts, runId)
  await privateDir(dir)
  await Promise.all(['actions.jsonl', 'model-usage.jsonl', 'semantic.jsonl', 'console.jsonl', 'network.jsonl', 'ipc.jsonl']
    .map((file) => writeFile(join(dir, file), '', { mode: 0o600 })))
  const started = Date.now()
  instance.state = 'running'
  instance.run = { id: runId, suite: suite.id, step: 0, startedAt: new Date(started).toISOString(), inputTokens: 0, outputTokens: 0 }
  await saveInstance(root, instance)
  let client: DebuggerClient | undefined
  let failure: FailureClass | undefined
  let message: string | undefined
  let cursor: number | undefined
  let previous: RunnerContext['previousAction']
  let repeated = 0
  let previousKey = ''
  const assertions: AssertionState = { ipcMatches: new Set() }
  try {
    const attached = await attachAgent(appId, instance.directories.runtime, app)
    client = attached.client
    try { await client.call('record', { action: 'start' }) } catch { /* optional on compatible plugin releases */ }
    if (await passed(client, suite.success, assertions)) {
      instance.state = 'passed'
    } else {
      for (let step = 0; step < suite.limits.steps; step++) {
        if (Date.now() - started >= suite.limits.seconds * 1000) { failure = 'app_failure'; message = 'suite time limit exceeded'; break }
        if (!await processOwned(app)) { failure = 'app_failure'; message = 'application exited'; break }
        const seen = await observation(client, cursor)
        cursor = seen.cursor ?? cursor ?? 0
        await appendJsonLine(join(dir, 'semantic.jsonl'), seen.value)
        const used = instance.run.inputTokens + instance.run.outputTokens
        if (suite.limits.tokens !== undefined && used >= suite.limits.tokens) { failure = 'runner_failure'; message = 'token limit exceeded'; break }
        let decision: ModelDecision
        try {
          decision = await nextAction({
            goal: suite.goal,
            success: suite.success,
            observation: seen.value,
            ...(previous ? { previousAction: previous } : {}),
            remaining: {
              steps: suite.limits.steps - step,
              seconds: Math.max(0, Math.ceil((suite.limits.seconds * 1000 - (Date.now() - started)) / 1000)),
              ...(suite.limits.tokens === undefined ? {} : { tokens: Math.max(0, suite.limits.tokens - used) })
            }
          })
          validateUsage(decision.usage)
        } catch (error) {
          failure = 'runner_failure'; message = error instanceof Error ? error.message : String(error); break
        }
        instance.run.inputTokens += decision.usage.inputTokens
        instance.run.outputTokens += decision.usage.outputTokens
        if (decision.usage.cost !== undefined) instance.run.cost = (instance.run.cost ?? 0) + decision.usage.cost
        await appendJsonLine(join(dir, 'model-usage.jsonl'), decision.usage)
        if (suite.limits.tokens !== undefined && instance.run.inputTokens + instance.run.outputTokens > suite.limits.tokens) {
          failure = 'runner_failure'; message = 'token limit exceeded'; break
        }
        const key = JSON.stringify(decision.action)
        repeated = key === previousKey ? repeated + 1 : 1
        previousKey = key
        if (repeated > (suite.limits.repetitions ?? 3)) { failure = 'runner_failure'; message = 'repeated action limit exceeded'; break }
        let result: unknown
        try { result = await executeAction(client, attached.capabilities, decision.action) } catch (error) {
          failure = 'runner_failure'; message = error instanceof Error ? error.message : String(error); break
        }
        instance.run.step = step + 1
        previous = { action: decision.action, result }
        await appendJsonLine(join(dir, 'actions.jsonl'), { step: step + 1, action: decision.action, result })
        await saveInstance(root, instance)
        if (await passed(client, suite.success, assertions)) { instance.state = 'passed'; break }
      }
      if (instance.state !== 'passed' && !failure) { failure = 'runner_failure'; message = 'step limit exceeded' }
    }
  } catch (error) {
    failure = 'infrastructure_failure'
    message = error instanceof Error ? error.message : String(error)
  } finally {
    if (client) {
      try { await client.call('record', { action: 'stop' }) } catch { /* optional */ }
      await persistCaptures(client, dir)
      if (failure) {
        try { await client.call<ScreenshotResult>('shot', { path: join(dir, 'failure.png'), backend: 'auto' }) } catch { /* best effort */ }
      }
    }
    if (failure) {
      instance.state = 'failed'
      instance.run!.failure = failure
      instance.run!.message = message
    }
    await atomicJson(join(dir, 'run.json'), { schemaVersion: 1, instance: instance.id, suite, state: instance.state, run: instance.run, finishedAt: new Date().toISOString() })
    await saveInstance(root, instance)
  }
  return instance
}
