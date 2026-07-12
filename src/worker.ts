import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { COORDINATOR_ARTIFACTS, CoordinatorError, type PublicCoordinatorJob } from './coordinator.ts'
import type { CoordinatorClient } from './coordinator-server.ts'
import { discoverRevision, requireCleanRevision } from './revision.ts'
import { runSuites } from './scheduler.ts'
import { privateDir } from './storage.ts'
import type { FleetConfig, InstanceRecord, Revision } from './types.ts'

export interface WorkerClient {
  claim(workerId: string): ReturnType<CoordinatorClient['claim']>
  heartbeat(id: string, workerId: string, leaseToken: string): ReturnType<CoordinatorClient['heartbeat']>
  upload(id: string, workerId: string, leaseToken: string, name: string, value: Uint8Array): ReturnType<CoordinatorClient['upload']>
  finish(id: string, workerId: string, leaseToken: string, result: unknown): ReturnType<CoordinatorClient['finish']>
}

export interface WorkerOptions {
  client: WorkerClient
  config: FleetConfig
  repository: string
  root: string
  id: string
  jobs: number
  once?: boolean
  signal?: AbortSignal
  pollMs?: number
  heartbeatMs?: number
  resolveRevision?: (repository: string, root: string, job: PublicCoordinatorJob) => Promise<Revision>
  execute?: (config: FleetConfig, root: string, revision: Revision, job: PublicCoordinatorJob) => Promise<InstanceRecord>
}

function safeId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) }

export async function resolveWorkerRevision(repository: string, root: string, job: PublicCoordinatorJob): Promise<Revision> {
  if (!job.commit.match(/^[a-f0-9]{40}$/)) throw new Error('coordinator job commit is invalid')
  const revision = await discoverRevision(repository, job.commit, root, { isolated: true })
  if (revision.repository !== job.repository) throw new Error('job repository does not match worker repository')
  if (revision.commit !== job.commit) throw new Error('worker resolved a different commit')
  return requireCleanRevision(revision)
}

async function defaultExecute(config: FleetConfig, root: string, revision: Revision, job: PublicCoordinatorJob): Promise<InstanceRecord> {
  if (!config.runtimes[job.runtime]) throw new Error(`runtime is not configured on worker: ${job.runtime}`)
  const [result] = await runSuites(config, root, revision, [job.suite], { jobs: 1, runtime: job.runtime })
  if (!result) throw new Error('worker produced no suite result')
  return result
}

async function uploadEvidence(client: WorkerClient, job: PublicCoordinatorJob, workerId: string, leaseToken: string, result: InstanceRecord): Promise<void> {
  if (!result.run) return
  const directory = join(result.directories.artifacts, result.run.id)
  for (const name of COORDINATOR_ARTIFACTS) {
    const path = join(directory, name)
    try {
      const value = await lstat(path)
      if (!value.isFile() || value.isSymbolicLink()) continue
      await client.upload(job.id, workerId, leaseToken, name, await readFile(path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
}

function resultFor(instance: InstanceRecord): unknown {
  const run = instance.run
  const usage = run ? {
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    ...(run.cost === undefined ? {} : { cost: run.cost })
  } : undefined
  if (instance.state === 'passed') return { state: 'passed', ...(usage ? { run: usage } : {}) }
  return {
    state: 'failed',
    failure: {
      class: run?.failure ?? instance.failure?.class ?? 'infrastructure_failure',
      message: run?.message ?? instance.failure?.message ?? `suite ended in ${instance.state}`
    },
    ...(usage ? { run: usage } : {})
  }
}

async function executeClaim(options: WorkerOptions, claim: { job: PublicCoordinatorJob; leaseToken: string }): Promise<void> {
  const { job, leaseToken } = claim
  let stopped = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const beat = async (): Promise<void> => {
    if (stopped) return
    try { await options.client.heartbeat(job.id, options.id, leaseToken) } catch (error) {
      if (error instanceof CoordinatorError && error.status === 409) stopped = true
    }
  }
  try {
    await beat()
    heartbeat = setInterval(() => { void beat() }, options.heartbeatMs ?? 10_000)
    const revisionRoot = join(options.root, 'jobs', job.id)
    const revision = await (options.resolveRevision ?? resolveWorkerRevision)(options.repository, revisionRoot, job)
    const instance = await (options.execute ?? defaultExecute)(options.config, options.root, revision, job)
    if (stopped) return
    await uploadEvidence(options.client, job, options.id, leaseToken, instance)
    await options.client.finish(job.id, options.id, leaseToken, resultFor(instance))
  } catch (error) {
    if (error instanceof CoordinatorError && error.status === 409) return
    try {
      await options.client.finish(job.id, options.id, leaseToken, {
        state: 'failed',
        failure: { class: 'infrastructure_failure', message: error instanceof Error ? error.message : String(error) }
      })
    } catch (finishError) {
      if (!(finishError instanceof CoordinatorError && finishError.status === 409)) throw finishError
    }
  } finally {
    stopped = true
    if (heartbeat) clearInterval(heartbeat)
  }
}

export async function runWorker(options: WorkerOptions): Promise<void> {
  if (!safeId(options.id)) throw new Error('worker ID must be a safe identifier')
  if (!Number.isSafeInteger(options.jobs) || options.jobs < 1) throw new Error('worker jobs must be a positive safe integer')
  await privateDir(options.root)
  const active = new Set<Promise<void>>()
  const start = (claim: { job: PublicCoordinatorJob; leaseToken: string }): void => {
    const task = executeClaim(options, claim).finally(() => active.delete(task))
    active.add(task)
  }
  while (!options.signal?.aborted) {
    let empty = false
    while (active.size < options.jobs && !options.signal?.aborted) {
      const claim = await options.client.claim(options.id)
      if (!claim) { empty = true; break }
      start(claim)
    }
    if (active.size) {
      await Promise.race([...active, Bun.sleep(options.pollMs ?? 1_000)])
      continue
    }
    if (options.once && empty) break
    await Bun.sleep(options.pollMs ?? 1_000)
  }
  await Promise.all(active)
}
