import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COORDINATOR_ARTIFACTS, COORDINATOR_PROTOCOL, CoordinatorError } from '../src/coordinator.ts'
import { CoordinatorClient, startCoordinator } from '../src/coordinator-server.ts'
import { CLEAN_FINGERPRINT, requireCleanRevision } from '../src/revision.ts'
import { runWorker } from '../src/worker.ts'
import type { FleetConfig, InstanceRecord, Revision, RuntimeVariant } from '../src/types.ts'

const token = 'horizontal-acceptance-token-'.padEnd(40, 'x')
const config: FleetConfig = {
  protocol: 'tauri-agent-fleet/v1', application: { id: 'acceptance', root: '.' },
  runtimes: { default: 'wry', wry: { build: ['true'] }, cef: { build: ['true'] } }
}

function input(index: number, runtime: RuntimeVariant) {
  return {
    protocol: COORDINATOR_PROTOCOL, repository: 'a'.repeat(64), commit: 'b'.repeat(40), runtime,
    suite: {
      protocol: 'tauri-agent-suite/v1', id: `smoke-${index}`, objective: `Pass smoke ${index}`,
      pass: [{ expect: { role: 'button', name: 'Ready' } }], budget: { steps: 2, seconds: 10, tokens: 100 }
    }
  }
}

test('two horizontal workers drain six runtime jobs with evidence and exact aggregate usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-horizontal-acceptance-'))
  const server = startCoordinator({ root: join(root, 'coordinator'), token, port: 0, maxActive: 6 })
  const client = new CoordinatorClient(server.url.toString(), token)
  const assigned = { a: new Set<string>(), b: new Set<string>() }
  const execute = (worker: keyof typeof assigned) => async (_config: FleetConfig, workerRoot: string, revision: Revision, job: Awaited<ReturnType<typeof client.enqueue>>): Promise<InstanceRecord> => {
    assigned[worker].add(job.id)
    await Bun.sleep(15)
    const runId = `run-${job.id}`
    const artifacts = join(workerRoot, 'evidence', job.id)
    const directory = join(artifacts, runId)
    await mkdir(directory, { recursive: true })
    for (const name of COORDINATOR_ARTIFACTS) {
      await writeFile(join(directory, name), name === 'failure.png' ? Uint8Array.of(137, 80, 78, 71) : `${name}\n`)
    }
    const index = Number(job.suite.id.slice('smoke-'.length))
    const failed = index === 6
    return {
      schemaVersion: 1, id: `${worker}-${job.id}`, revision, variant: job.runtime, artifactKey: 'key', state: failed ? 'failed' : 'passed',
      createdAt: '', updatedAt: '', slot: index, display: `:${index}`, vncPort: 5900 + index, appPort: 3000 + index, vncToken: 'v'.repeat(32),
      directories: { root: workerRoot, home: workerRoot, runtime: workerRoot, data: workerRoot, artifacts }, processes: [],
      run: {
        id: runId, suite: job.suite.id, objective: job.suite.objective, step: 1, startedAt: '', budget: job.suite.budget,
        inputTokens: index, outputTokens: 2, cost: 0.001,
        ...(failed ? { failure: 'app_failure' as const, message: 'deterministic failure' } : {})
      }
    }
  }
  const revision = async (): Promise<Revision> => ({ repository: 'a'.repeat(64), worktree: root, commit: 'b'.repeat(40), dirtyFingerprint: CLEAN_FINGERPRINT })
  try {
    for (let index = 1; index <= 6; index++) await client.enqueue(input(index, index <= 3 ? 'wry' : 'cef'))
    await Promise.all([
      runWorker({ client, config, repository: root, root: join(root, 'worker-a'), id: 'worker-a', jobs: 3, once: true, pollMs: 1, resolveRevision: revision, execute: execute('a') }),
      runWorker({ client, config, repository: root, root: join(root, 'worker-b'), id: 'worker-b', jobs: 3, once: true, pollMs: 1, resolveRevision: revision, execute: execute('b') })
    ])
    const fleet = await client.status() as { summary: Record<string, number>; jobs: Array<{ id: string; state: string; workerId?: string; runtime: string; artifacts?: string[] }> }
    expect(assigned.a.size).toBeGreaterThan(0)
    expect(assigned.b.size).toBeGreaterThan(0)
    expect(new Set([...assigned.a, ...assigned.b]).size).toBe(6)
    expect(fleet.summary).toMatchObject({ total: 6, active: 0, passed: 5, failed: 1, inputTokens: 21, outputTokens: 12, cost: 0.006 })
    expect(fleet.jobs.filter((job) => job.runtime === 'wry')).toHaveLength(3)
    expect(fleet.jobs.filter((job) => job.runtime === 'cef')).toHaveLength(3)
    expect(fleet.jobs.every((job) => job.workerId && job.artifacts?.length === COORDINATOR_ARTIFACTS.size)).toBe(true)
    const run = await client.artifact(fleet.jobs[0]!.id, 'run.json')
    expect(new TextDecoder().decode(run)).toBe('run.json\n')
  } finally {
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

test('expired leases cannot heartbeat, upload, or finish after reassignment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-horizontal-expiry-'))
  const server = startCoordinator({ root, token, port: 0, maxActive: 1, leaseMs: 5 })
  const client = new CoordinatorClient(server.url.toString(), token)
  try {
    const job = await client.enqueue(input(1, 'wry'))
    const stale = (await client.claim('worker-old'))!
    await client.upload(job.id, 'worker-old', stale.leaseToken, 'run.json', new TextEncoder().encode('stale'))
    await Bun.sleep(10)
    await client.status()
    const current = (await client.claim('worker-new'))!
    expect(current.job.id).toBe(job.id)
    await expect(client.artifact(job.id, 'run.json')).rejects.toMatchObject({ status: 404 })
    await expect(client.heartbeat(job.id, 'worker-old', stale.leaseToken)).rejects.toBeInstanceOf(CoordinatorError)
    await expect(client.upload(job.id, 'worker-old', stale.leaseToken, 'run.json', new Uint8Array())).rejects.toMatchObject({ status: 409 })
    await expect(client.finish(job.id, 'worker-old', stale.leaseToken, { state: 'passed' })).rejects.toMatchObject({ status: 409 })
    await client.finish(job.id, 'worker-new', current.leaseToken, { state: 'passed' })
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }) }
})

test('horizontal clean-revision and authenticated artifact gates reject unsafe input', async () => {
  expect(requireCleanRevision({ repository: '', worktree: '', commit: '', dirtyFingerprint: CLEAN_FINGERPRINT }).dirtyFingerprint).toBe(CLEAN_FINGERPRINT)
  expect(() => requireCleanRevision({ repository: '', worktree: '', commit: '', dirtyFingerprint: 'dirty' })).toThrow('clean revision')
  const root = await mkdtemp(join(tmpdir(), 'fleet-horizontal-auth-'))
  const server = startCoordinator({ root, token, port: 0, maxActive: 1 })
  try {
    expect((await fetch(new URL('/api/v1/fleet', server.url), { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await fetch(new URL('/api/v1/jobs/none/artifacts/run.json', server.url))).status).toBe(401)
    const client = new CoordinatorClient(server.url.toString(), token)
    await expect(client.enqueue({ ...input(1, 'wry'), suite: { ...input(1, 'wry').suite, id: '../unsafe' } })).rejects.toMatchObject({ status: 400 })
    await expect(client.enqueue({ ...input(1, 'cef'), suite: { ...input(1, 'cef').suite, runtime: 'wry' } })).rejects.toMatchObject({ status: 400 })
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }) }
})
