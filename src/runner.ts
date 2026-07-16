import { InfrastructureError, type AgentSession, type Driver } from './driver.ts'
import type { ModelDecision, ModelUsage, RunnerContext } from './provider.ts'
import { appendJsonLine, atomicJson, privateDir, saveInstance } from './storage.ts'
import { processOwned } from './process.ts'
import type { FailureClass, InstanceRecord, Suite } from './types.ts'
import { join } from 'node:path'
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

export async function runSuite(
  root: string,
  appId: string,
  instance: InstanceRecord,
  suite: Suite,
  nextAction: NextAction,
  driver: Driver
): Promise<InstanceRecord> {
  if (instance.state !== 'ready') throw new Error(`instance is not ready: ${instance.id}`)
  const app = instance.processes.find((process) => process.name === 'app')
  if (!app) throw new Error('instance has no application process')
  const runId = `${suite.id}-${crypto.randomUUID()}`
  const dir = join(instance.directories.artifacts, runId)
  await privateDir(dir)
  await Promise.all(['actions.jsonl', 'model-usage.jsonl', 'semantic.jsonl', 'console.jsonl', 'network.jsonl', 'events.jsonl']
    .map((file) => writeFile(join(dir, file), '', { mode: 0o600 })))
  const started = Date.now()
  const deadline = started + suite.budget.seconds * 1000
  instance.state = 'running'
  instance.run = { id: runId, suite: suite.id, objective: suite.objective, step: 0, startedAt: new Date(started).toISOString(), budget: suite.budget, inputTokens: 0, outputTokens: 0 }
  await saveInstance(root, instance)
  let session: AgentSession | undefined
  let failure: FailureClass | undefined
  let message: string | undefined
  let previous: RunnerContext['previousAction']
  let repeated = 0
  let previousKey = ''
  try {
    session = await byDeadline(driver.attach({ appId, runtimeDir: instance.directories.runtime, app, deadline }), deadline)
    try { await byDeadline(session.startRecording(), deadline) } catch (error) {
      if (error instanceof SuiteDeadline) throw error
      /* recording is optional on compatible driver releases */
    }
    if (await byDeadline(session.evaluate(suite.pass), deadline)) {
      instance.state = 'passed'
    } else {
      for (let step = 0; step < suite.budget.steps; step++) {
        if (Date.now() - started >= suite.budget.seconds * 1000) { failure = 'app_failure'; message = 'suite time limit exceeded'; break }
        if (!await processOwned(app)) { failure = 'app_failure'; message = 'application exited'; break }
        const seen = await byDeadline(session.observe(), deadline)
        await appendJsonLine(join(dir, 'semantic.jsonl'), seen)
        const used = instance.run.inputTokens + instance.run.outputTokens
        if (suite.budget.tokens !== undefined && used >= suite.budget.tokens) { failure = 'runner_failure'; message = 'token limit exceeded'; break }
        let decision: ModelDecision
        try {
          decision = await byDeadline(nextAction({
            objective: suite.objective,
            pass: suite.pass,
            observation: seen,
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
        try { result = await byDeadline(session.execute(decision.action), deadline) } catch (error) {
          if (error instanceof SuiteDeadline) throw error
          if (error instanceof InfrastructureError) throw error
          failure = 'runner_failure'; message = error instanceof Error ? error.message : String(error); break
        }
        instance.run.step = step + 1
        previous = { action: decision.action, result }
        await appendJsonLine(join(dir, 'actions.jsonl'), { step: step + 1, action: decision.action, result })
        await saveInstance(root, instance)
        if (await byDeadline(session.evaluate(suite.pass), deadline)) { instance.state = 'passed'; break }
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
    if (session) {
      await session.stopRecording()
      await session.persistCaptures(dir)
      if (failure) {
        try { await session.screenshot(join(dir, 'failure.png')) } catch { /* best effort */ }
      }
      await session.close()
    }
    if (failure) {
      instance.state = 'failed'
      instance.run!.failure = failure
      if (message !== undefined) instance.run!.message = message
    }
    const finishedAt = new Date().toISOString()
    instance.run!.finishedAt = finishedAt
    await atomicJson(join(dir, 'run.json'), { protocol: 'agent-run/v1', instance: instance.id, suite, state: instance.state, run: instance.run, finishedAt })
    await saveInstance(root, instance)
  }
  return instance
}
