import { buildArtifact } from './build.ts'
import { createInstance } from './instance.ts'
import { openAIAction } from './provider.ts'
import { terminateAll } from './process.ts'
import { runSuite, type NextAction } from './runner.ts'
import { saveInstance } from './storage.ts'
import type { FleetConfig, InstanceRecord, Revision, RuntimeVariant, Suite } from './types.ts'

export function defaultVariant(config: FleetConfig): RuntimeVariant {
  return config.variants.wry ? 'wry' : 'cef'
}

export async function runSuites(
  config: FleetConfig,
  root: string,
  revision: Revision,
  suites: Suite[],
  options: { jobs: number; variant?: RuntimeVariant; nextAction?: NextAction }
): Promise<InstanceRecord[]> {
  if (!Number.isInteger(options.jobs) || options.jobs < 1) throw new Error('jobs must be a positive integer')
  const fallback = defaultVariant(config)
  const variants = [...new Set(suites.map((suite) => options.variant ?? suite.variant ?? fallback))]
  const artifacts = new Map<RuntimeVariant, Awaited<ReturnType<typeof buildArtifact>>>()
  for (const variant of variants) artifacts.set(variant, await buildArtifact(config, root, revision, variant))
  const queue = suites.map((suite) => ({ suite, variant: options.variant ?? suite.variant ?? fallback }))
  const results: InstanceRecord[] = []
  const worker = async (): Promise<void> => {
    while (queue.length) {
      const task = queue.shift()!
      const artifact = artifacts.get(task.variant)!
      const instance = await createInstance(config, root, revision, task.variant, artifact, task.suite.id)
      try {
        results.push(await runSuite(root, config.agent.appId, instance, task.suite, options.nextAction ?? openAIAction))
      } finally {
        await terminateAll(instance.processes)
        if (instance.endpoint) instance.endpoint.healthy = false
        await saveInstance(root, instance)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.jobs, queue.length) }, worker))
  return results
}
