import {
  DebuggerClient,
  SocketTransport,
  readEndpointRegistry,
  type EndpointDescriptor
} from '@byeongsu-hong/tauri-agent-plugin/daemon'
import type { AgentMethod, FindResult } from '@byeongsu-hong/tauri-agent-plugin/protocol'
import { processIdentity, processOwned } from './process.ts'
import type { Locator, ProcessRecord, RunnerAction } from './types.ts'

export function clientFor(descriptor: EndpointDescriptor, timeoutMs?: number): DebuggerClient {
  const transport = descriptor.transport === 'unix'
    ? new SocketTransport({ path: descriptor.path }, timeoutMs)
    : new SocketTransport({ host: descriptor.host, port: descriptor.port }, timeoutMs)
  return new DebuggerClient(transport, descriptor.token)
}

export async function attachAgent(
  appId: string,
  runtimeDir: string,
  app: ProcessRecord,
  timeoutMs = 60_000
): Promise<{ client: DebuggerClient; descriptor: EndpointDescriptor; capabilities: unknown }> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    if (!await processOwned(app)) throw new Error('application exited before agent attach')
    try {
      const descriptor = await readEndpointRegistry(appId, { env: { XDG_RUNTIME_DIR: runtimeDir } })
      const identity = await processIdentity(descriptor.pid)
      if (!identity || identity.pgid !== app.pgid) throw new Error('endpoint belongs to a different process group')
      const response = await clientFor(descriptor, 2_000).call<Record<string, unknown>>('attach', { app: appId })
      if (!Array.isArray(response.windows) || response.windows.length === 0) throw new Error('guest bridge has no registered windows')
      return { client: clientFor(descriptor), descriptor, capabilities: response }
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

export async function executeAction(client: DebuggerClient, capabilities: unknown, action: RunnerAction): Promise<unknown> {
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
