import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COORDINATOR_PROTOCOL } from '../src/coordinator.ts'
import { CoordinatorClient, startCoordinator } from '../src/coordinator-server.ts'

const token = 'coordinator-test-token-'.padEnd(40, 'x')
const job = {
  protocol: COORDINATOR_PROTOCOL,
  repository: 'a'.repeat(64), commit: 'b'.repeat(40), runtime: 'wry',
  suite: {
    protocol: 'agent-suite/v1', id: 'smoke', objective: 'Pass',
    pass: [{ expect: { role: 'button', name: 'Ready' } }], budget: { steps: 1, seconds: 10 }
  }
}

test('coordinator HTTP API authenticates and aggregates queue usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-coordinator-server-'))
  const assets = join(root, 'assets')
  await mkdir(assets)
  await writeFile(join(assets, 'index.html'), 'coordinator dashboard')
  const server = startCoordinator({ root: join(root, 'state'), token, port: 0, maxActive: 1, assets })
  try {
    const page = await fetch(server.url)
    expect(await page.text()).toBe('coordinator dashboard')
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect((await fetch(new URL('/api/v1/fleet', server.url))).status).toBe(401)
    const client = new CoordinatorClient(server.url.toString(), token)
    const queued = await client.enqueue(job)
    const claim = (await client.claim('worker-a'))!
    expect(claim.job.id).toBe(queued.id)
    expect(await client.claim('worker-b')).toBeUndefined()
    await client.heartbeat(queued.id, 'worker-a', claim.leaseToken)
    await client.upload(queued.id, 'worker-a', claim.leaseToken, 'run.json', new TextEncoder().encode('{"ok":true}'))
    expect(new TextDecoder().decode(await client.artifact(queued.id, 'run.json'))).toBe('{"ok":true}')
    await expect(client.upload(queued.id, 'worker-a', 'stale', 'actions.jsonl', new Uint8Array())).rejects.toMatchObject({ status: 409 })
    await expect(client.upload(queued.id, 'worker-a', claim.leaseToken, '../secret', new Uint8Array())).rejects.toMatchObject({ status: 404 })
    await client.finish(queued.id, 'worker-a', claim.leaseToken, { state: 'passed', run: { inputTokens: 12, outputTokens: 3, cost: 0.01 } })
    const state = await client.status() as { summary: Record<string, number>; jobs: Array<Record<string, unknown>> }
    expect(state.summary).toMatchObject({ total: 1, active: 0, passed: 1, inputTokens: 12, outputTokens: 3, cost: 0.01 })
    expect(state.jobs[0]?.artifacts).toEqual(['run.json'])
    expect(JSON.stringify(state)).not.toContain('leaseHash')
    expect(JSON.stringify(state)).not.toContain(claim.leaseToken)
  } finally {
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})
