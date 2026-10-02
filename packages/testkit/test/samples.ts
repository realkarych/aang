import { readFileSync } from 'node:fs'

const samples = new URL('../../../docs/research/samples/observer/', import.meta.url)

export type Sample = Record<string, unknown>

export const readSample = (name: string): Sample => JSON.parse(readFileSync(new URL(name, samples), 'utf8')) as Sample

export const readSampleLines = (name: string): Sample[] =>
  readFileSync(new URL(name, samples), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Sample)

export const keysOf = (value: unknown): string[] =>
  typeof value === 'object' && value !== null ? Object.keys(value).sort() : []
