import {
  DebuggerClient,
  SocketTransport,
  readEndpointRegistry,
  type EndpointDescriptor
} from '@byeongsu-hong/tauri-agent-plugin/daemon'
import type { AgentMethod, FindResult, IpcEntry, ScreenshotResult, StreamResult, TreeResult } from '@byeongsu-hong/tauri-agent-plugin/protocol'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { InfrastructureError, type AgentSession, type AttachContext, type Driver, type DriverCapabilities } from '../driver.ts'
import { processIdentity, processOwned } from '../process.ts'
import { appendJsonLine, atomicJson } from '../storage.ts'
import type { Locator, RunnerAction, SuccessCondition } from '../types.ts'

function clientFor(descriptor: EndpointDescriptor, timeoutMs?: number): DebuggerClient {
  const transport = descriptor.transport === 'unix'
    ? new SocketTransport({ path: descriptor.path }, timeoutMs)
    : new SocketTransport({ host: descriptor.host, port: descriptor.port }, timeoutMs)
  return new DebuggerClient(transport, descriptor.token)
}

async function attach(appId: string, runtimeDir: string, app: AttachContext['app'], timeoutMs: number): Promise<{ client: DebuggerClient; descriptor: EndpointDescriptor; capabilities: unknown }> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    if (!await processOwned(app)) throw new Error('application exited before agent attach')
    try {
      const descriptor = await readEndpointRegistry(appId, { env: { XDG_RUNTIME_DIR: runtimeDir } })
      const identity = await processIdentity(descriptor.pid)
      if (!identity || identity.pgid !== app.pgid) throw new Error('endpoint belongs to a different process group')
      const response = await clientFor(descriptor, Math.max(1, Math.min(2_000, deadline - Date.now()))).call<Record<string, unknown>>('attach', { app: appId })
      if (!Array.isArray(response.windows) || response.windows.length === 0) throw new Error('guest bridge has no registered windows')
      return { client: clientFor(descriptor, Math.min(timeoutMs, 10_000)), descriptor, capabilities: response }
    } catch (error) { lastError = error }
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for plugin attach${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

function canAtomicAct(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== 'object') return false
  const value = capabilities as Record<string, unknown>
  const nested = value.capabilities
  const actions = value.actions
  return value.atomicAction === true
    || value.locatorAction === true
    || value.atomicLocatorAction === true
    || (Array.isArray(value.methods) && value.methods.includes('act'))
    || (Array.isArray(actions) && actions.some((entry) => entry === 'act' || entry === 'locator'))
    || Boolean(actions && typeof actions === 'object' && (actions as Record<string, unknown>).locator === true)
    || (nested !== undefined && canAtomicAct(nested))
}

function locator(action: RunnerAction): Locator {
  if (action.type === 'wait') return {}
  const { scope, role, name, text } = action
  return { ...(scope ? { scope } : {}), ...(role ? { role } : {}), ...(name ? { name } : {}), ...(text ? { text } : {}) }
}

async function executeAction(client: DebuggerClient, capabilities: unknown, action: RunnerAction): Promise<unknown> {
  if (action.type === 'wait') { await Bun.sleep(action.milliseconds); return { waited: action.milliseconds } }
  if (canAtomicAct(capabilities)) {
    return await client.call('act' as AgentMethod, { ...locator(action), action: action.type, value: 'value' in action ? action.value : undefined, x: 'x' in action ? action.x : undefined, y: 'y' in action ? action.y : undefined, timeoutMs: 10_000 })
  }
  if (action.type === 'press' && Object.keys(locator(action)).length === 0) return await client.call('press', { key: action.value })
  const found = await client.call<FindResult>('find', { ...locator(action), limit: 2 })
  if (found.matches.length !== 1) throw new Error(`locator matched ${found.matches.length} elements`)
  const ref = found.matches[0]!.ref
  switch (action.type) {
    case 'fill': case 'type': return await client.call(action.type, { ref, text: action.value })
    case 'press': return await client.call('press', { ref, key: action.value })
    case 'scroll': return await client.call('scroll', { ref, x: action.x, y: action.y })
    default: return await client.call(action.type, { ref })
  }
}

// Exported for the deterministic-condition unit test. Evaluates a single state
// or expect condition; event conditions are batched by evaluate() below.
export async function conditionMet(client: DebuggerClient, condition: SuccessCondition): Promise<boolean> {
  if ('state' in condition) {
    const value = await client.call('state', { key: condition.state.key })
    return isDeepStrictEqual(value, condition.state.equals)
  }
  if ('event' in condition) throw new Error('event conditions are evaluated together')
  try { await client.call('expect', { ...condition.expect }); return true } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    const message = error instanceof Error ? error.message : ''
    if (code === 'AGENT_ERROR' || message.startsWith('AGENT_ERROR:')) return false
    if ((code === 'BRIDGE_UNAVAILABLE' || message.startsWith('BRIDGE_UNAVAILABLE:')) && message.includes('expect:')) return false
    throw error
  }
}

interface AssertionState { eventCursor?: number; eventMatches: Set<number> }

async function passed(client: DebuggerClient, conditions: SuccessCondition[], state: AssertionState): Promise<boolean> {
  const eventConditions = conditions.map((condition, index) => ({ condition, index })).filter((entry) => 'event' in entry.condition)
  if (eventConditions.length) {
    // The wire method stays `ipc`; Fleet's semantic name is `event`.
    const raw = await client.call<unknown>('ipc', { ...(state.eventCursor === undefined ? {} : { since: state.eventCursor }), limit: 1000 })
    const result = Array.isArray(raw) ? undefined : raw as { entries?: unknown[]; cursor?: number }
    const entries = (Array.isArray(raw) ? raw : result?.entries ?? []) as IpcEntry[]
    if (typeof result?.cursor === 'number') state.eventCursor = result.cursor
    for (const { condition, index } of eventConditions) {
      if ('event' in condition && entries.some((entry) => entry.command === condition.event.name && (condition.event.ok === undefined || entry.ok === condition.event.ok))) {
        state.eventMatches.add(index)
      }
    }
  }
  const results = await Promise.all(conditions.map((condition, index) => 'event' in condition ? state.eventMatches.has(index) : conditionMet(client, condition)))
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
    ['console.jsonl', 'logs'], ['network.jsonl', 'network'], ['events.jsonl', 'ipc']
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

function isInfrastructureError(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const message = error instanceof Error ? error.message : ''
  return ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOENT', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)
    || message === 'debugger request timed out'
    || message === 'debugger connection closed before a response'
}

class TauriSession implements AgentSession {
  readonly capabilities: DriverCapabilities
  private cursor: number | undefined
  private readonly assertion: AssertionState = { eventMatches: new Set() }

  constructor(
    private readonly client: DebuggerClient,
    private readonly diagnostics: DebuggerClient,
    private readonly raw: unknown
  ) {
    this.capabilities = { atomicAct: canAtomicAct(raw), stream: true, event: true, screenshot: true }
  }

  async execute(action: RunnerAction): Promise<unknown> {
    try {
      return await executeAction(this.client, this.raw, action)
    } catch (error) {
      if (isInfrastructureError(error)) throw new InfrastructureError(error instanceof Error ? error.message : String(error), { cause: error })
      throw error
    }
  }

  async observe(): Promise<unknown> {
    const seen = await observation(this.client, this.cursor)
    this.cursor = seen.cursor ?? this.cursor ?? 0
    return seen.value
  }

  async evaluate(conditions: SuccessCondition[]): Promise<boolean> {
    return await passed(this.client, conditions, this.assertion)
  }

  async startRecording(): Promise<void> {
    await this.client.call('record', { action: 'start' })
  }

  async stopRecording(): Promise<void> {
    try { await this.diagnostics.call('record', { action: 'stop' }) } catch { /* optional on older plugins */ }
  }

  async persistCaptures(dir: string): Promise<void> {
    await persistCaptures(this.diagnostics, dir)
  }

  async screenshot(path: string): Promise<void> {
    await this.diagnostics.call<ScreenshotResult>('shot', { path, backend: 'auto' })
  }

  async close(): Promise<void> {
    /* connections are per-instance and reaped with the app process group */
  }
}

export const tauriDriver: Driver = {
  name: 'tauri',
  driverProtocol: 'agent-fleet-driver/v1',
  async attach(context: AttachContext): Promise<AgentSession> {
    const attached = await attach(context.appId, context.runtimeDir, context.app, Math.max(1, context.deadline - Date.now()))
    const diagnostics = clientFor(attached.descriptor, 1_000)
    return new TauriSession(attached.client, diagnostics, attached.capabilities)
  },
  async probe(context: AttachContext): Promise<unknown> {
    return (await attach(context.appId, context.runtimeDir, context.app, Math.max(1, context.deadline - Date.now()))).capabilities
  }
}

export default tauriDriver
