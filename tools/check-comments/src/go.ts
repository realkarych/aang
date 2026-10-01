import { closingIndex, comments, failure, lineEnd, type ScanResult } from './scan.js'

const directive = /^\/\/go:[a-z0-9_]+(?:[ \t]|$)/
const generatedMarker = /^\/\/ Code generated .* DO NOT EDIT\.$/

const interpretedEnd = (text: string, start: number): number | undefined => {
  const quote = text[start]
  let index = start + 1
  for (;;) {
    const char = text[index]
    if (char === undefined || char === '\n') {
      return undefined
    }
    if (char === quote) {
      return index + 1
    }
    index += char === '\\' && text[index + 1] !== '\n' ? 2 : 1
  }
}

export const scanGo = (text: string): ScanResult => {
  const offsets: number[] = []
  let beforePackageClause = true
  let generated = false
  let index = 0
  while (index < text.length) {
    const char = text[index] ?? ''
    const next = text[index + 1]
    if (char === '/' && next === '/') {
      const end = lineEnd(text, index)
      const comment = text.slice(index, end)
      const atLineStart = index === 0 || text[index - 1] === '\n'
      if (beforePackageClause && atLineStart && generatedMarker.test(comment)) {
        generated = true
      } else if (!directive.test(comment)) {
        offsets.push(index)
      }
      index = end
    } else if (char === '/' && next === '*') {
      const end = closingIndex(text, '*/', index + 2)
      if (end === undefined) {
        return failure(index, 'unterminated comment')
      }
      offsets.push(index)
      index = end
    } else if (char === '"' || char === "'") {
      const end = interpretedEnd(text, index)
      if (end === undefined) {
        return failure(index, char === '"' ? 'unterminated string literal' : 'unterminated rune literal')
      }
      beforePackageClause = false
      index = end
    } else if (char === '`') {
      const end = closingIndex(text, '`', index + 1)
      if (end === undefined) {
        return failure(index, 'unterminated raw string literal')
      }
      beforePackageClause = false
      index = end
    } else {
      if (!/\s/.test(char)) {
        beforePackageClause = false
      }
      index += 1
    }
  }
  return comments(generated ? [] : offsets)
}
