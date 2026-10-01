import { closingIndex, comments, failure, lineEnd, type ScanResult } from './scan.js'

const directiveNames: readonly string[] = [
  'build',
  'generate',
  'embed',
  'noinline',
  'nosplit',
  'noescape',
  'norace',
  'nocheckptr',
  'linkname',
  'uintptrescapes',
  'uintptrkeepalive',
  'wasmimport',
  'wasmexport',
  'debug',
]
const directive = new RegExp(`^//go:(?:${directiveNames.join('|')})(?:[ \\t]|$)`)
const generatedMarker = /^\/\/ Code generated .* DO NOT EDIT\.$/
const lineDirectivePrefix = 'line '
const maxPosition = 2 ** 30

interface TrailingNumber {
  readonly rest: string
  readonly value: number
}

const trailingNumber = (text: string): TrailingNumber | undefined => {
  const colon = text.lastIndexOf(':')
  const digits = text.slice(colon + 1)
  return colon >= 0 && /^\d+$/.test(digits) ? { rest: text.slice(0, colon), value: Number(digits) } : undefined
}

const isPosition = (value: number): boolean => value >= 1 && value <= maxPosition

const isLineDirective = (body: string): boolean => {
  if (!body.startsWith(lineDirectivePrefix) || /[\r\n]/.test(body)) {
    return false
  }
  const last = trailingNumber(body.slice(lineDirectivePrefix.length))
  if (last === undefined || !isPosition(last.value)) {
    return false
  }
  const previous = trailingNumber(last.rest)
  return previous === undefined || isPosition(previous.value)
}

const startsLine = (text: string, index: number): boolean => {
  let before = index - 1
  while (text[before] === ' ' || text[before] === '\t') {
    before -= 1
  }
  return before < 0 || text[before] === '\n'
}

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
      } else if (
        !(startsLine(text, index) && directive.test(comment)) &&
        !(atLineStart && isLineDirective(comment.slice(2)))
      ) {
        offsets.push(index)
      }
      index = end
    } else if (char === '/' && next === '*') {
      const end = closingIndex(text, '*/', index + 2)
      if (end === undefined) {
        return failure(index, 'unterminated comment')
      }
      if (!isLineDirective(text.slice(index + 2, end - 2))) {
        offsets.push(index)
      }
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
