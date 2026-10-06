import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const stamp = /("timestamp":\s*")(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)(")/g

interface ManifestDocument {
  readonly steps: readonly Readonly<Record<string, unknown>>[]
}

const sourceOf = (step: Readonly<Record<string, unknown>>): string | null => {
  const source = step['source']
  return typeof source === 'string' ? source : null
}

const isLog = (source: string): boolean => source.endsWith('.jsonl')

export type Replacement = readonly [string, string]

const replaced = (text: string, replacements: readonly Replacement[]): string =>
  replacements.reduce((current, [from, to]) => current.replaceAll(from, to), text)

export const freshManifest = async (
  manifest: string,
  directory: string,
  replacements: readonly Replacement[] = [],
  now = Date.now(),
): Promise<string> => {
  const document = JSON.parse(await readFile(manifest, 'utf8')) as ManifestDocument
  const sources = [...new Set(document.steps.flatMap((step) => sourceOf(step) ?? []))]
  const contents = new Map(
    await Promise.all(
      sources.map(async (source) => [source, await readFile(resolve(dirname(manifest), ...source.split('/')))] as const),
    ),
  )
  const times = sources
    .filter(isLog)
    .flatMap((source) => [...(contents.get(source)?.toString('utf8') ?? '').matchAll(stamp)].map((match) => Date.parse(match[2] ?? '')))
  const shift = times.length === 0 ? 0 : now - Math.max(...times)
  await mkdir(directory, { recursive: true })
  const copies = new Map(sources.map((source, index) => [source, `${String(index)}-${basename(source)}`]))
  await Promise.all(
    sources.map(async (source) => {
      const content = contents.get(source) ?? Buffer.alloc(0)
      const copy = join(directory, copies.get(source) ?? source)
      await writeFile(
        copy,
        isLog(source)
          ? replaced(content.toString('utf8'), replacements).replace(
              stamp,
              (_match, open: string, time: string, close: string) =>
                `${open}${new Date(Date.parse(time) + shift).toISOString()}${close}`,
            )
          : content,
      )
    }),
  )
  const fresh = join(directory, 'manifest.json')
  await writeFile(
    fresh,
    JSON.stringify({
      steps: document.steps.map((step) => {
        const source = sourceOf(step)
        return source === null ? step : { ...step, source: copies.get(source) }
      }),
    }),
  )
  return fresh
}
