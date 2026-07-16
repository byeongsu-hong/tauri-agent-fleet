import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ArtifactManifest, FleetConfig, RunnerAction, RuntimeDefinition, Suite } from './types.ts'

// Resolve a named runtime's definition (driver + build), or throw. Keeps the
// `string | RuntimeDefinition` union off every call site.
export function runtimeDefinition(config: FleetConfig, name: string): RuntimeDefinition {
  const definition = config.runtimes[name]
  if (name === 'default' || definition === undefined || typeof definition === 'string') {
    throw new Error(`runtime is not configured: ${name}`)
  }
  return definition
}

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
  if (value.includes('\0')) throw new Error(`${label} cannot contain a null byte`)
  return value
}

function workspacePath(value: unknown, label: string): string {
  const result = string(value, label)
  const path = relative('/workspace', resolve('/workspace', result))
  if (isAbsolute(result) || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`${label} must stay inside the workspace`)
  }
  return result
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive safe integer`)
  return Number(value)
}

function id(value: unknown, label: string): string {
  const result = string(value, label)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(result)) throw new Error(`${label} must be a safe identifier`)
  return result
}

function strings(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => typeof item !== 'string' || item.includes('\0'))) {
    throw new Error(`${label} must be ${allowEmpty ? 'a' : 'a non-empty'} string array`)
  }
  return value as string[]
}

function command(value: unknown, label: string): string[] {
  const result = strings(value, label)
  if (!result[0]!.trim()) throw new Error(`${label}[0] must be a non-empty executable`)
  return result
}

function optionalCommand(value: unknown, label: string): string[] | undefined {
  return value === undefined ? undefined : command(value, label)
}

export function parseConfig(value: unknown): FleetConfig {
  const root = object(value, 'config')
  only(root, ['protocol', 'application', 'lifecycle', 'runtimes'], 'config')
  if (root.protocol !== 'agent-fleet/v1') throw new Error('config.protocol must be agent-fleet/v1')
  const application = object(root.application, 'config.application')
  only(application, ['id', 'root'], 'config.application')
  const runtimes = object(root.runtimes, 'config.runtimes')
  if (typeof runtimes.default !== 'string' || !runtimes.default.trim()) throw new Error('config.runtimes.default must name a runtime')
  const runtimeNames = Object.keys(runtimes).filter((name) => name !== 'default')
  if (runtimeNames.length === 0) throw new Error('config.runtimes must define at least one runtime')
  const builtRuntimes: FleetConfig['runtimes'] = { default: string(runtimes.default, 'config.runtimes.default') }
  for (const name of runtimeNames) {
    id(name, `config.runtimes.${name} name`)
    const definition = object(runtimes[name], `config.runtimes.${name}`)
    only(definition, ['driver', 'build'], `config.runtimes.${name}`)
    builtRuntimes[name] = {
      driver: string(definition.driver, `config.runtimes.${name}.driver`),
      build: command(definition.build, `config.runtimes.${name}.build`)
    }
  }
  if (builtRuntimes[runtimes.default] === undefined) throw new Error('config.runtimes.default must name a configured runtime')
  const lifecycle = root.lifecycle === undefined ? undefined : object(root.lifecycle, 'config.lifecycle')
  if (lifecycle) only(lifecycle, ['prepareBuild', 'prepareInstance', 'cleanupInstance'], 'config.lifecycle')
  const config: FleetConfig = {
    protocol: 'agent-fleet/v1',
    application: {
      id: string(application.id, 'config.application.id'),
      root: workspacePath(application.root, 'config.application.root')
    },
    runtimes: builtRuntimes
  }
  if (lifecycle) {
    const prepareBuild = optionalCommand(lifecycle.prepareBuild, 'config.lifecycle.prepareBuild')
    const prepareInstance = optionalCommand(lifecycle.prepareInstance, 'config.lifecycle.prepareInstance')
    const cleanupInstance = optionalCommand(lifecycle.cleanupInstance, 'config.lifecycle.cleanupInstance')
    config.lifecycle = {
      ...(prepareBuild ? { prepareBuild } : {}),
      ...(prepareInstance ? { prepareInstance } : {}),
      ...(cleanupInstance ? { cleanupInstance } : {})
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
  only(root, ['protocol', 'id', 'runtime', 'objective', 'pass', 'budget'], 'suite')
  if (root.protocol !== 'agent-suite/v1') throw new Error('suite.protocol must be agent-suite/v1')
  const budget = object(root.budget, 'suite.budget')
  only(budget, ['steps', 'seconds', 'tokens', 'repetitions'], 'suite.budget')
  if (!Array.isArray(root.pass) || root.pass.length === 0) throw new Error('suite.pass must be a non-empty array')
  for (const [index, raw] of root.pass.entries()) {
    const condition = object(raw, `suite.pass[${index}]`)
    const keys = ['state', 'event', 'expect'].filter((key) => condition[key] !== undefined)
    if (keys.length !== 1) throw new Error(`suite.pass[${index}] must contain exactly one condition`)
    const body = object(condition[keys[0]!], `suite.pass[${index}].${keys[0]}`)
    if (keys[0] === 'state') {
      only(condition, ['state'], `suite.pass[${index}]`)
      only(body, ['key', 'equals'], `suite.pass[${index}].state`)
      string(body.key, `suite.pass[${index}].state.key`)
      if (!('equals' in body)) throw new Error(`suite.pass[${index}].state.equals is required`)
    } else if (keys[0] === 'event') {
      only(condition, ['event'], `suite.pass[${index}]`)
      only(body, ['name', 'ok'], `suite.pass[${index}].event`)
      string(body.name, `suite.pass[${index}].event.name`)
      if (body.ok !== undefined && typeof body.ok !== 'boolean') throw new Error(`suite.pass[${index}].event.ok must be boolean`)
    } else {
      only(condition, ['expect'], `suite.pass[${index}]`)
      only(body, ['scope', 'role', 'name', 'text', 'present', 'value', 'hasState'], `suite.pass[${index}].expect`)
      locator(body, `suite.pass[${index}].expect`)
      if (!hasLocator(body)) throw new Error(`suite.pass[${index}].expect requires a locator`)
      if (body.present !== undefined && typeof body.present !== 'boolean') throw new Error(`suite.pass[${index}].expect.present must be boolean`)
      for (const key of ['value', 'hasState']) if (body[key] !== undefined && typeof body[key] !== 'string') throw new Error(`suite.pass[${index}].expect.${key} must be a string`)
    }
  }
  const runtime = root.runtime
  if (runtime !== undefined && (typeof runtime !== 'string' || !runtime.trim())) throw new Error('suite.runtime must be a runtime name')
  const seconds = positiveInteger(budget.seconds, 'suite.budget.seconds')
  if (seconds > 2_147_483) throw new Error('suite.budget.seconds cannot exceed 2147483')
  return {
    protocol: 'agent-suite/v1',
    id: id(root.id, 'suite.id'),
    ...(runtime ? { runtime } : {}),
    objective: string(root.objective, 'suite.objective'),
    pass: root.pass as Suite['pass'],
    budget: {
      steps: positiveInteger(budget.steps, 'suite.budget.steps'),
      seconds,
      ...(budget.tokens === undefined ? {} : { tokens: positiveInteger(budget.tokens, 'suite.budget.tokens') }),
      ...(budget.repetitions === undefined ? {} : { repetitions: positiveInteger(budget.repetitions, 'suite.budget.repetitions') })
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
  only(root, ['protocol', 'executable', 'args', 'cwd', 'env'], 'artifact manifest')
  if (root.protocol !== 'agent-artifact/v1') throw new Error('artifact manifest protocol must be agent-artifact/v1')
  const executable = string(root.executable, 'artifact manifest.executable')
  const full = resolve(artifactDir, executable)
  const rel = relative(artifactDir, full)
  if (isAbsolute(executable) || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('artifact executable must be inside the artifact directory')
  }
  const manifest: ArtifactManifest = { protocol: 'agent-artifact/v1', executable }
  if (root.args !== undefined) manifest.args = strings(root.args, 'artifact manifest.args', true)
  if (root.cwd !== undefined) {
    const cwd = string(root.cwd, 'artifact manifest.cwd')
    const cwdRel = relative(artifactDir, resolve(artifactDir, cwd))
    if (isAbsolute(cwd) || cwdRel.startsWith('..') || isAbsolute(cwdRel)) throw new Error('artifact cwd must be inside the artifact directory')
    manifest.cwd = cwd
  }
  if (root.env !== undefined) {
    const env = object(root.env, 'artifact manifest.env')
    for (const [key, entry] of Object.entries(env)) {
      if (!key || key.includes('=') || key.includes('\0')) throw new Error('artifact manifest.env contains an invalid variable name')
      if (typeof entry !== 'string' || entry.includes('\0')) throw new Error('artifact manifest.env values must be strings without null bytes')
    }
    manifest.env = env as Record<string, string>
  }
  return manifest
}
