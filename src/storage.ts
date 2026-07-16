import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { FleetConfig, InstanceRecord, Suite } from './types.ts'
import { parseConfig, parseSuite } from './schema.ts'
import { decodeInstruction } from './instruction.ts'

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    throw new Error(`could not read JSON ${path}: ${error instanceof Error ? error.message : error}`, { cause: error })
  }
}

const DEFAULT_CONFIG = join('.agent', 'fleet.json')

function workspaceFor(path: string): string {
  const directory = dirname(path)
  return basename(directory) === '.agent' ? dirname(directory) : directory
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
  const directory = join(workspace, '.agent', 'suites')
  let value: unknown
  let extension = 'json'
  try { value = await readJson(join(directory, `${id}.json`)) } catch (error) {
    if ((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code !== 'ENOENT') throw error
    extension = 'toon'
    try { value = decodeInstruction(await readFile(join(directory, `${id}.toon`), 'utf8')) } catch (cause) {
      throw new Error(`could not read TOON suite ${id}.toon: ${cause instanceof Error ? cause.message : cause}`, { cause })
    }
  }
  const suite = parseSuite(value)
  if (suite.id !== id) throw new Error(`suite file ${id}.${extension} declares ID ${suite.id}`)
  return suite
}

export function stateRoot(configPath: string): string {
  const identity = createHash('sha256').update(resolve(configPath)).digest('hex').slice(0, 16)
  const configured = process.env.XDG_STATE_HOME
  const base = configured && isAbsolute(configured) ? configured : join(homedir(), '.local', 'state')
  return join(base, 'agent-fleet', identity)
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

export async function withRenewableLock<T>(
  path: string,
  action: (assertOwned: () => Promise<void>) => Promise<T>,
  timeoutMs = 10 * 60_000,
  leaseMs = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  const token = crypto.randomUUID()
  const ownerPath = join(path, 'owner.json')
  await privateDir(dirname(path))
  while (true) {
    const candidate = `${path}.candidate.${crypto.randomUUID()}`
    try {
      await mkdir(candidate, { mode: 0o700 })
      await atomicJson(join(candidate, 'owner.json'), { token, expiresAt: Date.now() + leaseMs })
      await rename(candidate, path)
      break
    } catch (error) {
      await rm(candidate, { recursive: true, force: true })
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      try {
        const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { token?: unknown; expiresAt?: unknown }
        if (typeof owner.expiresAt === 'number' && owner.expiresAt < Date.now()) {
          const stale = `${path}.stale.${crypto.randomUUID()}`
          try {
            await rename(path, stale)
            const moved = JSON.parse(await readFile(join(stale, 'owner.json'), 'utf8')) as { token?: unknown; expiresAt?: unknown }
            if (moved.token !== owner.token || typeof moved.expiresAt !== 'number' || moved.expiresAt >= Date.now()) {
              await rename(stale, path)
            } else {
              await rm(stale, { recursive: true, force: true })
              continue
            }
          } catch { /* another contender won or the owner recovered */ }
        }
      } catch { /* wait for initial owner publication or recovery */ }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for shared lock: ${path}`)
      await Bun.sleep(100)
    }
  }
  let lost = false
  const assertOwned = async (): Promise<void> => {
    try {
      const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { token?: unknown; expiresAt?: unknown }
      if (owner.token !== token || typeof owner.expiresAt !== 'number' || owner.expiresAt <= Date.now()) throw new Error('shared build lock lease was lost')
    } catch (error) {
      lost = true
      throw error
    }
  }
  const renew = async (): Promise<void> => {
    const file = await open(ownerPath, 'r+')
    try {
      const owner = JSON.parse(await file.readFile('utf8')) as { token?: unknown; expiresAt?: unknown }
      if (owner.token !== token || typeof owner.expiresAt !== 'number' || owner.expiresAt <= Date.now()) throw new Error('shared build lock lease was lost')
      const value = Buffer.from(`${JSON.stringify({ token, expiresAt: Date.now() + leaseMs }, null, 2)}\n`)
      await file.truncate(0)
      await file.write(value, 0, value.length, 0)
      await file.sync()
    } catch (error) {
      lost = true
      throw error
    } finally { await file.close() }
  }
  const renewal = setInterval(() => {
    void renew().catch(() => { lost = true })
  }, Math.max(100, Math.floor(leaseMs / 3)))
  try {
    const result = await action(assertOwned)
    await assertOwned()
    return result
  } finally {
    clearInterval(renewal)
    if (!lost) {
      try { await assertOwned(); await rm(path, { recursive: true, force: true }) } catch { /* never remove a successor's lock */ }
    }
  }
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
