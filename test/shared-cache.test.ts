import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildArtifact } from '../src/build.ts'
import { CLEAN_FINGERPRINT } from '../src/revision.ts'
import type { FleetConfig, Revision } from '../src/types.ts'

test('two worker roots build one immutable artifact through the shared cache', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'fleet-shared-workspace-'))
  const cache = await mkdtemp(join(tmpdir(), 'fleet-shared-cache-'))
  const rootA = await mkdtemp(join(tmpdir(), 'fleet-worker-a-'))
  const rootB = await mkdtemp(join(tmpdir(), 'fleet-worker-b-'))
  const previous = process.env.FLEET_ARTIFACT_CACHE
  process.env.FLEET_ARTIFACT_CACHE = cache
  const config: FleetConfig = {
    protocol: 'agent-fleet/v1', application: { id: 'test', root: '.' },
    runtimes: {
      default: 'wry',
      wry: { driver: '@byeongsu-hong/agent-fleet/driver-tauri', build: ['bash', '-c', 'n=$(cat count 2>/dev/null || echo 0); echo $((n+1)) > count; sleep 0.05; mkdir -p "$FLEET_ARTIFACT_DIR/bin"; printf "#!/bin/sh\\nexit 0\\n" > "$FLEET_ARTIFACT_DIR/bin/app"; chmod +x "$FLEET_ARTIFACT_DIR/bin/app"; printf \'{"protocol":"agent-artifact/v1","executable":"bin/app"}\\n\' > "$FLEET_ARTIFACT_MANIFEST"'] }
    }
  }
  const revision: Revision = {
    repository: 'a'.repeat(64), commit: 'b'.repeat(40), dirtyFingerprint: CLEAN_FINGERPRINT, worktree: workspace
  }
  try {
    const [first, second] = await Promise.all([
      buildArtifact(config, rootA, revision, 'wry'),
      buildArtifact(config, rootB, revision, 'wry')
    ])
    expect(first.dir).toBe(second.dir)
    expect(await readFile(join(workspace, 'count'), 'utf8')).toBe('1\n')
    expect(await readFile(join(first.dir, 'manifest.json'), 'utf8')).toContain('agent-artifact/v1')
  } finally {
    if (previous === undefined) delete process.env.FLEET_ARTIFACT_CACHE
    else process.env.FLEET_ARTIFACT_CACHE = previous
    await Promise.all([workspace, cache, rootA, rootB].map((path) => rm(path, { recursive: true, force: true })))
  }
})
