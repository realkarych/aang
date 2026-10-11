import { mergeProcessCovs, type ProcessCov, type ScriptCov } from '@bcoe/v8-coverage'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const usage = 'Usage: node tools/coverage/dist/main.js <raw coverage directory> <merged file>'

const C8Config = z.object({
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
})
type C8Config = z.infer<typeof C8Config>

interface RawCoverage {
  readonly result: ScriptCov[]
  readonly 'source-map-cache'?: Readonly<Record<string, unknown>>
}

interface MergedCoverage {
  readonly coverage: RawCoverage
  readonly files: number
  readonly skipped: number
}

const rawCoverage = (text: string): RawCoverage | undefined => {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && 'result' in value && Array.isArray(value.result)
      ? (value as RawCoverage)
      : undefined
  } catch {
    return undefined
  }
}

const selection = ({ include, exclude }: C8Config, root: string): ((url: string) => boolean) => {
  const excluded = [...exclude, '**/node_modules/**']
  const decisions = new Map<string, boolean>()
  const decide = (url: string): boolean => {
    if (!url.startsWith('file:')) {
      return false
    }
    const path = relative(root, fileURLToPath(url))
    if (path.startsWith('..') || isAbsolute(path)) {
      return false
    }
    const file = path.split(sep).join(posix.sep)
    const matches = (glob: string): boolean => posix.matchesGlob(file, glob)
    return (include.length === 0 || include.some(matches)) && !excluded.some(matches)
  }
  return (url) => {
    const known = decisions.get(url)
    if (known !== undefined) {
      return known
    }
    const decision = decide(url)
    decisions.set(url, decision)
    return decision
  }
}

const mergeDirectory = async (directory: string, selected: (url: string) => boolean): Promise<MergedCoverage> => {
  let merged: ProcessCov = { result: [] }
  const sourceMaps: Record<string, unknown> = {}
  let files = 0
  let skipped = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue
    }
    const raw = rawCoverage(await readFile(join(directory, entry.name), 'utf8'))
    if (raw === undefined) {
      skipped += 1
      continue
    }
    files += 1
    for (const [url, sourceMap] of Object.entries(raw['source-map-cache'] ?? {})) {
      if (selected(url)) {
        sourceMaps[url] = sourceMap
      }
    }
    merged = mergeProcessCovs([merged, { result: raw.result.filter((script) => selected(script.url)) }])
  }
  return { coverage: { result: merged.result, 'source-map-cache': sourceMaps }, files, skipped }
}

const main = async (args: readonly string[]): Promise<number> => {
  const [source, target, ...rest] = args
  if (source === undefined || target === undefined || rest.length > 0) {
    process.stderr.write(`${usage}\n`)
    return 2
  }
  const root = process.cwd()
  const config = C8Config.parse(JSON.parse(await readFile(join(root, '.c8rc.json'), 'utf8')))
  const { coverage, files, skipped } = await mergeDirectory(resolve(source), selection(config, root))
  if (files === 0) {
    throw new Error(`no V8 coverage files in ${source}`)
  }
  await mkdir(dirname(resolve(target)), { recursive: true })
  await writeFile(resolve(target), JSON.stringify(coverage))
  const unreadable = skipped > 0 ? `, ${String(skipped)} unreadable skipped` : ''
  process.stdout.write(`${String(files)} V8 coverage files merged into ${target}${unreadable}\n`)
  return 0
}

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  return 1
})
