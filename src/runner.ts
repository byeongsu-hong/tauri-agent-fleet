import type { DebuggerClient } from '@byeongsu-hong/tauri-agent-plugin/daemon'
import type { IpcEntry, ScreenshotResult, StreamResult, TreeResult } from '@byeongsu-hong/tauri-agent-plugin/protocol'
import { attachAgent, clientFor, executeAction } from './agent.ts'
import type { ModelDecision, ModelUsage, RunnerContext } from './provider.ts'
import { appendJsonLine, atomicJson, privateDir, saveInstance } from './storage.ts'
import { processOwned } from './process.ts'
import type { FailureClass, InstanceRecord, Suite, SuccessCondition } from './types.ts'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { writeFile } from 'node:fs/promises'

export type NextAction = (context: RunnerContext) => Promise<ModelDecision>

class SuiteDeadline extends Error {}

async function byDeadline<T>(value: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new SuiteDeadline('suite time limit exceeded')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SuiteDeadline('suite time limit exceeded')), remaining) })
    ])
  } finally { if (timer) clearTimeout(timer) }
}

export async function conditionMet(client: DebuggerClient, condition: SuccessCondition): Promise<boolean> {
  if ('state' in condition) {
    const value = await client.call('state', { key: condition.state.key })
    return isDeepStrictEqual(value, condition.state.equals)
  }
  if ('ipc' in condition) throw new Error('IPC conditions are evaluated together')
  try { await client.call('expect', { ...condition.expect }); return true } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    const message = error instanceof Error ? error.message : ''
    if (code === 'AGENT_ERROR' || message.startsWith('AGENT_ERROR:')) return false
    if ((code === 'BRIDGE_UNAVAILABLE' || message.startsWith('BRIDGE_UNAVAILABLE:')) && message.includes('expect:')) return false
    throw error
  }
}

interface AssertionState { ipcCursor?: number; ipcMatches: Set<number> }

function isInfrastructureError(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const message = error instanceof Error ? error.message : ''
  return ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOENT', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)
    || message === 'debugger request timed out'
    || message === 'debugger connection closed before a response'
}

function validateUsage(usage: ModelUsage, run: NonNullable<InstanceRecord['run']>): void {
  for (const [name, value] of [['inputTokens', usage.inputTokens], ['outputTokens', usage.outputTokens]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`model usage ${name} must be a non-negative safe integer`)
  }
  if (usage.cost !== undefined && (!Number.isFinite(usage.cost) || usage.cost < 0)) throw new Error('model usage cost must be a non-negative finite number')
  if (!Number.isSafeInteger(run.inputTokens + usage.inputTokens) || !Number.isSafeInteger(run.outputTokens + usage.outputTokens)) {
    throw new Error('model usage token totals exceed safe integer range')
  }
  if (!Number.isFinite((run.cost ?? 0) + (usage.cost ?? 0))) throw new Error('model usage cost total must be finite')
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
  await Promise.all(captures.map(async ([file, method]) => {
    try {
      const raw = await client.call<unknown>(method)
      const entries = Array.isArray(raw) ? raw : ((raw as { entries?: unknown[] })?.entries ?? [])
      for (const entry of entries) await appendJsonLine(join(dir, file), entry)
    } catch { /* preserve the other diagnostics */ }
  }))
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
  const deadline = started + suite.budget.seconds * 1000
  instance.state = 'running'
  instance.run = { id: runId, suite: suite.id, objective: suite.objective, step: 0, startedAt: new Date(started).toISOString(), budget: suite.budget, inputTokens: 0, outputTokens: 0 }
  await saveInstance(root, instance)
  let client: DebuggerClient | undefined
  let diagnosticClient: DebuggerClient | undefined
  let failure: FailureClass | undefined
  let message: string | undefined
  let cursor: number | undefined
  let previous: RunnerContext['previousAction']
  let repeated = 0
  let previousKey = ''
  const assertions: AssertionState = { ipcMatches: new Set() }
  try {
    const attached = await byDeadline(attachAgent(appId, instance.directories.runtime, app, Math.max(1, deadline - Date.now())), deadline)
    client = attached.client
    diagnosticClient = clientFor(attached.descriptor, 1_000)
    try { await byDeadline(client.call('record', { action: 'start' }), deadline) } catch (error) {
      if (error instanceof SuiteDeadline) throw error
      /* optional on compatible plugin releases */
    }
    if (await byDeadline(passed(client, suite.pass, assertions), deadline)) {
      instance.state = 'passed'
    } else {
      for (let step = 0; step < suite.budget.steps; step++) {
        if (Date.now() - started >= suite.budget.seconds * 1000) { failure = 'app_failure'; message = 'suite time limit exceeded'; break }
        if (!await processOwned(app)) { failure = 'app_failure'; message = 'application exited'; break }
        const seen = await byDeadline(observation(client, cursor), deadline)
        cursor = seen.cursor ?? cursor ?? 0
        await appendJsonLine(join(dir, 'semantic.jsonl'), seen.value)
        const used = instance.run.inputTokens + instance.run.outputTokens
        if (suite.budget.tokens !== undefined && used >= suite.budget.tokens) { failure = 'runner_failure'; message = 'token limit exceeded'; break }
        let decision: ModelDecision
        try {
          decision = await byDeadline(nextAction({
            objective: suite.objective,
            pass: suite.pass,
            observation: seen.value,
            ...(previous ? { previousAction: previous } : {}),
            remaining: {
              steps: suite.budget.steps - step,
              seconds: Math.max(0, Math.ceil((suite.budget.seconds * 1000 - (Date.now() - started)) / 1000)),
              ...(suite.budget.tokens === undefined ? {} : { tokens: Math.max(0, suite.budget.tokens - used) })
            }
          }), deadline)
          validateUsage(decision.usage, instance.run)
        } catch (error) {
          if (error instanceof SuiteDeadline) throw error
          failure = 'runner_failure'; message = error instanceof Error ? error.message : String(error); break
        }
        instance.run.inputTokens += decision.usage.inputTokens
        instance.run.outputTokens += decision.usage.outputTokens
        if (decision.usage.cost !== undefined) instance.run.cost = (instance.run.cost ?? 0) + decision.usage.cost
        await appendJsonLine(join(dir, 'model-usage.jsonl'), decision.usage)
        if (suite.budget.tokens !== undefined && instance.run.inputTokens + instance.run.outputTokens > suite.budget.tokens) {
          failure = 'runner_failure'; message = 'token limit exceeded'; break
        }
        if (!await processOwned(app)) { failure = 'app_failure'; message = 'application exited'; break }
        const key = JSON.stringify(decision.action)
        repeated = key === previousKey ? repeated + 1 : 1
        previousKey = key
        if (repeated > (suite.budget.repetitions ?? 3)) { failure = 'runner_failure'; message = 'repeated action limit exceeded'; break }
        let result: unknown
        try { result = await byDeadline(executeAction(client, attached.capabilities, decision.action), deadline) } catch (error) {
          if (error instanceof SuiteDeadline) throw error
          if (isInfrastructureError(error)) throw error
          failure = 'runner_failure'; message = error instanceof Error ? error.message : String(error); break
        }
        instance.run.step = step + 1
        previous = { action: decision.action, result }
        await appendJsonLine(join(dir, 'actions.jsonl'), { step: step + 1, action: decision.action, result })
        await saveInstance(root, instance)
        if (await byDeadline(passed(client, suite.pass, assertions), deadline)) { instance.state = 'passed'; break }
      }
      if (instance.state !== 'passed' && !failure) { failure = 'runner_failure'; message = 'step limit exceeded' }
    }
  } catch (error) {
    if (error instanceof SuiteDeadline) {
      failure = 'app_failure'; message = error.message
    } else if (!await processOwned(app)) {
      failure = 'app_failure'; message = 'application exited'
    } else {
      failure = 'infrastructure_failure'; message = error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (diagnosticClient) {
      try { await diagnosticClient.call('record', { action: 'stop' }) } catch { /* optional */ }
      await persistCaptures(diagnosticClient, dir)
      if (failure) {
        try { await diagnosticClient.call<ScreenshotResult>('shot', { path: join(dir, 'failure.png'), backend: 'auto' }) } catch { /* best effort */ }
      }
    }
    if (failure) {
      instance.state = 'failed'
      instance.run!.failure = failure
      if (message !== undefined) instance.run!.message = message
    }
    const finishedAt = new Date().toISOString()
    instance.run!.finishedAt = finishedAt
    await atomicJson(join(dir, 'run.json'), { protocol: 'tauri-agent-run/v1', instance: instance.id, suite, state: instance.state, run: instance.run, finishedAt })
    await saveInstance(root, instance)
  }
  return instance
}
