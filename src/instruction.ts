import { decode, encode } from '@toon-format/toon'

export const encodeInstruction = (value: unknown): string => encode(value)
export const decodeInstruction = (value: string): unknown => decode(value)
export const jsonToInstruction = (value: string): string => encodeInstruction(JSON.parse(value))
export const instructionToJson = (value: string): string => JSON.stringify(decodeInstruction(value), null, 2)
