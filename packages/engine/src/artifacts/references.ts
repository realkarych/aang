import { isAbsolute, resolve } from 'node:path'
import type { Fact, FactOf, JsonValue } from '@aang/contract'
import { fieldOf, shellScripts } from '../checks/commands.js'
import { shellWrites } from './shell.js'

type Start = FactOf<'action_start'>

export type WriteKind = 'file_tool' | 'command'

export interface VersionCandidate {
  readonly path: string
  readonly content: string | null
  readonly fact: Start
  readonly written: WriteKind
}

interface Named {
  readonly path: string
  readonly content: string | null
}

const textOf = (value: JsonValue | undefined): string | null => (typeof value === 'string' && value !== '' ? value : null)

const claudeFileTools: ReadonlyMap<string, string> = new Map([
  ['Write', 'file_path'],
  ['Edit', 'file_path'],
  ['MultiEdit', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
])

const claudeFile = (tool: string, input: JsonValue): Named[] => {
  const path = textOf(fieldOf(input, claudeFileTools.get(tool) ?? 'file_path'))
  const content = tool === 'Write' ? fieldOf(input, 'content') : undefined
  return path === null ? [] : [{ path, content: typeof content === 'string' ? content : null }]
}

const fileHeader = /^\*\*\* (Add|Update|Delete) File: (.+)$/

const moveHeader = /^\*\*\* Move to: (.+)$/

type Section =
  | { readonly kind: 'add'; readonly path: string; readonly lines: readonly string[]; readonly valid: boolean }
  | { readonly kind: 'update'; readonly path: string }
  | null

const sectionFile = (section: Section): Named[] => {
  if (section === null) {
    return []
  }
  return section.kind === 'add'
    ? [{ path: section.path, content: section.valid ? section.lines.map((line) => `${line}\n`).join('') : null }]
    : [{ path: section.path, content: null }]
}

const opened = (header: RegExpExecArray): Section => {
  const [, operation, path = ''] = header
  return operation === 'Add'
    ? { kind: 'add', path, lines: [], valid: true }
    : operation === 'Update'
      ? { kind: 'update', path }
      : null
}

const withLine = (section: Section, line: string): Section => {
  if (section?.kind !== 'add') {
    return section
  }
  return line.startsWith('+')
    ? { ...section, lines: [...section.lines, line.slice(1)] }
    : { ...section, valid: false }
}

const patchFiles = (patch: string): Named[] => {
  const lines = patch.split('\n').map((line) => line.replace(/\r$/, ''))
  if (lines.at(-1) === '') {
    lines.pop()
  }
  const files: Named[] = []
  let section: Section = null
  for (const line of lines) {
    const header = fileHeader.exec(line)
    const move = moveHeader.exec(line)
    if (header !== null) {
      files.push(...sectionFile(section))
      section = opened(header)
    } else if (move !== null && section?.kind === 'update') {
      section = { kind: 'update', path: move[1] ?? section.path }
    } else if (line.startsWith('***')) {
      files.push(...sectionFile(section))
      section = null
    } else {
      section = withLine(section, line)
    }
  }
  return [...files, ...sectionFile(section)]
}

const codexPatch = (input: JsonValue): Named[] => {
  const patch = typeof input === 'string' ? input : textOf(fieldOf(input, 'command'))
  return patch === null ? [] : patchFiles(patch)
}

const codexFileChange = (input: JsonValue): Named[] => {
  const changes = fieldOf(input, 'changes')
  const entries = changes !== null && typeof changes === 'object' && !Array.isArray(changes) ? Object.entries(changes) : []
  return entries.flatMap(([path, change]): Named[] => {
    const type = fieldOf(change, 'type')
    const content = fieldOf(change, 'content')
    const moved = textOf(fieldOf(change, 'move_path'))
    if (type === 'add') {
      return [{ path, content: typeof content === 'string' ? content : null }]
    }
    if (type === 'update') {
      return [{ path: moved ?? path, content: null }]
    }
    return []
  })
}

const fileTool = (start: Start): Named[] => {
  const { tool, input } = start.payload
  if (start.entity_key.runtime === 'claude') {
    return claudeFile(tool, input)
  }
  if (tool === 'apply_patch') {
    return codexPatch(input)
  }
  return tool === 'FileChange' ? codexFileChange(input) : []
}

const commandWrites = (start: Start): { readonly paths: readonly string[]; readonly base: string | null } => {
  const writes = shellScripts(start.payload.input).map(shellWrites)
  const workdir = textOf(fieldOf(start.payload.input, 'workdir'))
  const base = writes.some(({ changesDirectory }) => changesDirectory)
    ? null
    : workdir !== null && isAbsolute(workdir)
      ? workdir
      : start.runtime_env.cwd
  return { paths: writes.flatMap(({ targets }) => targets), base }
}

const absolute = (path: string, base: string | null): string | null =>
  isAbsolute(path) ? resolve(path) : base === null ? null : resolve(base, path)

const candidatesOf = (start: Start): VersionCandidate[] => {
  if (start.payload.action_kind === 'file_write') {
    return fileTool(start).flatMap(({ path, content }) => {
      const target = absolute(path, start.runtime_env.cwd)
      return target === null ? [] : [{ path: target, content, fact: start, written: 'file_tool' as const }]
    })
  }
  if (start.payload.action_kind === 'command') {
    const { paths, base } = commandWrites(start)
    return paths.flatMap((path) => {
      const target = absolute(path, base)
      return target === null ? [] : [{ path: target, content: null, fact: start, written: 'command' as const }]
    })
  }
  return []
}

export const actionCandidates = (facts: readonly Fact[]): VersionCandidate[] =>
  facts.flatMap((fact) => (fact.kind === 'action_start' ? candidatesOf(fact) : []))
