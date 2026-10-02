import { readFileSync } from 'node:fs'
import type { JsonValue } from '@aang/contract'

export const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export const emit = (event: JsonValue): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

export const say = (stream: NodeJS.WriteStream, line: string): void => {
  stream.write(`${line}\n`)
}

export const finish = (code: number): void => {
  process.exitCode = code
}

export const hang = (): void => {
  setInterval(() => undefined, 60_000)
}

export type TextRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly missing: boolean; readonly message: string }

export const tryReadText = (path: string): TextRead => {
  try {
    return { ok: true, text: readFileSync(path, 'utf8') }
  } catch (error) {
    return {
      ok: false,
      missing: error instanceof Error && 'code' in error && error.code === 'ENOENT',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export const readText = (path: string): string | undefined => {
  const read = tryReadText(path)
  return read.ok ? read.text : undefined
}

export const parseJson = (text: string | undefined): JsonValue | undefined => {
  if (text === undefined) {
    return undefined
  }
  try {
    return JSON.parse(text) as JsonValue
  } catch {
    return undefined
  }
}

export const isJsonObject = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const environment = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
