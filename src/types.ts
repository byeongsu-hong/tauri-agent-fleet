export type RuntimeVariant = 'wry' | 'cef'
export type LifecycleState =
  | 'queued'
  | 'building'
  | 'booting'
  | 'ready'
  | 'running'
  | 'passed'
  | 'failed'
  | 'stopped'

export type FailureClass = 'app_failure' | 'runner_failure' | 'infrastructure_failure'

export interface FleetConfig {
  schemaVersion: 1
  baseBranch?: string
  projectDir?: string
  stateDir?: string
  agent: { appId: string }
  hooks?: {
    prepareBuild?: string[]
    prepareInstance?: string[]
  }
  variants: Partial<Record<RuntimeVariant, { build: string[] }>>
}

export interface ArtifactManifest {
  schemaVersion: 1
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
  | { ipc: { command: string; ok?: boolean } }
  | { expect: Locator & { present?: boolean; value?: string; hasState?: string } }

export interface Suite {
  id: string
  variant?: RuntimeVariant
  goal: string
  success: SuccessCondition[]
  limits: { steps: number; seconds: number; tokens?: number; repetitions?: number }
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
  run?: {
    id: string
    suite: string
    step: number
    startedAt: string
    inputTokens: number
    outputTokens: number
    cost?: number
    failure?: FailureClass
    message?: string
  }
}

export interface FleetSnapshot {
  generatedAt: string
  instances: InstanceRecord[]
}
