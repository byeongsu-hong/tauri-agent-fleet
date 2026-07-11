import { randomBytes } from 'node:crypto'
import { access } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { attachAgent } from './agent.ts'
import type { Artifact } from './build.ts'
import { runCommand } from './command.ts'
import { freePort, portOpen, waitFor } from './network.ts'
import { processOwned, spawnOwned, terminateAll } from './process.ts'
import { resolveInsideWorktree } from './revision.ts'
import { listInstances, privateDir, saveInstance, withLock } from './storage.ts'
import type { FleetConfig, InstanceRecord, Revision, RuntimeVariant } from './types.ts'

const ACTIVE = new Set(['booting', 'ready', 'running'])

async function failInstance(
  config: FleetConfig,
  root: string,
  instance: InstanceRecord,
  failure: NonNullable<InstanceRecord['failure']>,
  persist: boolean
): Promise<void> {
  let teardownFailure: unknown
  const update = async () => {
    instance.state = 'failed'
    instance.failure = failure
    instance.endpoint = { ...instance.endpoint, healthy: false }
    if (persist) await saveInstance(root, instance)
  }
  if (!persist) return await update()
  try { await teardownInstance(config, root, instance) } catch (error) {
    teardownFailure = error
    failure = { ...failure, message: `${failure.message}; teardown failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  await update()
  if (teardownFailure) throw teardownFailure
}

function safeId(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  return slug || 'instance'
}

async function nextAllocation(root: string): Promise<{ slot: number; vncPort: number; appPort: number }> {
  const active = (await listInstances(root)).filter((item) => ACTIVE.has(item.state))
  const used = new Set(active.map((item) => item.slot))
  let slot = 0
  while (used.has(slot) || await displayExists(90 + slot)) slot++
  const ports = new Set(active.flatMap((item) => [item.vncPort, item.appPort]))
  const vncPort = await freePort(ports)
  ports.add(vncPort)
  return { slot, vncPort, appPort: await freePort(ports) }
}

async function displayExists(display: number): Promise<boolean> {
  try { await access(`/tmp/.X11-unix/X${display}`); return true } catch { return false }
}

export async function createInstance(
  config: FleetConfig,
  root: string,
  revision: Revision,
  variant: RuntimeVariant,
  artifact: Artifact,
  requestedId?: string
): Promise<InstanceRecord> {
  const instance = await withLock(join(root, '.instance-allocation.lock'), async () => {
    const { slot, vncPort, appPort } = await nextAllocation(root)
    const id = `${safeId(requestedId ?? revision.branch ?? basename(revision.worktree))}-${randomBytes(4).toString('hex')}`
    const base = join(root, 'instances', id)
    const directories = {
      root: base,
      home: join(base, 'home'),
      runtime: join(base, 'runtime'),
      data: join(base, 'data'),
      artifacts: join(base, 'artifacts')
    }
    await Promise.all(Object.values(directories).map(privateDir))
    const now = new Date().toISOString()
    const record: InstanceRecord = {
      schemaVersion: 1,
      id,
      revision,
      variant,
      artifactKey: artifact.key,
      state: 'booting',
      createdAt: now,
      updatedAt: now,
      slot,
      display: `:${90 + slot}`,
      vncPort,
      appPort,
      vncToken: randomBytes(24).toString('base64url'),
      directories,
      processes: []
    }
    await saveInstance(root, record)
    return record
  })
  const { directories } = instance
  const base = directories.root
  const env = instanceEnvironment(root, instance, artifact.dir)
  try {
    const project = await resolveInsideWorktree(revision.worktree, config.application.root)
    if (config.lifecycle?.prepareInstance) await runCommand(config.lifecycle.prepareInstance, { cwd: project, env })
    const displayNumber = instance.display.slice(1)
    const xvfb = process.env.FLEET_XVFB_COMMAND ?? 'Xvfb'
    instance.processes.push(await spawnOwned('xvfb', [xvfb, instance.display, '-screen', '0', '1440x900x24', '-nolisten', 'tcp', '-noreset', '-ac'], {
      env, log: join(base, 'xvfb.log')
    }))
    await saveInstance(root, instance)
    await waitFor(async () => {
      if (!await processOwned(instance.processes[0]!)) return false
      try { await access(`/tmp/.X11-unix/X${displayNumber}`); return true } catch { return false }
    }, 30_000, `X display ${instance.display}`)
    const vnc = process.env.FLEET_VNC_COMMAND ?? 'x11vnc'
    instance.processes.push(await spawnOwned('vnc', [vnc, '-display', instance.display, '-rfbport', String(instance.vncPort), '-localhost', '-forever', '-shared', '-nopw'], {
      env, log: join(base, 'vnc.log')
    }))
    await saveInstance(root, instance)
    await waitFor(async () => await processOwned(instance.processes[1]!) && await portOpen(instance.vncPort), 30_000, `VNC port ${instance.vncPort}`)
    const executable = resolve(artifact.dir, artifact.manifest.executable)
    const appEnv = { ...env }
    delete appEnv.FLEET_STATE_DIR
    instance.processes.push(await spawnOwned('app', [executable, ...(artifact.manifest.args ?? [])], {
      cwd: resolve(artifact.dir, artifact.manifest.cwd ?? '.'),
      env: {
        ...appEnv,
        ...artifact.manifest.env,
        HOME: env.HOME,
        XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
        XDG_DATA_HOME: env.XDG_DATA_HOME,
        XDG_STATE_HOME: env.XDG_STATE_HOME,
        XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
        XDG_CACHE_HOME: env.XDG_CACHE_HOME,
        DISPLAY: env.DISPLAY,
        FLEET_REVISION: env.FLEET_REVISION,
        FLEET_RUNTIME: env.FLEET_RUNTIME,
        FLEET_INSTANCE_ID: env.FLEET_INSTANCE_ID,
        FLEET_HOME: env.FLEET_HOME,
        FLEET_RUNTIME_DIR: env.FLEET_RUNTIME_DIR,
        FLEET_DISPLAY: env.FLEET_DISPLAY,
        FLEET_APP_PORT: env.FLEET_APP_PORT,
        FLEET_APP_DATA: env.FLEET_APP_DATA,
        FLEET_VNC_PORT: env.FLEET_VNC_PORT,
        FLEET_ARTIFACT_DIR: env.FLEET_ARTIFACT_DIR,
        FLEET_ARTIFACT_MANIFEST: env.FLEET_ARTIFACT_MANIFEST
      },
      log: join(base, 'app.log')
    }))
    await saveInstance(root, instance)
    const attached = await attachAgent(config.application.id, directories.runtime, instance.processes[2]!)
    instance.endpoint = { healthy: true, capabilities: attached.capabilities }
    instance.state = 'ready'
    await saveInstance(root, instance)
    return instance
  } catch (error) {
    await failInstance(config, root, instance, {
      class: 'infrastructure_failure', message: error instanceof Error ? error.message : String(error)
    }, true)
    throw error
  }
}

function instanceEnvironment(root: string, instance: InstanceRecord, artifactDir = join(root, 'artifacts', instance.artifactKey)): NodeJS.ProcessEnv {
  const { directories } = instance
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: directories.home,
    XDG_RUNTIME_DIR: directories.runtime,
    XDG_DATA_HOME: directories.data,
    XDG_STATE_HOME: join(directories.home, '.local', 'state'),
    XDG_CONFIG_HOME: join(directories.home, '.config'),
    XDG_CACHE_HOME: join(directories.home, '.cache'),
    DISPLAY: instance.display,
    FLEET_REVISION: instance.revision.commit,
    FLEET_RUNTIME: instance.variant,
    FLEET_INSTANCE_ID: instance.id,
    FLEET_STATE_DIR: root,
    FLEET_HOME: directories.home,
    FLEET_RUNTIME_DIR: directories.runtime,
    FLEET_DISPLAY: instance.display,
    FLEET_APP_PORT: String(instance.appPort),
    FLEET_APP_DATA: directories.data,
    FLEET_VNC_PORT: String(instance.vncPort),
    FLEET_ARTIFACT_DIR: artifactDir,
    FLEET_ARTIFACT_MANIFEST: join(artifactDir, 'manifest.json')
  }
  delete env.OPENAI_API_KEY
  return env
}

export async function teardownInstance(config: FleetConfig, root: string, instance: InstanceRecord): Promise<void> {
  let failure: unknown
  try { await terminateAll(instance.processes) } catch (error) { failure = error }
  if (config.lifecycle?.cleanupInstance) {
    try {
      const project = await resolveInsideWorktree(instance.revision.worktree, config.application.root)
      await runCommand(config.lifecycle.cleanupInstance, {
        cwd: project, env: instanceEnvironment(root, instance), timeoutMs: 30_000, maxOutputBytes: 1024 * 1024
      })
    } catch (error) { failure ??= error }
  }
  if (failure) {
    instance.state = 'failed'
    instance.failure = {
      class: 'infrastructure_failure', message: `instance teardown failed: ${failure instanceof Error ? failure.message : String(failure)}`
    }
    if (instance.endpoint) instance.endpoint.healthy = false
    await saveInstance(root, instance)
    throw failure
  }
}

export async function stopInstance(config: FleetConfig, root: string, instance: InstanceRecord): Promise<void> {
  await teardownInstance(config, root, instance)
  instance.state = 'stopped'
  if (instance.endpoint) instance.endpoint.healthy = false
  await saveInstance(root, instance)
}

export async function refreshInstance(config: FleetConfig, root: string, instance: InstanceRecord, persist = true): Promise<InstanceRecord> {
  if (ACTIVE.has(instance.state)) {
    const staleBoot = instance.state === 'booting' && Date.now() - Date.parse(instance.updatedAt) > 60_000
    const complete = ['xvfb', 'vnc', 'app'].every((name) => instance.processes.some((process) => process.name === name))
    if (!complete && (staleBoot || instance.state !== 'booting')) {
      await failInstance(config, root, instance, { class: 'infrastructure_failure', message: 'instance process set is incomplete' }, persist)
      return instance
    }
    const alive = await Promise.all(instance.processes.map(processOwned))
    if (alive.length > 0 && alive.some((value) => !value)) {
      const exited = instance.processes[alive.findIndex((value) => !value)]
      await failInstance(config, root, instance, {
        class: exited?.name === 'app' ? 'app_failure' : 'infrastructure_failure',
        message: `${exited?.name ?? 'instance'} process exited`
      }, persist)
    } else if (complete) {
      const app = instance.processes.find((process) => process.name === 'app')
      let capabilities: unknown
      try {
        capabilities = (await attachAgent(config.application.id, instance.directories.runtime, app!, 1_000)).capabilities
      } catch (error) {
        if (instance.state === 'booting') {
          if (staleBoot) {
            await failInstance(config, root, instance, {
              class: 'infrastructure_failure', message: error instanceof Error ? error.message : String(error)
            }, persist)
          }
          return instance
        }
        if (instance.endpoint?.healthy === false) return instance
        instance.endpoint = { ...instance.endpoint, healthy: false }
        if (persist) await saveInstance(root, instance)
        return instance
      }
      const endpoint = { healthy: true, capabilities }
      const changed = instance.state === 'booting' || instance.failure !== undefined || !isDeepStrictEqual(instance.endpoint, endpoint)
      instance.endpoint = endpoint
      delete instance.failure
      if (instance.state === 'booting') instance.state = 'ready'
      if (changed && persist) await saveInstance(root, instance)
    }
  }
  return instance
}
