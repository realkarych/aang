import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createProfile, type Profile } from '@aang/testkit'
import type { TestContext } from 'vitest'

const samples = new URL('../../../docs/research/samples/', import.meta.url)

export const sampleBytes = (path: string): Buffer => readFileSync(new URL(path, samples))

export interface ManifestFiles {
  readonly steps: readonly unknown[]
  readonly sources?: Readonly<Record<string, string | Uint8Array>>
}

export interface Fixture {
  readonly profile: Profile
  readonly manifest: (name: string, files: ManifestFiles) => Promise<string>
}

export const createFixture = async (onTestFinished: TestContext['onTestFinished']): Promise<Fixture> => {
  const profile = await createProfile()
  onTestFinished(profile.dispose)
  const directory = join(profile.root, 'fixture')
  return {
    profile,
    manifest: async (name, { steps, sources = {} }) => {
      const base = join(directory, name)
      for (const [source, content] of Object.entries(sources)) {
        const path = join(base, ...source.split('/'))
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, content)
      }
      const file = join(base, 'manifest.json')
      await mkdir(base, { recursive: true })
      await writeFile(file, JSON.stringify({ steps }, null, 2))
      return file
    },
  }
}

export const linesOf = (content: Buffer): Buffer[] => {
  const lines: Buffer[] = []
  for (let offset = 0; offset < content.length;) {
    const end = content.indexOf(0x0a, offset)
    const next = end < 0 ? content.length : end + 1
    lines.push(content.subarray(offset, next))
    offset = next
  }
  return lines
}

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}
