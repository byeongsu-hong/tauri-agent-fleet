#!/usr/bin/env bun
import { access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { buildArtifact } from './build.ts'
import { createInstance, refreshInstance, stopInstance } from './instance.ts'
import { discoverRevision } from './revision.ts'
import { defaultVariant, runSuites } from './scheduler.ts'
import { startDashboard } from './server.ts'
import { listInstances, loadConfig, loadSuite, stateRoot } from './storage.ts'
import type { RuntimeVariant } from './types.ts'

const HELP = `tauri-agent-fleet <command> [options]

Commands:
  up [revision...]                 build and start interactive instances
  down [instance...]               stop exact instances (all active if omitted)
  status [--json]                  show instance and run health
  dashboard [--host HOST] [--port PORT]
  test <suite.json...> [--revision REF] [--variant wry|cef] [--jobs N]

Options:
  --config PATH                    config file (default tauri-agent-fleet.json)
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

function variant(value: string | undefined): RuntimeVariant | undefined {
  if (value === undefined) return undefined
  if (value !== 'wry' && value !== 'cef') throw new Error('--variant must be wry or cef')
  return value
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
  if (!['up', 'down', 'status', 'dashboard', 'test'].includes(command)) throw new Error(`unknown command: ${command}\n\n${HELP}`)
  const loaded = await loadConfig(configOption)
  const root = stateRoot(loaded.config, loaded.path)
  const repository = dirname(loaded.path)
  if (command === 'up') {
    const selectedVariant = variant(take(args, '--variant')) ?? defaultVariant(loaded.config)
    const id = take(args, '--id')
    if (id && args.length > 1) throw new Error('--id can only be used with one revision')
    const selectors = args.length ? args : ['HEAD']
    for (const selector of selectors) {
      const revision = await discoverRevision(repository, selector, root)
      const artifact = await buildArtifact(loaded.config, root, revision, selectedVariant)
      const instance = await createInstance(loaded.config, root, revision, selectedVariant, artifact, id)
      console.log(`${instance.id}\t${instance.state}\t${instance.display}\tVNC ${instance.vncPort}`)
    }
    return 0
  }
  if (command === 'down') {
    const instances = await listInstances(root)
    const selected = args.length ? instances.filter((item) => args.includes(item.id)) : instances.filter((item) => ['booting', 'ready', 'running'].includes(item.state))
    if (args.length && selected.length !== new Set(args).size) throw new Error('one or more instance IDs were not found')
    for (const instance of selected) { await stopInstance(root, instance); console.log(`${instance.id}\tstopped`) }
    return 0
  }
  if (command === 'status') {
    const json = flag(args, '--json')
    if (args.length) throw new Error(`unknown option: ${args[0]}`)
    const instances = await Promise.all((await listInstances(root)).map((item) => refreshInstance(root, item)))
    if (json) console.log(JSON.stringify({ generatedAt: new Date().toISOString(), instances }, null, 2))
    else {
      console.log('INSTANCE\tSTATE\tREVISION\tVARIANT\tDISPLAY\tRUN\tTOKENS')
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
    const server = startDashboard({ root, assets: await assetsPath(), host, port })
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
    const selectedVariant = variant(take(args, '--variant'))
    const jobs = Number(take(args, '--jobs') ?? 1)
    if (!args.length) throw new Error('test requires at least one suite file')
    const suites = await Promise.all(args.map(loadSuite))
    const revision = await discoverRevision(repository, revisionName, root)
    const results = await runSuites(loaded.config, root, revision, suites, { jobs, ...(selectedVariant ? { variant: selectedVariant } : {}) })
    for (const item of results) console.log(`${item.run?.suite}\t${item.state}\t${item.run?.failure ?? '-'}`)
    return results.every((item) => item.state === 'passed') ? 0 : 1
  }
  throw new Error(`unhandled command: ${command}`)
}

main().then((code) => { process.exitCode = code }).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
