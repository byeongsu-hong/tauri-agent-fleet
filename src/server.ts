import { createConnection, type Socket } from 'node:net'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { realpath, readdir, stat } from 'node:fs/promises'
import { listInstances } from './storage.ts'
import { refreshInstance } from './instance.ts'
import { processOwned } from './process.ts'
import { CLEAN_FINGERPRINT } from './revision.ts'
import type { FleetConfig, InstanceRecord } from './types.ts'

interface WebSocketData { host: string; port: number; socket?: Socket; closed: boolean }

const LIVE = new Set(['booting', 'ready', 'running'])
const VNC_TOKEN = /^[A-Za-z0-9_-]{32}$/
const CONSOLE_TEXT_LIMIT = 8 * 1024

const validPort = (port: number): boolean => Number.isInteger(port) && port > 0 && port <= 65_535

function consoleText(value: string): string {
  return value.length <= CONSOLE_TEXT_LIMIT ? value : `${value.slice(0, CONSOLE_TEXT_LIMIT - 1)}…`
}

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm'
}

function inside(root: string, file: string): boolean {
  const path = relative(root, file)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

async function fileResponse(request: Request, root: string, pathname: string): Promise<Response> {
  let decoded: string
  try { decoded = decodeURIComponent(pathname) } catch { return new Response('bad path', { status: 400 }) }
  const file = resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`)
  if (!inside(root, file)) return new Response('forbidden', { status: 403 })
  try {
    if (!(await stat(file)).isFile()) throw new Error()
    if (!inside(await realpath(root), await realpath(file))) return new Response('forbidden', { status: 403 })
  } catch { return new Response('not found', { status: 404 }) }
  return new Response(request.method === 'HEAD' ? null : Bun.file(file), {
    headers: {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...(extname(file) === '.html' ? { 'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" } : {})
    }
  })
}

async function safeArtifactRoot(stateRoot: string, id: string): Promise<string | undefined> {
  const instanceRoot = resolve(stateRoot, 'instances', id)
  const artifacts = resolve(instanceRoot, 'artifacts')
  try { return inside(await realpath(instanceRoot), await realpath(artifacts)) ? artifacts : undefined } catch { return undefined }
}

async function artifactRoutes(stateRoot: string, instance: InstanceRecord): Promise<Record<string, string> | undefined> {
  if (!instance.run) return undefined
  const root = `/api/v1/instances/${encodeURIComponent(instance.id)}/runs/${encodeURIComponent(instance.run.id)}/artifacts`
  const artifacts = await safeArtifactRoot(stateRoot, instance.id)
  let files: string[]
  try { files = artifacts ? await readdir(join(artifacts, instance.run.id)) : [] } catch { files = [] }
  const routes: Record<string, string> = {}
  for (const [name, file] of Object.entries({
    run: 'run.json', actions: 'actions.jsonl', usage: 'model-usage.jsonl', semantic: 'semantic.jsonl', replay: 'replay.json',
    console: 'console.jsonl', network: 'network.jsonl', ipc: 'ipc.jsonl', screenshot: 'failure.png'
  })) if (files.includes(file)) routes[name] = `${root}/${file}`
  return routes
}

async function fleetView(stateRoot: string, instances: InstanceRecord[], generatedAt = new Date().toISOString()) {
  const now = Date.parse(generatedAt)
  const tokens = instances.reduce((total, item) => total + (item.run?.inputTokens ?? 0) + (item.run?.outputTokens ?? 0), 0)
  const cost = instances.reduce((total, item) => total + (item.run?.cost ?? 0), 0)
  return {
    protocol: 'tauri-agent-console/v1' as const,
    generatedAt,
    summary: {
      total: instances.length,
      live: instances.filter((item) => LIVE.has(item.state)).length,
      running: instances.filter((item) => item.state === 'running').length,
      passed: instances.filter((item) => item.state === 'passed').length,
      failed: instances.filter((item) => item.state === 'failed').length,
      tokens,
      cost
    },
    instances: await Promise.all([...instances].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(async (instance) => {
      const run = instance.run
      const finished = run?.finishedAt ? Date.parse(run.finishedAt) : now
      const websocket = LIVE.has(instance.state) && validPort(instance.vncPort) && VNC_TOKEN.test(instance.vncToken) && instance.processes.some((process) => process.name === 'vnc')
        ? `/api/v1/vnc/${encodeURIComponent(instance.vncToken)}` : undefined
      return {
        id: instance.id,
        state: instance.state,
        runtime: instance.variant,
        revision: {
          ...(instance.revision.branch ? { branch: instance.revision.branch } : {}),
          commit: instance.revision.commit,
          dirty: instance.revision.dirtyFingerprint !== CLEAN_FINGERPRINT
        },
        display: instance.display,
        agent: { healthy: instance.endpoint?.healthy === true },
        vnc: { available: websocket !== undefined, ...(websocket ? { websocket } : {}) },
        ...(instance.failure ? { failure: { class: instance.failure.class, message: consoleText(instance.failure.message) } } : {}),
        ...(run ? {
          run: {
            id: run.id,
            suite: run.suite,
            objective: run.objective,
            progress: {
              step: run.step,
              stepLimit: run.budget.steps,
              timeLimitMs: run.budget.seconds * 1000,
              elapsedMs: Math.max(0, finished - Date.parse(run.startedAt)),
              inputTokens: run.inputTokens,
              outputTokens: run.outputTokens,
              ...(run.budget.tokens === undefined ? {} : { tokenLimit: run.budget.tokens })
            },
            ...(run.cost === undefined ? {} : { cost: run.cost }),
            ...(run.failure ? { failure: { class: run.failure, message: consoleText(run.message ?? '') } } : {}),
            artifacts: (await artifactRoutes(stateRoot, instance))!
          }
        } : {})
      }
    }))
  }
}

export function startDashboard(options: { root: string; assets: string; config: FleetConfig; host?: string; port?: number }) {
  const assets = resolve(options.assets)
  return Bun.serve<WebSocketData>({
    hostname: options.host ?? '127.0.0.1',
    port: options.port ?? 4173,
    async fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === '/api/v1/fleet') {
        if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 })
        const instances = await Promise.all((await listInstances(options.root)).map((item) => refreshInstance(options.config, options.root, item, false)))
        const view = await fleetView(options.root, instances)
        return new Response(request.method === 'HEAD' ? null : JSON.stringify(view), {
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
        })
      }
      if (url.pathname.startsWith('/api/v1/vnc/')) {
        if (request.method !== 'GET') return new Response('method not allowed', { status: 405 })
        const token = url.pathname.slice('/api/v1/vnc/'.length)
        if (!VNC_TOKEN.test(token)) return new Response('unknown VNC token', { status: 404 })
        const instance = (await listInstances(options.root)).find((item) => item.vncToken === token)
        const vnc = instance?.processes.find((process) => process.name === 'vnc')
        if (!instance || !LIVE.has(instance.state) || !validPort(instance.vncPort) || !vnc || !await processOwned(vnc)) {
          return new Response('unknown VNC token', { status: 404 })
        }
        return server.upgrade(request, { data: { host: '127.0.0.1', port: instance.vncPort, closed: false } })
          ? undefined : new Response('WebSocket upgrade required', { status: 400 })
      }
      if (url.pathname.startsWith('/api/v1/instances/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 })
        const parts = url.pathname.split('/').filter(Boolean)
        if (parts.length < 8 || parts[0] !== 'api' || parts[1] !== 'v1' || parts[2] !== 'instances' || parts[4] !== 'runs' || parts[6] !== 'artifacts') {
          return new Response('not found', { status: 404 })
        }
        const instance = (await listInstances(options.root)).find((item) => item.id === parts[3])
        if (!instance || instance.run?.id !== parts[5]) return new Response('not found', { status: 404 })
        const artifactRoot = await safeArtifactRoot(options.root, instance.id)
        if (!artifactRoot) return new Response('forbidden', { status: 403 })
        return await fileResponse(request, artifactRoot, `/${[parts[5], ...parts.slice(7)].join('/')}`)
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 })
      return await fileResponse(request, assets, url.pathname)
    },
    websocket: {
      idleTimeout: 0,
      perMessageDeflate: false,
      backpressureLimit: 16 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(ws) {
        const tcp = createConnection({ host: ws.data.host, port: ws.data.port })
        ws.data.socket = tcp
        tcp.on('data', (data) => {
          const sent = ws.send(data)
          if (sent === -1) tcp.pause()
          else if (sent === 0) tcp.destroy()
        })
        tcp.on('close', () => { if (!ws.data.closed) ws.close() })
        tcp.on('error', () => { if (!ws.data.closed) ws.close(1011, 'VNC connection failed') })
      },
      message(ws, message) { ws.data.socket?.write(typeof message === 'string' ? Buffer.from(message) : message) },
      drain(ws) { ws.data.socket?.resume() },
      close(ws) { ws.data.closed = true; ws.data.socket?.destroy() }
    }
  })
}
