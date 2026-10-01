import { readFileSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { describeError, discover, isSkipped } from './files.js'
import { languageOf } from './languages.js'
import { positionLocator } from './position.js'

interface Output {
  readonly violations: string[]
  readonly problems: string[]
}

const check = (args: readonly string[], cwd: string): Output => {
  const display = (path: string | undefined): string =>
    path === undefined ? 'check-comments' : relative(cwd, path).split(sep).join('/')
  const { base, files, problems } = discover(args, cwd)
  const output: Output = {
    violations: [],
    problems: problems.map((problem) => `${display(problem.path)}: ${problem.message}`),
  }
  for (const path of files) {
    const language = languageOf(path)
    if (language === undefined || isSkipped(base, path)) {
      continue
    }
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      output.problems.push(`${display(path)}: cannot read: ${describeError(error)}`)
      continue
    }
    const result = language.scan(text, path)
    const locate = positionLocator(text)
    const at = (offset: number): string => {
      const { line, column } = locate(offset)
      return `${display(path)}:${line}:${column}`
    }
    if (result.kind === 'error') {
      output.problems.push(`${at(result.offset)}: cannot check ${language.name}: ${result.message}`)
    } else {
      output.violations.push(...result.offsets.map((offset) => `${at(offset)}: ${language.name} comment`))
    }
  }
  return output
}

const write = (stream: NodeJS.WriteStream, lines: readonly string[]): void => {
  if (lines.length > 0) {
    stream.write(`${lines.join('\n')}\n`)
  }
}

try {
  const { violations, problems } = check(process.argv.slice(2), process.cwd())
  write(process.stdout, violations)
  write(process.stderr, problems)
  process.exitCode = problems.length > 0 ? 2 : violations.length > 0 ? 1 : 0
} catch (error) {
  write(process.stderr, [`check-comments: ${error instanceof Error ? error.message : String(error)}`])
  process.exitCode = 2
}
