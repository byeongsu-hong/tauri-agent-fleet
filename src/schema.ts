import { isAbsolute, relative, resolve } from 'node:path'
import type { ArtifactManifest, FleetConfig, RunnerAction, Suite } from './types.ts'

type ObjectValue = Record<string, unknown>

function only(value: ObjectValue, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new Error(`${label} contains unknown field: ${unknown[0]}`)
}

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as ObjectValue
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive integer`)
  return Number(value)
}

function id(value: unknown, label: string): string {
  const result = string(value, label)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(result)) throw new Error(`${label} must be a safe identifier`)
  return result
}

function strings(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => typeof item !== 'string' || !item)) {
    throw new Error(`${label} must be ${allowEmpty ? 'a' : 'a non-empty'} string array`)
  }
  return value as string[]
}

const command = (value: unknown, label: string): string[] => strings(value, label)

function optionalCommand(value: unknown, label: string): string[] | undefined {
  return value === undefined ? undefined : command(value, label)
}

export function parseConfig(value: unknown): FleetConfig {
  const root = object(value, 'config')
  only(root, ['schemaVersion', 'baseBranch', 'projectDir', 'stateDir', 'agent', 'hooks', 'variants'], 'config')
  if (root.schemaVersion !== 1) throw new Error('config.schemaVersion must be 1')
  const agent = object(root.agent, 'config.agent')
  only(agent, ['appId'], 'config.agent')
  const variants = object(root.variants, 'config.variants')
  only(variants, ['wry', 'cef'], 'config.variants')
  if (variants.wry === undefined && variants.cef === undefined) throw new Error('config.variants must configure wry or cef')
  const wry = variants.wry === undefined ? undefined : object(variants.wry, 'config.variants.wry')
  if (wry) only(wry, ['build'], 'config.variants.wry')
  const cef = variants.cef === undefined ? undefined : object(variants.cef, 'config.variants.cef')
  if (cef) only(cef, ['build'], 'config.variants.cef')
  const hooks = root.hooks === undefined ? undefined : object(root.hooks, 'config.hooks')
  if (hooks) only(hooks, ['prepareBuild', 'prepareInstance'], 'config.hooks')
  const config: FleetConfig = {
    schemaVersion: 1,
    agent: { appId: string(agent.appId, 'config.agent.appId') },
    variants: {
      ...(wry ? { wry: { build: command(wry.build, 'config.variants.wry.build') } } : {}),
      ...(cef ? { cef: { build: command(cef.build, 'config.variants.cef.build') } } : {})
    }
  }
  if (root.baseBranch !== undefined) config.baseBranch = string(root.baseBranch, 'config.baseBranch')
  if (root.projectDir !== undefined) config.projectDir = string(root.projectDir, 'config.projectDir')
  if (root.stateDir !== undefined) config.stateDir = string(root.stateDir, 'config.stateDir')
  if (hooks) {
    config.hooks = {
      prepareBuild: optionalCommand(hooks.prepareBuild, 'config.hooks.prepareBuild'),
      prepareInstance: optionalCommand(hooks.prepareInstance, 'config.hooks.prepareInstance')
    }
  }
  return config
}

function locator(value: ObjectValue, label: string): void {
  for (const key of ['scope', 'role', 'name', 'text']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(`${label}.${key} must be a string`)
  }
}

function hasLocator(value: ObjectValue): boolean {
  return ['scope', 'role', 'name', 'text'].some((key) => typeof value[key] === 'string' && value[key] !== '')
}

export function parseSuite(value: unknown): Suite {
  const root = object(value, 'suite')
  only(root, ['id', 'variant', 'goal', 'success', 'limits'], 'suite')
  const limits = object(root.limits, 'suite.limits')
  only(limits, ['steps', 'seconds', 'tokens', 'repetitions'], 'suite.limits')
  if (!Array.isArray(root.success) || root.success.length === 0) throw new Error('suite.success must be a non-empty array')
  for (const [index, raw] of root.success.entries()) {
    const condition = object(raw, `suite.success[${index}]`)
    const keys = ['state', 'ipc', 'expect'].filter((key) => condition[key] !== undefined)
    if (keys.length !== 1) throw new Error(`suite.success[${index}] must contain exactly one condition`)
    const body = object(condition[keys[0]!], `suite.success[${index}].${keys[0]}`)
    if (keys[0] === 'state') {
      only(condition, ['state'], `suite.success[${index}]`)
      only(body, ['key', 'equals'], `suite.success[${index}].state`)
      string(body.key, `suite.success[${index}].state.key`)
      if (!('equals' in body)) throw new Error(`suite.success[${index}].state.equals is required`)
    } else if (keys[0] === 'ipc') {
      only(condition, ['ipc'], `suite.success[${index}]`)
      only(body, ['command', 'ok'], `suite.success[${index}].ipc`)
      string(body.command, `suite.success[${index}].ipc.command`)
      if (body.ok !== undefined && typeof body.ok !== 'boolean') throw new Error(`suite.success[${index}].ipc.ok must be boolean`)
    } else {
      only(condition, ['expect'], `suite.success[${index}]`)
      only(body, ['scope', 'role', 'name', 'text', 'present', 'value', 'hasState'], `suite.success[${index}].expect`)
      locator(body, `suite.success[${index}].expect`)
      if (!hasLocator(body)) throw new Error(`suite.success[${index}].expect requires a locator`)
      if (body.present !== undefined && typeof body.present !== 'boolean') throw new Error(`suite.success[${index}].expect.present must be boolean`)
      for (const key of ['value', 'hasState']) if (body[key] !== undefined && typeof body[key] !== 'string') throw new Error(`suite.success[${index}].expect.${key} must be a string`)
    }
  }
  const variant = root.variant
  if (variant !== undefined && variant !== 'wry' && variant !== 'cef') throw new Error('suite.variant must be wry or cef')
  return {
    id: id(root.id, 'suite.id'),
    ...(variant ? { variant } : {}),
    goal: string(root.goal, 'suite.goal'),
    success: root.success as Suite['success'],
    limits: {
      steps: positiveInteger(limits.steps, 'suite.limits.steps'),
      seconds: positiveInteger(limits.seconds, 'suite.limits.seconds'),
      ...(limits.tokens === undefined ? {} : { tokens: positiveInteger(limits.tokens, 'suite.limits.tokens') }),
      ...(limits.repetitions === undefined ? {} : { repetitions: positiveInteger(limits.repetitions, 'suite.limits.repetitions') })
    }
  }
}

export function parseAction(value: unknown): RunnerAction {
  const action = object(value, 'model action')
  const type = string(action.type, 'model action.type')
  if (!['click', 'hover', 'focus', 'blur', 'fill', 'type', 'press', 'scroll', 'wait'].includes(type)) {
    throw new Error(`unsupported model action: ${type}`)
  }
  if (type === 'wait') {
    only(action, ['type', 'milliseconds'], 'model action')
    const milliseconds = positiveInteger(action.milliseconds, 'model action.milliseconds')
    if (milliseconds > 5_000) throw new Error('model wait cannot exceed 5000ms')
    return { type, milliseconds }
  }
  const common = ['type', 'scope', 'role', 'name', 'text']
  const allowed = type === 'scroll' ? [...common, 'x', 'y'] : ['fill', 'type', 'press'].includes(type) ? [...common, 'value'] : common
  only(action, allowed, 'model action')
  locator(action, 'model action')
  if (type !== 'press' && !hasLocator(action)) throw new Error(`model action ${type} requires a locator`)
  if (['fill', 'type', 'press'].includes(type)) string(action.value, 'model action.value')
  if (type === 'scroll') {
    for (const key of ['x', 'y']) if (action[key] !== undefined && typeof action[key] !== 'number') throw new Error(`model action.${key} must be a number`)
  }
  return action as RunnerAction
}

export function parseArtifactManifest(value: unknown, artifactDir: string): ArtifactManifest {
  const root = object(value, 'artifact manifest')
  only(root, ['schemaVersion', 'executable', 'args', 'cwd', 'env'], 'artifact manifest')
  if (root.schemaVersion !== 1) throw new Error('artifact manifest schemaVersion must be 1')
  const executable = string(root.executable, 'artifact manifest.executable')
  const full = resolve(artifactDir, executable)
  const rel = relative(artifactDir, full)
  if (isAbsolute(executable) || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('artifact executable must be inside the artifact directory')
  }
  const manifest: ArtifactManifest = { schemaVersion: 1, executable }
  if (root.args !== undefined) manifest.args = strings(root.args, 'artifact manifest.args', true)
  if (root.cwd !== undefined) {
    const cwd = string(root.cwd, 'artifact manifest.cwd')
    const cwdRel = relative(artifactDir, resolve(artifactDir, cwd))
    if (isAbsolute(cwd) || cwdRel.startsWith('..') || isAbsolute(cwdRel)) throw new Error('artifact cwd must be inside the artifact directory')
    manifest.cwd = cwd
  }
  if (root.env !== undefined) {
    const env = object(root.env, 'artifact manifest.env')
    if (Object.values(env).some((entry) => typeof entry !== 'string')) throw new Error('artifact manifest.env values must be strings')
    manifest.env = env as Record<string, string>
  }
  return manifest
}
