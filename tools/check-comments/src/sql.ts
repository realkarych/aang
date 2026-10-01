import { closingIndex, comments, failure, lineEnd, type ScanResult } from './scan.js'

interface Quote {
  readonly close: string
  readonly name: string
}

const quotes: ReadonlyMap<string, Quote> = new Map([
  ["'", { close: "'", name: 'string literal' }],
  ['"', { close: '"', name: 'quoted identifier' }],
  ['`', { close: '`', name: 'quoted identifier' }],
  ['[', { close: ']', name: 'quoted identifier' }],
])

const parameterPrefixes: ReadonlySet<string> = new Set(['$', '@', ':', '#'])

const isIdentifierChar = (char: string | undefined): boolean =>
  char !== undefined && (/[\w$]/.test(char) || char.charCodeAt(0) >= 0x80)

const isSpace = (char: string | undefined): boolean => char !== undefined && /[ \t\n\v\f\r]/.test(char)

const identifierEnd = (text: string, start: number): number => {
  let index = start
  while (isIdentifierChar(text[index])) {
    index += 1
  }
  return index
}

const parameterEnd = (text: string, start: number): number | undefined => {
  let index = start + 1
  let named = false
  for (;;) {
    const char = text[index]
    if (isIdentifierChar(char)) {
      named = true
      index += 1
    } else if (char === '(' && named) {
      do {
        index += 1
      } while (index < text.length && !isSpace(text[index]) && text[index] !== ')')
      return text[index] === ')' ? index + 1 : undefined
    } else if (char === ':' && text[index + 1] === ':') {
      index += 2
    } else {
      return index
    }
  }
}

export const scanSql = (text: string): ScanResult => {
  const offsets: number[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index] ?? ''
    const next = text[index + 1]
    const quote = quotes.get(char)
    if (char === '-' && next === '-') {
      offsets.push(index)
      index = lineEnd(text, index)
    } else if (char === '/' && next === '*') {
      const end = closingIndex(text, '*/', index + 2)
      if (end === undefined) {
        return failure(index, 'unterminated comment')
      }
      offsets.push(index)
      index = end
    } else if (quote) {
      const end = closingIndex(text, quote.close, index + 1)
      if (end === undefined) {
        return failure(index, `unterminated ${quote.name}`)
      }
      index = end
    } else if (parameterPrefixes.has(char)) {
      const end = parameterEnd(text, index)
      if (end === undefined) {
        return failure(index, 'unterminated parameter')
      }
      index = end
    } else if (isIdentifierChar(char)) {
      index = identifierEnd(text, index)
    } else {
      index += 1
    }
  }
  return comments(offsets)
}
