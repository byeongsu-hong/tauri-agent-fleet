import { createServer, createConnection } from 'node:net'

export async function freePort(): Promise<number> {
  const server = createServer()
  return await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('failed to allocate port'))
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

export async function portOpen(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (value: boolean) => { socket.destroy(); resolve(value) }
    socket.setTimeout(250)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for ${label}`)
}
