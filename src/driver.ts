import type { ProcessRecord, RunnerAction, SuccessCondition } from './types.ts'

// Driver protocol versions this Fleet can drive. A driver module declares which
// one it speaks; the loader refuses anything outside this set.
export const SUPPORTED_DRIVER_PROTOCOLS = new Set(['agent-fleet-driver/v1'])

// What a driver can do against one live app. Declared by the driver at attach,
// replacing runtime capability guessing. A condition or observation that needs
// an unsupported capability is the runner's problem, not a silent no-op.
export interface DriverCapabilities {
  atomicAct: boolean
  stream: boolean
  event: boolean
  screenshot: boolean
}

// One attached, driveable app instance. Every framework-specific detail — wire
// envelope, method names, @ref handling, capture shape — lives behind this. The
// runner only ever sees these semantic operations.
export interface AgentSession {
  readonly capabilities: DriverCapabilities
  execute(action: RunnerAction): Promise<unknown>
  observe(): Promise<unknown>
  evaluate(conditions: SuccessCondition[]): Promise<boolean>
  startRecording(): Promise<void>
  stopRecording(): Promise<void>
  persistCaptures(dir: string): Promise<void>
  screenshot(path: string): Promise<void>
  close(): Promise<void>
}

export interface AttachContext {
  appId: string
  runtimeDir: string
  app: ProcessRecord
  deadline: number
}

// A pluggable app-framework driver, loaded out-of-tree by import specifier.
export interface Driver {
  readonly name: string
  readonly driverProtocol: string
  // Full driveable session for a run.
  attach(context: AttachContext): Promise<AgentSession>
  // Lightweight readiness check: confirm the app's agent endpoint is live and
  // return its opaque, driver-defined capability report (surfaced as instance
  // endpoint health). Throws until the endpoint answers or the deadline passes.
  probe(context: AttachContext): Promise<unknown>
}

// A transport-level failure that must classify a run as infrastructure_failure
// rather than runner_failure. Drivers throw this from session methods when the
// connection to the app is lost; the runner distinguishes it by type, never by
// framework-specific error strings.
export class InfrastructureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'InfrastructureError'
  }
}

function isDriver(value: unknown): value is Driver {
  return Boolean(value)
    && typeof (value as Driver).attach === 'function'
    && typeof (value as Driver).probe === 'function'
    && typeof (value as Driver).driverProtocol === 'string'
    && typeof (value as Driver).name === 'string'
}

const FIRST_PARTY = '@byeongsu-hong/agent-fleet/driver-'

function firstPartyFallback(spec: string): string | undefined {
  if (!spec.startsWith(FIRST_PARTY)) return undefined
  return new URL(`./drivers/${spec.slice(FIRST_PARTY.length)}.ts`, import.meta.url).href
}

const cache = new Map<string, Promise<Driver>>()

// Load a driver by import specifier — a package (`@scope/agent-fleet-driver-x`)
// or a first-party subpath (`@byeongsu-hong/agent-fleet/driver-tauri`), resolved
// identically. Negotiates the driver protocol; caches successes only.
export function loadDriver(spec: string): Promise<Driver> {
  const cached = cache.get(spec)
  if (cached) return cached
  const loading = (async (): Promise<Driver> => {
    let module: Record<string, unknown>
    try {
      module = (await import(spec)) as Record<string, unknown>
    } catch (error) {
      // First-party subpath drivers (`@byeongsu-hong/agent-fleet/driver-<x>`)
      // resolve to dist via package exports once built; running from source with
      // no dist, fall back to the local module so dev and e2e work unbuilt.
      const local = firstPartyFallback(spec)
      if (!local) throw new Error(`could not load driver "${spec}": ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      module = (await import(local)) as Record<string, unknown>
    }
    const driver = module.default ?? module.driver
    if (!isDriver(driver)) throw new Error(`driver "${spec}" must default-export a Driver (name, driverProtocol, attach)`)
    if (!SUPPORTED_DRIVER_PROTOCOLS.has(driver.driverProtocol)) {
      throw new Error(`driver "${spec}" speaks ${driver.driverProtocol}, which this Fleet cannot drive (supports: ${[...SUPPORTED_DRIVER_PROTOCOLS].join(', ')})`)
    }
    return driver
  })()
  cache.set(spec, loading)
  loading.catch(() => cache.delete(spec))
  return loading
}
