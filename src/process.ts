import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { ProcessRecord } from './types.ts'

export async function processIdentity(pid: number): Promise<{ pgid: number; startTime: string } | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    return { pgid: Number(fields[2]), startTime: fields[19]! }
  } catch { return undefined }
}

export async function processOwned(record: ProcessRecord): Promise<boolean> {
  const identity = await processIdentity(record.pid)
  return Boolean(identity && identity.pgid === record.pgid && identity.startTime === record.startTime)
}

export async function spawnOwned(
  name: ProcessRecord['name'],
  command: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; log: string }
): Promise<ProcessRecord> {
  if (!command[0]) throw new Error(`empty ${name} command`)
  const log = openSync(options.log, 'a', 0o600)
  const child = spawn(command[0], command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['ignore', log, log]
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
  } finally { closeSync(log) }
  child.unref()
  const identity = await processIdentity(child.pid!)
  if (!identity) throw new Error(`${name} exited during startup`)
  return { name, pid: child.pid!, pgid: identity.pgid, startTime: identity.startTime, command }
}

export async function terminateOwned(record: ProcessRecord, graceMs = 5_000): Promise<boolean> {
  if (!await processOwned(record)) return false
  try { process.kill(-record.pgid, 'SIGTERM') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!await processOwned(record)) return true
    await Bun.sleep(50)
  }
  if (await processOwned(record)) {
    try { process.kill(-record.pgid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  return true
}

export async function terminateAll(records: ProcessRecord[]): Promise<void> {
  for (const record of [...records].reverse()) await terminateOwned(record)
}
