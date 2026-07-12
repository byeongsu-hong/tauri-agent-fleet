#!/usr/bin/env bun

export {}

const args = Bun.argv.slice(2)
const index = args.indexOf('-rfbport')
const port = Number(args[index + 1])
if (index < 0 || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('vnc-stub requires -rfbport PORT')

const server = Bun.listen({
  hostname: '127.0.0.1',
  port,
  socket: { data(socket, value) { socket.write(value) } }
})

const stop = () => { server.stop(true); process.exit(0) }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
