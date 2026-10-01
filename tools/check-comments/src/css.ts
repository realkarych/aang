import { closingIndex, comments, failure, type ScanResult } from './scan.js'

const isNameChar = (char: string | undefined): boolean =>
  char !== undefined && (/[\w-]/.test(char) || char.charCodeAt(0) >= 0x80)

const isNewline = (char: string | undefined): boolean => char === '\n' || char === '\r' || char === '\f'

const nameEnd = (text: string, start: number): number => {
  let index = start
  for (;;) {
    const char = text[index]
    if (char === '\\' && index + 1 < text.length && !isNewline(text[index + 1])) {
      index += 2
    } else if (isNameChar(char)) {
      index += 1
    } else {
      return index
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
    } else if (char === '\\') {
      index += 2
    } else if (isNameChar(char)) {
      const end = nameEnd(text, index)
      if (text.slice(index, end).toLowerCase() === 'url' && text[end] === '(') {
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
