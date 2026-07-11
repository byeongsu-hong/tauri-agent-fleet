import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { FleetConfig, InstanceRecord, Suite } from './types.ts'
import { parseConfig, parseSuite } from './schema.ts'

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    throw new Error(`could not read JSON ${path}: ${error instanceof Error ? error.message : error}`, { cause: error })
  }
}

const DEFAULT_CONFIG = join('.tauri-agent', 'fleet.json')

function workspaceFor(path: string): string {
  const directory = dirname(path)
  return basename(directory) === '.tauri-agent' ? dirname(directory) : directory
}

async function discoverConfig(start = process.cwd()): Promise<string> {
  let directory = resolve(start)
  while (true) {
    const candidate = join(directory, DEFAULT_CONFIG)
    try {
      if (!(await stat(candidate)).isFile()) throw new Error(`config is not a file: ${candidate}`)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`could not find ${DEFAULT_CONFIG}`)
    directory = parent
  }
}

export async function loadConfig(path?: string): Promise<{ config: FleetConfig; path: string; workspace: string }> {
  const absolute = path ? resolve(path) : await discoverConfig()
  return { config: parseConfig(await readJson(absolute)), path: absolute, workspace: workspaceFor(absolute) }
}

export async function loadSuite(workspace: string, id: string): Promise<Suite> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error(`invalid suite ID: ${id}`)
  const suite = parseSuite(await readJson(join(workspace, '.tauri-agent', 'suites', `${id}.json`)))
  if (suite.id !== id) throw new Error(`suite file ${id}.json declares ID ${suite.id}`)
  return suite
}

export function stateRoot(configPath: string): string {
  const identity = createHash('sha256').update(resolve(configPath)).digest('hex').slice(0, 16)
  const configured = process.env.XDG_STATE_HOME
  const base = configured && isAbsolute(configured) ? configured : join(homedir(), '.local', 'state')
  return join(base, 'tauri-agent-fleet', identity)
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
      try { await file.writeFile(JSON.stringify({ pid: process.pid, startTime: await processStartTime(process.pid) })) }
      finally { await file.close() }
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
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await privateDir(dirname(path))
  const file = await open(path, 'a', 0o600)
  try { await file.write(`${JSON.stringify(value)}\n`) } finally { await file.close() }
}

function instancePath(root: string, id: string): string {
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
    try {
      const instance = await readJson(instancePath(root, id)) as InstanceRecord
      if (instance.schemaVersion !== 1) throw new Error('unsupported instance schema')
      if (instance.id !== id) throw new Error('instance ID does not match its directory')
      if (instance.endpoint && 'descriptor' in instance.endpoint) {
        delete (instance.endpoint as Record<string, unknown>).descriptor
        await atomicJson(instancePath(root, instance.id), instance)
      }
      return instance
    } catch { return undefined }
  }))
  return instances.filter((item): item is InstanceRecord => Boolean(item))
}
