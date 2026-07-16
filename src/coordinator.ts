import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSuite } from './schema.ts'
import { atomicJson, privateDir, withLock } from './storage.ts'
import type { FailureClass, RuntimeVariant, Suite } from './types.ts'

export const COORDINATOR_PROTOCOL = 'agent-coordinator/v1' as const
export type CoordinatorJobState = 'queued' | 'leased' | 'running' | 'passed' | 'failed'

export interface CoordinatorJob {
  protocol: typeof COORDINATOR_PROTOCOL
  id: string
  repository: string
  commit: string
  suite: Suite
  runtime: RuntimeVariant
  state: CoordinatorJobState
  attempt: number
  createdAt: string
  updatedAt: string
  workerId?: string
  leaseExpiresAt?: string
  leaseHash?: string
  failure?: { class: FailureClass; message: string }
  run?: { inputTokens: number; outputTokens: number; cost?: number }
  artifacts?: string[]
}

export type PublicCoordinatorJob = Omit<CoordinatorJob, 'leaseHash'>

export class CoordinatorError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

interface JobInput {
  repository: string
  commit: string
  suite: Suite
  runtime: RuntimeVariant
}

interface JobResult {
  state: 'passed' | 'failed'
  failure?: { class: FailureClass; message: string }
  run?: CoordinatorJob['run']
}

interface CoordinatorStoreOptions {
  maxActive: number
  leaseMs?: number
  maxAttempts?: number
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const REPOSITORY = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
export const COORDINATOR_ARTIFACTS = new Set([
  'run.json', 'actions.jsonl', 'model-usage.jsonl', 'semantic.jsonl',
  'console.jsonl', 'network.jsonl', 'events.jsonl', 'failure.png', 'replay.json'
])
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
export const MAX_JOB_ARTIFACT_BYTES = 64 * 1024 * 1024

function leaseHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function sameHash(expected: string, token: string): boolean {
  const actual = leaseHash(token)
  return expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
}

function publicJob({ leaseHash: _, ...job }: CoordinatorJob): PublicCoordinatorJob {
  return job
}

function jobInput(value: unknown): JobInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoordinatorError(400, 'job must be an object')
  const raw = value as Record<string, unknown>
  const unknown = Object.keys(raw).filter((key) => !['protocol', 'repository', 'commit', 'suite', 'runtime'].includes(key))
  if (unknown.length) throw new CoordinatorError(400, `job contains unknown field: ${unknown[0]}`)
  if (raw.protocol !== COORDINATOR_PROTOCOL) throw new CoordinatorError(400, `job.protocol must be ${COORDINATOR_PROTOCOL}`)
  if (typeof raw.repository !== 'string' || !REPOSITORY.test(raw.repository)) throw new CoordinatorError(400, 'job.repository must be a SHA-256 identity')
  if (typeof raw.commit !== 'string' || !COMMIT.test(raw.commit)) throw new CoordinatorError(400, 'job.commit must be a 40-character SHA')
  if (raw.runtime !== 'wry' && raw.runtime !== 'cef') throw new CoordinatorError(400, 'job.runtime must be wry or cef')
  let suite: Suite
  try { suite = parseSuite(raw.suite) } catch (error) { throw new CoordinatorError(400, error instanceof Error ? error.message : String(error)) }
  if (suite.runtime !== undefined && suite.runtime !== raw.runtime) throw new CoordinatorError(400, 'job runtime does not match suite runtime')
  return { repository: raw.repository, commit: raw.commit, suite, runtime: raw.runtime }
}

function jobResult(value: unknown): JobResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoordinatorError(400, 'result must be an object')
  const raw = value as Record<string, unknown>
  const unknown = Object.keys(raw).filter((key) => !['state', 'failure', 'run'].includes(key))
  if (unknown.length) throw new CoordinatorError(400, `result contains unknown field: ${unknown[0]}`)
  if (raw.state !== 'passed' && raw.state !== 'failed') throw new CoordinatorError(400, 'result.state must be passed or failed')
  let failure: JobResult['failure']
  if (raw.failure !== undefined) {
    if (!raw.failure || typeof raw.failure !== 'object' || Array.isArray(raw.failure)) throw new CoordinatorError(400, 'result.failure must be an object')
    const item = raw.failure as Record<string, unknown>
    const unknownFailure = Object.keys(item).filter((key) => !['class', 'message'].includes(key))
    if (unknownFailure.length) throw new CoordinatorError(400, `result.failure contains unknown field: ${unknownFailure[0]}`)
    if (!['app_failure', 'runner_failure', 'infrastructure_failure'].includes(String(item.class))) throw new CoordinatorError(400, 'result.failure.class is invalid')
    if (typeof item.message !== 'string' || !item.message || item.message.length > 8_192) throw new CoordinatorError(400, 'result.failure.message is invalid')
    failure = { class: item.class as FailureClass, message: item.message }
  }
  if (raw.state === 'passed' && failure) throw new CoordinatorError(400, 'passed job cannot include failure')
  if (raw.state === 'failed' && !failure) throw new CoordinatorError(400, 'failed job requires failure')
  let run: JobResult['run']
  if (raw.run !== undefined) {
    if (!raw.run || typeof raw.run !== 'object' || Array.isArray(raw.run)) throw new CoordinatorError(400, 'result.run must be an object')
    const item = raw.run as Record<string, unknown>
    const unknownRun = Object.keys(item).filter((key) => !['inputTokens', 'outputTokens', 'cost'].includes(key))
    if (unknownRun.length) throw new CoordinatorError(400, `result.run contains unknown field: ${unknownRun[0]}`)
    if (!Number.isSafeInteger(item.inputTokens) || Number(item.inputTokens) < 0 || !Number.isSafeInteger(item.outputTokens) || Number(item.outputTokens) < 0) {
      throw new CoordinatorError(400, 'result.run token usage is invalid')
    }
    if (item.cost !== undefined && (!Number.isFinite(item.cost) || Number(item.cost) < 0)) throw new CoordinatorError(400, 'result.run cost is invalid')
    run = { inputTokens: Number(item.inputTokens), outputTokens: Number(item.outputTokens), ...(item.cost === undefined ? {} : { cost: Number(item.cost) }) }
  }
  return { state: raw.state, ...(failure ? { failure } : {}), ...(run ? { run } : {}) }
}

export class CoordinatorStore {
  readonly leaseMs: number
  readonly maxAttempts: number

  constructor(readonly root: string, readonly options: CoordinatorStoreOptions) {
    if (!Number.isSafeInteger(options.maxActive) || options.maxActive < 1) throw new Error('maxActive must be a positive safe integer')
    this.leaseMs = options.leaseMs ?? 30_000
    this.maxAttempts = options.maxAttempts ?? 3
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1) throw new Error('leaseMs must be a positive safe integer')
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1) throw new Error('maxAttempts must be a positive safe integer')
  }

  async enqueue(value: unknown, now = Date.now()): Promise<PublicCoordinatorJob> {
    const input = jobInput(value)
    return await this.lock(async () => {
      const timestamp = new Date(now).toISOString()
      const job: CoordinatorJob = {
        protocol: COORDINATOR_PROTOCOL,
        id: randomBytes(16).toString('hex'),
        ...input,
        state: 'queued',
        attempt: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      }
      await this.save(job)
      return publicJob(job)
    })
  }

  async claim(workerId: string, now = Date.now()): Promise<{ job: PublicCoordinatorJob; leaseToken: string } | undefined> {
    if (!ID.test(workerId)) throw new CoordinatorError(400, 'workerId must be a safe identifier')
    return await this.lock(async () => {
      const jobs = await this.readJobs()
      await this.expire(jobs, now)
      if (jobs.filter((job) => job.state === 'leased' || job.state === 'running').length >= this.options.maxActive) return undefined
      const job = jobs.filter((item) => item.state === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]
      if (!job) return undefined
      const leaseToken = randomBytes(32).toString('base64url')
      job.state = 'leased'
      job.attempt++
      job.workerId = workerId
      job.leaseHash = leaseHash(leaseToken)
      job.leaseExpiresAt = new Date(now + this.leaseMs).toISOString()
      job.updatedAt = new Date(now).toISOString()
      await this.save(job)
      return { job: publicJob(job), leaseToken }
    })
  }

  async heartbeat(id: string, workerId: string, leaseToken: string, now = Date.now()): Promise<PublicCoordinatorJob> {
    return await this.lock(async () => {
      const job = await this.currentLease(id, workerId, leaseToken, now)
      job.state = 'running'
      job.leaseExpiresAt = new Date(now + this.leaseMs).toISOString()
      job.updatedAt = new Date(now).toISOString()
      await this.save(job)
      return publicJob(job)
    })
  }

  async finish(
    id: string,
    workerId: string,
    leaseToken: string,
    value: unknown,
    now = Date.now()
  ): Promise<PublicCoordinatorJob> {
    const result = jobResult(value)
    return await this.lock(async () => {
      const job = await this.currentLease(id, workerId, leaseToken, now)
      job.state = result.state
      if (result.failure) job.failure = result.failure
      if (result.run) job.run = result.run
      delete job.leaseHash
      delete job.leaseExpiresAt
      job.updatedAt = new Date(now).toISOString()
      await this.save(job)
      return publicJob(job)
    })
  }

  async list(now = Date.now()): Promise<PublicCoordinatorJob[]> {
    return await this.lock(async () => {
      const jobs = await this.readJobs()
      await this.expire(jobs, now)
      return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(publicJob)
    })
  }

  async putArtifact(
    id: string,
    workerId: string,
    leaseToken: string,
    name: string,
    contents: Uint8Array,
    now = Date.now()
  ): Promise<PublicCoordinatorJob> {
    if (!COORDINATOR_ARTIFACTS.has(name)) throw new CoordinatorError(400, 'artifact name is not allowed')
    if (contents.byteLength > MAX_ARTIFACT_BYTES) throw new CoordinatorError(413, 'artifact is too large')
    return await this.lock(async () => {
      const job = await this.currentLease(id, workerId, leaseToken, now)
      const directory = join(this.root, 'jobs', id, 'artifacts')
      await privateDir(directory)
      let total = contents.byteLength
      for (const existing of await readdir(directory)) {
        if (existing === name) continue
        const value = await lstat(join(directory, existing))
        if (value.isFile()) total += value.size
      }
      if (total > MAX_JOB_ARTIFACT_BYTES) throw new CoordinatorError(413, 'job artifact limit exceeded')
      const path = join(directory, name)
      const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
      try {
        await writeFile(temporary, contents, { mode: 0o600 })
        await rename(temporary, path)
      } finally { await rm(temporary, { force: true }) }
      job.artifacts = [...new Set([...(job.artifacts ?? []), name])].sort()
      job.updatedAt = new Date(now).toISOString()
      await this.save(job)
      return publicJob(job)
    })
  }

  async getArtifact(id: string, name: string): Promise<Uint8Array> {
    if (!ID.test(id) || !COORDINATOR_ARTIFACTS.has(name)) throw new CoordinatorError(404, 'artifact not found')
    try {
      const value = await lstat(join(this.root, 'jobs', id, 'artifacts', name))
      if (!value.isFile() || value.isSymbolicLink()) throw new CoordinatorError(404, 'artifact not found')
      return await readFile(join(this.root, 'jobs', id, 'artifacts', name))
    } catch (error) {
      if (error instanceof CoordinatorError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CoordinatorError(404, 'artifact not found')
      throw error
    }
  }

  private async currentLease(id: string, workerId: string, token: string, now: number): Promise<CoordinatorJob> {
    if (!ID.test(id) || !ID.test(workerId) || !token) throw new CoordinatorError(400, 'invalid lease identity')
    const job = await this.read(id)
    if (!job) throw new CoordinatorError(404, 'job not found')
    if ((job.state !== 'leased' && job.state !== 'running') || !job.leaseHash || job.workerId !== workerId || !sameHash(job.leaseHash, token)) {
      throw new CoordinatorError(409, 'stale job lease')
    }
    if (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= now) throw new CoordinatorError(409, 'expired job lease')
    return job
  }

  private async expire(jobs: CoordinatorJob[], now: number): Promise<void> {
    for (const job of jobs) {
      if ((job.state !== 'leased' && job.state !== 'running') || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) > now) continue
      delete job.leaseHash
      delete job.leaseExpiresAt
      if (job.attempt >= this.maxAttempts) {
        job.state = 'failed'
        job.failure = { class: 'infrastructure_failure', message: `worker lease expired after ${job.attempt} attempts` }
      } else {
        job.state = 'queued'
        delete job.workerId
        delete job.artifacts
        await rm(join(this.root, 'jobs', job.id, 'artifacts'), { recursive: true, force: true })
      }
      job.updatedAt = new Date(now).toISOString()
      await this.save(job)
    }
  }

  private async lock<T>(action: () => Promise<T>): Promise<T> {
    await privateDir(this.root)
    return await withLock(join(this.root, '.coordinator.lock'), action)
  }

  private path(id: string): string { return join(this.root, 'jobs', id, 'job.json') }

  private async save(job: CoordinatorJob): Promise<void> { await atomicJson(this.path(job.id), job) }

  private async read(id: string): Promise<CoordinatorJob | undefined> {
    try { return JSON.parse(await readFile(this.path(id), 'utf8')) as CoordinatorJob } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async readJobs(): Promise<CoordinatorJob[]> {
    let ids: string[]
    try { ids = await readdir(join(this.root, 'jobs')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return (await Promise.all(ids.filter((id) => ID.test(id)).map((id) => this.read(id)))).filter((job): job is CoordinatorJob => Boolean(job))
  }
}
