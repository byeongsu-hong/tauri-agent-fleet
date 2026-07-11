import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { FleetConfig, FleetSnapshot, InstanceRecord, Suite } from './types.ts'
import { parseConfig, parseSuite } from './schema.ts'

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

export async function loadConfig(path = 'tauri-agent-fleet.json'): Promise<{ config: FleetConfig; path: string }> {
  const absolute = resolve(path)
  return { config: parseConfig(await readJson(absolute)), path: absolute }
}

export async function loadSuite(path: string): Promise<Suite> {
  return parseSuite(await readJson(resolve(path)))
}

export function stateRoot(config: FleetConfig, configPath?: string): string {
  if (config.stateDir) return resolve(configPath ? dirname(configPath) : process.cwd(), config.stateDir)
  const identity = createHash('sha256').update(resolve(configPath ?? process.cwd())).digest('hex').slice(0, 16)
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'tauri-agent-fleet', identity)
}

export async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

export async function withLock<T>(path: string, action: () => Promise<T>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  await privateDir(dirname(path))
  while (true) {
    try {
      const file = await open(path, 'wx', 0o600)
      await file.writeFile(JSON.stringify({ pid: process.pid, startTime: await processStartTime(process.pid) }))
      await file.close()
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const owner = JSON.parse(await readFile(path, 'utf8')) as { pid: number; startTime: string }
        if (await processStartTime(owner.pid) !== owner.startTime) { await rm(path, { force: true }); continue }
      } catch {
        try {
          if (Date.now() - (await stat(path)).mtimeMs > 5_000) { await rm(path, { force: true }); continue }
        } catch { continue }
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for lock: ${path}`)
      await Bun.sleep(25)
    }
  }
  try { return await action() } finally { await rm(path, { force: true }) }
}

async function processStartTime(pid: number): Promise<string | undefined> {
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8')
    return value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
  } catch { return undefined }
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await privateDir(dirname(path))
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await privateDir(dirname(path))
  const file = await open(path, 'a', 0o600)
  try { await file.write(`${JSON.stringify(value)}\n`) } finally { await file.close() }
}

export function instancePath(root: string, id: string): string {
  return join(root, 'instances', id, 'instance.json')
}

export async function saveInstance(root: string, instance: InstanceRecord): Promise<void> {
  instance.updatedAt = new Date().toISOString()
  await atomicJson(instancePath(root, instance.id), instance)
}

export async function listInstances(root: string): Promise<InstanceRecord[]> {
  let ids: string[]
  try { ids = await readdir(join(root, 'instances')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const instances = await Promise.all(ids.map(async (id) => {
    try { return await readJson(instancePath(root, id)) as InstanceRecord } catch { return undefined }
  }))
  return instances.filter((item): item is InstanceRecord => Boolean(item))
}

export async function snapshot(root: string): Promise<FleetSnapshot> {
  return { generatedAt: new Date().toISOString(), instances: await listInstances(root) }
}

export async function removeInstance(root: string, id: string): Promise<void> {
  await rm(join(root, 'instances', id), { recursive: true, force: true })
}
