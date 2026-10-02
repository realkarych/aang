import type { JsonValue } from '@aang/contract'

type Table = { [key: string]: JsonValue }

interface Cursor {
  readonly text: string
  at: number
}

const fail = (cursor: Cursor, expected: string): never => {
  throw new SyntaxError(`expected ${expected} at ${String(cursor.at)} in ${cursor.text}`)
}

const peek = (cursor: Cursor): string => cursor.text.charAt(cursor.at)

const skipSpace = (cursor: Cursor): void => {
  while (peek(cursor) === ' ' || peek(cursor) === '\t') {
    cursor.at += 1
  }
}

const expect = (cursor: Cursor, token: string): void => {
  if (!cursor.text.startsWith(token, cursor.at)) {
    fail(cursor, token)
  }
  cursor.at += token.length
}

const simpleEscapes: Readonly<Record<string, string>> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
}

const readEscape = (cursor: Cursor): string => {
  const marker = peek(cursor)
  cursor.at += 1
  const simple = simpleEscapes[marker]
  if (simple !== undefined) {
    return simple
  }
  const length = marker === 'u' ? 4 : marker === 'U' ? 8 : 0
  const digits = cursor.text.slice(cursor.at, cursor.at + length)
  if (length === 0 || !/^[0-9a-fA-F]+$/.test(digits) || digits.length !== length) {
    return fail(cursor, 'a valid escape sequence')
  }
  cursor.at += length
  return String.fromCodePoint(Number.parseInt(digits, 16))
}

const readBasicString = (cursor: Cursor): string => {
  expect(cursor, '"')
  let value = ''
  for (;;) {
    const character = peek(cursor)
    if (character === '') {
      return fail(cursor, 'a closing "')
    }
    cursor.at += 1
    if (character === '"') {
      return value
    }
    value += character === '\\' ? readEscape(cursor) : character
  }
}

const readLiteralString = (cursor: Cursor): string => {
  expect(cursor, "'")
  const end = cursor.text.indexOf("'", cursor.at)
  if (end === -1) {
    return fail(cursor, "a closing '")
  }
  const value = cursor.text.slice(cursor.at, end)
  cursor.at = end + 1
  return value
}

const readKeyPart = (cursor: Cursor): string => {
  if (peek(cursor) === '"') {
    return readBasicString(cursor)
  }
  if (peek(cursor) === "'") {
    return readLiteralString(cursor)
  }
  const bare = /^[A-Za-z0-9_-]+/.exec(cursor.text.slice(cursor.at))?.[0]
  if (bare === undefined) {
    return fail(cursor, 'a key')
  }
  cursor.at += bare.length
  return bare
}

const readKey = (cursor: Cursor): string[] => {
  const parts = [readKeyPart(cursor)]
  skipSpace(cursor)
  while (peek(cursor) === '.') {
    cursor.at += 1
    skipSpace(cursor)
    parts.push(readKeyPart(cursor))
    skipSpace(cursor)
  }
  return parts
}

const isTable = (value: JsonValue | undefined): value is Table =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const assignPath = (table: Table, path: readonly string[], value: JsonValue): void => {
  const [head, ...rest] = path
  if (head === undefined) {
    return
  }
  if (rest.length === 0) {
    const existing = table[head]
    table[head] = isTable(existing) && isTable(value) ? { ...existing, ...value } : value
    return
  }
  const existing = table[head]
  const next: Table = isTable(existing) ? existing : {}
  table[head] = next
  assignPath(next, rest, value)
}

const readSequence = (cursor: Cursor, close: string, readItem: () => void): void => {
  skipSpace(cursor)
  while (peek(cursor) !== close) {
    readItem()
    skipSpace(cursor)
    if (peek(cursor) === ',') {
      cursor.at += 1
      skipSpace(cursor)
    } else if (peek(cursor) !== close) {
      fail(cursor, `, or ${close}`)
    }
  }
  cursor.at += 1
}

const readNumber = (cursor: Cursor): number => {
  const literal = /^[+-]?[0-9][0-9_]*(?:\.[0-9][0-9_]*)?(?:[eE][+-]?[0-9]+)?/.exec(cursor.text.slice(cursor.at))?.[0]
  if (literal === undefined) {
    return fail(cursor, 'a value')
  }
  cursor.at += literal.length
  return Number(literal.replaceAll('_', ''))
}

const readValue = (cursor: Cursor): JsonValue => {
  const character = peek(cursor)
  if (character === '"') {
    return readBasicString(cursor)
  }
  if (character === "'") {
    return readLiteralString(cursor)
  }
  if (character === '[') {
    cursor.at += 1
    const items: JsonValue[] = []
    readSequence(cursor, ']', () => items.push(readValue(cursor)))
    return items
  }
  if (character === '{') {
    cursor.at += 1
    const table: Table = {}
    readSequence(cursor, '}', () => {
      const key = readKey(cursor)
      expect(cursor, '=')
      skipSpace(cursor)
      assignPath(table, key, readValue(cursor))
    })
    return table
  }
  for (const [word, value] of [
    ['true', true],
    ['false', false],
  ] as const) {
    if (cursor.text.startsWith(word, cursor.at)) {
      cursor.at += word.length
      return value
    }
  }
  return readNumber(cursor)
}

export const parseTomlValue = (text: string): JsonValue => {
  const cursor: Cursor = { text, at: 0 }
  skipSpace(cursor)
  const value = readValue(cursor)
  skipSpace(cursor)
  if (cursor.at !== text.length) {
    fail(cursor, 'the end of the value')
  }
  return value
}

export const configOverrides = (entries: readonly string[]): Table => {
  const config: Table = {}
  for (const entry of entries) {
    const separator = entry.indexOf('=')
    if (separator === -1) {
      continue
    }
    const raw = entry.slice(separator + 1).trim()
    let value: JsonValue
    try {
      value = parseTomlValue(raw)
    } catch {
      value = raw
    }
    assignPath(
      config,
      entry
        .slice(0, separator)
        .trim()
        .split('.')
        .map((part) => part.trim()),
      value,
    )
  }
  return config
}

export const configValue = (config: JsonValue, path: string): JsonValue | undefined =>
  path.split('.').reduce<JsonValue | undefined>((value, key) => (isTable(value) ? value[key] : undefined), config)
