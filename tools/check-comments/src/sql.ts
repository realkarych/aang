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
    } else {
      index += 1
    }
  }
  return comments(offsets)
}
