import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { z } from 'zod'
import { FakeCall, FakePurpose } from './scenario.js'

const scenarioFile = (state: string): string => join(state, 'scenario.json')
const callsDirectory = (state: string): string => join(state, 'calls')
const repliesDirectory = (state: string, purpose: FakePurpose): string =>
  join(state, purpose === 'observer' ? 'replies' : 'chat-replies')

const recordSuffix = '.json'
const claimSuffix = '.claim'

const isCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code

const numbered = (sequence: number): string => String(sequence).padStart(6, '0')

const claim = (directory: string): number => {
  mkdirSync(directory, { recursive: true })
  const claimed = readdirSync(directory).filter((name) => name.endsWith(claimSuffix)).length
  for (let sequence = claimed + 1; ; sequence += 1) {
    try {
      closeSync(openSync(join(directory, `${numbered(sequence)}${claimSuffix}`), 'wx'))
      return sequence
    } catch (error) {
      if (!isCode(error, 'EEXIST')) {
        throw error
      }
    }
  }
}

const writeAtomically = (path: string, content: string): void => {
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, content)
  renameSync(temporary, path)
}

export const writeScenario = (state: string, scenario: unknown): void => {
  mkdirSync(state, { recursive: true })
  for (const purpose of FakePurpose.options) {
    rmSync(repliesDirectory(state, purpose), { recursive: true, force: true, maxRetries: 5 })
  }
  writeAtomically(scenarioFile(state), JSON.stringify(scenario, null, 2))
}

const readDocument = <S extends z.ZodType>(path: string, schema: S): z.output<S> => {
  try {
    return schema.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if (isCode(error, 'ENOENT')) {
      return schema.parse({})
    }
    throw error
  }
}

export const readScenario = <S extends z.ZodType>(state: string, schema: S): z.output<S> =>
  readDocument(scenarioFile(state), schema)

export const readStateDocument = <S extends z.ZodType>(state: string, name: string, schema: S): z.output<S> =>
  readDocument(join(state, name), schema)

export const writeStateDocument = (state: string, name: string, document: unknown): void => {
  mkdirSync(state, { recursive: true })
  writeAtomically(join(state, name), JSON.stringify(document, null, 2))
}

export const claimCall = (state: string): number => claim(callsDirectory(state))

export const claimReply = (state: string, purpose: FakePurpose): number => claim(repliesDirectory(state, purpose)) - 1

export const writeCall = (state: string, call: FakeCall): void => {
  writeAtomically(join(callsDirectory(state), `${numbered(call.sequence)}${recordSuffix}`), JSON.stringify(call))
}

export const readCalls = (state: string): FakeCall[] => {
  try {
    return readdirSync(callsDirectory(state))
      .filter((name) => name.endsWith(recordSuffix))
      .sort()
      .map((name) => FakeCall.parse(JSON.parse(readFileSync(join(callsDirectory(state), name), 'utf8'))))
  } catch (error) {
    if (isCode(error, 'ENOENT')) {
      return []
    }
    throw error
  }
}
