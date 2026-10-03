export interface ShellWrites {
  readonly targets: readonly string[]
  readonly changesDirectory: boolean
}

interface Word {
  readonly kind: 'word'
  readonly text: string
  readonly dynamic: boolean
  readonly digits: boolean
}

type Token =
  | Word
  | { readonly kind: 'separator' }
  | { readonly kind: 'write'; readonly adjacent: boolean }
  | { readonly kind: 'other'; readonly adjacent: boolean }

interface Heredoc {
  readonly delimiter: string
  readonly stripTabs: boolean
}

const blank = /[ \t\r]/

const wordEnd = /[ \t\r\n|&;()<>]/

const directoryCommands: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd'])

const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/

const closing = (script: string, from: number, open: string, close: string): number => {
  let depth = 0
  for (let index = from; index < script.length; index += 1) {
    if (script.startsWith(open, index)) {
      depth += 1
      index += open.length - 1
    } else if (script.startsWith(close, index)) {
      depth -= 1
      if (depth === 0) {
        return index + close.length
      }
      index += close.length - 1
    }
  }
  return script.length
}

const lineEnd = (script: string, from: number): number => {
  const end = script.indexOf('\n', from)
  return end < 0 ? script.length : end
}

const skipHeredocs = (script: string, from: number, heredocs: readonly Heredoc[]): number => {
  let index = from
  for (const { delimiter, stripTabs } of heredocs) {
    while (index < script.length) {
      const end = lineEnd(script, index)
      const line = script.slice(index, end).replace(/\r$/, '')
      index = end + 1
      if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) {
        break
      }
    }
  }
  return Math.min(index, script.length)
}

const readWord = (script: string, from: number): { readonly word: Word; readonly end: number } => {
  let text = ''
  let dynamic = false
  let index = from
  while (index < script.length && !wordEnd.test(script[index] ?? '')) {
    const char = script[index] ?? ''
    if (char === '\\') {
      text += script[index + 1] ?? ''
      index += 2
    } else if (char === "'") {
      const end = script.indexOf("'", index + 1)
      const stop = end < 0 ? script.length : end
      text += script.slice(index + 1, stop)
      index = stop + 1
    } else if (char === '"') {
      index += 1
      while (index < script.length && script[index] !== '"') {
        const inner = script[index] ?? ''
        if (inner === '$' || inner === '`') {
          dynamic = true
        }
        if (inner === '\\' && index + 1 < script.length) {
          index += 1
        }
        text += script[index] ?? ''
        index += 1
      }
      index += 1
    } else if (char === '$' && script[index + 1] === '(') {
      dynamic = true
      index = closing(script, index + 1, '(', ')')
    } else if (char === '`') {
      dynamic = true
      const end = script.indexOf('`', index + 1)
      index = end < 0 ? script.length : end + 1
    } else {
      if ('$*?[{~'.includes(char) && !(char === '~' && index > from)) {
        dynamic = true
      }
      text += char
      index += 1
    }
  }
  return { word: { kind: 'word', text, dynamic, digits: /^\d+$/.test(text) }, end: index }
}

const operators: readonly (readonly [string, 'write' | 'other' | 'separator'])[] = [
  ['&>>', 'write'],
  ['&>', 'write'],
  ['>>', 'write'],
  ['>|', 'write'],
  ['>&', 'other'],
  ['<&', 'other'],
  ['<<<', 'other'],
  ['<>', 'other'],
  ['>', 'write'],
  ['<', 'other'],
  ['||', 'separator'],
  ['|&', 'separator'],
  ['&&', 'separator'],
  ['|', 'separator'],
  [';', 'separator'],
  ['&', 'separator'],
  ['(', 'separator'],
  [')', 'separator'],
]

const tokenize = (script: string): Token[] => {
  const tokens: Token[] = []
  let heredocs: Heredoc[] = []
  let index = 0
  let adjacent = false
  while (index < script.length) {
    const char = script[index] ?? ''
    if (char === '\n') {
      tokens.push({ kind: 'separator' })
      index = heredocs.length === 0 ? index + 1 : skipHeredocs(script, index + 1, heredocs)
      heredocs = []
      adjacent = false
      continue
    }
    if (blank.test(char)) {
      index += 1
      adjacent = false
      continue
    }
    if (char === '\\' && script[index + 1] === '\n') {
      index += 2
      continue
    }
    if (char === '#' && !adjacent) {
      index = lineEnd(script, index)
      continue
    }
    if (script.startsWith('[[', index) && !adjacent) {
      const end = script.indexOf(']]', index + 2)
      index = end < 0 ? script.length : end + 2
      adjacent = true
      continue
    }
    if (script.startsWith('((', index) || script.startsWith('$((', index)) {
      index = closing(script, script.indexOf('((', index), '((', '))')
      adjacent = true
      continue
    }
    if ((char === '>' || char === '<') && script[index + 1] === '(') {
      index = closing(script, index + 1, '(', ')')
      adjacent = true
      continue
    }
    if (script.startsWith('<<', index) && script[index + 2] !== '<') {
      const stripTabs = script[index + 2] === '-'
      let start = index + (stripTabs ? 3 : 2)
      while (blank.test(script[start] ?? '')) {
        start += 1
      }
      const { word, end } = readWord(script, start)
      heredocs.push({ delimiter: word.text, stripTabs })
      index = end
      adjacent = true
      continue
    }
    const operator = operators.find(([symbol]) => script.startsWith(symbol, index))
    if (operator !== undefined) {
      const [symbol, kind] = operator
      tokens.push(kind === 'separator' ? { kind } : { kind, adjacent })
      index += symbol.length
      adjacent = false
      continue
    }
    const { word, end } = readWord(script, index)
    tokens.push(word)
    index = end
    adjacent = true
  }
  return tokens
}

const isFile = (word: Word): boolean => !word.dynamic && word.text !== '' && word.text !== '-' && !word.text.startsWith('/dev/')

export const shellWrites = (script: string): ShellWrites => {
  const targets: string[] = []
  let changesDirectory = false
  let words: Word[] = []
  const finishCommand = (): void => {
    const command = words.findIndex(({ text }) => !assignment.test(text))
    const [name, ...rest] = command < 0 ? [] : words.slice(command)
    const program = name?.text.split('/').at(-1) ?? ''
    if (directoryCommands.has(program)) {
      changesDirectory = true
    }
    if (program === 'tee') {
      targets.push(...rest.filter((word) => !word.text.startsWith('-') && isFile(word)).map(({ text }) => text))
    }
    words = []
  }
  const tokens = tokenize(script)
  let operand = false
  for (const [index, token] of tokens.entries()) {
    if (operand) {
      operand = false
      continue
    }
    switch (token.kind) {
      case 'separator':
        finishCommand()
        break
      case 'word':
        words.push(token)
        break
      case 'write':
      case 'other': {
        const previous = words.at(-1)
        if (token.adjacent && previous?.digits === true) {
          words.pop()
        }
        const next = tokens[index + 1]
        operand = next?.kind === 'word'
        if (next?.kind === 'word' && token.kind === 'write' && isFile(next)) {
          targets.push(next.text)
        }
      }
    }
  }
  finishCommand()
  return { targets: [...new Set(targets)], changesDirectory }
}
