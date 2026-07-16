import { buildArtifact } from './build.ts'
import { loadDriver, type Driver } from './driver.ts'
import { createInstance, teardownInstance } from './instance.ts'
import { modelAction } from './provider.ts'
import { runSuite, type NextAction } from './runner.ts'
import { runtimeDefinition } from './schema.ts'
import { saveInstance } from './storage.ts'
import type { FleetConfig, InstanceRecord, Revision, RuntimeVariant, Suite } from './types.ts'

export function defaultVariant(config: FleetConfig): RuntimeVariant {
  return config.runtimes.default
}

export async function runSuites(
  config: FleetConfig,
  root: string,
  revision: Revision,
  suites: Suite[],
  options: { jobs: number; runtime?: RuntimeVariant; nextAction?: NextAction; driver?: Driver }
): Promise<InstanceRecord[]> {
  if (!Number.isSafeInteger(options.jobs) || options.jobs < 1) throw new Error('jobs must be a positive safe integer')
  const fallback = defaultVariant(config)
  const variants = [...new Set(suites.map((suite) => options.runtime ?? suite.runtime ?? fallback))]
  const artifacts = new Map<RuntimeVariant, Awaited<ReturnType<typeof buildArtifact>>>()
  const drivers = new Map<RuntimeVariant, Driver>()
  for (const variant of variants) {
    artifacts.set(variant, await buildArtifact(config, root, revision, variant))
    drivers.set(variant, options.driver ?? await loadDriver(runtimeDefinition(config, variant).driver))
  }
  const queue = suites.map((suite) => ({ suite, variant: options.runtime ?? suite.runtime ?? fallback }))
  const results: InstanceRecord[] = []
  const worker = async (): Promise<void> => {
    while (queue.length) {
      const task = queue.shift()!
      const artifact = artifacts.get(task.variant)!
      const driver = drivers.get(task.variant)!
      const instance = await createInstance(config, root, revision, task.variant, artifact, task.suite.id)
      try {
        results.push(await runSuite(root, config.application.id, instance, task.suite, options.nextAction ?? modelAction, driver))
      } finally {
        try { await teardownInstance(config, root, instance) } catch (error) {
          if (instance.run) {
            instance.run.failure = 'infrastructure_failure'
            instance.run.message = instance.failure?.message ?? (error instanceof Error ? error.message : String(error))
          }
          throw error
        } finally {
          if (instance.endpoint) instance.endpoint.healthy = false
          await saveInstance(root, instance)
        }
      }
    }
  }
  const workers = await Promise.allSettled(Array.from({ length: Math.min(options.jobs, queue.length) }, worker))
  const failure = workers.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failure) throw failure.reason
  return results
}
