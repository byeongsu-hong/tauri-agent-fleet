import { timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'
import { CoordinatorError, CoordinatorStore, MAX_ARTIFACT_BYTES, type PublicCoordinatorJob } from './coordinator.ts'
import { fileResponse } from './server.ts'

const MAX_JSON_BYTES = 1024 * 1024

export interface CoordinatorServerOptions {
  root: string
  token: string
  host?: string
  port?: number
  maxActive: number
  leaseMs?: number
  maxAttempts?: number
  assets?: string
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

function sameToken(expected: string, actual: string): boolean {
  const left = Buffer.from(expected)
  const right = Buffer.from(actual)
  return left.length === right.length && timingSafeEqual(left, right)
}

function authorized(request: Request, token: string): boolean {
  const header = request.headers.get('authorization') ?? ''
  return header.startsWith('Bearer ') && sameToken(token, header.slice(7))
}

async function body(request: Request): Promise<unknown> {
  const length = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(length) && length > MAX_JSON_BYTES) throw new CoordinatorError(413, 'request body is too large')
  const text = await request.text()
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new CoordinatorError(413, 'request body is too large')
  try { return JSON.parse(text) } catch { throw new CoordinatorError(400, 'request body must be JSON') }
}

async function artifactBody(request: Request): Promise<Uint8Array> {
  const length = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(length) && length > MAX_ARTIFACT_BYTES) throw new CoordinatorError(413, 'artifact is too large')
  const value = new Uint8Array(await request.arrayBuffer())
  if (value.byteLength > MAX_ARTIFACT_BYTES) throw new CoordinatorError(413, 'artifact is too large')
  return value
}

function leaseBody(value: unknown): { workerId: string; leaseToken: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoordinatorError(400, 'lease body must be an object')
  const raw = value as Record<string, unknown>
  if (typeof raw.workerId !== 'string' || typeof raw.leaseToken !== 'string') throw new CoordinatorError(400, 'workerId and leaseToken are required')
  return { workerId: raw.workerId, leaseToken: raw.leaseToken }
}

function projection(jobs: PublicCoordinatorJob[]): unknown {
  const active = jobs.filter((job) => job.state === 'leased' || job.state === 'running').length
  return {
    protocol: 'tauri-agent-coordinator/v1',
    generatedAt: new Date().toISOString(),
    summary: {
      total: jobs.length,
      queued: jobs.filter((job) => job.state === 'queued').length,
      active,
      passed: jobs.filter((job) => job.state === 'passed').length,
      failed: jobs.filter((job) => job.state === 'failed').length,
      inputTokens: jobs.reduce((sum, job) => sum + (job.run?.inputTokens ?? 0), 0),
      outputTokens: jobs.reduce((sum, job) => sum + (job.run?.outputTokens ?? 0), 0),
      cost: jobs.reduce((sum, job) => sum + (job.run?.cost ?? 0), 0)
    },
    jobs
  }
}

export function startCoordinator(options: CoordinatorServerOptions): ReturnType<typeof Bun.serve> {
  if (options.token.length < 32) throw new Error('FLEET_COORDINATOR_TOKEN must contain at least 32 characters')
  const store = new CoordinatorStore(options.root, options)
  const assets = options.assets ? resolve(options.assets) : undefined
  return Bun.serve({
    hostname: options.host ?? '127.0.0.1',
    port: options.port ?? 4180,
    async fetch(request) {
      try {
        const url = new URL(request.url)
        if (!url.pathname.startsWith('/api/v1/')) {
          if (!assets || (request.method !== 'GET' && request.method !== 'HEAD')) return new Response('not found', { status: 404 })
          return await fileResponse(request, assets, url.pathname)
        }
        if (!authorized(request, options.token)) return new Response('unauthorized', { status: 401 })
        if (request.method === 'POST' && url.pathname === '/api/v1/jobs') return json(await store.enqueue(await body(request)), 201)
        if (request.method === 'POST' && url.pathname === '/api/v1/claim') {
          const value = await body(request) as { workerId?: unknown }
          if (!value || typeof value.workerId !== 'string') throw new CoordinatorError(400, 'workerId is required')
          const claim = await store.claim(value.workerId)
          return claim ? json(claim) : new Response(null, { status: 204 })
        }
        const job = url.pathname.match(/^\/api\/v1\/jobs\/([A-Za-z0-9._-]+)\/(heartbeat|finish)$/)
        if (request.method === 'POST' && job) {
          const value = await body(request)
          const lease = leaseBody(value)
          if (job[2] === 'heartbeat') return json(await store.heartbeat(job[1]!, lease.workerId, lease.leaseToken))
          const raw = value as Record<string, unknown>
          return json(await store.finish(job[1]!, lease.workerId, lease.leaseToken, raw.result))
        }
        const artifact = url.pathname.match(/^\/api\/v1\/jobs\/([A-Za-z0-9._-]+)\/artifacts\/([A-Za-z0-9._-]+)$/)
        if (artifact && request.method === 'PUT') {
          const workerId = request.headers.get('x-fleet-worker') ?? ''
          const leaseToken = request.headers.get('x-fleet-lease') ?? ''
          return json(await store.putArtifact(artifact[1]!, workerId, leaseToken, artifact[2]!, await artifactBody(request)), 201)
        }
        if (artifact && request.method === 'GET') {
          const value = await store.getArtifact(artifact[1]!, artifact[2]!)
          return new Response(new Blob([value.buffer as ArrayBuffer]), { headers: { 'cache-control': 'no-store', 'content-type': artifact[2] === 'failure.png' ? 'image/png' : 'application/octet-stream' } })
        }
        if (request.method === 'GET' && url.pathname === '/api/v1/fleet') return json(projection(await store.list()))
        return new Response('not found', { status: 404 })
      } catch (error) {
        if (error instanceof CoordinatorError) return json({ error: error.message }, error.status)
        console.error(error)
        return json({ error: 'internal coordinator error' }, 500)
      }
    }
  })
}

function coordinatorUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('--coordinator must be an HTTP URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('--coordinator must be an HTTP URL')
  if (url.username || url.password) throw new Error('--coordinator URL cannot contain credentials')
  return url
}

export class CoordinatorClient {
  readonly url: URL

  constructor(url: string, readonly token: string) {
    this.url = coordinatorUrl(url)
    if (token.length < 32) throw new Error('FLEET_COORDINATOR_TOKEN must contain at least 32 characters')
  }

  async enqueue(value: unknown): Promise<PublicCoordinatorJob> { return await this.request('/api/v1/jobs', value) as PublicCoordinatorJob }
  async claim(workerId: string): Promise<{ job: PublicCoordinatorJob; leaseToken: string } | undefined> {
    return await this.request('/api/v1/claim', { workerId }, true) as { job: PublicCoordinatorJob; leaseToken: string } | undefined
  }
  async heartbeat(id: string, workerId: string, leaseToken: string): Promise<PublicCoordinatorJob> {
    return await this.request(`/api/v1/jobs/${encodeURIComponent(id)}/heartbeat`, { workerId, leaseToken }) as PublicCoordinatorJob
  }
  async finish(id: string, workerId: string, leaseToken: string, result: unknown): Promise<PublicCoordinatorJob> {
    return await this.request(`/api/v1/jobs/${encodeURIComponent(id)}/finish`, { workerId, leaseToken, result }) as PublicCoordinatorJob
  }
  async upload(id: string, workerId: string, leaseToken: string, name: string, value: Uint8Array): Promise<PublicCoordinatorJob> {
    const response = await fetch(new URL(`/api/v1/jobs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(name)}`, this.url), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/octet-stream',
        'x-fleet-worker': workerId,
        'x-fleet-lease': leaseToken
      },
      body: new Blob([value.buffer as ArrayBuffer]),
      signal: AbortSignal.timeout(30_000)
    })
    return await this.response(response) as PublicCoordinatorJob
  }
  async artifact(id: string, name: string): Promise<Uint8Array> {
    const response = await fetch(new URL(`/api/v1/jobs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(name)}`, this.url), {
      headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) await this.response(response)
    return new Uint8Array(await response.arrayBuffer())
  }
  async status(): Promise<unknown> { return await this.request('/api/v1/fleet') }

  private async request(path: string, value?: unknown, empty = false): Promise<unknown> {
    const response = await fetch(new URL(path, this.url), {
      method: value === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${this.token}`, ...(value === undefined ? {} : { 'content-type': 'application/json' }) },
      signal: AbortSignal.timeout(30_000),
      ...(value === undefined ? {} : { body: JSON.stringify(value) })
    })
    if (empty && response.status === 204) return undefined
    return await this.response(response)
  }

  private async response(response: Response): Promise<unknown> {
    const text = await response.text()
    if (!response.ok) {
      let message = text || `coordinator returned ${response.status}`
      try { message = String((JSON.parse(text) as { error?: unknown }).error ?? message) } catch { /* keep response text */ }
      throw new CoordinatorError(response.status, message)
    }
    return text ? JSON.parse(text) : undefined
  }
}
