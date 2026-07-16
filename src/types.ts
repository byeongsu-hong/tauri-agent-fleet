// A runtime is a build variant named by config (wry, cef, native, …). Fleet no
// longer hardcodes the set; each runtime names the driver that drives it.
export type RuntimeVariant = string

export interface RuntimeDefinition {
  driver: string
  build: string[]
}

export type LifecycleState =
  | 'booting'
  | 'ready'
  | 'running'
  | 'passed'
  | 'failed'
  | 'stopped'

export type FailureClass = 'app_failure' | 'runner_failure' | 'infrastructure_failure'

export interface FleetConfig {
  protocol: 'agent-fleet/v1'
  application: { id: string; root: string }
  lifecycle?: {
    prepareBuild?: string[]
    prepareInstance?: string[]
    cleanupInstance?: string[]
  }
  runtimes: { [name: string]: string | RuntimeDefinition; default: string }
}

export interface ArtifactManifest {
  protocol: 'agent-artifact/v1'
  executable: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

export interface Locator {
  scope?: string
  role?: string
  name?: string
  text?: string
}

export type RunnerAction =
  | ({ type: 'click' | 'hover' | 'focus' | 'blur' } & Locator)
  | ({ type: 'fill' | 'type' } & Locator & { value: string })
  | ({ type: 'press' } & Locator & { value: string })
  | ({ type: 'scroll' } & Locator & { x?: number; y?: number })
  | { type: 'wait'; milliseconds: number }

export type SuccessCondition =
  | { state: { key: string; equals: unknown } }
  | { event: { name: string; ok?: boolean } }
  | { expect: Locator & { present?: boolean; value?: string; hasState?: string } }

export interface Suite {
  protocol: 'agent-suite/v1'
  id: string
  runtime?: RuntimeVariant
  objective: string
  pass: SuccessCondition[]
  budget: { steps: number; seconds: number; tokens?: number; repetitions?: number }
}

export interface Revision {
  repository: string
  worktree: string
  branch?: string
  commit: string
  dirtyFingerprint: string
}

export interface ProcessRecord {
  name: 'xvfb' | 'vnc' | 'app'
  pid: number
  pgid: number
  startTime: string
  identitySource?: 'linux-proc' | 'darwin-libproc'
  executable?: string
  command: string[]
}

export interface InstanceRecord {
  schemaVersion: 1
  id: string
  revision: Revision
  variant: RuntimeVariant
  artifactKey: string
  state: LifecycleState
  createdAt: string
  updatedAt: string
  slot: number
  display: string
  vncPort: number
  appPort: number
  vncToken: string
  directories: { root: string; home: string; runtime: string; data: string; artifacts: string }
  processes: ProcessRecord[]
  endpoint?: { healthy: boolean; capabilities?: unknown }
  failure?: { class: FailureClass; message: string }
  run?: {
    id: string
    suite: string
    objective: string
    step: number
    startedAt: string
    finishedAt?: string
    budget: Suite['budget']
    inputTokens: number
    outputTokens: number
    cost?: number
    failure?: FailureClass
    message?: string
  }
}
