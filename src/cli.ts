#!/usr/bin/env bun
import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { buildArtifact } from './build.ts'
import { COORDINATOR_PROTOCOL } from './coordinator.ts'
import { CoordinatorClient, startCoordinator } from './coordinator-server.ts'
import { createInstance, refreshInstance, stopInstance } from './instance.ts'
import { discoverRevision, requireCleanRevision } from './revision.ts'
import { defaultVariant, runSuites } from './scheduler.ts'
import { startDashboard } from './server.ts'
import { listInstances, loadConfig, loadSuite, stateRoot } from './storage.ts'
import type { RuntimeVariant } from './types.ts'
import { runWorker } from './worker.ts'

const HELP = `agent-fleet <command> [options]

Commands:
  up [revision...]                 build and start interactive instances
     [--runtime NAME] [--id PREFIX]
  down [instance...]               stop exact instances (all active if omitted)
  status [--json]                  show instance and run health
  dashboard [--host HOST] [--port PORT]
  test <suite...> [--revision REF] [--runtime NAME] [--jobs N]
  coordinator [--host HOST] [--port PORT] [--max-active N]
  submit <suite...> --coordinator URL [--revision REF] [--runtime NAME]
  worker --coordinator URL --id ID [--jobs N] [--once]
  remote-status --coordinator URL [--json]

Options:
  --config PATH                    config file (default .agent/fleet.json)
  --help                           show this help
  --version                        show the version`

function take(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  args.splice(index, 2)
  return value
}

function flag(args: string[], name: string): boolean {
  const index = args.indexOf(name)
  if (index === -1) return false
  args.splice(index, 1)
  return true
}

function runtime(value: string | undefined): RuntimeVariant | undefined {
  // Any configured runtime name; buildArtifact rejects an unconfigured one.
  return value
}

function positive(value: string | undefined, fallback: number, name: string): number {
  const number = Number(value ?? fallback)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive safe integer`)
  return number
}

function coordinatorToken(): string {
  const token = process.env.FLEET_COORDINATOR_TOKEN ?? ''
  if (token.length < 32) throw new Error('FLEET_COORDINATOR_TOKEN must contain at least 32 characters')
  return token
}

async function assetsPath(): Promise<string> {
  const bundled = join(import.meta.dir, 'dashboard')
  try { await access(bundled); return bundled } catch { return resolve(import.meta.dir, '../dist/dashboard') }
}

async function main(): Promise<number> {
  const args = Bun.argv.slice(2)
  if (flag(args, '--help') || args.length === 0) { console.log(HELP); return 0 }
  if (flag(args, '--version')) { console.log('0.1.0'); return 0 }
  const configOption = take(args, '--config')
  const command = args.shift()!
  if (!['up', 'down', 'status', 'dashboard', 'test', 'coordinator', 'submit', 'worker', 'remote-status'].includes(command)) throw new Error(`unknown command: ${command}\n\n${HELP}`)
  const loaded = await loadConfig(configOption)
  const root = stateRoot(loaded.path)
  const repository = loaded.workspace
  if (command === 'coordinator') {
    const host = take(args, '--host') ?? '127.0.0.1'
    const port = Number(take(args, '--port') ?? 4180)
    const maxActive = positive(take(args, '--max-active'), 8, '--max-active')
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a valid port')
    if (args.length) throw new Error(`unknown option: ${args[0]}`)
    const server = startCoordinator({ root: join(root, 'coordinator'), token: coordinatorToken(), host, port, maxActive, assets: await assetsPath() })
    console.log(`coordinator listening on ${server.url}`)
    await new Promise<void>((resolve) => {
      const stop = () => { server.stop(true); resolve() }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
    return 0
  }
  if (command === 'submit') {
    const url = take(args, '--coordinator')
    if (!url) throw new Error('submit requires --coordinator URL')
    const revisionName = take(args, '--revision') ?? 'HEAD'
    const selectedVariant = runtime(take(args, '--runtime'))
    if (!args.length) throw new Error('submit requires at least one suite ID')
    const suites = await Promise.all(args.map((id) => loadSuite(loaded.workspace, id)))
    const revision = await discoverRevision(repository, revisionName, root)
    requireCleanRevision(revision)
    const client = new CoordinatorClient(url, coordinatorToken())
    for (const suite of suites) {
      const selected = selectedVariant ?? suite.runtime ?? defaultVariant(loaded.config)
      const job = await client.enqueue({ protocol: COORDINATOR_PROTOCOL, repository: revision.repository, commit: revision.commit, suite, runtime: selected })
      console.log(`${job.id}\t${suite.id}\t${selected}\t${job.state}`)
    }
    return 0
  }
  if (command === 'worker') {
    const url = take(args, '--coordinator')
    const id = take(args, '--id')
    const jobs = positive(take(args, '--jobs'), 1, '--jobs')
    const once = flag(args, '--once')
    if (!url || !id) throw new Error('worker requires --coordinator URL and --id ID')
    if (args.length) throw new Error(`unknown option: ${args[0]}`)
    const controller = new AbortController()
    const stop = () => controller.abort()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    try {
      await runWorker({
        client: new CoordinatorClient(url, coordinatorToken()), config: loaded.config, repository,
        root: join(root, 'worker'), id, jobs, once, signal: controller.signal
      })
    } finally {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
    }
    return 0
  }
  if (command === 'remote-status') {
    const url = take(args, '--coordinator')
    const json = flag(args, '--json')
    if (!url) throw new Error('remote-status requires --coordinator URL')
    if (args.length) throw new Error(`unknown option: ${args[0]}`)
    const value = await new CoordinatorClient(url, coordinatorToken()).status() as {
      summary: Record<string, number>
      jobs: Array<{ id: string; state: string; workerId?: string; commit: string; runtime: string; suite: { id: string }; attempt: number }>
    }
    if (json) console.log(JSON.stringify(value, null, 2))
    else {
      console.log(`TOTAL ${value.summary.total}  QUEUED ${value.summary.queued}  ACTIVE ${value.summary.active}  PASSED ${value.summary.passed}  FAILED ${value.summary.failed}`)
      console.log('JOB\tSTATE\tWORKER\tREVISION\tRUNTIME\tSUITE\tATTEMPT')
      for (const job of value.jobs) console.log([job.id, job.state, job.workerId ?? '-', job.commit.slice(0, 12), job.runtime, job.suite.id, job.attempt].join('\t'))
    }
    return 0
  }
  if (command === 'up') {
    const selectedVariant = runtime(take(args, '--runtime')) ?? defaultVariant(loaded.config)
    const id = take(args, '--id')
    if (id && args.length > 1) throw new Error('--id can only be used with one revision')
    const selectors = args.length ? args : ['HEAD']
    for (const selector of selectors) {
      const revision = await discoverRevision(repository, selector, root)
      const artifact = await buildArtifact(loaded.config, root, revision, selectedVariant)
      const instance = await createInstance(loaded.config, root, revision, selectedVariant, artifact, id)
      const view = instance.processes.some((process) => process.name === 'vnc') ? `VNC ${instance.vncPort}` : 'VNC unavailable'
      console.log(`${instance.id}\t${instance.state}\t${instance.display}\t${view}`)
    }
    return 0
  }
  if (command === 'down') {
    const instances = await listInstances(root)
    const selected = args.length ? instances.filter((item) => args.includes(item.id)) : instances.filter((item) => ['booting', 'ready', 'running'].includes(item.state))
    if (args.length && selected.length !== new Set(args).size) throw new Error('one or more instance IDs were not found')
    for (const instance of selected) { await stopInstance(loaded.config, root, instance); console.log(`${instance.id}\tstopped`) }
    return 0
  }
  if (command === 'status') {
    const json = flag(args, '--json')
    if (args.length) throw new Error(`unknown option: ${args[0]}`)
    const instances = await Promise.all((await listInstances(root)).map((item) => refreshInstance(loaded.config, root, item)))
    if (json) console.log(JSON.stringify({
      protocol: 'agent-status/v1',
      generatedAt: new Date().toISOString(),
      instances: instances.map(({ schemaVersion: _, variant: runtime, endpoint: agent, ...instance }) => ({ ...instance, runtime, ...(agent ? { agent } : {}) }))
    }, null, 2))
    else {
      console.log('INSTANCE\tSTATE\tREVISION\tRUNTIME\tDISPLAY\tRUN\tTOKENS')
      for (const item of instances) console.log([
        item.id, item.state, item.revision.branch ?? item.revision.commit.slice(0, 12), item.variant, item.display,
        item.run?.suite ?? '-', item.run ? item.run.inputTokens + item.run.outputTokens : 0
      ].join('\t'))
    }
    return 0
  }
  if (command === 'dashboard') {
    const host = take(args, '--host') ?? '127.0.0.1'
    const port = Number(take(args, '--port') ?? 4173)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a valid port')
    if (args.length) throw new Error(`unknown option: ${args[0]}`)
    const server = startDashboard({ root, assets: await assetsPath(), config: loaded.config, host, port })
    console.log(`dashboard listening on ${server.url}`)
    await new Promise<void>((resolve) => {
      const stop = () => { server.stop(true); resolve() }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
    return 0
  }
  if (command === 'test') {
    const revisionName = take(args, '--revision') ?? 'HEAD'
    const selectedVariant = runtime(take(args, '--runtime'))
    const jobs = positive(take(args, '--jobs'), 1, '--jobs')
    if (!args.length) throw new Error('test requires at least one suite ID')
    const suites = await Promise.all(args.map((id) => loadSuite(loaded.workspace, id)))
    const revision = await discoverRevision(repository, revisionName, root)
    const results = await runSuites(loaded.config, root, revision, suites, { jobs, ...(selectedVariant ? { runtime: selectedVariant } : {}) })
    for (const item of results) console.log(`${item.run?.suite}\t${item.state}\t${item.run?.failure ?? '-'}`)
    return results.every((item) => item.state === 'passed') ? 0 : 1
  }
  throw new Error(`unhandled command: ${command}`)
}

main().then((code) => { process.exitCode = code }).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
