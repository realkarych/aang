import { comments, failure, lineEnd, type ScanResult } from './scan.js'

interface Line {
  readonly offset: number
  readonly text: string
}

interface Word {
  readonly start: number
  readonly text: string
}

interface Heredoc {
  readonly delimiter: string
  readonly stripsTabs: boolean
}

const parserDirective = /^[ \t]*#[ \t]*(?:syntax|escape|check)[ \t]*=/i
const backtickEscape = /^[ \t]*#[ \t]*escape[ \t]*=[ \t]*`[ \t]*$/i
const commentStart = /^[ \t]*#/
const blankLine = /^[ \t]*$/
const backslashContinuation = /\\[ \t]*$/
const backtickContinuation = /`[ \t]*$/
const shellWord = /(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.?|[^ \t'"\\])+/gs
const shellQuoting = /'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.?)/gs
const doubleQuotedEscape = /\\(["$\\])/g
const heredocWord = /^\d*<<(-?)([^<]*)$/
const heredocInstructions = new Set(['run', 'copy', 'add'])

const linesOf = (text: string): Line[] => {
  const lines: Line[] = []
  let offset = 0
  while (offset < text.length) {
    const end = lineEnd(text, offset)
    lines.push({ offset, text: text.slice(offset, end) })
    offset = end + (text.startsWith('\r\n', end) ? 2 : 1)
  }
  return lines
}

const readerOf = (lines: readonly Line[], from: number): (() => Line | undefined) => {
  let index = from
  return () => {
    const line = lines[index]
    index += 1
    return line
  }
}

const leadingDirectives = (lines: readonly Line[]): readonly Line[] => {
  const end = lines.findIndex(({ text }) => !parserDirective.test(text))
  return end === -1 ? lines : lines.slice(0, end)
}

const wordsOf = (text: string): Word[] => {
  const words = [...text.matchAll(shellWord)].map((match) => ({ start: match.index, text: match[0] }))
  return blankLine.test(text.replace(shellWord, '')) ? words : []
}

const unquoted = (word: string): string =>
  word.replace(
    shellQuoting,
    (_match, single: string | undefined, double: string | undefined, escaped: string | undefined) =>
      single ?? double?.replace(doubleQuotedEscape, '$1') ?? escaped ?? '',
  )

const isJsonArray = (text: string): boolean => {
  try {
    return Array.isArray(JSON.parse(text))
  } catch {
    return false
  }
}

const heredocOf = ({ text }: Word): Heredoc[] => {
  const [, chomp, word = ''] = heredocWord.exec(text) ?? []
  return word === '' ? [] : [{ delimiter: unquoted(word), stripsTabs: chomp === '-' }]
}

const heredocsOf = (instruction: string): Heredoc[] => {
  const words = wordsOf(instruction)
  const [keyword, ...operands] = words[0]?.text.toLowerCase() === 'onbuild' ? words.slice(1) : words
  const first = operands.find(({ text }) => !text.startsWith('--'))
  return keyword === undefined ||
    !heredocInstructions.has(keyword.text.toLowerCase()) ||
    first === undefined ||
    isJsonArray(instruction.slice(first.start))
    ? []
    : operands.flatMap(heredocOf)
}

const closes = (heredoc: Heredoc, line: string): boolean =>
  (heredoc.stripsTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter

export const scanDockerfile = (text: string): ScanResult => {
  const lines = linesOf(text)
  const directives = leadingDirectives(lines)
  const continuation = directives.some((line) => backtickEscape.test(line.text))
    ? backtickContinuation
    : backslashContinuation
  const next = readerOf(lines, directives.length)
  const offsets: number[] = []
  const recordComment = (line: Line): boolean => {
    const comment = commentStart.exec(line.text)
    if (comment !== null) {
      offsets.push(line.offset + comment[0].length - 1)
    }
    return comment !== null
  }
  const instructionFrom = (line: Line): string => {
    let instruction = line.text.replace(continuation, '')
    let continued = continuation.test(line.text)
    for (let part = continued ? next() : undefined; part !== undefined; part = continued ? next() : undefined) {
      if (!recordComment(part) && !blankLine.test(part.text)) {
        continued = continuation.test(part.text)
        instruction += part.text.replace(continuation, '')
      }
    }
    return instruction
  }
  const terminates = (heredoc: Heredoc): boolean => {
    for (let line = next(); line !== undefined; line = next()) {
      if (closes(heredoc, line.text)) {
        return true
      }
    }
    return false
  }
  for (let line = next(); line !== undefined; line = next()) {
    if (!recordComment(line) && !heredocsOf(instructionFrom(line)).every(terminates)) {
      return failure(line.offset, 'unterminated heredoc')
    }
  }
  return comments(offsets)
}

export const scanDockerignore = (text: string): ScanResult =>
  comments(linesOf(text).flatMap((line) => (line.text.startsWith('#') ? [line.offset] : [])))
