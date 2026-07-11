import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { ProcessRecord } from './types.ts'

function validRecord(record: ProcessRecord): boolean {
  return Number.isSafeInteger(record.pid) && record.pid > 1 && record.pgid === record.pid && Boolean(record.startTime)
}

export async function processIdentity(pid: number): Promise<{ pgid: number; startTime: string } | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    return { pgid: Number(fields[2]), startTime: fields[19]! }
  } catch { return undefined }
}

export async function processOwned(record: ProcessRecord): Promise<boolean> {
  if (!validRecord(record)) return false
  const identity = await processIdentity(record.pid)
  return Boolean(identity && identity.pgid === record.pgid && identity.startTime === record.startTime)
}

function processGroupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

export async function spawnOwned(
  name: ProcessRecord['name'],
  command: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; log: string }
): Promise<ProcessRecord> {
  if (!command[0]) throw new Error(`empty ${name} command`)
  const log = openSync(options.log, 'a', 0o600)
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', log, log]
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
  } finally { closeSync(log) }
  child.unref()
  const identity = await processIdentity(child.pid!)
  if (!identity) throw new Error(`${name} exited during startup`)
  if (identity.pgid !== child.pid) { child.kill('SIGKILL'); throw new Error(`${name} did not start in its own process group`) }
  return { name, pid: child.pid!, pgid: identity.pgid, startTime: identity.startTime, command }
}

export async function terminateOwned(record: ProcessRecord, graceMs = 5_000): Promise<boolean> {
  if (!validRecord(record)) return false
  const identity = await processIdentity(record.pid)
  if (identity ? identity.pgid !== record.pgid || identity.startTime !== record.startTime : !processGroupAlive(record.pgid)) return false
  try { process.kill(-record.pgid, 'SIGTERM') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!processGroupAlive(record.pgid)) return true
    await Bun.sleep(50)
  }
  if (processGroupAlive(record.pgid)) {
    try { process.kill(-record.pgid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    const killDeadline = Date.now() + Math.max(1_000, graceMs)
    while (Date.now() < killDeadline) {
      if (!processGroupAlive(record.pgid)) return true
      await Bun.sleep(10)
    }
    if (processGroupAlive(record.pgid)) throw new Error(`${record.name} process group ${record.pgid} survived SIGKILL`)
  }
  return true
}

export async function terminateAll(records: ProcessRecord[]): Promise<void> {
  let failure: unknown
  for (const record of [...records].reverse()) {
    try { await terminateOwned(record) } catch (error) { failure ??= error }
  }
  if (failure) throw failure
}
