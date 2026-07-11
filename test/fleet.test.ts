import { afterEach, describe, expect, test } from 'bun:test'
import { createServer as createTcpServer } from 'node:net'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  StaticHtmlAppAdapter,
  DebuggerSession,
  createLineJsonRpcServer,
  createEndpointDescriptor,
  readEndpointRegistry,
  writeEndpointRegistry
} from '@byeongsu-hong/tauri-agent-plugin/daemon'
import { buildArtifact } from '../src/build.ts'
import { runCommand } from '../src/command.ts'
import { artifactKey, dirtyFingerprint, discoverRevision } from '../src/revision.ts'
import { parseAction, parseArtifactManifest, parseConfig, parseSuite } from '../src/schema.ts'
import { processIdentity, processOwned, spawnOwned, terminateOwned } from '../src/process.ts'
import { createInstance, stopInstance } from '../src/instance.ts'
import { privateDir, saveInstance } from '../src/storage.ts'
import { startDashboard } from '../src/server.ts'
import { runSuite, type NextAction } from '../src/runner.ts'
import { defaultVariant } from '../src/scheduler.ts'
import { freePort, waitFor } from '../src/network.ts'
import { openAIAction } from '../src/provider.ts'
import type { FleetConfig, InstanceRecord, ProcessRecord, Suite } from '../src/types.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function temporary(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'tauri-agent-fleet-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

const CONFIG: FleetConfig = {
  schemaVersion: 1,
  agent: { appId: 'com.example.app' },
  variants: { wry: { build: ['true'] }, cef: { build: ['true'] } }
}

test('port allocation honors active exclusions', async () => {
  const first = await freePort()
  expect(await freePort(new Set([first]))).not.toBe(first)
})

describe('trust-boundary schemas', () => {
  test('accepts v1 config and suites, rejects unsafe or unbounded input', () => {
    expect(parseConfig(CONFIG)).toEqual(CONFIG)
    const cefOnly = parseConfig({ schemaVersion: 1, agent: { appId: 'com.example.cef' }, variants: { cef: { build: ['true'] } } })
    expect(cefOnly.variants.wry).toBeUndefined()
    expect(defaultVariant(cefOnly)).toBe('cef')
    expect(() => parseConfig({ ...CONFIG, schemaVersion: 2 })).toThrow('schemaVersion')
    expect(() => parseConfig({ ...CONFIG, variants: { wry: { build: 'bun build' } } })).toThrow('string array')
    const suite = parseSuite({
      id: 'save', goal: 'Save', success: [{ state: { key: 'saved', equals: true } }], limits: { steps: 5, seconds: 10 }
    })
    expect(suite.variant).toBeUndefined()
    expect(() => parseSuite({ ...suite, success: [] })).toThrow('non-empty')
    expect(() => parseSuite({ ...suite, id: '../../escape' })).toThrow('safe identifier')
    expect(() => parseSuite({ ...suite, surprise: true })).toThrow('unknown field')
    expect(parseAction({ type: 'click', role: 'button' })).toEqual({ type: 'click', role: 'button' })
    expect(() => parseAction({ type: 'wait', milliseconds: 5001 })).toThrow('5000')
    expect(() => parseAction({ type: 'eval', value: 'danger()' })).toThrow('unsupported')
  })

  test('artifact executables cannot escape the cache', () => {
    expect(parseArtifactManifest({ schemaVersion: 1, executable: 'bin/app' }, '/tmp/artifact').executable).toBe('bin/app')
    expect(parseArtifactManifest({ schemaVersion: 1, executable: 'bin/app', args: [] }, '/tmp/artifact').args).toEqual([])
    expect(() => parseArtifactManifest({ schemaVersion: 1, executable: '../app' }, '/tmp/artifact')).toThrow('inside')
    expect(() => parseArtifactManifest({ schemaVersion: 1, executable: '/bin/sh' }, '/tmp/artifact')).toThrow('inside')
  })
})

test('revision fingerprints include dirty and untracked content and variant', async () => {
  const repo = await temporary()
  await runCommand(['git', 'init', '-q'], { cwd: repo })
  await runCommand(['git', 'config', 'user.email', 'fleet@example.test'], { cwd: repo })
  await runCommand(['git', 'config', 'user.name', 'Fleet Test'], { cwd: repo })
  await writeFile(join(repo, 'tracked'), 'one')
  await runCommand(['git', 'add', '.'], { cwd: repo })
  await runCommand(['git', 'commit', '-qm', 'initial'], { cwd: repo })
  const clean = await dirtyFingerprint(repo)
  await writeFile(join(repo, 'untracked'), 'first')
  const first = await dirtyFingerprint(repo)
  await writeFile(join(repo, 'untracked'), 'second')
  const second = await dirtyFingerprint(repo)
  expect(new Set([clean, first, second]).size).toBe(3)
  const revision = await discoverRevision(repo, 'HEAD', join(repo, '.state'))
  expect(artifactKey(revision, 'wry')).not.toBe(artifactKey(revision, 'cef'))
  const foreign = await temporary()
  await runCommand(['git', 'init', '-q'], { cwd: foreign })
  await expect(discoverRevision(repo, foreign, join(repo, '.state'))).rejects.toThrow('not a registered worktree')
  await mkdir(join(repo, 'nested'))
  await expect(discoverRevision(repo, join(repo, 'nested'), join(repo, '.state'))).rejects.toThrow('not a registered worktree')
})

test('build cache runs a variant build once and validates its manifest', async () => {
  const repo = await temporary()
  const state = join(repo, '.fleet')
  await runCommand(['git', 'init', '-q'], { cwd: repo })
  await runCommand(['git', 'config', 'user.email', 'fleet@example.test'], { cwd: repo })
  await runCommand(['git', 'config', 'user.name', 'Fleet Test'], { cwd: repo })
  await writeFile(join(repo, 'seed'), 'seed')
  await runCommand(['git', 'add', '.'], { cwd: repo })
  await runCommand(['git', 'commit', '-qm', 'initial'], { cwd: repo })
  const revision = await discoverRevision(repo, 'HEAD', state)
  const config: FleetConfig = {
    ...CONFIG,
    variants: { wry: { build: ['bash', '-c', `n=$(cat count 2>/dev/null || echo 0); echo $((n+1)) > count; mkdir -p "$FLEET_ARTIFACT_DIR/bin"; printf '#!/usr/bin/env bash\\nexec sleep 30\\n' > "$FLEET_ARTIFACT_DIR/bin/app"; chmod +x "$FLEET_ARTIFACT_DIR/bin/app"; printf '{"schemaVersion":1,"executable":"bin/app"}\\n' > "$FLEET_ARTIFACT_MANIFEST"`] } }
  }
  const first = await buildArtifact(config, state, revision, 'wry')
  const second = await buildArtifact(config, state, revision, 'wry')
  expect(second.key).toBe(first.key)
  expect(await readFile(join(repo, 'count'), 'utf8')).toBe('1\n')
  expect((await readFile(join(first.dir, 'bin/app'), 'utf8')).startsWith('#!')).toBe(true)
})

test('exact teardown does not touch sibling groups or stale PID records', async () => {
  const dir = await temporary()
  const one = await spawnOwned('app', ['bash', '-c', 'exec sleep 30'], { log: join(dir, 'one.log') })
  const two = await spawnOwned('app', ['bash', '-c', 'exec sleep 30'], { log: join(dir, 'two.log') })
  cleanups.push(async () => { await terminateOwned(one, 10); await terminateOwned(two, 10) })
  expect(await processOwned(one)).toBe(true)
  expect(await terminateOwned({ ...one, startTime: `${one.startTime}-stale` }, 10)).toBe(false)
  expect(await processOwned(one)).toBe(true)
  expect(await terminateOwned(one, 200)).toBe(true)
  expect(await processOwned(one)).toBe(false)
  expect(await processOwned(two)).toBe(true)
})

test('teardown kills descendants after the process-group leader exits', async () => {
  const dir = await temporary()
  const childFile = join(dir, 'child.pid')
  const record = await spawnOwned('app', ['bash', '-c', `trap 'exit 0' TERM; (trap '' TERM; echo "$BASHPID" > "$CHILD_PID_FILE"; exec sleep 30) & wait`], {
    env: { ...process.env, CHILD_PID_FILE: childFile },
    log: join(dir, 'group.log')
  })
  cleanups.push(() => { try { process.kill(-record.pgid, 'SIGKILL') } catch { /* already gone */ } })
  let childPid = 0
  await waitFor(async () => {
    try { childPid = Number(await readFile(childFile, 'utf8')); return childPid > 0 } catch { return false }
  }, 1_000, 'child PID')
  expect(record.pgid).toBe(record.pid)
  expect(await terminateOwned(record, 50)).toBe(true)
  await waitFor(async () => !await processIdentity(childPid), 1_000, 'descendant teardown')
})

test('parallel same-artifact instances isolate slots, state, endpoints, and teardown', async () => {
  const dir = await temporary()
  const root = join(dir, 'state')
  const artifactDir = join(dir, 'artifact')
  await mkdir(artifactDir)
  const xvfb = join(dir, 'fake-xvfb')
  const vnc = join(dir, 'fake-vnc')
  const app = join(artifactDir, 'app')
  await writeFile(xvfb, `#!/usr/bin/env bash
socket="/tmp/.X11-unix/X\${1#:}"
mkdir -p /tmp/.X11-unix
touch "$socket"
trap 'rm -f "$socket"; exit 0' TERM INT EXIT
while true; do sleep 1; done
`)
  await writeFile(vnc, `#!/usr/bin/env bun
const port = Number(Bun.argv[Bun.argv.indexOf('-rfbport') + 1])
const server = Bun.listen({ hostname: '127.0.0.1', port, socket: { data(socket, data) { socket.write(data) } } })
process.on('SIGTERM', () => { server.stop(true); process.exit(0) })
`)
  await writeFile(app, `#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = join(process.env.XDG_RUNTIME_DIR, 'tauri-agent', 'com.example.app')
mkdirSync(dir, { recursive: true, mode: 0o700 })
const path = join(dir, process.pid + '.sock')
let attaches = 0
const server = Bun.listen({ unix: path, socket: { data(socket, data) {
  for (const line of data.toString().trim().split('\\n')) { const request = JSON.parse(line); attaches += 1; socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { attached: true, windows: attaches > 1 ? [{ label: 'main' }] : [], capabilities: { runtime: process.env.FLEET_VARIANT, home: process.env.HOME, display: process.env.DISPLAY, custom: process.env.CUSTOM } } }) + '\\n') }
} } })
writeFileSync(join(dir, 'endpoint.json'), JSON.stringify({ appId: 'com.example.app', pid: process.pid, transport: 'unix', path, token: 'private-agent-token' }), { mode: 0o600 })
process.on('SIGTERM', () => { server.stop(true); process.exit(0) })
`)
  await Promise.all([xvfb, vnc, app].map((path) => chmod(path, 0o700)))
  const oldXvfb = process.env.FLEET_XVFB_COMMAND
  const oldVnc = process.env.FLEET_VNC_COMMAND
  process.env.FLEET_XVFB_COMMAND = xvfb
  process.env.FLEET_VNC_COMMAND = vnc
  cleanups.push(() => {
    if (oldXvfb === undefined) delete process.env.FLEET_XVFB_COMMAND
    else process.env.FLEET_XVFB_COMMAND = oldXvfb
    if (oldVnc === undefined) delete process.env.FLEET_VNC_COMMAND
    else process.env.FLEET_VNC_COMMAND = oldVnc
  })
  const worktreeOne = join(dir, 'worktree-one')
  const worktreeTwo = join(dir, 'worktree-two')
  await Promise.all([mkdir(worktreeOne), mkdir(worktreeTwo)])
  const revision = { repository: 'test', worktree: worktreeOne, commit: 'd'.repeat(40), dirtyFingerprint: 'e'.repeat(64) }
  const artifact = { key: 'f'.repeat(64), dir: artifactDir, manifest: { schemaVersion: 1 as const, executable: 'app', env: { HOME: '/escape', DISPLAY: ':1', CUSTOM: 'yes' } } }
  const [one, two] = await Promise.all([
    createInstance(CONFIG, root, revision, 'wry', artifact, 'one'),
    createInstance(CONFIG, root, revision, 'wry', artifact, 'two')
  ])
  cleanups.push(async () => { await stopInstance(root, one); await stopInstance(root, two) })
  expect(one.artifactKey).toBe(two.artifactKey)
  expect(one.slot).not.toBe(two.slot)
  expect(one.display).not.toBe(two.display)
  expect(one.vncPort).not.toBe(two.vncPort)
  expect(one.appPort).not.toBe(two.appPort)
  expect(one.directories.home).not.toBe(two.directories.home)
  expect(one.directories.runtime).not.toBe(two.directories.runtime)
  expect(one.directories.data).not.toBe(two.directories.data)
  expect(one.vncToken).not.toBe(two.vncToken)
  const [oneDescriptor, twoDescriptor] = await Promise.all([
    readEndpointRegistry(CONFIG.agent.appId, { env: { XDG_RUNTIME_DIR: one.directories.runtime } }),
    readEndpointRegistry(CONFIG.agent.appId, { env: { XDG_RUNTIME_DIR: two.directories.runtime } })
  ])
  if (oneDescriptor.transport !== 'unix' || twoDescriptor.transport !== 'unix') throw new Error('expected Unix endpoints')
  expect(oneDescriptor.path).not.toBe(twoDescriptor.path)
  expect(await readFile(join(one.directories.root, 'instance.json'), 'utf8')).not.toContain('private-agent-token')
  expect((one.endpoint?.capabilities as { capabilities: { home: string; display: string; custom: string; runtime: string } }).capabilities).toEqual({ home: one.directories.home, display: one.display, custom: 'yes', runtime: 'wry' })
  const cefArtifact = { ...artifact, key: '9'.repeat(64) }
  const cef = await createInstance(CONFIG, root, { ...revision, worktree: worktreeTwo, commit: '8'.repeat(40) }, 'cef', cefArtifact, 'cef')
  cleanups.push(async () => { await stopInstance(root, cef) })
  expect(cef.state).toBe('ready')
  expect(cef.variant).toBe('cef')
  expect(cef.revision.worktree).not.toBe(one.revision.worktree)
  expect((cef.endpoint?.capabilities as { capabilities: { runtime: string } }).capabilities.runtime).toBe('cef')
  await stopInstance(root, one)
  expect(await processOwned(two.processes.find((item) => item.name === 'app')!)).toBe(true)
})

test('dashboard validates opaque routes and forwards binary VNC traffic', async () => {
  const dir = await temporary()
  const assets = join(dir, 'assets')
  const root = join(dir, 'state')
  await mkdir(assets)
  await writeFile(join(assets, 'index.html'), 'fleet dashboard')
  const tcp = createTcpServer((socket) => socket.pipe(socket))
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve))
  const address = tcp.address()
  if (!address || typeof address === 'string') throw new Error('missing TCP port')
  const token = 'A'.repeat(32)
  const instance = fakeInstance(root, [], {
    vncPort: address.port,
    vncToken: token,
    state: 'stopped',
    endpoint: { healthy: false, descriptor: { token: 'legacy-agent-token' } } as InstanceRecord['endpoint']
  })
  await saveInstance(root, instance)
  const web = startDashboard({ root, assets, appId: CONFIG.agent.appId, host: '127.0.0.1', port: 0 })
  cleanups.push(() => { web.stop(true); tcp.close() })
  expect(await (await fetch(new URL('/', web.url))).text()).toBe('fleet dashboard')
  const state = await (await fetch(new URL('/api/state', web.url))).text()
  expect(state).not.toContain('legacy-agent-token')
  expect(await readFile(join(instance.directories.root, 'instance.json'), 'utf8')).not.toContain('legacy-agent-token')
  expect((await fetch(new URL('/websockify?token=branch-name', web.url))).status).toBe(404)
  const echoed = await new Promise<number[]>((resolve, reject) => {
    const ws = new WebSocket(new URL(`/websockify?token=${token}`, web.url).toString().replace('http:', 'ws:'))
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => ws.send(Uint8Array.of(0, 1, 2, 255))
    ws.onerror = () => reject(new Error('websocket failed'))
    ws.onmessage = ({ data }) => { ws.close(); resolve([...new Uint8Array(data as ArrayBuffer)]) }
  })
  expect(echoed).toEqual([0, 1, 2, 255])
})

test('provider sends lean structured context and records reported usage and cost', async () => {
  let requestBody: Record<string, unknown> | undefined
  const api = Bun.serve({
    port: 0,
    async fetch(request) {
      requestBody = await request.json() as Record<string, unknown>
      return Response.json({
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
          type: 'click', scope: null, role: 'button', name: 'Save', text: null, value: null, x: null, y: null, milliseconds: null
        }) }] }],
        usage: { input_tokens: 100, output_tokens: 20 }
      })
    }
  })
  cleanups.push(() => api.stop(true))
  const previous = { ...process.env }
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.OPENAI_BASE_URL = String(api.url).replace(/\/$/, '')
  process.env.OPENAI_INPUT_COST_PER_MILLION = '1'
  process.env.OPENAI_OUTPUT_COST_PER_MILLION = '2'
  cleanups.push(() => {
    for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_INPUT_COST_PER_MILLION', 'OPENAI_OUTPUT_COST_PER_MILLION']) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  })
  const decision = await openAIAction({ goal: 'Save', success: [{ state: { key: 'saved', equals: true } }], observation: { snapshot: 'button Save' }, remaining: { steps: 2, seconds: 5, tokens: 1000 } })
  expect(decision.action).toEqual({ type: 'click', role: 'button', name: 'Save' })
  expect(decision.usage).toEqual({ inputTokens: 100, outputTokens: 20, cost: 0.00014 })
  expect(requestBody?.store).toBe(false)
  expect(requestBody?.max_output_tokens).toBe(100)
  expect((requestBody?.text as { format: { type: string } }).format.type).toBe('json_schema')
  expect(JSON.parse(requestBody?.input as string)).toEqual({ goal: 'Save', success: [{ state: { key: 'saved', equals: true } }], observation: { snapshot: 'button Save' }, remaining: { steps: 2, seconds: 5, tokens: 1000 } })
})

function fakeInstance(root: string, processes: ProcessRecord[], changes: Partial<InstanceRecord> = {}): InstanceRecord {
  const id = changes.id ?? crypto.randomUUID()
  const base = join(root, 'instances', id)
  const now = new Date().toISOString()
  return {
    schemaVersion: 1, id, revision: { repository: 'test', worktree: '.', commit: 'a'.repeat(40), dirtyFingerprint: 'b'.repeat(64) },
    variant: 'wry', artifactKey: 'c'.repeat(64), state: 'ready', createdAt: now, updatedAt: now, slot: 0,
    display: ':90', vncPort: 5900, appPort: 3000, vncToken: 'T'.repeat(32),
    directories: { root: base, home: join(base, 'home'), runtime: join(base, 'runtime'), data: join(base, 'data'), artifacts: join(base, 'artifacts') },
    processes, ...changes
  }
}

async function runnerHarness(): Promise<{ root: string; instance: InstanceRecord; close: () => Promise<void> }> {
  const root = await temporary()
  const instanceBase = join(root, 'instances', 'runner')
  const runtime = join(instanceBase, 'runtime')
  const artifacts = join(instanceBase, 'artifacts')
  await privateDir(runtime)
  await privateDir(artifacts)
  const processRecord = await spawnOwned('app', ['bash', '-c', 'exec sleep 30'], { log: join(instanceBase, 'app.log') })
  const descriptor = createEndpointDescriptor({ appId: CONFIG.agent.appId, pid: processRecord.pid, env: { XDG_RUNTIME_DIR: runtime } })
  if (descriptor.transport !== 'unix') throw new Error('expected unix endpoint')
  await privateDir(dirname(descriptor.path))
  const adapter = await StaticHtmlAppAdapter.create({ html: '<label>Document name<input aria-label="Document name" name="documentName"></label>' })
  const server = createLineJsonRpcServer(new DebuggerSession(adapter))
  await new Promise<void>((resolve) => server.listen(descriptor.path, resolve))
  await writeEndpointRegistry(descriptor, { env: { XDG_RUNTIME_DIR: runtime } })
  const instance = fakeInstance(root, [processRecord], {
    id: 'runner', directories: { root: instanceBase, home: join(instanceBase, 'home'), runtime, data: join(instanceBase, 'data'), artifacts }
  })
  await saveInstance(root, instance)
  return {
    root,
    instance,
    close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await terminateOwned(processRecord, 50) }
  }
}

const UNREACHABLE: Suite['success'] = [{ expect: { role: 'textbox', name: 'Never here', value: 'done' } }]

test('mock-model run passes by deterministic assertion and persists lean artifacts', async () => {
  const harness = await runnerHarness()
  cleanups.push(harness.close)
  const suite: Suite = { id: 'save', goal: 'Rename the document', success: [{ expect: { role: 'textbox', name: 'Document name', value: 'notes.md' } }], limits: { steps: 3, seconds: 5 } }
  const mock: NextAction = async () => ({ action: { type: 'fill', role: 'textbox', name: 'Document name', value: 'notes.md' }, usage: { inputTokens: 10, outputTokens: 2 }, raw: {} })
  const result = await runSuite(harness.root, CONFIG.agent.appId, harness.instance, suite, mock)
  expect(result.state).toBe('passed')
  expect(result.run?.inputTokens).toBe(10)
  const dir = join(result.directories.artifacts, result.run!.id)
  expect((await readFile(join(dir, 'actions.jsonl'), 'utf8')).split('\n').filter(Boolean)).toHaveLength(1)
  expect(JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')).state).toBe('passed')
})

test('app timeouts, invalid usage, and repeated model actions have distinct failure classes', async () => {
  const appHarness = await runnerHarness()
  cleanups.push(appHarness.close)
  const wait: NextAction = async () => await new Promise<never>(() => {})
  const appSuite: Suite = { id: 'app-timeout', goal: 'Impossible', success: UNREACHABLE, limits: { steps: 5, seconds: 1, repetitions: 5 } }
  const started = Date.now()
  const appResult = await runSuite(appHarness.root, CONFIG.agent.appId, appHarness.instance, appSuite, wait)
  expect(appResult.run?.failure).toBe('app_failure')
  expect(Date.now() - started).toBeLessThan(2_000)

  const usageHarness = await runnerHarness()
  cleanups.push(usageHarness.close)
  const invalidUsage: NextAction = async () => ({ action: { type: 'wait', milliseconds: 1 }, usage: { inputTokens: -1, outputTokens: 1 }, raw: {} })
  const usageResult = await runSuite(usageHarness.root, CONFIG.agent.appId, usageHarness.instance, { ...appSuite, id: 'invalid-usage', limits: { ...appSuite.limits, seconds: 5 } }, invalidUsage)
  expect(usageResult.run).toMatchObject({ failure: 'runner_failure', inputTokens: 0, outputTokens: 0 })

  const runnerHarnessValue = await runnerHarness()
  cleanups.push(runnerHarnessValue.close)
  const repeat: NextAction = async () => ({ action: { type: 'wait', milliseconds: 1 }, usage: { inputTokens: 1, outputTokens: 1 }, raw: {} })
  const runnerSuite: Suite = { id: 'runner-repeat', goal: 'Impossible', success: UNREACHABLE, limits: { steps: 5, seconds: 5, repetitions: 1 } }
  const runnerResult = await runSuite(runnerHarnessValue.root, CONFIG.agent.appId, runnerHarnessValue.instance, runnerSuite, repeat)
  expect(runnerResult.run?.failure).toBe('runner_failure')
  expect(await readFile(join(runnerResult.directories.artifacts, runnerResult.run!.id, 'failure.png'))).not.toHaveLength(0)
})
