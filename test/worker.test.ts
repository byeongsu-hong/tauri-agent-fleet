import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PublicCoordinatorJob } from '../src/coordinator.ts'
import type { WorkerClient } from '../src/worker.ts'
import { runWorker } from '../src/worker.ts'

const config = {
  protocol: 'tauri-agent-fleet/v1' as const,
  application: { id: 'test', root: '.' },
  runtimes: { default: 'wry' as const, wry: { build: ['true'] } }
}

test('worker drains several claims with bounded local parallelism and reports results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-worker-'))
  const queue = Array.from({ length: 4 }, (_, index) => ({
    job: {
      protocol: 'tauri-agent-coordinator/v1', id: `job-${index}`, repository: 'a'.repeat(64), commit: 'b'.repeat(40),
      suite: { protocol: 'tauri-agent-suite/v1', id: `suite-${index}`, objective: 'pass', pass: [], budget: { steps: 1, seconds: 1 } },
      runtime: 'wry', state: 'leased', attempt: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    } satisfies PublicCoordinatorJob,
    leaseToken: `lease-${index}`
  }))
  let running = 0
  let highWater = 0
  const finished: string[] = []
  const client: WorkerClient = {
    claim: async () => queue.shift(),
    heartbeat: async () => ({} as PublicCoordinatorJob),
    upload: async () => ({} as PublicCoordinatorJob),
    finish: async (id) => { finished.push(id); return {} as PublicCoordinatorJob }
  }
  try {
    await runWorker({
      client, config, repository: root, root, id: 'worker-a', jobs: 3, once: true, pollMs: 1,
      resolveRevision: async () => ({ repository: 'a'.repeat(64), worktree: root, commit: 'b'.repeat(40), dirtyFingerprint: '' }),
      execute: async (_config, workerRoot, _revision, job) => {
        running++; highWater = Math.max(highWater, running)
        await Bun.sleep(10)
        running--
        return {
          schemaVersion: 1, id: job.id, revision: {} as never, variant: 'wry', artifactKey: 'key', state: 'passed',
          createdAt: '', updatedAt: '', slot: 1, display: ':1', vncPort: 1, appPort: 2, vncToken: 'token',
          directories: { root: workerRoot, home: workerRoot, runtime: workerRoot, data: workerRoot, artifacts: workerRoot },
          processes: [], run: { id: 'run', suite: job.suite.id, objective: '', step: 1, startedAt: '', budget: job.suite.budget, inputTokens: 2, outputTokens: 1 }
        }
      }
    })
    expect(highWater).toBe(3)
    expect(finished.sort()).toEqual(['job-0', 'job-1', 'job-2', 'job-3'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
