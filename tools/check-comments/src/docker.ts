import { comments, failure, lineEnd, type ScanResult } from './scan.js'

interface Line {
  readonly offset: number
  readonly text: string
}

interface Heredoc {
  readonly offset: number
  readonly delimiter: string
  readonly stripsTabs: boolean
}

const parserDirective = /^[ \t]*#[ \t]*(?:syntax|escape|check)[ \t]*=/i
const commentStart = /^[ \t]*#/
const heredocStart = /<<(-?)(["']?)([A-Za-z_][\w.-]*)\2/g

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

const heredocsOf = (line: Line): Heredoc[] =>
  [...line.text.matchAll(heredocStart)].map((match) => ({
    offset: line.offset + match.index,
    delimiter: match[3] ?? '',
    stripsTabs: match[1] === '-',
  }))

const closes = (heredoc: Heredoc, line: string): boolean =>
  (heredoc.stripsTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter

export const scanDockerfile = (text: string): ScanResult => {
  const offsets: number[] = []
  let directives = true
  let heredocs: Heredoc[] = []
  for (const line of linesOf(text)) {
    const [heredoc, ...later] = heredocs
    if (heredoc !== undefined) {
      heredocs = closes(heredoc, line.text) ? later : heredocs
      continue
    }
    if (directives && parserDirective.test(line.text)) {
      continue
    }
    directives = false
    const comment = commentStart.exec(line.text)
    if (comment === null) {
      heredocs = heredocsOf(line)
    } else {
      offsets.push(line.offset + comment[0].length - 1)
    }
  }
  const [unterminated] = heredocs
  return unterminated === undefined ? comments(offsets) : failure(unterminated.offset, 'unterminated heredoc')
}

export const scanDockerignore = (text: string): ScanResult =>
  comments(linesOf(text).flatMap((line) => (line.text.startsWith('#') ? [line.offset] : [])))
