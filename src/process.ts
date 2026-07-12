import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dlopen, FFIType, ptr } from 'bun:ffi'
import type { ProcessRecord } from './types.ts'

export interface ProcessIdentity {
  source: 'linux-proc' | 'darwin-libproc'
  pgid: number
  startTime: string
  executable?: string
}

export type ProcessInspector = (pid: number) => Promise<ProcessIdentity | undefined>

const PROC_PIDTBSDINFO = 3
const PROC_BSDINFO_SIZE = 136
const PBI_PGID_OFFSET = 100
const PBI_START_TVSEC_OFFSET = 120
const PBI_START_TVUSEC_OFFSET = 128
const PROC_PIDPATHINFO_MAXSIZE = 4096
const LIBPROC_SYMBOLS = {
  proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 }
} as const

function openLibproc() {
  return dlopen('/usr/lib/libproc.dylib', LIBPROC_SYMBOLS)
}

let libproc: ReturnType<typeof openLibproc> | undefined

function validRecord(record: ProcessRecord): boolean {
  return Number.isSafeInteger(record.pid) && record.pid > 1 && record.pgid === record.pid && Boolean(record.startTime)
}

function darwinProcessIdentity(pid: number): ProcessIdentity | undefined {
  libproc ??= openLibproc()
  const info = new Uint8Array(PROC_BSDINFO_SIZE)
  const size = libproc.symbols.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ptr(info), info.byteLength)
  if (size !== PROC_BSDINFO_SIZE) return undefined
  const path = new Uint8Array(PROC_PIDPATHINFO_MAXSIZE)
  const pathLength = libproc.symbols.proc_pidpath(pid, ptr(path), path.byteLength)
  if (pathLength <= 0 || pathLength >= path.byteLength) return undefined
  const view = new DataView(info.buffer, info.byteOffset, info.byteLength)
  const pgid = view.getUint32(PBI_PGID_OFFSET, true)
  const seconds = view.getBigUint64(PBI_START_TVSEC_OFFSET, true)
  const microseconds = view.getBigUint64(PBI_START_TVUSEC_OFFSET, true)
  const executable = new TextDecoder().decode(path.subarray(0, path.indexOf(0) === -1 ? pathLength : path.indexOf(0)))
  if (!Number.isSafeInteger(pgid) || pgid <= 1 || microseconds > 999_999 || !executable) return undefined
  return { source: 'darwin-libproc', pgid, startTime: `${seconds}.${microseconds.toString().padStart(6, '0')}`, executable }
}

export async function processIdentity(pid: number, platform: NodeJS.Platform = process.platform): Promise<ProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined
  if (platform === 'darwin') {
    try { return darwinProcessIdentity(pid) } catch { return undefined }
  }
  if (platform !== 'linux') return undefined
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    return { source: 'linux-proc', pgid: Number(fields[2]), startTime: fields[19]! }
  } catch { return undefined }
}

function sameIdentity(record: ProcessRecord, identity: ProcessIdentity): boolean {
  const source = record.identitySource ?? (identity.source === 'linux-proc' ? 'linux-proc' : undefined)
  if (source !== identity.source || identity.pgid !== record.pgid || identity.startTime !== record.startTime) return false
  return identity.source !== 'darwin-libproc' || Boolean(record.executable && identity.executable === record.executable)
}

async function signalStillOwned(record: ProcessRecord, inspect: ProcessInspector): Promise<boolean> {
  const identity = await inspect(record.pid)
  if (identity) return sameIdentity(record, identity)
  const linuxRecord = record.identitySource === undefined || record.identitySource === 'linux-proc'
  return linuxRecord && processGroupAlive(record.pgid)
}

export async function processOwned(record: ProcessRecord): Promise<boolean> {
  if (!validRecord(record)) return false
  const identity = await processIdentity(record.pid)
  return Boolean(identity && sameIdentity(record, identity))
}

function processGroupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

async function settledIdentity(pid: number, command: string[]): Promise<ProcessIdentity | undefined> {
  if (process.platform !== 'darwin') return await processIdentity(pid)
  const shellExec = command[1] === '-c' && /^\s*exec(?:\s|$)/.test(command[2] ?? '')
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    const identity = await processIdentity(pid)
    if (!identity) return undefined
    const executable = identity.executable ?? ''
    const transient = executable === '/usr/bin/env'
      || (shellExec && ['/bin/bash', '/bin/sh', '/bin/zsh'].includes(executable))
    if (!transient) return identity
    await Bun.sleep(10)
  }
  return undefined
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
  // Shebang and `exec` launchers can still be replacing their image when the
  // spawn event fires. Capture the executable after that handoff settles so
  // Darwin identity checks do not pin `/usr/bin/env` or the wrapper shell.
  const identity = await settledIdentity(child.pid!, command)
  if (!identity) throw new Error(`${name} exited during startup`)
  if (identity.pgid !== child.pid) { child.kill('SIGKILL'); throw new Error(`${name} did not start in its own process group`) }
  return {
    name, pid: child.pid!, pgid: identity.pgid, startTime: identity.startTime, command,
    identitySource: identity.source,
    ...(identity.executable ? { executable: identity.executable } : {})
  }
}

export async function terminateOwned(record: ProcessRecord, graceMs = 5_000, inspect: ProcessInspector = processIdentity): Promise<boolean> {
  if (!validRecord(record)) return false
  if (!await signalStillOwned(record, inspect)) return false
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
    if (!await signalStillOwned(record, inspect)) return false
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
