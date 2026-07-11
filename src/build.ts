import { access, readFile, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { runCommand } from './command.ts'
import { artifactKey } from './revision.ts'
import { parseArtifactManifest } from './schema.ts'
import { atomicJson, privateDir, withLock } from './storage.ts'
import type { ArtifactManifest, FleetConfig, Revision, RuntimeVariant } from './types.ts'

export interface Artifact { key: string; dir: string; manifest: ArtifactManifest }

async function validArtifact(dir: string): Promise<ArtifactManifest | undefined> {
  try {
    const manifest = parseArtifactManifest(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')), dir)
    await access(resolve(dir, manifest.executable), constants.X_OK)
    return manifest
  } catch { return undefined }
}

export async function buildArtifact(
  config: FleetConfig,
  root: string,
  revision: Revision,
  variant: RuntimeVariant
): Promise<Artifact> {
  const definition = config.variants[variant]
  if (!definition) throw new Error(`variant is not configured: ${variant}`)
  const key = artifactKey(revision, variant)
  const dir = join(root, 'artifacts', key)
  const cached = await validArtifact(dir)
  if (cached) return { key, dir, manifest: cached }
  await privateDir(join(root, 'artifacts'))
  return await withLock(`${dir}.lock`, async () => {
    const raced = await validArtifact(dir)
    if (raced) return { key, dir, manifest: raced }
    const staging = `${dir}.${process.pid}.tmp`
    await rm(staging, { recursive: true, force: true })
    await privateDir(staging)
    const project = resolve(revision.worktree, config.projectDir ?? '.')
    const env = {
      ...process.env,
      FLEET_REVISION: revision.commit,
      FLEET_VARIANT: variant,
      FLEET_INSTANCE_ID: '',
      FLEET_STATE_DIR: root,
      FLEET_HOME: '',
      FLEET_RUNTIME_DIR: '',
      FLEET_DISPLAY: '',
      FLEET_APP_PORT: '',
      FLEET_ARTIFACT_DIR: staging,
      FLEET_ARTIFACT_MANIFEST: join(staging, 'manifest.json')
    }
    if (config.hooks?.prepareBuild) await runCommand(config.hooks.prepareBuild, { cwd: project, env })
    await runCommand(definition.build, { cwd: project, env })
    const manifest = await validArtifact(staging)
    if (!manifest) throw new Error(`build did not create a valid artifact at ${join(staging, 'manifest.json')}`)
    await atomicJson(join(staging, 'build.json'), { schemaVersion: 1, key, revision, variant, builtAt: new Date().toISOString() })
    await rm(dir, { recursive: true, force: true })
    await rename(staging, dir)
    return { key, dir, manifest }
  }, 10 * 60_000)
}
