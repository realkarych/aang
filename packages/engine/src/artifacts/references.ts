import type { Fact, FactOf, JsonValue } from '@aang/contract'
import { fieldOf, type ShellDialect, shellScripts } from '../checks/commands.js'
import { actionDirectory, isWindowsPath, resolvedPath } from '../observations/directories.js'
import type { Hunk, Patch, Replacement } from './patches.js'
import { shellWrites } from './shell.js'

type Start = FactOf<'action_start'>

export type WriteKind = 'file_tool' | 'command'

export interface FilePatch {
  readonly base: string
  readonly change: Patch
}

export interface VersionCandidate {
  readonly path: string
  readonly content: string | null
  readonly patch: FilePatch | null
  readonly fact: Start
  readonly written: WriteKind
}

interface Named {
  readonly path: string
  readonly content: string | null
  readonly patch: FilePatch | null
}

const textOf = (value: JsonValue | undefined): string | null => (typeof value === 'string' && value !== '' ? value : null)

const claudeFileTools: ReadonlyMap<string, string> = new Map([
  ['Write', 'file_path'],
  ['Edit', 'file_path'],
  ['MultiEdit', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
])

const replacementOf = (edit: JsonValue): Replacement | null => {
  const before = fieldOf(edit, 'old_string')
  const after = fieldOf(edit, 'new_string')
  return typeof before === 'string' && typeof after === 'string'
    ? { before, after, all: fieldOf(edit, 'replace_all') === true }
    : null
}

const claudeEdits = (tool: string, input: JsonValue): Patch | null => {
  const listed = fieldOf(input, 'edits')
  const edits = tool === 'Edit' ? [input] : tool === 'MultiEdit' && Array.isArray(listed) ? listed : []
  const replacements = edits.map(replacementOf).filter((edit) => edit !== null)
  return replacements.length > 0 && replacements.length === edits.length ? { kind: 'replace', edits: replacements } : null
}

const claudeFile = (tool: string, input: JsonValue): Named[] => {
  const path = textOf(fieldOf(input, claudeFileTools.get(tool) ?? 'file_path'))
  if (path === null) {
    return []
  }
  const content = tool === 'Write' ? fieldOf(input, 'content') : undefined
  const change = claudeEdits(tool, input)
  return [{ path, content: typeof content === 'string' ? content : null, patch: change === null ? null : { base: path, change } }]
}

const fileHeader = /^\*\*\* (Add|Update|Delete) File: (.+)$/

const moveHeader = /^\*\*\* Move to: (.+)$/

const endOfFile = '*** End of File'

interface HunkDraft {
  readonly context: string | null
  readonly before: string[]
  readonly after: string[]
  endOfFile: boolean
}

type Section =
  | { readonly kind: 'add'; readonly path: string; readonly lines: string[]; valid: boolean }
  | { readonly kind: 'update'; readonly path: string; target: string; readonly hunks: HunkDraft[]; valid: boolean }

const sectionFile = (section: Section): Named => {
  if (section.kind === 'add') {
    return { path: section.path, content: section.valid ? section.lines.map((line) => `${line}\n`).join('') : null, patch: null }
  }
  const hunks: Hunk[] = section.hunks
  const patched = section.valid && hunks.length > 0
  return { path: section.target, content: null, patch: patched ? { base: section.path, change: { kind: 'hunks', hunks } } : null }
}

const opened = (header: RegExpExecArray): Section | null => {
  const [, operation, path = ''] = header
  return operation === 'Add'
    ? { kind: 'add', path, lines: [], valid: true }
    : operation === 'Update'
      ? { kind: 'update', path, target: path, hunks: [], valid: true }
      : null
}

const hunkLine = /^([ +-]?)(.*)$/s

const withUpdateLine = (section: Extract<Section, { kind: 'update' }>, line: string): void => {
  if (line === '@@' || line.startsWith('@@ ')) {
    section.hunks.push({ context: line === '@@' ? null : line.slice(3), before: [], after: [], endOfFile: false })
    return
  }
  const current = section.hunks.at(-1)
  if (line === endOfFile) {
    section.valid &&= current !== undefined
    if (current !== undefined) {
      current.endOfFile = true
    }
    return
  }
  const [, marker = '', text = ''] = hunkLine.exec(line) ?? []
  if (marker === '' && line !== '') {
    section.valid = false
    return
  }
  const hunk = current ?? { context: null, before: [], after: [], endOfFile: false }
  if (current === undefined) {
    section.hunks.push(hunk)
  }
  if (marker !== '+') {
    hunk.before.push(text)
  }
  if (marker !== '-') {
    hunk.after.push(text)
  }
}

const withLine = (section: Section | null, line: string): void => {
  if (section?.kind === 'add') {
    if (line.startsWith('+')) {
      section.lines.push(line.slice(1))
    } else {
      section.valid = false
    }
  } else if (section?.kind === 'update') {
    withUpdateLine(section, line)
  }
}

const patchFiles = (patch: string): Named[] => {
  const lines = patch.split('\n').map((line) => line.replace(/\r$/, ''))
  if (lines.at(-1) === '') {
    lines.pop()
  }
  const files: Named[] = []
  let section: Section | null = null
  const close = (): void => {
    if (section !== null) {
      files.push(sectionFile(section))
    }
    section = null
  }
  for (const line of lines) {
    const header = fileHeader.exec(line)
    const move = moveHeader.exec(line)
    if (header !== null) {
      close()
      section = opened(header)
    } else if (move !== null && section?.kind === 'update' && section.hunks.length === 0) {
      section.target = move[1] ?? section.target
    } else if (line.startsWith('***') && line !== endOfFile) {
      close()
    } else {
      withLine(section, line)
    }
  }
  close()
  return files
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
      return [{ path, content: typeof content === 'string' ? content : null, patch: null }]
    }
    if (type === 'update') {
      return [{ path: moved ?? path, content: null, patch: null }]
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

const hostDialect: ShellDialect = process.platform === 'win32' ? 'powershell' : 'posix'

const sessionDialect = (directory: string | null): ShellDialect =>
  directory === null ? hostDialect : isWindowsPath(directory) ? 'powershell' : 'posix'

const dialectOf = ({ entity_key, payload }: Start, directory: string | null): ShellDialect =>
  payload.tool === 'PowerShell' ? 'powershell' : entity_key.runtime === 'claude' ? 'posix' : sessionDialect(directory)

const commandWrites = (start: Start, directory: string | null): { readonly paths: readonly string[]; readonly base: string | null } => {
  const writes = shellScripts(start.payload.input, dialectOf(start, directory)).map(shellWrites)
  return {
    paths: writes.flatMap(({ targets }) => targets),
    base: writes.some(({ changesDirectory }) => changesDirectory) ? null : directory,
  }
}

const candidatesOf = (start: Start, directory: string | null): VersionCandidate[] => {
  if (start.payload.action_kind === 'file_write') {
    return fileTool(start).flatMap(({ path, content, patch }) => {
      const target = resolvedPath(path, directory)
      const base = patch === null ? null : resolvedPath(patch.base, directory)
      const resolved = patch === null || base === null ? null : { base, change: patch.change }
      return target === null ? [] : [{ path: target, content, patch: resolved, fact: start, written: 'file_tool' as const }]
    })
  }
  if (start.payload.action_kind === 'command') {
    const { paths, base } = commandWrites(start, directory)
    return paths.flatMap((path) => {
      const target = resolvedPath(path, base)
      return target === null ? [] : [{ path: target, content: null, patch: null, fact: start, written: 'command' as const }]
    })
  }
  return []
}

export const actionCandidates = (facts: readonly Fact[], session: string | null): VersionCandidate[] => {
  const starts = facts.filter((fact): fact is Start => fact.kind === 'action_start')
  const directory = actionDirectory(starts, session)
  return starts.flatMap((start) => candidatesOf(start, directory))
}
