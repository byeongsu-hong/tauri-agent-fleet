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
    type: { type: 'string', enum: ['click', 'hover', 'focus', 'blur', 'fill', 'type', 'press', 'scroll', 'wait'] },
    scope: { type: ['string', 'null'] },
    role: { type: ['string', 'null'] },
    name: { type: ['string', 'null'] },
    text: { type: ['string', 'null'] },
    value: { type: ['string', 'null'] },
    x: { type: ['number', 'null'] },
    y: { type: ['number', 'null'] },
    milliseconds: { type: ['integer', 'null'] }
  },
  required: ['type', 'scope', 'role', 'name', 'text', 'value', 'x', 'y', 'milliseconds']
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
      max_output_tokens: 200,
      instructions: 'Choose exactly one safe UI action toward the goal. Never use shell or JavaScript. Use wait only for brief UI settling.',
      input: JSON.stringify(context),
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
    action: parseAction(cleanNulls(parsed)),
    usage: { inputTokens, outputTokens, ...(inputRate || outputRate ? { cost } : {}) },
    raw
  }
}
