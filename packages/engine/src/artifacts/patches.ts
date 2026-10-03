export interface Replacement {
  readonly before: string
  readonly after: string
  readonly all: boolean
}

export interface Hunk {
  readonly context: string | null
  readonly before: readonly string[]
  readonly after: readonly string[]
  readonly endOfFile: boolean
}

export type Patch =
  | { readonly kind: 'replace'; readonly edits: readonly Replacement[] }
  | { readonly kind: 'hunks'; readonly hunks: readonly Hunk[] }

const replaced = (content: string, { before, after, all }: Replacement): string | null => {
  if (before === '') {
    return null
  }
  const parts = content.split(before)
  const matches = parts.length - 1
  const strippedNewline = after === '' && !before.endsWith('\n') && content.includes(`${before}\n`)
  return matches === 0 || (matches > 1 && !all) || strippedNewline ? null : parts.join(after)
}

const matchesAt = (lines: readonly string[], pattern: readonly string[], at: number): boolean =>
  pattern.every((line, offset) => lines[at + offset] === line)

const seek = (lines: readonly string[], pattern: readonly string[], from: number, endOfFile: boolean): number | null => {
  if (pattern.length === 0) {
    return from
  }
  if (pattern.length > lines.length) {
    return null
  }
  for (let at = endOfFile ? lines.length - pattern.length : from; at + pattern.length <= lines.length; at += 1) {
    if (matchesAt(lines, pattern, at)) {
      return at
    }
  }
  return null
}

interface Splice {
  readonly at: number
  readonly length: number
  readonly lines: readonly string[]
}

const located = (lines: readonly string[], hunk: Hunk, from: number): Splice | null => {
  const found = seek(lines, hunk.before, from, hunk.endOfFile)
  if (found !== null || hunk.before.at(-1) !== '') {
    return found === null ? null : { at: found, length: hunk.before.length, lines: hunk.after }
  }
  const before = hunk.before.slice(0, -1)
  const after = hunk.after.at(-1) === '' ? hunk.after.slice(0, -1) : hunk.after
  const trimmed = seek(lines, before, from, hunk.endOfFile)
  return trimmed === null ? null : { at: trimmed, length: before.length, lines: after }
}

const splices = (lines: readonly string[], hunks: readonly Hunk[]): Splice[] | null => {
  const found: Splice[] = []
  let cursor = 0
  for (const hunk of hunks) {
    if (hunk.context !== null) {
      const context = seek(lines, [hunk.context], cursor, false)
      if (context === null) {
        return null
      }
      cursor = context + 1
    }
    if (hunk.before.length === 0) {
      found.push({ at: lines.at(-1) === '' ? lines.length - 1 : lines.length, length: 0, lines: hunk.after })
      continue
    }
    const splice = located(lines, hunk, cursor)
    if (splice === null) {
      return null
    }
    found.push(splice)
    cursor = splice.at + splice.length
  }
  return found.sort((left, right) => left.at - right.at)
}

const patched = (content: string, hunks: readonly Hunk[]): string | null => {
  const lines = content.split('\n')
  if (lines.at(-1) === '') {
    lines.pop()
  }
  const found = splices(lines, hunks)
  if (found === null) {
    return null
  }
  for (const { at, length, lines: replacement } of found.toReversed()) {
    lines.splice(at, length, ...replacement)
  }
  if (lines.at(-1) !== '') {
    lines.push('')
  }
  return lines.join('\n')
}

export const applyPatch = (patch: Patch, content: string): string | null => {
  if (patch.kind === 'hunks') {
    return patched(content, patch.hunks)
  }
  let result: string | null = content
  for (const edit of patch.edits) {
    result = result === null ? null : replaced(result, edit)
  }
  return result
}
