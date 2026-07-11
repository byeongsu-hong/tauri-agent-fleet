import { randomBytes } from 'node:crypto'
import { access } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { attachAgent } from './agent.ts'
import type { Artifact } from './build.ts'
import { runCommand } from './command.ts'
import { freePort, portOpen, waitFor } from './network.ts'
import { processOwned, spawnOwned, terminateAll } from './process.ts'
import { listInstances, privateDir, saveInstance, withLock } from './storage.ts'
import type { FleetConfig, InstanceRecord, Revision, RuntimeVariant } from './types.ts'

const ACTIVE = new Set(['queued', 'building', 'booting', 'ready', 'running'])

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
  const project = resolve(revision.worktree, config.projectDir ?? '.')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: directories.home,
    XDG_RUNTIME_DIR: directories.runtime,
    XDG_DATA_HOME: directories.data,
    XDG_CONFIG_HOME: join(directories.home, '.config'),
    XDG_CACHE_HOME: join(directories.home, '.cache'),
    DISPLAY: instance.display,
    FLEET_REVISION: revision.commit,
    FLEET_VARIANT: variant,
    FLEET_INSTANCE_ID: instance.id,
    FLEET_STATE_DIR: root,
    FLEET_HOME: directories.home,
    FLEET_RUNTIME_DIR: directories.runtime,
    FLEET_DISPLAY: instance.display,
    FLEET_APP_PORT: String(instance.appPort),
    FLEET_APP_DATA: directories.data,
    FLEET_VNC_PORT: String(instance.vncPort),
    FLEET_ARTIFACT_DIR: artifact.dir,
    FLEET_ARTIFACT_MANIFEST: join(artifact.dir, 'manifest.json')
  }
  try {
    if (config.hooks?.prepareInstance) await runCommand(config.hooks.prepareInstance, { cwd: project, env })
    const displayNumber = instance.display.slice(1)
    const xvfb = (process.env.FLEET_XVFB_COMMAND ?? 'Xvfb').split(' ')
    instance.processes.push(await spawnOwned('xvfb', [...xvfb, instance.display, '-screen', '0', '1440x900x24', '-nolisten', 'tcp', '-noreset', '-ac'], {
      env, log: join(base, 'xvfb.log')
    }))
    await saveInstance(root, instance)
    await waitFor(async () => {
      if (!await processOwned(instance.processes[0]!)) return false
      try { await access(`/tmp/.X11-unix/X${displayNumber}`); return true } catch { return false }
    }, 30_000, `X display ${instance.display}`)
    const vnc = (process.env.FLEET_VNC_COMMAND ?? 'x11vnc').split(' ')
    instance.processes.push(await spawnOwned('vnc', [...vnc, '-display', instance.display, '-rfbport', String(instance.vncPort), '-localhost', '-forever', '-shared', '-nopw'], {
      env, log: join(base, 'vnc.log')
    }))
    await saveInstance(root, instance)
    await waitFor(async () => await processOwned(instance.processes[1]!) && await portOpen(instance.vncPort), 30_000, `VNC port ${instance.vncPort}`)
    const executable = resolve(artifact.dir, artifact.manifest.executable)
    instance.processes.push(await spawnOwned('app', [executable, ...(artifact.manifest.args ?? [])], {
      cwd: resolve(artifact.dir, artifact.manifest.cwd ?? '.'),
      env: {
        ...env,
        ...artifact.manifest.env,
        HOME: env.HOME,
        XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
        XDG_DATA_HOME: env.XDG_DATA_HOME,
        XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
        XDG_CACHE_HOME: env.XDG_CACHE_HOME,
        DISPLAY: env.DISPLAY,
        FLEET_REVISION: env.FLEET_REVISION,
        FLEET_VARIANT: env.FLEET_VARIANT,
        FLEET_INSTANCE_ID: env.FLEET_INSTANCE_ID,
        FLEET_STATE_DIR: env.FLEET_STATE_DIR,
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
    const attached = await attachAgent(config.agent.appId, directories.runtime, instance.processes[2]!)
    instance.endpoint = { healthy: true, capabilities: attached.capabilities }
    instance.state = 'ready'
    await saveInstance(root, instance)
    return instance
  } catch (error) {
    await terminateAll(instance.processes)
    instance.state = 'failed'
    instance.endpoint = { healthy: false }
    await saveInstance(root, instance)
    throw error
  }
}

export async function stopInstance(root: string, instance: InstanceRecord): Promise<void> {
  await terminateAll(instance.processes)
  instance.state = 'stopped'
  if (instance.endpoint) instance.endpoint.healthy = false
  await saveInstance(root, instance)
}

export async function refreshInstance(root: string, instance: InstanceRecord, appId: string): Promise<InstanceRecord> {
  if (ACTIVE.has(instance.state)) {
    if (instance.processes.length === 0 && Date.now() - Date.parse(instance.updatedAt) > 60_000) {
      instance.state = 'failed'
      await saveInstance(root, instance)
      return instance
    }
    const alive = await Promise.all(instance.processes.map(processOwned))
    if (alive.length > 0 && alive.some((value) => !value)) {
      instance.state = 'failed'
      if (instance.endpoint) instance.endpoint.healthy = false
      await saveInstance(root, instance)
    } else if (instance.endpoint) {
      const app = instance.processes.find((process) => process.name === 'app')
      try {
        if (!app) throw new Error('instance has no application process')
        instance.endpoint.capabilities = (await attachAgent(appId, instance.directories.runtime, app, 1_000)).capabilities
        instance.endpoint.healthy = true
      } catch { instance.endpoint.healthy = false }
      await saveInstance(root, instance)
    }
  }
  return instance
}
