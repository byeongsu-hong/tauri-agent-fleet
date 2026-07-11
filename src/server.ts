import { createConnection, type Socket } from 'node:net'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { listInstances, snapshot } from './storage.ts'
import { refreshInstance } from './instance.ts'

interface WebSocketData { host: string; port: number; socket?: Socket; closed: boolean }

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
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
    headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }
  })
}

export function startDashboard(options: { root: string; assets: string; host?: string; port?: number }) {
  const assets = resolve(options.assets)
  return Bun.serve<WebSocketData>({
    hostname: options.host ?? '127.0.0.1',
    port: options.port ?? 4173,
    async fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === '/api/state') {
        if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 })
        await Promise.all((await listInstances(options.root)).map((item) => refreshInstance(options.root, item)))
        return Response.json(await snapshot(options.root), { headers: { 'cache-control': 'no-store' } })
      }
      if (url.pathname === '/websockify') {
        if (request.method !== 'GET') return new Response('method not allowed', { status: 405 })
        const token = url.searchParams.get('token') ?? ''
        if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return new Response('unknown VNC token', { status: 404 })
        const instance = (await listInstances(options.root)).find((item) => item.vncToken === token)
        if (!instance) return new Response('unknown VNC token', { status: 404 })
        return server.upgrade(request, { data: { host: '127.0.0.1', port: instance.vncPort, closed: false } })
          ? undefined : new Response('WebSocket upgrade required', { status: 400 })
      }
      if (url.pathname.startsWith('/artifacts/')) {
        const parts = url.pathname.split('/').filter(Boolean)
        if (parts.length < 4) return new Response('not found', { status: 404 })
        const instance = (await listInstances(options.root)).find((item) => item.id === parts[1])
        if (!instance) return new Response('not found', { status: 404 })
        const artifactRoot = resolve(instance.directories.artifacts)
        return await fileResponse(request, artifactRoot, `/${parts.slice(2).join('/')}`)
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
