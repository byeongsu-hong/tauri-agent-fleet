import { expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COORDINATOR_PROTOCOL, CoordinatorError, CoordinatorStore } from '../src/coordinator.ts'

const suite = {
  protocol: 'tauri-agent-suite/v1', id: 'smoke', runtime: 'wry', objective: 'Pass',
  pass: [{ expect: { role: 'button', name: 'Ready', present: true } }], budget: { steps: 1, seconds: 10 }
} as const

const input = { protocol: COORDINATOR_PROTOCOL, repository: 'a'.repeat(64), commit: 'b'.repeat(40), runtime: 'wry', suite }

async function temporary(): Promise<string> { return await mkdtemp(join(tmpdir(), 'fleet-coordinator-')) }

test('coordinator claims atomically and enforces global capacity', async () => {
  const root = await temporary()
  try {
    const store = new CoordinatorStore(root, { maxActive: 2, leaseMs: 1_000 })
    await Promise.all([store.enqueue(input, 0), store.enqueue(input, 1), store.enqueue(input, 2)])
    const claims = await Promise.all([store.claim('worker-a', 10), store.claim('worker-b', 10)])
    expect(claims.every(Boolean)).toBe(true)
    expect(new Set(claims.map((claim) => claim!.job.id)).size).toBe(2)
    expect(await store.claim('worker-c', 10)).toBeUndefined()
    expect((await store.list(10)).map((job) => job.state).sort()).toEqual(['leased', 'leased', 'queued'])
    expect((await stat(root)).mode & 0o777).toBe(0o700)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('coordinator requeues expired leases and rejects stale completion', async () => {
  const root = await temporary()
  try {
    const store = new CoordinatorStore(root, { maxActive: 1, leaseMs: 10, maxAttempts: 3 })
    const queued = await store.enqueue(input, 0)
    const first = (await store.claim('worker-a', 1))!
    expect((await store.list(12))[0]).toMatchObject({ id: queued.id, state: 'queued', attempt: 1 })
    await expect(store.heartbeat(queued.id, 'worker-a', first.leaseToken, 12)).rejects.toMatchObject({ status: 409 })

    const second = (await store.claim('worker-b', 12))!
    const running = await store.heartbeat(queued.id, 'worker-b', second.leaseToken, 13)
    expect(running).toMatchObject({ state: 'running', workerId: 'worker-b' })
    await expect(store.finish(queued.id, 'worker-a', first.leaseToken, { state: 'passed' }, 14)).rejects.toBeInstanceOf(CoordinatorError)
    const passed = await store.finish(queued.id, 'worker-b', second.leaseToken, { state: 'passed', run: { inputTokens: 10, outputTokens: 2 } }, 14)
    expect(passed).toMatchObject({ state: 'passed', run: { inputTokens: 10, outputTokens: 2 } })
    expect('leaseHash' in passed).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('coordinator fails a job after its third expired attempt', async () => {
  const root = await temporary()
  try {
    const store = new CoordinatorStore(root, { maxActive: 1, leaseMs: 1, maxAttempts: 3 })
    await store.enqueue(input, 0)
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await store.claim(`worker-${attempt}`, attempt * 2 + 1)).toBeDefined()
      await store.list(attempt * 2 + 2)
    }
    expect((await store.list(10))[0]).toMatchObject({
      state: 'failed', attempt: 3, failure: { class: 'infrastructure_failure', message: 'worker lease expired after 3 attempts' }
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('coordinator validates immutable job inputs', async () => {
  const root = await temporary()
  try {
    const store = new CoordinatorStore(root, { maxActive: 1 })
    await expect(store.enqueue({ ...input, runtime: 'cef' })).rejects.toMatchObject({ status: 400 })
    await expect(store.enqueue({ ...input, repository: '../other' })).rejects.toMatchObject({ status: 400 })
    await expect(store.claim('unsafe worker')).rejects.toMatchObject({ status: 400 })
  } finally { await rm(root, { recursive: true, force: true }) }
})
