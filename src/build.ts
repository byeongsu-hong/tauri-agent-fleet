import { access, lstat, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { runCommand } from './command.ts'
import { artifactKey, CLEAN_FINGERPRINT, resolveInsideWorktree } from './revision.ts'
import { parseArtifactManifest } from './schema.ts'
import { atomicJson, privateDir, withLock, withRenewableLock } from './storage.ts'
import type { ArtifactManifest, FleetConfig, Revision, RuntimeVariant } from './types.ts'

export interface Artifact { key: string; dir: string; manifest: ArtifactManifest }

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function validArtifact(dir: string, containerRoot: string): Promise<ArtifactManifest | undefined> {
  try {
    if (!(await lstat(dir)).isDirectory()) return undefined
    const root = await realpath(dir)
    if (!inside(containerRoot, root)) return undefined
    const manifestPath = join(dir, 'manifest.json')
    if (!(await lstat(manifestPath)).isFile()) return undefined
    const manifestFile = await realpath(manifestPath)
    if (!inside(root, manifestFile)) return undefined
    const manifest = parseArtifactManifest(JSON.parse(await readFile(manifestFile, 'utf8')), dir)
    const executable = await realpath(resolve(dir, manifest.executable))
    const cwd = await realpath(resolve(dir, manifest.cwd ?? '.'))
    if (![executable, cwd].every((target) => inside(root, target))) return undefined
    const [executableStat, cwdStat] = await Promise.all([stat(executable), stat(cwd)])
    if (!executableStat.isFile() || !cwdStat.isDirectory()) return undefined
    await access(executable, constants.X_OK)
    return manifest
  } catch { return undefined }
}

export async function buildArtifact(
  config: FleetConfig,
  root: string,
  revision: Revision,
  variant: RuntimeVariant
): Promise<Artifact> {
  const definition = config.runtimes[variant]
  if (!definition) throw new Error(`runtime is not configured: ${variant}`)
  const key = artifactKey(revision, variant)
  const shared = process.env.FLEET_ARTIFACT_CACHE
  if (shared && !isAbsolute(shared)) throw new Error('FLEET_ARTIFACT_CACHE must be an absolute path')
  if (shared && revision.dirtyFingerprint !== CLEAN_FINGERPRINT) throw new Error('shared artifact cache requires a clean revision')
  const container = shared ? resolve(shared) : join(root, 'artifacts')
  const dir = join(container, key)
  await privateDir(container)
  const containerRoot = await realpath(container)
  const cached = await validArtifact(dir, containerRoot)
  if (cached) return { key, dir, manifest: cached }
  const build = async (assertOwned: () => Promise<void>): Promise<Artifact> => {
    const raced = await validArtifact(dir, containerRoot)
    if (raced) return { key, dir, manifest: raced }
    const staging = `${dir}.${process.pid}.${crypto.randomUUID()}.tmp`
    await rm(staging, { recursive: true, force: true })
    await privateDir(staging)
    try {
      const project = await resolveInsideWorktree(revision.worktree, config.application.root)
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        FLEET_REVISION: revision.commit,
        FLEET_RUNTIME: variant,
        FLEET_INSTANCE_ID: '',
        FLEET_STATE_DIR: root,
        FLEET_HOME: '',
        FLEET_RUNTIME_DIR: '',
        FLEET_DISPLAY: '',
        FLEET_APP_PORT: '',
        FLEET_APP_DATA: '',
        FLEET_VNC_PORT: '',
        FLEET_ARTIFACT_DIR: staging,
        FLEET_ARTIFACT_MANIFEST: join(staging, 'manifest.json')
      }
      delete env.OPENAI_API_KEY
      delete env.ANTHROPIC_API_KEY
      delete env.CLAUDE_CODE_OAUTH_TOKEN
      if (config.lifecycle?.prepareBuild) await runCommand(config.lifecycle.prepareBuild, { cwd: project, env })
      await runCommand(definition.build, { cwd: project, env })
      const manifest = await validArtifact(staging, containerRoot)
      if (!manifest) throw new Error(`build did not create a valid artifact at ${join(staging, 'manifest.json')}`)
      await atomicJson(join(staging, 'build.json'), {
        schemaVersion: 1, key,
        revision: { repository: revision.repository, commit: revision.commit, dirtyFingerprint: revision.dirtyFingerprint },
        variant, builtAt: new Date().toISOString()
      })
      await assertOwned()
      await rm(dir, { recursive: true, force: true })
      await rename(staging, dir)
      const installed = await validArtifact(dir, containerRoot)
      if (!installed) {
        await rm(dir, { recursive: true, force: true })
        throw new Error(`artifact became invalid after installation: ${dir}`)
      }
      return { key, dir, manifest: installed }
    } finally { await rm(staging, { recursive: true, force: true }) }
  }
  return shared
    ? await withRenewableLock(`${dir}.lock`, build)
    : await withLock(`${dir}.lock`, () => build(async () => {}), 10 * 60_000)
}
