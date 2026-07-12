import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
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
import { artifactKey, CLEAN_FINGERPRINT, dirtyFingerprint, discoverRevision, resolveInsideWorktree } from '../src/revision.ts'
import { parseAction, parseArtifactManifest, parseConfig, parseSuite } from '../src/schema.ts'
import { processIdentity, processOwned, spawnOwned, terminateOwned } from '../src/process.ts'
import { createInstance, refreshInstance, stopInstance } from '../src/instance.ts'
import { atomicJson, listInstances, loadConfig, loadSuite, privateDir, saveInstance, stateRoot } from '../src/storage.ts'
import { startDashboard } from '../src/server.ts'
import { conditionMet, runSuite, type NextAction } from '../src/runner.ts'
import { defaultVariant, runSuites } from '../src/scheduler.ts'
import { freePort, portOpen, waitFor } from '../src/network.ts'
import { decodeInstruction, encodeInstruction, instructionToJson, jsonToInstruction } from '../src/instruction.ts'
import { formatActionText, modelAction, parseActionText } from '../src/provider.ts'
import type { FleetConfig, InstanceRecord, ProcessRecord, Suite } from '../src/types.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function temporary(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'tauri-agent-fleet-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

test('TOON instructions round-trip the JSON data model and typed actions', () => {
  const value = { objective: 'Save "notes"', pass: [{ state: { key: 'saved', equals: true } }], values: [null, 1, 'two\nlines'] }
  expect(decodeInstruction(encodeInstruction(value))).toEqual(value)
  expect(JSON.parse(instructionToJson(jsonToInstruction(JSON.stringify(value))))).toEqual(value)
  const action = { type: 'fill', role: 'textbox', name: 'Document name', value: 'notes.md' } as const
  expect(parseActionText(formatActionText(action))).toEqual(action)
  expect(parseActionText(JSON.stringify(action))).toEqual(action)
})

const CONFIG: FleetConfig = {
  protocol: 'tauri-agent-fleet/v1',
  application: { id: 'com.example.app', root: '.' },
  runtimes: { default: 'wry', wry: { build: ['true'] }, cef: { build: ['true'] } }
}

test('command output and execution time are bounded', async () => {
  await expect(runCommand(['bash', '-c', 'printf 12345'], { maxOutputBytes: 4 })).rejects.toThrow('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
  await expect(runCommand(['sleep', '30'], { timeoutMs: 10 })).rejects.toThrow('timed out after 10ms')
})

test('failed atomic writes remove their private temporary file', async () => {
  const dir = await temporary()
  const target = join(dir, 'state.json')
  await mkdir(target)
  await expect(atomicJson(target, { ok: true })).rejects.toThrow()
  expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
})

test('port allocation honors active exclusions', async () => {
  const first = await freePort()
  expect(await freePort(new Set([first]))).not.toBe(first)
})

describe('trust-boundary schemas', () => {
  test('accepts v1 config and suites, rejects unsafe or unbounded input', () => {
    expect(parseConfig(CONFIG)).toEqual(CONFIG)
    const cefOnly = parseConfig({ protocol: 'tauri-agent-fleet/v1', application: { id: 'com.example.cef', root: '.' }, runtimes: { default: 'cef', cef: { build: ['true'] } } })
    expect(cefOnly.runtimes.wry).toBeUndefined()
    expect(defaultVariant(cefOnly)).toBe('cef')
    expect(() => parseConfig({ ...CONFIG, protocol: 'tauri-agent-fleet/v2' })).toThrow('protocol')
    expect(() => parseConfig({ ...CONFIG, application: { id: 'com.example.app', root: '../outside' } })).toThrow('inside the workspace')
    expect(() => parseConfig({ ...CONFIG, runtimes: { default: 'wry', wry: { build: 'bun build' } } })).toThrow('string array')
    expect(parseConfig({ ...CONFIG, runtimes: { default: 'wry', wry: { build: ['printf', ''] } } }).runtimes.wry?.build).toEqual(['printf', ''])
    expect(parseConfig({ ...CONFIG, lifecycle: { cleanupInstance: ['bash', 'cleanup.sh'] } }).lifecycle?.cleanupInstance).toEqual(['bash', 'cleanup.sh'])
    expect(() => parseConfig({ ...CONFIG, runtimes: { default: 'wry', wry: { build: ['', 'arg'] } } })).toThrow('executable')
    expect(() => parseConfig({ ...CONFIG, runtimes: { default: 'wry', wry: { build: ['  '] } } })).toThrow('executable')
    expect(() => parseConfig({ ...CONFIG, runtimes: { default: 'wry', wry: { build: ['printf', '\0'] } } })).toThrow('string array')
    expect(() => parseConfig({ ...CONFIG, runtimes: { default: 'cef', wry: { build: ['true'] } } })).toThrow('configured runtime')
    const suite = parseSuite({
      protocol: 'tauri-agent-suite/v1', id: 'save', objective: 'Save', pass: [{ state: { key: 'saved', equals: true } }], budget: { steps: 5, seconds: 10 }
    })
    expect(suite.runtime).toBeUndefined()
    expect(() => parseSuite({ ...suite, pass: [] })).toThrow('non-empty')
    expect(() => parseSuite({ ...suite, budget: { steps: Number.MAX_SAFE_INTEGER + 1, seconds: 1 } })).toThrow('safe integer')
    expect(() => parseSuite({ ...suite, budget: { steps: 1, seconds: 2_147_484 } })).toThrow('2147483')
    expect(() => parseSuite({ ...suite, id: '../../escape' })).toThrow('safe identifier')
    expect(() => parseSuite({ ...suite, surprise: true })).toThrow('unknown field')
    expect(parseAction({ type: 'click', role: 'button' })).toEqual({ type: 'click', role: 'button' })
    expect(() => parseAction({ type: 'wait', milliseconds: 5001 })).toThrow('5000')
    expect(() => parseAction({ type: 'eval', value: 'danger()' })).toThrow('unsupported')
  })

  test('discovers hidden workspace config and resolves state from the workspace', async () => {
    const root = await temporary()
    await mkdir(join(root, '.tauri-agent'))
    await mkdir(join(root, 'app', 'nested'), { recursive: true })
    await mkdir(join(root, '.tauri-agent', 'suites'))
    await writeFile(join(root, '.tauri-agent', 'fleet.json'), JSON.stringify(CONFIG))
    await writeFile(join(root, '.tauri-agent', 'suites', 'save.json'), JSON.stringify({
      protocol: 'tauri-agent-suite/v1', id: 'save', objective: 'Save', pass: [{ state: { key: 'saved', equals: true } }], budget: { steps: 1, seconds: 1 }
    }))
    await writeFile(join(root, '.tauri-agent', 'suites', 'wrong.json'), JSON.stringify({
      protocol: 'tauri-agent-suite/v1', id: 'different', objective: 'Save', pass: [{ state: { key: 'saved', equals: true } }], budget: { steps: 1, seconds: 1 }
    }))
    await writeFile(join(root, '.tauri-agent', 'suites', 'toon.toon'), encodeInstruction({
      protocol: 'tauri-agent-suite/v1', id: 'toon', objective: 'Save', pass: [{ state: { key: 'saved', equals: true } }], budget: { steps: 1, seconds: 1 }
    }))
    const previous = process.cwd()
    try {
      process.chdir(join(root, 'app', 'nested'))
      const loaded = await loadConfig()
      expect(loaded.path).toBe(join(root, '.tauri-agent', 'fleet.json'))
      expect(loaded.workspace).toBe(root)
      expect(stateRoot(loaded.path)).toContain(join('tauri-agent-fleet', ''))
      expect((await loadSuite(loaded.workspace, 'save')).id).toBe('save')
      expect((await loadSuite(loaded.workspace, 'toon')).id).toBe('toon')
      await expect(loadSuite(loaded.workspace, '../save')).rejects.toThrow('invalid suite ID')
      await expect(loadSuite(loaded.workspace, 'wrong')).rejects.toThrow('declares ID different')
    } finally { process.chdir(previous) }
  })

  test('ignores a relative XDG state root', () => {
    const previous = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = 'relative-state'
    try { expect(stateRoot('/tmp/config').startsWith(join(homedir(), '.local', 'state', 'tauri-agent-fleet'))).toBe(true) } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previous
    }
  })

  test('artifact executables cannot escape the cache', () => {
    expect(parseArtifactManifest({ protocol: 'tauri-agent-artifact/v1', executable: 'bin/app' }, '/tmp/artifact').executable).toBe('bin/app')
    expect(parseArtifactManifest({ protocol: 'tauri-agent-artifact/v1', executable: 'bin/app', args: [] }, '/tmp/artifact').args).toEqual([])
    expect(parseArtifactManifest({ protocol: 'tauri-agent-artifact/v1', executable: 'bin/app', args: [''] }, '/tmp/artifact').args).toEqual([''])
    expect(() => parseArtifactManifest({ protocol: 'tauri-agent-artifact/v1', executable: 'bin/app', env: { 'BAD=KEY': 'value' } }, '/tmp/artifact')).toThrow('variable name')
    expect(() => parseArtifactManifest({ protocol: 'tauri-agent-artifact/v1', executable: 'bin/app', env: { OK: '\0' } }, '/tmp/artifact')).toThrow('null bytes')
    expect(() => parseArtifactManifest({ protocol: 'tauri-agent-artifact/v2', executable: 'bin/app' }, '/tmp/artifact')).toThrow('protocol')
    expect(() => parseArtifactManifest({ protocol: 'tauri-agent-artifact/v1', executable: '../app' }, '/tmp/artifact')).toThrow('inside')
    expect(() => parseArtifactManifest({ protocol: 'tauri-agent-artifact/v1', executable: '/bin/sh' }, '/tmp/artifact')).toThrow('inside')
  })
})

test('revision fingerprints include dirty and untracked content and runtime', async () => {
  const repo = await temporary()
  await runCommand(['git', 'init', '-q'], { cwd: repo })
  await runCommand(['git', 'config', 'user.email', 'fleet@example.test'], { cwd: repo })
  await runCommand(['git', 'config', 'user.name', 'Fleet Test'], { cwd: repo })
  await writeFile(join(repo, 'tracked'), 'one')
  await runCommand(['git', 'add', '.'], { cwd: repo })
  await runCommand(['git', 'commit', '-qm', 'initial'], { cwd: repo })
  const clean = await dirtyFingerprint(repo)
  expect(clean).toBe(CLEAN_FINGERPRINT)
  await writeFile(join(repo, 'untracked'), 'first')
  const first = await dirtyFingerprint(repo)
  await writeFile(join(repo, 'untracked'), 'second')
  const second = await dirtyFingerprint(repo)
  await chmod(join(repo, 'untracked'), 0o755)
  const executable = await dirtyFingerprint(repo)
  expect(new Set([clean, first, second, executable]).size).toBe(4)
  const revision = await discoverRevision(repo, 'HEAD', join(repo, '.state'))
  expect((await discoverRevision(repo, '.', join(repo, '.state'))).worktree).toBe(repo)
  expect(artifactKey(revision, 'wry')).not.toBe(artifactKey(revision, 'cef'))
  const foreign = await temporary()
  await runCommand(['git', 'init', '-q'], { cwd: foreign })
  await expect(discoverRevision(repo, foreign, join(repo, '.state'))).rejects.toThrow('not a registered worktree')
  await mkdir(join(repo, 'nested'))
  await expect(discoverRevision(repo, join(repo, 'nested'), join(repo, '.state'))).rejects.toThrow('not a registered worktree')
})

test('managed worktrees cannot silently drift from their requested revision', async () => {
  const repo = await temporary()
  const state = await temporary()
  await runCommand(['git', 'init', '-q'], { cwd: repo })
  await runCommand(['git', 'config', 'user.email', 'fleet@example.test'], { cwd: repo })
  await runCommand(['git', 'config', 'user.name', 'Fleet Test'], { cwd: repo })
  await writeFile(join(repo, 'tracked'), 'one')
  await runCommand(['git', 'add', '.'], { cwd: repo })
  await runCommand(['git', 'commit', '-qm', 'one'], { cwd: repo })
  const one = await runCommand(['git', 'rev-parse', 'HEAD'], { cwd: repo }).then((result) => result.stdout.trim())
  await writeFile(join(repo, 'tracked'), 'two')
  await runCommand(['git', 'commit', '-qam', 'two'], { cwd: repo })
  const two = await runCommand(['git', 'rev-parse', 'HEAD'], { cwd: repo }).then((result) => result.stdout.trim())
  const managed = await discoverRevision(repo, one, state)
  await runCommand(['git', 'checkout', '--detach', two], { cwd: managed.worktree })
  await expect(discoverRevision(repo, one, state)).rejects.toThrow('does not match requested revision')
})

test('application roots cannot escape a worktree through symlinks', async () => {
  const worktree = await temporary()
  const outside = await temporary()
  const state = await temporary()
  const artifactDir = await temporary()
  await symlink(outside, join(worktree, 'app'))
  await writeFile(join(worktree, 'file'), '')
  await expect(resolveInsideWorktree(worktree, 'file')).rejects.toThrow('not a directory')
  await expect(resolveInsideWorktree(worktree, 'app')).rejects.toThrow('escapes its worktree')
  const config = { ...CONFIG, application: { ...CONFIG.application, root: 'app' } }
  const revision = { repository: 'test', worktree, commit: 'a'.repeat(40), dirtyFingerprint: CLEAN_FINGERPRINT }
  const artifact = { key: 'b'.repeat(64), dir: artifactDir, manifest: { protocol: 'tauri-agent-artifact/v1' as const, executable: 'app' } }
  await expect(createInstance(config, state, revision, 'wry', artifact)).rejects.toThrow('escapes its worktree')
  expect((await listInstances(state))[0]).toMatchObject({ state: 'failed', processes: [], failure: { class: 'infrastructure_failure' } })
})

test('build cache runs a runtime build once and validates its manifest', async () => {
  const repo = await temporary()
  const state = join(repo, '.fleet')
  const previousProviderKey = process.env.OPENAI_API_KEY
  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY
  const previousClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
  process.env.OPENAI_API_KEY = 'runner-secret'
  process.env.ANTHROPIC_API_KEY = 'anthropic-secret'
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'claude-secret'
  cleanups.push(() => {
    if (previousProviderKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousProviderKey
    if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousAnthropicKey
    if (previousClaudeToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousClaudeToken
  })
  await runCommand(['git', 'init', '-q'], { cwd: repo })
  await runCommand(['git', 'config', 'user.email', 'fleet@example.test'], { cwd: repo })
  await runCommand(['git', 'config', 'user.name', 'Fleet Test'], { cwd: repo })
  await writeFile(join(repo, 'seed'), 'seed')
  await runCommand(['git', 'add', '.'], { cwd: repo })
  await runCommand(['git', 'commit', '-qm', 'initial'], { cwd: repo })
  const revision = await discoverRevision(repo, 'HEAD', state)
  const config: FleetConfig = {
    ...CONFIG,
    runtimes: { default: 'wry', wry: { build: ['bash', '-c', `test -z "\${OPENAI_API_KEY:-}\${ANTHROPIC_API_KEY:-}\${CLAUDE_CODE_OAUTH_TOKEN:-}"; n=$(cat count 2>/dev/null || echo 0); echo $((n+1)) > count; mkdir -p "$FLEET_ARTIFACT_DIR/bin"; printf '#!/usr/bin/env bash\\nexec sleep 30\\n' > "$FLEET_ARTIFACT_DIR/bin/app"; chmod +x "$FLEET_ARTIFACT_DIR/bin/app"; printf '{"protocol":"tauri-agent-artifact/v1","executable":"bin/app"}\\n' > "$FLEET_ARTIFACT_MANIFEST"`] } }
  }
  const first = await buildArtifact(config, state, revision, 'wry')
  const second = await buildArtifact(config, state, revision, 'wry')
  expect(second.key).toBe(first.key)
  expect(await readFile(join(repo, 'count'), 'utf8')).toBe('1\n')
  expect((await readFile(join(first.dir, 'bin/app'), 'utf8')).startsWith('#!')).toBe(true)
  const failed = { ...config, runtimes: { default: 'wry' as const, wry: { build: ['bash', '-c', 'touch "$FLEET_ARTIFACT_DIR/partial"; exit 1'] } } }
  await expect(buildArtifact(failed, state, { ...revision, commit: 'f'.repeat(40) }, 'wry')).rejects.toThrow('exited 1')
  const escapedExecutable = { ...config, runtimes: { default: 'wry' as const, wry: { build: ['bash', '-c', 'mkdir -p "$FLEET_ARTIFACT_DIR/bin"; ln -s /bin/sh "$FLEET_ARTIFACT_DIR/bin/app"; printf \'{"protocol":"tauri-agent-artifact/v1","executable":"bin/app"}\\n\' > "$FLEET_ARTIFACT_MANIFEST"'] } } }
  await expect(buildArtifact(escapedExecutable, state, { ...revision, commit: 'e'.repeat(40) }, 'wry')).rejects.toThrow('valid artifact')
  const escapedCwd = { ...config, runtimes: { default: 'wry' as const, wry: { build: ['bash', '-c', 'mkdir -p "$FLEET_ARTIFACT_DIR/bin"; printf \'#!/bin/sh\\n\' > "$FLEET_ARTIFACT_DIR/bin/app"; chmod +x "$FLEET_ARTIFACT_DIR/bin/app"; ln -s /tmp "$FLEET_ARTIFACT_DIR/outside"; printf \'{"protocol":"tauri-agent-artifact/v1","executable":"bin/app","cwd":"outside"}\\n\' > "$FLEET_ARTIFACT_MANIFEST"'] } } }
  await expect(buildArtifact(escapedCwd, state, { ...revision, commit: 'd'.repeat(40) }, 'wry')).rejects.toThrow('valid artifact')
  const escapedManifest = { ...config, runtimes: { default: 'wry' as const, wry: { build: ['bash', '-c', 'mkdir -p "$FLEET_ARTIFACT_DIR/bin"; printf \'#!/bin/sh\\n\' > "$FLEET_ARTIFACT_DIR/bin/app"; chmod +x "$FLEET_ARTIFACT_DIR/bin/app"; printf \'{"protocol":"tauri-agent-artifact/v1","executable":"bin/app"}\\n\' > outside-manifest.json; ln -s "$PWD/outside-manifest.json" "$FLEET_ARTIFACT_MANIFEST"'] } } }
  await expect(buildArtifact(escapedManifest, state, { ...revision, commit: '1'.repeat(40) }, 'wry')).rejects.toThrow('valid artifact')
  const escapedRoot = { ...config, runtimes: { default: 'wry' as const, wry: { build: ['bash', '-c', 'rm -rf "$FLEET_ARTIFACT_DIR"; mkdir -p outside-artifact/bin; ln -s "$PWD/outside-artifact" "$FLEET_ARTIFACT_DIR"; printf \'#!/bin/sh\\n\' > "$FLEET_ARTIFACT_DIR/bin/app"; chmod +x "$FLEET_ARTIFACT_DIR/bin/app"; printf \'{"protocol":"tauri-agent-artifact/v1","executable":"bin/app"}\\n\' > "$FLEET_ARTIFACT_MANIFEST"'] } } }
  await expect(buildArtifact(escapedRoot, state, { ...revision, commit: '2'.repeat(40) }, 'wry')).rejects.toThrow('valid artifact')
  const stagingLink = { ...config, runtimes: { default: 'wry' as const, wry: { build: ['bash', '-c', 'mkdir -p "$FLEET_ARTIFACT_DIR/bin"; printf \'#!/bin/sh\\n\' > "$FLEET_ARTIFACT_DIR/bin/real"; chmod +x "$FLEET_ARTIFACT_DIR/bin/real"; ln -s "$FLEET_ARTIFACT_DIR/bin/real" "$FLEET_ARTIFACT_DIR/bin/app"; printf \'{"protocol":"tauri-agent-artifact/v1","executable":"bin/app"}\\n\' > "$FLEET_ARTIFACT_MANIFEST"'] } } }
  await expect(buildArtifact(stagingLink, state, { ...revision, commit: 'c'.repeat(40) }, 'wry')).rejects.toThrow('invalid after installation')
  expect((await readdir(join(state, 'artifacts'))).some((name) => name.endsWith('.tmp'))).toBe(false)
})

test('exact teardown does not touch sibling groups or stale PID records', async () => {
  const dir = await temporary()
  const one = await spawnOwned('app', ['bash', '-c', 'exec sleep 30'], { log: join(dir, 'one.log') })
  const two = await spawnOwned('app', ['bash', '-c', 'exec sleep 30'], { log: join(dir, 'two.log') })
  cleanups.push(async () => { await terminateOwned(one, 10); await terminateOwned(two, 10) })
  expect(await processOwned(one)).toBe(true)
  expect(await terminateOwned({ ...one, startTime: `${one.startTime}-stale` }, 10)).toBe(false)
  expect(await terminateOwned({ ...one, pgid: 0 }, 10)).toBe(false)
  expect(await processOwned(one)).toBe(true)
  expect(await terminateOwned(one, 200)).toBe(true)
  expect(await processOwned(one)).toBe(false)
  expect(await processOwned(two)).toBe(true)
})

test('instance cleanup hook reaps an exact app-owned process group', async () => {
  const dir = await temporary()
  const worktree = join(dir, 'worktree')
  const home = join(dir, 'state', 'instances', 'cleanup', 'home')
  await Promise.all([mkdir(worktree), privateDir(home)])
  const managed = await spawnOwned('app', ['bash', '-c', 'exec sleep 30'], { log: join(dir, 'managed.log') })
  const sidecar = await spawnOwned('app', ['bash', '-c', 'exec sleep 30'], { log: join(dir, 'sidecar.log') })
  cleanups.push(async () => { await terminateOwned(managed, 10); await terminateOwned(sidecar, 10) })
  await Promise.all([
    writeFile(join(home, 'managed.pid'), String(managed.pid)),
    writeFile(join(home, 'sidecar.pid'), String(sidecar.pgid)),
    writeFile(join(worktree, 'cleanup.sh'), `#!/usr/bin/env bash
set -euo pipefail
managed="$(cat "$FLEET_HOME/managed.pid")"
sidecar="$(cat "$FLEET_HOME/sidecar.pid")"
! kill -0 "$managed" 2>/dev/null
kill -TERM -- "-$sidecar"
for _ in $(seq 1 100); do kill -0 -- "-$sidecar" 2>/dev/null || break; sleep .01; done
! kill -0 -- "-$sidecar" 2>/dev/null
printf '%s\n' "$FLEET_INSTANCE_ID|$FLEET_RUNTIME|$FLEET_ARTIFACT_DIR" > "$FLEET_HOME/cleanup.marker"
`)
  ])
  const root = join(dir, 'state')
  const instance = fakeInstance(root, [managed], {
    id: 'cleanup',
    revision: { repository: 'test', worktree, commit: 'd'.repeat(40), dirtyFingerprint: CLEAN_FINGERPRINT },
    directories: { root: dirname(home), home, runtime: join(dirname(home), 'runtime'), data: join(dirname(home), 'data'), artifacts: join(dirname(home), 'artifacts') }
  })
  const config: FleetConfig = { ...CONFIG, lifecycle: { cleanupInstance: ['bash', 'cleanup.sh'] } }
  await stopInstance(config, root, instance)
  expect(await processOwned(managed)).toBe(false)
  expect(await processOwned(sidecar)).toBe(false)
  expect(await readFile(join(home, 'cleanup.marker'), 'utf8')).toBe(`cleanup|wry|${join(root, 'artifacts', instance.artifactKey)}\n`)
  expect((await listInstances(root))[0]?.state).toBe('stopped')
})

test('cleanup hook failure persists infrastructure evidence', async () => {
  const dir = await temporary()
  const root = join(dir, 'state')
  const worktree = join(dir, 'worktree')
  const home = join(root, 'instances', 'cleanup-failure', 'home')
  await Promise.all([mkdir(worktree), privateDir(home)])
  const managed = await spawnOwned('app', ['bash', '-c', 'exec sleep 30'], { log: join(dir, 'managed.log') })
  cleanups.push(async () => { await terminateOwned(managed, 10) })
  const instance = fakeInstance(root, [managed], {
    id: 'cleanup-failure',
    revision: { repository: 'test', worktree, commit: 'd'.repeat(40), dirtyFingerprint: CLEAN_FINGERPRINT },
    directories: { root: dirname(home), home, runtime: join(dirname(home), 'runtime'), data: join(dirname(home), 'data'), artifacts: join(dirname(home), 'artifacts') }
  })
  await expect(stopInstance({ ...CONFIG, lifecycle: { cleanupInstance: ['false'] } }, root, instance)).rejects.toThrow('exited 1')
  expect(await processOwned(managed)).toBe(false)
  expect((await listInstances(root))[0]).toMatchObject({
    state: 'failed', failure: { class: 'infrastructure_failure', message: expect.stringContaining('instance teardown failed') }
  })
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
  expect(await processIdentity(childPid)).toBeUndefined()
})

test('teardown terminates an orphaned owned process group', async () => {
  const dir = await temporary()
  const childFile = join(dir, 'orphan.pid')
  const record = await spawnOwned('app', ['bash', '-c', `(trap '' TERM; echo "$BASHPID" > "$CHILD_PID_FILE"; exec sleep 30) & sleep .2`], {
    env: { ...process.env, CHILD_PID_FILE: childFile }, log: join(dir, 'orphan.log')
  })
  cleanups.push(() => { try { process.kill(-record.pgid, 'SIGKILL') } catch { /* already gone */ } })
  let childPid = 0
  await waitFor(async () => {
    try { childPid = Number(await readFile(childFile, 'utf8')); return childPid > 0 && !await processIdentity(record.pid) } catch { return false }
  }, 1_000, 'orphaned process group')
  expect(await terminateOwned(record, 50)).toBe(true)
  expect(await processIdentity(childPid)).toBeUndefined()
})

test('refresh expires an incomplete boot and tears down its exact processes', async () => {
  const root = await temporary()
  const app = await spawnOwned('app', ['bash', '-c', 'exec sleep 30'], { log: join(root, 'partial.log') })
  cleanups.push(async () => { await terminateOwned(app, 10) })
  const instance = fakeInstance(root, [app], { state: 'booting', updatedAt: new Date(Date.now() - 61_000).toISOString() })
  await saveInstance(root, instance)
  instance.updatedAt = new Date(Date.now() - 61_000).toISOString()
  await writeFile(join(instance.directories.root, 'instance.json'), JSON.stringify(instance))
  const observed = await refreshInstance(CONFIG, root, instance, false)
  expect(observed.state).toBe('failed')
  expect(await processOwned(app)).toBe(true)
  expect((await listInstances(root))[0]?.state).toBe('booting')
  const refreshed = await refreshInstance(CONFIG, root, (await listInstances(root))[0]!)
  expect(refreshed.state).toBe('failed')
  expect(refreshed.failure).toEqual({ class: 'infrastructure_failure', message: 'instance process set is incomplete' })
  expect(await processOwned(app)).toBe(false)
})

test('startup failures persist infrastructure evidence without a live process', async () => {
  const root = await temporary()
  const worktree = await temporary()
  const artifactDir = await temporary()
  const previous = process.env.FLEET_XVFB_COMMAND
  process.env.FLEET_XVFB_COMMAND = join(root, 'missing-xvfb')
  cleanups.push(() => {
    if (previous === undefined) delete process.env.FLEET_XVFB_COMMAND
    else process.env.FLEET_XVFB_COMMAND = previous
  })
  const revision = { repository: 'test', worktree, commit: 'a'.repeat(40), dirtyFingerprint: CLEAN_FINGERPRINT }
  const artifact = { key: 'b'.repeat(64), dir: artifactDir, manifest: { protocol: 'tauri-agent-artifact/v1' as const, executable: 'app' } }
  await expect(createInstance(CONFIG, root, revision, 'wry', artifact)).rejects.toThrow('ENOENT')
  const [failed] = await listInstances(root)
  expect(failed).toMatchObject({ state: 'failed', processes: [], failure: { class: 'infrastructure_failure' } })
  expect(failed?.failure?.message).toContain('missing-xvfb')
})

test('parallel same-artifact instances isolate slots, state, endpoints, and teardown', async () => {
  const dir = await temporary()
  const root = join(dir, 'state')
  const artifactDir = join(dir, 'artifact')
  await mkdir(artifactDir)
  const xvfb = join(dir, 'fake xvfb')
  const vnc = join(dir, 'fake vnc')
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
  for (const line of data.toString().trim().split('\\n')) { const request = JSON.parse(line); attaches += 1; socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { attached: true, windows: attaches > 1 ? [{ label: 'main' }] : [], capabilities: { runtime: process.env.FLEET_RUNTIME, home: process.env.HOME, state: process.env.XDG_STATE_HOME, display: process.env.DISPLAY, custom: process.env.CUSTOM, providerKey: process.env.OPENAI_API_KEY ?? null, anthropicKey: process.env.ANTHROPIC_API_KEY ?? null, claudeToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, fleetState: process.env.FLEET_STATE_DIR ?? null } } }) + '\\n') }
} } })
writeFileSync(join(dir, 'endpoint.json'), JSON.stringify({ appId: 'com.example.app', pid: process.pid, transport: 'unix', path, token: 'private-agent-token' }), { mode: 0o600 })
process.on('SIGTERM', () => { server.stop(true); process.exit(0) })
`)
  await Promise.all([xvfb, vnc, app].map((path) => chmod(path, 0o700)))
  const oldXvfb = process.env.FLEET_XVFB_COMMAND
  const oldVnc = process.env.FLEET_VNC_COMMAND
  const oldProviderKey = process.env.OPENAI_API_KEY
  const oldAnthropicKey = process.env.ANTHROPIC_API_KEY
  const oldClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
  process.env.FLEET_XVFB_COMMAND = xvfb
  process.env.FLEET_VNC_COMMAND = vnc
  process.env.OPENAI_API_KEY = 'runner-secret'
  process.env.ANTHROPIC_API_KEY = 'anthropic-secret'
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'claude-secret'
  cleanups.push(() => {
    if (oldXvfb === undefined) delete process.env.FLEET_XVFB_COMMAND
    else process.env.FLEET_XVFB_COMMAND = oldXvfb
    if (oldVnc === undefined) delete process.env.FLEET_VNC_COMMAND
    else process.env.FLEET_VNC_COMMAND = oldVnc
    if (oldProviderKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = oldProviderKey
    if (oldAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = oldAnthropicKey
    if (oldClaudeToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = oldClaudeToken
  })
  const worktreeOne = join(dir, 'worktree-one')
  const worktreeTwo = join(dir, 'worktree-two')
  await Promise.all([mkdir(worktreeOne), mkdir(worktreeTwo)])
  const revision = { repository: 'test', worktree: worktreeOne, commit: 'd'.repeat(40), dirtyFingerprint: 'e'.repeat(64) }
  const artifact = { key: 'f'.repeat(64), dir: artifactDir, manifest: { protocol: 'tauri-agent-artifact/v1' as const, executable: 'app', env: { HOME: '/escape', XDG_STATE_HOME: '/escape', DISPLAY: ':1', CUSTOM: 'yes' } } }
  const [one, two] = await Promise.all([
    createInstance(CONFIG, root, revision, 'wry', artifact, 'one'),
    createInstance(CONFIG, root, revision, 'wry', artifact, 'two')
  ])
  cleanups.push(async () => { await stopInstance(CONFIG, root, one); await stopInstance(CONFIG, root, two) })
  expect(one.artifactKey).toBe(two.artifactKey)
  expect(one.slot).not.toBe(two.slot)
  expect(one.display).not.toBe(two.display)
  expect(one.vncPort).not.toBe(two.vncPort)
  expect(one.appPort).not.toBe(two.appPort)
  expect(one.directories.home).not.toBe(two.directories.home)
  expect(one.directories.runtime).not.toBe(two.directories.runtime)
  expect(one.directories.data).not.toBe(two.directories.data)
  expect((await stat(one.directories.home)).mode & 0o777).toBe(0o700)
  expect((await stat(one.directories.runtime)).mode & 0o777).toBe(0o700)
  expect((await stat(one.directories.data)).mode & 0o777).toBe(0o700)
  expect(one.vncToken).not.toBe(two.vncToken)
  const [oneDescriptor, twoDescriptor] = await Promise.all([
    readEndpointRegistry(CONFIG.application.id, { env: { XDG_RUNTIME_DIR: one.directories.runtime } }),
    readEndpointRegistry(CONFIG.application.id, { env: { XDG_RUNTIME_DIR: two.directories.runtime } })
  ])
  if (oneDescriptor.transport !== 'unix' || twoDescriptor.transport !== 'unix') throw new Error('expected Unix endpoints')
  expect(oneDescriptor.path).not.toBe(twoDescriptor.path)
  expect(await readFile(join(one.directories.root, 'instance.json'), 'utf8')).not.toContain('private-agent-token')
  expect((one.endpoint?.capabilities as { capabilities: { home: string; state: string; display: string; custom: string; runtime: string; providerKey: string | null; anthropicKey: string | null; claudeToken: string | null; fleetState: string | null } }).capabilities).toEqual({
    home: one.directories.home, state: join(one.directories.home, '.local', 'state'), display: one.display, custom: 'yes', runtime: 'wry', providerKey: null, anthropicKey: null, claudeToken: null, fleetState: null
  })
  two.state = 'booting'
  delete two.endpoint
  await saveInstance(root, two)
  const recovered = await refreshInstance(CONFIG, root, two)
  expect(recovered.state).toBe('ready')
  expect(recovered.endpoint?.healthy).toBe(true)
  const stableUpdatedAt = recovered.updatedAt
  await Bun.sleep(2)
  expect((await refreshInstance(CONFIG, root, recovered)).updatedAt).toBe(stableUpdatedAt)
  const cefArtifact = { ...artifact, key: '9'.repeat(64) }
  const cef = await createInstance(CONFIG, root, { ...revision, worktree: worktreeTwo, commit: '8'.repeat(40) }, 'cef', cefArtifact, 'cef')
  cleanups.push(async () => { await stopInstance(CONFIG, root, cef) })
  expect(cef.state).toBe('ready')
  expect(cef.variant).toBe('cef')
  expect(cef.revision.worktree).not.toBe(one.revision.worktree)
  expect((cef.endpoint?.capabilities as { capabilities: { runtime: string } }).capabilities.runtime).toBe('cef')
  await terminateOwned(one.processes.find((item) => item.name === 'app')!, 50)
  expect((await refreshInstance(CONFIG, root, one)).state).toBe('failed')
  expect((await Promise.all(one.processes.map(processOwned))).every((alive) => !alive)).toBe(true)
  expect(await processOwned(two.processes.find((item) => item.name === 'app')!)).toBe(true)

  const schedulerRoot = join(dir, 'scheduler-state')
  const schedulerConfig: FleetConfig = {
    ...CONFIG,
    lifecycle: { cleanupInstance: ['bash', '-c', 'touch "$FLEET_HOME/cleaned"'] },
    runtimes: { default: 'wry', wry: { build: ['bash', '-c', `install -m 755 '${app}' "$FLEET_ARTIFACT_DIR/app"; printf '{"protocol":"tauri-agent-artifact/v1","executable":"app"}\\n' > "$FLEET_ARTIFACT_MANIFEST"`] } }
  }
  const suites: Suite[] = ['first', 'second'].map((id) => ({
    protocol: 'tauri-agent-suite/v1', id, objective: `Pass ${id}`,
    pass: [{ expect: { role: 'button', name: 'Ready' } }], budget: { steps: 1, seconds: 5 }
  }))
  await expect(runSuites(schedulerConfig, schedulerRoot, revision, suites, { jobs: 0 })).rejects.toThrow('positive safe integer')
  const scheduled = await runSuites(schedulerConfig, schedulerRoot, revision, suites, {
    jobs: 2, nextAction: async () => { throw new Error('initial assertion should pass') }
  })
  expect(new Set(scheduled.map((item) => item.run?.suite))).toEqual(new Set(['first', 'second']))
  expect(new Set(scheduled.map((item) => item.artifactKey)).size).toBe(1)
  expect(scheduled.every((item) => item.state === 'passed')).toBe(true)
  expect((await Promise.all(scheduled.map((item) => Bun.file(join(item.directories.home, 'cleaned')).exists()))).every(Boolean)).toBe(true)
  expect((await Promise.all(scheduled.flatMap((item) => item.processes).map(processOwned))).every((alive) => !alive)).toBe(true)
})

test('dashboard validates opaque routes and forwards binary VNC traffic', async () => {
  const dir = await temporary()
  const assets = join(dir, 'assets')
  const root = join(dir, 'state')
  await mkdir(assets)
  await writeFile(join(assets, 'index.html'), 'fleet dashboard')
  const port = await freePort()
  const vncScript = join(dir, 'vnc')
  await writeFile(vncScript, `#!/usr/bin/env bun
const server = Bun.listen({ hostname: '127.0.0.1', port: Number(Bun.argv[2]), socket: { data(socket, data) { socket.write(data) } } })
process.on('SIGTERM', () => { server.stop(true); process.exit(0) })
`)
  await chmod(vncScript, 0o700)
  const vnc = await spawnOwned('vnc', [vncScript, String(port)], { log: join(dir, 'vnc.log') })
  cleanups.push(async () => { await terminateOwned(vnc, 50) })
  await waitFor(() => portOpen(port), 1_000, 'test VNC port')
  const token = 'A'.repeat(32)
  const instance = fakeInstance(root, [vnc], {
    state: 'booting',
    vncPort: port,
    vncToken: token,
    endpoint: { healthy: false, descriptor: { token: 'legacy-agent-token' } } as NonNullable<InstanceRecord['endpoint']>,
    run: {
      id: 'run-1', suite: 'smoke', objective: 'Open the application', step: 2,
      startedAt: new Date(Date.now() - 1_000).toISOString(), budget: { steps: 3, seconds: 30, tokens: 1000 },
      inputTokens: 90, outputTokens: 10, cost: 0.001
    }
  })
  const stopped = fakeInstance(root, [], {
    id: 'stopped', vncPort: port, vncToken: 'B'.repeat(32), state: 'stopped',
    failure: { class: 'infrastructure_failure', message: 'x'.repeat(9_000) }
  })
  await saveInstance(root, instance)
  await saveInstance(root, stopped)
  const beforeDashboard = instance.updatedAt
  await mkdir(join(root, 'instances', 'mismatch'))
  await writeFile(join(root, 'instances', 'mismatch', 'instance.json'), JSON.stringify(fakeInstance(root, [], { id: 'different' })))
  await mkdir(join(root, 'instances', 'future'))
  await writeFile(join(root, 'instances', 'future', 'instance.json'), JSON.stringify({ schemaVersion: 2, id: 'future' }))
  const listed = await listInstances(root)
  expect(listed.some((item) => item.id === 'different')).toBe(false)
  expect(listed.some((item) => item.id === 'future')).toBe(false)
  await mkdir(join(instance.directories.artifacts, 'run-1'), { recursive: true })
  await writeFile(join(instance.directories.artifacts, 'run-1', 'run.json'), 'run artifact')
  const web = startDashboard({ root, assets, config: CONFIG, host: '127.0.0.1', port: 0 })
  cleanups.push(() => web.stop(true))
  const page = await fetch(new URL('/', web.url))
  expect(await page.text()).toBe('fleet dashboard')
  expect(page.headers.get('content-security-policy')).toContain("default-src 'self'")
  const state = await (await fetch(new URL('/api/v1/fleet', web.url))).text()
  expect(state).not.toContain('legacy-agent-token')
  expect(state).not.toContain('directories')
  expect(state).not.toContain('processes')
  expect(state).not.toContain('vncPort')
  expect(Object.keys(JSON.parse(state))).toEqual(['protocol', 'generatedAt', 'summary', 'instances'])
  expect(JSON.parse(state).summary).toMatchObject({ total: 2, live: 1, tokens: 100, cost: 0.001 })
  const publicInstance = JSON.parse(state).instances.find((item: { id: string }) => item.id === instance.id)
  expect(Object.keys(publicInstance)).toEqual(['id', 'state', 'runtime', 'revision', 'display', 'agent', 'vnc', 'run'])
  expect(publicInstance.revision).toEqual({ commit: 'a'.repeat(40), dirty: true })
  const publicFailure = JSON.parse(state).instances.find((item: { id: string }) => item.id === stopped.id).failure
  expect(publicFailure.class).toBe('infrastructure_failure')
  expect(publicFailure.message).toHaveLength(8 * 1024)
  expect(publicFailure.message.endsWith('…')).toBe(true)
  const publicRun = publicInstance.run
  expect(publicRun.progress).toMatchObject({ step: 2, stepLimit: 3, timeLimitMs: 30_000, tokenLimit: 1000 })
  expect(Object.keys(publicRun.artifacts)).toEqual(['run'])
  const artifactResponse = await fetch(new URL('/api/v1/instances/' + instance.id + '/runs/run-1/artifacts/run.json', web.url))
  expect(artifactResponse.headers.get('content-type')).toContain('application/json')
  expect(await artifactResponse.text()).toBe('run artifact')
  expect((await fetch(new URL('/api/v1/instances/' + instance.id + '/runs/other/artifacts/run.json', web.url))).status).toBe(404)
  const escaped = fakeInstance(root, [], {
    id: 'escaped', state: 'stopped',
    run: { id: 'run-2', suite: 'escape', objective: 'Escape', step: 0, startedAt: new Date().toISOString(), budget: { steps: 1, seconds: 1 }, inputTokens: 0, outputTokens: 0 }
  })
  await saveInstance(root, escaped)
  await mkdir(join(dir, 'outside', 'run-2'), { recursive: true })
  await writeFile(join(dir, 'outside', 'run-2', 'run.json'), 'private')
  await symlink(join(dir, 'outside'), escaped.directories.artifacts)
  expect((await fetch(new URL('/api/v1/instances/escaped/runs/run-2/artifacts/run.json', web.url))).status).toBe(403)
  expect((await fetch(new URL('/api/state', web.url))).status).toBe(404)
  const persisted = await readFile(join(instance.directories.root, 'instance.json'), 'utf8')
  expect(persisted).not.toContain('legacy-agent-token')
  expect(JSON.parse(persisted).updatedAt).toBe(beforeDashboard)
  expect((await fetch(new URL('/api/v1/vnc/branch-name', web.url))).status).toBe(404)
  expect((await fetch(new URL(`/api/v1/vnc/${stopped.vncToken}`, web.url))).status).toBe(404)
  const echoed = await new Promise<number[]>((resolve, reject) => {
    const ws = new WebSocket(new URL(`/api/v1/vnc/${token}`, web.url).toString().replace('http:', 'ws:'))
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => ws.send(Uint8Array.of(0, 1, 2, 255))
    ws.onerror = () => reject(new Error('websocket failed'))
    ws.onmessage = ({ data }) => { ws.close(); resolve([...new Uint8Array(data as ArrayBuffer)]) }
  })
  expect(echoed).toEqual([0, 1, 2, 255])
})

test('Codex provider replaces built-in instructions and pins Spark low without model tools', async () => {
  const dir = await temporary()
  const command = join(dir, 'codex')
  const capture = join(dir, 'capture.json')
  await writeFile(command, `#!/usr/bin/env bun
const input = await Bun.stdin.text()
const args = Bun.argv.slice(2)
const config = args.find((arg) => arg.startsWith('model_instructions_file='))
const instructions = config ? await Bun.file(JSON.parse(config.slice(config.indexOf('=') + 1))).text() : null
await Bun.write(process.env.CODEX_CAPTURE, JSON.stringify({ args, input, instructions, apiKey: process.env.OPENAI_API_KEY ?? null, anthropicKey: process.env.ANTHROPIC_API_KEY ?? null, claudeToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null }))
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'type: wait\\nmilliseconds: 1' } }))
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 9000, output_tokens: 100 } }))
`)
  await chmod(command, 0o700)
  const previous = { ...process.env }
  process.env.FLEET_MODEL_PROVIDER = 'codex'
  process.env.CODEX_COMMAND = command
  process.env.CODEX_CAPTURE = capture
  process.env.OPENAI_API_KEY = 'must-not-reach-codex'
  process.env.ANTHROPIC_API_KEY = 'must-not-reach-codex'
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'must-not-reach-codex'
  delete process.env.CODEX_MODEL
  delete process.env.CODEX_REASONING_EFFORT
  cleanups.push(() => {
    for (const key of ['FLEET_MODEL_PROVIDER', 'CODEX_COMMAND', 'CODEX_CAPTURE', 'CODEX_MODEL', 'CODEX_REASONING_EFFORT', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  })
  const decision = await modelAction({ objective: 'Wait', pass: [{ expect: { role: 'button', name: 'Ready' } }], observation: {}, remaining: { steps: 1, seconds: 5 } })
  expect(decision).toEqual({ action: { type: 'wait', milliseconds: 1 }, usage: { inputTokens: 9000, outputTokens: 100 } })
  let invocation = JSON.parse(await readFile(capture, 'utf8')) as { args: string[]; input: string; instructions: string; apiKey: string | null; anthropicKey: string | null; claudeToken: string | null }
  expect(invocation.args).toContain('gpt-5.3-codex-spark')
  expect(invocation.args).toContain('model_reasoning_effort="low"')
  expect(invocation.args.some((arg) => arg.startsWith('model_instructions_file='))).toBe(true)
  expect(invocation.args).toContain('web_search="disabled"')
  expect(invocation.args).not.toContain('--output-schema')
  expect(invocation.args).toContain('shell_tool')
  expect(invocation.instructions).toContain('Return only one TOON object')
  expect(invocation.instructions).toContain('no JSON')
  expect(invocation.input).toStartWith('objective: Wait\npass[1]:')
  expect(decodeInstruction(invocation.input)).toEqual({ objective: 'Wait', pass: [{ expect: { role: 'button', name: 'Ready' } }], observation: {}, remaining: { steps: 1, seconds: 5 } })
  expect(invocation.apiKey).toBeNull()
  expect(invocation.anthropicKey).toBeNull()
  expect(invocation.claudeToken).toBeNull()
  process.env.CODEX_MODEL = 'gpt-5.6-luna'
  await modelAction({ objective: 'Wait', pass: [{ expect: { role: 'button', name: 'Ready' } }], observation: {}, remaining: { steps: 1, seconds: 5 } })
  invocation = JSON.parse(await readFile(capture, 'utf8')) as typeof invocation
  expect(invocation.args).toContain('gpt-5.6-luna')
  expect(invocation.args).toContain('model_reasoning_effort="medium"')
})

test('Claude provider uses subscription auth, TOON output, and no tools', async () => {
  const dir = await temporary()
  const command = join(dir, 'claude')
  const capture = join(dir, 'capture.json')
  await writeFile(command, `#!/usr/bin/env bun
const input = await Bun.stdin.text()
await Bun.write(process.env.CLAUDE_CAPTURE, JSON.stringify({ args: Bun.argv.slice(2), input, apiKey: process.env.ANTHROPIC_API_KEY ?? null, openAIKey: process.env.OPENAI_API_KEY ?? null }))
console.log(JSON.stringify({
  type: 'result', result: 'type: wait\\nmilliseconds: 1',
  modelUsage: { claude: { inputTokens: 10, cacheReadInputTokens: 20, cacheCreationInputTokens: 30, outputTokens: 2, costUSD: 0.01 } }
}))
`)
  await chmod(command, 0o700)
  const previous = { ...process.env }
  process.env.FLEET_MODEL_PROVIDER = 'claude'
  process.env.CLAUDE_COMMAND = command
  process.env.CLAUDE_CAPTURE = capture
  delete process.env.CLAUDE_MODEL
  delete process.env.CLAUDE_EFFORT
  process.env.ANTHROPIC_API_KEY = 'must-not-reach-claude'
  process.env.OPENAI_API_KEY = 'must-not-reach-claude'
  cleanups.push(() => {
    for (const key of ['FLEET_MODEL_PROVIDER', 'CLAUDE_COMMAND', 'CLAUDE_CAPTURE', 'CLAUDE_MODEL', 'CLAUDE_EFFORT', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  })
  const decision = await modelAction({ objective: 'Wait', pass: [{ expect: { role: 'button', name: 'Ready' } }], observation: {}, remaining: { steps: 1, seconds: 5 } })
  expect(decision).toEqual({ action: { type: 'wait', milliseconds: 1 }, usage: { inputTokens: 60, outputTokens: 2, cost: 0.01 } })
  const invocation = JSON.parse(await readFile(capture, 'utf8')) as { args: string[]; input: string; apiKey: string | null; openAIKey: string | null }
  expect(invocation.args).toContain('haiku')
  expect(invocation.args).toContain('low')
  expect(invocation.args).not.toContain('--json-schema')
  expect(invocation.args).toContain('--system-prompt')
  expect(invocation.args[invocation.args.indexOf('--tools') + 1]).toBe('')
  expect(invocation.input).toStartWith('objective: Wait\npass[1]:')
  expect(decodeInstruction(invocation.input)).toEqual({ objective: 'Wait', pass: [{ expect: { role: 'button', name: 'Ready' } }], observation: {}, remaining: { steps: 1, seconds: 5 } })
  expect(invocation.apiKey).toBeNull()
  expect(invocation.openAIKey).toBeNull()
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

async function runnerHarness(): Promise<{ root: string; instance: InstanceRecord; disconnect: () => Promise<void>; close: () => Promise<void> }> {
  const root = await temporary()
  const instanceBase = join(root, 'instances', 'runner')
  const runtime = join(instanceBase, 'runtime')
  const artifacts = join(instanceBase, 'artifacts')
  await privateDir(runtime)
  await privateDir(artifacts)
  const processRecord = await spawnOwned('app', ['bash', '-c', 'exec sleep 30'], { log: join(instanceBase, 'app.log') })
  const descriptor = createEndpointDescriptor({ appId: CONFIG.application.id, pid: processRecord.pid, env: { XDG_RUNTIME_DIR: runtime } })
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
  let connected = true
  const disconnect = async () => {
    if (!connected) return
    connected = false
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return {
    root,
    instance,
    disconnect,
    close: async () => { await disconnect(); await terminateOwned(processRecord, 50) }
  }
}

const UNREACHABLE: Suite['pass'] = [{ expect: { role: 'textbox', name: 'Never here', value: 'done' } }]

test('real bridge expectation mismatches remain deterministic false conditions', async () => {
  const client = {
    call: async () => {
      throw Object.assign(new Error('live bridge unavailable: expect: value "" != "notes.md"'), { code: 'BRIDGE_UNAVAILABLE' })
    }
  } as unknown as Parameters<typeof conditionMet>[0]
  expect(await conditionMet(client, { expect: { role: 'textbox', name: 'Document name', value: 'notes.md' } })).toBe(false)
})

test('mock-model run passes by deterministic assertion and persists lean artifacts', async () => {
  const harness = await runnerHarness()
  cleanups.push(harness.close)
  const suite: Suite = { protocol: 'tauri-agent-suite/v1', id: 'save', objective: 'Rename the document', pass: [{ expect: { role: 'textbox', name: 'Document name', value: 'notes.md' } }], budget: { steps: 3, seconds: 5 } }
  const mock: NextAction = async () => ({ action: { type: 'fill', role: 'textbox', name: 'Document name', value: 'notes.md' }, usage: { inputTokens: 10, outputTokens: 2 } })
  const result = await runSuite(harness.root, CONFIG.application.id, harness.instance, suite, mock)
  expect(result.state).toBe('passed')
  expect(result.run?.inputTokens).toBe(10)
  const dir = join(result.directories.artifacts, result.run!.id)
  expect((await readFile(join(dir, 'actions.jsonl'), 'utf8')).split('\n').filter(Boolean)).toHaveLength(1)
  const run = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8'))
  expect((await stat(join(dir, 'run.json'))).mode & 0o777).toBe(0o600)
  expect((await stat(join(dir, 'actions.jsonl'))).mode & 0o777).toBe(0o600)
  expect(run).toMatchObject({ protocol: 'tauri-agent-run/v1', state: 'passed' })
  expect(run.finishedAt).toBe(run.run.finishedAt)
})

test('app timeouts, invalid usage, and repeated model actions have distinct failure classes', async () => {
  const appHarness = await runnerHarness()
  cleanups.push(appHarness.close)
  const wait: NextAction = async () => await new Promise<never>(() => {})
  const appSuite: Suite = { protocol: 'tauri-agent-suite/v1', id: 'app-timeout', objective: 'Impossible', pass: UNREACHABLE, budget: { steps: 5, seconds: 1, repetitions: 5 } }
  const started = Date.now()
  const appResult = await runSuite(appHarness.root, CONFIG.application.id, appHarness.instance, appSuite, wait)
  expect(appResult.run?.failure).toBe('app_failure')
  expect(Date.now() - started).toBeLessThan(2_000)

  const exitHarness = await runnerHarness()
  cleanups.push(exitHarness.close)
  const exit: NextAction = async () => {
    await terminateOwned(exitHarness.instance.processes[0]!, 50)
    return { action: { type: 'wait', milliseconds: 1 }, usage: { inputTokens: 1, outputTokens: 1 } }
  }
  const exitResult = await runSuite(exitHarness.root, CONFIG.application.id, exitHarness.instance, { ...appSuite, id: 'app-exit', budget: { ...appSuite.budget, seconds: 5 } }, exit)
  expect(exitResult.run).toMatchObject({ failure: 'app_failure', message: 'application exited' })

  const usageHarness = await runnerHarness()
  cleanups.push(usageHarness.close)
  const invalidUsage: NextAction = async () => ({ action: { type: 'wait', milliseconds: 1 }, usage: { inputTokens: -1, outputTokens: 1 } })
  const usageResult = await runSuite(usageHarness.root, CONFIG.application.id, usageHarness.instance, { ...appSuite, id: 'invalid-usage', budget: { ...appSuite.budget, seconds: 5 } }, invalidUsage)
  expect(usageResult.run).toMatchObject({ failure: 'runner_failure', inputTokens: 0, outputTokens: 0 })

  const overflowHarness = await runnerHarness()
  cleanups.push(overflowHarness.close)
  let usageCall = 0
  const overflowingUsage: NextAction = async () => ({
    action: { type: 'wait', milliseconds: 1 },
    usage: { inputTokens: usageCall++ === 0 ? Number.MAX_SAFE_INTEGER : 1, outputTokens: 0 }
  })
  const overflowResult = await runSuite(overflowHarness.root, CONFIG.application.id, overflowHarness.instance, { ...appSuite, id: 'overflow-usage', budget: { ...appSuite.budget, seconds: 5 } }, overflowingUsage)
  expect(overflowResult.run).toMatchObject({ failure: 'runner_failure', inputTokens: Number.MAX_SAFE_INTEGER, message: 'model usage token totals exceed safe integer range' })

  const infrastructureHarness = await runnerHarness()
  cleanups.push(infrastructureHarness.close)
  const disconnect: NextAction = async () => {
    await infrastructureHarness.disconnect()
    return { action: { type: 'click', role: 'button', name: 'Missing' }, usage: { inputTokens: 1, outputTokens: 1 } }
  }
  const infrastructureResult = await runSuite(infrastructureHarness.root, CONFIG.application.id, infrastructureHarness.instance, { ...appSuite, id: 'transport-failure', budget: { ...appSuite.budget, seconds: 5 } }, disconnect)
  expect(infrastructureResult.run?.failure).toBe('infrastructure_failure')

  const runnerHarnessValue = await runnerHarness()
  cleanups.push(runnerHarnessValue.close)
  const repeat: NextAction = async () => ({ action: { type: 'wait', milliseconds: 1 }, usage: { inputTokens: 1, outputTokens: 1 } })
  const runnerSuite: Suite = { protocol: 'tauri-agent-suite/v1', id: 'runner-repeat', objective: 'Impossible', pass: UNREACHABLE, budget: { steps: 5, seconds: 5, repetitions: 1 } }
  const runnerResult = await runSuite(runnerHarnessValue.root, CONFIG.application.id, runnerHarnessValue.instance, runnerSuite, repeat)
  expect(runnerResult.run?.failure).toBe('runner_failure')
  expect(await readFile(join(runnerResult.directories.artifacts, runnerResult.run!.id, 'failure.png'))).not.toHaveLength(0)
})
