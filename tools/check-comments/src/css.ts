import { closingIndex, comments, failure, type ScanResult } from './scan.js'

const isNameChar = (char: string | undefined): char is string =>
  char !== undefined && (/[\w-]/.test(char) || char.charCodeAt(0) >= 0x80)

const isNewline = (char: string | undefined): boolean => char === '\n' || char === '\r' || char === '\f'

const isWhitespace = (char: string | undefined): boolean => char === ' ' || char === '\t' || isNewline(char)

const isHexDigit = (char: string | undefined): boolean => char !== undefined && /[\da-f]/i.test(char)

const isEscape = (text: string, index: number): boolean =>
  text[index] === '\\' && index + 1 < text.length && !isNewline(text[index + 1])

const replacementCharacter = '\ufffd'

interface Ident {
  readonly end: number
  readonly value: string
}

const escaped = (text: string, start: number): Ident => {
  let index = start + 1
  if (!isHexDigit(text[index])) {
    const value = String.fromCodePoint(text.codePointAt(index) ?? 0xfffd)
    return { end: index + value.length, value }
  }
  const digitsStart = index
  while (index - digitsStart < 6 && isHexDigit(text[index])) {
    index += 1
  }
  const codePoint = Number.parseInt(text.slice(digitsStart, index), 16)
  const end = text.startsWith('\r\n', index) ? index + 2 : isWhitespace(text[index]) ? index + 1 : index
  const valid = codePoint !== 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
  return { end, value: valid ? String.fromCodePoint(codePoint) : replacementCharacter }
}

const ident = (text: string, start: number): Ident => {
  let index = start
  let value = ''
  for (;;) {
    const char = text[index]
    if (isEscape(text, index)) {
      const escape = escaped(text, index)
      value += escape.value
      index = escape.end
    } else if (isNameChar(char)) {
      value += char
      index += 1
    } else {
      return { end: index, value }
    }
  }
}

const stringEnd = (text: string, start: number): number | undefined => {
  const quote = text[start]
  let index = start + 1
  for (;;) {
    const char = text[index]
    if (char === undefined || isNewline(char)) {
      return undefined
    }
    if (char === quote) {
      return index + 1
    }
    index += char !== '\\' ? 1 : text.startsWith('\r\n', index + 1) ? 3 : 2
  }
}

const unquotedUrlEnd = (text: string, start: number): number | undefined => {
  let index = start
  while (/\s/.test(text[index] ?? '')) {
    index += 1
  }
  if (text[index] === '"' || text[index] === "'") {
    return start
  }
  for (;;) {
    const char = text[index]
    if (char === undefined) {
      return undefined
    }
    if (char === ')') {
      return index + 1
    }
    index += char === '\\' ? 2 : 1
  }
}

export const scanCss = (text: string): ScanResult => {
  const offsets: number[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '/' && text[index + 1] === '*') {
      const end = closingIndex(text, '*/', index + 2)
      if (end === undefined) {
        return failure(index, 'unterminated comment')
      }
      offsets.push(index)
      index = end
    } else if (char === '"' || char === "'") {
      const end = stringEnd(text, index)
      if (end === undefined) {
        return failure(index, 'unterminated string')
      }
      index = end
    } else if (char === '#' || char === '@') {
      index = ident(text, index + 1).end
    } else if (isNameChar(char) || isEscape(text, index)) {
      const { end, value } = ident(text, index)
      if (/^url$/i.test(value) && text[end] === '(') {
        const urlEnd = unquotedUrlEnd(text, end + 1)
        if (urlEnd === undefined) {
          return failure(index, 'unterminated url')
        }
        index = urlEnd
      } else {
        index = end
      }
    } else {
      index += 1
    }
  }
  return comments(offsets)
}
