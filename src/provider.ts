import { parseAction } from './schema.ts'
import type { RunnerAction, SuccessCondition } from './types.ts'

export interface ModelUsage { inputTokens: number; outputTokens: number; cost?: number }
export interface ModelDecision { action: RunnerAction; usage: ModelUsage; raw: unknown }
export interface RunnerContext {
  goal: string
  success: SuccessCondition[]
  observation: unknown
  previousAction?: { action: RunnerAction; result: unknown }
  remaining: { steps: number; seconds: number; tokens?: number }
}

const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    t: { type: 'string', enum: ['click', 'hover', 'focus', 'blur', 'fill', 'type', 'press', 'scroll', 'wait'] },
    s: { type: ['string', 'null'] },
    r: { type: ['string', 'null'] },
    n: { type: ['string', 'null'] },
    q: { type: ['string', 'null'] },
    v: { type: ['string', 'null'] },
    x: { type: ['number', 'null'] },
    y: { type: ['number', 'null'] },
    ms: { type: ['integer', 'null'] }
  },
  required: ['t', 's', 'r', 'n', 'q', 'v', 'x', 'y', 'ms']
} as const

function outputText(response: Record<string, unknown>): string {
  const output = response.output
  if (!Array.isArray(output)) throw new Error('model response has no output')
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const content = (item as Record<string, unknown>).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part && typeof part === 'object' && (part as Record<string, unknown>).type === 'output_text') {
        const text = (part as Record<string, unknown>).text
        if (typeof text === 'string') return text
      }
    }
  }
  throw new Error('model response has no output text')
}

function cleanNulls(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null))
}

function compactAction(action: RunnerAction): Record<string, unknown> {
  const locator = action as RunnerAction & { scope?: string; role?: string; name?: string; text?: string; value?: string; x?: number; y?: number; milliseconds?: number }
  return Object.fromEntries(Object.entries({
    t: action.type,
    s: locator.scope,
    r: locator.role,
    n: locator.name,
    q: locator.text,
    v: locator.value,
    x: locator.x,
    y: locator.y,
    ms: locator.milliseconds
  }).filter(([, value]) => value !== undefined))
}

function compactSuccess(condition: SuccessCondition): Record<string, unknown> {
  if ('state' in condition) return { s: [condition.state.key, condition.state.equals] }
  if ('ipc' in condition) return { i: [condition.ipc.command, ...(condition.ipc.ok === undefined ? [] : [condition.ipc.ok])] }
  const expect = condition.expect
  return { e: Object.fromEntries(Object.entries({
    s: expect.scope,
    r: expect.role,
    n: expect.name,
    q: expect.text,
    p: expect.present,
    v: expect.value,
    h: expect.hasState
  }).filter(([, value]) => value !== undefined)) }
}

function compactObservation(observation: unknown): unknown {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return observation
  const value = observation as Record<string, unknown>
  if (!('snapshot' in value) && !('frames' in value) && !('dropped' in value)) return observation
  return {
    ...('snapshot' in value ? { s: value.snapshot } : {}),
    ...('frames' in value ? { f: value.frames } : {}),
    ...(value.dropped === true ? { d: true } : {})
  }
}

function modelInput(context: RunnerContext): Record<string, unknown> {
  return {
    g: context.goal,
    p: context.success.map(compactSuccess),
    o: compactObservation(context.observation),
    ...(context.previousAction ? { x: { a: compactAction(context.previousAction.action), o: context.previousAction.result } } : {}),
    b: {
      n: context.remaining.steps,
      s: context.remaining.seconds,
      ...(context.remaining.tokens === undefined ? {} : { t: context.remaining.tokens })
    }
  }
}

export async function openAIAction(context: RunnerContext): Promise<ModelDecision> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is required')
  const base = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const response = await fetch(`${base}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(Math.max(1_000, context.remaining.seconds * 1_000)),
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      store: false,
      max_output_tokens: 100,
      instructions: 'Input: g goal; p success (s=[state key,equals], i=[IPC command,ok?], e=expect); o observation (s snapshot,f frames,d dropped); x previous {a action,o result}; b budget {n steps,s seconds,t tokens}. Output: t action, s scope, r role, n name, q text, v value, ms wait. Null unused. Choose one safe UI action; no shell or JavaScript.',
      input: JSON.stringify(modelInput(context)),
      text: { format: { type: 'json_schema', name: 'next_action', strict: true, schema: ACTION_SCHEMA } }
    })
  })
  const raw = await response.json() as Record<string, unknown>
  if (!response.ok) throw new Error(`OpenAI API ${response.status}: ${JSON.stringify(raw)}`)
  const parsed = JSON.parse(outputText(raw)) as Record<string, unknown>
  const usage = (raw.usage ?? {}) as Record<string, unknown>
  const inputTokens = Number(usage.input_tokens ?? 0)
  const outputTokens = Number(usage.output_tokens ?? 0)
  const inputRate = Number(process.env.OPENAI_INPUT_COST_PER_MILLION ?? 0)
  const outputRate = Number(process.env.OPENAI_OUTPUT_COST_PER_MILLION ?? 0)
  const cost = (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000
  return {
    action: parseAction(cleanNulls({
      type: parsed.t,
      scope: parsed.s,
      role: parsed.r,
      name: parsed.n,
      text: parsed.q,
      value: parsed.v,
      x: parsed.x,
      y: parsed.y,
      milliseconds: parsed.ms
    })),
    usage: { inputTokens, outputTokens, ...(inputRate || outputRate ? { cost } : {}) },
    raw
  }
}
